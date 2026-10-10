'use strict';

/**
 * The library: every site you have saved, kept in a real folder.
 *
 * The web UI used to stage mirrors in a temp directory and delete them an hour
 * later, which is fine for a developer grabbing a zip and wrong for everyone
 * else. Someone who saves a website expects to find it again next week. So
 * each snapshot is a folder a person can recognise in Finder or Explorer:
 *
 *   Documents/sitesnap/
 *     example.com 2026-10-08 10-42/
 *       Open me.html          <- double-click to start reading
 *       site/                 <- the mirror itself (serve this root)
 *       .sitesnap/
 *         snapshot.json       <- what this is, when, how it went
 *         icon.png, cover.jpg <- for the library card, if the site had them
 *
 * Folders are found again by reading their snapshot.json, so the id in the URL
 * is never mapped onto a path: a request can only reach a folder this module
 * already registered.
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const META_DIR = '.sitesnap';
const META_FILE = 'snapshot.json';
const SITE_DIR = 'site';
const OPEN_ME = 'Open me.html';
const VERSION = 1;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where the library lives when nothing says otherwise. */
function defaultRoot() {
  const docs = path.join(os.homedir(), 'Documents');
  return path.join(docs, 'sitesnap');
}

const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
};

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}-${p(date.getMinutes())}`;
}

function safeName(host) {
  return String(host || 'site').toLowerCase().replace(/[^a-z0-9.-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'site';
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The page a person double-clicks. It forwards to the saved start page and,
 * in case the forward is blocked, says plainly where to click.
 *
 * @param {string} target  relative URL of the start page from this file
 * @param {string} title
 */
function openMeHtml(target, title) {
  const href = target
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${escapeHtml(href)}">
<title>${escapeHtml(title)} (saved copy)</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11131c;color:#eef0f6;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:34rem;padding:2rem}
a{color:#f4a77a}
p{color:#b9bccb}
</style></head><body><main>
<h1>${escapeHtml(title)}</h1>
<p>Opening your saved copy. If nothing happens, <a href="${escapeHtml(href)}">click here to open it</a>.</p>
<p>Some pages work best when opened from the sitesnap app, under Your library.</p>
</main></body></html>
`;
}

class Library {
  /** @param {string} root  absolute path of the library folder */
  constructor(root = defaultRoot()) {
    this.root = path.resolve(root);
    /** @type {Map<string, {record: object, dir: string}>} */
    this.items = new Map();
  }

  /** Load every snapshot already on disk. Safe to call on an empty or missing folder. */
  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    const entries = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      const record = await readJson(path.join(dir, META_DIR, META_FILE));
      if (!record || record.version !== VERSION || !ID_RE.test(String(record.id))) continue;

      // A snapshot still marked running was interrupted (the app quit or
      // crashed mid-download). Whatever reached disk is still a usable copy.
      if (record.status === 'running') {
        record.status = record.stats && record.stats.files > 0 ? 'stopped' : 'failed';
        record.stopReason = 'sitesnap closed before it finished';
        await writeJson(path.join(dir, META_DIR, META_FILE), record).catch(() => {});
      }
      this.items.set(record.id, { record, dir });
    }
    return this;
  }

  /** Newest first. Records only; paths stay inside this module. */
  list() {
    return [...this.items.values()]
      .map((item) => item.record)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) {
    if (!ID_RE.test(String(id))) return null;
    return this.items.get(id)?.record || null;
  }

  /** Absolute folder of a snapshot, or null. */
  dirOf(id) {
    if (!ID_RE.test(String(id))) return null;
    return this.items.get(id)?.dir || null;
  }

  /** Absolute path of a snapshot's mirror root. */
  siteDirOf(id) {
    const dir = this.dirOf(id);
    return dir ? path.join(dir, SITE_DIR) : null;
  }

  /**
   * Register a new snapshot and create its folder.
   * @param {object} fields  url, host, title, options, ...
   */
  async create(fields) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const base = `${safeName(fields.host)} ${stamp(new Date(now))}`;

    let name = base;
    for (let n = 2; ; n++) {
      try {
        await fsp.mkdir(path.join(this.root, name), { recursive: false });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' || n > 99) throw err;
        name = `${base} (${n})`;
      }
    }

    const dir = path.join(this.root, name);
    await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
    await fsp.mkdir(path.join(dir, SITE_DIR), { recursive: true });

    const record = {
      version: VERSION,
      id,
      folder: name,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      icon: null,
      cover: null,
      stats: { pages: 0, files: 0, bytes: 0, failed: 0, durationMs: 0 },
      notes: [],
      pages: [],
      ...fields,
    };
    this.items.set(id, { record, dir });
    await this.save(id);
    return record;
  }

  /** Merge fields into a snapshot's record and persist it. */
  async update(id, fields = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    Object.assign(item.record, fields, { updatedAt: Date.now() });
    await this.save(id);
    return item.record;
  }

  async save(id) {
    const item = this.items.get(id);
    if (!item) return;
    await writeJson(path.join(item.dir, META_DIR, META_FILE), item.record);
  }

  /**
   * Store the site's icon or preview image for the library card.
   * @param {'icon'|'cover'} kind
   * @param {string} dataUrl  as produced by inspect()
   */
  async saveImage(id, kind, dataUrl) {
    const item = this.items.get(id);
    if (!item || !dataUrl || (kind !== 'icon' && kind !== 'cover')) return null;
    const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl);
    if (!match) return null;
    const ext = IMAGE_EXT[match[1].toLowerCase()];
    if (!ext) return null;
    const file = `${kind}.${ext}`;
    await fsp.writeFile(path.join(item.dir, META_DIR, file), Buffer.from(match[2], 'base64'));
    item.record[kind] = file;
    await this.save(id);
    return file;
  }

  /** Absolute path of a stored image, only if it is one this module wrote. */
  imagePath(id, kind) {
    const item = this.items.get(id);
    const file = item?.record?.[kind];
    if (!file || !/^(icon|cover)\.[a-z]+$/.test(file)) return null;
    return path.join(item.dir, META_DIR, file);
  }

  /**
   * Write the double-clickable "Open me.html" beside the site folder.
   * @param {string} entry  the start page, relative to the mirror root
   */
  async writeOpenMe(id, entry, title) {
    const item = this.items.get(id);
    if (!item || !entry) return;
    await fsp.writeFile(path.join(item.dir, OPEN_ME), openMeHtml(`${SITE_DIR}/${entry}`, title), 'utf8');
  }

  /** Permanently delete a snapshot's folder. */
  async remove(id) {
    const item = this.items.get(id);
    if (!item) return false;
    // Belt and braces: never delete anything that is not a direct child of
    // the library root, whatever a record claims.
    const rel = path.relative(this.root, item.dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return false;
    this.items.delete(id);
    await fsp.rm(item.dir, { recursive: true, force: true });
    return true;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

module.exports = { Library, defaultRoot, openMeHtml, OPEN_ME, SITE_DIR, META_DIR, ID_RE };
