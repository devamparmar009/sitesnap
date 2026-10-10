'use strict';

/**
 * The runtime URL map.
 *
 * The static rewrite pass can only repoint references it can see. A URL built
 * while the page runs — `` `${cdn}/models/${name}.glb` `` — exists nowhere in
 * the source, so the pass cannot touch it, and the mirror quietly loads that
 * resource from the live internet instead of from disk. three.js's own glTF
 * example does precisely this: the mirror downloaded a 3.7MB model, wrote it
 * to disk, and then fetched the remote copy anyway.
 *
 * These cover the map's two load-bearing promises: that it redirects what it
 * knows, and that it does not touch anything else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { Crawler } = require('../lib/crawler');
const {
  buildRuntimeScript,
  runtimeTag,
  injectRuntime,
  RUNTIME_FILENAME,
} = require('../lib/runtime');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sitesnap-rt-'));
const listen = (srv) =>
  new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const close = (srv) => new Promise((r) => srv.close(r));

// --- script generation ------------------------------------------------------

test('the generated script is syntactically valid JavaScript', () => {
  const src = buildRuntimeScript([
    ['https://cdn.example.com/a/model.glb', 'cdn.example.com/a/model.glb'],
    ['https://cdn.example.com/x.json?v=2', 'cdn.example.com/x@ab12cd.json'],
  ]);
  // Throws on a syntax error; the mirror would otherwise ship a broken page.
  assert.doesNotThrow(() => new Function(src));
  assert.match(src, /model\.glb/);
});

test('URLs with characters that matter in JS are safely encoded', () => {
  const src = buildRuntimeScript([
    ['https://x.example/a"b</script>.json', 'x.example/weird.json'],
    ["https://x.example/it's.glb", 'x.example/its.glb'],
  ]);
  assert.doesNotThrow(() => new Function(src));
});

// --- injection --------------------------------------------------------------

test('the tag goes first inside <head>, before any page script', () => {
  const html = '<!DOCTYPE html><html><head><script src="app.js"></script></head><body></body></html>';
  const out = injectRuntime(html, runtimeTag('../sitesnap-runtime.js'));
  assert.ok(out.indexOf('sitesnap-runtime.js') < out.indexOf('app.js'), 'must patch before app code runs');
});

test('the tag is neither async nor deferred', () => {
  // Either attribute would let the page issue its requests against the
  // unpatched originals, which is the whole failure being fixed.
  const tag = runtimeTag('../sitesnap-runtime.js');
  assert.doesNotMatch(tag, /\basync\b/);
  assert.doesNotMatch(tag, /\bdefer\b/);
  assert.doesNotMatch(tag, /type="module"/);
});

test('data-base points back at the mirror root from the page', () => {
  assert.match(runtimeTag('../../sitesnap-runtime.js'), /data-base="\.\.\/\.\.\/"/);
  assert.match(runtimeTag('sitesnap-runtime.js'), /data-base=""/);
});

test('a document with no <head> still gets the script', () => {
  const out = injectRuntime('<html><body>hi</body></html>', runtimeTag('x.js'));
  assert.ok(out.includes('x.js'));
  assert.ok(out.indexOf('x.js') < out.indexOf('hi'));

  const bare = injectRuntime('just text', runtimeTag('x.js'));
  assert.ok(bare.includes('x.js'));
});

// --- behaviour, in a real DOM-less evaluation -------------------------------

/**
 * Run the generated script against a minimal fake window and return the
 * patched fetch, so the mapping logic is exercised rather than assumed.
 */
function evaluateShim(pairs, base = '../') {
  const calls = [];
  const win = {
    fetch(url) {
      calls.push(String(url));
      return Promise.resolve({ ok: true });
    },
    XMLHttpRequest: function () {},
    Element: function () {},
  };
  win.XMLHttpRequest.prototype = { open(method, url) { calls.push(String(url)); } };
  win.Element.prototype = { setAttribute(name, value) { calls.push(`${name}=${value}`); } };

  const doc = {
    baseURI: 'http://localhost/site/page.html',
    currentScript: { getAttribute: (n) => (n === 'data-base' ? base : null) },
  };

  const src = buildRuntimeScript(pairs);
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'URL', 'Request', `with (window) { ${src} }`)(
    win,
    doc,
    URL,
    class Request {}
  );
  return { win, calls };
}

test('a mapped URL is redirected to the local copy', async () => {
  const { win, calls } = evaluateShim([
    ['https://cdn.example.com/models/helmet.glb', 'cdn.example.com/models/helmet.glb'],
  ]);
  await win.fetch('https://cdn.example.com/models/helmet.glb');
  assert.equal(calls[0], '../cdn.example.com/models/helmet.glb');
});

test('an unmapped URL is passed through untouched', async () => {
  // The safety property: never invent a local path for something not mirrored,
  // or a page that fetches an un-mirrored resource gets a fabricated 404
  // instead of degrading to the live site.
  const { win, calls } = evaluateShim([['https://cdn.example.com/a.glb', 'cdn.example.com/a.glb']]);
  await win.fetch('https://other.example.com/b.glb');
  assert.equal(calls[0], 'https://other.example.com/b.glb');
});

test('data: and blob: URLs are never rewritten', async () => {
  const { win, calls } = evaluateShim([['https://x/a.png', 'x/a.png']]);
  await win.fetch('data:image/png;base64,AAAA');
  await win.fetch('blob:http://localhost/abc-def');
  assert.equal(calls[0], 'data:image/png;base64,AAAA');
  assert.equal(calls[1], 'blob:http://localhost/abc-def');
});

test('a fragment survives the rewrite', async () => {
  const { win, calls } = evaluateShim([['https://cdn.example.com/m.gltf', 'cdn.example.com/m.gltf']]);
  await win.fetch('https://cdn.example.com/m.gltf#mesh0');
  assert.equal(calls[0], '../cdn.example.com/m.gltf#mesh0');
});

test('XMLHttpRequest is mapped too', () => {
  const { win, calls } = evaluateShim([['https://cdn.example.com/d.json', 'cdn.example.com/d.json']]);
  const xhr = new win.XMLHttpRequest();
  xhr.open('GET', 'https://cdn.example.com/d.json');
  assert.equal(calls[0], '../cdn.example.com/d.json');
});

// --- end to end -------------------------------------------------------------

test('a crawl ships the map, and every page loads it', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/style.css') {
      res.setHeader('content-type', 'text/css');
      res.end('body{margin:0}');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      req.url === '/deep/page.html'
        ? '<html><head><link rel="stylesheet" href="/style.css"></head><body>deep</body></html>'
        : '<html><head><link rel="stylesheet" href="/style.css"></head>' +
          '<body><a href="/deep/page.html">d</a></body></html>'
    );
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    await new Crawler(origin, out, { respectRobots: false, maxPages: 5 }).run();

    const map = await fsp.readFile(path.join(out, RUNTIME_FILENAME), 'utf8');
    assert.match(map, /style\.css/, 'the mirrored asset belongs in the map');

    // Both pages, at different depths, must reach the map correctly.
    const host = (await fsp.readdir(out)).find((d) => d.startsWith('127.0.0.1'));
    const root = await fsp.readFile(path.join(out, host, 'index.html'), 'utf8');
    const deep = await fsp.readFile(path.join(out, host, 'deep', 'page.html'), 'utf8');
    assert.match(root, /src="\.\.\/sitesnap-runtime\.js"/);
    assert.match(deep, /src="\.\.\/\.\.\/sitesnap-runtime\.js"/);
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('--no-runtime-rewrite ships neither the map nor the tag', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><head></head><body>x</body></html>');
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    await new Crawler(origin, out, {
      respectRobots: false,
      maxPages: 1,
      runtimeRewrite: false,
    }).run();

    await assert.rejects(() => fsp.access(path.join(out, RUNTIME_FILENAME)));
    const host = (await fsp.readdir(out)).find((d) => d.startsWith('127.0.0.1'));
    const page = await fsp.readFile(path.join(out, host, 'index.html'), 'utf8');
    assert.doesNotMatch(page, /sitesnap-runtime/);
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});
