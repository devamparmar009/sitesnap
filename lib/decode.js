'use strict';

/**
 * Character-encoding detection and content sniffing.
 *
 * Two problems that only show up once you point a crawler at the real web
 * rather than at your own test server:
 *
 *   1. **Not every page is UTF-8.** Decoding a Shift_JIS or windows-1252 page
 *      as UTF-8 replaces every non-ASCII byte with U+FFFD, permanently. The
 *      mirror is then wrong in a way no later pass can repair, because the
 *      original bytes are gone. Any non-English site hits this immediately.
 *
 *   2. **Content-Type is frequently absent or wrong.** Plenty of servers send
 *      HTML as `application/octet-stream`, `text/plain`, or with no header at
 *      all. Trusting the header alone means those pages are stored as opaque
 *      binaries and — much worse — never parsed, so every link on them is
 *      lost and the crawl silently dead-ends.
 *
 * Both follow the WHATWG sniffing rules closely enough for real-world use:
 * BOM wins, then the header charset, then an in-document declaration.
 */

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', length: 3 },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le', length: 2 },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be', length: 2 },
];

// Labels Node's TextDecoder understands, normalised from what pages declare.
const ALIASES = new Map([
  ['latin1', 'iso-8859-1'],
  ['latin-1', 'iso-8859-1'],
  ['iso8859-1', 'iso-8859-1'],
  ['iso_8859-1', 'iso-8859-1'],
  ['cp1252', 'windows-1252'],
  ['ansi', 'windows-1252'],
  ['sjis', 'shift_jis'],
  ['shift-jis', 'shift_jis'],
  ['x-sjis', 'shift_jis'],
  ['ms932', 'shift_jis'],
  ['cp932', 'shift_jis'],
  ['eucjp', 'euc-jp'],
  ['x-euc-jp', 'euc-jp'],
  ['gb_2312', 'gb2312'],
  ['cp936', 'gbk'],
  ['ms936', 'gbk'],
  ['big5-hkscs', 'big5'],
  ['cp950', 'big5'],
  ['euckr', 'euc-kr'],
  ['cp949', 'euc-kr'],
  ['cp1251', 'windows-1251'],
  ['utf8', 'utf-8'],
  ['utf-8n', 'utf-8'],
  ['ascii', 'utf-8'], // ASCII is a strict UTF-8 subset
  ['us-ascii', 'utf-8'],
]);

function normalizeLabel(raw) {
  if (!raw) return null;
  const label = String(raw).trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!label) return null;
  return ALIASES.get(label) || label;
}

/** Is this label something TextDecoder can actually handle? */
function decoderFor(label) {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;
  try {
    return new TextDecoder(normalized);
  } catch {
    return null;
  }
}

function charsetFromContentType(contentType = '') {
  const match = /charset\s*=\s*([^;\s]+)/i.exec(contentType);
  return match ? match[1] : null;
}

/**
 * Find a charset declared inside the document itself.
 *
 * Only the head matters, so this scans a bounded prefix — a declaration
 * appearing after the first 4KB is not honoured by browsers either, and
 * scanning a whole 5MB page as latin1 to find it would be wasteful.
 */
function charsetFromMarkup(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');

  // <meta charset="utf-8">
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-:]+)/i.exec(head);
  if (meta) return meta[1];

  // <meta http-equiv="Content-Type" content="text/html; charset=...">
  const httpEquiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_\-:]+)/i.exec(head);
  if (httpEquiv) return httpEquiv[1];

  // <?xml version="1.0" encoding="..."?>
  const xml = /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_\-:]+)["']/i.exec(head);
  if (xml) return xml[1];

  return null;
}

/**
 * Decode a response body to text using the best available encoding signal.
 *
 * Precedence — BOM, then header, then in-document declaration, then UTF-8.
 * A BOM outranks everything because it is unambiguous; a declaration that
 * contradicts it is simply wrong.
 *
 * @returns {{text: string, encoding: string, source: string}}
 */
function decodeText(buf, contentType = '') {
  if (!buf || buf.length === 0) return { text: '', encoding: 'utf-8', source: 'empty' };

  for (const bom of BOMS) {
    if (buf.length >= bom.length && bom.bytes.every((b, i) => buf[i] === b)) {
      const decoder = decoderFor(bom.encoding);
      if (decoder) {
        // Strip the BOM itself so it does not survive as a stray U+FEFF.
        return {
          text: decoder.decode(buf.subarray(bom.length)),
          encoding: bom.encoding,
          source: 'bom',
        };
      }
    }
  }

  const headerLabel = charsetFromContentType(contentType);
  const headerDecoder = decoderFor(headerLabel);
  if (headerDecoder) {
    return {
      text: headerDecoder.decode(buf),
      encoding: normalizeLabel(headerLabel),
      source: 'content-type',
    };
  }

  const markupLabel = charsetFromMarkup(buf);
  const markupDecoder = decoderFor(markupLabel);
  if (markupDecoder) {
    return {
      text: markupDecoder.decode(buf),
      encoding: normalizeLabel(markupLabel),
      source: 'markup',
    };
  }

  // Default to UTF-8, but fall back to windows-1252 if the bytes are not
  // valid UTF-8. Guessing 1252 beats emitting a page full of U+FFFD, and it
  // is what browsers do for unlabelled western content.
  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    return { text: strict.decode(buf), encoding: 'utf-8', source: 'default' };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(buf),
      encoding: 'windows-1252',
      source: 'fallback',
    };
  }
}

// Content-Type values that carry no real information and should not be
// trusted over what the bytes actually look like.
const UNINFORMATIVE = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'text/plain',
  'application/download',
  'application/force-download',
  'unknown/unknown',
  'application/unknown',
  '*/*',
]);

/**
 * Decide what a resource really is.
 *
 * The declared type wins when it is meaningful. When it is missing or one of
 * the generic catch-alls above, the leading bytes decide instead — otherwise
 * an HTML page served as `application/octet-stream` is stored as a binary
 * blob and never parsed, and every link on it is lost.
 *
 * @returns {'html'|'css'|'other'}
 */
function detectKind(contentType, buf) {
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();

  if (declared === 'text/html' || declared === 'application/xhtml+xml') return 'html';
  if (declared === 'text/css') return 'css';
  // JavaScript is parsed too — its `import` specifiers name code-split chunks
  // that appear nowhere in the HTML.
  if (
    declared === 'text/javascript' ||
    declared === 'application/javascript' ||
    declared === 'application/x-javascript' ||
    declared === 'module'
  ) {
    return 'js';
  }

  // A specific, non-generic type is trusted even if sniffing might disagree —
  // it is far more likely to be right than a heuristic.
  if (declared && !UNINFORMATIVE.has(declared)) return 'other';

  if (!buf || buf.length === 0) return 'other';

  const head = buf.subarray(0, 1024).toString('latin1').trim().toLowerCase();

  // Binary signatures first — never sniff these as text.
  const sig = buf.subarray(0, 8);
  const startsWith = (...bytes) => bytes.every((b, i) => sig[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'other'; // PNG
  if (startsWith(0xff, 0xd8, 0xff)) return 'other'; // JPEG
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'other'; // GIF
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'other'; // PDF
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'other'; // ZIP family
  if (startsWith(0x00, 0x01, 0x00, 0x00)) return 'other'; // TTF
  if (startsWith(0x77, 0x4f, 0x46, 0x46)) return 'other'; // WOFF
  if (startsWith(0x77, 0x4f, 0x46, 0x32)) return 'other'; // WOFF2

  // Anything binary, whatever its bytes happen to spell.
  //
  // Enumerating magic numbers only covers the formats someone thought to list,
  // and the text tests below are loose enough that the gaps matter. The CSS
  // test in particular looks for `<selector> {`, a shape binary data hits
  // constantly: a .glb opens with the ASCII tag `glTF`, and its JSON chunk
  // supplies a `{` a few bytes later. That is enough to match. A 3.7MB glTF
  // model served as application/octet-stream — which is uninformative, so
  // sniffing decides — was classified as a stylesheet and written to disk as
  // `DamagedHelmet.glb.css`, then rewritten into the page under that name and
  // served back as text/css, which is not something a glTF loader will accept.
  //
  // A NUL byte in the first block is the classic binary test, the one git and
  // file(1) use, and neither a stylesheet nor an HTML document contains one.
  // UTF-16 text does, so its BOM is excluded first.
  const utf16 = (sig[0] === 0xff && sig[1] === 0xfe) || (sig[0] === 0xfe && sig[1] === 0xff);
  if (!utf16 && buf.subarray(0, 1024).includes(0x00)) return 'other';

  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    /^<\?xml[^>]*\?>\s*<(!doctype\s+html|html)/.test(head) ||
    /<html[\s>]/.test(head.slice(0, 512))
  ) {
    return 'html';
  }

  // JSON, which the CSS test below would otherwise claim.
  //
  // That test looks for "something, then a brace", and a JSON document opens
  // with exactly that shape: `[\n  {"name": ...` is a selector followed by a
  // rule as far as the regex is concerned. glTF-Sample-Assets' model-index.json
  // was mirrored as `model-index.json.css` for this reason.
  //
  // The two are separable without parsing. A stylesheet can never begin with
  // `{` — a rule must be preceded by a selector. It *can* begin with `[`, as
  // an attribute selector, but such a selector always closes its bracket
  // before the rule opens; a JSON array reaches its first `{` first.
  if (head.startsWith('{')) return 'other';
  if (head.startsWith('[')) {
    const close = head.indexOf(']');
    const brace = head.indexOf('{');
    if (close === -1 || (brace !== -1 && brace < close)) return 'other';
  }

  // CSS has no magic number; look for a rule-ish shape near the start.
  if (/^\s*(@(charset|import|media|font-face)\b|[.#a-z\[][^{};<]{0,120}\{)/i.test(head)) {
    return 'css';
  }

  return 'other';
}

/**
 * Rewrite a document's declared charset to UTF-8.
 *
 * Files are always written to disk as UTF-8, whatever they arrived as. If the
 * saved copy still says `<meta charset="shift_jis">`, a browser opening it
 * offline decodes UTF-8 bytes as Shift_JIS and every non-ASCII character is
 * mojibake — the decode work would be undone at the last step.
 */
function retagCharset(html, kind = 'html') {
  if (kind === 'css') {
    // @charset must be the very first thing in a stylesheet if present.
    return html.replace(/^@charset\s+["'][^"']*["']\s*;/i, '@charset "utf-8";');
  }

  let out = html;
  let replaced = false;

  out = out.replace(/(<meta[^>]+charset\s*=\s*["']?\s*)([a-z0-9_\-:]+)/gi, (m, lead) => {
    replaced = true;
    return `${lead}utf-8`;
  });

  out = out.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*)([a-z0-9_\-:]+)/gi,
    (m, lead) => {
      replaced = true;
      return `${lead}utf-8`;
    }
  );

  out = out.replace(/(<\?xml[^>]+encoding\s*=\s*["'])([a-z0-9_\-:]+)(["'])/gi, (m, a, b, c) => {
    replaced = true;
    return `${a}utf-8${c}`;
  });

  // Nothing declared one — add a declaration so the browser cannot guess
  // wrong on a page whose encoding we had to detect.
  if (!replaced && /<head[\s>]/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">');
  }

  return out;
}

// Fingerprints of "prove you are a browser" interstitials. These are served
// with an error status but are not really errors, and reporting them as a
// bare "403 Forbidden" sends people hunting for a bug in their own tool.
const CHALLENGE_MARKERS = [
  /checking your browser/i,
  /just a moment/i,
  /enable javascript and cookies to continue/i,
  /ddos protection by/i,
  /attention required!/i,
  /cf-browser-verification/i,
  /jschallengeurl/i,
  /_cf_chl_opt/i,
  /challenge-platform/i,
  /px-captcha/i,
  /incapsula incident id/i,
  /request unsuccessful\. incapsula/i,
];

const CHALLENGE_SERVERS = /^(cloudflare|hcdn|akamaighost|incapsula|imperva|sucuri)/i;

/**
 * Identify a bot-protection interstitial.
 *
 * Detection only — this reports what is happening so the user can make an
 * informed decision. It deliberately does not attempt to satisfy, solve or
 * work around the challenge.
 *
 * @returns {{isChallenge: boolean, vendor: string|null}}
 */
function detectChallenge(status, headers, bodyPrefix = '') {
  const server = (headers?.get?.('server') || headers?.server || '').toString();
  const vendor = CHALLENGE_SERVERS.test(server) ? server.split('/')[0] : null;

  const looksLikeChallenge =
    (status === 403 || status === 503 || status === 429) &&
    CHALLENGE_MARKERS.some((re) => re.test(bodyPrefix));

  return { isChallenge: looksLikeChallenge, vendor };
}

module.exports = {
  decodeText,
  detectKind,
  retagCharset,
  detectChallenge,
  charsetFromContentType,
  charsetFromMarkup,
  normalizeLabel,
};
