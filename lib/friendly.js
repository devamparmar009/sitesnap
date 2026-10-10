'use strict';

/**
 * Plain-language explanations for everything that can go wrong.
 *
 * The crawler reports failures the way an engineer wants them: "fetch failed",
 * "HTTP 403", "robots.txt disallows /". Those are accurate and useless to
 * someone who just wants a copy of a website. This module turns a failure into
 * three things a person can act on:
 *
 *   title    what happened, in one short sentence
 *   message  why, and what to try, with no jargon
 *   action   the one button that would most likely fix it, if any
 *
 * The original text always travels along as `detail`, so nothing is hidden
 * from someone who wants it; it is just not the first thing they read.
 */

const NOT_FOUND = new Set(['ENOTFOUND']);
const OFFLINE = new Set(['EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']);
const REFUSED = new Set(['ECONNREFUSED', 'ECONNRESET']);
const TIMEOUT = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const CERT = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i;

/** Actions the UI knows how to offer. Anything else is shown without a button. */
const ACTIONS = {
  retry: 'Try again',
  login: 'Sign in first',
  modern: 'Turn on modern site mode',
  install: 'Set up modern site mode',
  robots: 'Ignore the site’s robot rules',
  settings: 'Change what to save',
};

function make(kind, title, message, action = null, detail = '') {
  return {
    kind,
    title,
    message,
    action,
    actionLabel: action ? ACTIONS[action] : null,
    detail: detail || '',
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'that address';
  }
}

/**
 * Explain a network-level problem (no HTTP response at all).
 * @param {string|null} code  e.g. ENOTFOUND, from err.cause.code
 */
function explainNetwork(code, host, detail = '') {
  const c = String(code || '');
  if (NOT_FOUND.has(c)) {
    return make(
      'not-found',
      'We couldn’t find that website.',
      `Nothing answers at ${host}. Check the spelling, or open it in your browser to make sure it exists.`,
      null,
      detail
    );
  }
  if (OFFLINE.has(c)) {
    return make(
      'offline',
      'You seem to be offline.',
      'sitesnap needs the internet to make the copy. Check your connection, then try again.',
      'retry',
      detail
    );
  }
  if (REFUSED.has(c)) {
    return make(
      'refused',
      'The website isn’t answering.',
      `${host} exists but turned the connection away. It may be down for a moment. Try again in a few minutes.`,
      'retry',
      detail
    );
  }
  if (TIMEOUT.has(c) || /timed? ?out|stalled|TimeoutError/i.test(detail)) {
    return make(
      'timeout',
      'The website took too long to answer.',
      `${host} is very slow right now. Try again, or choose “Go gently” in More options so it has more time.`,
      'retry',
      detail
    );
  }
  if (CERT.test(c) || CERT.test(detail)) {
    return make(
      'certificate',
      'This website’s security certificate is broken.',
      'Your browser would warn you about this site too. sitesnap won’t copy a site it can’t confirm is the real one.',
      null,
      detail
    );
  }
  return null;
}

/** Explain an HTTP status the site answered with. */
function explainStatus(status, host, detail = '') {
  if (status === 401) {
    return make(
      'login',
      'This page needs you to sign in.',
      `${host} only shows this to signed-in visitors. Sign in once in a browser window, and sitesnap will save it as you see it.`,
      'login',
      detail
    );
  }
  if (status === 404 || status === 410) {
    return make(
      'missing',
      'That page doesn’t exist.',
      'The site says there is nothing at this address. Check the link, or try the site’s home page instead.',
      null,
      detail
    );
  }
  if (status === 403 || status === 406 || status === 418 || status === 451) {
    return make(
      'refused-client',
      'This website turned sitesnap away.',
      `${host} refuses automatic copying, even after sitesnap tried looking like a few different browsers. If the site is yours, allow it in your hosting settings.`,
      null,
      detail
    );
  }
  if (status === 429) {
    return make(
      'rate-limited',
      'The website asked us to slow down.',
      'It has had too many visits from this computer. Wait a few minutes, then try again with “Go gently” switched on.',
      'retry',
      detail
    );
  }
  if (status >= 500) {
    return make(
      'server-error',
      'The website is having problems.',
      `${host} answered with an error of its own. This is on their side. Try again later.`,
      'retry',
      detail
    );
  }
  return null;
}

/**
 * Explain why a crawl produced nothing (or failed outright).
 *
 * @param {object} input
 * @param {string} input.url           the address the person asked for
 * @param {string} [input.message]     the thrown error's message
 * @param {object} [input.stats]       crawler.stats
 * @param {Array}  [input.failures]    crawler.failures ({url, message, code})
 * @param {string|null} [input.code]   a network code, if known directly
 */
function explainFailure({ url, message = '', stats = {}, failures = [], code = null } = {}) {
  const host = hostOf(url);
  const first = failures[0] || null;
  const detail = message || (first && first.message) || '';

  if (/Playwright/i.test(message)) {
    return make(
      'install',
      'Modern site mode isn’t set up yet.',
      'This site needs a built-in browser to show its pages. It is a one-time download of about 150 MB.',
      'install',
      detail
    );
  }

  if (/^Refusing to crawl/i.test(message)) {
    return make(
      'private',
      'That address points inside your own network.',
      'This copy of sitesnap is set up to only save public websites.',
      null,
      detail
    );
  }

  if (/robots\.txt disallows/i.test(message)) {
    return make(
      'robots',
      'This website asks not to be copied.',
      'Its robot rules ask tools like sitesnap to stay away from this page. If the site is yours, or you have permission, you can tell sitesnap to ignore those rules.',
      'robots',
      detail
    );
  }

  if (stats.blocked > 0) {
    return make(
      'blocked',
      'This website blocks automatic copying.',
      `${host} shows a “checking your browser” screen to stop tools like this one. sitesnap respects that and won’t try to get around it. If the site is yours, use your host’s export or allow sitesnap in its settings.`,
      null,
      detail
    );
  }

  if (stats.filtered > 0 && !stats.files) {
    return make(
      'filtered',
      'Your choices left nothing to save.',
      'The “only save” and “skip” rules in More options ruled out every page. Loosen them and try again.',
      'settings',
      detail
    );
  }

  const net = explainNetwork(code || (first && first.code), host, detail);
  if (net) return net;

  const status = Number((/HTTP (\d{3})/.exec(detail) || [])[1]);
  if (status) {
    const byStatus = explainStatus(status, host, detail);
    if (byStatus) return byStatus;
  }

  if (stats.skipped > 0 && !stats.files) {
    return make(
      'robots',
      'This website asks not to be copied.',
      'Its robot rules asked sitesnap to skip every page it found. If the site is yours, or you have permission, you can tell sitesnap to ignore those rules.',
      'robots',
      detail
    );
  }

  if (/fetch failed|network|socket/i.test(detail)) {
    return make(
      'unreachable',
      'We couldn’t reach that website.',
      `Something between this computer and ${host} got in the way. Check the address and your connection, then try again.`,
      'retry',
      detail
    );
  }

  return make(
    'unknown',
    'Something went wrong.',
    'sitesnap couldn’t finish this copy. Try again, and if it keeps happening, the technical details below will help.',
    'retry',
    detail
  );
}

/**
 * Turn the per-file warnings of a finished crawl into a short, readable list:
 * "4 pictures couldn't be downloaded", not forty URLs. Order is by how much a
 * person would care.
 *
 * @param {object} stats     crawler.stats
 * @param {Array}  failures  crawler.failures
 */
function summarizeProblems(stats = {}, failures = []) {
  const notes = [];
  const missing = failures.filter((f) => f.message !== 'cancelled');

  if (stats.robotsBlockedCode > 0) {
    notes.push({
      tone: 'warn',
      text: `The site’s robot rules kept ${count(stats.robotsBlockedCode, 'script')} out, so pages will look right but buttons and menus may not work.`,
      action: 'robots',
      actionLabel: ACTIONS.robots,
    });
  }
  if (stats.blocked > 0) {
    notes.push({
      tone: 'warn',
      text: `${count(stats.blocked, 'page')} showed a “checking your browser” screen instead of content.`,
    });
  }
  if (missing.length) {
    notes.push({
      tone: 'info',
      text: `${count(missing.length, 'file')} couldn’t be downloaded. Those parts will load from the live website when you are online.`,
    });
  }
  if (stats.partial > 0) {
    notes.push({
      tone: 'info',
      text: `${count(stats.partial, 'page')} kept loading forever, so the copy of ${stats.partial === 1 ? 'it' : 'them'} may be missing a piece.`,
    });
  }
  if (stats.filtered > 0) {
    notes.push({
      tone: 'info',
      text: `${count(stats.filtered, 'address', 'addresses')} skipped because of your “only save” and “skip” rules.`,
    });
  }
  return notes;
}

function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

module.exports = { explainFailure, explainNetwork, explainStatus, summarizeProblems, ACTIONS };
