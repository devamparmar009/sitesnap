'use strict';

/**
 * The crawl engine.
 *
 * Runs in two passes, and the split is forced by a real constraint: the local
 * filename of a resource depends on its *served* content type (a URL like
 * `/about` with no extension becomes `about.html` only once we've seen
 * `Content-Type: text/html`). So we cannot rewrite a link until the thing it
 * points at has been fetched.
 *
 *   Pass 1 — fetch everything reachable, write raw bytes to disk, and record
 *            url -> local path in the manifest.
 *   Pass 2 — reread each saved HTML/CSS file and rewrite its references using
 *            the completed manifest.
 *
 * There is no child_process here, and no shell anywhere in the package. The
 * command-injection class that affects wget-wrapping downloaders is absent by
 * construction rather than by escaping.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const { urlToLocalPath, urlToLocalDir, resolveInside, relativeLink } = require('./urlpath');
const {
  buildRuntimeScript,
  runtimeTag,
  injectRuntime,
  RUNTIME_FILENAME,
} = require('./runtime');
const {
  normalize,
  inPageScope,
  shouldSkipReference,
  privateAddressReason,
} = require('./scope');
const {
  extractHtml,
  rewriteHtml,
  extractCss,
  rewriteCss,
  extractJsImports,
  rewriteJsImports,
  extractBundlerAssets,
  extractScriptAssets,
  rewriteAssetBase,
} = require('./extract');
const robotsLib = require('./robots');
const sitemapLib = require('./sitemap');
const stateLib = require('./state');
const { UrlFilter } = require('./patterns');
const { Fetcher, BLOCK_STATUS, DEFAULT_UA, describeUa } = require('./fetcher');
const { Renderer } = require('./render');
const { decodeText, detectKind, retagCharset, detectChallenge } = require('./decode');

const DEFAULTS = {
  maxPages: 200,
  maxFiles: 3000,
  maxBytes: 500 * 1024 * 1024, // 500 MB total
  maxFileBytes: 50 * 1024 * 1024, // 50 MB per resource
  maxDepth: 5,
  concurrency: 6,
  timeout: 30_000,
  includeSubdomains: false,
  noParent: true,
  respectRobots: true,
  blockPrivate: false,
  include: [],
  exclude: [],
  useSitemap: false,
  maxSitemapUrls: 5000,
  retries: 2,
  delay: 0,
  headers: {},
  resume: false,
  render: false,
  // Minimum time to let a rendered page keep working before capturing it.
  // Raising this is the fix for an app whose content appears on a timer with
  // no network request to wait on — nothing observable distinguishes "still
  // rendering" from "finished" in that case, so it has to be waited out.
  settleMinMs: 1_200,
  // Hard cap on that wait, so a page that never goes quiet still returns.
  settleTimeout: 5_000,
  // Scroll rendered pages to trigger lazy-loaded images and content.
  autoScroll: false,
  // Keep the bytes of every subresource a rendered page fetched. This is what
  // makes a JS-driven app work offline rather than merely look right, so it is
  // on by default whenever --render is; the caps bound a runaway page.
  harvest: true,
  harvestMaxFiles: 2000,
  harvestMaxBytes: 250 * 1024 * 1024,
  // Ship a URL map the running page can consult, for addresses it assembles
  // rather than declares. On by default: it is exact-match only, so an
  // unmapped URL passes through untouched and nothing can be made worse.
  runtimeRewrite: true,
  // A real browser's User-Agent, and not the conventional
  // `Mozilla/5.0 (compatible; sitesnap/1.0; +offline archiving)` this used to
  // send.
  //
  // Honest self-identification is the better instinct and it loses. The
  // `(compatible; ...)` shape is what a decade of copy-pasted WAF rules match
  // on, so the polite string is refused by hosts that serve `spider` and
  // `crawler` without complaint — mapleleaflegalservices.ca is one, and it
  // 403'd the seed and ended the crawl with nothing downloaded. Politeness
  // that reliably produces an empty mirror is not politeness, it is a bug.
  //
  // What actually makes this crawler well-behaved is unchanged and is not a
  // matter of what it calls itself: robots.txt is still obeyed by default,
  // requests are still rate-limited and backed off, and Retry-After is still
  // honoured. Override with --user-agent if you would rather announce
  // yourself; hosts that accept it will still get it.
  userAgent: DEFAULT_UA,
};

/**
 * Header-only type detection.
 *
 * Superseded internally by `detectKind` in ./decode, which also sniffs the
 * leading bytes and so survives a missing or wrong Content-Type. Kept as a
 * named export because it is part of this module's public surface.
 */
function kindFromContentType(contentType = '') {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/css') return 'css';
  return 'other';
}

class Crawler extends EventEmitter {
  #queue = [];
  #waiters = [];
  #active = 0;
  #seen = new Set();
  #stopped = false;
  // Budget counters, incremented on admission to the queue rather than on
  // completion — see #enqueue for why.
  #pagesQueued = 0;
  #filesQueued = 0;
  #priorState = new Map();

  constructor(startUrl, outDir, options = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    this.outDir = path.resolve(outDir);

    const start = normalize(startUrl);
    if (!start) {
      throw new Error(
        `Not a usable http(s) URL: ${startUrl}. Try including the scheme, e.g. https://example.com`
      );
    }
    this.start = start;

    /** @type {Map<string, {localPath: string, kind: string, url: string}>} */
    this.manifest = new Map();
    this.stats = {
      pages: 0,
      files: 0,
      bytes: 0,
      failed: 0,
      skipped: 0,
      filtered: 0,
      blocked: 0,
      partial: 0,
      fromSitemap: 0,
      reused: 0,
      rendered: 0,
      harvested: 0,
      robotsBlockedCode: 0,
      startedAt: null,
      finishedAt: null,
    };
    this.failures = [];
    this.robots = null;
    this.controller = new AbortController();

    // Throws on a malformed pattern, which is what we want: a typo that
    // silently matched nothing would quietly produce the wrong archive.
    this.filter = new UrlFilter(this.opts.include, this.opts.exclude);

    this.fetcher = new Fetcher({
      origin: this.start,
      headers: this.opts.headers,
      userAgent: this.opts.userAgent,
      retries: this.opts.retries,
      timeout: this.opts.timeout,
      delay: this.opts.delay,
      signal: this.controller.signal,
      onNote: (message) => this.emit('phase', { phase: 'throttle', message }),
    });

    this.renderer = null;
    /** @type {Map<string, object>} previous run's state, for --resume */
    this.#priorState = new Map();
  }

  /**
   * Does this status mean the host objected to the client rather than to the
   * request? Mirrors Fetcher's rule. 401 is excluded here: the browser
   * surfaces a genuine auth challenge the same way, and no choice of identity
   * satisfies one.
   */
  #isIdentityBlock(status) {
    return BLOCK_STATUS.has(status);
  }

  /**
   * Live queue counts, for progress reporting. Read-only: calling this never
   * affects the crawl. `filesQueued` grows as pages reveal more links, so a
   * progress bar built on it must tolerate a moving total.
   */
  progress() {
    return {
      pagesQueued: this.#pagesQueued,
      filesQueued: this.#filesQueued,
      waiting: this.#queue.length,
      active: this.#active,
    };
  }

  stop(reason = 'cancelled') {
    if (this.#stopped) return;
    this.#stopped = true;
    this.stopReason = reason;
    this.controller.abort();
    this.#wakeAll();
  }

  // ---- work queue -------------------------------------------------------

  #wakeAll() {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  #push(task) {
    this.#queue.push(task);
    const waiter = this.#waiters.shift();
    if (waiter) waiter();
  }

  /**
   * Claim the next task, or null when the crawl is finished.
   *
   * The `#active++` MUST happen here, in the same synchronous step as the
   * shift — not in the caller after its `await`. Incrementing later leaves a
   * window where the queue is empty and `#active` is still 0, and every other
   * worker reads that as "nothing left to do" and exits for good. That window
   * is hit immediately at startup (one seed URL, N workers), which silently
   * collapsed the whole pool to a single worker.
   */
  async #take() {
    while (!this.#stopped) {
      if (this.#queue.length) {
        this.#active++;
        return this.#queue.shift();
      }
      // Nothing queued and nothing running means nothing can ever be queued
      // again — the crawl is genuinely finished.
      if (this.#active === 0) return null;
      await new Promise((resolve) => this.#waiters.push(resolve));
    }
    return null;
  }

  /**
   * Admit a URL to the queue if it is new, permitted and within budget.
   *
   * Budgets are counted against what has been *admitted*, not what has been
   * completed. Counting completions is useless here: one page linking to 200
   * others enqueues all 200 before a single one finishes, so a maxPages of 5
   * would admit every one of them. The queued counters are the real cap.
   */
  #enqueue(url, depth, kind, { seed = false, referer = null, speculative = false, parent = null } = {}) {
    const key = url.href;
    if (this.#seen.has(key)) return;

    if (kind === 'page' && depth > this.opts.maxDepth) return;
    if (this.#filesQueued >= this.opts.maxFiles) return;
    if (kind === 'page' && this.#pagesQueued >= this.opts.maxPages) return;

    if (this.filter.active) {
      const reason = this.filter.rejects(url, kind);

      // The start URL is exempt from --include. The user named it explicitly
      // as the entry point, and it is what discovers the links the include is
      // meant to select from — filtering it out leaves nothing to crawl at
      // all. --exclude still applies: an explicit "not this" is never
      // overridden, not even for the seed.
      const exempt = seed && reason === 'not matched by any --include';

      if (reason && !exempt) {
        this.#seen.add(key); // don't re-evaluate this URL every time it's linked
        this.stats.filtered++;
        this.emit('skip', { url: key, reason });
        return;
      }
    }

    if (this.opts.respectRobots && !robotsLib.isAllowed(this.robots, url.pathname)) {
      this.stats.skipped++;
      // Counted separately so the run can say *why* the mirror is inert. A
      // robots.txt that disallows `*.js$` — suitsupply.com does exactly this —
      // yields a page with all its markup, all its styling, and none of its
      // behaviour. Every individual skip is correct and the result looks like
      // a broken tool, so the total has to be surfaced at the end.
      if (kind === 'asset' && /\.(?:m?js|css)$/i.test(url.pathname)) {
        this.stats.robotsBlockedCode++;
      }
      this.emit('skip', { url: key, reason: 'robots.txt' });
      return;
    }

    this.#seen.add(key);
    this.#filesQueued++;
    if (kind === 'page') this.#pagesQueued++;
    // `parent` is the page whose link admitted this one. It changes nothing
    // about the crawl; it is reported on the resource event so a UI can draw
    // the site as the tree it was actually discovered as.
    this.#push({ url, depth, kind, referer, seed, speculative, parent });
  }

  /**
   * Re-anchor the crawl when the entry URL redirects somewhere else.
   *
   * Scope is judged against the start URL, but the start URL is what the user
   * *typed* — and the page we actually landed on may be somewhere else
   * entirely. `nike.com` geo-redirects to `nike.in`; countless sites send the
   * apex to `www`. Every link on the landed page then belongs to the new
   * host, gets judged against the old one, and is rejected: the crawl saves a
   * single page and silently follows nothing, with no error to explain it.
   *
   * Only the seed rebases. A redirect on some page deep in the crawl must not
   * be allowed to drag the whole scope along with it.
   */
  #rebaseStart(finalUrl) {
    if (finalUrl.href === this.start.href) return;

    const from = this.start;
    this.start = finalUrl;

    // noParent is relative to the start path, so it moves too.
    if (from.origin !== finalUrl.origin || from.pathname !== finalUrl.pathname) {
      this.emit('phase', {
        phase: 'redirect',
        message: `entry redirected to ${finalUrl.href} — scoping the crawl to there`,
      });
    }
  }

  // ---- disk -------------------------------------------------------------

  /**
   * Write a resource, resolving the rare case where one URL wants to be a file
   * and another wants that same name as a directory (/logo.png vs /logo.png/x).
   * Returns the relative path actually used.
   */
  async #write(relPath, body) {
    let rel = relPath;

    for (let attempt = 0; attempt < 3; attempt++) {
      const full = resolveInside(this.outDir, rel);
      try {
        await fsp.mkdir(path.dirname(full), { recursive: true });

        if (body instanceof Uint8Array || typeof body === 'string') {
          await fsp.writeFile(full, body);
        } else {
          await this.#pipeWithStallGuard(body, fs.createWriteStream(full));
        }
        return rel;
      } catch (err) {
        // ENOTDIR: an ancestor is a file. EISDIR: this name is already a dir.
        if (err.code !== 'ENOTDIR' && err.code !== 'EISDIR') throw err;
        const dir = path.posix.dirname(rel);
        const base = path.posix.basename(rel);
        rel = `${dir}/_${base}`;
      }
    }
    throw new Error(`could not find a free path for ${relPath}`);
  }

  /**
   * pipeline() with an inactivity watchdog on BOTH ends.
   *
   * `AbortSignal.timeout` on the fetch only bounds the network side, up to
   * the point headers arrive. Once streaming into this pipe begins, nothing
   * previously bounded a destination write that stops draining — a locked
   * file, a throttled or network-mounted disk, backup or antivirus software
   * intercepting the write. Node's `pipeline()` has no built-in deadline; a
   * stalled write sits forever, and because that worker never returns to the
   * queue, enough stalled files can quietly stop the whole crawl with no
   * error ever printed.
   *
   * This polls `dest.bytesWritten` — real progress, not wall-clock elapsed —
   * so a large file that is genuinely still transferring is never penalised
   * for taking a long time, only for taking `timeout` ms with zero progress.
   * A stall on the read side shows up here too: no new bytes reach the
   * destination either.
   */
  async #pipeWithStallGuard(source, dest) {
    const timeoutMs = this.opts.timeout;
    let lastBytes = 0;
    let lastActivity = Date.now();

    const watchdog = setInterval(() => {
      const written = dest.bytesWritten || 0;
      if (written !== lastBytes) {
        lastBytes = written;
        lastActivity = Date.now();
        return;
      }
      if (Date.now() - lastActivity >= timeoutMs) {
        const err = new Error(`stalled — no write progress for ${Math.round(timeoutMs / 1000)}s`);
        // destroy() on either end makes pipeline() reject with this error
        // and tears down the other end too, rather than leaking a handle.
        source.destroy?.(err);
        dest.destroy?.(err);
      }
    }, Math.min(1000, Math.max(250, timeoutMs / 10)));

    try {
      await pipeline(source, dest);
    } finally {
      clearInterval(watchdog);
    }
  }

  // ---- pass 1 -----------------------------------------------------------

  async #process(task) {
    const { url, depth, kind: requestedKind } = task;

    // Already on disk, because rendering some earlier page made the browser
    // fetch it and the harvest kept the bytes. A URL reaches the queue only
    // once, so the manifest can only hold it already for that reason —
    // re-downloading would be pure duplicate traffic for an identical file.
    if (this.manifest.has(url.href)) return;

    if (this.opts.blockPrivate) {
      const reason = await privateAddressReason(url);
      if (reason) {
        this.stats.skipped++;
        this.emit('skip', { url: url.href, reason: `blocked: ${reason}` });
        return;
      }
    }

    // Resume: ask the server whether our copy is still current.
    //
    // Except when the render mode has changed. A cached page fetched without
    // --render holds the server's shell, and a 304 would hand that straight
    // back — so turning --render on would silently do nothing. Treat a render
    // mismatch as a cache miss and refetch unconditionally.
    const prior = this.#priorState.get(url.href);
    const renderChanged =
      prior &&
      prior.kind === 'html' &&
      Boolean(prior.rendered) !== Boolean(this.opts.render);

    const conditional =
      this.opts.resume && !renderChanged ? stateLib.conditionalHeaders(prior) : {};

    // With rendering on, a page task is loaded *by the browser*, not by
    // fetch(). Previously the browser only re-processed a page that fetch()
    // had already retrieved successfully, so `if (!res.ok) return` abandoned
    // the page before the browser was ever consulted — making --render dead
    // weight for exactly the pages that most need a real browser. It also
    // fetched every page twice.
    let browserAlreadyTried = false;
    if (this.renderer && requestedKind === 'page') {
      const handled = await this.#processViaBrowser(task);
      if (handled) return;
      // Not HTML, or the browser could not load it — fall through to fetch().
      // Remember that, so the fetch path does not pay for a second render of
      // a page the browser has already failed to load once.
      browserAlreadyTried = true;
    }

    let res;
    try {
      res = await this.fetcher.fetch(url, { headers: conditional, referer: task.referer });
    } catch (err) {
      this.#fail(url.href, this.#stopped ? 'cancelled' : err.message, err);
      return;
    }

    // 304: our copy is good, so adopt it and replay its recorded links.
    if (res.status === 304) {
      const reused = prior && (await this.#reuse(url, prior, depth));
      if (reused) return;

      // The cached file is gone, so the 304 is useless to us — and it carries
      // no body to fall back on. Ask again without the validators.
      try {
        res = await this.fetcher.fetch(url);
      } catch (err) {
        this.#fail(url.href, this.#stopped ? 'cancelled' : err.message, err);
        return;
      }
    }

    if (!res.ok) {
      res.clearDeadline?.();
      // A URL we inferred from inside JavaScript rather than read from markup
      // is a guess, and a guess that misses is not a fault in the crawl. A
      // bundler's code is full of filename fragments its own loader resolves
      // by rules we deliberately do not execute, so some 404s are the expected
      // cost of finding the chunks that do exist. Reporting them as failures
      // buries the real ones and makes a healthy mirror look broken.
      if (task.speculative) {
        this.stats.skipped++;
        this.emit('skip', { url: url.href, reason: `inferred URL not found (HTTP ${res.status})` });
        return;
      }
      this.#fail(url.href, await this.#explainHttpError(res));
      return;
    }

    const contentType = res.headers.get('content-type') || '';

    const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > this.opts.maxFileBytes) {
      res.clearDeadline?.();
      this.stats.skipped++;
      this.emit('skip', {
        url: url.href,
        reason: `too large (${formatBytes(declared)})`,
      });
      return;
    }

    // Peek at the leading bytes before committing to a type. Trusting the
    // Content-Type header alone means an HTML page served as
    // application/octet-stream (or with no header at all) is stored as an
    // opaque blob and never parsed — so every link on it is lost and the
    // crawl dead-ends there.
    let sniffed;
    try {
      sniffed = await this.#sniff(res, contentType);
    } catch (err) {
      res.clearDeadline?.();
      this.#fail(url.href, err.message, err);
      return;
    }
    const kind = sniffed.kind;

    // fetch follows redirects, so res.url may differ from what we asked for.
    // Both identities must map to the same file or links will dangle.
    const finalUrl = normalize(res.url) || url;
    // Must happen before #discover, so this page's links are judged against
    // where we actually landed rather than where we asked to go.
    if (task.seed) this.#rebaseStart(finalUrl);
    const relPath = urlToLocalPath(finalUrl, kind);

    let written;
    let text = null;
    // Tracks whether this page's bytes really are the rendered DOM. Using
    // "rendering was enabled" instead would mislabel a page whose render
    // failed and fell back to the server HTML.
    let didRender = false;
    // Subresources the browser fetched, ingested once this page is recorded.
    let harvested = null;

    try {
      if (kind === 'html' || kind === 'css' || kind === 'js') {
        // Read chunk-by-chunk rather than one `res.arrayBuffer()` call, so
        // each chunk can bump the read deadline — otherwise a large-but-
        // healthy page would be judged solely on total transfer time.
        const buf = await this.#readWithDeadline(res, url.href, sniffed);
        if (!this.#chargeBytes(buf.byteLength, url.href)) return;

        // Decode with the page's real encoding, not a blanket UTF-8. Getting
        // this wrong replaces every non-ASCII byte with U+FFFD permanently —
        // the original bytes are gone, so no later pass can repair it.
        const decoded = decodeText(buf, contentType);
        text = decoded.text;
        if (decoded.encoding !== 'utf-8') {
          // We write UTF-8 to disk, so the document's own declaration has to
          // be updated or the offline copy renders as mojibake.
          text = retagCharset(text, kind);
          this.emit('phase', {
            phase: 'decode',
            message: `${finalUrl.href} decoded as ${decoded.encoding} (via ${decoded.source})`,
          });
        }

        // With --render, the server's HTML is only a shell for a JS app. Run
        // the page in a real browser and mirror the settled DOM instead.
        //
        // Skipped when the browser has already been tried and failed for this
        // URL: retrying would just pay the same timeout a second time, which
        // is how a single slow page used to cost two full timeouts.
        // `requestedKind`, not just the sniffed kind. A URL we asked for as an
        // asset that comes back as HTML is a soft 404 or an interstitial, not a
        // page — and driving a browser is the most expensive thing here, so
        // rendering every one of them turns a handful of bad guesses into
        // minutes of wasted work and a page count that bears no relation to
        // what was actually crawled.
        if (kind === 'html' && requestedKind === 'page' && this.renderer && !browserAlreadyTried) {
          try {
            const rendered = await this.renderer.render(finalUrl.href);
            text = rendered.html;
            didRender = true;
            harvested = rendered.harvested;
            this.stats.rendered++;
          } catch (err) {
            // A render failure is not fatal — the server HTML is still a
            // usable, if emptier, mirror of the page.
            this.emit('warn', {
              url: finalUrl.href,
              message: `render failed, using server HTML: ${err.message}`,
            });
          }
        }

        written = await this.#write(relPath, Buffer.from(text, 'utf8'));
      } else {
        // Replay the bytes consumed while sniffing, then the rest of the
        // stream — the prefix has already left the socket and would
        // otherwise be silently dropped from the saved file.
        const counted = this.#countingStream(this.#restream(sniffed), url.href, res);
        written = await this.#write(relPath, counted);
      }
    } catch (err) {
      this.#fail(url.href, err.message, err);
      return;
    } finally {
      // Guaranteed exactly once regardless of which path above returned,
      // threw, or succeeded — the one place this can be forgotten.
      res.clearDeadline?.();
    }

    const entry = {
      localPath: written,
      kind,
      url: finalUrl.href,
      // Kept for the next run's conditional request.
      etag: res.headers.get('etag') || null,
      lastModified: res.headers.get('last-modified') || null,
      // Whether this copy is the browser-rendered DOM or the server's HTML.
      // A later run with a different --render setting must not reuse it.
      rendered: kind === 'html' ? didRender : undefined,
    };
    this.manifest.set(url.href, entry);
    this.manifest.set(finalUrl.href, entry);

    this.stats.files++;
    // Only something we set out to crawl as a page counts as one; see the
    // render guard above for why an asset can arrive as HTML.
    if (kind === 'html' && requestedKind === 'page') this.stats.pages++;

    this.emit('resource', {
      url: finalUrl.href,
      localPath: written,
      kind,
      status: res.status,
      parent: task.parent || task.referer || null,
      depth,
      title: kind === 'html' && text !== null ? pageTitle(text) : null,
      files: this.stats.files,
      pages: this.stats.pages,
      bytes: this.stats.bytes,
    });

    if (text !== null) entry.links = this.#discover(text, finalUrl, kind, depth);

    // See the matching call in #processViaBrowser for why this runs last.
    await this.#ingestHarvest(harvested, depth, finalUrl.href);
  }

  /**
   * Adopt an unchanged file from a previous run.
   *
   * The 304 saved us the download, but not the parsing: this document's links
   * still have to feed discovery or the crawl stops at the first cached page.
   * So we read the existing copy back off disk.
   *
   * @returns {Promise<boolean>} false if the file is gone and we must refetch
   */
  async #reuse(url, prior, depth) {
    let full;
    try {
      full = resolveInside(this.outDir, prior.localPath);
      await fsp.access(full);
    } catch {
      return false;
    }

    const entry = {
      localPath: prior.localPath,
      kind: prior.kind,
      url: prior.url || url.href,
      etag: prior.etag || null,
      lastModified: prior.lastModified || null,
      // Carry the recorded links forward. Dropping them here would let the
      // state degrade across runs: this run works (it still has the previous
      // run's links) but writes link-less entries, so the *next* resume finds
      // nothing to follow and silently shrinks the mirror to one page.
      links: prior.links || null,
      // Same reasoning for the render flag — losing it would make the next
      // run think a rendered page was never rendered.
      rendered: prior.rendered,
    };
    this.manifest.set(url.href, entry);
    if (entry.url !== url.href) this.manifest.set(entry.url, entry);

    this.stats.files++;
    this.stats.reused++;
    if (entry.kind === 'html') this.stats.pages++;

    this.emit('resource', {
      url: entry.url,
      localPath: entry.localPath,
      kind: entry.kind,
      status: 304,
      cached: true,
      files: this.stats.files,
      pages: this.stats.pages,
      bytes: this.stats.bytes,
    });

    // Replay the links this document had when we last fetched it.
    //
    // We cannot reparse the file on disk: pass 2 already rewrote its
    // references to local paths, so an <a href> now reads "about.html" and
    // resolving that against the page URL would invent
    // https://site/about.html for a page really served at /about. The links
    // are therefore recorded as absolute URLs at crawl time and stored in the
    // state file.
    if (prior.links) {
      for (const raw of prior.links.assets || []) {
        const abs = normalize(raw);
        if (abs) this.#enqueue(abs, depth, 'asset');
      }
      for (const raw of prior.links.pages || []) {
        const abs = normalize(raw);
        if (abs && inPageScope(abs, this.start, this.opts)) {
          this.#enqueue(abs, depth + 1, 'page');
        }
      }
    }
    return true;
  }

  /** Queue everything a freshly-downloaded document points at. */
  #discover(text, baseUrl, kind, depth) {
    // Absolute URLs are collected as well as queued, so a resumed run can
    // replay them without reparsing a file whose links have been localised.
    const found = { pages: [], assets: [] };

    if (kind === 'html') {
      const { pages, assets, baseHref } = extractHtml(text);

      // <base href> redefines what relative URLs on this page mean.
      let base = baseUrl;
      if (baseHref) {
        const rebased = normalize(baseHref, baseUrl);
        if (rebased) base = rebased;
      }

      for (const raw of assets) {
        if (shouldSkipReference(raw)) continue;
        const abs = normalize(raw, base);
        if (!abs) continue;
        found.assets.push(abs.href);
        // The document that referenced this asset is its Referer — which is
        // what hotlink-protected fonts and images check for.
        this.#enqueue(abs, depth, 'asset', { referer: baseUrl.href });
      }

      // A framework's client-reference manifest lives in an inline <script>,
      // not in any attribute — and it is the only place the route's own
      // component chunk is ever named. Missing it is what leaves a rendered
      // mirror showing a blank error instead of the page.
      for (const raw of extractScriptAssets(text)) {
        if (shouldSkipReference(raw)) continue;
        const abs = normalize(raw, base);
        if (!abs) continue;
        found.assets.push(abs.href);
        this.#enqueue(abs, depth, 'asset', { referer: baseUrl.href, speculative: true });
      }

      for (const raw of pages) {
        if (shouldSkipReference(raw)) continue;
        const abs = normalize(raw, base);
        if (!abs) continue;
        if (!inPageScope(abs, this.start, this.opts)) continue;
        found.pages.push(abs.href);
        this.#enqueue(abs, depth + 1, 'page', { parent: baseUrl.href });
      }
    } else if (kind === 'js') {
      // Code-split chunks are named only inside the JavaScript itself.
      for (const raw of extractJsImports(text)) {
        if (shouldSkipReference(raw)) continue;
        const abs = normalize(raw, baseUrl);
        if (!abs) continue;
        found.assets.push(abs.href);
        this.#enqueue(abs, depth, 'asset', { referer: baseUrl.href });
      }

      // Chunks webpack builds at runtime from an id->hash table, which no
      // `import` statement mentions. These are relative to the bundle's
      // publicPath rather than to this file — resolving them against the
      // file's own URL yields /_next/static/chunks/static/chunks/x.js.
      const bundle = extractBundlerAssets(text);
      const assetBase = bundle.base ? normalize(bundle.base, baseUrl) || baseUrl : baseUrl;
      for (const raw of bundle.assets) {
        if (shouldSkipReference(raw)) continue;
        const abs = normalize(raw, assetBase);
        if (!abs) continue;
        found.assets.push(abs.href);
        this.#enqueue(abs, depth, 'asset', { referer: baseUrl.href, speculative: true });
      }
    } else if (kind === 'css') {
      // Stylesheets pull in fonts, sprites and @import-ed stylesheets. Those
      // are assets regardless of origin — a mirror without its webfont is
      // visibly broken.
      for (const raw of extractCss(text)) {
        if (shouldSkipReference(raw)) continue;
        const abs = normalize(raw, baseUrl);
        if (!abs) continue;
        found.assets.push(abs.href);
        this.#enqueue(abs, depth, 'asset', { referer: baseUrl.href });
      }
    }

    return found;
  }

  #chargeBytes(n, url) {
    this.stats.bytes += n;
    if (this.stats.bytes > this.opts.maxBytes) {
      this.stop(`byte budget exhausted (${formatBytes(this.opts.maxBytes)})`);
      this.emit('skip', { url, reason: 'byte budget exhausted' });
      return false;
    }
    return true;
  }

  /**
   * Wrap a body stream so per-file and total byte caps apply while streaming.
   * Also bumps the fetch's read deadline on every chunk — see
   * Fetcher.fetch()'s `bumpDeadline`. A slow-but-alive network read must not
   * be judged by total elapsed time, only by whether it has gone quiet.
   */
  #countingStream(stream, url, res) {
    let seen = 0;
    const self = this;
    return Readable.from(
      (async function* () {
        for await (const chunk of stream) {
          res?.bumpDeadline?.();
          seen += chunk.length;
          if (seen > self.opts.maxFileBytes) {
            throw new Error(`exceeded per-file limit (${formatBytes(self.opts.maxFileBytes)})`);
          }
          if (!self.#chargeBytes(chunk.length, url)) {
            throw new Error('byte budget exhausted');
          }
          yield chunk;
        }
      })()
    );
  }

  /**
   * Turn an HTTP error into something the user can act on.
   *
   * A bare "403 Forbidden" is misleading when the body is actually a
   * "checking your browser" interstitial: nothing is broken, the site is
   * deliberately refusing automated clients. Naming that saves people from
   * debugging a tool that is working correctly.
   */
  async #explainHttpError(res) {
    const base = `HTTP ${res.status} ${res.statusText || ''}`.trim();

    if (res.status !== 403 && res.status !== 503 && res.status !== 429) return base;

    let prefix = '';
    try {
      const buf = await this.#readWithDeadline(res, res.url, await this.#sniff(res, ''));
      prefix = buf.subarray(0, 4096).toString('latin1');
    } catch {
      return base;
    }

    const { isChallenge, vendor } = detectChallenge(res.status, res.headers, prefix);
    if (!isChallenge) return base;

    this.stats.blocked++;
    return (
      `${base} — bot-protection challenge${vendor ? ` (${vendor})` : ''}. ` +
      'This site requires visitors to pass an automated browser check, so it is ' +
      'refusing automated access rather than failing. sitesnap will not attempt ' +
      'to defeat it. If the site is yours, allow-list this crawler or use an ' +
      'export/API; otherwise seek the owner\'s permission.'
    );
  }

  /**
   * Load a page through the browser and store the settled DOM.
   *
   * @returns {Promise<boolean>} true if the page was handled here; false to
   *          let the caller fall back to a plain fetch (non-HTML responses,
   *          or a navigation the browser could not complete).
   */
  async #processViaBrowser(task) {
    const { url, depth } = task;

    // Resume, cheaply. Driving a browser is by far the most expensive thing
    // this crawler does, so revalidate with a plain conditional request
    // first: if the source is unchanged, the previously-rendered DOM on disk
    // is still good and no page needs to be opened at all. Skipping this
    // would make --resume almost worthless in combination with --render,
    // which is precisely where it saves the most.
    const prior = this.#priorState.get(url.href);
    if (this.opts.resume && prior && prior.kind === 'html' && prior.rendered) {
      try {
        const probe = await this.fetcher.fetch(url, {
          headers: stateLib.conditionalHeaders(prior),
        });
        probe.clearDeadline?.();
        if (probe.status === 304 && (await this.#reuse(url, prior, depth))) return true;
      } catch {
        // Revalidation is an optimisation; if it fails, just render.
      }
    }

    let page;
    try {
      page = await this.renderer.navigate(url.href);
    } catch (err) {
      this.emit('warn', {
        url: url.href,
        message: `browser navigation failed, falling back to plain fetch: ${err.message}`,
      });
      return false;
    }

    // The browser can be refused on identity too, and when it is, falling
    // straight back to plain fetch is the wrong move: fetch() has its own
    // ladder and may well succeed, but it succeeds *without running any
    // JavaScript* — so --render would silently degrade to a static mirror on
    // exactly the sites that were hardest to reach. Re-present the browser
    // under the identity this host accepts, and only then give up on it.
    if (!page.ok && this.#isIdentityBlock(page.status) && !task.uaRetried) {
      const before = this.fetcher.uaFor(url.host);
      // One plain probe is enough to make the fetcher climb; whatever it
      // settles on is the answer for this host, browser included.
      await this.fetcher.fetch(url, { navigation: true }).catch(() => {});
      const after = this.fetcher.uaFor(url.host);
      if (after !== before && (await this.renderer.setUserAgent(after))) {
        this.emit('warn', {
          url: url.href,
          message: `browser refused with HTTP ${page.status}; retrying it as ${describeUa(after)}`,
        });
        return this.#processViaBrowser({ ...task, uaRetried: true });
      }
    }

    if (!page.ok) {
      // The browser sees challenge interstitials too — its HTML is the
      // challenge page itself, so classify from that rather than reporting a
      // bare status the user cannot interpret.
      const { isChallenge, vendor } = detectChallenge(page.status, {}, page.html.slice(0, 4096));
      if (isChallenge) {
        this.stats.blocked++;
        this.#fail(
          url.href,
          `HTTP ${page.status} — bot-protection challenge${vendor ? ` (${vendor})` : ''}. ` +
            'The site requires an automated browser check even for a real browser. ' +
            'sitesnap will not attempt to defeat it.'
        );
        return true; // handled: do not retry with plain fetch, it will also be blocked
      }
      this.emit('warn', {
        url: url.href,
        message: `browser got HTTP ${page.status}, falling back to plain fetch`,
      });
      return false;
    }

    // A <a href> can point at a PDF or a zip. Those are not the browser's
    // job — hand them back for streaming to disk.
    const kind = detectKind(page.contentType, Buffer.from(page.html.slice(0, 1024), 'utf8'));
    if (kind !== 'html') return false;

    const finalUrl = normalize(page.url) || url;
    // Same as the fetch path: a redirected entry re-anchors the crawl, or
    // every link on the landed page is judged against a host we left behind.
    if (task.seed) this.#rebaseStart(finalUrl);
    const relPath = urlToLocalPath(finalUrl, 'html');
    const bytes = Buffer.from(page.html, 'utf8');

    if (!this.#chargeBytes(bytes.byteLength, url.href)) return true;

    let written;
    try {
      written = await this.#write(relPath, bytes);
    } catch (err) {
      this.#fail(url.href, err.message, err);
      return true;
    }

    // Assets are still fetched over plain HTTP for speed; carry the
    // browser's cookies across so they arrive as the same session.
    if (page.partial) {
      this.emit('warn', {
        url: finalUrl.href,
        message:
          'page kept despite a navigation timeout — some subresource never finished, ' +
          'so the capture may be incomplete',
      });
      this.stats.partial++;
    }

    const cookie = await this.renderer.cookieHeaderFor(finalUrl.href);
    if (cookie) this.fetcher.setSessionCookie(finalUrl.origin, cookie);

    const entry = {
      localPath: written,
      kind: 'html',
      url: finalUrl.href,
      // Validators describe the *source* document, not the rendered DOM, but
      // that is exactly the right thing to revalidate against: if the source
      // is unchanged, re-rendering it produces the same page.
      etag: page.etag || null,
      lastModified: page.lastModified || null,
      rendered: true,
    };
    this.manifest.set(url.href, entry);
    this.manifest.set(finalUrl.href, entry);

    this.stats.files++;
    this.stats.pages++;
    this.stats.rendered++;

    this.emit('resource', {
      url: finalUrl.href,
      localPath: written,
      kind: 'html',
      status: page.status,
      rendered: true,
      parent: task.parent || null,
      depth: task.depth,
      title: pageTitle(page.html),
      files: this.stats.files,
      pages: this.stats.pages,
      bytes: this.stats.bytes,
    });

    entry.links = this.#discover(page.html, finalUrl, 'html', depth);

    // After #discover, so a chunk the page actually loaded is already on disk
    // by the time the statically-extracted queue reaches it and is skipped as a
    // duplicate rather than downloaded twice.
    await this.#ingestHarvest(page.harvested, depth, finalUrl.href);
    return true;
  }

  /**
   * Save everything the browser fetched while rendering a page.
   *
   * The renderer hands back real bytes for real requests, which makes this the
   * one asset source that needs no guessing: a chunk only appears here because
   * the running app asked for it. Static extraction predicts; this observes.
   *
   * The same gates as any other asset still apply — `--exclude`, robots, and
   * both byte budgets. A harvest must not become a side door around the limits
   * the user set, so nothing here bypasses them. Scope is intentionally *not*
   * applied, matching how referenced assets already behave: a page without its
   * cross-origin webfont is not a usable mirror.
   */
  async #ingestHarvest(harvested, depth, parent = null) {
    if (!harvested || !harvested.entries || !harvested.entries.length) return;

    if (harvested.truncated) {
      this.emit('warn', {
        url: this.start.href,
        message:
          'render harvest hit its cap — some subresources the page fetched were not kept. ' +
          'Raise --harvest-max-files or --harvest-max-bytes if the mirror looks incomplete.',
      });
    }

    for (const item of harvested.entries) {
      const url = normalize(item.url);
      if (!url) continue;
      if (this.manifest.has(url.href)) continue;

      if (this.filter.active && this.filter.rejects(url, 'asset') !== null) {
        this.stats.filtered++;
        continue;
      }
      if (this.opts.respectRobots && !robotsLib.isAllowed(this.robots, url.pathname)) {
        this.stats.skipped++;
        continue;
      }
      if (item.body.length > this.opts.maxFileBytes) {
        this.stats.skipped++;
        continue;
      }
      if (!this.#chargeBytes(item.body.length, url.href)) return;

      const kind = detectKind(item.contentType, item.body.subarray(0, 1024));
      const relPath = urlToLocalPath(url, kind);

      let text = null;
      let bytes = item.body;
      if (kind === 'html' || kind === 'css' || kind === 'js') {
        const decoded = decodeText(item.body, item.contentType);
        text = decoded.encoding === 'utf-8' ? decoded.text : retagCharset(decoded.text, kind);
        bytes = Buffer.from(text, 'utf8');
      }

      let written;
      try {
        written = await this.#write(relPath, bytes);
      } catch (err) {
        this.#fail(url.href, `harvest write failed: ${err.message}`);
        continue;
      }

      const entry = {
        localPath: written,
        kind,
        url: url.href,
        etag: item.etag,
        lastModified: item.lastModified,
        // Marks this as a browser observation rather than a fetch of our own,
        // so #process can skip a queued duplicate instead of downloading it
        // a second time.
        harvested: true,
      };
      this.manifest.set(url.href, entry);
      // Keep the queue from re-fetching what we already hold.
      this.#seen.add(url.href);

      this.stats.files++;
      this.stats.harvested++;

      this.emit('resource', {
        url: url.href,
        localPath: written,
        kind,
        status: item.status,
        harvested: true,
        parent,
        depth,
        files: this.stats.files,
        pages: this.stats.pages,
        bytes: this.stats.bytes,
      });

      // A harvested stylesheet or bundle references further assets, and those
      // are subject to every normal rule when they come back through here.
      if (text !== null) entry.links = this.#discover(text, url, kind, depth);
    }
  }

  /**
   * Read just enough of the body to identify it, then decide its kind.
   *
   * Returns the consumed prefix alongside the still-unread iterator so the
   * caller can either finish buffering it (HTML/CSS) or splice it back onto
   * the front of the stream (binary). Reading a fixed small prefix means a
   * 200MB video costs one chunk to classify, not a full buffer.
   *
   * @returns {{kind: string, head: Buffer[], iterator: AsyncIterator|null}}
   */
  async #sniff(res, contentType) {
    const SNIFF_BYTES = 1024;

    if (!res.body) {
      return { kind: detectKind(contentType, Buffer.alloc(0)), head: [], iterator: null };
    }

    const iterator = res.body[Symbol.asyncIterator]();
    const head = [];
    let seen = 0;

    while (seen < SNIFF_BYTES) {
      const { value, done } = await iterator.next();
      if (done) break;
      res.bumpDeadline?.();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      head.push(chunk);
      seen += chunk.length;
    }

    return { kind: detectKind(contentType, Buffer.concat(head)), head, iterator };
  }

  /** Re-emit the sniffed prefix, then the remainder of the body. */
  #restream(sniffed) {
    const { head, iterator } = sniffed;
    return Readable.from(
      (async function* () {
        for (const chunk of head) yield chunk;
        if (!iterator) return;
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) return;
          yield Buffer.isBuffer(value) ? value : Buffer.from(value);
        }
      })()
    );
  }

  /**
   * Buffer a response body chunk-by-chunk, bumping the read deadline as data
   * arrives — the buffered counterpart to #countingStream, used for HTML/CSS
   * where we need the whole body as text rather than a stream to disk.
   */
  async #readWithDeadline(res, url, sniffed) {
    const chunks = [...(sniffed?.head || [])];
    const iterator = sniffed?.iterator;
    if (!iterator) return Buffer.concat(chunks);

    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      res.bumpDeadline?.();
      chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  #fail(url, message, err = null) {
    this.stats.failed++;
    // `fetch failed` is all undici says at the top level; the reason a person
    // can act on (no such host, connection refused, bad certificate) lives on
    // the cause. Kept so the failure can be explained in plain words later.
    const code = err?.cause?.code || err?.code || null;
    this.failures.push(code ? { url, message, code } : { url, message });
    this.emit('warn', { url, message });
  }

  /**
   * Seed the queue from the site's own sitemap.
   *
   * Sitemap URLs enter at depth 0: they are canonical entry points the site
   * published, not things we discovered by following links, so they should not
   * inherit a depth that might exclude them. Scope, filters and budgets still
   * apply — a sitemap is a suggestion, not an override.
   */
  async #seedFromSitemap() {
    const seeds = sitemapLib.candidates(this.start.origin, this.robots);
    this.emit('phase', { phase: 'sitemap', message: 'reading sitemap.xml' });

    let urls;
    try {
      urls = await sitemapLib.collect(seeds, {
        limit: this.opts.maxSitemapUrls,
        userAgent: this.opts.userAgent,
        signal: this.controller.signal,
        fetcher: this.fetcher,
        // Applied during the walk so maxSitemapUrls counts URLs we want.
        accept: (raw) => {
          const url = normalize(raw);
          if (!url) return false;
          if (!inPageScope(url, this.start, this.opts)) return false;
          return !this.filter.active || this.filter.rejects(url, 'page') === null;
        },
        onNote: (message) => this.emit('warn', { url: this.start.origin, message }),
      });
    } catch (err) {
      this.emit('warn', { url: this.start.origin, message: `sitemap failed: ${err.message}` });
      return;
    }

    if (!urls.length) {
      this.emit('phase', { phase: 'sitemap', message: 'no sitemap found — crawling links instead' });
      return;
    }

    let admitted = 0;
    for (const raw of urls) {
      const url = normalize(raw);
      if (!url) continue;
      if (!inPageScope(url, this.start, this.opts)) continue;

      const before = this.#pagesQueued;
      this.#enqueue(url, 0, 'page');
      if (this.#pagesQueued > before) admitted++;
    }

    this.stats.fromSitemap = admitted;
    this.emit('phase', {
      phase: 'sitemap',
      message: `sitemap listed ${urls.length} URLs, queued ${admitted} in scope`,
    });
  }

  // ---- pass 2 -----------------------------------------------------------

  /**
   * A last resort when a reference's exact URL is not in the manifest.
   *
   * Found on suitsupply.com's own homepage: two separate nav links to a page
   * this crawl genuinely captured, neither spelled the way the crawler fetched
   * it — one omitted the locale segment every other link on the site carries
   * (`/men/suits/x` instead of `/en-in/men/suits/x`), the other carried a
   * stray `.html` the live site's own href never serves (an authoring
   * artifact in a promotional card, not something this tool added). An exact
   * lookup on either fails, and — worse — used to be silently treated the
   * same as "genuinely not crawled": the link was left absolute, live, and
   * broken offline, indistinguishable from a page truly outside the budget.
   *
   * Both variants describe a page this crawl already has under a *slightly*
   * different string. The two probes below are deliberately narrow — a
   * locale-segment guess and a trailing-extension strip — because a wrong
   * guess here is worse than the honest "not mirrored" fallback the caller
   * already has: it would silently point a link at the wrong page. Anything
   * that does not match verbatim after one of these two adjustments is left
   * for the caller to handle as unresolved, same as before this existed.
   *
   * @param {URL} abs        the reference, already normalized
   * @param {URL} sourceUrl  the document containing it — its locale segment,
   *                         if any, is the one guess this makes
   */
  #lookupNearMiss(abs, sourceUrl) {
    // A no-op replace when there's no trailing extension to strip, so this is
    // safe to run unconditionally rather than gating it on a pathname test
    // that would just duplicate the regex's own job.
    const stripped = new URL(abs.href);
    stripped.pathname = abs.pathname.replace(/\.html?$/i, '');
    if (stripped.href !== abs.href) {
      const hit = this.manifest.get(stripped.href);
      if (hit) return hit;
    }

    const localeSeg = sourceUrl.pathname.split('/').filter(Boolean)[0];
    if (localeSeg && /^[a-z]{2}-[a-z]{2}$/i.test(localeSeg)) {
      const alreadyHasLocale = new RegExp(`^/${localeSeg}(/|$)`, 'i').test(abs.pathname);
      if (!alreadyHasLocale && abs.origin === sourceUrl.origin) {
        const withLocale = new URL(abs.href);
        withLocale.pathname = `/${localeSeg}${abs.pathname}`;
        const hit = this.manifest.get(withLocale.href);
        if (hit) return hit;

        // The .html quirk and the missing-locale quirk can both apply to the
        // same link at once — try the combination before giving up.
        if (/\.html?$/i.test(withLocale.pathname)) {
          const both = new URL(withLocale.href);
          both.pathname = withLocale.pathname.replace(/\.html?$/i, '');
          const hit2 = this.manifest.get(both.href);
          if (hit2) return hit2;
        }
      }
    }

    return null;
  }

  /**
   * Rewrite saved documents so every reference points at a local file.
   * References we never downloaded become absolute URLs, so the page still
   * degrades to the live site rather than 404-ing.
   */
  /**
   * Write the runtime URL map to the mirror root.
   *
   * @returns {Promise<string|null>} its path within the mirror, or null when
   *   the feature is off or there is nothing worth mapping.
   */
  async #writeRuntimeMap() {
    if (!this.opts.runtimeRewrite) return null;

    // Every mirrored resource, documents included: an app that fetches a page
    // for its content — a prefetch, a partial, a router preloading the next
    // route — is asking by address just as much as one loading a model, and
    // the static pass cannot see those calls either.
    const pairs = [];
    for (const entry of this.manifest.values()) {
      pairs.push([entry.url, entry.localPath]);
    }
    if (!pairs.length) return null;

    try {
      const full = resolveInside(this.outDir, RUNTIME_FILENAME);
      await fsp.writeFile(full, buildRuntimeScript(pairs));
      return RUNTIME_FILENAME;
    } catch (err) {
      // A mirror without the runtime map is the old behaviour, not a failure.
      this.emit('warn', { url: RUNTIME_FILENAME, message: `runtime map not written: ${err.message}` });
      return null;
    }
  }

  async #rewriteAll() {
    const documents = new Map();
    for (const entry of this.manifest.values()) {
      if (entry.kind === 'html' || entry.kind === 'css' || entry.kind === 'js') {
        documents.set(entry.localPath, entry);
      }
    }

    this.emit('phase', { phase: 'rewrite', total: documents.size });

    // The same manifest the static pass uses, made available to the running
    // page for the addresses it builds rather than declares. See ./runtime.
    const runtimePath = await this.#writeRuntimeMap();

    let done = 0;
    for (const entry of documents.values()) {
      const full = resolveInside(this.outDir, entry.localPath);
      const sourceUrl = new URL(entry.url);

      const resolve = (raw, refKind) => {
        if (shouldSkipReference(raw)) return null;
        const abs = normalize(raw, sourceUrl);
        if (!abs) return null;

        const target = this.manifest.get(abs.href) || this.#lookupNearMiss(abs, sourceUrl);
        if (!target) {
          // Not mirrored (out of scope, failed, or over budget) — keep it
          // working online by making the reference absolute.
          return abs.href;
        }
        return relativeLink(entry.localPath, target.localPath);
      };

      /**
       * Map a bundler's publicPath to a directory-relative path from this
       * script, for the runtime base rewrite in rewriteAssetBase.
       *
       * A root-absolute publicPath is resolved against this file's own URL.
       * That is sound in the only configuration where such a value can work at
       * all: the browser resolves publicPath against the *document*, so a site
       * serving its bundle from another origin has to spell that origin out in
       * full — and an absolute URL resolves correctly here regardless of base.
       */
      const resolveBase = (rawBase) => {
        const absBase = normalize(rawBase, sourceUrl);
        if (!absBase) return null;
        const rel = relativeLink(entry.localPath, urlToLocalDir(absBase));
        if (!rel) return null;
        // `new URL(rel, script)` treats a bare last segment as a filename, so
        // without the slash the base would drop its final directory.
        return rel.endsWith('/') ? rel : `${rel}/`;
      };

      try {
        const original = await fsp.readFile(full, 'utf8');
        let updated;
        if (entry.kind === 'html') {
          updated = rewriteHtml(original, resolve, { baseUrl: entry.url });
          if (runtimePath) {
            updated = injectRuntime(
              updated,
              runtimeTag(relativeLink(entry.localPath, runtimePath))
            );
          }
        } else if (entry.kind === 'css') {
          updated = rewriteCss(original, resolve);
        } else {
          updated = rewriteJsImports(original, resolve);
          updated = rewriteAssetBase(
            updated,
            path.posix.basename(entry.localPath),
            resolveBase
          );
        }

        if (updated !== original) await fsp.writeFile(full, updated);
      } catch (err) {
        this.#fail(entry.url, `rewrite failed: ${err.message}`);
      }

      done++;
      if (done % 10 === 0 || done === documents.size) {
        this.emit('phase', { phase: 'rewrite', done, total: documents.size });
      }
    }
  }

  /**
   * Write an entry page at the root of the mirror.
   *
   * Without one there is nothing obvious to open. A mirror's real homepage ends
   * up at `<host>/<locale>/index.html`, several directories down and sharing a
   * name with dozens of other files, so "just open the download" means digging
   * for it. Every captured page is listed here instead.
   *
   * Self-contained by necessity: an offline archive cannot load a font or a
   * script from a CDN, so the styling is inline and the page has no JS.
   */
  async #writeEntryIndex() {
    const esc = (s) =>
      String(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
      );

    // One entry per file, since the manifest holds an alias per redirect.
    const pages = new Map();
    for (const entry of this.manifest.values()) {
      if (entry.kind !== 'html') continue;
      if (!pages.has(entry.localPath)) pages.set(entry.localPath, entry);
    }
    if (!pages.size) return;

    const entryPath = this.manifest.get(this.start.href)?.localPath || null;

    const byHost = new Map();
    for (const entry of pages.values()) {
      const host = entry.localPath.split('/')[0];
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(entry);
    }
    for (const list of byHost.values()) {
      list.sort((a, b) => a.localPath.localeCompare(b.localPath));
    }

    const sections = [...byHost.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([host, list]) => {
        const items = list
          .map((e) => {
            const label = e.localPath.split('/').slice(1).join('/') || e.localPath;
            const primary = e.localPath === entryPath;
            return (
              `<li${primary ? ' class="primary"' : ''}>` +
              `<a href="${esc(e.localPath)}">${esc(label)}</a>` +
              `<span class="src">${esc(e.url)}</span></li>`
            );
          })
          .join('');
        return `<section><h2>${esc(host)} <em>${list.length}</em></h2><ul>${items}</ul></section>`;
      })
      .join('');

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(this.start.hostname)} — offline mirror</title>
<style>
:root{--bg:#0b0d10;--panel:#12151a;--line:#222831;--fg:#e8ecf1;--dim:#8b95a3;--accent:#7cc4ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:56px 24px 80px}
h1{font-size:clamp(26px,4vw,38px);letter-spacing:-.02em;margin:0 0 6px;font-weight:600}
.lede{color:var(--dim);margin:0 0 36px}
.lede code{color:var(--accent);background:#0f141a;padding:1px 6px;border-radius:4px}
section{margin:0 0 28px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
h2{margin:0;padding:13px 18px;font-size:12px;font-weight:600;letter-spacing:.09em;
  text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);
  display:flex;justify-content:space-between;align-items:center}
h2 em{font-style:normal;color:#5b6675}
ul{list-style:none;margin:0;padding:6px}
li{display:flex;flex-direction:column;gap:1px;padding:9px 12px;border-radius:8px;
  transition:background .15s ease,transform .15s ease}
li:hover{background:#171c23;transform:translateX(3px)}
li.primary{background:#101a24;box-shadow:inset 2px 0 0 var(--accent)}
a{color:var(--fg);text-decoration:none;font-weight:500;word-break:break-all}
li:hover a{color:var(--accent)}
.src{color:#5b6675;font-size:11.5px;word-break:break-all}
footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);color:#5b6675;font-size:13px}
@media (prefers-reduced-motion:reduce){li{transition:none}li:hover{transform:none}}
@media (prefers-color-scheme:light){
  :root{--bg:#fbfcfd;--panel:#fff;--line:#e3e8ee;--fg:#1b2027;--dim:#67717f;--accent:#0b6bcb}
  li:hover{background:#f2f6fa}li.primary{background:#f0f7ff}.src,h2 em{color:#8b95a3}
}
</style></head><body><div class="wrap">
<h1>${esc(this.start.hostname)}</h1>
<p class="lede">Offline mirror of <code>${esc(this.start.href)}</code> — ${pages.size} page${
      pages.size === 1 ? '' : 's'
    }, ${formatBytes(this.stats.bytes)}.</p>
${sections}
<footer>Captured by sitesnap. Interactive pages behave best when served over HTTP
(<code>npx serve</code> in this folder) rather than opened directly as files —
some browsers restrict what a <code>file://</code> page may load.</footer>
</div></body></html>`;

    try {
      await fsp.writeFile(path.join(this.outDir, 'index.html'), html, 'utf8');
    } catch (err) {
      this.emit('warn', {
        url: this.start.href,
        message: `could not write entry index: ${err.message}`,
      });
    }
  }

  /**
   * Explain an empty result in terms of what the user actually configured.
   *
   * "Nothing downloaded" is a dead end — the interesting question is always
   * *which* of their settings threw everything away, and over-narrow filters
   * are by far the most common cause.
   */
  #explainEmptyResult() {
    const parts = ['Nothing was downloaded.'];

    if (this.stats.filtered > 0) {
      parts.push(
        `${this.stats.filtered} URL${this.stats.filtered === 1 ? ' was' : 's were'} ` +
          'rejected by your include/exclude patterns.'
      );
      if (this.opts.include.length) {
        parts.push(`Check --include ${this.opts.include.map((p) => `"${p}"`).join(', ')}.`);
      }
      if (this.opts.useSitemap && this.stats.fromSitemap === 0) {
        parts.push(
          `No sitemap URL matched either — if the sitemap is large, raise ` +
            `--max-sitemap (currently ${this.opts.maxSitemapUrls}), since it is ` +
            'truncated before filtering.'
        );
      }
    } else if (this.stats.blocked > 0) {
      parts.push(
        'The site is serving a bot-protection challenge instead of content. ' +
          'This is a deliberate block on automated access, not a fault in the crawl.'
      );
    } else if (this.stats.skipped > 0) {
      parts.push(
        `${this.stats.skipped} URLs were skipped, most likely by robots.txt. ` +
          'Pass --ignore-robots if you own this site.'
      );
    }

    if (this.failures.length) {
      parts.push(`First error: ${this.failures[0].message}`);
    }

    return parts.join(' ');
  }

  // ---- entry point ------------------------------------------------------

  async run() {
    try {
      return await this.#runInner();
    } finally {
      // A launched browser must be closed on every path, including a throw,
      // or the process hangs on a live Chromium.
      if (this.renderer) await this.renderer.stop().catch(() => {});
    }
  }

  async #runInner() {
    this.stats.startedAt = Date.now();
    await fsp.mkdir(this.outDir, { recursive: true });

    if (this.opts.resume) {
      const previous = await stateLib.load(this.outDir);
      this.#priorState = previous.entries;
      if (previous.entries.size) {
        this.emit('phase', {
          phase: 'resume',
          message: `resuming: ${previous.entries.size} files known from a previous run`,
        });
      }
    }

    if (this.opts.render) {
      this.renderer = new Renderer({
        userAgent: this.opts.userAgent,
        headers: this.opts.headers,
        origin: this.start,
        timeout: this.opts.timeout,
        settleMinMs: this.opts.settleMinMs,
        // The cap must always exceed the floor, or the floor can never be
        // reached and every page would run to the cap.
        settleTimeout: Math.max(this.opts.settleTimeout, this.opts.settleMinMs + 3000),
        autoScroll: this.opts.autoScroll,
        harvest: this.opts.harvest,
        harvestMaxFiles: this.opts.harvestMaxFiles,
        harvestMaxBytes: this.opts.harvestMaxBytes,
        // A single harvested file must not be allowed past the per-file limit
        // the crawl is already enforcing, or #ingestHarvest would buffer
        // something it will only throw away.
        harvestMaxFileBytes: this.opts.maxFileBytes,
      });
      // Fail fast and clearly if Playwright isn't installed, rather than
      // after a long crawl.
      await this.renderer.start();
      this.emit('phase', { phase: 'render', message: 'JavaScript rendering enabled' });
    }

    if (this.opts.blockPrivate) {
      const reason = await privateAddressReason(this.start);
      if (reason) throw new Error(`Refusing to crawl ${this.start.hostname}: ${reason}`);
    }

    if (this.opts.respectRobots) {
      this.robots = await robotsLib.load(this.start.origin, {
        userAgent: this.opts.userAgent,
        signal: this.controller.signal,
      });
      if (this.robots.crawlDelay > 0) {
        this.emit('phase', {
          phase: 'robots',
          message: `robots.txt requests a ${this.robots.crawlDelay}s crawl delay`,
        });
        // Honour it by serialising requests rather than sleeping per worker.
        this.opts.concurrency = 1;
        this.crawlDelayMs = this.robots.crawlDelay * 1000;
      }
      if (!robotsLib.isAllowed(this.robots, this.start.pathname)) {
        throw new Error(
          `robots.txt disallows ${this.start.pathname}. Pass --ignore-robots if you own this site.`
        );
      }
    }

    this.emit('phase', { phase: 'crawl', message: `starting at ${this.start.href}` });
    this.#enqueue(this.start, 0, 'page', { seed: true });

    if (this.opts.useSitemap) await this.#seedFromSitemap();

    const worker = async () => {
      for (;;) {
        // #take() has already incremented #active for this task.
        const task = await this.#take();
        if (!task) return;

        try {
          await this.#process(task);
          if (this.crawlDelayMs) await sleep(this.crawlDelayMs);
        } catch (err) {
          this.#fail(task.url.href, err.message, err);
        } finally {
          this.#active--;
          // A worker going idle can be the event that ends the crawl, so any
          // parked worker must get a chance to re-check the exit condition.
          if (this.#queue.length || this.#active === 0) this.#wakeAll();
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.max(1, this.opts.concurrency) }, worker)
    );

    if (this.stats.files === 0) throw new Error(this.#explainEmptyResult());

    // A mirror can be a complete success by every counter here and still not
    // work, if the site's robots.txt put its JavaScript off limits. Say so
    // plainly rather than leaving the user to discover a dead page.
    if (this.stats.robotsBlockedCode > 0) {
      this.emit('warn', {
        url: this.start.href,
        message:
          `robots.txt disallowed ${this.stats.robotsBlockedCode} script/stylesheet ` +
          'files, so this mirror will render but not run. That is the site asking ' +
          'not to be crawled this way — if the site is yours, or you have permission, ' +
          're-run with --ignore-robots to capture them.',
      });
    }

    await this.#rewriteAll();
    await this.#writeEntryIndex();

    // Persist validators for the next run. Written after the rewrite pass so
    // the recorded localPath always matches a file that is fully processed.
    try {
      const unique = new Map();
      for (const [url, entry] of this.manifest) {
        unique.set(url, {
          localPath: entry.localPath,
          kind: entry.kind,
          url: entry.url,
          etag: entry.etag || null,
          lastModified: entry.lastModified || null,
          links: entry.links || null,
          rendered: entry.rendered,
        });
      }
      await stateLib.save(this.outDir, unique, { startUrl: this.start.href });
    } catch (err) {
      this.emit('warn', { url: this.start.href, message: `could not save resume state: ${err.message}` });
    }

    this.stats.finishedAt = Date.now();
    const entry = this.manifest.get(this.start.href);

    const result = {
      outDir: this.outDir,
      entryFile: entry ? entry.localPath : null,
      stats: { ...this.stats, durationMs: this.stats.finishedAt - this.stats.startedAt },
      failures: this.failures,
      stopped: this.#stopped ? this.stopReason : null,
    };

    this.emit('done', result);
    return result;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const TITLE_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * The document's <title>, for progress reporting only ("saved: Pricing").
 * A regex rather than a parse: this runs on every page, the answer is purely
 * cosmetic, and a page with no usable title simply reports none.
 */
function pageTitle(html) {
  const match = /<title\b[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(html.slice(0, 200_000));
  if (!match) return null;
  const text = match[1]
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
      if (ref[0] !== '#') return TITLE_ENTITIES[ref.toLowerCase()] ?? whole;
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 140) : null;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

module.exports = { Crawler, DEFAULTS, formatBytes, kindFromContentType, pageTitle };
