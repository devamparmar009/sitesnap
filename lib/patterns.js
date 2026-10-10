'use strict';

/**
 * URL include/exclude filtering.
 *
 * Two deliberate semantic choices, because getting these wrong produces
 * mirrors that look fine and are quietly broken:
 *
 *   1. **Includes apply to page links only; excludes apply to everything.**
 *      An include means "only crawl these pages" — applying it to assets would
 *      starve those pages of the CSS and fonts that make them render, since
 *      styling usually lives outside the content path you asked for. An
 *      exclude is an explicit "I do not want this", so it is honoured for
 *      assets too.
 *
 *   2. **`*` crosses `/`.** When someone writes `/docs/*` they mean everything
 *      under /docs, not one level of it. Segment-bounded globbing is the right
 *      default for filesystems and the wrong one for URLs.
 */

// Regex metacharacters minus the glob ones we handle ourselves.
const ESCAPE = /[.+^${}()|[\]\\]/g;

/**
 * Compile one pattern to a RegExp.
 *
 * Glob by default; a `re:` prefix passes the rest through as a raw regex for
 * cases globs can't express (alternation, backreferences).
 *
 * Trailing `/*` also matches the bare directory, so `/docs/*` covers `/docs`,
 * `/docs/` and `/docs/a/b`. Without that, the most common pattern anyone
 * writes silently misses the section's own index page.
 */
function compile(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new Error('empty pattern');
  }
  const raw = pattern.trim();

  if (raw.startsWith('re:')) {
    const body = raw.slice(3);
    try {
      return {
        source: raw,
        re: new RegExp(body),
        // Same path-vs-URL rule as globs, applied to the regex body rather
        // than the `re:`-prefixed string. Without this, `re:^/docs/` would be
        // tested against "https://ex.com/docs/x" and never match — the prefix
        // would silently change what the pattern applies to.
        scope: /^\^?\//.test(body) ? 'path' : 'url',
      };
    } catch (err) {
      throw new Error(`invalid regex in "${raw}": ${err.message}`);
    }
  }

  let body = raw;
  let trailingDir = false;
  if (body.endsWith('/*')) {
    body = body.slice(0, -2);
    trailingDir = true;
  }

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '*') {
      // Collapse ** to the same meaning as *, so both read naturally.
      while (body[i + 1] === '*') i++;
      out += '.*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(ESCAPE, '\\$&');
    }
  }

  if (trailingDir) out += '(?:/.*)?';

  return {
    source: raw,
    re: new RegExp(`^${out}$`),
    scope: raw.startsWith('/') ? 'path' : 'url',
  };
}

/**
 * What a compiled pattern is tested against.
 *
 * Path-scoped patterns see path + query, which is what people write for
 * same-site filtering. Everything else sees the full URL, so `*.pdf` and
 * `https://cdn.example.com/*` both work.
 */
function subject(url, compiled) {
  return compiled.scope === 'path' ? `${url.pathname}${url.search}` : url.href;
}

class UrlFilter {
  /**
   * @param {string[]} include  page must match at least one, if any given
   * @param {string[]} exclude  matching any one rejects the URL
   */
  constructor(include = [], exclude = []) {
    this.include = include.filter(Boolean).map(compile);
    this.exclude = exclude.filter(Boolean).map(compile);
  }

  get active() {
    return this.include.length > 0 || this.exclude.length > 0;
  }

  /** @returns {string|null} the pattern that rejected it, or null to allow */
  rejects(url, kind) {
    for (const p of this.exclude) {
      if (p.re.test(subject(url, p))) return `excluded by ${p.source}`;
    }

    // Includes gate pages only — see the note at the top of this file.
    if (kind === 'page' && this.include.length) {
      const hit = this.include.some((p) => p.re.test(subject(url, p)));
      if (!hit) return 'not matched by any --include';
    }
    return null;
  }
}

module.exports = { UrlFilter, compile, subject };
