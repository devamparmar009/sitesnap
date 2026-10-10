'use strict';

/**
 * URL -> local file path mapping.
 *
 * This module is the security core of the crawler. Every byte we write to disk
 * lands at a path computed here, and the input is attacker-influenced (a remote
 * server controls its own URLs, redirects and link targets). Two rules hold:
 *
 *   1. Every path segment is sanitized in isolation, so no segment can contain
 *      a separator, a traversal token, or a character that means something to
 *      a filesystem.
 *   2. `resolveInside()` re-checks the assembled result against the job root.
 *      Rule 1 should make it unreachable; it runs anyway.
 */

const path = require('path');
const crypto = require('crypto');

// Windows-illegal characters plus separators and control codes. We apply the
// Windows rules everywhere so an archive made on macOS still unzips on Windows.
const ILLEGAL = /[<>:"|?*\\/\x00-\x1f\x7f]/g;
const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_SEGMENT = 100;
const MAX_STEM = 60;

function shortHash(input, len = 8) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, len);
}

/**
 * Make one path segment safe. Never returns '', '.', '..', or anything
 * containing a separator.
 */
function safeSegment(raw) {
  let s = raw;

  // URL segments arrive percent-encoded. Decode so files are human-readable,
  // but a malformed escape must not throw.
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep the raw form */
  }

  s = s.replace(ILLEGAL, '_').trim();

  // Strip leading dots so we can never produce '.', '..', or a dotfile that
  // shadows real config (e.g. a URL segment literally named '.git').
  s = s.replace(/^\.+/, '');

  // Trailing dots and spaces are silently dropped by Windows; drop them
  // ourselves so the name on disk matches the name in the archive.
  s = s.replace(/[. ]+$/, '');

  if (RESERVED_WIN.test(s)) s = `_${s}`;
  if (!s) s = '_';

  if (s.length > MAX_SEGMENT) {
    s = `${s.slice(0, MAX_SEGMENT - 9)}-${shortHash(raw)}`;
  }

  return s;
}

/**
 * Host segment for the output tree. Ports become '_8080' rather than ':8080'
 * because ':' is illegal on Windows and awkward in shells everywhere.
 */
function hostSegment(url) {
  const host = url.hostname.replace(ILLEGAL, '_');
  return url.port ? `${host}_${url.port}` : host;
}

function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);

/**
 * Map a URL plus its observed content type to a repo-relative local path.
 *
 * Mirrors wget's --adjust-extension behaviour: a URL with no usable extension
 * that serves HTML becomes `.html` on disk, so the mirror opens in a browser.
 *
 * @param {URL} url            absolute URL, already normalized
 * @param {string} kind        'html' | 'css' | 'other'
 * @returns {string}           POSIX-style relative path
 */
function urlToLocalPath(url, kind = 'other') {
  const segments = [hostSegment(url)];

  const rawParts = url.pathname.split('/').filter(Boolean);
  const endsWithSlash = url.pathname.endsWith('/') || rawParts.length === 0;

  for (const part of rawParts) segments.push(safeSegment(part));

  // A directory-style URL has no filename of its own.
  if (endsWithSlash) segments.push('index.html');

  let filename = segments.pop();
  let [stem, ext] = splitExt(filename);

  // Two distinct URLs may differ only in query string. Fold the query into the
  // filename so they do not overwrite each other, but keep it short and safe.
  if (url.search) {
    const q = url.search.slice(1);
    const tag = q.length <= 24 ? safeSegment(q) : shortHash(q);
    stem = `${stem}@${tag}`;
  }

  if (stem.length > MAX_STEM) {
    stem = `${stem.slice(0, MAX_STEM - 9)}-${shortHash(filename)}`;
  }

  // --adjust-extension: give the file an extension matching what was served.
  if (kind === 'html' && !HTML_EXT.has(ext.toLowerCase())) {
    ext = `${ext}.html`;
  } else if (kind === 'css' && ext.toLowerCase() !== '.css') {
    ext = `${ext}.css`;
  }

  filename = `${stem}${ext}` || 'index.html';
  segments.push(filename);

  return segments.join('/');
}

/**
 * Map a URL *directory* to its local equivalent, with no filename appended.
 *
 * Needed for asset bases rather than assets: a bundler's `publicPath` names a
 * directory ("/_next/") that never appears in the manifest, because no request
 * is ever made for it. Rewriting that base to point at local files therefore
 * cannot go through the manifest and has to be computed directly — using the
 * same per-segment sanitizer as `urlToLocalPath`, or the base would point
 * somewhere the assets under it were not written.
 */
function urlToLocalDir(url) {
  const segments = [hostSegment(url)];
  for (const part of url.pathname.split('/').filter(Boolean)) {
    segments.push(safeSegment(part));
  }
  return segments.join('/');
}

/**
 * Resolve `relative` under `root`, guaranteeing the result stays inside.
 * Throws rather than returning a path outside the job directory.
 */
function resolveInside(root, relative) {
  const base = path.resolve(root);
  const full = path.resolve(base, relative);

  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`path escapes output directory: ${relative}`);
  }
  return full;
}

/**
 * Compute the href to write into a rewritten document so that `fromPath`
 * points at `toPath` on the local filesystem.
 */
function relativeLink(fromPath, toPath) {
  const fromDir = path.posix.dirname(fromPath);
  const rel = path.posix.relative(fromDir, toPath);
  return rel || path.posix.basename(toPath);
}

module.exports = {
  urlToLocalPath,
  urlToLocalDir,
  resolveInside,
  relativeLink,
  safeSegment,
  hostSegment,
  shortHash,
};
