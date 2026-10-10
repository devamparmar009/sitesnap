'use strict';

/**
 * The pieces behind the app: plain-language errors, the site check, the
 * library on disk, the engine installer's unpacking, and how the app's three
 * questions become crawler settings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const cheerio = require('cheerio');

const { explainFailure, explainNetwork, explainStatus, summarizeProblems } = require('../lib/friendly');
const { inspect, parseAddress, looksScriptBuilt, sniffImage } = require('../lib/inspect');
const { Library, openMeHtml, OPEN_ME } = require('../lib/library');
const { extractNpmTarball, verifyIntegrity } = require('../lib/engine');
const { domainMatches } = require('../lib/login');
const { pageTitle, Crawler } = require('../lib/crawler');
const { crawlSettings, patterns, category } = require('../bin/server');

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sitesnap-app-'));
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const found = routes[req.url.split('?')[0]];
    if (found === undefined) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    const route = typeof found === 'function' ? found(req) : found;
    const r = typeof route === 'string' ? { body: route } : route;
    if (r.status) res.statusCode = r.status;
    for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
    if (!r.headers || !r.headers['content-type']) res.setHeader('content-type', r.type || 'text/html');
    res.end(r.body || '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// ---- friendly ---------------------------------------------------------------

test('network codes become sentences a person can act on', () => {
  assert.equal(explainNetwork('ENOTFOUND', 'nope.example').kind, 'not-found');
  assert.match(explainNetwork('ENOTFOUND', 'nope.example').message, /nope\.example/);
  assert.equal(explainNetwork('ECONNREFUSED', 'x').kind, 'refused');
  assert.equal(explainNetwork('EAI_AGAIN', 'x').kind, 'offline');
  assert.equal(explainNetwork('CERT_HAS_EXPIRED', 'x').kind, 'certificate');
  assert.equal(explainNetwork(null, 'x', 'The operation was aborted due to inactivity TimeoutError').kind, 'timeout');
  assert.equal(explainNetwork('SOMETHING_ELSE', 'x'), null);
});

test('HTTP statuses map to plain explanations, with a login action for 401', () => {
  assert.equal(explainStatus(404, 'x').kind, 'missing');
  assert.equal(explainStatus(401, 'x').action, 'login');
  assert.equal(explainStatus(403, 'x').kind, 'refused-client');
  assert.equal(explainStatus(503, 'x').kind, 'server-error');
  assert.equal(explainStatus(200, 'x'), null);
});

test('a failed crawl is explained from what actually happened', () => {
  const url = 'https://site.example/';
  assert.equal(explainFailure({ url, message: 'Nothing was downloaded.', failures: [{ message: 'fetch failed', code: 'ENOTFOUND' }] }).kind, 'not-found');
  assert.equal(explainFailure({ url, message: 'Nothing was downloaded. First error: HTTP 404 Not Found' }).kind, 'missing');
  assert.equal(explainFailure({ url, message: 'robots.txt disallows /. Pass --ignore-robots' }).action, 'robots');
  assert.equal(explainFailure({ url, message: 'x', stats: { blocked: 2 } }).kind, 'blocked');
  assert.equal(explainFailure({ url, message: 'x', stats: { filtered: 3, files: 0 } }).action, 'settings');
  assert.equal(explainFailure({ url, message: 'JavaScript rendering needs Playwright' }).action, 'install');
  assert.equal(explainFailure({ url, message: 'something odd' }).kind, 'unknown');
  // The technical text is kept, just not shown first.
  assert.equal(explainFailure({ url, message: 'something odd' }).detail, 'something odd');
});

test('no message uses an em or en dash (house style for app copy)', () => {
  const samples = [
    ...['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'CERT_X'].map((c) => explainNetwork(c, 'h')),
    ...[401, 403, 404, 429, 500].map((s) => explainStatus(s, 'h')),
    explainFailure({ url: 'https://h/', message: 'Playwright' }),
    explainFailure({ url: 'https://h/', message: 'x', stats: { blocked: 1 } }),
    explainFailure({ url: 'https://h/', message: 'robots.txt disallows /' }),
  ];
  const notes = summarizeProblems(
    { robotsBlockedCode: 2, blocked: 1, partial: 1, filtered: 4 },
    [{ url: 'u', message: 'm' }]
  );
  for (const item of [...samples, ...notes]) {
    for (const text of [item.title, item.message, item.text].filter(Boolean)) {
      assert.doesNotMatch(text, /[–—]/, text);
    }
  }
});

test('problem summaries count, never list, and skip user cancellations', () => {
  const notes = summarizeProblems({ robotsBlockedCode: 0 }, [
    { url: 'a', message: 'HTTP 404' },
    { url: 'b', message: 'cancelled' },
  ]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^1 file couldn/);
});

// ---- inspect ------------------------------------------------------------------

test('addresses are accepted the way people type them', () => {
  assert.equal(parseAddress('example.com').href, 'https://example.com/');
  assert.equal(parseAddress('  https://Example.com/docs ').href, 'https://example.com/docs');
  assert.equal(parseAddress('http://localhost:3000').href, 'http://localhost:3000/');
  assert.equal(parseAddress('hello'), null, 'a bare word is a typo, not a host');
  assert.equal(parseAddress('two words.com'), null);
  assert.equal(parseAddress('ftp://example.com'), null);
  assert.equal(parseAddress(''), null);
});

test('a script-built shell is told apart from a short static page', () => {
  const shell = cheerio.load('<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
  const short = cheerio.load(
    '<html><body><h1>Example Domain</h1><p>This domain is for use in documentation examples without needing permission.</p><script src="/s.js"></script></body></html>'
  );
  const noscript = cheerio.load('<html><body><noscript>You need to enable JavaScript to run this app.</noscript></body></html>');
  assert.equal(looksScriptBuilt(shell), true);
  assert.equal(looksScriptBuilt(short), false);
  assert.equal(looksScriptBuilt(noscript), true);
});

test('image sniffing recognises real images and nothing else', () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
  assert.equal(sniffImage(Buffer.from('<html>not an image</html>')), null);
});

test('inspect reports title, icon, preview image, size and warnings', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const site = await serve({
    '/': `<html><head><title>Home | Tiny Co</title>
      <meta property="og:site_name" content="Tiny Co">
      <meta name="description" content="A tiny site.">
      <meta property="og:image" content="/cover.png">
      <link rel="icon" href="/icon.png" sizes="32x32"></head>
      <body><a href="/a">A</a><a href="/b">B</a><a href="/a">A again</a><a href="https://elsewhere.example/">x</a>
      <p>Enough real text on this page that it is clearly not an empty application shell waiting for code.</p></body></html>`,
    '/icon.png': { body: png, type: 'image/png' },
    '/cover.png': { body: png, type: 'image/png' },
    '/robots.txt': { body: 'User-agent: *\nDisallow: /private\nSitemap: /sitemap.xml', type: 'text/plain' },
    // A sitemap holds absolute URLs, built from the address the request used.
    '/sitemap.xml': (req) => ({
      body: `<urlset>${['a', 'b', 'c'].map((p) => `<url><loc>http://${req.headers.host}/${p}</loc></url>`).join('')}</urlset>`,
      type: 'application/xml',
    }),
  });
  const res = await inspect(site.origin, {});
  await site.close();

  assert.equal(res.ok, true);
  assert.equal(res.title, 'Home | Tiny Co');
  assert.equal(res.siteName, 'Tiny Co');
  assert.equal(res.description, 'A tiny site.');
  assert.match(res.icon, /^data:image\/png;base64,/);
  assert.match(res.image, /^data:image\/png;base64,/);
  assert.equal(res.needsJs, false);
  assert.equal(res.login, false);
  assert.equal(res.links, 2, 'unique in-scope links only');
  assert.equal(res.robotsBlocksStart, false);
  assert.deepEqual(res.sitemap, { found: true, count: 3, capped: false });
});

test('inspect explains a missing page and flags a login redirect', async () => {
  const site = await serve({
    '/gone': { status: 404, body: 'no' },
    '/account': { status: 302, headers: { location: '/login?next=/account', 'content-type': 'text/html' } },
    '/login': '<html><head><title>Sign in</title></head><body><form><input type="password"></form></body></html>',
  });
  const missing = await inspect(`${site.origin}/gone`);
  const login = await inspect(`${site.origin}/account`);
  await site.close();

  assert.equal(missing.ok, false);
  assert.equal(missing.error.kind, 'missing');
  assert.equal(login.ok, true);
  assert.equal(login.login, true);
});

test('inspect turns an unknown host into a spelling hint', async () => {
  const res = await inspect('this-host-does-not-exist.invalid');
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, 'not-found');
});

// ---- crawler additions --------------------------------------------------------

test('page titles are decoded and trimmed for progress messages', () => {
  assert.equal(pageTitle('<title>  Tom &amp; Jerry &#8211; Home </title>'), 'Tom & Jerry – Home');
  assert.equal(pageTitle('<html><body>no title</body></html>'), null);
  assert.equal(pageTitle('<title></title>'), null);
});

test('resource events say which page linked here, and its title', async () => {
  const site = await serve({
    '/': '<html><head><title>Root</title></head><body><a href="/a">a</a></body></html>',
    '/a': '<html><head><title>Page A</title></head><body><a href="/a/b">b</a><img src="/pic.png"></body></html>',
    '/a/b': '<html><head><title>Page B</title></head><body>leaf</body></html>',
    '/pic.png': { body: 'png', type: 'image/png' },
  });
  const out = await tmp();
  const events = [];
  const crawler = new Crawler(`${site.origin}/`, out, { respectRobots: false });
  crawler.on('resource', (r) => events.push(r));
  await crawler.run();
  await site.close();

  const byUrl = Object.fromEntries(events.map((e) => [new URL(e.url).pathname, e]));
  assert.equal(byUrl['/'].parent, null);
  assert.equal(byUrl['/'].title, 'Root');
  assert.equal(byUrl['/a'].parent, `${site.origin}/`);
  assert.equal(byUrl['/a/b'].parent, `${site.origin}/a`);
  assert.equal(byUrl['/a/b'].title, 'Page B');
  assert.equal(byUrl['/pic.png'].parent, `${site.origin}/a`, 'an asset reports the page that needed it');
  assert.equal(byUrl['/pic.png'].title, null);

  const p = crawler.progress();
  assert.equal(p.waiting, 0);
  assert.equal(p.active, 0);
  assert.ok(p.filesQueued >= 4);
});

// ---- library --------------------------------------------------------------------

test('the library keeps snapshots in readable folders and finds them again', async () => {
  const root = await tmp();
  const lib = await new Library(root).init();
  const rec = await lib.create({ url: 'https://example.com/', host: 'example.com', title: 'Example' });

  assert.match(rec.folder, /^example\.com \d{4}-\d{2}-\d{2} \d{2}-\d{2}$/);
  assert.equal(lib.get(rec.id).title, 'Example');
  assert.equal(lib.get('../../etc'), null, 'ids are validated, never used as paths');
  assert.equal(lib.dirOf('not-an-id'), null);

  const second = await lib.create({ url: 'https://example.com/', host: 'example.com' });
  assert.notEqual(second.folder, rec.folder, 'two saves in the same minute get distinct folders');

  await lib.update(rec.id, { status: 'done', stats: { files: 3, pages: 1, bytes: 10 }, entry: 'example.com/index.html' });
  await lib.writeOpenMe(rec.id, 'example.com/index.html', 'Example');
  const openMe = await fsp.readFile(path.join(lib.dirOf(rec.id), OPEN_ME), 'utf8');
  assert.match(openMe, /url=site\/example\.com\/index\.html/);

  const again = await new Library(root).init();
  assert.equal(again.list().length, 2);
  assert.equal(again.get(rec.id).status, 'done');
});

test('an interrupted snapshot is recovered as partly saved, not left running', async () => {
  const root = await tmp();
  const lib = await new Library(root).init();
  const withFiles = await lib.create({ host: 'a.example' });
  await lib.update(withFiles.id, { stats: { files: 5 } });
  const empty = await lib.create({ host: 'b.example' });

  const reopened = await new Library(root).init();
  assert.equal(reopened.get(withFiles.id).status, 'stopped');
  assert.equal(reopened.get(empty.id).status, 'failed');
});

test('library images accept only real image data URLs', async () => {
  const lib = await new Library(await tmp()).init();
  const rec = await lib.create({ host: 'example.com' });
  assert.equal(await lib.saveImage(rec.id, 'icon', 'data:image/png;base64,iVBORw0KGgo='), 'icon.png');
  assert.equal(await lib.saveImage(rec.id, 'cover', 'data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(await lib.saveImage(rec.id, 'other', 'data:image/png;base64,AAAA'), null);
  assert.ok(lib.imagePath(rec.id, 'icon').endsWith(path.join('.sitesnap', 'icon.png')));
  assert.equal(lib.imagePath(rec.id, 'cover'), null);
});

test('removing a snapshot deletes only its own folder', async () => {
  const root = await tmp();
  const lib = await new Library(root).init();
  const keep = await lib.create({ host: 'keep.example' });
  const drop = await lib.create({ host: 'drop.example' });
  assert.equal(await lib.remove(drop.id), true);
  const left = await fsp.readdir(root);
  assert.deepEqual(left, [keep.folder]);
});

test('the open-me page escapes what it is given', () => {
  const html = openMeHtml('site/a"b/index.html', '<script>x</script>');
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /a%22b/);
});

// ---- engine installer -------------------------------------------------------------

function tarEntry(name, content = '', type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content);
  return Buffer.concat([header, body]);
}

function tgz(...entries) {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test('an npm tarball unpacks without its package/ prefix', async () => {
  const dest = await tmp();
  await extractNpmTarball(tgz(tarEntry('package/index.js', 'module.exports = 1;'), tarEntry('package/lib/a.js', 'x')), dest);
  assert.equal(await fsp.readFile(path.join(dest, 'index.js'), 'utf8'), 'module.exports = 1;');
  assert.equal(await fsp.readFile(path.join(dest, 'lib', 'a.js'), 'utf8'), 'x');
});

test('a tarball entry that climbs out of its folder is refused', async () => {
  const parent = await tmp();
  const dest = path.join(parent, 'engine');
  await assert.rejects(
    extractNpmTarball(tgz(tarEntry('package/../../escaped.js', 'pwned')), dest),
    /unsafe path/
  );
  await assert.rejects(fsp.access(path.join(parent, 'escaped.js')));
});

test('a download that does not match its published checksum is rejected', () => {
  const data = Buffer.from('the real package');
  const good = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
  assert.doesNotThrow(() => verifyIntegrity(data, good));
  assert.throws(() => verifyIntegrity(Buffer.from('tampered'), good), /did not match/);
  assert.throws(() => verifyIntegrity(data, 'sha1-abc'), /did not publish/);
});

test('a borrowed sign-in only covers the site it came from', () => {
  assert.equal(domainMatches('www.example.com', '.example.com'), true);
  assert.equal(domainMatches('example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', '.other.com'), false);
  assert.equal(domainMatches('notexample.com', 'example.com'), false);
});

// ---- settings ------------------------------------------------------------------------

test('the three questions become crawler settings', () => {
  const cfg = { blockPrivate: false };
  const page = crawlSettings({ scope: 'page', size: 'everything' }, null, cfg);
  assert.equal(page.options.maxDepth, 0);
  assert.equal(page.options.maxPages, 1);

  const section = crawlSettings({ scope: 'section', size: 'quick' }, null, cfg);
  assert.equal(section.options.noParent, true);
  assert.equal(section.options.maxPages, 25);

  const site = crawlSettings({ scope: 'site', size: 'normal' }, { sitemap: { found: true } }, cfg);
  assert.equal(site.options.noParent, false);
  assert.equal(site.options.useSitemap, true, 'a whole-site save uses the sitemap when there is one');

  const fallback = crawlSettings({ scope: 'nonsense', size: 'huge' }, null, cfg);
  assert.equal(fallback.scope, 'section');
  assert.equal(fallback.size, 'normal');
});

test('advanced options are validated and clamped', () => {
  const s = crawlSettings(
    {
      scope: 'site',
      size: 'quick',
      advanced: { maxPages: '999999', maxMb: '-5', ignoreRobots: true, gentle: true, modern: 'yes', sitemap: 'never' },
    },
    null,
    { blockPrivate: true }
  );
  assert.equal(s.options.maxPages, 5000);
  assert.equal(s.options.maxBytes, 10 * 1024 * 1024);
  assert.equal(s.options.respectRobots, false);
  assert.equal(s.options.delay, 600);
  assert.equal(s.options.render, false, 'only a real boolean switches rendering on');
  assert.equal(s.advanced.sitemap, 'auto', 'unknown values fall back');
  assert.equal(s.options.blockPrivate, true);
});

test('plain words become "contains" patterns; globs pass through', () => {
  assert.deepEqual(patterns('blog, /docs/'), ['*blog*', '*/docs/*']);
  assert.deepEqual(patterns('/tag/*, re:^/x'), ['/tag/*', 're:^/x']);
  assert.deepEqual(patterns(''), []);
  assert.equal(patterns(Array(40).fill('a').join(',')).length, 25);
});

test('files are grouped the way the app names them', () => {
  assert.equal(category('css', 'https://x/a.css'), 'style');
  assert.equal(category('other', 'https://x/photo.JPG'), 'image');
  assert.equal(category('other', 'https://x/f.woff2'), 'font');
  assert.equal(category('other', 'https://x/clip.mp4'), 'media');
  assert.equal(category('other', 'https://x/guide.pdf'), 'document');
  assert.equal(category('other', 'https://x/blob'), 'other');
});
