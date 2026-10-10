'use strict';

/**
 * sitemap.xml discovery and parsing.
 *
 * A sitemap is the site telling you its own URL list. Using it beats crawling
 * for precision: you get pages that are linked from nowhere obvious, you skip
 * pagination and tag-archive sprawl, and you don't have to guess a depth.
 *
 * Handles the three forms that actually appear in the wild:
 *   - <urlset>      a plain list of pages
 *   - <sitemapindex> a list of further sitemaps (recursed, depth-capped)
 *   - .xml.gz        gzipped, which large sites use routinely
 */

const zlib = require('zlib');
const { promisify } = require('util');
const cheerio = require('cheerio');

const gunzip = promisify(zlib.gunzip);

const GZIP_MAGIC = [0x1f, 0x8b];
const MAX_INDEX_DEPTH = 3;
const MAX_SITEMAP_BYTES = 32 * 1024 * 1024;

/** Decompress if these bytes are gzip, regardless of what the server claimed. */
async function maybeGunzip(buf) {
  if (buf.length > 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) {
    return gunzip(buf);
  }
  return buf;
}

/**
 * Parse sitemap XML.
 * @returns {{urls: string[], sitemaps: string[]}}
 */
function parse(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });

  const sitemaps = [];
  $('sitemapindex > sitemap > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) sitemaps.push(loc);
  });

  const urls = [];
  $('urlset > url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) urls.push(loc);
  });

  // Some sitemaps omit the namespace or nest oddly; if the strict selectors
  // found nothing, fall back to any <loc> and let the caller's scope rules
  // sort it out.
  if (!urls.length && !sitemaps.length) {
    $('loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) urls.push(loc);
    });
  }

  return { urls, sitemaps };
}

/**
 * Fetch and fully expand a set of sitemap URLs.
 *
 * @param {string[]} seeds       sitemap URLs to start from
 * @param {object} opts
 * @param {number} opts.limit    stop after this many *accepted* page URLs
 * @param {(url: string) => boolean} [opts.accept]  filter applied during the
 *        walk, so `limit` counts only URLs you actually want. Filtering after
 *        truncation instead would make a narrow --include over a large sitemap
 *        come back empty for no visible reason.
 * @param {{fetch: Function}} [opts.fetcher]  retrying fetcher; plain fetch otherwise
 * @param {string} opts.userAgent
 * @param {AbortSignal} opts.signal
 * @param {(msg: string) => void} [opts.onNote]
 * @returns {Promise<string[]>}  page URLs, deduplicated, in document order
 */
async function collect(seeds, opts = {}) {
  const { limit = 5000, userAgent, signal, onNote, accept, fetcher } = opts;
  const doFetch = fetcher
    ? (url, init) => fetcher.fetch(url, init)
    : (url, init) => fetch(url, init);

  const seenSitemaps = new Set();
  const found = [];
  const seenUrls = new Set();

  async function walk(sitemapUrl, depth) {
    if (depth > MAX_INDEX_DEPTH) return;
    if (found.length >= limit) return;
    if (seenSitemaps.has(sitemapUrl)) return;
    seenSitemaps.add(sitemapUrl);

    let res;
    try {
      res = await doFetch(sitemapUrl, {
        headers: { 'user-agent': userAgent, accept: 'application/xml,text/xml,*/*' },
        signal,
      });
    } catch (err) {
      if (onNote) onNote(`sitemap unreachable: ${sitemapUrl}`);
      return;
    }

    if (!res.ok) {
      if (onNote) onNote(`sitemap ${res.status}: ${sitemapUrl}`);
      return;
    }

    let buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_SITEMAP_BYTES) {
      if (onNote) onNote(`sitemap too large, skipped: ${sitemapUrl}`);
      return;
    }

    try {
      buf = await maybeGunzip(buf);
    } catch {
      if (onNote) onNote(`sitemap could not be decompressed: ${sitemapUrl}`);
      return;
    }

    let parsed;
    try {
      parsed = parse(buf.toString('utf8'));
    } catch {
      if (onNote) onNote(`sitemap could not be parsed: ${sitemapUrl}`);
      return;
    }

    for (const url of parsed.urls) {
      if (found.length >= limit) break;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      // Filter here, not after the cap, so `limit` bounds useful results.
      if (accept && !accept(url)) continue;
      found.push(url);
    }

    for (const nested of parsed.sitemaps) {
      if (found.length >= limit) break;
      await walk(nested, depth + 1);
    }
  }

  for (const seed of seeds) {
    if (found.length >= limit) break;
    await walk(seed, 0);
  }

  return found;
}

/**
 * Where to look for sitemaps: whatever robots.txt advertises, plus the
 * conventional location as a fallback.
 */
function candidates(origin, robots) {
  const list = [];
  if (robots && Array.isArray(robots.sitemaps)) list.push(...robots.sitemaps);

  const fallback = new URL('/sitemap.xml', origin).href;
  if (!list.includes(fallback)) list.push(fallback);
  return list;
}

module.exports = { collect, parse, candidates, maybeGunzip };
