'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractHtml,
  rewriteHtml,
  extractCss,
  rewriteCss,
  parseSrcset,
  extractJsImports,
  rewriteJsImports,
  extractBundlerAssets,
  extractScriptAssets,
  rewriteAssetBase,
} = require('../lib/extract');
const { normalize, inPageScope, shouldSkipReference } = require('../lib/scope');

// --- extraction ------------------------------------------------------------

test('separates navigational links from assets', () => {
  const html = `
    <link rel="stylesheet" href="/a.css">
    <script src="/a.js"></script>
    <img src="/a.png">
    <a href="/about">About</a>
  `;
  const { pages, assets } = extractHtml(html);

  assert.deepEqual(pages, ['/about']);
  assert.deepEqual(assets.sort(), ['/a.css', '/a.js', '/a.png']);
});

test('ignores link rels that are not assets', () => {
  // canonical/alternate point at pages we may already be crawling; following
  // them as assets causes duplicate downloads and rewrite loops.
  const html = `
    <link rel="canonical" href="/canonical">
    <link rel="dns-prefetch" href="//cdn.example.com">
    <link rel="stylesheet" href="/real.css">
  `;
  const { assets } = extractHtml(html);
  assert.deepEqual(assets, ['/real.css']);
});

test('picks up icons and manifests', () => {
  const html = `
    <link rel="icon" href="/favicon.ico">
    <link rel="apple-touch-icon" href="/touch.png">
    <link rel="manifest" href="/site.webmanifest">
  `;
  const { assets } = extractHtml(html);
  assert.equal(assets.length, 3);
});

test('finds urls inside style blocks and style attributes', () => {
  const html = `
    <style>.a { background: url('/bg.png'); }</style>
    <div style="background-image: url(/inline.jpg)"></div>
  `;
  const { assets } = extractHtml(html);
  assert.ok(assets.includes('/bg.png'), 'missed <style> url');
  assert.ok(assets.includes('/inline.jpg'), 'missed style attribute url');
});

test('reads <base href>', () => {
  const { baseHref } = extractHtml('<base href="https://cdn.example.com/v2/">');
  assert.equal(baseHref, 'https://cdn.example.com/v2/');
});

// --- srcset ----------------------------------------------------------------

test('parses srcset with descriptors', () => {
  const parts = parseSrcset('/a.png 1x, /b.png 2x');
  assert.deepEqual(parts, [
    { url: '/a.png', descriptor: '1x' },
    { url: '/b.png', descriptor: '2x' },
  ]);
});

test('parses srcset without descriptors', () => {
  assert.deepEqual(parseSrcset('/only.png'), [{ url: '/only.png', descriptor: '' }]);
});

test('a srcset candidate with no descriptor is not merged with the next', () => {
  // Regression guard, found by crawling apple.com. A URL token runs to the
  // next whitespace, so `a.jpg, b.jpg` used to parse as the single broken
  // URL `a.jpg,` — requesting a 404 *and* silently dropping b.jpg from the
  // mirror. Expected values were confirmed against Chromium, not assumed.
  assert.deepEqual(
    parseSrcset('a.jpg, b.jpg').map((p) => p.url),
    ['a.jpg', 'b.jpg']
  );
  assert.deepEqual(
    parseSrcset('a.jpg, b.jpg 2x').map((p) => p.url),
    ['a.jpg', 'b.jpg']
  );
  assert.deepEqual(
    parseSrcset('s.jpg, m.jpg, l.jpg').map((p) => p.url),
    ['s.jpg', 'm.jpg', 'l.jpg']
  );
});

test('a comma with no surrounding space stays part of the URL', () => {
  // Chromium requests `a.jpg,b.jpg` as ONE url — commas are legal in URLs,
  // and only whitespace separates a candidate from its descriptor.
  assert.deepEqual(
    parseSrcset('a.jpg,b.jpg').map((p) => p.url),
    ['a.jpg,b.jpg']
  );
});

test('srcset parsing survives commas inside data URIs', () => {
  // Splitting on ',' naively corrupts a data: URI, which always contains one.
  const parts = parseSrcset('data:image/svg+xml;base64,AAA= 1x, /real.png 2x');
  assert.equal(parts.length, 2);
  assert.equal(parts[1].url, '/real.png');
});

test('extracts every candidate from a srcset', () => {
  const { assets } = extractHtml('<img srcset="/s.png 480w, /m.png 800w, /l.png 1200w">');
  assert.deepEqual(assets, ['/s.png', '/m.png', '/l.png']);
});

// --- non-fetchable references ---------------------------------------------

test('skips schemes that are not downloadable', () => {
  for (const raw of [
    'data:image/png;base64,AAA',
    'mailto:a@b.com',
    'javascript:void(0)',
    'tel:+15551234',
    '#section',
    '',
    '   ',
  ]) {
    assert.equal(shouldSkipReference(raw), true, `should skip: ${raw}`);
  }
  assert.equal(shouldSkipReference('/real.css'), false);
});

// --- rewriting -------------------------------------------------------------

test('rewrites references through the resolver', () => {
  const html = '<link rel="stylesheet" href="/css/a.css"><img src="/img/b.png">';
  const out = rewriteHtml(html, (raw) => `LOCAL${raw}`);

  assert.ok(out.includes('href="LOCAL/css/a.css"'), out);
  assert.ok(out.includes('src="LOCAL/img/b.png"'), out);
});

test('a null resolver result leaves the reference untouched', () => {
  const html = '<a href="https://external.example/x">x</a>';
  const out = rewriteHtml(html, () => null);
  assert.ok(out.includes('https://external.example/x'));
});

test('rewrites each srcset candidate and keeps descriptors', () => {
  const html = '<img srcset="/a.png 1x, /b.png 2x">';
  const out = rewriteHtml(html, (raw) => raw.replace('/', 'local/'));

  assert.ok(out.includes('local/a.png 1x'), out);
  assert.ok(out.includes('local/b.png 2x'), out);
});

test('strips <base href> so relative paths resolve locally', () => {
  // Left in place, a base href pointing at the live origin silently defeats
  // every rewritten relative path.
  const html = '<base href="https://example.com/"><img src="/a.png">';
  const out = rewriteHtml(html, (raw) => raw);
  assert.ok(!/base[^>]+href/i.test(out), `base href survived: ${out}`);
});

test('rewrites urls inside style blocks', () => {
  const html = "<style>.a { background: url('/bg.png'); }</style>";
  const out = rewriteHtml(html, () => 'local/bg.png');
  assert.ok(out.includes('local/bg.png'), out);
});

// --- css -------------------------------------------------------------------

test('extracts css url() and @import references', () => {
  const css = `
    @import "reset.css";
    .a { background: url(img/a.png); }
    .b { background: url("img/b.png"); }
    @font-face { src: url('fonts/c.woff2'); }
  `;
  const found = extractCss(css);
  assert.ok(found.includes('img/a.png'));
  assert.ok(found.includes('img/b.png'));
  assert.ok(found.includes('fonts/c.woff2'));
  assert.ok(found.includes('reset.css'));
});

test('finds the target of @import url(...)', () => {
  // This is the form that pulls in a second stylesheet — missing it means the
  // mirror silently loses half its styling.
  assert.ok(extractCss('@import url("tokens.css");').includes('tokens.css'));
});

test('rewrites css references and preserves quote style', () => {
  const out = rewriteCss('.a { background: url("img/a.png"); }', () => 'local/a.png');
  assert.ok(out.includes('url("local/a.png")'), out);
});

// --- scope -----------------------------------------------------------------

test('normalize strips fragments and default ports', () => {
  assert.equal(normalize('https://ex.com/a#top').href, 'https://ex.com/a');
  assert.equal(normalize('https://ex.com:443/a').href, 'https://ex.com/a');
  assert.equal(normalize('http://EX.com/a').hostname, 'ex.com');
});

test('normalize rejects non-http schemes', () => {
  assert.equal(normalize('ftp://ex.com/a'), null);
  assert.equal(normalize('not a url'), null);
});

test('page scope stays on the origin host by default', () => {
  const origin = normalize('https://ex.com/');
  assert.equal(inPageScope(normalize('https://ex.com/a'), origin, {}), true);
  assert.equal(inPageScope(normalize('https://other.com/a'), origin, {}), false);
  assert.equal(inPageScope(normalize('https://blog.ex.com/a'), origin, {}), false);
});

test('includeSubdomains widens scope to the registrable domain', () => {
  const origin = normalize('https://ex.com/');
  const opts = { includeSubdomains: true };
  assert.equal(inPageScope(normalize('https://blog.ex.com/a'), origin, opts), true);
  assert.equal(inPageScope(normalize('https://other.com/a'), origin, opts), false);
});

test('noParent keeps the crawl at or below the start path', () => {
  const origin = normalize('https://ex.com/docs/');
  const opts = { noParent: true };
  assert.equal(inPageScope(normalize('https://ex.com/docs/a'), origin, opts), true);
  assert.equal(inPageScope(normalize('https://ex.com/blog/a'), origin, opts), false);
});

// --- JavaScript module discovery -------------------------------------------

test('finds code-split chunks imported from JavaScript', () => {
  // Found by crawling apple.com: the entry script is a stub that imports
  // hashed chunks named nowhere in the HTML. Fetching only what the markup
  // references leaves the mirror looking right while its whole interactive
  // layer 404s.
  const js =
    'import{E as t}from"./ComponentMap-abc.built.js";' +
    'import"./side-effect.js";' +
    'const x=await import("/chunks/lazy.js");' +
    'export{a}from"../up/reexport.js";';

  const found = extractJsImports(js);
  assert.ok(found.includes('./ComponentMap-abc.built.js'));
  assert.ok(found.includes('./side-effect.js'));
  assert.ok(found.includes('/chunks/lazy.js'));
  assert.ok(found.includes('../up/reexport.js'));
});

test('bare package specifiers are ignored', () => {
  // `react` is resolved by a bundler at build time and has no URL to fetch.
  const found = extractJsImports('import React from "react";import"./real.js";');
  assert.deepEqual(found, ['./real.js']);
});

test('rewritten module specifiers stay valid ES module references', () => {
  // ES modules are stricter than HTML: a specifier not starting with '/',
  // './' or '../' is a package name. Our relative-path helper returns bare
  // names, so rewriting naively produced "Failed to resolve module
  // specifier" and broke every chunk — worse than not rewriting at all.
  const js = 'import{a}from"./chunk-abc.js";';
  const out = rewriteJsImports(js, (spec) => spec.replace(/^\.\//, ''));

  assert.match(out, /from"\.\/chunk-abc\.js"/, 'the ./ prefix must survive');
  assert.ok(!/from"chunk-abc\.js"/.test(out), 'a bare specifier is invalid');
});

test('rewriting leaves non-import code untouched', () => {
  const js = 'const s="./not-an-import.js";import{a}from"./real.js";';
  const out = rewriteJsImports(js, () => './LOCAL.js');
  assert.ok(out.includes('const s="./not-an-import.js"'), 'string literals must not be rewritten');
});

// --- bundler assets --------------------------------------------------------

test('mines webpack chunk URLs that no import statement mentions', () => {
  // The real shape Next.js emits: a ternary chain of complete literal paths,
  // reached only through __webpack_require__.e(id) at runtime.
  const js =
    'var c={};__webpack_require__=c;' +
    'c.u=e=>4459===e?"static/chunks/4459-8ec03f9821b3e9ce.js":' +
    '5192===e?"static/chunks/5192-0ffe23d6aaaefab4.js":"x";' +
    'c.p="/_next/";';

  const { base, assets } = extractBundlerAssets(js);

  assert.equal(base, '/_next/', 'publicPath is what these paths are relative to');
  assert.ok(assets.includes('static/chunks/5192-0ffe23d6aaaefab4.js'));
  assert.ok(assets.includes('static/chunks/4459-8ec03f9821b3e9ce.js'));
  assert.equal(extractJsImports(js).length, 0, 'proves import-scanning cannot find these');
});

test('expands the prefix+hashmap+suffix chunk template', () => {
  // Here the filename never exists as one literal, so only expanding the map
  // recovers it. Next.js uses this form for CSS chunks.
  const js =
    '__webpack_require__.miniCssF=e=>"static/css/"+' +
    '({6745:"27f14a110687f84b",7106:"7f78bc37869a5353"})[e]+".css";';

  const { assets } = extractBundlerAssets(js);

  assert.ok(assets.includes('static/css/27f14a110687f84b.css'));
  assert.ok(assets.includes('static/css/7f78bc37869a5353.css'));
});

test('ignores files that are not bundles', () => {
  // Gating on a webpack marker keeps `.p=` — two characters — from matching
  // arbitrary minified code.
  const js = 'const o={};o.p="/not/a/public/path/";o.q="a/b.js";';
  assert.deepEqual(extractBundlerAssets(js), { base: null, assets: [] });
});

test('finds the route chunk that lives only in an inline script', () => {
  // Next.js App Router pushes its client-reference manifest through
  // self.__next_f. The route's own component chunk is named nowhere else —
  // not in the webpack runtime, not in any other saved file — so missing this
  // is what leaves a mirrored page showing a blank "Application error".
  const html =
    '<html><head>' +
    '<script src="/_next/static/chunks/webpack-abc.js"></script>' +
    '<script>self.__next_f.push([1,"3:I[4359,[\\"422\\",' +
    '\\"static/chunks/422-5933d4e82992be4f.js\\",\\"465\\",' +
    '\\"static/chunks/app/page-a8ff1353.js\\"],\\"Providers\\"]"])</script>' +
    '</head><body></body></html>';

  const found = extractScriptAssets(html);

  // Rebased onto the publicPath proven by the real <script src> above, because
  // these paths are publicPath-relative rather than document-relative.
  assert.ok(
    found.includes('/_next/static/chunks/app/page-a8ff1353.js'),
    `route chunk missing or unbased: ${JSON.stringify(found)}`
  );
  assert.ok(found.includes('/_next/static/chunks/422-5933d4e82992be4f.js'));
});

test('inline-script mining skips structured-data blocks', () => {
  const html =
    '<html><body><script type="application/ld+json">' +
    '{"logo":"https://x.test/a/logo.png"}</script></body></html>';
  assert.deepEqual(extractScriptAssets(html), []);
});

test('publicPath is rewritten to resolve against the script own URL', () => {
  // A literal relative path cannot work: webpack assigns the result to
  // script.src, which resolves against the *document*, so one value would have
  // to be right for pages at every depth. Resolving against the script's own
  // URL gives an absolute base that is identical for all of them.
  const js = 'var c={};__webpack_require__=c;c.p="/_next/";';
  const out = rewriteAssetBase(js, 'webpack-abc.js', () => '../../');

  assert.ok(!/c\.p="\/_next\/"/.test(out), 'the root-absolute literal must be gone');
  assert.match(out, /new URL\("\.\.\/\.\.\/",s\)/, 'must resolve against the script URL');
  assert.match(out, /"\/_next\/"/, 'the original value must survive as a fallback');
});

test('publicPath rewriting is skipped when the base cannot be mapped', () => {
  // A wrong base is worse than an unchanged one: it converts references that
  // still work online into guaranteed 404s.
  const js = 'var c={};__webpack_require__=c;c.p="/_next/";';
  assert.equal(rewriteAssetBase(js, 'webpack-abc.js', () => null), js);
});

test('integrity is dropped once a reference points at a local file', () => {
  // SRI is only checked on a CORS fetch, and a file:// document has an opaque
  // origin — so the browser refuses to run the script at all rather than
  // falling back. The hash would be wrong for any file we rewrote anyway.
  const html =
    '<html><head>' +
    '<script src="/app.js" integrity="sha384-aaa" crossorigin="anonymous"></script>' +
    '<script src="https://cdn.test/x.js" integrity="sha384-bbb" crossorigin="anonymous"></script>' +
    '</head><body></body></html>';

  const out = rewriteHtml(html, (raw) => (raw.startsWith('http') ? null : 'app.js'));

  assert.ok(!/integrity="sha384-aaa"/.test(out), 'local ref must lose its integrity attr');
  assert.ok(
    /integrity="sha384-bbb"/.test(out),
    'a still-remote ref keeps a check that remains valid and meaningful'
  );
});

test('the chunk id survives the template expansion', () => {
  // Regression guard, found crawling suitsupply.com. The real webpack form is
  //   "static/chunks/" + e + "." + {248:"cad4287d"}[e] + ".js"
  // and matching only the literal nearest the map produced ".cad4287d.js",
  // which resolved against publicPath into "/_next/.cad4287d.js" — a URL that
  // exists nowhere. Those 404s came back as soft-404 HTML, so each one was
  // then classified, saved and browser-rendered as if it were a page.
  const js =
    '__webpack_require__.u=e=>"static/chunks/"+e+"."+' +
    '({248:"cad4287d5babafc1",284:"2d69585aa2b2385d"})[e]+".js";';

  const { assets } = extractBundlerAssets(js);

  assert.ok(
    assets.includes('static/chunks/248.cad4287d5babafc1.js'),
    `chunk id dropped: ${JSON.stringify(assets)}`
  );
  assert.ok(assets.includes('static/chunks/284.2d69585aa2b2385d.js'));
  assert.ok(
    !assets.some((a) => a.startsWith('.') || a.includes('/.')),
    `malformed path emitted: ${JSON.stringify(assets)}`
  );
});

test('both chunk template shapes coexist in one bundle', () => {
  // Form A's tail on its own also matches form B, so scanning B first would
  // silently strip the id from every JS chunk while the CSS ones looked fine.
  const js =
    '__webpack_require__.u=e=>"static/chunks/"+e+"."+({248:"aaaaaaaaaaaaaaaa"})[e]+".js";' +
    '__webpack_require__.miniCssF=e=>"static/css/"+({6745:"bbbbbbbbbbbbbbbb"})[e]+".css";';

  const { assets } = extractBundlerAssets(js);

  assert.ok(assets.includes('static/chunks/248.aaaaaaaaaaaaaaaa.js'), JSON.stringify(assets));
  assert.ok(assets.includes('static/css/bbbbbbbbbbbbbbbb.css'), JSON.stringify(assets));
});

// --- navigation survives hydration -----------------------------------------

test('a rewritten local link gets a hydration-proof marker', () => {
  // Found by clicking a real crawled mirror: React hydration reads its own
  // routing data from the page's inline payload, not the DOM's href, and
  // "corrects" our rewritten href back to the framework's original — every
  // click then 404s. The marker attribute is not part of any framework's
  // rendered output, so hydration has no reason to touch it.
  const html = '<a href="/men/suits/the-perennial-suit">Suits</a>';
  const out = rewriteHtml(html, () => 'men/suits/the-perennial-suit.html');

  assert.match(out, /href="men\/suits\/the-perennial-suit\.html"/);
  assert.match(out, /data-sitesnap-href="men\/suits\/the-perennial-suit\.html"/);
});

test('a link left pointing at the live site gets no marker', () => {
  // Only a real local target is safe to force navigation to. A page that
  // was not crawled resolves to its absolute URL instead, and forcing a
  // location.href to that would just replace a broken local link with an
  // unpredictable live-network jump.
  const html = '<a href="/not/crawled">x</a>';
  const out = rewriteHtml(html, () => 'https://example.com/not/crawled');

  assert.ok(!/data-sitesnap-href/.test(out), out);
});

test('a link the resolver leaves untouched gets no marker', () => {
  const html = '<a href="/x">x</a>';
  const out = rewriteHtml(html, () => null);
  assert.ok(!/data-sitesnap-href/.test(out), out);
});

test('the click interceptor is injected exactly once', () => {
  const html = '<a href="/a">a</a><a href="/b">b</a>';
  const out = rewriteHtml(html, (raw) => raw.slice(1) + '.html');

  assert.equal((out.match(/data-sitesnap-nav/g) || []).length, 1);
});

test('re-rewriting an already-patched page does not double the interceptor', () => {
  // A resumed crawl can run rewriteHtml on the same file twice. A second
  // script tag would double-navigate on every click.
  const html = '<a href="/a">a</a>';
  const once = rewriteHtml(html, () => 'a.html');
  const twice = rewriteHtml(once, () => 'a.html');

  assert.equal((twice.match(/data-sitesnap-nav/g) || []).length, 1);
});

test('a page with no local links gets no interceptor at all', () => {
  const html = '<img src="/a.png">';
  const out = rewriteHtml(html, () => 'a.png');
  assert.ok(!/data-sitesnap-nav/.test(out), out);
});

test('the click interceptor carries a pathname-keyed table, not just the marker', () => {
  // The marker attribute alone was tried first and confirmed (against a real
  // hydrating page) not to survive a hydration mismatch severe enough that
  // React discards and re-renders the subtree. The table lives in a <script>
  // outside whatever subtree mismatched, so it survives that case too.
  const html = '<a href="/men/suits/the-perennial-suit">Suits</a>';
  const out = rewriteHtml(html, () => 'men/suits/the-perennial-suit.html', {
    baseUrl: 'https://suitsupply.com/en-in/',
  });

  const script = out.match(/<script data-sitesnap-nav="1">([\s\S]*?)<\/script>/)[1];
  const tableJson = script.match(/var map=(\{.*?\});/)[1];
  const table = JSON.parse(tableJson);

  assert.equal(
    table['/men/suits/the-perennial-suit'],
    'men/suits/the-perennial-suit.html',
    `table missing or wrong: ${tableJson}`
  );
});

test('table keys are absolute pathnames, resolved against the real document URL', () => {
  // A relative `raw` like "../x" means something different depending on
  // which page it was found on. Without the source document's own URL, the
  // table cannot be built correctly — this is why rewriteHtml takes baseUrl.
  const html = '<a href="../checkout">Checkout</a>';
  const out = rewriteHtml(html, () => 'checkout.html', {
    baseUrl: 'https://example.com/en-in/cart/',
  });

  const script = out.match(/<script data-sitesnap-nav="1">([\s\S]*?)<\/script>/)[1];
  const table = JSON.parse(script.match(/var map=(\{.*?\});/)[1]);

  assert.equal(table['/en-in/checkout'], 'checkout.html', JSON.stringify(table));
});

test('no baseUrl still rewrites correctly, only the table degrades', () => {
  // baseUrl is an enhancement, not a requirement — every existing caller that
  // omits it must keep working exactly as before.
  const html = '<a href="/a">a</a>';
  const out = rewriteHtml(html, () => 'a.html');
  assert.match(out, /href="a\.html"/);
});

test('re-rewriting replaces a stale table rather than keeping it', () => {
  // A resumed crawl can rewrite the same file twice with a fuller manifest
  // the second time. The old skip-if-already-present guard would have frozen
  // the table at its first-run contents forever.
  const html = '<a href="/a">a</a>';
  const first = rewriteHtml(html, () => null); // not yet crawled, no local target
  const second = rewriteHtml(first, () => 'a.html'); // now crawled

  const script = second.match(/<script data-sitesnap-nav="1">([\s\S]*?)<\/script>/)[1];
  const table = JSON.parse(script.match(/var map=(\{.*?\});/)[1]);
  assert.equal(table['/a'], 'a.html', JSON.stringify(table));
  assert.equal((second.match(/data-sitesnap-nav/g) || []).length, 1, 'must not duplicate the script');
});

test('a link resolved to a live absolute URL clears any earlier marker', () => {
  const html = '<a href="/a" data-sitesnap-href="a.html">a</a>';
  const out = rewriteHtml(html, () => 'https://example.com/a');
  assert.ok(!/data-sitesnap-href/.test(out), out);
});
