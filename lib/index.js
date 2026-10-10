'use strict';

/**
 * sitesnap — public API.
 *
 *   const { snapshot } = require('./lib');
 *   const result = await snapshot('https://example.com', {
 *     outDir: './out',
 *     zip: true,
 *     onEvent: (type, payload) => console.log(type, payload),
 *   });
 */

const path = require('path');
const { Crawler, DEFAULTS, formatBytes } = require('./crawler');
const { pack } = require('./pack');

const EVENTS = ['phase', 'resource', 'warn', 'skip', 'done'];

/**
 * Crawl a site and optionally zip the result.
 *
 * @param {string} url
 * @param {object} options            crawler options plus:
 * @param {string} options.outDir     where the mirror is written
 * @param {boolean} [options.zip]     also produce <outDir>.zip
 * @param {string} [options.zipPath]  explicit zip destination
 * @param {(type: string, payload: object) => void} [options.onEvent]
 * @param {(crawler: Crawler) => void} [options.onStart]  receives the crawler
 *        so callers can cancel with crawler.stop()
 */
async function snapshot(url, options = {}) {
  const { outDir, zip = false, zipPath, onEvent, onStart, ...crawlerOpts } = options;

  if (!outDir) throw new Error('outDir is required');

  const crawler = new Crawler(url, outDir, crawlerOpts);

  if (onEvent) {
    for (const type of EVENTS) {
      crawler.on(type, (payload) => onEvent(type, payload));
    }
  }
  if (onStart) onStart(crawler);

  const result = await crawler.run();

  if (zip) {
    const dest = zipPath || `${path.resolve(outDir)}.zip`;
    if (onEvent) onEvent('phase', { phase: 'zip', message: 'compressing' });

    const { bytes } = await pack(crawler.outDir, dest, (info) => {
      if (onEvent) onEvent('phase', { phase: 'zip', ...info });
    });

    result.zipPath = dest;
    result.zipBytes = bytes;
    if (onEvent) onEvent('phase', { phase: 'zip', done: true, bytes });
  }

  return result;
}

module.exports = { snapshot, Crawler, pack, DEFAULTS, formatBytes };
