'use strict';

/**
 * Hosted mode: the pieces that only matter when sitesnap is a public web
 * service instead of an app on your own machine.
 *
 * Turn it on with SITESNAP_HOSTED=1. Everything here exists because a public
 * server has different risks from a localhost one:
 *
 *   - A visitor leaves an email address before the tool opens (the "gate").
 *     The address is checked for shape only. Nothing is sent to it, so it is
 *     not verified; treat it as a contact list, not as proof of identity.
 *   - Each visitor sees only their own saves, and can only download their own.
 *   - Saves are small and short, are deleted shortly after they finish, and
 *     are limited per visitor, per address and in total.
 *   - Private network addresses are always blocked, robots.txt is always
 *     obeyed, and the features that need your own computer are switched off.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MB = 1024 * 1024;
const COOKIE = 'ss_visitor';
const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** Read hosted-mode settings from the environment. */
function hostedSettings(env = process.env) {
  const int = (name, fallback, lo, hi) => {
    const n = Number.parseInt(env[name], 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    secret: env.SITESNAP_SECRET || crypto.randomBytes(32).toString('hex'),
    secretIsEphemeral: !env.SITESNAP_SECRET,
    dataDir: env.SITESNAP_DATA || path.join(process.cwd(), 'data'),
    webhook: env.SITESNAP_EMAIL_WEBHOOK || '',
    adminKey: env.SITESNAP_ADMIN_KEY || '',
    contact: env.SITESNAP_CONTACT || '',
    keepMinutes: int('SITESNAP_KEEP_MINUTES', 30, 5, 24 * 60),
    maxPages: int('SITESNAP_MAX_PAGES', 60, 1, 500),
    maxFiles: int('SITESNAP_MAX_FILES', 2000, 50, 20000),
    maxMb: int('SITESNAP_MAX_MB', 100, 5, 1000),
    maxMinutes: int('SITESNAP_MAX_MINUTES', 8, 1, 60),
    maxJobs: int('SITESNAP_MAX_JOBS', 2, 1, 10),
    dailyPerVisitor: int('SITESNAP_DAILY_SAVES', 10, 1, 500),
    perMinutePerIp: int('SITESNAP_PER_MINUTE', 20, 1, 600),
  };
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Returns the cleaned address, or null if it does not look like one. */
function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  const [local, domain] = email.split('@');
  if (local.length > 64 || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return null;
  return email;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A fixed-window counter: at most `limit` hits per key per window. */
class Limiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** True if this hit is allowed. */
  take(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || now >= entry.reset) {
      entry = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, entry);
      if (this.hits.size > 5000) {
        for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k);
      }
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

class Gate {
  constructor(settings) {
    this.s = settings;
    this.file = path.join(settings.dataDir, 'emails.jsonl');
    this.known = new Set();
    this.gateLimiter = new Limiter(10, 60_000);
    fs.mkdirSync(settings.dataDir, { recursive: true });
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          this.known.add(JSON.parse(line).email);
        } catch {
          /* skip a damaged line */
        }
      }
    } catch {
      /* first run: no file yet */
    }
  }

  sign(id) {
    return crypto.createHmac('sha256', this.s.secret).update(id).digest('base64url');
  }

  /** The visitor id carried by a Cookie header, or null. */
  visitor(cookieHeader) {
    const raw = parseCookies(cookieHeader)[COOKIE];
    if (!raw) return null;
    const [id, sig] = raw.split('.');
    if (!id || !sig || !/^[0-9a-f]{32}$/.test(id) || !safeEqual(sig, this.sign(id))) return null;
    return id;
  }

  cookieFor(id, secure) {
    return `${COOKIE}=${id}.${this.sign(id)}; Path=/; Max-Age=${THIRTY_DAYS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  /** Write the address down (file, optional webhook). A repeat address is kept once. */
  async record(email) {
    if (this.known.has(email)) return false;
    this.known.add(email);
    const row = { email, at: new Date().toISOString(), source: 'sitesnap-gate' };
    await fsp.appendFile(this.file, `${JSON.stringify(row)}\n`).catch((err) => {
      console.error('[sitesnap] could not write the email list:', err.message);
    });
    if (this.s.webhook) {
      try {
        const res = await fetch(this.s.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(row),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) console.error(`[sitesnap] email webhook answered ${res.status}`);
      } catch (err) {
        console.error('[sitesnap] email webhook failed:', err.message);
      }
    }
    return true;
  }

  csv() {
    let rows = [];
    try {
      rows = fs
        .readFileSync(this.file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      rows = [];
    }
    // A spreadsheet will run a cell that starts with = + - @, so none can.
    const cell = (v) => `"${String(v).replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;
    return ['email,signed_up_at', ...rows.map((r) => `${cell(r.email)},${cell(r.at)}`)].join('\n') + '\n';
  }

  /** Express middleware set; mount before the static handler. */
  mount(app, { publicDir }) {
    const express = require('express');
    const secureReq = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

    app.use((req, res, next) => {
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'same-origin');
      next();
    });

    app.get('/api/limits', (_req, res) => {
      const { keepMinutes, maxPages, maxMb, maxMinutes } = this.s;
      res.json({ keepMinutes, maxPages, maxMb, maxMinutes });
    });

    // JSON from the page's script, or a plain form post when scripts are off.
    app.post('/api/gate', express.json({ limit: '2kb' }), express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
      const isForm = String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
      const fail = (status, error) => {
        if (isForm) res.status(status).type('text/plain').send(error);
        else res.status(status).json({ error });
      };
      if (!this.gateLimiter.take(req.ip)) {
        fail(429, 'Too many tries. Please wait a minute and try again.');
        return;
      }
      const email = cleanEmail(req.body && req.body.email);
      if (!email) {
        fail(400, 'That doesn’t look like an email address. Please check it and try again.');
        return;
      }
      await this.record(email);
      const id = crypto.randomBytes(16).toString('hex');
      res.set('Set-Cookie', this.cookieFor(id, secureReq(req)));
      res.set('Cache-Control', 'no-store');
      if (isForm) res.redirect(303, '/');
      else res.json({ ok: true });
    });

    app.get('/admin/emails.csv', (req, res) => {
      const auth = String(req.headers.authorization || '');
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!this.s.adminKey || !safeEqual(given, this.s.adminKey)) {
        res.status(404).end();
        return;
      }
      res.set('Cache-Control', 'no-store');
      res.type('text/csv').attachment('sitesnap-emails.csv').send(this.csv());
    });

    // The app itself is only handed to someone who has passed the gate.
    // Fonts, styles and scripts are public: there is nothing in them.
    app.get(['/', '/index.html'], (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (this.visitor(req.headers.cookie)) {
        next();
        return;
      }
      res.sendFile(path.join(publicDir, 'gate.html'));
    });
  }
}

/**
 * Remove finished saves once they are `keepMs` old, so the disk never fills
 * and nobody's copy of a site lingers on a shared machine.
 */
function startSweeper({ library, running, keepMs, onRemove }) {
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const record of library.list()) {
      if (running.has(record.id)) continue;
      const finished = record.finishedAt || record.updatedAt || record.createdAt || 0;
      if (now - finished > keepMs) {
        await library.remove(record.id).catch(() => {});
        onRemove(record.id);
      }
    }
  }, 60_000);
  timer.unref();
  return timer;
}

/** Empty the library folder at start-up: a fresh server starts with no one's data. */
async function wipeLibrary(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map((e) => fsp.rm(path.join(root, e.name), { recursive: true, force: true })));
}

module.exports = { hostedSettings, Gate, Limiter, cleanEmail, startSweeper, wipeLibrary, MB, COOKIE };
