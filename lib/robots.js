'use strict';

/**
 * Minimal robots.txt support.
 *
 * Not a complete RFC 9309 implementation — it handles User-agent grouping,
 * Allow/Disallow with * and $ wildcards, and Crawl-delay, which covers what
 * real sites actually write. Unknown directives are ignored.
 */

const EMPTY = { rules: [], crawlDelay: 0, allowAll: true, sitemaps: [] };

function patternToRegex(pattern) {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}`);
}

/**
 * @param {string} text  raw robots.txt
 * @param {string} ua    our user-agent token, lowercased
 */
function parse(text, ua = 'sitesnap') {
  const groups = [];
  const sitemaps = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(/#.*$/, '').trim();
    if (!stripped) continue;

    const idx = stripped.indexOf(':');
    if (idx === -1) continue;

    const field = stripped.slice(0, idx).trim().toLowerCase();
    const value = stripped.slice(idx + 1).trim();

    // Sitemap is a global directive — it belongs to the file, not to whichever
    // User-agent group happens to precede it.
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one rule block.
      if (!current || current.rules.length || current.crawlDelay) {
        current = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === 'allow' || field === 'disallow')) {
      if (field === 'disallow' && value === '') continue; // "allow everything"
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (current && field === 'crawl-delay') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  // Prefer a group naming us exactly; fall back to the wildcard group.
  const exact = groups.find((g) => g.agents.includes(ua));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = exact || wildcard;
  // No group applies to us, but the file may still advertise sitemaps.
  if (!chosen) return { ...EMPTY, sitemaps };

  return {
    // Longest match wins, per the spec's specificity rule.
    rules: chosen.rules
      .map((r) => ({ ...r, re: patternToRegex(r.path), len: r.path.length }))
      .sort((a, b) => b.len - a.len),
    crawlDelay: chosen.crawlDelay,
    allowAll: chosen.rules.length === 0,
    sitemaps,
  };
}

function isAllowed(robots, pathname) {
  if (!robots || robots.allowAll) return true;
  for (const rule of robots.rules) {
    if (rule.re.test(pathname)) return rule.allow;
  }
  return true;
}

/**
 * Fetch and parse robots.txt for an origin. Any failure means "no rules" —
 * a missing or broken robots.txt has never meant "crawl nothing".
 */
async function load(origin, { fetchImpl = fetch, userAgent, signal } = {}) {
  try {
    const res = await fetchImpl(new URL('/robots.txt', origin).href, {
      headers: { 'user-agent': userAgent },
      signal,
    });
    if (!res.ok) return EMPTY;
    return parse(await res.text());
  } catch {
    return EMPTY;
  }
}

module.exports = { parse, isAllowed, load, EMPTY };
