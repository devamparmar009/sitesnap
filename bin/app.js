#!/usr/bin/env node
'use strict';

/**
 * sitesnap as a double-click app.
 *
 * This is the entry point of the packaged desktop build (see
 * scripts/build-app.mjs), and also works from a checkout: `npm run app`.
 * Differences from `npm start`:
 *
 *   - it opens your browser on the app by itself;
 *   - the page gets a Quit button, since there is no terminal to Ctrl-C;
 *   - starting it a second time just reopens the window that is already
 *     running, instead of failing on a busy port.
 *
 * Inside the packaged build the page's files (public/) travel as embedded
 * assets. They are unpacked once into the per-user data folder and served
 * from there.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function sea() {
  try {
    const mod = require('node:sea');
    return mod.isSea() ? mod : null;
  } catch {
    return null;
  }
}

/**
 * `--sitesnap-run <script> [...args]`: behave as plain Node for one script.
 * The packaged app has no separate `node` to run the browser-engine
 * installer with, so lib/system.js asks the app itself to do it.
 */
function runScript(argv) {
  const script = path.resolve(argv[0]);
  require('dns').setDefaultResultOrder('ipv4first');
  process.argv = [process.argv[0], script, ...argv.slice(1)];
  require('module').createRequire(script)(script);
}

/** Unpack the embedded page files, once per build. */
function unpackPublic(seaModule) {
  const manifest = JSON.parse(Buffer.from(seaModule.getAsset('public-manifest.json')).toString('utf8'));
  const hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 12);
  const { appDataDir } = require('../lib/engine');
  const dir = path.join(appDataDir(), 'app', hash, 'public');
  const marker = path.join(dir, '.complete');
  if (!fs.existsSync(marker)) {
    for (const rel of manifest.files) {
      const target = path.join(dir, rel);
      if (!target.startsWith(dir + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(seaModule.getAsset(`public/${rel}`)));
    }
    fs.writeFileSync(marker, hash);
  }
  return dir;
}

async function main() {
  // A double-clicked app inherits no shell settings. On networks where IPv6
  // connects but then stalls on large transfers, every request would hang
  // with nothing to show for it; virtually every site also answers on IPv4.
  require('dns').setDefaultResultOrder('ipv4first');

  const seaModule = sea();
  if (seaModule) process.env.SITESNAP_PUBLIC = unpackPublic(seaModule);
  process.env.SITESNAP_APP = '1';

  const system = require('../lib/system');
  const { start } = require('./server');
  const port = Number.parseInt(process.env.PORT || '4000', 10);
  const open = process.env.SITESNAP_OPEN !== '0';

  try {
    const { url, shutdown } = await start();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    if (open) await system.openUrl(url);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      // Already running: show it rather than complain.
      if (open) await system.openUrl(`http://127.0.0.1:${port}/`);
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  }
}

if (process.argv[2] === '--sitesnap-run') {
  runScript(process.argv.slice(3));
} else {
  main();
}
