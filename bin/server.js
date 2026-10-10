#!/usr/bin/env node
'use strict';

/**
 * sitesnap app server.
 *
 * Threat model, stated plainly because it drove several choices below:
 *
 * This process runs on your machine and accepts a URL, then does network I/O
 * with it. Any page open in your browser can attempt to talk to a localhost
 * server — WebSocket handshakes are not blocked by the same-origin policy, and
 * a permissive server will happily take commands from evil.example. So:
 *
 *   - We bind 127.0.0.1 by default. Not reachable off-box unless you opt in.
 *   - Every WebSocket handshake has its Origin checked against our own host.
 *     This is the control that stops a drive-by from another tab. All
 *     commands travel over that socket; there is no state-changing HTTP route.
 *   - Saved sites are shown from a SECOND port. A mirrored site's own
 *     JavaScript runs when you view it, and on the app's origin it could open
 *     the command socket itself. On the viewer port it is a different origin,
 *     so the gate above refuses it like any other foreign page.
 *   - Snapshot ids are 128-bit random and are only ever looked up in the
 *     library's registry, never mapped onto a path.
 *
 * If you ever expose this beyond localhost, set SITESNAP_BLOCK_PRIVATE=1 so a
 * submitted URL cannot be used to read internal services or cloud metadata.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { Crawler, formatBytes } = require('../lib');
const { packStream } = require('../lib/pack');
const { Library, defaultRoot, openMeHtml, OPEN_ME } = require('../lib/library');
const { inspect, parseAddress } = require('../lib/inspect');
const { explainFailure, summarizeProblems } = require('../lib/friendly');
const engine = require('../lib/engine');
const system = require('../lib/system');
const { LoginSession } = require('../lib/login');
const hostedLib = require('../lib/hosted');

const VERSION = require('../package.json').version;

const MB = 1024 * 1024;
const MAX_CONCURRENT_JOBS = 2;
const MAX_GRAPH_PAGES = 1500;
const MAX_RECENT = 160;
/** Actions that need the visitor's own computer. A hosted server ignores them. */
const LOCAL_ONLY = new Set(['reveal', 'reveal-library', 'engine-install', 'login-start', 'login-finish', 'login-cancel', 'quit']);

/**
 * The three questions the app asks, turned into crawler settings.
 *
 * "How much?" sets where the crawl may go; "how big?" sets the budgets.
 * Everything a developer would reach for is still reachable under More
 * options, but nobody has to know what "depth" means to get a good result.
 */
const SCOPES = {
  page: { maxDepth: 0, noParent: true },
  section: { maxDepth: 4, noParent: true },
  site: { maxDepth: 8, noParent: false },
};

const SIZES = {
  quick: { maxPages: 25, maxFiles: 1500, maxBytes: 250 * MB },
  normal: { maxPages: 150, maxFiles: 5000, maxBytes: 750 * MB },
  everything: { maxPages: 1000, maxFiles: 20000, maxBytes: 3072 * MB },
};

function config() {
  const port = Number.parseInt(process.env.PORT || '4000', 10);
  return {
    port,
    host: process.env.HOST || (process.env.SITESNAP_HOSTED === '1' ? '0.0.0.0' : '127.0.0.1'),
    viewPort: Number.parseInt(process.env.SITESNAP_VIEW_PORT || String(port + 1), 10),
    blockPrivate: process.env.SITESNAP_BLOCK_PRIVATE === '1',
    libraryRoot: process.env.SITESNAP_LIBRARY || defaultRoot(),
    publicDir: process.env.SITESNAP_PUBLIC || path.join(__dirname, '..', 'public'),
    appMode: process.env.SITESNAP_APP === '1',
    hosted: process.env.SITESNAP_HOSTED === '1',
  };
}

/** "Documents/sitesnap" rather than "/Users/you/Documents/sitesnap". */
function friendlyPath(abs) {
  const rel = path.relative(os.homedir(), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join(' / ') : abs;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const FONT_EXT = /\.(woff2?|ttf|otf|eot)$/i;
const MEDIA_EXT = /\.(mp4|webm|mov|m4v|mp3|ogg|oga|wav|m4a|flac)$/i;
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|epub)$/i;

/** What kind of file this is, in the words the app uses. */
function category(kind, url) {
  if (kind === 'css') return 'style';
  if (kind === 'js') return 'script';
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = '';
  }
  if (IMAGE_EXT.test(pathname)) return 'image';
  if (FONT_EXT.test(pathname)) return 'font';
  if (MEDIA_EXT.test(pathname)) return 'media';
  if (DOC_EXT.test(pathname)) return 'document';
  return 'other';
}

function pathLabel(url) {
  try {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    return p === '/' ? u.hostname : p;
  } catch {
    return url;
  }
}

/** Comma-separated words or globs into crawler patterns. A plain word means "contains". */
function patterns(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 25)
    .map((s) => (s.startsWith('re:') || /[*?]/.test(s) ? s : `*${s}*`));
}

function intIn(value, lo, hi) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}

/**
 * Build crawler options from what the app sent. Every field is validated
 * here; nothing from the client reaches the crawler unchecked.
 */
function crawlSettings(request, inspected, cfg) {
  const scope = Object.hasOwn(SCOPES, request.scope) ? request.scope : 'section';
  const size = Object.hasOwn(SIZES, request.size) ? request.size : 'normal';
  const adv = request.advanced && typeof request.advanced === 'object' ? request.advanced : {};

  const options = { ...SCOPES[scope], ...SIZES[size] };
  if (scope === 'page') options.maxPages = 1;

  const pages = intIn(adv.maxPages, 1, 5000);
  if (pages && scope !== 'page') options.maxPages = pages;
  const mb = intIn(adv.maxMb, 10, 20000);
  if (mb) options.maxBytes = mb * MB;

  options.includeSubdomains = adv.subdomains === true;
  options.respectRobots = adv.ignoreRobots !== true;
  const sitemapFound = Boolean(inspected && inspected.sitemap && inspected.sitemap.found);
  options.useSitemap = adv.sitemap === 'on' || (adv.sitemap !== 'off' && scope === 'site' && sitemapFound);
  options.render = adv.modern === true;
  options.autoScroll = options.render && adv.scroll !== false;
  if (adv.patient === true) {
    options.settleMinMs = 4000;
    options.timeout = 60_000;
  }
  if (adv.gentle === true) {
    options.delay = 600;
    options.concurrency = 2;
  }
  options.include = patterns(adv.only);
  options.exclude = patterns(adv.skip);
  options.blockPrivate = cfg.blockPrivate;

  if (cfg.hosted && cfg.hostedLimits) {
    // A shared public server: small saves, polite crawling, no features that
    // need the visitor's own machine.
    const h = cfg.hostedLimits;
    options.maxPages = Math.min(options.maxPages, h.maxPages);
    options.maxFiles = Math.min(options.maxFiles, h.maxFiles);
    options.maxBytes = Math.min(options.maxBytes, h.maxMb * MB);
    options.respectRobots = true;
    options.render = false;
    options.autoScroll = false;
    options.includeSubdomains = false;
    options.concurrency = Math.min(options.concurrency || 4, 4);
    options.blockPrivate = true;
  }

  const advanced = {
    subdomains: options.includeSubdomains,
    ignoreRobots: !options.respectRobots,
    sitemap: ['on', 'off'].includes(adv.sitemap) ? adv.sitemap : 'auto',
    modern: options.render,
    scroll: adv.scroll !== false,
    patient: adv.patient === true,
    gentle: adv.gentle === true,
    only: String(adv.only || '').slice(0, 500),
    skip: String(adv.skip || '').slice(0, 500),
    maxPages: pages,
    maxMb: mb,
  };

  return { scope, size, advanced, options };
}

/** A record as the client sees it. The page graph is sent only on request. */
function publicRecord(record, { withPages = false } = {}) {
  const { pages, options, owner, ...rest } = record;
  return withPages ? { ...rest, pages: pages || [] } : rest;
}

async function start(overrides = {}) {
  const cfg = { ...config(), ...overrides };
  if (cfg.hosted) {
    cfg.hostedLimits = hostedLib.hostedSettings();
    cfg.blockPrivate = true;
    await require('fs/promises').mkdir(cfg.libraryRoot, { recursive: true });
    await hostedLib.wipeLibrary(cfg.libraryRoot);
  }
  const library = await new Library(cfg.libraryRoot).init();

  /** @type {Map<string, object>} running jobs by snapshot id */
  const running = new Map();
  /** Recent site checks, so a start request can refer to one by token. */
  const inspections = new Map();
  const clients = new Set();

  // ---- app server --------------------------------------------------------

  const app = express();
  app.disable('x-powered-by');

  let gate = null;
  const ipLimiter = cfg.hosted ? new hostedLib.Limiter(cfg.hostedLimits.perMinutePerIp, 60_000) : null;
  const dailyLimiter = cfg.hosted ? new hostedLib.Limiter(cfg.hostedLimits.dailyPerVisitor, 24 * 60 * 60_000) : null;
  if (cfg.hosted) {
    app.set('trust proxy', 1);
    gate = new hostedLib.Gate(cfg.hostedLimits);
    gate.mount(app, { publicDir: cfg.publicDir });
  }
  /** On a hosted server a visitor may only touch their own saves. */
  const owns = (ws, record) => !cfg.hosted || Boolean(record && ws.owner && record.owner === ws.owner);

  app.use(express.static(cfg.publicDir, { etag: true, maxAge: 0 }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: VERSION, node: process.version, running: running.size });
  });

  /**
   * Download a snapshot as a zip, built on the fly. The id must exist in the
   * library registry; nothing user-supplied is ever turned into a path.
   */
  app.get('/download/:id', (req, res) => {
    const record = library.get(req.params.id);
    const mine = !cfg.hosted || (record && record.owner === gate.visitor(req.headers.cookie));
    if (!record || !mine || running.has(record.id) || !record.stats || !record.stats.files) {
      res.status(404).json({ error: 'No saved copy with that id.' });
      return;
    }
    const siteDir = library.siteDirOf(record.id);
    res.attachment(`${record.host}.zip`);
    const extras = record.entry
      ? [{ name: OPEN_ME, content: openMeHtml(record.entry, record.title || record.host) }]
      : [];
    const archive = packStream(siteDir, res, { extras });
    archive.on('error', () => res.destroy());
    req.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });
  });

  const server = http.createServer(app);

  // ---- viewer server -----------------------------------------------------

  const viewer = express();
  viewer.disable('x-powered-by');
  viewer.use((_req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-cache');
    next();
  });

  viewer.get('/:id/__sitesnap/:kind', (req, res) => {
    const file = ['icon', 'cover'].includes(req.params.kind) ? library.imagePath(req.params.id, req.params.kind) : null;
    if (!file) {
      res.status(404).end();
      return;
    }
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  });

  const statics = new Map();
  viewer.use('/:id', (req, res, next) => {
    const record = library.get(req.params.id);
    if (!record || running.has(record.id)) {
      next();
      return;
    }
    let serve = statics.get(record.id);
    if (!serve) {
      // dotfiles: 'ignore' keeps the resume state (a list of every URL
      // crawled) from being served to the pages being viewed.
      serve = express.static(library.siteDirOf(record.id), { dotfiles: 'ignore', etag: true });
      statics.set(record.id, serve);
    }
    serve(req, res, next);
  });

  viewer.use((_req, res) => {
    res
      .status(404)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Not saved</title>' +
          '<body style="font:16px/1.6 -apple-system,sans-serif;padding:3rem;color:#444">' +
          '<h1 style="font-size:1.4rem">This page wasn’t saved</h1>' +
          '<p>It was outside what sitesnap was asked to copy. Go back, or open the live site when you are online.</p>'
      );
  });

  const viewServer = http.createServer(viewer);

  // ---- WebSocket origin gate --------------------------------------------

  /**
   * A browser always sends Origin on a WebSocket handshake, so requiring it to
   * match us is what blocks a malicious page from driving this server.
   * Requests with no Origin at all are non-browser clients (curl, a script),
   * which cannot be a cross-site attack.
   */
  function originAllowed(origin, hostHeader) {
    if (!origin) return true;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (hostHeader && parsed.host === hostHeader) return true;
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    return loopback.has(parsed.hostname) && String(parsed.port) === String(cfg.port);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      console.warn(`[sitesnap] rejected WebSocket from origin: ${req.headers.origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    let owner = null;
    if (cfg.hosted) {
      owner = gate.visitor(req.headers.cookie);
      if (!owner) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.owner = owner;
      ws.ip = (cfg.hosted && forwarded) || req.socket.remoteAddress || 'unknown';
      wss.emit('connection', ws, req);
    });
  });

  // ---- messaging ---------------------------------------------------------

  function send(ws, type, payload = {}) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
  }

  function broadcast(type, payload = {}) {
    for (const ws of clients) send(ws, type, payload);
  }

  function emitJob(job, type, payload = {}) {
    for (const ws of job.subscribers) send(ws, type, { id: job.id, ...payload });
  }

  function libraryFor(ws) {
    return {
      items: library
        .list()
        .filter((r) => owns(ws, r))
        .map((r) => publicRecord(r)),
      running: [...running.entries()].filter(([, job]) => owns(ws, job.record)).map(([id]) => id),
    };
  }

  function broadcastLibrary() {
    for (const ws of clients) send(ws, 'library', libraryFor(ws));
  }

  function jobProgress(job) {
    const s = job.crawler.stats;
    const q = job.crawler.progress();
    return {
      files: s.files,
      pages: s.pages,
      bytes: s.bytes,
      human: formatBytes(s.bytes),
      queued: q.filesQueued,
      pagesQueued: q.pagesQueued,
      waiting: q.waiting,
      active: q.active,
      failed: s.failed,
      phase: job.phase,
      rewrite: job.rewrite,
      counts: job.counts,
      elapsed: Date.now() - job.startedAt,
    };
  }

  /** Everything a client needs to draw a running job from scratch. */
  function jobState(job) {
    return {
      id: job.id,
      record: publicRecord(job.record),
      pages: [...job.pages.values()],
      recent: job.recent,
      progress: jobProgress(job),
    };
  }

  function note(job, entry) {
    job.recent.push({ at: Date.now(), ...entry });
    if (job.recent.length > MAX_RECENT) job.recent.shift();
    emitJob(job, 'log', entry);
  }

  // ---- jobs --------------------------------------------------------------

  /**
   * Run a crawl for a library record. The job belongs to the server, not to
   * the browser tab that started it: closing or reloading the tab no longer
   * cancels anything, and any tab can re-attach and watch.
   */
  async function runJob(record, options, ws, { resume = false } = {}) {
    const siteDir = library.siteDirOf(record.id);
    let crawler;
    try {
      crawler = new Crawler(record.finalUrl || record.url, siteDir, { ...options, resume });
    } catch (err) {
      // A malformed "only save" or "skip" rule is the usual cause.
      const error = {
        kind: 'settings',
        title: 'One of your rules in More options doesn\u2019t make sense.',
        message: 'Check the \u201conly save\u201d and \u201cskip\u201d boxes, then try again.',
        action: 'settings',
        actionLabel: 'Change what to save',
        detail: err.message,
      };
      if (!resume) await library.remove(record.id);
      if (ws) send(ws, 'failed', { id: record.id, error });
      broadcastLibrary();
      return;
    }

    const job = {
      id: record.id,
      record,
      crawler,
      subscribers: new Set(ws ? [ws] : []),
      startedAt: Date.now(),
      phase: 'starting',
      rewrite: null,
      pages: new Map(),
      recent: [],
      counts: { image: 0, style: 0, script: 0, font: 0, media: 0, document: 0, other: 0 },
    };
    running.set(record.id, job);
    if (ws) ws.watching = record.id;

    await library.update(record.id, { status: 'running', error: null });
    broadcastLibrary();
    emitJob(job, 'job', { job: jobState(job) });

    crawler.on('resource', (r) => {
      if (r.kind === 'html') {
        const page = {
          u: r.url,
          p: r.parent || null,
          t: r.title || null,
          d: Number.isFinite(r.depth) ? r.depth : null,
          // Where the saved copy lives inside the mirror, for the viewer.
          l: r.localPath || null,
        };
        if (job.pages.size < MAX_GRAPH_PAGES && !job.pages.has(r.url)) job.pages.set(r.url, page);
        emitJob(job, 'page', { page });
        note(job, { k: 'page', text: r.title || pathLabel(r.url), url: r.url });
      } else {
        const c = category(r.kind, r.url);
        job.counts[c] += 1;
        emitJob(job, 'file', { c, p: r.parent || null });
        note(job, { k: 'file', c, url: r.url });
      }
    });

    crawler.on('warn', (w) => note(job, { k: 'warn', url: w.url, detail: w.message }));
    crawler.on('skip', (s) => note(job, { k: 'skip', url: s.url, detail: s.reason }));
    crawler.on('phase', (p) => {
      if (p.phase === 'rewrite') {
        job.phase = 'rewrite';
        job.rewrite = { done: p.done || 0, total: p.total || 0 };
      } else if (['crawl', 'sitemap', 'render', 'resume'].includes(p.phase)) {
        job.phase = 'crawl';
      } else if (p.phase === 'throttle') {
        note(job, { k: 'slow', detail: p.message });
      }
    });

    const ticker = setInterval(() => emitJob(job, 'progress', { progress: jobProgress(job) }), 450);
    const timeLimit = cfg.hosted
      ? setTimeout(
          () => crawler.stop(`the ${cfg.hostedLimits.maxMinutes} minute limit on this free page was reached`),
          cfg.hostedLimits.maxMinutes * 60_000
        )
      : null;

    try {
      const result = await crawler.run();
      const stats = result.stats;
      const graph = [...job.pages.values()];
      const notes = summarizeProblems(stats, result.failures);

      const fields = {
        status: result.stopped ? 'stopped' : 'done',
        stopReason: result.stopped || null,
        finishedAt: Date.now(),
        entry: result.entryFile || record.entry || null,
        notes,
        stats: {
          pages: stats.pages,
          files: stats.files,
          bytes: stats.bytes,
          failed: stats.failed,
          reused: stats.reused,
          durationMs: stats.durationMs,
        },
        counts: job.counts,
        // A resumed run only reports what changed, so keep the old map when
        // the new one is smaller rather than shrinking the picture.
        pages: resume && (record.pages || []).length > graph.length ? record.pages : graph,
      };
      await library.update(record.id, fields);
      await library.writeOpenMe(record.id, fields.entry, record.title || record.host).catch(() => {});

      emitJob(job, 'done', { record: publicRecord(record, { withPages: true }) });
    } catch (err) {
      const stats = crawler.stats;
      const error = explainFailure({
        url: record.url,
        message: err.message,
        stats,
        failures: crawler.failures,
      });

      if (!resume && stats.files === 0) {
        await library.remove(record.id);
      } else {
        await library.update(record.id, { status: 'stopped', error, stopReason: error.title });
      }
      emitJob(job, 'failed', { error, cancelled: crawler.stopReason === 'cancelled by you' });
    } finally {
      clearInterval(ticker);
      if (timeLimit) clearTimeout(timeLimit);
      running.delete(record.id);
      broadcastLibrary();
    }
  }

  const plainError = (kind, title, message) => ({ kind, title, message, action: null, actionLabel: null, detail: '' });

  /** Public-server limits. Returns an error to show, or null if the save may go ahead. */
  function hostedGuard(ws) {
    if (!cfg.hosted) return null;
    const L = cfg.hostedLimits;
    if (!ipLimiter.take(ws.ip)) {
      return plainError('busy', 'That was a lot of requests in a row.', 'Please wait a minute, then try again.');
    }
    const mine = [...running.values()].filter((j) => j.record.owner === ws.owner).length;
    if (mine >= 1 || starting.has(ws.owner)) {
      return plainError('busy', 'One save at a time on this free page.', 'Wait for your current save to finish, then start the next one.');
    }
    if (running.size + starting.size >= L.maxJobs) {
      return plainError(
        'busy',
        'This free page is busy right now.',
        `Other people are saving sites. Please try again in a minute or two.`
      );
    }
    if (!dailyLimiter.take(ws.owner)) {
      return plainError('busy', 'You have used today’s saves.', `This free page allows ${L.dailyPerVisitor} saves a day. Please come back tomorrow, or run sitesnap on your own computer for no limits.`);
    }
    return null;
  }

  /** Visitors whose save has passed the limits but is not registered as running yet. */
  const starting = new Set();

  async function startJob(ws, msg) {
    const limit = cfg.hosted ? hostedGuard(ws) : null;
    if (limit) {
      send(ws, 'start-failed', { error: limit });
      return;
    }
    if (cfg.hosted) starting.add(ws.owner);
    try {
      await beginJob(ws, msg);
    } finally {
      starting.delete(ws.owner);
    }
  }

  async function beginJob(ws, msg) {
    if (!cfg.hosted && running.size >= MAX_CONCURRENT_JOBS) {
      send(ws, 'start-failed', {
        error: plainError('busy', 'sitesnap is already saving two sites.', 'Wait for one of them to finish, then try again.'),
      });
      return;
    }

    const cached = typeof msg.inspection === 'string' ? inspections.get(msg.inspection) : null;
    const inspected = cached ? cached.result : null;
    const target = inspected ? inspected.finalUrl : msg.url;
    const url = parseAddress(target);
    if (!url) {
      const result = await inspect(String(msg.url || ''), { blockPrivate: cfg.blockPrivate });
      send(ws, 'start-failed', { error: result.error });
      return;
    }

    const { scope, size, advanced, options } = crawlSettings(msg, inspected, cfg);

    // A borrowed sign-in applies only to the site it was taken from.
    let usedLogin = false;
    if (msg.useLogin && ws.login && ws.login.header && ws.login.host === url.hostname) {
      options.headers = { cookie: ws.login.header };
      usedLogin = true;
    }

    const record = await library.create({
      url: url.href,
      finalUrl: url.href,
      host: url.hostname,
      title: (inspected && (inspected.title || inspected.siteName)) || url.hostname,
      siteName: inspected ? inspected.siteName : null,
      description: inspected ? inspected.description : null,
      scope,
      size,
      advanced,
      usedLogin,
      owner: cfg.hosted ? ws.owner : undefined,
      // Stored without credentials, so "Update" can repeat the same crawl.
      options: { ...options, headers: undefined },
    });

    if (inspected) {
      await library.saveImage(record.id, 'icon', inspected.icon).catch(() => {});
      await library.saveImage(record.id, 'cover', inspected.image).catch(() => {});
    }

    send(ws, 'started', { record: publicRecord(record) });
    runJob(record, options, ws).catch((err) => console.error('[sitesnap] job crashed:', err));
  }

  async function updateJob(ws, id) {
    const record = library.get(id);
    if (!record || running.has(id) || !owns(ws, record)) return;
    if (cfg.hosted) {
      const limit = hostedGuard(ws);
      if (limit) {
        send(ws, 'toast', { text: limit.title + ' ' + limit.message });
        return;
      }
    } else if (running.size >= MAX_CONCURRENT_JOBS) {
      send(ws, 'toast', { text: 'sitesnap is already saving two sites. Try again when one finishes.' });
      return;
    }
    const options = { ...(record.options || {}), blockPrivate: cfg.blockPrivate };
    if (cfg.hosted) Object.assign(options, crawlSettings({ scope: record.scope, size: record.size, advanced: record.advanced }, null, cfg).options);
    if (record.usedLogin && ws.login && ws.login.header && ws.login.host === record.host) {
      options.headers = { cookie: ws.login.header };
    }
    send(ws, 'started', { record: publicRecord(record) });
    runJob(record, options, ws, { resume: true }).catch((err) => console.error('[sitesnap] job crashed:', err));
  }

  function attach(ws, id) {
    for (const job of running.values()) job.subscribers.delete(ws);
    const job = running.get(id);
    if (!job || !owns(ws, job.record)) return false;
    job.subscribers.add(ws);
    ws.watching = id;
    send(ws, 'job', { id, job: jobState(job) });
    return true;
  }

  // ---- modern site mode and sign-in ---------------------------------------

  let engineState = { state: engine.status().ready ? 'ready' : 'missing' };

  function installEngine() {
    if (engineState.state === 'installing') return;
    engineState = { state: 'installing', step: 'library', percent: 0, message: 'Starting' };
    broadcast('engine', engineState);
    let last = 0;
    engine
      .install((update) => {
        engineState = { state: 'installing', ...update };
        const now = Date.now();
        if (now - last > 250 || update.step === 'done') {
          last = now;
          broadcast('engine', engineState);
        }
      })
      .then(() => {
        engineState = { state: 'ready' };
        broadcast('engine', engineState);
      })
      .catch((err) => {
        engineState = { state: 'error', message: err.message };
        broadcast('engine', engineState);
      });
  }

  async function loginStart(ws, rawUrl) {
    const url = parseAddress(rawUrl);
    if (!url) return;
    if (!engine.status().ready) {
      send(ws, 'login', { state: 'needs-engine' });
      return;
    }
    if (ws.login && ws.login.session) await ws.login.session.close();
    const session = new LoginSession(url.href);
    ws.login = { session, header: null, host: url.hostname };
    try {
      await session.open();
      send(ws, 'login', { state: 'open', host: url.hostname });
    } catch (err) {
      send(ws, 'login', { state: 'error', message: err.message });
    }
  }

  async function loginFinish(ws) {
    if (!ws.login || !ws.login.session) return;
    const { header, count } = await ws.login.session.finish();
    ws.login.session = null;
    ws.login.header = header;
    send(ws, 'login', { state: header ? 'ready' : 'empty', host: ws.login.host, count });
  }

  // ---- connections -------------------------------------------------------

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (cfg.hosted && LOCAL_ONLY.has(msg.action)) return;
      if (cfg.hosted && msg.action === 'inspect' && !ipLimiter.take(ws.ip)) {
        send(ws, 'inspected', {
          reqId: msg.reqId,
          token: null,
          result: { ok: false, error: plainError('busy', 'That was a lot of requests in a row.', 'Please wait a minute, then try again.') },
        });
        return;
      }

      try {
        switch (msg.action) {
          case 'hello': {
            send(ws, 'hello', {
              version: VERSION,
              appMode: cfg.appMode,
              hosted: cfg.hosted
                ? {
                    keepMinutes: cfg.hostedLimits.keepMinutes,
                    maxPages: cfg.hostedLimits.maxPages,
                    maxMb: cfg.hostedLimits.maxMb,
                    maxMinutes: cfg.hostedLimits.maxMinutes,
                    dailySaves: cfg.hostedLimits.dailyPerVisitor,
                    contact: cfg.hostedLimits.contact,
                  }
                : null,
              viewPort: cfg.hosted ? null : cfg.viewPort,
              libraryPath: cfg.hosted ? 'this page' : friendlyPath(library.root),
              engine: cfg.hosted ? { state: 'unavailable' } : engineState,
              ...libraryFor(ws),
            });
            if (typeof msg.attach === 'string') attach(ws, msg.attach);
            break;
          }

          case 'inspect': {
            const result = await inspect(String(msg.url || '').slice(0, 2000), { blockPrivate: cfg.blockPrivate });
            let token = null;
            if (result.ok) {
              token = crypto.randomBytes(16).toString('hex');
              inspections.set(token, { result, at: Date.now() });
              for (const [key, value] of inspections) {
                if (Date.now() - value.at > 30 * 60_000 || inspections.size > 40) inspections.delete(key);
              }
            }
            send(ws, 'inspected', { reqId: msg.reqId, token, result });
            break;
          }

          case 'start':
            await startJob(ws, msg);
            break;

          case 'attach':
            if (!attach(ws, msg.id)) send(ws, 'gone', { id: msg.id });
            break;

          case 'cancel': {
            const job = running.get(msg.id);
            if (job && owns(ws, job.record)) job.crawler.stop('cancelled by you');
            break;
          }

          case 'update':
            await updateJob(ws, msg.id);
            break;

          case 'snapshot': {
            const record = library.get(msg.id);
            if (record && owns(ws, record)) send(ws, 'snapshot', { record: publicRecord(record, { withPages: true }) });
            else send(ws, 'gone', { id: msg.id });
            break;
          }

          case 'delete': {
            if (running.has(msg.id) || !owns(ws, library.get(msg.id))) break;
            statics.delete(msg.id);
            await library.remove(msg.id);
            broadcastLibrary();
            break;
          }

          case 'reveal': {
            const dir = library.dirOf(msg.id);
            if (dir) await system.revealPath(dir);
            break;
          }

          case 'reveal-library':
            await system.revealPath(library.root);
            break;

          case 'engine-install':
            installEngine();
            break;

          case 'login-start':
            await loginStart(ws, msg.url);
            break;

          case 'login-finish':
            await loginFinish(ws);
            break;

          case 'login-cancel':
            if (ws.login && ws.login.session) await ws.login.session.close();
            ws.login = null;
            send(ws, 'login', { state: 'cancelled' });
            break;

          case 'quit':
            if (cfg.appMode) shutdown();
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('[sitesnap] message failed:', err);
        send(ws, 'toast', { text: 'Something went wrong there. Please try again.' });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      // Jobs keep running without a watcher; only the subscription ends.
      for (const job of running.values()) job.subscribers.delete(ws);
      if (ws.login && ws.login.session) ws.login.session.close();
    });
  });

  // Drop half-open connections.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  // ---- start -------------------------------------------------------------

  await listen(server, cfg.port, cfg.host);
  // A hosted server has one public port, and no in-browser viewer: visitors
  // download a zip instead.
  if (!cfg.hosted) await listen(viewServer, cfg.viewPort, cfg.host);
  let sweeper = null;
  if (cfg.hosted) {
    sweeper = hostedLib.startSweeper({
      library,
      running,
      keepMs: cfg.hostedLimits.keepMinutes * 60_000,
      onRemove: (id) => {
        statics.delete(id);
        broadcastLibrary();
      },
    });
  }

  const appUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}/`;
  if (!overrides.quiet) {
    console.log(`\n  sitesnap  →  ${appUrl}\n`);
    console.log(`  library       ${library.root}`);
    if (cfg.hosted) {
      console.log('  mode          hosted (email gate on, private addresses blocked)');
      if (cfg.hostedLimits.secretIsEphemeral) console.log('  ⚠  SITESNAP_SECRET is not set: visitors will be asked for their email again after a restart.');
      if (!cfg.hostedLimits.webhook) console.log('  ⚠  SITESNAP_EMAIL_WEBHOOK is not set: emails live only in data/emails.jsonl on this machine.');
    } else {
      console.log(`  viewer port   ${cfg.viewPort}`);
    }
    console.log(`  private addrs ${cfg.blockPrivate ? 'blocked' : 'allowed (localhost mirroring on)'}`);
    if (!cfg.hosted && cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
      console.warn(
        `\n  ⚠  Bound to ${cfg.host}, so this is reachable off-box.\n` +
          `     Set SITESNAP_BLOCK_PRIVATE=1 unless you trust everyone who can reach it.\n`
      );
    }
    console.log('');
  }

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    if (!overrides.quiet) console.log('\nShutting down…');
    broadcast('bye');
    const waits = [...running.values()].map(
      (job) =>
        new Promise((resolve) => {
          job.crawler.once('done', resolve);
          job.crawler.stop('sitesnap was closed');
          setTimeout(resolve, 4000);
        })
    );
    for (const ws of clients) if (ws.login && ws.login.session) ws.login.session.close();
    await Promise.all(waits);
    // Let the finishing jobs write their records.
    await new Promise((r) => setTimeout(r, 300));
    if (sweeper) clearInterval(sweeper);
    server.close();
    if (!cfg.hosted) viewServer.close();
    if (!overrides.keepProcess) process.exit(0);
  }

  return { server, viewServer, library, url: appUrl, shutdown, config: cfg };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

module.exports = { start, crawlSettings, patterns, category, SCOPES, SIZES };

if (require.main === module) {
  start()
    .then(({ shutdown, url }) => {
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      if (process.argv.includes('--open')) system.openUrl(url);
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n  Port ${err.port} is already in use. Is sitesnap already running?\n`);
      } else {
        console.error(err);
      }
      process.exit(1);
    });
}
