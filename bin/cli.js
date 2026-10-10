#!/usr/bin/env node
'use strict';

const path = require('path');
const { snapshot, DEFAULTS, formatBytes } = require('../lib');

const HELP = `
sitesnap — download a complete website for offline viewing

USAGE
  sitesnap <url> [options]

OPTIONS
  -o, --out <dir>        output directory        (default: ./snapshots/<host>)
  -z, --zip              also produce a .zip alongside the directory
  -d, --depth <n>        max link depth from the start page   (default: ${DEFAULTS.maxDepth})
  -p, --max-pages <n>    max HTML pages                       (default: ${DEFAULTS.maxPages})
  -f, --max-files <n>    max total files                      (default: ${DEFAULTS.maxFiles})
  -c, --concurrency <n>  parallel requests                    (default: ${DEFAULTS.concurrency})
      --max-mb <n>       total download budget in MB          (default: ${DEFAULTS.maxBytes / 1048576})
      --timeout <ms>     per-request timeout                  (default: ${DEFAULTS.timeout})
      --subdomains       follow links to subdomains
      --all-paths        allow climbing above the start path (default: stay below)
      --ignore-robots    do not read robots.txt
      --block-private    refuse private / loopback / metadata addresses
  -q, --quiet            only print the summary
  -h, --help             show this help

NETWORK
      --retries <n>      retries per request on 429/5xx/network  (default: ${DEFAULTS.retries})
      --delay <ms>       pause between requests, shared by all workers
      --render           run JavaScript before mirroring (needs Playwright)
      --scroll           scroll rendered pages to load lazy content
      --settle <ms>      min time to let a rendered page finish  (default: ${DEFAULTS.settleMinMs})
      --resume           reuse unchanged files from a previous run
      --no-runtime-rewrite
                         don't ship the runtime URL map. That map is what
                         redirects addresses the page BUILDS while running
                         (a template-literal model URL, a fetch assembled
                         from variables) at the local copy; without it those
                         load from the live site and the mirror is not
                         offline-complete.

AUTH  (sent only to the starting origin, never to third-party hosts)
  -H, --header <h>       extra request header, "Name: Value" (repeatable)
      --cookie <c>       shorthand for -H "Cookie: ..."
  -A, --user-agent <ua>  identify as this instead of a current Chrome.
                         If a host refuses it, sitesnap tries other browser
                         identities before giving up.

FILTERING  (repeatable)
  -i, --include <pat>    only crawl pages matching this pattern
  -x, --exclude <pat>    never fetch anything matching this pattern
      --sitemap          seed from sitemap.xml instead of guessing from links
      --max-sitemap <n>  cap URLs taken from the sitemap   (default: 5000)

  Patterns are globs. '*' crosses '/', so /docs/* means everything under
  /docs — including /docs itself. '?' matches one non-slash character.
  A pattern starting with '/' is matched against the path; anything else is
  matched against the whole URL. Prefix with 're:' for a raw regex.

  --include gates PAGES only, so a page you asked for keeps its CSS and fonts
  even when they live elsewhere. --exclude applies to everything.

EXAMPLES
  sitesnap https://example.com
  sitesnap https://example.com/docs/ --depth 3 --zip

  # only the docs, and never the changelog or any PDF
  sitesnap https://example.com -i '/docs/*' -x '/docs/changelog*' -x '*.pdf'

  # take the site's own URL list rather than crawling blind
  sitesnap https://example.com --sitemap --zip

  # sitemap, but only 2024 posts
  sitesnap https://example.com --sitemap -i '/blog/2024/*'

  # a JS-rendered app, politely, resuming a previous run
  sitesnap https://app.example.com --render --delay 300 --resume

  # behind a session cookie
  sitesnap https://example.com/account --cookie 'session=abc123'

  sitesnap http://localhost:3000 -o ./backup --ignore-robots
`;

const FLAGS = {
  '-o': 'out', '--out': 'out',
  '-d': 'depth', '--depth': 'depth',
  '-p': 'max-pages', '--max-pages': 'max-pages',
  '-f': 'max-files', '--max-files': 'max-files',
  '-c': 'concurrency', '--concurrency': 'concurrency',
  '--max-mb': 'max-mb',
  '--timeout': 'timeout',
  '-i': 'include', '--include': 'include',
  '-x': 'exclude', '--exclude': 'exclude',
  '--max-sitemap': 'max-sitemap',
  '--retries': 'retries',
  '--delay': 'delay',
  '--settle': 'settle',
  '-H': 'header', '--header': 'header',
  '--cookie': 'cookie',
  '-A': 'user-agent', '--user-agent': 'user-agent',
};

// Flags that may appear more than once and accumulate into an array.
const REPEATABLE = new Set(['include', 'exclude', 'header']);

const BOOLEANS = {
  '-z': 'zip', '--zip': 'zip',
  '--sitemap': 'sitemap',
  '--render': 'render',
  '--scroll': 'scroll',
  '--resume': 'resume',
  '--subdomains': 'subdomains',
  '--all-paths': 'all-paths',
  '--ignore-robots': 'ignore-robots',
  '--block-private': 'block-private',
  '--no-runtime-rewrite': 'no-runtime-rewrite',
  '-q': 'quiet', '--quiet': 'quiet',
  '-h': 'help', '--help': 'help',
};

function parseArgs(argv) {
  const opts = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (BOOLEANS[arg]) {
      opts[BOOLEANS[arg]] = true;
    } else if (FLAGS[arg]) {
      const key = FLAGS[arg];
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);

      if (REPEATABLE.has(key)) {
        (opts[key] ||= []).push(value);
      } else {
        opts[key] = value;
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

/** Parse repeated `-H "Name: Value"` into a header object. */
function parseHeaders(list = [], cookie) {
  const headers = {};

  for (const raw of list) {
    const idx = raw.indexOf(':');
    if (idx <= 0) {
      throw new Error(`--header must look like "Name: Value", got: ${raw}`);
    }
    const name = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (!name) throw new Error(`--header has an empty name: ${raw}`);
    headers[name] = value;
  }

  if (cookie) headers.cookie = cookie;
  return headers;
}

function intOr(value, fallback, label) {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a positive number`);
  return n;
}

// Progress on one rewritten line, so a long crawl doesn't flood the scrollback.
function makeReporter(quiet) {
  const tty = process.stdout.isTTY && !quiet;
  let last = 0;

  return {
    line(text) {
      if (quiet) return;
      if (!tty) {
        console.log(text);
        return;
      }
      const now = Date.now();
      if (now - last < 60) return; // cap repaint rate
      last = now;
      const width = process.stdout.columns || 80;
      process.stdout.write(`\r\x1b[2K${text.slice(0, width - 1)}`);
    },
    clear() {
      if (tty) process.stdout.write('\r\x1b[2K');
    },
    log(text) {
      if (quiet) return;
      this.clear();
      console.log(text);
    },
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`sitesnap: ${err.message}`);
    process.exit(2);
  }

  const { opts, positional } = parsed;

  if (opts.help || positional.length === 0) {
    console.log(HELP.trim());
    process.exit(positional.length === 0 && !opts.help ? 2 : 0);
  }

  const target = positional[0];
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`).hostname;
  } catch {
    console.error(`sitesnap: not a valid URL: ${target}`);
    process.exit(2);
  }

  const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const outDir = opts.out || path.join(process.cwd(), 'snapshots', host);
  const report = makeReporter(opts.quiet);

  let crawler = null;
  const onSignal = () => {
    report.clear();
    console.log('\nStopping — finishing in-flight requests…');
    if (crawler) crawler.stop('interrupted');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const started = Date.now();

  try {
    const result = await snapshot(url, {
      outDir,
      zip: Boolean(opts.zip),
      maxDepth: intOr(opts.depth, DEFAULTS.maxDepth, '--depth'),
      maxPages: intOr(opts['max-pages'], DEFAULTS.maxPages, '--max-pages'),
      maxFiles: intOr(opts['max-files'], DEFAULTS.maxFiles, '--max-files'),
      concurrency: intOr(opts.concurrency, DEFAULTS.concurrency, '--concurrency'),
      timeout: intOr(opts.timeout, DEFAULTS.timeout, '--timeout'),
      maxBytes: opts['max-mb']
        ? intOr(opts['max-mb'], 0, '--max-mb') * 1024 * 1024
        : DEFAULTS.maxBytes,
      includeSubdomains: Boolean(opts.subdomains),
      noParent: !opts['all-paths'],
      respectRobots: !opts['ignore-robots'],
      blockPrivate: Boolean(opts['block-private']),
      include: opts.include || [],
      exclude: opts.exclude || [],
      useSitemap: Boolean(opts.sitemap),
      maxSitemapUrls: intOr(opts['max-sitemap'], DEFAULTS.maxSitemapUrls, '--max-sitemap'),
      retries: intOr(opts.retries, DEFAULTS.retries, '--retries'),
      delay: intOr(opts.delay, DEFAULTS.delay, '--delay'),
      headers: parseHeaders(opts.header, opts.cookie),
      userAgent: opts['user-agent'] || DEFAULTS.userAgent,
      runtimeRewrite: !opts['no-runtime-rewrite'],
      resume: Boolean(opts.resume),
      render: Boolean(opts.render),
      autoScroll: Boolean(opts.scroll),
      settleMinMs: intOr(opts.settle, DEFAULTS.settleMinMs, '--settle'),
      onStart: (c) => {
        crawler = c;
      },
      onEvent: (type, payload) => {
        if (type === 'resource') {
          report.line(
            `  ${payload.files} files · ${payload.pages} pages · ` +
              `${formatBytes(payload.bytes)}  ${payload.url}`
          );
        } else if (type === 'warn') {
          report.log(`  ! ${payload.message}  ${payload.url}`);
        } else if (type === 'phase' && payload.phase === 'rewrite' && !payload.done) {
          if (payload.total !== undefined && payload.done === undefined) {
            report.log(`\nRewriting links in ${payload.total} documents…`);
          }
        } else if (type === 'phase' && payload.phase === 'zip' && payload.message) {
          report.log('Compressing…');
        } else if (type === 'phase' && payload.message) {
          report.log(payload.message);
        }
      },
    });

    report.clear();

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log('\nDone.');
    console.log(`  files      ${result.stats.files}  (${result.stats.pages} pages)`);
    console.log(`  downloaded ${formatBytes(result.stats.bytes)} in ${seconds}s`);
    if (result.stats.fromSitemap) console.log(`  sitemap    ${result.stats.fromSitemap} URLs queued`);
    if (result.stats.reused) console.log(`  unchanged  ${result.stats.reused} reused from last run`);
    if (result.stats.rendered) console.log(`  rendered   ${result.stats.rendered} pages via browser`);
    if (result.stats.failed) console.log(`  failed     ${result.stats.failed}`);
    if (result.stats.filtered) console.log(`  filtered   ${result.stats.filtered}`);
    if (result.stats.skipped) console.log(`  skipped    ${result.stats.skipped}`);
    if (result.stopped) console.log(`  stopped    ${result.stopped}`);
    console.log(`  output     ${result.outDir}`);
    if (result.entryFile) {
      console.log(`  open       ${path.join(result.outDir, result.entryFile)}`);
    }
    if (result.zipPath) {
      console.log(`  zip        ${result.zipPath} (${formatBytes(result.zipBytes)})`);
    }
  } catch (err) {
    report.clear();
    console.error(`\nsitesnap: ${err.message}`);
    process.exit(1);
  }
}

main();
