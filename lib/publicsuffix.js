'use strict';

/**
 * Registrable-domain detection.
 *
 * The naive "last two labels" rule says example.co.uk and other.co.uk share a
 * registrable domain, so `--subdomains` on one would happily crawl the other.
 * That is a scope bug with real consequences: it is how a crawl escapes the
 * site you asked for.
 *
 * The full Public Suffix List is ~10k entries and changes weekly, which is a
 * dependency and a staleness problem. This is a curated set covering the
 * multi-part suffixes that actually occur — ccTLD second levels, the common
 * platform domains, and the generic patterns. It is not exhaustive, and
 * `isKnownSuffix` reports whether a given answer came from real knowledge or
 * from the fallback, so callers can be honest about it.
 */

// Second-level suffixes under a ccTLD, e.g. "co" in "example.co.uk".
const CC_SECOND_LEVEL = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'sch', 'nhs',
  'ltd', 'plc', 'me', 'nom', 'gen', 'firm', 'ind', 'res', 'or', 'ne',
  'gr', 'lg', 'in', 'info', 'biz', 'name', 'asn', 'id', 'priv', 'k12',
]);

// ccTLDs that commonly use the second-level structure above.
const CC_TLDS = new Set([
  'uk', 'au', 'nz', 'za', 'jp', 'kr', 'in', 'br', 'mx', 'ar', 'il', 'tr',
  'id', 'my', 'sg', 'th', 'ph', 'vn', 'cn', 'hk', 'tw', 'pk', 'bd', 'lk',
  'ng', 'ke', 'gh', 'tz', 'ug', 'zw', 'zm', 'eg', 'ma', 'pl', 'ua', 'ru',
  'cy', 'mt', 'ee', 'lv', 'gg', 'je', 'im', 'ie', 'es', 'pt', 'it', 'fr',
  'nl', 'be', 'at', 'ch', 'se', 'no', 'fi', 'dk', 'is', 'gr', 'ro', 'bg',
  'hr', 'rs', 'si', 'sk', 'cz', 'hu', 'lt', 'pe', 'cl', 'co', 'uy', 've',
  'ec', 'bo', 'py', 'do', 'gt', 'cr', 'pa', 'ni', 'sv', 'hn', 'cu', 'jm',
  'tt', 'bb', 'bs', 'bz', 'sa', 'ae', 'qa', 'kw', 'bh', 'om', 'jo', 'lb',
]);

// Multi-part suffixes that are not the ccTLD pattern. Hosting platforms are
// the important ones: two GitHub Pages sites are different owners entirely.
const EXPLICIT = new Set([
  'github.io', 'gitlab.io', 'githubusercontent.com',
  'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'netlify.com',
  'herokuapp.com', 'firebaseapp.com', 'web.app', 'appspot.com',
  'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com',
  'elasticbeanstalk.com', 'fly.dev', 'onrender.com', 'railway.app',
  'surge.sh', 'now.sh', 'glitch.me', 'repl.co', 'replit.dev',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'medium.com',
  'substack.com', 'notion.site', 'webflow.io', 'squarespace.com',
  'shopify.com', 'myshopify.com', 'bandcamp.com', 'itch.io',
  'readthedocs.io', 'gitbook.io', 'sourceforge.net',
  'ngrok.io', 'ngrok-free.app', 'localhost',
]);

/**
 * The registrable domain for a hostname — the part someone actually bought.
 *
 * @param {string} hostname
 * @returns {{domain: string, known: boolean}} `known` is false when the answer
 *          came from the two-label fallback rather than a recognised suffix.
 */
function registrableDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const parts = host.split('.').filter(Boolean);

  if (parts.length <= 1) return { domain: host, known: true };

  // Longest explicit suffix wins: s3.amazonaws.com before amazonaws.com.
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (EXPLICIT.has(candidate)) {
      // The registrable domain is one label above the suffix.
      return i === 0
        ? { domain: candidate, known: true }
        : { domain: parts.slice(i - 1).join('.'), known: true };
    }
  }

  const tld = parts[parts.length - 1];
  const second = parts[parts.length - 2];

  if (parts.length >= 3 && CC_TLDS.has(tld) && CC_SECOND_LEVEL.has(second)) {
    return { domain: parts.slice(-3).join('.'), known: true };
  }

  return { domain: parts.slice(-2).join('.'), known: parts.length === 2 };
}

/** Do two hostnames belong to the same registrable domain? */
function sameSite(a, b) {
  return registrableDomain(a).domain === registrableDomain(b).domain;
}

module.exports = { registrableDomain, sameSite };
