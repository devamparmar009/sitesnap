'use strict';

/**
 * Finding and rewriting the URLs inside HTML and CSS.
 *
 * Extraction (pass 1) and rewriting (pass 2) walk the *same* set of references
 * through `forEachHtmlRef`. Keeping one traversal means the crawler can never
 * download something it later fails to rewrite, or rewrite something it never
 * downloaded — the two passes cannot drift apart.
 */

const cheerio = require('cheerio');
const { shouldSkipReference } = require('./scope');

// element/attribute pairs that carry a single URL
const SINGLE_URL_ATTRS = [
  ['img', 'src'],
  ['img', 'data-src'],
  ['script', 'src'],
  ['iframe', 'src'],
  ['frame', 'src'],
  ['embed', 'src'],
  ['source', 'src'],
  ['audio', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['track', 'src'],
  ['input', 'src'],
  ['object', 'data'],
  ['a', 'href'],
  ['area', 'href'],
  ['link', 'href'],
  ['use', 'href'],
  ['image', 'href'],
];

const SRCSET_ATTRS = [
  ['img', 'srcset'],
  ['source', 'srcset'],
  ['img', 'data-srcset'],
];

// link[rel] values whose target is an asset we want on disk
const ASSET_RELS = new Set([
  'stylesheet',
  'icon',
  'shortcut icon',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'mask-icon',
  'manifest',
  'preload',
  'prefetch',
]);

/**
 * Parse a srcset attribute into {url, descriptor} parts.
 *
 * Follows the HTML spec's algorithm, which is subtler than it looks and was
 * verified against Chromium rather than assumed:
 *
 *   - A candidate URL runs to the next ASCII whitespace, NOT to the next
 *     comma. So `a.jpg,b.jpg` (no space) is a single URL that happens to
 *     contain a comma, exactly as browsers request it.
 *   - If that token ends with commas, they are separators: strip them, and
 *     the candidate has no descriptor. Missing this made `a.jpg, b.jpg`
 *     parse as the single broken URL `a.jpg,` — requesting a 404 *and*
 *     silently dropping `b.jpg` from the mirror.
 *   - Only otherwise does a descriptor follow, running to the next comma.
 *
 * Splitting on ',' would also corrupt data: URIs, which always contain one.
 */
function parseSrcset(value) {
  const parts = [];
  let i = 0;
  const n = value.length;

  while (i < n) {
    // Skip separators between candidates.
    while (i < n && /[\s,]/.test(value[i])) i++;
    if (i >= n) break;

    const start = i;
    while (i < n && !/\s/.test(value[i])) i++;
    let url = value.slice(start, i);

    if (url.endsWith(',')) {
      // Trailing commas are separators, and mean this candidate carries no
      // descriptor — the next token is another URL, not a width or density.
      url = url.replace(/,+$/, '');
      if (url) parts.push({ url, descriptor: '' });
      continue;
    }

    while (i < n && /\s/.test(value[i])) i++;

    const descStart = i;
    while (i < n && value[i] !== ',') i++;
    const descriptor = value.slice(descStart, i).trim();

    if (i < n && value[i] === ',') i++;
    if (url) parts.push({ url, descriptor });
  }
  return parts;
}

function serializeSrcset(parts) {
  return parts
    .map(({ url, descriptor }) => (descriptor ? `${url} ${descriptor}` : url))
    .join(', ');
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;

/**
 * Visit every URL reference inside a CSS string.
 * `visit(rawUrl)` returns a replacement string, or undefined to leave it alone.
 */
function mapCssUrls(css, visit) {
  const replaceIn = (re, build) =>
    (css = css.replace(re, (match, quote, raw) => {
      const next = visit(raw);
      return next === undefined ? match : build(quote, next);
    }));

  replaceIn(CSS_URL_RE, (q, next) => `url(${q}${next}${q})`);
  replaceIn(CSS_IMPORT_RE, (q, next) => `@import ${q}${next}${q}`);
  return css;
}

/**
 * Walk every URL-bearing attribute in a parsed document.
 *
 * @param {CheerioAPI} $
 * @param {(ref: {raw: string, kind: 'page'|'asset', set: (v: string) => void}) => void} visit
 */
function forEachHtmlRef($, visit) {
  for (const [tag, attr] of SINGLE_URL_ATTRS) {
    $(`${tag}[${attr}]`).each((_, el) => {
      const node = $(el);
      const raw = node.attr(attr);
      if (shouldSkipReference(raw)) return;

      let kind = 'asset';
      if (tag === 'a' || tag === 'area') {
        kind = 'page';
      } else if (tag === 'iframe' || tag === 'frame') {
        kind = 'page';
      } else if (tag === 'link') {
        const rel = (node.attr('rel') || '').toLowerCase().trim();
        // canonical, alternate, search, dns-prefetch… We don't download these,
        // but they must still be rewritten: left alone, a root-relative href
        // like "/opensearch.xml" points at the filesystem root once the page
        // is opened from disk. 'external' means "rewrite, do not fetch".
        if (!ASSET_RELS.has(rel)) kind = 'external';
      }

      // `tag` and `setAttr` ride along so rewriteHtml can single out
      // <a>/<area> for the hydration-proof navigation handling described on
      // buildNavInterceptScript — this function stays agnostic to that, it
      // just gives the caller a way to touch the same element again.
      visit({
        raw,
        kind,
        tag,
        set: (v) => node.attr(attr, v),
        setAttr: (name, v) => (v === null ? node.removeAttr(name) : node.attr(name, v)),
      });
    });
  }

  for (const [tag, attr] of SRCSET_ATTRS) {
    $(`${tag}[${attr}]`).each((_, el) => {
      const node = $(el);
      const parts = parseSrcset(node.attr(attr) || '');
      if (!parts.length) return;

      let changed = false;
      for (const part of parts) {
        if (shouldSkipReference(part.url)) continue;
        visit({
          raw: part.url,
          kind: 'asset',
          set: (v) => {
            part.url = v;
            changed = true;
          },
        });
      }
      if (changed) node.attr(attr, serializeSrcset(parts));
    });
  }

  // <style> blocks and style="" attributes hide url() references too.
  $('style').each((_, el) => {
    const node = $(el);
    const css = node.html() || '';
    const next = mapCssUrls(css, (raw) => {
      if (shouldSkipReference(raw)) return undefined;
      let replacement;
      visit({ raw, kind: 'asset', set: (v) => (replacement = v) });
      return replacement;
    });
    if (next !== css) node.html(next);
  });

  $('[style]').each((_, el) => {
    const node = $(el);
    const css = node.attr('style') || '';
    const next = mapCssUrls(css, (raw) => {
      if (shouldSkipReference(raw)) return undefined;
      let replacement;
      visit({ raw, kind: 'asset', set: (v) => (replacement = v) });
      return replacement;
    });
    if (next !== css) node.attr('style', next);
  });
}

/**
 * Pass 1: collect references without modifying anything.
 * @returns {{pages: string[], assets: string[]}} raw (unresolved) URL strings
 */
function extractHtml(html) {
  const $ = cheerio.load(html);
  const pages = [];
  const assets = [];

  // <base href> changes what every relative URL on the page means.
  const baseHref = $('base[href]').first().attr('href') || null;

  forEachHtmlRef($, ({ raw, kind }) => {
    // 'external' refs are rewritten but never fetched.
    if (kind === 'external') return;
    (kind === 'page' ? pages : assets).push(raw);
  });

  return { pages, assets, baseHref };
}

/**
 * Pass 2: rewrite every reference through `resolve`.
 *
 * @param {string} html
 * @param {(raw: string, kind: 'page'|'asset') => string|null} resolve
 *        returns the replacement href, or null to leave the reference as-is
 */
/**
 * Restores real navigation on a page whose framework has taken over routing.
 *
 * Rewriting an <a href> is not durable on a hydrating app, and this is not a
 * corner case — it is what happened on the very first click tried against the
 * suitsupply.com mirror. React (and any framework that hydrates onto
 * server-sent markup) does not read an anchor's href from the DOM to decide
 * where a click goes; it renders its OWN idea of that anchor from data carried
 * in the page's inline hydration payload (Next's `self.__next_f`, Nuxt's
 * `__NUXT__`, and equivalents elsewhere) — data this tool does not rewrite,
 * because it is JavaScript string content, not an HTML attribute. On a
 * mismatch, hydration does not stop at patching the one attribute: React can
 * (and, tested against this exact mirror, did) discard the whole mismatched
 * subtree and re-render it fresh from its own data — which erases any extra
 * attribute we had added to that element right along with the broken href.
 * A per-anchor marker was tried first and confirmed not to survive this.
 * The visible symptom is a React hydration-mismatch warning (error #418) on
 * load, followed by a 404 on the first click.
 *
 * What *does* survive is anything outside the subtree React re-renders — in
 * particular, a `<script>` this tool adds to `<head>`, well outside whatever
 * part of the page mismatched. So instead of marking individual elements,
 * this records a lookup table — the real site's pathname for every local link
 * on the page, mapped to the correct local file — and matches against it at
 * click time using whatever pathname the anchor holds *then*, however the
 * framework arrived at it. This works precisely because hydration's
 * "correction" is not garbage: it is the framework's own accurate site
 * pathname, just not adjusted for this being a local mirror — exactly the
 * string this table is keyed on.
 *
 * The capture phase matters as much as the table: it runs before any handler
 * attached the ordinary (bubble-phase) way, including every framework's own
 * delegated click listener, so this fires first regardless of what the
 * framework tries to do with the click.
 *
 * Deliberately narrow: modifier-clicks and middle-clicks (open in new
 * tab/window) are left alone rather than guessed at, since a wrong forced
 * navigation is worse than falling back to whatever the framework does.
 */
function buildNavInterceptScript(navMap) {
  const table = JSON.stringify(Object.fromEntries(navMap));
  return `<script data-sitesnap-nav="1">(function(){
var map=${table};
function localFor(href){
if(!href)return null;
if(Object.prototype.hasOwnProperty.call(map,href))return map[href];
try{
var path=new URL(href,location.href).pathname;
if(Object.prototype.hasOwnProperty.call(map,path))return map[path];
// The mirror may have been crawled at a different locale prefix than the
// one hydration renders (e.g. a language switcher whose target pathname
// omits the segment this copy was captured under).
var stripped=path.replace(/^\\/[a-z]{2}-[a-z]{2}\\//i,'/');
if(stripped!==path&&Object.prototype.hasOwnProperty.call(map,stripped))return map[stripped];
}catch(e){}
return null;
}
document.addEventListener('click',function(e){
if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var a=e.target&&e.target.closest&&e.target.closest('a[href],area[href]');
if(!a)return;
var local=a.getAttribute('data-sitesnap-href')||localFor(a.getAttribute('href'));
if(!local)return;
e.preventDefault();
e.stopImmediatePropagation();
window.location.href=local;
},true);
})();</script>`;
}

/**
 * @param {string} html
 * @param {(raw: string, kind: 'page'|'asset') => string|null} resolve
 *        returns the replacement href, or null to leave the reference as-is
 * @param {{baseUrl?: string}} [opts]
 *        baseUrl: the absolute URL this document was fetched from, needed to
 *        resolve a relative `raw` href into the real site pathname the
 *        click-interceptor keys its table on. Omitting it only degrades the
 *        table (page-relative refs can't be resolved to a pathname); every
 *        other rewrite in this function is unaffected.
 */
function rewriteHtml(html, resolve, opts = {}) {
  const $ = cheerio.load(html);
  const navMap = new Map();

  forEachHtmlRef($, ({ raw, kind, tag, set, setAttr }) => {
    const next = resolve(raw, kind);
    if (next === null || next === undefined) return;
    set(next);

    if (tag !== 'a' && tag !== 'area') return;

    if (/^https?:\/\//i.test(next)) {
      // Not ours to hijack: either unresolved (still points at the live
      // site) or already absolute — ordinary click behaviour is already
      // correct for both, and a stale marker here would be actively wrong.
      setAttr('data-sitesnap-href', null);
      return;
    }

    // Cheap fast path: survives on any element hydration does not fully
    // discard, letting the click handler skip the table lookup below.
    setAttr('data-sitesnap-href', next);

    // The durable path. Keyed on the real site's pathname, not on anything
    // of ours — see buildNavInterceptScript for why that is what survives.
    try {
      const abs = new URL(raw, opts.baseUrl || 'https://sitesnap.invalid/');
      navMap.set(abs.pathname, next);
    } catch {
      /* raw wasn't resolvable to a pathname — the marker above still helps */
    }
  });

  // A <base href> pointing at the live site defeats every relative path we
  // just wrote. Neutralize it so the mirror resolves against local files.
  $('base[href]').removeAttr('href');

  // Subresource Integrity has to go once a reference points at a local file.
  //
  // `integrity` is only honoured on a CORS-enabled fetch, which is why these
  // tags carry `crossorigin` too — and a `file://` document has an opaque
  // origin, so that fetch cannot succeed. The browser does not fall back: it
  // refuses to execute the script at all. Left in place, this silently blocks
  // exactly the scripts a site considered important enough to pin, and the
  // hash would be wrong anyway for any file whose contents we rewrote.
  //
  // Absolute http(s) references are left alone. Those still load from the
  // live origin, where the integrity check is both valid and meaningful.
  $('script[integrity], link[integrity]').each((_, el) => {
    const node = $(el);
    const ref = node.attr('src') || node.attr('href') || '';
    if (/^https?:\/\//i.test(ref)) return;
    node.removeAttr('integrity');
    node.removeAttr('crossorigin');
  });

  // Replaced, not skipped-if-present: a resumed crawl can rewrite the same
  // file again with a different manifest (more of the site now downloaded),
  // and the old table would silently keep pointing at last run's targets. A
  // stale copy left in place would also attach the click listener twice —
  // every click then navigating twice in a row.
  $('script[data-sitesnap-nav]').remove();
  if (navMap.size) {
    $('head').append(buildNavInterceptScript(navMap));
  }

  return $.html();
}

/**
 * Find the module specifiers a JavaScript file imports.
 *
 * Code-splitting means a modern site's entry script is only a stub: it
 * `import`s a dozen hashed chunks that appear nowhere in the HTML. Fetching
 * only what the markup references leaves the mirror looking correct while its
 * whole interactive layer 404s — Apple's homepage pulls six such chunks.
 *
 * Regex rather than a real parser: a JS parser is a heavy dependency for this,
 * and the failure mode of a false positive is one wasted request, not a
 * corrupted mirror. Bare specifiers (`react`) are skipped — they are a
 * bundler concept and do not exist as URLs.
 */
const JS_IMPORT_PATTERNS = [
  // Whitespace is optional throughout: these files are minified, and a
  // minifier emits `import"./x.js"` with no space at all.
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import()
  /\bfrom\s*['"]([^'"]+)['"]/g, // import … from / export … from
  /\bimport\s*['"]([^'"]+)['"]/g, // side-effect import
  /\bnew\s+Worker\s*\(\s*['"]([^'"]+)['"]/g, // web workers
  /\bimportScripts\s*\(\s*['"]([^'"]+)['"]/g, // classic worker imports
];

function extractJsImports(js) {
  const found = new Set();

  for (const re of JS_IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(js)) !== null) {
      const spec = m[1];
      // Only path-like specifiers can be fetched. A bare name is resolved by
      // a bundler at build time and has no URL on the server.
      if (/^(\.{1,2}\/|\/|https?:\/\/)/.test(spec)) found.add(spec);
    }
  }
  return [...found];
}

/** Rewrite module specifiers through `resolve`, leaving all other code alone. */
function rewriteJsImports(js, resolve) {
  let out = js;

  for (const re of JS_IMPORT_PATTERNS) {
    out = out.replace(new RegExp(re.source, 'g'), (match, spec) => {
      if (!/^(\.{1,2}\/|\/|https?:\/\/)/.test(spec)) return match;
      let next = resolve(spec, 'asset');
      if (next === null || next === undefined || next === spec) return match;

      // ES modules are stricter than HTML or CSS: a specifier that does not
      // begin with '/', './' or '../' is a *package name*, not a sibling
      // file. Our relative-path helper returns bare names like
      // "chunk-abc.js", which the module loader then refuses outright —
      // making the rewrite worse than leaving the original alone.
      if (!/^(\.{1,2}\/|\/|https?:\/\/|data:)/.test(next)) next = `./${next}`;

      // Only the quoted specifier is swapped, so surrounding code — which may
      // be minified into something regex should never restructure — is
      // untouched.
      return match.replace(spec, next);
    });
  }
  return out;
}

// ---- bundler assets -------------------------------------------------------

/**
 * Extensions worth chasing inside JavaScript. Deliberately excludes `.map`:
 * source maps are frequently larger than the code they describe and change
 * nothing about how the mirror renders, so fetching them doubles the download
 * for no visible gain.
 */
const ASSET_EXT = [
  // Code and data
  'js|mjs|cjs|css|json|wasm',
  // Fonts
  'woff2|woff|ttf|otf|eot',
  // Images
  'png|jpe?g|gif|svg|webp|avif|ico|apng|bmp|jxl',
  // Audio / video, plus the text tracks a <video> pulls in separately. HLS
  // playlists are listed because the .m3u8 is what the player asks for; its
  // segments are discovered by parsing it, not by guessing.
  'mp4|webm|ogg|ogv|oga|mp3|wav|m4a|m4v|mov|aac|flac|opus|m3u8|vtt|srt',
  // 3D and WebGL payloads.
  //
  // These matter more than their obscurity suggests: on a Three.js or
  // model-viewer page the entire visible content is a model the JavaScript
  // fetches at runtime, so a mirror that does not chase these extensions
  // reproduces the page's furniture and none of its subject. `.bin` earns its
  // place despite being the vaguest name here — a .gltf is a manifest whose
  // geometry lives in a sibling .bin, and capturing the manifest alone yields
  // a model that loads to nothing.
  'glb|gltf|bin|hdr|exr|ktx2?|basis|drc|fbx|obj|mtl|usdz|ply|stl|dds|tga|pvr',
].join('|');

// A quoted path that ends in an asset extension. The `(?:[\w@.~-]+\/)*` prefix
// keeps this anchored to path-shaped strings rather than arbitrary text.
const ASSET_LITERAL = new RegExp(
  `["'\`]((?:[\\w@.~-]+\\/)*[\\w@.~-]+\\.(?:${ASSET_EXT}))["'\`]`,
  'gi'
);

// Bare path shaped like an asset, for scanning *inside* JS string payloads
// where the quotes belong to an outer layer of escaping (`\\\"static/x.js\\\"`).
const ASSET_BARE = new RegExp(
  `(?:[\\w@.~-]+\\/)+[\\w@.~%-]+\\.(?:${ASSET_EXT})\\b`,
  'gi'
);

/**
 * webpack's template forms for a family of chunk URLs. The finished filename
 * never exists as one literal, so `ASSET_LITERAL` cannot see it — only
 * expanding the id->hash map recovers the real names.
 *
 * Two shapes occur, and telling them apart matters:
 *
 *   A  "static/chunks/" + e + "."   + ({248:"cad4287d"})[e] + ".js"
 *   B  "static/css/"                + ({6745:"27f14a11"})[e] + ".css"
 *
 * In form A the chunk *id* is part of the filename. Matching only the literal
 * nearest the map — the `"."` — yields `.cad4287d.js`, which resolves against
 * publicPath into `/_next/.cad4287d.js`: a URL that exists nowhere, 404s, and
 * on many sites comes back as a soft-404 HTML page rather than an error. So the
 * damage is not one wasted request; it is a phantom asset per chunk that then
 * has to be classified, saved and rewritten.
 *
 * Both forms therefore require the leading literal to end in `/`. A real chunk
 * prefix is a directory path, and that one constraint is what stops form A from
 * being mis-read as form B.
 */
const HASHMAP_WITH_ID = new RegExp(
  '(["\'])([^"\'\\n]{0,120}?\\/)\\1\\s*\\+\\s*([A-Za-z_$][\\w$]*)\\s*\\+\\s*' +
    '(["\'])([^"\'\\n]{0,20})\\4\\s*\\+\\s*' +
    '\\(?\\s*\\{([^{}]{0,20000})\\}\\s*\\)?\\s*\\[\\s*\\3\\s*\\]\\s*\\+\\s*' +
    '(["\'])([^"\'\\n]{0,40})\\7',
  'g'
);

const HASHMAP_PLAIN = new RegExp(
  '(["\'])([^"\'\\n]{0,120}?\\/)\\1\\s*\\+\\s*' +
    '\\(?\\s*\\{([^{}]{0,20000})\\}\\s*\\)?\\s*\\[[^\\]\\n]{1,40}\\]\\s*\\+\\s*' +
    '(["\'])([^"\'\\n]{0,40})\\4',
  'g'
);

/** Pull the `id: "hash"` pairs out of a matched object literal. */
function mapPairs(body) {
  return [...body.matchAll(/(["']?)([\w$]+)\1\s*:\s*["']([\w@.~-]+)["']/g)].map((m) => [
    m[2],
    m[3],
  ]);
}

/**
 * A bundler's `publicPath`: the absolute base every chunk URL is built from.
 *
 * Gated on a webpack marker by the caller rather than matched anywhere, because
 * `.p=` is two characters and would otherwise hit minified code constantly.
 */
const PUBLIC_PATH_ASSIGN =
  /([A-Za-z_$][\w$]*)\.p\s*=\s*(["'])((?:\/|https?:\/\/)[^"'\s]*)\2/;

const WEBPACK_MARKERS =
  /__webpack_require__|webpackChunk|__webpack_modules__|\.miniCssF\s*=|__webpack_public_path__/;

function looksLikeBundler(js) {
  return WEBPACK_MARKERS.test(js);
}

function isPlausibleAsset(spec) {
  if (!spec || spec.length > 200) return false;
  // A hashed filename or a directory component is what separates a real chunk
  // path from an incidental string like "index.js" in a log message. Without
  // this the miner queues hundreds of guesses per bundle.
  return spec.includes('/') || /[\w-]{8,}\./.test(spec);
}

/**
 * Find the asset URLs a bundle can request at runtime, plus the base they are
 * built from.
 *
 * Code-splitting hides these from every other extractor in this file.
 * `extractJsImports` only sees literal `import()` specifiers, but webpack does
 * not emit those — it emits `__webpack_require__.e(5192)` and reconstructs the
 * URL from an id->hash table at runtime. So a mirror of a Next.js, Nuxt or
 * SvelteKit app downloads the entry chunks named in the HTML, hydration then
 * asks for a chunk nobody ever recorded, and the whole app dies on a
 * ChunkLoadError behind a blank "Application error" screen.
 *
 * Returned specifiers are relative to `base`, NOT to the containing file:
 * webpack prepends `publicPath` to them. Resolving them against the JS file's
 * own URL — the obvious thing to do — yields
 * `/_next/static/chunks/static/chunks/x.js` and 404s on every one.
 *
 * No `eval`, and no JS parser. The values we need are string literals and
 * object literals, so they are recoverable by pattern; running a remote site's
 * bundle to ask it for its own URLs would hand that site the process.
 *
 * @param {string} js
 * @returns {{base: string|null, assets: string[]}}
 */
function extractBundlerAssets(js) {
  if (!looksLikeBundler(js)) return { base: null, assets: [] };

  const pub = js.match(PUBLIC_PATH_ASSIGN);
  const base = pub ? pub[3] : null;

  const found = new Set();
  const LIMIT = 5000;

  ASSET_LITERAL.lastIndex = 0;
  let m;
  while ((m = ASSET_LITERAL.exec(js)) !== null && found.size < LIMIT) {
    if (isPlausibleAsset(m[1])) found.add(m[1]);
  }

  // Form A first: its own tail also matches form B, so testing B first would
  // consume the match and drop the chunk id from every filename.
  HASHMAP_WITH_ID.lastIndex = 0;
  const consumed = [];
  while ((m = HASHMAP_WITH_ID.exec(js)) !== null && found.size < LIMIT) {
    const [whole, , prefix, , , mid, body, , suffix] = m;
    consumed.push(whole);
    for (const [id, hash] of mapPairs(body)) {
      const spec = `${prefix}${id}${mid}${hash}${suffix}`;
      if (isPlausibleAsset(spec)) found.add(spec);
    }
  }

  // Scan form B over what form A did not already claim.
  const rest = consumed.reduce((acc, whole) => acc.split(whole).join('\n'), js);
  HASHMAP_PLAIN.lastIndex = 0;
  while ((m = HASHMAP_PLAIN.exec(rest)) !== null && found.size < LIMIT) {
    const [, , prefix, body, , suffix] = m;
    // Only the map's *values* are filename fragments; its keys are chunk ids.
    for (const [, hash] of mapPairs(body)) {
      const spec = `${prefix}${hash}${suffix}`;
      if (isPlausibleAsset(spec)) found.add(spec);
    }
  }

  return { base, assets: [...found] };
}

/**
 * Asset paths that exist only inside inline `<script>` bodies.
 *
 * Frameworks ship a client-reference manifest in the page itself: Next.js App
 * Router pushes one through `self.__next_f.push([1,"…"])`, Nuxt uses
 * `__NUXT__`, SvelteKit inlines its start hydration call. The route's own
 * component chunk is named *only* there — it is absent from the webpack runtime
 * table and from every other saved file — so without this the one chunk the
 * page cannot render without is the one chunk nobody downloads.
 *
 * These paths sit inside a JS string inside an HTML attribute-free script, so
 * they arrive multiply escaped (`\\\"static/chunks/x.js\\\"`). Matching the
 * bare path rather than a quoted one sidesteps every layer of that.
 *
 * They are publicPath-relative like any other chunk path, and the page's own
 * `<script src>` tags are the only clue to what publicPath was. So the base is
 * inferred from them: a real ref ending in `/static/chunks/webpack-x.js` proves
 * that a mined `static/chunks/y.js` belongs under the same `/_next/` prefix.
 *
 * @param {string} html
 * @returns {string[]} specifiers, made root-absolute where a base was inferable
 */
function extractScriptAssets(html) {
  const $ = cheerio.load(html);

  // Real refs from the markup, used only to infer the asset base.
  const refs = [];
  $('script[src], link[href]').each((_, el) => {
    const node = $(el);
    const v = node.attr('src') || node.attr('href');
    if (v && !shouldSkipReference(v)) refs.push(v);
  });

  const mined = new Set();
  $('script:not([src])').each((_, el) => {
    const body = $(el).html() || '';
    // Skip JSON-LD and similar: structured data holds page URLs and image
    // links that the HTML already declares properly, so mining it only
    // duplicates work already done by forEachHtmlRef.
    const type = ($(el).attr('type') || '').toLowerCase();
    if (type && type.includes('json') && !type.includes('javascript')) return;

    ASSET_BARE.lastIndex = 0;
    let m;
    while ((m = ASSET_BARE.exec(body)) !== null && mined.size < 5000) {
      if (isPlausibleAsset(m[0])) mined.add(m[0]);
    }
  });

  const out = new Set();
  for (const spec of mined) {
    // Already absolute or document-relative in a way we can trust as-is.
    if (/^(\/|https?:\/\/|\.{1,2}\/)/.test(spec)) {
      out.add(spec);
      continue;
    }

    const firstSeg = spec.slice(0, spec.indexOf('/') + 1); // "static/"
    let based = null;
    for (const ref of refs) {
      const at = ref.indexOf(`/${firstSeg}`);
      if (at === -1) continue;
      based = `${ref.slice(0, at + 1)}${spec}`;
      break;
    }
    out.add(based || spec);
  }

  return [...out];
}

/**
 * Repoint a bundler's `publicPath` at the mirrored files.
 *
 * This is the difference between a mirror that renders and one that shows a
 * blank error page. `publicPath` is baked in as a root-absolute string
 * (`c.p="/_next/"`), so every chunk webpack loads at runtime is requested from
 * the filesystem root — `file:///_next/static/chunks/x.js` — no matter where
 * the mirror actually lives. Rewriting the `<script src>` tags in the HTML does
 * not help: those cover only the entry chunks, and everything loaded after
 * hydration goes through this string.
 *
 * A plain relative path cannot work either. webpack assigns the result to
 * `script.src`, which the browser resolves against the *document*, so one
 * literal would have to be correct for pages at every directory depth at once.
 * The replacement therefore resolves at runtime against the URL of this very
 * script — an absolute base, computed from wherever the mirror was unzipped to,
 * identical for every page that loads it.
 *
 * @param {string} js
 * @param {string} ownFile   basename of this script on disk, for the fallback lookup
 * @param {(base: string) => string|null} resolveBase
 *        maps the original publicPath to a path relative to this script's
 *        directory (e.g. "../../"), or null to leave the code untouched
 */
function rewriteAssetBase(js, ownFile, resolveBase) {
  if (!looksLikeBundler(js)) return js;

  const m = js.match(PUBLIC_PATH_ASSIGN);
  if (!m) return js;

  const relative = resolveBase(m[3]);
  if (!relative) return js;

  const original = JSON.stringify(m[3]);
  const rel = JSON.stringify(relative);
  const own = JSON.stringify(ownFile);

  // `document.currentScript` is the cheap path and is set during a script's own
  // synchronous execution, including for `async` scripts. It is null inside a
  // module or a worker, where scanning for our own filename is the fallback and
  // the original value is the last resort — a wrong base is worse than an
  // unchanged one, because it turns a working relative reference into a 404.
  const expr =
    `(function(){try{` +
    `if(typeof document==="undefined")return ${original};` +
    `var s=document.currentScript&&document.currentScript.src;` +
    `if(!s){var a=document.getElementsByTagName("script");` +
    `for(var i=a.length-1;i>=0;i--){if(a[i].src&&a[i].src.indexOf(${own})>-1){s=a[i].src;break}}}` +
    `return s?new URL(${rel},s).href:${original};` +
    `}catch(e){return ${original}}})()`;

  return js.replace(m[0], `${m[1]}.p=${expr}`);
}

function extractCss(css) {
  const found = [];
  mapCssUrls(css, (raw) => {
    found.push(raw);
    return undefined;
  });
  return found;
}

function rewriteCss(css, resolve) {
  return mapCssUrls(css, (raw) => {
    const next = resolve(raw, 'asset');
    return next === null || next === undefined ? undefined : next;
  });
}

module.exports = {
  extractHtml,
  rewriteHtml,
  extractCss,
  rewriteCss,
  extractJsImports,
  rewriteJsImports,
  extractBundlerAssets,
  extractScriptAssets,
  rewriteAssetBase,
  parseSrcset,
  serializeSrcset,
  mapCssUrls,
};
