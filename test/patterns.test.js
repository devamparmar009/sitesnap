'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { UrlFilter, compile } = require('../lib/patterns');
const { parse: parseRobots } = require('../lib/robots');
const { parse: parseSitemap } = require('../lib/sitemap');

const u = (s) => new URL(s, 'https://ex.com');

function allows(filter, url, kind = 'page') {
  return filter.rejects(u(url), kind) === null;
}

// --- glob semantics --------------------------------------------------------

test('* crosses path separators', () => {
  // The whole point for URLs: /docs/* must reach /docs/a/b/c.
  const f = new UrlFilter(['/docs/*']);
  assert.ok(allows(f, '/docs/a'));
  assert.ok(allows(f, '/docs/a/b/c'));
  assert.ok(!allows(f, '/blog/a'));
});

test('a trailing /* also matches the bare directory', () => {
  // Otherwise the section index page is silently missed, which is the most
  // common way this kind of filter disappoints people.
  const f = new UrlFilter(['/docs/*']);
  assert.ok(allows(f, '/docs'), '/docs should match /docs/*');
  assert.ok(allows(f, '/docs/'), '/docs/ should match /docs/*');
});

test('? matches exactly one non-slash character', () => {
  const f = new UrlFilter(['/p?']);
  assert.ok(allows(f, '/pa'));
  assert.ok(!allows(f, '/pab'));
  assert.ok(!allows(f, '/p/a'));
});

test('patterns are full matches, not substring searches', () => {
  const f = new UrlFilter(['/docs']);
  assert.ok(allows(f, '/docs'));
  assert.ok(!allows(f, '/docs/page'), 'bare /docs must not match deeper paths');
  assert.ok(!allows(f, '/other/docs'));
});

test('regex escapes are respected in literal segments', () => {
  const f = new UrlFilter(['/a.b']);
  assert.ok(allows(f, '/a.b'));
  assert.ok(!allows(f, '/axb'), 'the dot must be literal, not a wildcard');
});

test('a path pattern matches path + query; other patterns match the whole URL', () => {
  const byPath = new UrlFilter(['/search*']);
  assert.ok(allows(byPath, '/search?q=1'));

  const byUrl = new UrlFilter(['*.pdf']);
  assert.ok(allows(byUrl, 'https://ex.com/files/a.pdf'));
  assert.ok(!allows(byUrl, 'https://ex.com/files/a.html'));
});

test('cross-origin patterns work against the full URL', () => {
  const f = new UrlFilter([], ['https://cdn.other.com/*']);
  assert.ok(!allows(f, 'https://cdn.other.com/x.js', 'asset'));
  assert.ok(allows(f, 'https://ex.com/x.js', 'asset'));
});

test('re: prefix passes through a raw regex', () => {
  const f = new UrlFilter(['re:^/(docs|guide)/']);
  assert.ok(allows(f, '/docs/a'));
  assert.ok(allows(f, '/guide/a'));
  assert.ok(!allows(f, '/blog/a'));
});

test('a malformed pattern fails loudly rather than matching nothing', () => {
  assert.throws(() => compile('re:[unclosed'), /invalid regex/);
  assert.throws(() => compile('   '), /empty pattern/);
});

// --- include / exclude interaction ----------------------------------------

test('exclude beats include', () => {
  const f = new UrlFilter(['/docs/*'], ['/docs/private/*']);
  assert.ok(allows(f, '/docs/public'));
  assert.ok(!allows(f, '/docs/private/secret'));
});

test('include gates pages but never starves assets', () => {
  // The reason this rule exists: styling usually lives outside the content
  // path, so filtering assets by --include would break every page you kept.
  const f = new UrlFilter(['/docs/*']);
  assert.ok(!allows(f, '/static/app.css', 'page'), 'as a page it is out of scope');
  assert.ok(allows(f, '/static/app.css', 'asset'), 'as an asset it must still load');
});

test('exclude applies to assets as well as pages', () => {
  const f = new UrlFilter([], ['/analytics/*']);
  assert.ok(!allows(f, '/analytics/track.js', 'asset'));
});

test('no patterns means the filter is inactive', () => {
  assert.equal(new UrlFilter([], []).active, false);
  assert.equal(new UrlFilter(['/a']).active, true);
});

test('multiple includes are OR-ed', () => {
  const f = new UrlFilter(['/docs/*', '/guide/*']);
  assert.ok(allows(f, '/docs/a'));
  assert.ok(allows(f, '/guide/a'));
  assert.ok(!allows(f, '/blog/a'));
});

// --- robots Sitemap directive ---------------------------------------------

test('robots.txt Sitemap directives are collected', () => {
  const robots = parseRobots(`
    Sitemap: https://ex.com/sitemap.xml
    User-agent: *
    Disallow: /admin
    Sitemap: https://ex.com/news-sitemap.xml
  `);
  assert.deepEqual(robots.sitemaps, [
    'https://ex.com/sitemap.xml',
    'https://ex.com/news-sitemap.xml',
  ]);
});

test('sitemaps survive when no user-agent group applies to us', () => {
  const robots = parseRobots(`
    Sitemap: https://ex.com/sitemap.xml
    User-agent: googlebot
    Disallow: /
  `);
  assert.deepEqual(robots.sitemaps, ['https://ex.com/sitemap.xml']);
  assert.equal(robots.allowAll, true, 'a googlebot-only rule must not bind us');
});

// --- sitemap parsing -------------------------------------------------------

test('parses a urlset', () => {
  const { urls, sitemaps } = parseSitemap(`<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://ex.com/a</loc></url>
      <url><loc>https://ex.com/b</loc><lastmod>2026-01-01</lastmod></url>
    </urlset>`);
  assert.deepEqual(urls, ['https://ex.com/a', 'https://ex.com/b']);
  assert.deepEqual(sitemaps, []);
});

test('parses a sitemap index', () => {
  const { urls, sitemaps } = parseSitemap(`<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://ex.com/s1.xml</loc></sitemap>
      <sitemap><loc>https://ex.com/s2.xml.gz</loc></sitemap>
    </sitemapindex>`);
  assert.deepEqual(sitemaps, ['https://ex.com/s1.xml', 'https://ex.com/s2.xml.gz']);
  assert.deepEqual(urls, []);
});

test('falls back to bare <loc> when the document is unnamespaced or odd', () => {
  const { urls } = parseSitemap('<root><loc>https://ex.com/a</loc></root>');
  assert.deepEqual(urls, ['https://ex.com/a']);
});

test('an empty or junk sitemap yields nothing rather than throwing', () => {
  assert.deepEqual(parseSitemap('<urlset></urlset>').urls, []);
  assert.deepEqual(parseSitemap('not xml at all').urls, []);
});
