'use strict';

/**
 * Behavioural tests against a real local HTTP server.
 *
 * These cover things unit tests on pure functions cannot: the worker pool,
 * budget enforcement, and the two-pass rewrite as a whole.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { Crawler } = require('../lib/crawler');

/** Start a server from a {path: handler|string} routing table. */
async function serve(routes, { delay = 0, onRequest } = {}) {
  const server = http.createServer(async (req, res) => {
    if (onRequest) onRequest(req);
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const url = req.url.split('?')[0];
    const route = routes[url];

    if (route === undefined) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    const body = typeof route === 'function' ? route() : route;

    // `type: ''` means "send no Content-Type at all", which is a distinct
    // case from omitting the field (where the default text/html applies).
    const type = body && typeof body === 'object' && 'type' in body ? body.type : 'text/html';
    if (type) res.setHeader('content-type', type);
    if (body && typeof body === 'object' && body.status) res.statusCode = body.status;

    res.end(body && typeof body === 'object' && 'body' in body ? body.body : body);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((r) => server.close(r)) };
}

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sitesnap-test-'));
}

/**
 * Every file under `dir`, as one space-joined string for easy assertions.
 * Walks rather than guessing the host directory name — the crawler encodes
 * ports as `host_port`, not `host:port`.
 */
async function listFiles(dir) {
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath || e.path, e.name))
    .join(' ');
}

// --- the worker pool -------------------------------------------------------

test('the worker pool actually runs requests in parallel', async () => {
  // Regression guard. This previously collapsed to one worker: #take() shifted
  // a task but #active was incremented only after the caller's await, so every
  // other worker saw {empty queue, active === 0} and exited at startup. The
  // failure was invisible — crawls still completed, just serially.
  let inFlight = 0;
  let peak = 0;

  const links = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">p</a>`).join('');
  const routes = { '/': `<html>${links}</html>` };
  for (let i = 0; i < 12; i++) routes[`/p${i}`] = '<html>leaf</html>';

  const srv = await serve(routes, {
    delay: 60,
    onRequest: () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => inFlight--, 60);
    },
  });
  const out = await tmp();

  try {
    const crawler = new Crawler(srv.origin, out, {
      concurrency: 5,
      respectRobots: false,
    });
    await crawler.run();
    assert.ok(peak > 1, `pool ran serially (peak in-flight ${peak})`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('concurrency of 1 is honoured', async () => {
  let inFlight = 0;
  let peak = 0;

  const routes = { '/': '<html><a href="/a">a</a><a href="/b">b</a></html>', '/a': 'x', '/b': 'y' };
  const srv = await serve(routes, {
    delay: 40,
    onRequest: () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => inFlight--, 40);
    },
  });
  const out = await tmp();

  try {
    await new Crawler(srv.origin, out, { concurrency: 1, respectRobots: false }).run();
    assert.equal(peak, 1, `expected serial, saw ${peak} in flight`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- budgets ---------------------------------------------------------------

test('maxPages caps how many HTML pages are fetched', async () => {
  const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">p</a>`).join('');
  const routes = { '/': `<html>${links}</html>` };
  for (let i = 0; i < 30; i++) routes[`/p${i}`] = '<html>leaf</html>';

  const srv = await serve(routes);
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, {
      maxPages: 5,
      respectRobots: false,
    }).run();
    assert.ok(result.stats.pages <= 6, `fetched ${result.stats.pages} pages, expected ~5`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('maxDepth stops the crawl descending further', async () => {
  const routes = {
    '/': '<html><a href="/one">1</a></html>',
    '/one': '<html><a href="/two">2</a></html>',
    '/two': '<html><a href="/three">3</a></html>',
    '/three': '<html>deep</html>',
  };
  const srv = await serve(routes);
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, {
      maxDepth: 1,
      respectRobots: false,
    }).run();
    assert.ok(result.stats.pages <= 2, `expected root + 1 level, got ${result.stats.pages}`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- the two-pass rewrite --------------------------------------------------

test('links are rewritten to working local paths', async () => {
  const srv = await serve({
    '/': '<html><link rel="stylesheet" href="/s.css"><a href="/about">a</a></html>',
    '/about': '<html>about</html>',
    '/s.css': { body: 'body{background:url(/bg.png)}', type: 'text/css' },
    '/bg.png': { body: 'PNGDATA', type: 'image/png' },
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, { respectRobots: false }).run();
    const index = await fsp.readFile(path.join(out, result.entryFile), 'utf8');

    assert.ok(index.includes('href="s.css"'), `stylesheet not localised: ${index}`);
    assert.ok(index.includes('href="about.html"'), `page link not localised: ${index}`);

    // The CSS-referenced image must have come along and been repointed.
    const css = await fsp.readFile(path.join(path.dirname(path.join(out, result.entryFile)), 's.css'), 'utf8');
    assert.ok(css.includes('url(bg.png)'), `css url not localised: ${css}`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('references that were never downloaded become absolute, not broken', async () => {
  const srv = await serve({
    '/': '<html><a href="https://elsewhere.example/page">off-site</a></html>',
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, { respectRobots: false }).run();
    const index = await fsp.readFile(path.join(out, result.entryFile), 'utf8');
    assert.ok(
      index.includes('https://elsewhere.example/page'),
      `off-site link should stay absolute: ${index}`
    );
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- filtering, end to end -------------------------------------------------

test('--include restricts which pages are crawled', async () => {
  const srv = await serve({
    '/': '<html><a href="/docs/a">d</a><a href="/blog/b">b</a></html>',
    '/docs/a': '<html>docs</html>',
    '/blog/b': '<html>blog</html>',
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, {
      respectRobots: false,
      include: ['/docs/*', '/'],
    }).run();

    const flat = await listFiles(out);
    assert.ok(flat.includes('docs'), `docs should be mirrored: ${flat}`);
    assert.ok(!flat.includes('blog'), `blog should have been filtered: ${flat}`);
    assert.ok(result.stats.filtered > 0, 'filtered count should be reported');
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('--exclude wins and also applies to assets', async () => {
  const srv = await serve({
    '/': '<html><script src="/analytics/t.js"></script><link rel="stylesheet" href="/s.css"><a href="/keep">k</a></html>',
    '/analytics/t.js': { body: 'track()', type: 'application/javascript' },
    '/s.css': { body: 'body{}', type: 'text/css' },
    '/keep': '<html>keep</html>',
  });
  const out = await tmp();

  try {
    await new Crawler(srv.origin, out, {
      respectRobots: false,
      exclude: ['/analytics/*'],
    }).run();

    const files = await listFiles(out);
    assert.ok(!files.includes('analytics'), `excluded asset was fetched: ${files}`);
    assert.ok(files.includes('s.css'), `unexcluded asset should still load: ${files}`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('an --include that excludes the start page still mirrors its assets', async () => {
  // Guards the rule that includes gate pages only. If includes applied to
  // assets, this page would be saved with no stylesheet.
  const srv = await serve({
    '/': '<html><link rel="stylesheet" href="/assets/s.css">home</html>',
    '/assets/s.css': { body: 'body{color:red}', type: 'text/css' },
  });
  const out = await tmp();

  try {
    await new Crawler(srv.origin, out, { respectRobots: false, include: ['/'] }).run();
    const files = await listFiles(out);
    assert.ok(files.includes('s.css'), `asset outside the include was dropped: ${files}`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('the start URL is exempt from --include but not from --exclude', async () => {
  // Without the exemption an --include that does not match the entry point
  // leaves nothing to crawl from, and the run returns empty.
  const srv = await serve({
    '/': '<html><a href="/docs/a">d</a><a href="/blog/b">b</a></html>',
    '/docs/a': '<html>docs</html>',
    '/blog/b': '<html>blog</html>',
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, {
      respectRobots: false,
      include: ['/docs/*'], // deliberately does not match "/"
    }).run();

    assert.equal(result.stats.pages, 2, 'expected the seed plus /docs/a');
    const flat = await listFiles(out);
    assert.ok(flat.includes('docs'), `included page missing: ${flat}`);
    assert.ok(!flat.includes('blog'), `filtered page present: ${flat}`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('an excluded start URL is still excluded', async () => {
  const srv = await serve({ '/': '<html>home</html>' });
  const out = await tmp();

  try {
    await assert.rejects(
      () => new Crawler(srv.origin, out, { respectRobots: false, exclude: ['/*'] }).run(),
      /rejected by your include\/exclude patterns/
    );
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- entry redirects -------------------------------------------------------

test('a cross-host redirect at the entry re-anchors the crawl', async () => {
  // Regression guard, found by crawling nike.com — which geo-redirects to
  // nike.in. Scope is judged against the start URL, but the start URL is what
  // the user *typed*; every link on the landed page belongs to the new host,
  // was judged against the old one, and was rejected. The crawl saved a
  // single page and silently followed nothing, with no error to explain it.
  // The far more common case is an apex that redirects to www.
  const landing = await serve({
    '/': '<html><a href="/one">1</a><a href="/two">2</a></html>',
    '/one': '<html>one</html>',
    '/two': '<html>two</html>',
  });

  // A separate origin that only redirects onward.
  const entry = http.createServer((req, res) => {
    res.writeHead(302, { location: `${landing.origin}${req.url}` });
    res.end();
  });
  await new Promise((r) => entry.listen(0, '127.0.0.1', r));
  const entryOrigin = `http://127.0.0.1:${entry.address().port}`;
  const out = await tmp();

  try {
    const result = await new Crawler(entryOrigin, out, { respectRobots: false }).run();
    assert.ok(
      result.stats.pages >= 3,
      `links on the redirected-to host must still be followed, got ${result.stats.pages} page(s)`
    );
  } finally {
    await new Promise((r) => entry.close(r));
    await landing.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('a redirect deeper in the crawl does not move the scope', async () => {
  // Only the seed re-anchors. Otherwise one redirecting page could drag the
  // entire crawl onto an unrelated host.
  //
  // The two servers must differ by HOSTNAME, not merely by port: scope
  // compares hostnames, so 127.0.0.1:1 and 127.0.0.1:2 count as one site.
  // "localhost" and "127.0.0.1" resolve to the same machine but are distinct
  // hostname strings, which is exactly the distinction under test.
  const offsite = await serve({
    '/elsewhere': '<html><a href="/deep">deep</a></html>',
    '/deep': '<html>should never be reached</html>',
  });
  const offsiteHost = `http://localhost:${new URL(offsite.origin).port}`;

  const main = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><a href="/hop">hop</a></html>');
      return;
    }
    if (req.url === '/hop') {
      res.writeHead(302, { location: `${offsiteHost}/elsewhere` });
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => main.listen(0, '127.0.0.1', r));
  const out = await tmp();

  try {
    const result = await new Crawler(`http://127.0.0.1:${main.address().port}/`, out, {
      respectRobots: false,
    }).run();

    // The redirect target itself is fetched — that is just following a
    // redirect. What must NOT happen is crawling onward from it.
    const files = await listFiles(out);
    assert.ok(!files.includes('deep'), `scope escaped via a mid-crawl redirect: ${files}`);
    assert.ok(result.stats.pages <= 2, `expected the crawl to stop at the redirect target`);
  } finally {
    await new Promise((r) => main.close(r));
    await offsite.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- real-world response handling ------------------------------------------

test('a non-UTF-8 page is decoded correctly and re-tagged', async () => {
  const latin1 = Buffer.from(
    '<html><head><meta charset="ISO-8859-1"><title>t</title></head><body>naïve résumé © 2026</body></html>',
    'latin1'
  );
  const srv = await serve({
    '/': '<html><a href="/l1">a</a></html>',
    '/l1': { type: 'text/html; charset=ISO-8859-1', body: latin1 },
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, { respectRobots: false }).run();
    const dir = path.dirname(path.join(out, result.entryFile));
    const html = await fsp.readFile(path.join(dir, 'l1.html'), 'utf8');

    assert.match(html, /naïve résumé © 2026/, 'accented characters must survive');
    assert.ok(!html.includes('�'), 'no replacement characters');
    assert.match(html, /charset="utf-8"/i, 'saved copy must declare the encoding it is in');
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('links are followed on a page served with no Content-Type', async () => {
  // Trusting the header alone leaves the page unparsed, so the crawl silently
  // dead-ends instead of continuing through it.
  const srv = await serve({
    '/': '<html><a href="/untyped">a</a></html>',
    '/untyped': { type: '', body: '<html><a href="/deep">deeper</a></html>' },
    '/deep': '<html>reached</html>',
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, { respectRobots: false }).run();
    const files = await listFiles(out);
    assert.ok(files.includes('deep'), `crawl should have continued through: ${files}`);
    assert.ok(result.stats.pages >= 3);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('HTML mislabelled as a binary download is still parsed', async () => {
  const srv = await serve({
    '/': '<html><a href="/wrong">a</a></html>',
    '/wrong': {
      type: 'application/octet-stream',
      body: '<html><a href="/found">link inside mislabelled page</a></html>',
    },
    '/found': '<html>found</html>',
  });
  const out = await tmp();

  try {
    await new Crawler(srv.origin, out, { respectRobots: false }).run();
    const files = await listFiles(out);
    assert.ok(files.includes('found'), `link inside mislabelled HTML was missed: ${files}`);
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('a binary asset is never mangled by text handling', async () => {
  // A PNG whose bytes happen to contain "<html>" must not be sniffed as text
  // and rewritten as UTF-8 — that would corrupt the file.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('<html>not really html</html>'),
    Buffer.from([0x00, 0xff, 0xfe, 0x01]),
  ]);
  const srv = await serve({
    '/': '<html><img src="/x.png"></html>',
    '/x.png': { type: 'application/octet-stream', body: png },
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, { respectRobots: false }).run();
    const dir = path.dirname(path.join(out, result.entryFile));
    const saved = await fsp.readFile(path.join(dir, 'x.png'));
    assert.deepEqual(saved, png, 'binary bytes must round-trip exactly');
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('a bot-protection challenge is reported as such, not as a bare 403', async () => {
  const srv = await serve({
    '/': {
      status: 403,
      type: 'text/html',
      body: '<html><body>Checking your browser before accessing. Just a moment...</body></html>',
    },
  });
  const out = await tmp();

  try {
    await assert.rejects(
      () => new Crawler(srv.origin, out, { respectRobots: false }).run(),
      /bot-protection challenge/,
      'the error should name the real cause, not just the status code'
    );
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- sitemap, end to end ---------------------------------------------------

test('--sitemap reaches pages that are linked from nowhere', async () => {
  // The whole point of a sitemap: /orphan has no inbound link, so a link
  // crawler at any depth can never find it.
  let origin = '';
  const srv = await serve({
    '/': '<html>home, links to nothing</html>',
    '/sitemap.xml': () => ({
      type: 'application/xml',
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>${origin}/orphan</loc></url>
        <url><loc>${origin}/also-orphan</loc></url>
      </urlset>`,
    }),
    '/orphan': '<html>orphan page</html>',
    '/also-orphan': '<html>second orphan</html>',
  });
  origin = srv.origin;
  const out = await tmp();

  try {
    // Without the sitemap, only the homepage is reachable.
    const plain = await new Crawler(srv.origin, out, { respectRobots: false }).run();
    assert.equal(plain.stats.pages, 1, 'link crawl should only find the homepage');

    const out2 = await tmp();
    const withMap = await new Crawler(srv.origin, out2, {
      respectRobots: false,
      useSitemap: true,
    }).run();

    assert.equal(withMap.stats.fromSitemap, 2, 'both orphans should be queued');
    assert.equal(withMap.stats.pages, 3, 'homepage + 2 orphans');
    await fsp.rm(out2, { recursive: true, force: true });
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('sitemap URLs still obey scope and filters', async () => {
  let origin = '';
  const srv = await serve({
    '/': '<html>home</html>',
    '/sitemap.xml': () => ({
      type: 'application/xml',
      body: `<?xml version="1.0"?><urlset>
        <url><loc>${origin}/docs/keep</loc></url>
        <url><loc>${origin}/blog/drop</loc></url>
        <url><loc>https://elsewhere.example/off-site</loc></url>
      </urlset>`,
    }),
    '/docs/keep': '<html>keep</html>',
    '/blog/drop': '<html>drop</html>',
  });
  origin = srv.origin;
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, {
      respectRobots: false,
      useSitemap: true,
      include: ['/docs/*', '/'],
    }).run();

    // Off-site is out of scope; /blog is filtered; only /docs/keep survives.
    assert.equal(result.stats.fromSitemap, 1, 'only the in-scope, included URL should queue');
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('a gzipped sitemap is decompressed', async () => {
  const zlib = require('node:zlib');
  const xml = `<?xml version="1.0"?><urlset><url><loc>https://ex.com/a</loc></url></urlset>`;
  const gz = zlib.gzipSync(Buffer.from(xml));

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/gzip');
    res.end(gz);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const { collect } = require('../lib/sitemap');
    const urls = await collect([`${origin}/sitemap.xml.gz`], { limit: 10 });
    assert.deepEqual(urls, ['https://ex.com/a']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a sitemap index is followed one level down', async () => {
  let origin = '';
  const srv = await serve({
    '/sitemap.xml': () => ({
      type: 'application/xml',
      body: `<?xml version="1.0"?><sitemapindex>
        <sitemap><loc>${origin}/s-a.xml</loc></sitemap>
        <sitemap><loc>${origin}/s-b.xml</loc></sitemap>
      </sitemapindex>`,
    }),
    '/s-a.xml': { type: 'application/xml', body: '<urlset><url><loc>https://ex.com/a</loc></url></urlset>' },
    '/s-b.xml': { type: 'application/xml', body: '<urlset><url><loc>https://ex.com/b</loc></url></urlset>' },
  });
  origin = srv.origin;

  try {
    const { collect } = require('../lib/sitemap');
    const urls = await collect([`${srv.origin}/sitemap.xml`], { limit: 10 });
    assert.deepEqual(urls.sort(), ['https://ex.com/a', 'https://ex.com/b']);
  } finally {
    await srv.close();
  }
});

test('a failed asset does not abort the crawl', async () => {
  const srv = await serve({
    '/': '<html><img src="/missing.png"><a href="/ok">ok</a></html>',
    '/ok': '<html>fine</html>',
  });
  const out = await tmp();

  try {
    const result = await new Crawler(srv.origin, out, { respectRobots: false }).run();
    assert.ok(result.stats.files >= 2, 'crawl should continue past a 404');
    assert.ok(result.stats.failed >= 1, 'the 404 should be recorded as a failure');
  } finally {
    await srv.close();
    await fsp.rm(out, { recursive: true, force: true });
  }
});
