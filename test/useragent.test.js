'use strict';

/**
 * Client identity: what we say we are, and what happens when a host says no.
 *
 * These exist because of a real failure. sitesnap used to identify itself as
 * `Mozilla/5.0 (compatible; sitesnap/1.0; +offline archiving; respects
 * robots.txt)`, and mapleleaflegalservices.ca answers 403 to any User-Agent
 * containing the token `compatible` — while serving `spider`, `crawler` and
 * `bot` without complaint. The rule is not aimed at crawlers; it matches the
 * *shape* of the conventional polite UA. So the most honest string on offer
 * was the one that failed, 403 was not retryable, and the crawl ended on the
 * seed with an empty output directory and no explanation worth acting on.
 *
 * The server below reproduces exactly that rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { Crawler, DEFAULTS } = require('../lib/crawler');
const { Fetcher, UA_LADDER, DEFAULT_UA, describeUa, BLOCK_STATUS } = require('../lib/fetcher');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sitesnap-ua-'));
const listen = (srv) =>
  new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const close = (srv) => new Promise((r) => srv.close(r));

/** A host that refuses the classic polite-crawler UA, as the real one does. */
function pickyServer(onHit) {
  return http.createServer((req, res) => {
    const ua = req.headers['user-agent'] || '';
    if (onHit) onHit(ua, req);
    if (/compatible/i.test(ua)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<html><body><h1>served</h1></body></html>');
  });
}

// --- the default identity --------------------------------------------------

test('the default User-Agent is not the shape that gets blocked', () => {
  assert.doesNotMatch(
    DEFAULTS.userAgent,
    /compatible/i,
    'the `(compatible; ...)` form is what crude WAF rules match on'
  );
  assert.equal(DEFAULTS.userAgent, DEFAULT_UA);
  assert.match(DEFAULTS.userAgent, /Mozilla\/5\.0/);
});

test('a default-configured crawl is served by a host that refuses polite crawlers', async () => {
  const seen = [];
  const srv = pickyServer((ua) => seen.push(ua));
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const crawler = new Crawler(origin, out, { respectRobots: false, maxPages: 1 });
    const result = await crawler.run();
    assert.equal(result.stats.failed, 0);
    assert.equal(result.stats.pages, 1, 'the seed must actually be captured');
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every((ua) => !/compatible/i.test(ua)),
      'no request should have gone out under the blocked identity'
    );
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- the escalation ladder -------------------------------------------------

test('a 403 on identity escalates to the next browser rather than failing', async () => {
  const seen = [];
  const srv = pickyServer((ua) => seen.push(ua));
  const origin = await listen(srv);

  try {
    const notes = [];
    const f = new Fetcher({
      // Start deliberately on the rung this host refuses.
      userAgent: 'Mozilla/5.0 (compatible; sitesnap/1.0; +offline archiving)',
      retries: 0,
      timeout: 5000,
      onNote: (m) => notes.push(m),
    });

    const res = await f.fetch(new URL(origin));
    assert.equal(res.status, 200, 'the ladder should have recovered the request');
    assert.equal(seen.length, 2, 'exactly one rejected attempt, then one that works');
    assert.match(seen[0], /compatible/i);
    assert.doesNotMatch(seen[1], /compatible/i);
    assert.match(notes.join('\n'), /refuses this client/);
  } finally {
    await close(srv);
  }
});

test('escalation does not spend the retry budget', async () => {
  // A host that refuses on identity AND is flaky. If climbing the ladder were
  // charged to --retries, the flakiness would have no attempts left to absorb.
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    const ua = req.headers['user-agent'] || '';
    if (/compatible/i.test(ua)) {
      res.statusCode = 403;
      res.end('no');
      return;
    }
    if (hits < 4) {
      res.statusCode = 503;
      res.end('later');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<html>ok</html>');
  });
  const origin = await listen(srv);

  try {
    const f = new Fetcher({
      userAgent: 'Mozilla/5.0 (compatible; sitesnap/1.0)',
      retries: 3,
      timeout: 5000,
    });
    const res = await f.fetch(new URL(origin));
    assert.equal(res.status, 200);
  } finally {
    await close(srv);
  }
});

test('the chosen identity is remembered per host, so the 403 is paid once', async () => {
  const seen = [];
  const srv = pickyServer((ua) => seen.push(ua));
  const origin = await listen(srv);

  try {
    const f = new Fetcher({
      userAgent: 'Mozilla/5.0 (compatible; sitesnap/1.0)',
      retries: 0,
      timeout: 5000,
    });
    await f.fetch(new URL(origin));
    await f.fetch(new URL(`${origin}/two`));
    await f.fetch(new URL(`${origin}/three`));

    const refused = seen.filter((ua) => /compatible/i.test(ua));
    assert.equal(refused.length, 1, 'the blocked identity must not be offered again');
    assert.equal(seen.length, 4, 'one rejected probe plus three served requests');
  } finally {
    await close(srv);
  }
});

test('a host that refuses every identity fails rather than looping', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.statusCode = 403;
    res.end('never');
  });
  const origin = await listen(srv);

  try {
    const f = new Fetcher({ retries: 0, timeout: 5000 });
    const res = await f.fetch(new URL(origin));
    assert.equal(res.status, 403, 'it must give up and report the block');
    assert.ok(hits <= UA_LADDER.length + 1, `bounded by the ladder, got ${hits} attempts`);
  } finally {
    await close(srv);
  }
});

test('a 401 carrying WWW-Authenticate is left alone — no identity satisfies it', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.statusCode = 401;
    res.setHeader('www-authenticate', 'Basic realm="private"');
    res.end('auth required');
  });
  const origin = await listen(srv);

  try {
    const res = await new Fetcher({ retries: 0, timeout: 5000 }).fetch(new URL(origin));
    assert.equal(res.status, 401);
    assert.equal(hits, 1, 'a real auth challenge must not burn the ladder');
  } finally {
    await close(srv);
  }
});

test('a 404 still does not escalate — the request is wrong, not the client', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.statusCode = 404;
    res.end('nope');
  });
  const origin = await listen(srv);

  try {
    const res = await new Fetcher({ retries: 2, timeout: 5000 }).fetch(new URL(origin));
    assert.equal(res.status, 404);
    assert.equal(hits, 1);
  } finally {
    await close(srv);
  }
});

// --- explicit override -----------------------------------------------------

test('--user-agent is honoured as the first identity tried', async () => {
  const seen = [];
  const srv = pickyServer((ua) => seen.push(ua));
  const origin = await listen(srv);
  const out = await tmp();

  try {
    const crawler = new Crawler(origin, out, {
      respectRobots: false,
      maxPages: 1,
      userAgent: 'my-archiver/2.0',
    });
    await crawler.run();
    assert.equal(seen[0], 'my-archiver/2.0');
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

// --- the browser header set ------------------------------------------------

test('requests carry a type-appropriate Accept and a language', async () => {
  let headers = null;
  const srv = http.createServer((req, res) => {
    headers = req.headers;
    res.setHeader('content-type', 'text/html');
    res.end('<html>ok</html>');
  });
  const origin = await listen(srv);

  try {
    await new Fetcher({ retries: 0, timeout: 5000 }).fetch(new URL(origin));
    assert.match(headers.accept, /text\/html/);
    assert.ok(headers['accept-language']);
    assert.match(headers['user-agent'], /Mozilla\/5\.0/);
  } finally {
    await close(srv);
  }
});

/**
 * The regression this locks down is subtle and was live for one commit.
 *
 * `sec-fetch-mode` is a forbidden header name: undici forces it to `cors` and
 * throws away whatever we pass. `sec-fetch-dest` is not forced. Setting the
 * pair by hand therefore produced `dest: document` beside `mode: cors` — a
 * combination no browser emits, and a clearer automation tell than sending
 * neither. If someone reintroduces the trio, this fails.
 */
test('no self-contradicting sec-fetch metadata is sent', async () => {
  let headers = null;
  const srv = http.createServer((req, res) => {
    headers = req.headers;
    res.setHeader('content-type', 'text/html');
    res.end('<html>ok</html>');
  });
  const origin = await listen(srv);

  try {
    await new Fetcher({ retries: 0, timeout: 5000 }).fetch(new URL(origin));
    assert.equal(headers['sec-fetch-dest'], undefined);
    assert.equal(headers['sec-fetch-site'], undefined);
    assert.equal(headers['sec-fetch-user'], undefined);
    // Whatever undici forces is allowed to stand — it is at least coherent
    // with an unadorned script-issued fetch, which is what this is.
    if (headers['sec-fetch-mode'] !== undefined) {
      assert.equal(headers['sec-fetch-mode'], 'cors');
    }
  } finally {
    await close(srv);
  }
});

test('client hints track the User-Agent instead of contradicting it', async () => {
  const captured = [];
  const srv = http.createServer((req, res) => {
    captured.push({ ua: req.headers['user-agent'], hint: req.headers['sec-ch-ua'] });
    res.setHeader('content-type', 'text/html');
    res.end('<html>ok</html>');
  });
  const origin = await listen(srv);

  try {
    // Chrome sends client hints...
    await new Fetcher({ retries: 0, timeout: 5000, userAgent: UA_LADDER[0] }).fetch(new URL(origin));
    assert.ok(captured[0].hint, 'a Chrome UA with no sec-ch-ua is a contradiction');
    assert.match(captured[0].hint, /Google Chrome/);

    // ...and Firefox implements none at all, so claiming them would be a tell.
    await new Fetcher({ retries: 0, timeout: 5000, userAgent: UA_LADDER[1] }).fetch(new URL(origin));
    assert.equal(captured[1].hint, undefined);
  } finally {
    await close(srv);
  }
});

test('Accept follows the resource kind, as a browser varies it', async () => {
  const seen = {};
  const srv = http.createServer((req, res) => {
    seen[req.url] = req.headers.accept;
    res.end('x');
  });
  const origin = await listen(srv);

  try {
    const f = new Fetcher({ retries: 0, timeout: 5000 });
    for (const p of ['/a.css', '/a.png', '/a.woff2', '/model.glb', '/clip.mp4']) {
      await f.fetch(new URL(origin + p));
    }
    assert.match(seen['/a.css'], /text\/css/);
    assert.match(seen['/a.png'], /image\//);
    assert.match(seen['/a.woff2'], /font\//);
    assert.match(seen['/clip.mp4'], /video\//);
    // Models are fetched by script; a browser sends */* for those.
    assert.equal(seen['/model.glb'], '*/*');
  } finally {
    await close(srv);
  }
});

test('a referer is sent for subresources, since hotlink checks need it', async () => {
  let headers = null;
  const srv = http.createServer((req, res) => {
    headers = req.headers;
    res.setHeader('content-type', 'text/css');
    res.end('body{}');
  });
  const origin = await listen(srv);

  try {
    await new Fetcher({ retries: 0, timeout: 5000 }).fetch(new URL(`${origin}/a.css`), {
      referer: `${origin}/index.html`,
    });
    assert.equal(headers.referer, `${origin}/index.html`);
  } finally {
    await close(srv);
  }
});

// --- housekeeping ----------------------------------------------------------

test('the ladder is made of genuinely different engines', () => {
  assert.ok(UA_LADDER.length >= 3);
  const engines = UA_LADDER.map((ua) => describeUa(ua));
  assert.deepEqual([...new Set(engines)].sort(), ['Chrome', 'Firefox', 'Safari']);
});

test('block statuses exclude the ones that mean something else', () => {
  for (const status of [403, 406]) assert.ok(BLOCK_STATUS.has(status));
  for (const status of [404, 500, 429, 200]) assert.ok(!BLOCK_STATUS.has(status));
});
