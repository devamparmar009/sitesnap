'use strict';

/**
 * A quick look at a site before committing to a full download.
 *
 * Someone pasting an address wants to know three things before they press
 * the button: is this the site I meant, roughly how big is it, and will it
 * work? Answering those up front turns the most common failures (a typo, a
 * site that needs JavaScript, a page behind a login) into a sentence on the
 * screen instead of a crawl that runs for a minute and then explains itself.
 *
 * This makes a handful of requests: the page itself, robots.txt, the sitemap
 * if there is one, and the icon and preview image. It uses the same Fetcher as
 * the crawl, so it identifies itself the same way and honours the same rules.
 */

const cheerio = require('cheerio');
const { Fetcher } = require('./fetcher');
const { normalize, inPageScope, shouldSkipReference, privateAddressReason } = require('./scope');
const { extractHtml } = require('./extract');
const { decodeText, detectChallenge } = require('./decode');
const robotsLib = require('./robots');
const sitemapLib = require('./sitemap');
const { explainNetwork, explainStatus, explainFailure } = require('./friendly');

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SITEMAP_LIMIT = 5000;
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|signin|auth|sso|session|account\/login)(\/|$|\?)/i;

/**
 * Accept what a person types: "example.com", "www.example.com/docs",
 * " https://Example.com ". Returns a URL or null.
 */
function parseAddress(raw) {
  const text = String(raw || '').trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const url = normalize(withScheme);
  if (!url) return null;
  // A bare word ("hello") parses as a hostname. Require a dot, or an explicit
  // localhost, so a typo gets a helpful message instead of a DNS failure.
  if (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('[')) {
    return null;
  }
  return url;
}

async function readCapped(res, cap) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Fetch a small image and return it as a data: URL, or null. */
async function imageAsDataUrl(fetcher, url, cap, referer) {
  try {
    const res = await fetcher.fetch(url, { referer });
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      res.clearDeadline?.();
      return null;
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const bytes = await readCapped(res, cap);
    res.clearDeadline?.();
    if (!bytes || !bytes.length) return null;
    const mime = type.startsWith('image/') ? type : sniffImage(bytes);
    if (!mime) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function sniffImage(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01) return 'image/x-icon';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^\s*(<\?xml|<svg)/i.test(b.slice(0, 200).toString())) return 'image/svg+xml';
  return null;
}

/**
 * Does this page build itself with JavaScript? Judged on what the server
 * sent: if the visible text is almost nothing but there are scripts, the real
 * page arrives later, and only a browser will see it.
 */
function looksScriptBuilt($) {
  const scripts = $('script[src], script[type="module"]').length;
  const body = $('body').clone();
  body.find('script, style, noscript, template, svg').remove();
  const text = body.text().replace(/\s+/g, ' ').trim();

  const mount = $('#root, #app, #__next, #___gatsby, #svelte, app-root, [data-reactroot]').first();
  const emptyMount = mount.length > 0 && mount.text().trim().length < 40;
  const noscript = /enable javascript|requires javascript|need to enable/i.test($('noscript').text());

  // A short page is not a script-built one: example.com is three sentences
  // and one script. The shell of a client-rendered app has next to no text.
  if (emptyMount && text.length < 600) return true;
  if (scripts > 0 && text.length < 60) return true;
  return noscript && text.length < 400;
}

function pickIcon($, base) {
  const candidates = [];
  $('link[rel]').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase();
    const href = $(el).attr('href');
    if (!href || !/(^|\s)(icon|apple-touch-icon|shortcut icon|mask-icon)(\s|$)/.test(rel)) return;
    const sizes = String($(el).attr('sizes') || '');
    const size = Number((/(\d+)x\d+/.exec(sizes) || [])[1]) || (rel.includes('apple-touch') ? 180 : 32);
    // Bigger is better up to a point; a mask icon is monochrome, so last.
    const score = rel.includes('mask-icon') ? -1 : Math.min(size, 256);
    candidates.push({ href, score });
  });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ? normalize(candidates[0].href, base) : null;
  return best || normalize('/favicon.ico', base);
}

function meta($, ...names) {
  for (const name of names) {
    const value =
      $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
    if (value && value.trim()) return value.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * @param {string} raw  what the person typed
 * @param {object} [opts]
 * @param {string} [opts.userAgent]
 * @param {Record<string,string>} [opts.headers]  sent to the site's own origin only
 * @param {boolean} [opts.blockPrivate]
 * @param {number} [opts.timeout]  overall budget in ms
 * @returns {Promise<object>} `{ ok: true, ... }` or `{ ok: false, error }`
 */
async function inspect(raw, opts = {}) {
  const start = parseAddress(raw);
  if (!start) {
    return {
      ok: false,
      error: {
        kind: 'invalid',
        title: 'That doesn’t look like a web address.',
        message: 'Paste the address from your browser’s address bar, something like example.com or https://example.com/blog.',
        action: null,
        actionLabel: null,
        detail: String(raw || ''),
      },
    };
  }

  if (opts.blockPrivate) {
    const reason = await privateAddressReason(start);
    if (reason) {
      return { ok: false, error: explainFailure({ url: start.href, message: `Refusing to crawl ${start.hostname}: ${reason}` }) };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 20_000);

  const fetcher = new Fetcher({
    origin: start,
    headers: opts.headers || {},
    userAgent: opts.userAgent,
    retries: 1,
    timeout: 12_000,
    signal: controller.signal,
  });

  try {
    let res;
    try {
      res = await fetcher.fetch(start);
    } catch (err) {
      const code = err?.cause?.code || err?.code;
      const detail = err?.cause?.message || err?.message || '';
      const error =
        explainNetwork(code, start.hostname, detail) ||
        explainFailure({ url: start.href, message: detail, code });
      return { ok: false, error };
    }

    const finalUrl = normalize(res.url) || start;
    const body = await readCapped(res, MAX_PAGE_BYTES);
    res.clearDeadline?.();
    const html = body ? decodeText(body, res.headers.get('content-type') || '').text : '';

    if (!res.ok) {
      const { isChallenge } = detectChallenge(res.status, res.headers, html.slice(0, 4096));
      if (isChallenge) {
        return {
          ok: false,
          error: explainFailure({ url: start.href, message: `HTTP ${res.status}`, stats: { blocked: 1 } }),
        };
      }
      const error =
        explainStatus(res.status, start.hostname, `HTTP ${res.status} from ${finalUrl.href}`) ||
        explainFailure({ url: start.href, message: `HTTP ${res.status}` });
      return { ok: false, error, status: res.status };
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !/html|xml/.test(type)) {
      // A direct link to a PDF or an image: a "site" of one file. Still fine
      // to download; there is just nothing to preview.
      return {
        ok: true,
        url: start.href,
        finalUrl: finalUrl.href,
        host: finalUrl.hostname,
        title: decodeURIComponent(finalUrl.pathname.split('/').pop() || finalUrl.hostname),
        description: null,
        siteName: finalUrl.hostname,
        icon: null,
        image: null,
        singleFile: true,
        needsJs: false,
        login: false,
        robotsBlocksStart: false,
        sitemap: { found: false, count: 0, capped: false },
        links: 0,
        siteLinks: 0,
      };
    }

    const $ = cheerio.load(html);
    const title = meta($, 'og:title', 'twitter:title') || $('title').first().text().replace(/\s+/g, ' ').trim() || null;
    const siteName = meta($, 'og:site_name', 'application-name', 'apple-mobile-web-app-title');
    const description = meta($, 'description', 'og:description', 'twitter:description');

    const iconUrl = pickIcon($, finalUrl);
    const imageRaw = meta($, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
    const imageUrl = imageRaw ? normalize(imageRaw, finalUrl) : null;

    // Links on this page that a crawl would follow, as a floor for the size.
    const { pages } = extractHtml(html);
    const scopeOpts = { noParent: true, includeSubdomains: false };
    const linkSet = new Set();
    const siteLinkSet = new Set();
    for (const href of pages) {
      if (shouldSkipReference(href)) continue;
      const abs = normalize(href, finalUrl);
      if (!abs || abs.href === finalUrl.href) continue;
      if (inPageScope(abs, finalUrl, { noParent: false })) siteLinkSet.add(abs.href);
      if (inPageScope(abs, finalUrl, scopeOpts)) linkSet.add(abs.href);
    }

    const passwordForm = $('input[type="password"]').length > 0;
    const redirectedToLogin =
      finalUrl.pathname !== start.pathname && LOGIN_PATH.test(finalUrl.pathname + finalUrl.search);

    const robots = await robotsLib.load(finalUrl.origin, {
      userAgent: fetcher.uaFor(finalUrl.host),
      signal: controller.signal,
    });

    let sitemapUrls = [];
    try {
      sitemapUrls = await sitemapLib.collect(sitemapLib.candidates(finalUrl.origin, robots), {
        limit: SITEMAP_LIMIT,
        fetcher,
        signal: controller.signal,
        accept: (u) => {
          const abs = normalize(u);
          return Boolean(abs && inPageScope(abs, finalUrl, scopeOpts));
        },
      });
    } catch {
      sitemapUrls = [];
    }

    const [icon, image] = await Promise.all([
      iconUrl ? imageAsDataUrl(fetcher, iconUrl, MAX_ICON_BYTES, finalUrl.href) : null,
      imageUrl ? imageAsDataUrl(fetcher, imageUrl, MAX_IMAGE_BYTES, finalUrl.href) : null,
    ]);

    return {
      ok: true,
      url: start.href,
      finalUrl: finalUrl.href,
      host: finalUrl.hostname,
      title,
      siteName,
      description: description ? description.slice(0, 280) : null,
      icon,
      image,
      singleFile: false,
      needsJs: looksScriptBuilt($),
      login: redirectedToLogin || (passwordForm && linkSet.size < 8),
      robotsBlocksStart: !robotsLib.isAllowed(robots, finalUrl.pathname),
      sitemap: {
        found: sitemapUrls.length > 0,
        count: sitemapUrls.length,
        capped: sitemapUrls.length >= SITEMAP_LIMIT,
      },
      links: linkSet.size,
      siteLinks: siteLinkSet.size,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: explainNetwork('ETIMEDOUT', start.hostname, 'the check took longer than 20 seconds'),
      };
    }
    return { ok: false, error: explainFailure({ url: start.href, message: err.message }) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { inspect, parseAddress, looksScriptBuilt, sniffImage };
