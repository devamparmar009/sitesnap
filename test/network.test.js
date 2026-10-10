'use strict';

/**
 * Retry, throttling, credential scoping and resume.
 *
 * All against real local servers — these behaviours only exist in the
 * interaction between the fetcher, the crawler and an actual HTTP peer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { Crawler } = require('../lib/crawler');
const { Fetcher, retryAfterMs } = require('../lib/fetcher');
const { registrableDomain, sameSite } = require('../lib/publicsuffix');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sitesnap-net-'));
const listen = (srv) =>
  new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const close = (srv) => new Promise((r) => srv.close(r));

// --- retry -----------------------------------------------------------------

test('a transient 503 is retried', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits < 3) {
      res.statusCode = 503;
      res.end('later');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<html>ok</html>');
  });
  const origin = await listen(srv);

  try {
    const res = await new Fetcher({ retries: 3, timeout: 5000 }).fetch(new URL(origin));
    assert.equal(res.status, 200);
    assert.equal(hits, 3, 'should have taken three attempts');
  } finally {
    await close(srv);
  }
});

test('a 404 is not retried — it is not transient', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.statusCode = 404;
    res.end('nope');
  });
  const origin = await listen(srv);

  try {
    const res = await new Fetcher({ retries: 3, timeout: 5000 }).fetch(new URL(origin));
    assert.equal(res.status, 404);
    assert.equal(hits, 1, 'a 404 should be accepted first time');
  } finally {
    await close(srv);
  }
});

test('retries are bounded and the last response is returned', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.statusCode = 500;
    res.end('boom');
  });
  const origin = await listen(srv);

  try {
    const res = await new Fetcher({ retries: 2, timeout: 5000 }).fetch(new URL(origin));
    assert.equal(res.status, 500);
    assert.equal(hits, 3, 'one initial attempt plus two retries');
  } finally {
    await close(srv);
  }
});

test('Retry-After is honoured', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits === 1) {
      res.statusCode = 429;
      res.setHeader('retry-after', '1');
      res.end('slow down');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<html>ok</html>');
  });
  const origin = await listen(srv);

  try {
    const started = Date.now();
    await new Fetcher({ retries: 2, timeout: 5000 }).fetch(new URL(origin));
    assert.ok(Date.now() - started >= 950, 'should have waited the advertised second');
  } finally {
    await close(srv);
  }
});

test('retryAfterMs parses both seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('5'), 5000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('garbage'), null);

  const future = new Date(Date.now() + 3000).toUTCString();
  const parsed = retryAfterMs(future);
  assert.ok(parsed > 1000 && parsed <= 4000, `unexpected delta: ${parsed}`);
});

// --- credential scoping ----------------------------------------------------

test('auth headers reach the start origin but never a third party', async () => {
  // The failure this guards against is handing your session cookie to every
  // CDN a page happens to reference.
  const seen = { origin: null, thirdParty: null, thirdPartyCalled: false };

  const third = http.createServer((req, res) => {
    seen.thirdPartyCalled = true;
    seen.thirdParty = req.headers.cookie || null;
    res.setHeader('content-type', 'text/css');
    res.end('body{}');
  });
  const thirdOrigin = await listen(third);

  const main = http.createServer((req, res) => {
    if (req.url !== '/') {
      res.statusCode = 404;
      res.end();
      return;
    }
    seen.origin = req.headers.cookie || null;
    res.setHeader('content-type', 'text/html');
    res.end(`<html><link rel="stylesheet" href="${thirdOrigin}/x.css"></html>`);
  });
  const mainOrigin = await listen(main);
  const out = await tmp();

  try {
    await new Crawler(mainOrigin, out, {
      respectRobots: false,
      headers: { cookie: 'session=SECRET' },
    }).run();

    assert.equal(seen.origin, 'session=SECRET', 'origin should receive the cookie');
    assert.ok(seen.thirdPartyCalled, 'the third-party asset should still be fetched');
    assert.equal(seen.thirdParty, null, 'the cookie must not leak off-origin');
  } finally {
    await close(main);
    await close(third);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- throttling ------------------------------------------------------------

test('--delay is shared across workers, not applied per worker', async () => {
  // Per-worker sleeping would multiply the real request rate by concurrency,
  // which defeats the point of asking to be polite.
  const stamps = [];
  const srv = http.createServer((req, res) => {
    stamps.push(Date.now());
    res.setHeader('content-type', 'text/html');
    res.end(
      req.url === '/'
        ? '<html><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></html>'
        : '<html>leaf</html>'
    );
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    await new Crawler(origin, out, {
      respectRobots: false,
      concurrency: 4,
      delay: 120,
    }).run();

    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    assert.ok(stamps.length >= 3, 'expected several requests');
    assert.ok(Math.min(...gaps) >= 100, `requests bunched: gaps ${gaps.join(',')}`);
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- resume ----------------------------------------------------------------

test('a second run reuses unchanged files via 304', async () => {
  let bodiesSent = 0;
  const ETAG = '"v1"';

  const srv = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === ETAG) {
      res.statusCode = 304;
      res.end();
      return;
    }
    bodiesSent++;
    res.setHeader('etag', ETAG);
    res.setHeader('content-type', 'text/html');
    res.end('<html><a href="/b">b</a></html>');
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const first = await new Crawler(origin, out, { respectRobots: false, resume: true }).run();
    const afterFirst = bodiesSent;

    const second = await new Crawler(origin, out, { respectRobots: false, resume: true }).run();

    assert.ok(second.stats.reused > 0, 'second run should reuse files');
    assert.equal(bodiesSent, afterFirst, 'no bodies should be re-sent');
    assert.equal(
      second.stats.pages,
      first.stats.pages,
      'a resumed run must still discover the same pages'
    );
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('resume refetches when the cached file has been deleted', async () => {
  const ETAG = '"v1"';
  let bodiesSent = 0;

  const srv = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === ETAG) {
      res.statusCode = 304;
      res.end();
      return;
    }
    bodiesSent++;
    res.setHeader('etag', ETAG);
    res.setHeader('content-type', 'text/html');
    res.end('<html>page</html>');
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const first = await new Crawler(origin, out, { respectRobots: false, resume: true }).run();

    // Simulate the archive being partially cleaned up between runs.
    await fsp.rm(path.join(out, first.entryFile), { force: true });

    const second = await new Crawler(origin, out, { respectRobots: false, resume: true }).run();
    assert.ok(bodiesSent >= 2, 'the missing file must be fetched again, not assumed present');
    assert.equal(second.stats.files, first.stats.files);
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('resume state survives repeated runs', async () => {
  // Regression guard. #reuse used to build a fresh entry without carrying the
  // recorded links, so run 2 worked (it still had run 1's links) but saved
  // link-less entries — and run 3 silently collapsed to a single page.
  const ETAG = '"v1"';
  const srv = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === ETAG) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('etag', ETAG);
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' ? '<html><a href="/b">b</a></html>' : '<html>leaf</html>');
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const first = await new Crawler(origin, out, { respectRobots: false, resume: true }).run();
    await new Crawler(origin, out, { respectRobots: false, resume: true }).run();
    const third = await new Crawler(origin, out, { respectRobots: false, resume: true }).run();

    assert.equal(
      third.stats.pages,
      first.stats.pages,
      'the third run must still find every page the first did'
    );

    const state = JSON.parse(
      await fsp.readFile(path.join(out, '.sitesnap-state.json'), 'utf8')
    );
    const withLinks = Object.values(state.entries).filter((e) => e.links).length;
    assert.ok(withLinks > 0, 'state must retain recorded links across runs');
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('undownloaded link rels are made absolute, not left root-relative', async () => {
  // A <link rel="search" href="/opensearch.xml"> we never fetch must not stay
  // root-relative: opened from disk that resolves to the filesystem root.
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<html><link rel="search" href="/opensearch.xml"><link rel="canonical" href="/canon">hi</html>'
    );
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const result = await new Crawler(origin, out, { respectRobots: false }).run();
    const html = await fsp.readFile(path.join(out, result.entryFile), 'utf8');

    assert.ok(
      html.includes(`${origin}/opensearch.xml`),
      `rel=search should be absolute: ${html}`
    );
    assert.ok(!/href="\/opensearch/.test(html), `root-relative href survived: ${html}`);
    assert.equal(result.stats.files, 1, 'these rels must not be downloaded');
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('the resume state file never lands in the archive', async () => {
  // The state file records every URL crawled, its validators and its link
  // graph. Shipping that inside a shared zip leaks the user's crawl history.
  const { pack } = require('../lib/pack');

  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html>page</html>');
  });
  const origin = await listen(srv);
  const out = await tmp();
  const zipPath = path.join(out, '..', `state-test-${Date.now()}.zip`);

  try {
    await new Crawler(origin, out, { respectRobots: false, resume: true }).run();

    // It must exist on disk — resume depends on it.
    await fsp.access(path.join(out, '.sitesnap-state.json'));

    await pack(out, zipPath);
    const zip = await fsp.readFile(zipPath);

    // Filenames are stored uncompressed in the zip's central directory.
    assert.ok(
      !zip.includes(Buffer.from('.sitesnap-state.json')),
      'the state file must not be inside the archive'
    );
    assert.ok(zip.includes(Buffer.from('index.html')), 'the mirror itself should be present');
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
    await fsp.rm(zipPath, { force: true });
  }
});

// --- stall detection ---------------------------------------------------

test('a large but steadily-progressing download is not killed by total elapsed time', async () => {
  // Regression guard. --timeout used to be a fixed AbortSignal.timeout() —
  // a hard deadline on the WHOLE transfer, not an idle timeout. A perfectly
  // healthy file that simply took longer than `timeout` in total (a large
  // asset on a slow connection) was killed the same as a genuinely dead one.
  const srv = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><img src="/slow.bin"></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let n = 0;
    const iv = setInterval(() => {
      res.write(Buffer.alloc(50_000, 1));
      if (++n >= 8) {
        clearInterval(iv);
        res.end();
      }
    }, 400); // 8 chunks * 400ms ≈ 3.2s total — longer than the 2s timeout below
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const result = await new Crawler(origin, out, { respectRobots: false, timeout: 2000 }).run();
    assert.equal(result.stats.failed, 0, 'a steadily-progressing transfer must not be killed');
    assert.equal(result.stats.files, 2);
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('a network read that goes truly quiet is still caught', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><img src="/dead.bin"></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.flushHeaders();
    res.write(Buffer.alloc(1024)); // one real chunk, then nothing ever again
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const started = Date.now();
    const result = await new Crawler(origin, out, { respectRobots: false, timeout: 1000 }).run();
    assert.equal(result.stats.failed, 1);
    assert.ok(Date.now() - started < 3000, 'should not wait much past the configured timeout');
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test('a stalled disk write is caught even when the network side is fine', async () => {
  // Regression guard. AbortSignal.timeout on the fetch only ever bounded the
  // network side. Once headers arrive and streaming into pipeline() begins,
  // nothing previously bounded a destination write that stops draining — a
  // locked file, a throttled disk, backup/AV software intercepting the
  // write. That worker then never returns to the queue, and enough stalled
  // files can quietly stop the whole crawl with no error ever printed.
  const realCreate = fs.createWriteStream;
  let restored = false;
  const restore = () => {
    if (!restored) {
      restored = true;
      fs.createWriteStream = realCreate;
    }
  };

  fs.createWriteStream = function (...args) {
    const ws = realCreate.apply(fs, args);
    const realWrite = ws._write.bind(ws);
    let calls = 0;
    // The correct way to simulate a genuinely stuck write: withhold the
    // internal callback, which is exactly what a hung write() syscall does
    // and creates real backpressure (unlike overriding the public .write()).
    ws._write = function (chunk, enc, cb) {
      calls++;
      if (calls > 1) return; // callback withheld — simulates a stuck disk
      return realWrite(chunk, enc, cb);
    };
    return ws;
  };

  const srv = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><img src="/big.bin"></html>');
      return;
    }
    // The network delivers everything instantly and in full — there is
    // nothing for a network-side timeout to ever act on here.
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(5 * 1024 * 1024, 7));
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const started = Date.now();
    const result = await new Crawler(origin, out, { respectRobots: false, timeout: 1000 }).run();
    assert.equal(result.stats.failed, 1, 'the stalled write should be recorded as a failure');
    assert.ok(
      result.failures.some((f) => /stalled — no write progress/.test(f.message)),
      `expected a stall message, got: ${JSON.stringify(result.failures)}`
    );
    assert.ok(Date.now() - started < 3000, 'should not hang past the configured timeout');
  } finally {
    restore();
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- public suffix ---------------------------------------------------------

test('registrable domain handles multi-part ccTLD suffixes', () => {
  assert.equal(registrableDomain('example.co.uk').domain, 'example.co.uk');
  assert.equal(registrableDomain('blog.example.co.uk').domain, 'example.co.uk');
  assert.equal(registrableDomain('example.com.au').domain, 'example.com.au');
  assert.equal(registrableDomain('www.example.com').domain, 'example.com');
});

test('unrelated co.uk sites are not treated as one site', () => {
  // The naive "last two labels" rule made these identical, which let a
  // --subdomains crawl wander onto somebody else's domain.
  assert.equal(sameSite('example.co.uk', 'other.co.uk'), false);
  assert.equal(sameSite('a.example.co.uk', 'b.example.co.uk'), true);
});

test('hosting platforms are treated as public suffixes', () => {
  assert.equal(sameSite('alice.github.io', 'bob.github.io'), false);
  assert.equal(sameSite('docs.alice.github.io', 'alice.github.io'), true);
  assert.equal(registrableDomain('myapp.vercel.app').domain, 'myapp.vercel.app');
});

test('ordinary domains still resolve normally', () => {
  assert.equal(sameSite('blog.example.com', 'example.com'), true);
  assert.equal(sameSite('example.com', 'example.org'), false);
  assert.equal(registrableDomain('localhost').domain, 'localhost');
});
