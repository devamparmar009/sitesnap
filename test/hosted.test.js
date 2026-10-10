'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { cleanEmail, Limiter, Gate, hostedSettings } = require('../lib/hosted');
const { crawlSettings } = require('../bin/server');

function gate() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesnap-gate-'));
  return new Gate({ ...hostedSettings({ SITESNAP_SECRET: 'unit-test-secret' }), dataDir });
}

test('cleanEmail accepts ordinary addresses and lower-cases them', () => {
  assert.equal(cleanEmail('  Jo.Smith+tag@Example.COM '), 'jo.smith+tag@example.com');
});

test('cleanEmail rejects things that are not addresses', () => {
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'x@y..com', '@c.com', 'a@.com', `${'a'.repeat(300)}@c.com`, '<x>@c.com']) {
    assert.equal(cleanEmail(bad), null, bad);
  }
});

test('Limiter allows the limit, then refuses, per key', () => {
  const l = new Limiter(2, 60_000);
  assert.deepEqual([l.take('a'), l.take('a'), l.take('a'), l.take('b')], [true, true, false, true]);
});

test('visitor cookies verify, and a tampered or foreign one does not', () => {
  const g = gate();
  const id = 'a'.repeat(32);
  const cookie = g.cookieFor(id, false).split(';')[0];
  assert.equal(g.visitor(cookie), id);
  assert.equal(g.visitor(cookie.replace(/.$/, (c) => (c === 'x' ? 'y' : 'x'))), null);
  assert.equal(g.visitor(`ss_visitor=${'b'.repeat(32)}.${g.sign('a'.repeat(32))}`), null);
  assert.equal(g.visitor(''), null);
  const other = new Gate({ ...hostedSettings({ SITESNAP_SECRET: 'different' }), dataDir: g.s.dataDir });
  assert.equal(other.visitor(cookie), null);
});

test('an address is recorded once, and the CSV neutralises spreadsheet formulas', async () => {
  const g = gate();
  assert.equal(await g.record('a@example.com'), true);
  assert.equal(await g.record('a@example.com'), false);
  assert.equal(g.csv().trim().split('\n').length, 2);
  fs.appendFileSync(g.file, `${JSON.stringify({ email: '=cmd@x.com', at: 'now' })}\n`);
  assert.match(g.csv(), /"'=cmd@x\.com"/);
});

test('hosted crawl settings are capped and cannot be switched off', () => {
  const cfg = { blockPrivate: true, hosted: true, hostedLimits: hostedSettings({}) };
  const { options } = crawlSettings(
    { scope: 'site', size: 'everything', advanced: { modern: true, ignoreRobots: true, subdomains: true, maxPages: 5000, maxMb: 20000 } },
    null,
    cfg
  );
  assert.ok(options.maxPages <= cfg.hostedLimits.maxPages);
  assert.ok(options.maxBytes <= cfg.hostedLimits.maxMb * 1024 * 1024);
  assert.equal(options.respectRobots, true);
  assert.equal(options.render, false);
  assert.equal(options.includeSubdomains, false);
  assert.equal(options.blockPrivate, true);
});
