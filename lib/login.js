'use strict';

/**
 * "Sign in first": borrow a session from a real browser window.
 *
 * The CLI covers pages behind a login with `--cookie`, which means opening
 * devtools and copying a header. Nobody outside engineering will do that. So
 * the app opens a normal browser window on the site, the person signs in the
 * way they always do, and sitesnap takes the resulting cookies for that site.
 *
 * What it never does: see or type the password (the person types it into the
 * site's own page), write the cookies to disk, or send them anywhere but the
 * site itself. They live in memory for one download and go to the starting
 * origin only, the same rule `--cookie` has always followed.
 */

const { loadPlaywright } = require('./engine');

/** Does a cookie's Domain attribute cover this host? */
function domainMatches(host, cookieDomain) {
  const domain = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  return Boolean(domain) && (h === domain || h.endsWith(`.${domain}`));
}

class LoginSession {
  /** @param {string} url  the page the person wants to save */
  constructor(url) {
    this.url = new URL(url);
    this.browser = null;
    this.context = null;
    this.lastCookies = [];
    this.poll = null;
    this.closed = false;
  }

  async open() {
    const pw = loadPlaywright({ fresh: true });
    if (!pw) throw new Error('Playwright is not installed');

    this.browser = await pw.chromium.launch({ headless: false });
    this.browser.on('disconnected', () => {
      this.closed = true;
      clearInterval(this.poll);
    });
    this.context = await this.browser.newContext({ viewport: null });
    const page = await this.context.newPage();
    // Keep a running copy of the cookies, so a person who signs in and then
    // simply closes the window has not thrown their session away.
    this.poll = setInterval(() => this.#snapshot(), 1500);
    page.goto(this.url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  }

  async #snapshot() {
    if (this.closed || !this.context) return;
    try {
      this.lastCookies = await this.context.cookies();
    } catch {
      // the window is closing; keep the last good copy
    }
  }

  /**
   * Take the cookies for the site and close the window.
   * @returns {Promise<{header: string|null, count: number}>}
   */
  async finish() {
    await this.#snapshot();
    const mine = this.lastCookies.filter((c) => domainMatches(this.url.hostname, c.domain));
    await this.close();
    if (!mine.length) return { header: null, count: 0 };
    return { header: mine.map((c) => `${c.name}=${c.value}`).join('; '), count: mine.length };
  }

  async close() {
    clearInterval(this.poll);
    this.closed = true;
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
  }
}

module.exports = { LoginSession, domainMatches };
