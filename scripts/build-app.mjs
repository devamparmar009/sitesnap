#!/usr/bin/env node
/**
 * Build sitesnap as a double-click desktop app.
 *
 *   npm run build:app
 *
 * Output (macOS):  dist/sitesnap.app  and  dist/sitesnap-mac.zip
 * Output (Linux):  dist/sitesnap      (a single executable)
 *
 * How: the app is bundled into one script with esbuild, the page files are
 * embedded as assets, and both are packed into a copy of the official Node.js
 * runtime as a Node "single executable application". Nobody who receives the
 * app needs Node, npm or a terminal.
 *
 * The runtime is the official build from nodejs.org for the same version and
 * platform as the Node running this script, checked against the SHA-256 that
 * nodejs.org publishes. (Package-manager builds of Node, Homebrew's included,
 * are often compiled without single-executable support, so the local `node`
 * cannot be used directly.)
 *
 * This is a build tool, so unlike the app itself it does run other programs:
 * tar, codesign, sips, iconutil and ditto, each with a fixed argument list.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, '.build-cache');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const version = process.version;
const platform = process.platform;
const arch = process.arch;

function log(step, detail = '') {
  console.log(`  ${step.padEnd(10)} ${detail}`);
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { family: 4, headers: { 'user-agent': 'sitesnap-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(get(new URL(res.headers.location, url).href, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url}: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** The official Node.js binary for this platform, downloaded once and verified. */
async function officialNode() {
  const ext = platform === 'linux' ? 'tar.xz' : 'tar.gz';
  const name = `node-${version}-${platform}-${arch}`;
  const file = `${name}.${ext}`;
  const binary = path.join(cache, name, 'bin', 'node');
  if (fs.existsSync(binary)) return binary;

  await fsp.mkdir(cache, { recursive: true });
  const base = `https://nodejs.org/dist/${version}`;
  log('runtime', `downloading ${file} from nodejs.org`);
  const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8');
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`));
  if (!line) throw new Error(`nodejs.org publishes no ${file}`);
  const expected = line.split(/\s+/)[0];

  const archive = await get(`${base}/${file}`);
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`${file} does not match its published SHA-256`);
  log('runtime', `verified sha256 ${actual.slice(0, 16)}...`);

  const archivePath = path.join(cache, file);
  await fsp.writeFile(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', cache]);
  await fsp.rm(archivePath);
  return binary;
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

async function bundle() {
  const esbuild = require('esbuild');
  const outfile = path.join(dist, 'sitesnap.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'bin', 'app.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Loaded from the per-user engine folder at run time, never bundled.
    external: ['playwright', 'playwright-core', 'bufferutil', 'utf-8-validate', 'fsevents'],
    legalComments: 'none',
    logLevel: 'error',
  });
  log('bundle', `${(fs.statSync(outfile).size / 1024).toFixed(0)} KB`);
  return outfile;
}

async function seaConfig() {
  const publicDir = path.join(root, 'public');
  const files = await walk(publicDir);
  const manifest = { version: pkg.version, files };
  const manifestPath = path.join(dist, 'public-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));

  const assets = { 'public-manifest.json': manifestPath };
  for (const rel of files) assets[`public/${rel}`] = path.join(publicDir, rel);

  const config = {
    main: path.join(dist, 'sitesnap.cjs'),
    output: path.join(dist, 'sitesnap'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets,
  };
  const configPath = path.join(dist, 'sea.json');
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
  log('assets', `${files.length} page files embedded`);
  return configPath;
}

async function macApp(binary) {
  const app = path.join(dist, 'sitesnap.app');
  const contents = path.join(app, 'Contents');
  await fsp.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fsp.mkdir(path.join(contents, 'Resources'), { recursive: true });
  await fsp.rename(binary, path.join(contents, 'MacOS', 'sitesnap'));

  // Icon: every size macOS asks for, from the 1024 master.
  const iconset = path.join(dist, 'sitesnap.iconset');
  await fsp.mkdir(iconset, { recursive: true });
  const master = path.join(root, 'assets', 'icon-1024.png');
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('sips', ['-z', String(px), String(px), master, '--out', path.join(iconset, name)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources', 'sitesnap.icns')]);
  await fsp.rm(iconset, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>sitesnap</string>
  <key>CFBundleDisplayName</key><string>sitesnap</string>
  <key>CFBundleIdentifier</key><string>local.sitesnap.app</string>
  <key>CFBundleExecutable</key><string>sitesnap</string>
  <key>CFBundleIconFile</key><string>sitesnap</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- No Dock icon: the app's window is a browser tab, and it has its own Quit button. -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
  await fsp.writeFile(path.join(contents, 'Info.plist'), plist);

  // Ad-hoc signature: enough to run on this Mac. Other Macs will ask the
  // person to confirm the first time (right-click, Open), since it is not
  // notarised by Apple.
  execFileSync('codesign', ['--sign', '-', '--force', '--deep', app], { stdio: 'ignore' });
  log('app', path.relative(root, app));

  const zip = path.join(dist, 'sitesnap-mac.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
  log('zip', `${path.relative(root, zip)} (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
}

async function main() {
  if (platform === 'win32') {
    console.error('Building on Windows is not supported by this script yet.');
    process.exit(1);
  }
  console.log(`\n  sitesnap ${pkg.version}: building a ${platform}-${arch} app on Node ${version}\n`);
  await fsp.rm(dist, { recursive: true, force: true });
  await fsp.mkdir(dist, { recursive: true });

  const node = await officialNode();
  await bundle();
  const config = await seaConfig();
  execFileSync(node, ['--build-sea', config], { cwd: dist, stdio: ['ignore', 'ignore', 'inherit'] });
  const binary = path.join(dist, 'sitesnap');
  log('runtime', `${(fs.statSync(binary).size / 1048576).toFixed(0)} MB executable`);

  for (const leftover of ['sitesnap.cjs', 'sea.json', 'public-manifest.json']) {
    await fsp.rm(path.join(dist, leftover), { force: true });
  }

  if (platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', '--force', binary], { stdio: 'ignore' });
    await macApp(binary);
  } else {
    log('app', path.relative(root, binary));
  }
  console.log('\n  Done.\n');
}

main().catch((err) => {
  console.error(`\n  Build failed: ${err.message}\n`);
  process.exit(1);
});
