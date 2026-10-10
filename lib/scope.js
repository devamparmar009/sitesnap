'use strict';

/**
 * URL normalization and crawl-scope rules.
 *
 * "Scope" answers one question: should the crawler follow this link as a page?
 * Assets (images, css, js) use a looser rule — they are fetched wherever they
 * live, because a page missing its stylesheet is not a usable mirror.
 */

const dns = require('dns').promises;
const net = require('net');

const FETCHABLE_PROTOCOLS = new Set(['http:', 'https:']);

// Non-navigational schemes that legitimately appear in href/src attributes.
const SKIP_SCHEMES = /^(data|mailto|javascript|tel|sms|blob|about|#):/i;

/**
 * Parse and normalize a URL for use as a crawl identity.
 *
 * Normalizing matters: `/a`, `/a#top` and `/a#bottom` are one document, and
 * crawling them as three would triple the work and write the file three times.
 *
 * @returns {URL|null} null if unparseable or not http(s)
 */
function normalize(input, base) {
  let url;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }

  if (!FETCHABLE_PROTOCOLS.has(url.protocol)) return null;

  // Fragments are client-side only; they never produce a distinct response.
  url.hash = '';

  // Strip the default port so http://x/ and http://x:80/ are one identity.
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  url.hostname = url.hostname.toLowerCase();
  if (!url.pathname) url.pathname = '/';

  return url;
}

function shouldSkipReference(raw) {
  if (!raw) return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('#')) return true;
  return SKIP_SCHEMES.test(trimmed);
}

const { registrableDomain } = require('./publicsuffix');

function registrableSuffix(hostname) {
  return registrableDomain(hostname).domain;
}

/**
 * Decide whether a URL is in scope as a *page* to crawl.
 *
 * @param {URL} url        candidate
 * @param {URL} origin     the crawl's starting URL
 * @param {object} opts
 * @param {boolean} opts.includeSubdomains  follow blog.example.com from example.com
 * @param {boolean} opts.noParent           stay at or below the start path
 */
function inPageScope(url, origin, opts = {}) {
  const sameHost = opts.includeSubdomains
    ? registrableSuffix(url.hostname) === registrableSuffix(origin.hostname)
    : url.hostname === origin.hostname;

  if (!sameHost) return false;
  if (url.protocol !== origin.protocol && !opts.allowProtocolChange) {
    // Following http -> https on the same host is normal and desirable.
    const upgrade = origin.protocol === 'http:' && url.protocol === 'https:';
    if (!upgrade) return false;
  }

  if (opts.noParent) {
    const baseDir = origin.pathname.endsWith('/')
      ? origin.pathname
      : origin.pathname.replace(/[^/]*$/, '');
    if (!url.pathname.startsWith(baseDir)) return false;
  }

  return true;
}

const PRIVATE_V4 = [
  [/^10\./, '10.0.0.0/8'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local / cloud metadata'],
  [/^192\.168\./, '192.168.0.0/16'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16.0.0/12'],
  [/^0\./, 'this-network'],
];

function classifyIp(ip) {
  if (net.isIPv4(ip)) {
    for (const [re, label] of PRIVATE_V4) if (re.test(ip)) return label;
    return null;
  }
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return 'loopback';
    if (v6.startsWith('fe80:')) return 'link-local';
    if (/^f[cd]/.test(v6)) return 'unique-local';
    // IPv4-mapped (::ffff:10.0.0.1)
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyIp(mapped[1]);
    return null;
  }
  return null;
}

/**
 * Reject URLs pointing at private/loopback/metadata addresses.
 *
 * Off by default: this tool's normal home is localhost, and mirroring your own
 * dev server is a real use case. Turn it on (--block-private) whenever the
 * server is reachable by anyone but you, so a submitted URL cannot be used to
 * read internal services or cloud metadata.
 *
 * @returns {Promise<string|null>} reason string if blocked, else null
 */
async function privateAddressReason(url) {
  const host = url.hostname;

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return 'loopback hostname';
  }

  const literal = classifyIp(host.replace(/^\[|\]$/g, ''));
  if (literal) return literal;

  if (net.isIP(host)) return null; // public literal IP, no lookup needed

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    return 'hostname does not resolve';
  }

  for (const { address } of records) {
    const label = classifyIp(address);
    if (label) return `${host} resolves to ${address} (${label})`;
  }
  return null;
}

module.exports = {
  normalize,
  inPageScope,
  shouldSkipReference,
  privateAddressReason,
  classifyIp,
  FETCHABLE_PROTOCOLS,
};
