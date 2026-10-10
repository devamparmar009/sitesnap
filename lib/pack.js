'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');

// Internal bookkeeping that must never end up in a shared archive. The resume
// state records every URL crawled, its validators and its link graph — that is
// the user's browsing history, not part of the mirrored site.
const INTERNAL = ['.sitesnap-state.json', '.sitesnap-state.json.tmp'];

/**
 * Zip a mirrored site directory.
 *
 * @param {string} sourceDir  directory to compress
 * @param {string} zipPath    destination .zip
 * @param {(info: {bytes: number, entries: number}) => void} [onProgress]
 * @returns {Promise<{zipPath: string, bytes: number}>}
 */
async function pack(sourceDir, zipPath, onProgress) {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      output.destroy();
      reject(err);
    };

    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({ zipPath, bytes: archive.pointer() });
    });

    output.on('error', fail);
    archive.on('error', fail);

    // ENOENT here means a file vanished mid-archive; that is worth reporting
    // but not worth throwing away an otherwise complete zip.
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') fail(err);
    });

    if (onProgress) {
      archive.on('progress', (data) =>
        onProgress({
          entries: data.entries.processed,
          bytes: data.fs.processedBytes,
        })
      );
    }

    archive.pipe(output);
    // glob rather than directory() so the internal files can be excluded.
    // dot:true keeps any legitimate dotfiles from the mirrored site.
    archive.glob('**/*', { cwd: sourceDir, dot: true, ignore: INTERNAL });
    archive.finalize();
  });
}

/**
 * Zip a mirrored site straight into a writable stream, such as an HTTP
 * response, so no second copy of the archive ever sits on disk.
 *
 * @param {string} sourceDir
 * @param {import('stream').Writable} output
 * @param {object} [opts]
 * @param {{name: string, content: string|Buffer}[]} [opts.extras]  files added at the zip root
 * @returns {import('archiver').Archiver} listen for 'error' on it
 */
function packStream(sourceDir, output, { extras = [] } = {}) {
  // Level 6 rather than 9: the person is waiting on this download, and the
  // last few percent of compression cost far more time than they save.
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') archive.emit('error', err);
  });
  archive.pipe(output);
  for (const { name, content } of extras) archive.append(content, { name });
  archive.glob('**/*', { cwd: sourceDir, dot: true, ignore: INTERNAL });
  archive.finalize();
  return archive;
}

module.exports = { pack, packStream };
