'use strict';

/**
 * Optional JavaScript rendering via Playwright.
 *
 * Without this, a client-rendered app mirrors as an empty shell: the HTML the
 * server sends is a `<div id="root">` and the content arrives later from JS we
 * never run. Rendering fixes that by driving a real browser and taking the DOM
 * after it settles.
 *
 * Playwright is an OPTIONAL dependency on purpose. It pulls a ~150MB browser,
 * which is an absurd cost for the common case of mirroring a static site, so
 * the core package does not require it and this module loads it lazily. If it
 * isn't installed, `--render` fails with instructions rather than the package
 * being uninstallable for everyone else.
 */

let playwright = null;
let loadError = null;

function tryLoad() {
  if (playwright) return playwright;
  // Not cached on failure: the app can install the engine while running
  // (see ./engine), and the next crawl must find it without a restart.
  // eslint-disable-next-line global-require
  playwright = require('./engine').loadPlaywright({ fresh: true });
  loadError = playwright ? null : new Error('Playwright is not installed');
  return playwright;
}

function isAvailable() {
  return Boolean(tryLoad());
}

const INSTALL_HINT =
  'JavaScript rendering needs Playwright, which is not installed.\n' +
  '  npm install playwright && npx playwright install chromium\n' +
  'Omit --render to mirror the server-sent HTML instead.';

/**
 * A reusable browser. One instance serves the whole crawl — launching Chromium
 * per page would cost more than the rendering saves.
 */
class Renderer {
  constructor(opts = {}) {
    this.opts = {
      timeout: 30_000,
      // `domcontentloaded`, deliberately, NOT `networkidle`.
      //
      // networkidle waits for the network to fall silent, and on a large part
      // of the real web it never does: analytics beacons, chat widgets, ad
      // refreshes, polling and websockets all keep it busy forever. The page
      // is fully rendered in milliseconds and we would still sit there until
      // the timeout, then throw the finished DOM away. Readiness is decided
      // by watching the DOM stop changing instead — see #settle().
      waitUntil: 'domcontentloaded',
      // How long to let JS keep mutating the DOM after load, and how much
      // quiet is enough to call it done.
      settleTimeout: 5_000,
      settleQuietMs: 400,
      // Never conclude a page is finished before this much has elapsed — a
      // page still showing `loading…` is stable, and would otherwise be
      // captured as the spinner.
      settleMinMs: 1_200,
      // Scroll the page to trigger lazy-loaded images and content.
      autoScroll: false,
      // Keep the bytes of every subresource the browser fetched — see #harvest.
      harvest: true,
      harvestMaxFileBytes: 25 * 1024 * 1024,
      harvestMaxBytes: 250 * 1024 * 1024,
      harvestMaxFiles: 2000,
      userAgent: undefined,
      headers: {},
      origin: null,
      ...opts,
    };
    this.browser = null;
    this.context = null;
    this.pages = 0;
  }

  async start() {
    const pw = tryLoad();
    if (!pw) throw new Error(INSTALL_HINT);

    this.browser = await pw.chromium.launch({ headless: true });
    await this.#openContext();
  }

  /**
   * Build the browsing context. Separated from start() because the User-Agent
   * is fixed at context creation and may need to change mid-crawl — see
   * setUserAgent.
   */
  async #openContext() {
    this.context = await this.browser.newContext({
      // `undefined` means "whatever Chromium says", which is a real Chrome UA
      // and a perfectly good answer.
      userAgent: this.opts.userAgent,
      // Deterministic viewport so responsive sites render their desktop layout.
      viewport: { width: 1366, height: 900 },
      // Stated rather than inherited from the host, so a mirror taken on a
      // machine in one locale matches one taken anywhere else. Sites that vary
      // by locale would otherwise produce a different capture per machine.
      locale: 'en-US',
      timezoneId: 'America/Toronto',
      // Ask for uncompressed-friendly, real-browser defaults; Chromium fills
      // in the rest of the header set itself.
      extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });

    // Same rule as the fetcher: credentials never leave the starting origin.
    if (this.opts.origin && Object.keys(this.opts.headers).length) {
      await this.context.route('**/*', async (route, request) => {
        const sameOrigin = new URL(request.url()).origin === this.opts.origin.origin;
        if (!sameOrigin) return route.continue();
        return route.continue({
          headers: { ...request.headers(), ...this.opts.headers },
        });
      });
    }
  }

  /**
   * Adopt a different User-Agent for subsequent navigations.
   *
   * Playwright fixes the UA when the context is created, so changing it means
   * replacing the context. That is the point: when a host refuses the browser
   * too, the fetcher has already worked out which identity that host *does*
   * accept, and the browser should not keep presenting the rejected one. Any
   * cookies collected so far are discarded with the old context, which is
   * correct — they were issued to a client the host has since refused.
   */
  async setUserAgent(userAgent) {
    if (userAgent === this.opts.userAgent) return false;
    this.opts.userAgent = userAgent;
    if (!this.browser) return false;
    const old = this.context;
    await this.#openContext();
    await old?.close().catch(() => {});
    return true;
  }

  /**
   * Wait until the page looks finished.
   *
   * "The DOM stopped changing" alone is ambiguous: a page showing `loading…`
   * is perfectly stable, and returning then captures the spinner instead of
   * the content. So three signals have to agree before we call it done —
   *
   *   - the rendered DOM size has held steady for `settleQuietMs`
   *   - no requests are currently in flight
   *   - at least `settleMinMs` has passed, so a page that has not yet begun
   *     rendering is never mistaken for one that has finished
   *
   * and the whole thing is capped at `settleTimeout` so a site that never
   * goes quiet still returns promptly. Network counting is what catches the
   * common real case: content that arrives from a fetch/XHR after a pause.
   */
  /**
   * Start counting in-flight requests.
   *
   * MUST be attached before `goto`, not inside #settle. A page that kicks off
   * its data fetch during load has already fired `request` by the time
   * navigation resolves, so a listener added afterwards sees a count of zero
   * and concludes the page is idle while it is in fact still loading.
   */
  #trackRequests(page) {
    const state = { inFlight: 0 };
    const onRequest = () => { state.inFlight++; };
    const onDone = () => { state.inFlight = Math.max(0, state.inFlight - 1); };

    page.on('request', onRequest);
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);

    state.detach = () => {
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    };
    return state;
  }

  /**
   * Keep the bytes of everything the browser fetched while rendering.
   *
   * This is the single highest-value thing the renderer can do, and not doing
   * it was the root cause of mirrors that render as a blank "Application
   * error". The browser resolves what a modern app needs *by running it*:
   * hydration chunks, dynamically imported modules, fonts a stylesheet only
   * asks for once a rule matches, images chosen by srcset at the current DPR,
   * JSON an effect fetches after mount. Chromium downloaded every one of them
   * successfully — and then we threw them away and re-derived the asset list by
   * re-parsing the HTML we had just serialized, which cannot name any of them.
   *
   * Harvesting inverts that: instead of predicting what a bundle will ask for,
   * record what it did ask for. It needs no per-framework knowledge, so it
   * works on Next, Nuxt, SvelteKit, Astro, Vite and hand-rolled bundles alike.
   *
   * Bodies are read eagerly rather than after the load finishes. Playwright can
   * only return a body while its page is alive, and a response buffer may be
   * discarded once the renderer moves on — deferring the read is how you get an
   * empty file with no error to explain it.
   *
   * Documents are deliberately skipped: the main page and any iframe already
   * travel the crawler's own page path, which applies scope, robots and depth
   * rules that a harvest must not be able to bypass.
   */
  #harvest(page) {
    const results = new Map();
    const claimed = new Set();
    const pending = [];
    const state = { bytes: 0, truncated: false };

    const onResponse = (response) => {
      if (!this.opts.harvest) return;

      let url;
      try {
        url = response.url();
      } catch {
        return;
      }
      if (!/^https?:/i.test(url)) return; // data:, blob:, about:
      if (claimed.has(url)) return;

      const status = response.status();
      // Redirects carry no body of their own, and an error page is not the
      // asset it stands in for — saving one would mask the failure behind a
      // file that exists and is wrong.
      if (status < 200 || status >= 300) return;

      let resourceType = '';
      try {
        resourceType = response.request().resourceType();
      } catch {
        /* request may already be gone */
      }
      if (resourceType === 'document') return;

      if (claimed.size >= this.opts.harvestMaxFiles) {
        state.truncated = true;
        return;
      }
      claimed.add(url);

      pending.push(
        response
          .body()
          .then((body) => {
            if (!body || !body.length) return;
            if (body.length > this.opts.harvestMaxFileBytes) return;
            if (state.bytes + body.length > this.opts.harvestMaxBytes) {
              state.truncated = true;
              return;
            }
            state.bytes += body.length;

            let headers = {};
            try {
              headers = response.headers();
            } catch {
              /* best effort */
            }
            results.set(url, {
              url,
              status,
              body,
              contentType: headers['content-type'] || '',
              etag: headers.etag || null,
              lastModified: headers['last-modified'] || null,
              resourceType,
            });
          })
          .catch(() => {
            // A body can be unavailable for reasons that are not faults: served
            // from cache, aborted mid-flight, or a preflight. The asset list
            // from static parsing still covers those, so a miss here is a
            // missed optimisation rather than a broken mirror.
          })
      );
    };

    page.on('response', onResponse);

    return {
      detach: () => page.off('response', onResponse),
      /** Await every in-flight body read and return what was captured. */
      collect: async () => {
        // Settled, not all: one rejected read must not discard the other 300.
        await Promise.allSettled(pending);
        return { entries: [...results.values()], bytes: state.bytes, truncated: state.truncated };
      },
    };
  }

  async #settle(page, tracker) {
    const started = Date.now();
    const deadline = started + this.opts.settleTimeout;

    let lastSize = -1;
    let steadySince = Date.now();

    while (Date.now() < deadline) {
      let size;
      try {
        size = await page.evaluate(() => document.documentElement.innerHTML.length);
      } catch {
        return; // navigated away or closed — nothing more to wait for
      }

      if (size !== lastSize) {
        lastSize = size;
        steadySince = Date.now();
      }

      const quietLongEnough = Date.now() - steadySince >= this.opts.settleQuietMs;
      const pastFloor = Date.now() - started >= this.opts.settleMinMs;
      const idle = !tracker || tracker.inFlight === 0;

      if (quietLongEnough && pastFloor && idle) return;

      await page.waitForTimeout(100).catch(() => {});
    }
  }

  /**
   * Scroll to the bottom to trigger lazy-loaded content, then return to the
   * top. Plenty of sites only request their images once they approach the
   * viewport, so a mirror taken without scrolling is missing them entirely.
   */
  async #autoScroll(page, tracker) {
    try {
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let scrolled = 0;
          const step = 600;
          const timer = setInterval(() => {
            const before = window.scrollY;
            window.scrollBy(0, step);
            scrolled += step;
            // Stop at the bottom, if scrolling stops having any effect, or at
            // a hard cap so an infinite-scroll feed cannot run forever.
            if (
              scrolled >= document.body.scrollHeight ||
              window.scrollY === before ||
              scrolled > 40000
            ) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      });
      await this.#settle(page, tracker);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    } catch {
      // Scrolling is best-effort; never fail a page over it.
    }
  }

  /**
   * Load a page and return its settled HTML, tolerating a slow site.
   *
   * A navigation timeout is NOT treated as failure. The browser may well hold
   * a fully-rendered page while some straggling subresource keeps the
   * navigation promise pending — discarding that would throw away the very
   * content we came for.
   */
  async #load(url) {
    const page = await this.context.newPage();
    this.pages++;

    // Both attached before navigating — see #trackRequests. The harvester has
    // the same constraint for a stronger reason: a response that arrives before
    // the listener exists is not merely uncounted, its bytes are gone for good.
    const tracker = this.#trackRequests(page);
    const harvester = this.#harvest(page);

    let response = null;
    let timedOut = false;

    try {
      response = await page.goto(url, {
        waitUntil: this.opts.waitUntil,
        timeout: this.opts.timeout,
      });
    } catch (err) {
      timedOut = true;
      // Only a navigation that never arrived anywhere is unrecoverable.
      const landed = page.url() && page.url() !== 'about:blank';
      if (!landed) {
        tracker.detach();
        harvester.detach();
        await page.close().catch(() => {});
        throw err;
      }
    }

    try {
      await this.#settle(page, tracker);
      if (this.opts.autoScroll) await this.#autoScroll(page, tracker);
    } finally {
      tracker.detach();
    }

    return { page, response, timedOut, harvester };
  }

  /**
   * The `src` of every <script> the *server* sent, resolved absolute.
   *
   * Returns null when the original body cannot be had, which is deliberate:
   * #capture prunes nothing rather than guessing from a DOM that has already
   * been rewritten by the page.
   */
  async #serverScriptSrcs(page, response) {
    if (!response) return null;

    let body;
    try {
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (type && !/html/.test(type)) return null;
      body = await response.text();
    } catch {
      return null; // body already released — do not prune on a guess
    }
    if (!body) return null;

    const base = page.url();
    const srcs = [];
    const re = /<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const raw = m[1] ?? m[2] ?? m[3];
      if (!raw) continue;
      try {
        srcs.push(new URL(raw, base).href);
      } catch {
        /* unresolvable specifier — nothing to match against anyway */
      }
    }
    return srcs;
  }

  /**
   * Serialise the settled DOM, minus the `<script src>` elements the page's
   * own JavaScript injected while it ran.
   *
   * Capturing a rendered DOM captures those injections too, and replaying them
   * is not the same as having run them. The injected tag executes a second
   * time, from a blank slate, without whatever the injector had set up for
   * it — so it either throws or does its work twice.
   *
   * mapleleaflegalservices.ca is a clean example. WordPress ships a module
   * script that feature-detects emoji support and, only if the browser lacks
   * it, injects `wp-emoji-release.min.js`. Headless Chromium fails that
   * detection where a normal browser passes it, so the mirror froze in a
   * `<script src>` the live page never has — and on replay it ran with none
   * of the state the module normally hands it and threw on every page load.
   * The live site throws nothing.
   *
   * Removing them is safe precisely because the code that injected them is
   * still present and still runs: a page that genuinely needs an injected
   * chunk re-injects it, now judged against the *viewer's* browser rather
   * than against headless Chromium. What is dropped is only the frozen
   * verdict of the wrong environment.
   *
   * Scoped to scripts with a `src`. An injected inline script re-runs too,
   * but distinguishing one from an inline script the server sent means
   * comparing bodies that frameworks routinely rewrite, and a wrong match
   * would delete a script the page depends on. The double network fetch and
   * the errors above both come from the `src` case.
   */
  async #capture(page, response) {
    const fromServer = await this.#serverScriptSrcs(page, response);
    if (fromServer) {
      await page
        .evaluate((keep) => {
          const allowed = new Set(keep);
          let removed = 0;
          for (const s of document.querySelectorAll('script[src]')) {
            // `s.src` is already absolute and resolved the same way the
            // server's specifiers were, so this compares like with like.
            if (!allowed.has(s.src)) {
              s.remove();
              removed++;
            }
          }
          return removed;
        }, fromServer)
        .catch(() => {
          // Best effort: a page that navigated away mid-capture still yields
          // usable HTML, just without the pruning.
        });
    }
    return page.content();
  }

  /**
   * Render one URL and return its settled HTML.
   *
   * @returns {Promise<{html: string, url: string, status: number}>}
   */
  async render(url) {
    if (!this.context) await this.start();
    const { page, response, harvester } = await this.#load(url);

    try {
      const html = await this.#capture(page, response);
      // Collected before the page closes: Playwright can only hand back a
      // response body while its page is still open.
      const harvested = await harvester.collect();
      return {
        html,
        url: page.url(),
        status: response ? response.status() : 200,
        harvested,
      };
    } finally {
      harvester.detach();
      await page.close().catch(() => {});
    }
  }

  /**
   * Navigate to a URL and return the settled page, including its status.
   *
   * The difference from render(): this is the *primary* way a page is
   * fetched when rendering is on, rather than a post-process applied after a
   * separate plain fetch has already succeeded. Fetching twice — once with
   * fetch(), once with the browser — is wasteful, doubles the load on the
   * site, and means any page the plain fetch cannot retrieve is abandoned
   * before the browser is ever asked.
   *
   * @returns {Promise<{html, url, status, contentType, ok}>}
   */
  async navigate(url) {
    if (!this.context) await this.start();
    const { page, response, timedOut, harvester } = await this.#load(url);

    try {
      const headers = response ? response.headers() : {};
      const html = await this.#capture(page, response);
      // Before page.close() — see render().
      const harvested = await harvester.collect();

      // With no response object the navigation never completed cleanly, but
      // we still have a document. Treat it as usable rather than losing it —
      // `partial` lets the caller report the caveat.
      const status = response ? response.status() : 200;

      return {
        html,
        url: page.url(),
        status,
        contentType: headers['content-type'] || 'text/html',
        // Kept so a resumed run can revalidate cheaply instead of paying for
        // a full browser render just to discover nothing changed.
        etag: headers.etag || null,
        lastModified: headers['last-modified'] || null,
        ok: status >= 200 && status < 300,
        partial: timedOut,
        harvested,
      };
    } finally {
      harvester.detach();
      await page.close().catch(() => {});
    }
  }

  /**
   * Cookies the browser holds for a URL, as a Cookie header value.
   *
   * Assets are still fetched over plain HTTP for speed, so without this they
   * would arrive as a different, session-less client than the page that
   * referenced them — breaking anything gated behind a login the browser
   * established.
   */
  async cookieHeaderFor(url) {
    if (!this.context) return null;
    try {
      const cookies = await this.context.cookies(url);
      if (!cookies.length) return null;
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return null;
    }
  }

  async stop() {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.context = null;
    this.browser = null;
  }
}

module.exports = { Renderer, isAvailable, INSTALL_HINT };
