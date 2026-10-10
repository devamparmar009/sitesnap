'use strict';

/**
 * HTTP with retries, backoff, adaptive throttling and scoped auth headers.
 *
 * Centralised so every request in the package gets the same behaviour — the
 * crawler and the sitemap reader both go through here.
 *
 * The security-relevant rule lives in `#headersFor`: user-supplied headers are
 * sent ONLY to the origin the crawl started from. A mirror routinely pulls
 * assets from CDNs and third parties, and blindly attaching an Authorization
 * header or session Cookie to those requests would hand your credentials to
 * every host the page happens to reference.
 */

// Transient by nature: worth another go.
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Statuses that mean "we don't like who you claim to be" rather than "try
 * again later".
 *
 * Retrying these *unchanged* is pointless — the same request earns the same
 * answer, which is why they are absent from RETRY_STATUS. Retrying them under
 * a different identity is a different matter entirely: a great many WAFs judge
 * a client from its User-Agent alone, and the crude ones reject shapes rather
 * than names. mapleleaflegalservices.ca refuses any UA containing the token
 * `compatible` — the conventional way for a well-behaved crawler to identify
 * itself — while cheerfully serving one that says `spider`. Honesty is what
 * gets blocked, so there is nothing to be gained by staying on a rung the host
 * has already refused. See `UA_LADDER`.
 */
const BLOCK_STATUS = new Set([403, 406, 409, 418, 451]);

/**
 * Fallback identities, tried in order when a host blocks the one before.
 *
 * Deliberately three *different engines and platforms*, not three versions of
 * Chrome: a rule tuned to reject one vendor's string has no particular reason
 * to reject another's, whereas bumping a version number leaves the shape the
 * host objected to entirely intact.
 */
const UA_LADDER = [
  // Chrome on macOS — the most common client on the web, and so the one least
  // likely to be special-cased by anything.
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  // Firefox on Windows: different engine, different platform, no AppleWebKit.
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
  // Safari, for the hosts that gate on Chrome specifically.
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
];

/** The default: rung zero of the ladder. */
const DEFAULT_UA = UA_LADDER[0];

/** A short human name for a UA string, for log lines. */
function describeUa(ua = '') {
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Version\/[\d.]+ Safari/.test(ua)) return 'Safari';
  return ua.slice(0, 40);
}

/**
 * Client hints, which a real Chrome sends and a spoofed one does not.
 *
 * Sending a Chrome User-Agent with no `sec-ch-ua` is a contradiction any
 * moderately careful WAF can spot, so the hints have to track whichever rung
 * of the ladder is in play — and be absent for the rungs where a real browser
 * would not send them (Firefox and Safari implement no client hints at all).
 */
function clientHintsFor(ua = '') {
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (!chrome) return {};
  const major = chrome[1];
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Not(A:Brand";v="24", "Google Chrome";v="${major}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': /Windows/.test(ua) ? '"Windows"' : /Linux/.test(ua) ? '"Linux"' : '"macOS"',
  };
}

/**
 * The `sec-fetch-*` trio is deliberately NOT sent from here, and that is a
 * correction rather than an omission.
 *
 * They looked like free realism — every browser sends them, few scripts do.
 * But `sec-fetch-mode` is a forbidden header name: undici sets it to `cors`
 * on every request and silently discards any value we supply. The other two
 * pass through untouched. So a "navigation" assembled here goes out as
 *
 *     sec-fetch-dest: document
 *     sec-fetch-mode: cors        <- ours overwritten
 *
 * which is a combination no browser ever emits — a document request is always
 * `mode: navigate`. Sending an internally contradictory set is a *stronger*
 * automation signal than sending none, so the coherent choice is to send none
 * and let the request read as what it honestly is: a script-issued fetch, the
 * exact shape undici's forced `mode: cors` already describes.
 *
 * Sites that genuinely gate on navigation metadata are served by the
 * Playwright path instead, where a real browser produces the real trio.
 */


// fetch() rejects with these when the network misbehaves rather than the server.
const RETRY_ERROR = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network|terminated|fetch failed/i;

/**
 * Should this thrown error be retried?
 *
 * Timeouts belong here and were previously missing, which made `--retries`
 * useless against the single most transient failure there is: a CDN that
 * occasionally stalls for a few seconds turned every slow response into a
 * permanent loss. A user cancellation also surfaces as an abort, so callers
 * must check their own signal *before* consulting this.
 */
function isRetryableError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return RETRY_ERROR.test(err.message || '');
}

const DEFAULTS = {
  retries: 2,
  timeout: 30_000,
  delay: 0,
  maxBackoff: 30_000,
  userAgent: DEFAULT_UA,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Extension-driven Accept headers, matching what a browser sends for each
// kind of subresource. A bare */* is a tell, and some services vary on it.
const ACCEPT_BY_EXT = [
  [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|apng|jxl)(\?|$)/i, 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'],
  [/\.(woff2?|ttf|otf|eot)(\?|$)/i, 'font/woff2,font/woff,*/*;q=0.8'],
  [/\.css(\?|$)/i, 'text/css,*/*;q=0.1'],
  [/\.(m?js|cjs)(\?|$)/i, '*/*'],
  [/\.(mp4|webm|ogv|mov|m4v)(\?|$)/i, 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.5'],
  [/\.(mp3|wav|m4a|aac|flac|opus|oga|ogg)(\?|$)/i, 'audio/webm,audio/ogg,audio/*;q=0.9,*/*;q=0.5'],
  // Model and texture payloads are fetched by JS with fetch()/XHR, and a
  // browser sends `*/*` for those rather than a type-specific Accept.
  [/\.(glb|gltf|bin|hdr|exr|ktx2?|basis|drc|fbx|obj|mtl|usdz|ply|stl|dds|tga|pvr|wasm)(\?|$)/i, '*/*'],
];

function acceptFor(url) {
  const path = `${url.pathname}${url.search}`;
  for (const [re, value] of ACCEPT_BY_EXT) {
    if (re.test(path)) return value;
  }
  return 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
}

/** Parse Retry-After, which is either delta-seconds or an HTTP date. */
function retryAfterMs(value) {
  if (!value) return null;

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && String(seconds) === value.trim()) {
    return Math.max(0, seconds * 1000);
  }

  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

class Fetcher {
  /**
   * @param {object} opts
   * @param {URL} opts.origin           the crawl's starting URL
   * @param {Record<string,string>} [opts.headers]  sent to opts.origin only
   * @param {AbortSignal} [opts.signal]
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.origin = opts.origin || null;
    this.headers = opts.headers || {};
    this.signal = opts.signal;

    // Adaptive throttle: raised when a host pushes back, decayed on success.
    this.extraDelay = 0;

    // How far up UA_LADDER each host has driven us. Per-host and sticky: once
    // a host has rejected an identity there is no reason to offer it again on
    // the next request, and a mirror makes hundreds. Paying one 403 per host
    // rather than one per file is the whole point of remembering.
    this.uaRung = new Map();
    this.#nextSlot = 0;
    this.onNote = opts.onNote || (() => {});

    // Cookies picked up by the browser, keyed by origin. Assets are fetched
    // over plain HTTP for speed, so without these they would arrive as a
    // different, session-less client than the page that referenced them.
    this.sessionCookies = new Map();
  }

  /** Record a Cookie header to send with later requests to this origin. */
  setSessionCookie(origin, cookie) {
    if (origin && cookie) this.sessionCookies.set(origin, cookie);
  }

  #nextSlot = 0;

  /** The identity ladder for this crawl: the configured UA, then the rest. */
  #ladder() {
    const configured = this.opts.userAgent;
    if (!configured) return UA_LADDER.slice();
    return [configured, ...UA_LADDER.filter((ua) => ua !== configured)];
  }

  /** The identity currently in use for this host. */
  uaFor(host) {
    const ladder = this.#ladder();
    const rung = Math.min(this.uaRung.get(host) || 0, ladder.length - 1);
    return ladder[rung];
  }

  /**
   * Move this host one rung up the ladder.
   * @returns {boolean} false once every identity has been refused
   */
  #escalate(host) {
    const next = (this.uaRung.get(host) || 0) + 1;
    if (next >= this.#ladder().length) return false;
    this.uaRung.set(host, next);
    return true;
  }

  /**
   * Is this a rejection of who we say we are, rather than of what we asked
   * for? A 401 carrying `WWW-Authenticate` is a genuine auth challenge and no
   * User-Agent will satisfy it, so it is excluded — changing identity there
   * would burn the ladder on a host that simply wants a password.
   */
  #isIdentityBlock(res) {
    if (res.status === 401) return !res.headers.get('www-authenticate');
    return BLOCK_STATUS.has(res.status);
  }

  /** Headers for this URL. Credentials never leave the starting origin. */
  #headersFor(url, init = {}) {
    const ua = this.uaFor(url.host);

    const base = {
      'user-agent': ua,
      // A type-appropriate Accept, as a browser sends. Some asset services
      // vary or refuse on a bare */*.
      accept: acceptFor(url),
      'accept-language': 'en-US,en;q=0.9',
      // Client hints, which track whichever rung of the ladder is in play.
      // A Chrome User-Agent with no `sec-ch-ua` is a contradiction a careful
      // WAF can spot, and Firefox and Safari implement no client hints at all
      // — so these are emitted for the Chrome rungs and omitted for the rest.
      // See the note above fetchMetadata's removal for the headers we
      // deliberately do NOT try to send.
      ...clientHintsFor(ua),
    };

    // Referer, when we are fetching a subresource because some page linked
    // it. This is simply true — that page is why we are asking — and hotlink
    // protection on fonts and images commonly requires it. Apple's font
    // endpoint, for one, answers 403 without it and 200 with it.
    if (init.referer) base.referer = init.referer;

    // A session cookie belongs to the origin that issued it, so this is
    // keyed per-origin rather than shared — the same rule that keeps
    // user-supplied credentials from leaking to third-party hosts.
    const session = this.sessionCookies.get(url.origin);
    const withSession = session ? { ...base, cookie: session } : base;

    const sameOrigin = this.origin && url.origin === this.origin.origin;
    if (!sameOrigin) return withSession;

    // An explicit --cookie/-H from the user outranks a browser-picked one.
    return { ...withSession, ...this.headers };
  }

  /**
   * Serialise the wait so N workers share one rate limit rather than each
   * sleeping independently (which would multiply the real request rate by N).
   */
  async #pace() {
    const wait = this.opts.delay + this.extraDelay;
    if (wait <= 0) return;

    const now = Date.now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + wait;
    if (slot > now) await sleep(slot - now);
  }

  #backoff(attempt) {
    // Exponential with full jitter — synchronised retries from parallel
    // workers would otherwise arrive as a burst and be throttled again.
    const ceiling = Math.min(this.opts.maxBackoff, 500 * 2 ** attempt);
    return Math.random() * ceiling;
  }

  /**
   * Fetch with retries.
   *
   * @param {URL|string} target
   * @param {object} [init]  extra fetch init (e.g. conditional headers)
   * @returns {Promise<Response>}
   * @throws on network failure or exhausted retries
   */
  async fetch(target, init = {}) {
    const url = typeof target === 'string' ? new URL(target) : target;
    const attempts = this.opts.retries + 1;
    let lastError = null;

    // Two independent budgets. `attempt` counts genuine retries of the same
    // request. Climbing the identity ladder is not one of those — it is a
    // materially different request, and charging it a retry would mean a host
    // that refuses the first two rungs exhausts --retries before the third is
    // ever offered. `ladderBudget` bounds that separately; neither can spin.
    let attempt = 0;
    let ladderBudget = this.#ladder().length;

    while (attempt < attempts) {
      if (this.signal && this.signal.aborted) throw new Error('cancelled');
      await this.#pace();

      // A deadline we own and can reset, rather than a fixed
      // AbortSignal.timeout(). A plain timeout bounds the WHOLE
      // request — connect, then every byte of the body — as one fixed
      // wall-clock window, so a large file on a slow-but-healthy connection
      // gets killed for the same reason a truly dead one would: it simply
      // took longer than `timeout` in total. Resetting on activity means the
      // deadline only ever fires on genuine inactivity, which is the failure
      // this option is actually meant to catch.
      const deadline = new AbortController();
      const expire = () =>
        deadline.abort(new DOMException('The operation was aborted due to inactivity', 'TimeoutError'));
      let timer = setTimeout(expire, this.opts.timeout);
      const bump = () => {
        clearTimeout(timer);
        timer = setTimeout(expire, this.opts.timeout);
      };
      const cleanup = () => clearTimeout(timer);

      const signal = this.signal
        ? AbortSignal.any([this.signal, deadline.signal])
        : deadline.signal;

      let res;
      try {
        const { referer, ...fetchInit } = init;
        res = await fetch(url.href, {
          ...fetchInit,
          headers: { ...this.#headersFor(url, { referer }), ...(init.headers || {}) },
          redirect: 'follow',
          signal,
        });
      } catch (err) {
        cleanup();
        // A user cancel must not be retried as though it were a blip.
        if (this.signal && this.signal.aborted) throw new Error('cancelled');

        lastError = err;
        // The user-cancel check above has already run, so anything reaching
        // here is a genuine failure rather than a deliberate stop.
        if (attempt < attempts - 1 && isRetryableError(err)) {
          await sleep(this.#backoff(attempt));
          attempt++;
          continue;
        }
        throw err;
      }

      if (res.ok) {
        // Ease off the throttle once the host is happy again.
        if (this.extraDelay > 0) this.extraDelay = Math.floor(this.extraDelay / 2);
        // The caller streams the body after this returns, so the deadline
        // must stay alive — expose bump()/cleanup() rather than clearing it
        // here. Every consumer of a streamed body MUST call one of these.
        res.bumpDeadline = bump;
        res.clearDeadline = cleanup;
        return res;
      }

      cleanup();

      // A rejection of who we are, not of what we asked for. The identical
      // request under a different name is very often served, so climb the
      // ladder and go again — charging this to `ladderBudget`, not `attempt`.
      if (this.#isIdentityBlock(res) && ladderBudget > 0 && this.#escalate(url.host)) {
        ladderBudget--;
        // Nothing will read this body; releasing it keeps the connection
        // reusable instead of leaving it pinned until GC.
        res.body?.cancel?.().catch(() => {});
        this.onNote(
          `HTTP ${res.status} from ${url.host} — host refuses this client, ` +
            `retrying as ${describeUa(this.uaFor(url.host))}`
        );
        continue;
      }

      if (!RETRY_STATUS.has(res.status) || attempt === attempts - 1) return res;

      // 429/503 mean "slow down", not just "try again" — raise the floor for
      // every subsequent request, not only this one.
      if (res.status === 429 || res.status === 503) {
        this.extraDelay = Math.min(5000, Math.max(500, this.extraDelay * 2 || 500));
        this.onNote(
          `${res.status} from ${url.host} — throttling to ${this.opts.delay + this.extraDelay}ms between requests`
        );
      }

      const hinted = retryAfterMs(res.headers.get('retry-after'));
      await sleep(hinted !== null ? Math.min(hinted, this.opts.maxBackoff) : this.#backoff(attempt));
      attempt++;
    }

    throw lastError || new Error('request failed');
  }
}

module.exports = {
  Fetcher,
  retryAfterMs,
  isRetryableError,
  RETRY_STATUS,
  BLOCK_STATUS,
  UA_LADDER,
  DEFAULT_UA,
  describeUa,
};
