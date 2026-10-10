'use strict';

/**
 * Encoding detection, content sniffing and challenge identification.
 *
 * These are the three things that decide whether the crawler copes with the
 * real web or only with well-behaved test servers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeText,
  detectKind,
  retagCharset,
  detectChallenge,
  charsetFromMarkup,
  normalizeLabel,
} = require('../lib/decode');

// --- encoding detection ----------------------------------------------------

test('decodes UTF-8 by default', () => {
  const buf = Buffer.from('héllo wörld', 'utf8');
  const { text, encoding } = decodeText(buf, 'text/html');
  assert.equal(text, 'héllo wörld');
  assert.equal(encoding, 'utf-8');
});

test('honours charset from the Content-Type header', () => {
  // Decoding these bytes as UTF-8 yields U+FFFD replacement characters, and
  // the original bytes are gone — no later pass can repair it.
  const buf = Buffer.from('naïve résumé © 2026', 'latin1');
  const { text, source } = decodeText(buf, 'text/html; charset=ISO-8859-1');
  assert.equal(text, 'naïve résumé © 2026');
  assert.equal(source, 'content-type');
});

test('falls back to a charset declared in the markup', () => {
  const buf = Buffer.concat([
    Buffer.from('<html><head><meta charset="shift_jis"><title>'),
    Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), // 日本語
    Buffer.from('</title></head></html>'),
  ]);
  const { text, encoding, source } = decodeText(buf, 'text/html'); // no charset in header
  assert.match(text, /日本語/);
  assert.equal(encoding, 'shift_jis');
  assert.equal(source, 'markup');
});

test('a BOM outranks a contradicting declaration', () => {
  const buf = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
    Buffer.from('café', 'utf8'),
  ]);
  // Header lies; the BOM is unambiguous and must win.
  const { text, source } = decodeText(buf, 'text/html; charset=shift_jis');
  assert.equal(source, 'bom');
  assert.equal(text, 'café', 'the BOM itself must not survive into the text');
});

test('an unlabelled non-UTF-8 body falls back rather than emitting U+FFFD', () => {
  const buf = Buffer.from('caf\xe9 na\xefve', 'latin1');
  const { text, source } = decodeText(buf, 'text/html');
  assert.equal(source, 'fallback');
  assert.ok(!text.includes('�'), `should not contain replacement chars: ${text}`);
});

test('an unknown charset label degrades instead of throwing', () => {
  const buf = Buffer.from('plain ascii', 'utf8');
  const { text } = decodeText(buf, 'text/html; charset=x-not-a-real-charset');
  assert.equal(text, 'plain ascii');
});

test('charset aliases are normalised', () => {
  assert.equal(normalizeLabel('LATIN1'), 'iso-8859-1');
  assert.equal(normalizeLabel('sjis'), 'shift_jis');
  assert.equal(normalizeLabel('cp1252'), 'windows-1252');
  assert.equal(normalizeLabel('UTF8'), 'utf-8');
});

test('finds a charset in an http-equiv meta tag', () => {
  const buf = Buffer.from(
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"></head></html>'
  );
  assert.equal(normalizeLabel(charsetFromMarkup(buf)), 'windows-1251');
});

// --- charset re-tagging ----------------------------------------------------

test('rewrites a declared charset to utf-8 for the saved copy', () => {
  // Files are written as UTF-8. A surviving `charset=shift_jis` would make a
  // browser decode UTF-8 bytes as Shift_JIS — mojibake, undoing the decode.
  const out = retagCharset('<html><head><meta charset="shift_jis"></head></html>');
  assert.match(out, /charset="utf-8"/i);
  assert.ok(!/shift_jis/i.test(out));
});

test('adds a charset declaration when the document has none', () => {
  const out = retagCharset('<html><head><title>x</title></head><body>y</body></html>');
  assert.match(out, /<meta charset="utf-8">/i);
});

test('rewrites @charset in stylesheets', () => {
  const out = retagCharset('@charset "shift_jis";\nbody{color:red}', 'css');
  assert.match(out, /@charset "utf-8";/i);
});

// --- content sniffing ------------------------------------------------------

test('a meaningful Content-Type is trusted', () => {
  assert.equal(detectKind('text/html', Buffer.from('<html>')), 'html');
  assert.equal(detectKind('text/css', Buffer.from('body{}')), 'css');
  assert.equal(detectKind('image/png', Buffer.alloc(10)), 'other');
});

test('HTML served as octet-stream is still recognised', () => {
  // Otherwise it is stored as an opaque blob and never parsed, so every link
  // on the page is lost and the crawl dead-ends there.
  assert.equal(
    detectKind('application/octet-stream', Buffer.from('<!DOCTYPE html><html><body>hi')),
    'html'
  );
});

test('HTML with no Content-Type at all is still recognised', () => {
  assert.equal(detectKind('', Buffer.from('<html><head></head><body>hi</body></html>')), 'html');
});

test('binary signatures are never sniffed as text', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('<html>')]);
  assert.equal(detectKind('application/octet-stream', png), 'other');

  const pdf = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.from('<html>')]);
  assert.equal(detectKind('', pdf), 'other');

  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  assert.equal(detectKind('', zip), 'other');
});

test('CSS is sniffed from its shape when untyped', () => {
  assert.equal(detectKind('text/plain', Buffer.from('.header { color: red; }')), 'css');
  assert.equal(detectKind('', Buffer.from('@media screen { body { margin: 0 } }')), 'css');
});

test('genuinely unidentifiable content stays "other"', () => {
  assert.equal(detectKind('', Buffer.from('just some prose with no markup')), 'other');
  assert.equal(detectKind('', Buffer.alloc(0)), 'other');
});

// --- bot-protection identification -----------------------------------------

test('identifies a browser-check interstitial', () => {
  // Detection only. Reporting this accurately stops people debugging a tool
  // that is working correctly; sitesnap does not try to satisfy the check.
  const body = '<html><body>Checking your browser before accessing...</body></html>';
  const { isChallenge } = detectChallenge(403, new Headers({ server: 'hcdn' }), body);
  assert.equal(isChallenge, true);
});

test('names the protection vendor when the server header gives it away', () => {
  const { vendor } = detectChallenge(503, new Headers({ server: 'cloudflare' }), 'Just a moment...');
  assert.equal(vendor, 'cloudflare');
});

test('an ordinary 403 is not mistaken for a challenge', () => {
  const body = '<html><body>You do not have permission to access this resource.</body></html>';
  const { isChallenge } = detectChallenge(403, new Headers({ server: 'nginx' }), body);
  assert.equal(isChallenge, false);
});

test('a success status is never a challenge', () => {
  const { isChallenge } = detectChallenge(200, new Headers(), 'Checking your browser');
  assert.equal(isChallenge, false);
});

// --- binary must never be sniffed as text -----------------------------------

/**
 * A .glb served as application/octet-stream — uninformative, so sniffing
 * decides — used to come back as 'css'. The CSS test looks for `selector {`,
 * and a glTF binary opens with the ASCII tag `glTF` followed by a JSON chunk
 * whose `{` arrives within a few bytes. That was enough to match, so a 3.7MB
 * model was written to disk as `DamagedHelmet.glb.css` and then served back to
 * the page as text/css.
 */
test('a glTF binary is not mistaken for a stylesheet', () => {
  const glb = Buffer.concat([
    Buffer.from('glTF'),
    Buffer.from([0x02, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x39, 0x00]),
    Buffer.from('JSON{"asset":{"version":"2.0"},"scenes":[{"nodes":[0]}]}'),
  ]);
  assert.equal(detectKind('application/octet-stream', glb), 'other');
  assert.equal(detectKind('', glb), 'other');
});

test('wasm is not mistaken for text', () => {
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  assert.equal(detectKind('application/octet-stream', wasm), 'other');
});

test('binary that happens to spell a CSS rule is still binary', () => {
  // `a{` is a valid stylesheet opening; the NUL is what settles it.
  const nasty = Buffer.concat([Buffer.from('a{color:red}'), Buffer.from([0x00, 0xff, 0xfe])]);
  assert.equal(detectKind('', nasty), 'other');
});

test('genuine stylesheets and documents still detect correctly', () => {
  assert.equal(detectKind('', Buffer.from('body { margin: 0 }')), 'css');
  assert.equal(detectKind('', Buffer.from('@media screen { .a { color: red } }')), 'css');
  assert.equal(detectKind('', Buffer.from('@import url("x.css");')), 'css');
  assert.equal(detectKind('', Buffer.from('<!DOCTYPE html><html><body>hi</body></html>')), 'html');
  assert.equal(detectKind('text/css', Buffer.from('body{}')), 'css');
});

test('JSON is not mistaken for a stylesheet', () => {
  // The real shape that broke: glTF-Sample-Assets' model-index.json, served by
  // raw.githubusercontent.com as text/plain, was written as `.json.css`.
  const arr = Buffer.from('[\n    {\n        "name": "DamagedHelmet",\n        "variants": {}\n    }\n]');
  assert.equal(detectKind('text/plain', arr), 'other');
  assert.equal(detectKind('', arr), 'other');
  assert.equal(detectKind('', Buffer.from('{\n  "compilerOptions": { "strict": true }\n}')), 'other');
});

test('a CSS attribute selector is still CSS', () => {
  // The one stylesheet form that also opens with `[`. It closes the bracket
  // before the rule opens, which is what distinguishes it from a JSON array.
  assert.equal(detectKind('', Buffer.from('[data-theme="dark"] { color: red }')), 'css');
  assert.equal(detectKind('', Buffer.from('[hidden]{display:none}')), 'css');
});
