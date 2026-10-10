'use strict';

/**
 * "Modern site mode": the optional browser engine, set up from a button.
 *
 * Rendering JavaScript-built sites needs Playwright and a Chromium build,
 * roughly 150 MB together. That is too much to force on everyone, so it stays
 * optional, but "run npm install playwright && npx playwright install
 * chromium in a terminal" is not an instruction most people can follow.
 *
 * So the app installs it itself, into a per-user folder outside the project:
 *
 *   1. playwright-core, downloaded from the npm registry as a tarball,
 *      checked against the registry's published sha512, and unpacked in pure
 *      Node (no npm needed, which the desktop app does not have);
 *   2. Chromium, via playwright-core's own installer script.
 *
 * playwright-core has no dependencies and the same API as `playwright`, so the
 * renderer can use whichever one it finds.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { createRequire } = require('module');
const { runNodeScript } = require('./system');

const REGISTRY = 'https://registry.npmjs.org/playwright-core';
const MAX_TARBALL = 60 * 1024 * 1024;

/** Per-user application data folder, following each platform's convention. */
function appDataDir() {
  if (process.env.SITESNAP_HOME) return path.resolve(process.env.SITESNAP_HOME);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'sitesnap');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'sitesnap');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'sitesnap');
}

function engineDir() {
  return path.join(appDataDir(), 'engine');
}

let cached = null;

/**
 * Find a usable Playwright: the project's own install first (developers who
 * ran npm install keep working exactly as before), then the app's engine.
 * @returns {object|null} the module, or null
 */
function loadPlaywright({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const attempts = [
    () => require('playwright'),
    () => require('playwright-core'),
    () => createRequire(path.join(engineDir(), 'package.json'))('playwright-core'),
  ];
  for (const attempt of attempts) {
    try {
      cached = attempt();
      return cached;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** Is modern site mode ready to use? */
function status() {
  const pw = loadPlaywright({ fresh: true });
  if (!pw) return { ready: false, library: false, browser: false };
  let browser = false;
  try {
    const exe = pw.chromium.executablePath();
    browser = Boolean(exe && fs.existsSync(exe));
  } catch {
    browser = false;
  }
  return { ready: browser, library: true, browser };
}

// ---- download -----------------------------------------------------------

/** GET over IPv4, following redirects, with a size cap. */
function download(url, { cap = MAX_TARBALL, onProgress, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, headers: { 'user-agent': 'sitesnap-engine-installer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, { cap, onProgress, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      const chunks = [];
      let got = 0;
      res.on('data', (chunk) => {
        got += chunk.length;
        if (got > cap) {
          req.destroy(new Error('download larger than expected'));
          return;
        }
        chunks.push(chunk);
        if (onProgress) onProgress(got, total);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}

// ---- tar ----------------------------------------------------------------

function field(buf, start, length) {
  const raw = buf.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function parsePax(data) {
  const out = {};
  let text = data.toString('utf8');
  while (text.length) {
    const space = text.indexOf(' ');
    const len = Number(text.slice(0, space));
    if (!len || space < 0) break;
    const record = text.slice(space + 1, len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    text = text.slice(len);
  }
  return out;
}

/**
 * Walk a (decompressed) tar archive. Yields regular files and directories;
 * links and device entries are not yielded at all.
 */
function* tarEntries(buf) {
  let offset = 0;
  let longName = null;
  let paxPath = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const name = field(header, 0, 100);
    const size = parseInt(field(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(header, 345, 155);
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = field(data, 0, size);
      continue;
    }
    if (type === 'x') {
      paxPath = parsePax(data).path || null;
      continue;
    }
    if (type === 'g') continue;

    const full = paxPath || longName || (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    longName = null;
    if (type === '0' || type === '\0' || type === '5') {
      yield { name: full, type: type === '5' ? 'dir' : 'file', data };
    }
  }
}

/**
 * Unpack an npm tarball into `dest`, dropping the leading `package/`.
 * Every entry is resolved and checked to stay inside `dest`: a tarball is
 * remote input, and `../../` in an entry name is the classic way to write
 * outside the folder it is being unpacked into.
 */
async function extractNpmTarball(tgz, dest) {
  const tar = zlib.gunzipSync(tgz);
  const root = path.resolve(dest);
  for (const entry of tarEntries(tar)) {
    const rel = entry.name.replace(/^package\//, '');
    if (!rel || rel.includes('\0')) continue;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`unsafe path in package: ${entry.name}`);
    }
    if (entry.type === 'dir') {
      await fsp.mkdir(target, { recursive: true });
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, entry.data);
    }
  }
}

function verifyIntegrity(buf, integrity) {
  const match = /^sha512-(.+)$/.exec(String(integrity || ''));
  if (!match) throw new Error('the registry did not publish a checksum for this package');
  const actual = crypto.createHash('sha512').update(buf).digest('base64');
  if (actual !== match[1]) throw new Error('the downloaded package did not match its checksum');
}

// ---- install ------------------------------------------------------------

/**
 * playwright-core's installer script: the app's engine copy if there is one,
 * else the project's own (a developer who installed `playwright` but never
 * downloaded the browser). createRequire rather than require.resolve, because
 * inside the packaged app the plain `require` can only load Node built-ins.
 */
function cliPath(dir) {
  const roots = [path.join(dir, 'package.json'), __filename];
  for (const root of roots) {
    try {
      return path.join(path.dirname(createRequire(root).resolve('playwright-core/package.json')), 'cli.js');
    } catch {
      // try the next root
    }
  }
  throw new Error('the browser engine installer could not be found');
}

/**
 * Download playwright-core from the npm registry into `dir`, verified
 * against the registry's sha512, unpacked without npm.
 * @returns {Promise<string>} the installed version
 */
async function installLibrary(dir, onProgress = () => {}) {
  onProgress({ step: 'library', percent: 0, message: 'Getting the browser engine' });
  const meta = JSON.parse((await download(`${REGISTRY}/latest`, { cap: 2 * 1024 * 1024 })).toString('utf8'));
  const tarball = await download(meta.dist.tarball, {
    onProgress: (got, total) =>
      onProgress({
        step: 'library',
        percent: total ? Math.round((got / total) * 100) : null,
        message: 'Getting the browser engine',
      }),
  });
  verifyIntegrity(tarball, meta.dist.integrity);

  const pkgDir = path.join(dir, 'node_modules', 'playwright-core');
  await fsp.rm(pkgDir, { recursive: true, force: true });
  await extractNpmTarball(tarball, pkgDir);
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ private: true, dependencies: { 'playwright-core': meta.version } }, null, 2)
  );
  return meta.version;
}

let installing = null;

/**
 * Install modern site mode. Safe to call repeatedly: a second call while one
 * is running returns the same promise, and finished steps are skipped.
 *
 * @param {(update: {step: string, percent: number|null, message: string}) => void} [onProgress]
 */
function install(onProgress = () => {}) {
  if (!installing) {
    installing = doInstall(onProgress).finally(() => {
      installing = null;
    });
  }
  return installing;
}

async function doInstall(onProgress) {
  const dir = engineDir();
  await fsp.mkdir(dir, { recursive: true });

  if (!loadPlaywright({ fresh: true })) {
    await installLibrary(dir, onProgress);
    cached = null;
  }

  const pw = loadPlaywright({ fresh: true });
  if (!pw) throw new Error('the browser engine could not be loaded after installing it');

  if (!status().browser) {
    onProgress({ step: 'browser', percent: 0, message: 'Downloading the built-in browser (about 150 MB)' });
    const cli = cliPath(dir);
    const lines = [];
    const code = await runNodeScript(cli, ['install', 'chromium'], {
      onLine: (line) => {
        lines.push(line);
        if (lines.length > 30) lines.shift();
        const pct = /(\d{1,3})%/.exec(line);
        onProgress({
          step: 'browser',
          percent: pct ? Math.min(100, Number(pct[1])) : null,
          message: 'Downloading the built-in browser (about 150 MB)',
        });
      },
    });
    if (code !== 0) {
      throw new Error(`the browser download stopped (exit ${code}): ${lines.slice(-3).join(' | ')}`);
    }
  }

  const final = status();
  if (!final.ready) throw new Error('modern site mode is still not ready after installing');
  onProgress({ step: 'done', percent: 100, message: 'Modern site mode is ready' });
  return final;
}

module.exports = {
  appDataDir,
  engineDir,
  loadPlaywright,
  status,
  install,
  installLibrary,
  cliPath,
  extractNpmTarball,
  tarEntries,
  verifyIntegrity,
};
