'use strict';

/**
 * The app server end to end: a real server on real ports, driven over its
 * WebSocket the way the page drives it, against a local fixture site.
 *
 * What these protect: a download outliving the tab that started it, the
 * viewer port being unable to drive the app, the private resume state never
 * being served, and the zip carrying its "Open me" page.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const WebSocket = require('ws');

const { start } = require('../bin/server');

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A small site. `delay` slows every response, to keep a crawl running. */
async function fixture({ delay = 0, pages = 3 } = {}) {
  const routes = {
    '/': `<html><head><title>Fixture Home</title></head><body>${Array.from(
      { length: pages },
      (_, i) => `<a href="/p${i}">p${i}</a>`
    ).join('')}<img src="/pic.png"></body></html>`,
    '/pic.png': { type: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
  };
  for (let i = 0; i < pages; i++) routes[`/p${i}`] = `<html><head><title>Page ${i}</title></head><body>page ${i}</body></html>`;

  const server = http.createServer(async (req, res) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const route = routes[req.url.split('?')[0]];
    if (route === undefined) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    const r = typeof route === 'string' ? { type: 'text/html', body: route } : route;
    res.setHeader('content-type', r.type);
    res.end(r.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function app() {
  const port = await freePort();
  let viewPort = await freePort();
  while (viewPort === port) viewPort = await freePort();
  const libraryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sitesnap-lib-'));
  const srv = await start({ port, viewPort, libraryRoot, quiet: true, keepProcess: true });
  return { ...srv, port, viewPort, libraryRoot };
}

/** A socket client that buffers messages and can wait for one. */
function client(port, origin = `http://127.0.0.1:${port}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  const seen = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    seen.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const api = {
    ws,
    seen,
    ready: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send: (action, payload = {}) => ws.send(JSON.stringify({ action, ...payload })),
    next(type, pred = () => true, timeout = 30000) {
      const match = (m) => m.type === type && pred(m);
      const already = seen.find(match);
      if (already) {
        seen.splice(seen.indexOf(already), 1);
        return Promise.resolve(already);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer);
            seen.splice(seen.indexOf(m), 1);
            resolve(m);
          },
        });
      });
    },
    close: () => ws.close(),
  };
  return api;
}

test('check, save, view and zip a site over the socket', async () => {
  const site = await fixture();
  const srv = await app();
  const c = client(srv.port);
  await c.ready;

  c.send('hello');
  const hello = await c.next('hello');
  assert.equal(hello.viewPort, srv.viewPort);
  assert.deepEqual(hello.items, []);

  c.send('inspect', { url: site.origin, reqId: 7 });
  const inspected = await c.next('inspected');
  assert.equal(inspected.reqId, 7);
  assert.equal(inspected.result.ok, true);
  assert.equal(inspected.result.title, 'Fixture Home');
  assert.match(inspected.token, /^[0-9a-f]{32}$/);

  c.send('start', { inspection: inspected.token, scope: 'site', size: 'quick' });
  const started = await c.next('started');
  const id = started.record.id;
  const done = await c.next('done', (m) => m.id === id);
  assert.equal(done.record.status, 'done');
  assert.equal(done.record.stats.pages, 4);
  assert.ok(done.record.pages.some((p) => p.t === 'Page 1' && p.l), 'pages carry titles and saved paths');

  // The viewer serves the saved copy...
  const page = await fetch(`http://127.0.0.1:${srv.viewPort}/${id}/${done.record.entry}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Fixture Home/);
  // ...but never the resume state, which lists every URL crawled.
  const state = await fetch(`http://127.0.0.1:${srv.viewPort}/${id}/.sitesnap-state.json`);
  assert.equal(state.status, 404);
  // An unknown id gets the friendly not-saved page, not a path lookup.
  const unknown = await fetch(`http://127.0.0.1:${srv.viewPort}/../../etc/passwd`);
  assert.equal(unknown.status, 404);

  const zip = await fetch(`http://127.0.0.1:${srv.port}/download/${id}`);
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-disposition'), /attachment; filename="127\.0\.0\.1\.zip"/);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.ok(bytes.includes(Buffer.from('Open me.html')));
  assert.ok(!bytes.includes(Buffer.from('.sitesnap-state.json')), 'resume state stays out of the zip');

  // The folder is a real, readable one with an Open me page.
  const folders = await fsp.readdir(srv.libraryRoot);
  assert.equal(folders.length, 1);
  assert.ok((await fsp.readdir(path.join(srv.libraryRoot, folders[0]))).includes('Open me.html'));

  c.send('delete', { id });
  const after = await c.next('library', (m) => m.items.length === 0);
  assert.deepEqual(after.items, []);
  assert.deepEqual(await fsp.readdir(srv.libraryRoot), []);

  c.close();
  await srv.shutdown();
  await site.close();
});

test('only the app itself may open the command socket', async () => {
  const srv = await app();
  const attempt = (origin) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`, { origin });
      ws.once('open', () => {
        ws.close();
        resolve('open');
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('error', () => resolve('error'));
    });

  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await attempt(`http://127.0.0.1:${srv.port}`), 'open');
    assert.equal(await attempt(`http://127.0.0.1:${srv.viewPort}`), 403, 'a saved site cannot drive the app');
    assert.equal(await attempt('https://evil.example'), 403);
  } finally {
    console.warn = warn;
  }
  await srv.shutdown();
});

test('a download keeps going after its tab closes, and another tab can pick it up', async () => {
  const site = await fixture({ delay: 120, pages: 6 });
  const srv = await app();

  const first = client(srv.port);
  await first.ready;
  first.send('start', { url: site.origin, scope: 'site', size: 'quick' });
  const started = await first.next('started');
  first.close();

  const second = client(srv.port);
  await second.ready;
  second.send('hello', { attach: started.record.id });
  const job = await second.next('job');
  assert.equal(job.id, started.record.id);
  assert.equal(job.job.record.host, '127.0.0.1');
  const done = await second.next('done');
  assert.equal(done.record.stats.pages, 7);

  second.close();
  await srv.shutdown();
  await site.close();
});

test('stopping keeps what was saved; a third download waits its turn', async () => {
  const site = await fixture({ delay: 400, pages: 12 });
  const srv = await app();
  const c = client(srv.port);
  await c.ready;

  c.send('start', { url: site.origin, scope: 'site', size: 'quick' });
  const a = await c.next('started');
  c.send('start', { url: site.origin, scope: 'site', size: 'quick' });
  const b = await c.next('started');
  c.send('start', { url: site.origin, scope: 'site', size: 'quick' });
  const busy = await c.next('start-failed');
  assert.equal(busy.error.kind, 'busy');

  // Let the first one save something, then stop both.
  await c.next('page', (m) => m.id === a.record.id);
  c.send('cancel', { id: a.record.id });
  c.send('cancel', { id: b.record.id });
  const stopped = await c.next('done', (m) => m.id === a.record.id);
  assert.equal(stopped.record.status, 'stopped');
  assert.ok(stopped.record.stats.files >= 1);

  c.close();
  await srv.shutdown();
  await site.close();
});
