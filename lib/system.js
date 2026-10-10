'use strict';

/**
 * The only place sitesnap starts another program.
 *
 * The crawler itself never does: it is pure Node `fetch`, so a URL typed into
 * the app can never become a shell command. The app around it needs exactly
 * three things the operating system has to do for it:
 *
 *   openUrl       open the app in your default browser when it starts
 *   revealPath    show a saved site's folder in Finder / Explorer
 *   runNodeScript run the browser-engine installer for "modern site mode"
 *
 * All three use execFile/spawn with an argument ARRAY and no shell, so there
 * is no command line to inject into. None of them accepts text a person
 * typed: the URL is our own localhost address, the path comes from the
 * library's own registry, and the script is one this package installed.
 */

const { execFile, spawn } = require('child_process');
const path = require('path');

const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/[\w\-./?=&#%]*$/;

function isSea() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

/** Open one of this app's own localhost pages in the default browser. */
function openUrl(url) {
  if (!LOCAL_URL.test(url)) return Promise.reject(new Error('refusing to open a non-local URL'));
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['explorer.exe', [url]]
        : ['xdg-open', [url]];
  return run(cmd, args);
}

/** Show a file or folder selected in the system file manager. */
function revealPath(absPath) {
  if (!path.isAbsolute(absPath)) return Promise.reject(new Error('path must be absolute'));
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', absPath]]
      : process.platform === 'win32'
        ? ['explorer.exe', [`/select,${absPath}`]]
        : ['xdg-open', [path.dirname(absPath)]];
  return run(cmd, args);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err) => {
      // explorer.exe exits 1 even on success; a failure to open a window is
      // never worth crashing the app over.
      resolve(!err || process.platform === 'win32');
    });
  });
}

/**
 * Run a JavaScript file with this same Node, streaming its output by line.
 *
 * Inside the packaged desktop app `process.execPath` is the app itself, not
 * a plain `node`, so it is asked to run the script via `--sitesnap-run`
 * (handled in bin/app.js).
 *
 * @param {string} script  absolute path of a .js file
 * @param {string[]} args
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.onLine]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<number>} exit code
 */
function runNodeScript(script, args = [], { onLine, signal } = {}) {
  if (!path.isAbsolute(script)) return Promise.reject(new Error('script must be absolute'));

  const argv = isSea() ? ['--sitesnap-run', script, ...args] : [script, ...args];
  const env = {
    ...process.env,
    // On some networks IPv6 connects but then stalls on large downloads, and
    // a 150 MB browser download is exactly what trips it. IPv4 first avoids
    // an install that sits at 0% forever.
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' '),
    // The installer draws progress bars only for a terminal; ask for plain lines.
    CI: '1',
    FORCE_COLOR: '0',
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env, windowsHide: true, signal });
    let buffer = '';
    const feed = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop();
      for (const line of lines) if (line.trim() && onLine) onLine(line.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buffer.trim() && onLine) onLine(buffer.trim());
      resolve(code ?? 1);
    });
  });
}

module.exports = { openUrl, revealPath, runNodeScript, isSea };
