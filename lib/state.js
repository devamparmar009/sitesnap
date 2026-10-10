'use strict';

/**
 * Incremental crawl state.
 *
 * Stores what each URL resolved to last time, plus its validators, so a repeat
 * run can send `If-None-Match` / `If-Modified-Since` and take a 304 instead of
 * redownloading. On a large docs site the second run is mostly 304s.
 *
 * A 304 has no body, so anything we still need from the content — the links on
 * an HTML page, the url() references in a stylesheet — has to be reread from
 * the copy already on disk. The crawler does that; this module just remembers.
 */

const fsp = require('fs/promises');
const path = require('path');

const STATE_FILE = '.sitesnap-state.json';
const VERSION = 1;

/**
 * @param {string} outDir
 * @returns {Promise<{entries: Map<string, object>, savedAt: number|null}>}
 */
async function load(outDir) {
  const file = path.join(outDir, STATE_FILE);

  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return { entries: new Map(), savedAt: null };
  }

  try {
    const parsed = JSON.parse(raw);
    // A state file from a different layout is worse than none — a stale
    // localPath would make us "reuse" a file that isn't there.
    if (parsed.version !== VERSION) return { entries: new Map(), savedAt: null };

    return {
      entries: new Map(Object.entries(parsed.entries || {})),
      savedAt: parsed.savedAt || null,
    };
  } catch {
    return { entries: new Map(), savedAt: null };
  }
}

/**
 * @param {string} outDir
 * @param {Map<string, object>} entries  url -> {localPath, kind, etag, lastModified}
 */
async function save(outDir, entries, meta = {}) {
  const file = path.join(outDir, STATE_FILE);

  const payload = {
    version: VERSION,
    savedAt: Date.now(),
    ...meta,
    entries: Object.fromEntries(entries),
  };

  await fsp.mkdir(outDir, { recursive: true });
  // Write-then-rename so an interrupted save cannot leave a truncated file
  // that would silently disable resume on the next run.
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload));
  await fsp.rename(tmp, file);
}

/** Conditional request headers for a known URL, or {} if we have no validators. */
function conditionalHeaders(entry) {
  if (!entry) return {};
  const headers = {};
  if (entry.etag) headers['if-none-match'] = entry.etag;
  if (entry.lastModified) headers['if-modified-since'] = entry.lastModified;
  return headers;
}

module.exports = { load, save, conditionalHeaders, STATE_FILE, VERSION };
