'use strict';

/**
 * JavaScript rendering.
 *
 * Playwright is optional, so the behavioural tests skip when it is absent
 * rather than failing — a missing optional dependency is a supported state,
 * not a broken build. The "not installed" path is tested unconditionally,
 * because that error message is what most people will actually meet.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { Crawler } = require('../lib/crawler');
const { isAvailable, INSTALL_HINT } = require('../lib/render');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sitesnap-render-'));
const listen = (srv) =>
  new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const close = (srv) => new Promise((r) => srv.close(r));

const available = isAvailable();

// A page whose real content only exists after its script runs — the exact
// shape sitesnap used to mirror as an empty shell.
const SPA = `<!doctype html><html><body>
  <div id="root"></div>
  <script>
    document.getElementById('root').innerHTML =
      '<h1>Rendered heading</h1><a href="/generated">generated link</a>';
  </script>
</body></html>`;

test('the install hint names the package and the opt-out', () => {
  assert.match(INSTALL_HINT, /npm install playwright/);
  assert.match(INSTALL_HINT, /--render/);
});

test('--render without Playwright fails clearly, not obscurely', { skip: available }, async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html>hi</html>');
  });
  const origin = await listen(srv);
  const out = await tmp();

  try {
    await assert.rejects(
      () => new Crawler(origin, out, { respectRobots: false, render: true }).run(),
      /npm install playwright/,
      'the error should tell the user how to fix it'
    );
  } finally {
    await close(srv);
    await fsp.rm(out, { recursive: true, force: true });
  }
});

test(
  'rendering captures DOM built by JavaScript',
  { skip: !available, timeout: 120_000 },
  async () => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url === '/' ? SPA : '<html>leaf</html>');
    });
    const origin = await listen(srv);
    const out = await tmp();

    try {
      const result = await new Crawler(origin, out, {
        respectRobots: false,
        render: true,
        maxPages: 5,
      }).run();

      const html = await fsp.readFile(path.join(out, result.entryFile), 'utf8');
      assert.match(html, /Rendered heading/, 'script-generated content should be mirrored');

      // Every HTML page goes through the browser when --render is on. (The
      // count is >1 here because the rendered page adds a link of its own.)
      assert.equal(
        result.stats.rendered,
        result.stats.pages,
        'each mirrored page should have been rendered'
      );
    } finally {
      await close(srv);
      await fsp.rm(out, { recursive: true, force: true });
    }
  }
);

test(
  'links created by JavaScript are followed',
  { skip: !available, timeout: 120_000 },
  async () => {
    // Without rendering this link does not exist in the served HTML, so the
    // crawler could never reach /generated.
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url === '/' ? SPA : '<html>generated page</html>');
    });
    const origin = await listen(srv);
    const out = await tmp();

    try {
      const result = await new Crawler(origin, out, {
        respectRobots: false,
        render: true,
        maxPages: 5,
      }).run();
      assert.ok(result.stats.pages >= 2, `expected the generated link to be followed, got ${result.stats.pages}`);
    } finally {
      await close(srv);
      await fsp.rm(out, { recursive: true, force: true });
    }
  }
);

test(
  'turning --render on invalidates a non-rendered cache',
  { skip: !available, timeout: 120_000 },
  async () => {
    // Regression guard. A cached page fetched without --render holds the
    // server shell; a 304 would hand it straight back, so switching --render
    // on silently did nothing at all.
    const ETAG = '"v1"';
    const isRendered = (html) =>
      /<h1>Rendered heading<\/h1>/.test(html.replace(/<script[\s\S]*?<\/script>/g, ''));

    const srv = http.createServer((req, res) => {
      if (req.headers['if-none-match'] === ETAG) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader('etag', ETAG);
      res.setHeader('content-type', 'text/html');
      res.end(SPA);
    });
    const origin = await listen(srv);
    const out = await tmp();

    try {
      const plain = await new Crawler(origin, out, {
        respectRobots: false,
        resume: true,
        maxPages: 3,
      }).run();
      assert.equal(
        isRendered(await fsp.readFile(path.join(out, plain.entryFile), 'utf8')),
        false,
        'without --render the shell is expected'
      );

      const withRender = await new Crawler(origin, out, {
        respectRobots: false,
        resume: true,
        render: true,
        maxPages: 3,
      }).run();
      assert.ok(
        isRendered(await fsp.readFile(path.join(out, withRender.entryFile), 'utf8')),
        '--render must take effect even on a resumed run'
      );
      assert.ok(withRender.stats.rendered > 0, 'pages should actually have been rendered');

      // ...and a second rendered run should reuse rather than re-render.
      const again = await new Crawler(origin, out, {
        respectRobots: false,
        resume: true,
        render: true,
        maxPages: 3,
      }).run();
      assert.ok(again.stats.reused > 0, 'a matching render mode should still resume');
    } finally {
      await close(srv);
      await fsp.rm(out, { recursive: true, force: true });
    }
  }
);

test(
  'a page whose network never goes quiet is still captured, and quickly',
  { skip: !available, timeout: 120_000 },
  async () => {
    // Regression guard for the worst rendering bug this tool had: waiting on
    // `networkidle`. Analytics, chat widgets, ads and polling mean a large
    // part of the web NEVER goes network-idle. The page below is fully
    // rendered in milliseconds, but used to burn the full timeout, get
    // discarded, fall back to plain fetch, and lose all its JS content.
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/beacon')) {
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
        return;
      }
      if (req.url === '/found') {
        res.setHeader('content-type', 'text/html');
        res.end('<html>found</html>');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        '<html><body><div id=r></div><script>' +
          'document.getElementById("r").innerHTML=\'<h1>READY</h1><a href="/found">l</a>\';' +
          'setInterval(()=>fetch("/beacon").catch(()=>{}),200);' +
          '</script></body></html>'
      );
    });
    const origin = await listen(srv);
    const out = await tmp();

    try {
      const started = Date.now();
      const result = await new Crawler(origin, out, {
        respectRobots: false,
        render: true,
        timeout: 10_000,
        maxPages: 3,
      }).run();
      const elapsed = Date.now() - started;

      const html = await fsp.readFile(path.join(out, result.entryFile), 'utf8');
      assert.match(
        html.replace(/<script[\s\S]*?<\/script>/g, ''),
        /READY/,
        'JS-rendered content must be captured'
      );
      assert.ok(result.stats.pages >= 2, 'JS-created links must still be followed');
      assert.ok(
        elapsed < 10_000,
        `must not burn the navigation timeout on a never-idle page (took ${elapsed}ms)`
      );
    } finally {
      await close(srv);
      await fsp.rm(out, { recursive: true, force: true });
    }
  }
);

test(
  'content arriving late from a fetch is waited for',
  { skip: !available, timeout: 120_000 },
  async () => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/api')) {
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end('{"v":"FROM API"}');
        }, 1500);
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        '<html><body><div id=r>loading...</div><script>' +
          'fetch("/api").then(x=>x.json()).then(j=>{document.getElementById("r").innerHTML="<h1>"+j.v+"</h1>"});' +
          '</script></body></html>'
      );
    });
    const origin = await listen(srv);
    const out = await tmp();

    try {
      const result = await new Crawler(origin, out, {
        respectRobots: false,
        render: true,
        maxPages: 1,
      }).run();
      const html = await fsp.readFile(path.join(out, result.entryFile), 'utf8');
      assert.match(
        html.replace(/<script[\s\S]*?<\/script>/g, ''),
        /FROM API/,
        'must wait for in-flight requests rather than capturing the spinner'
      );
    } finally {
      await close(srv);
      await fsp.rm(out, { recursive: true, force: true });
    }
  }
);

test(
  '--scroll pulls in lazy-loaded content',
  { skip: !available, timeout: 120_000 },
  async () => {
    // The image URL is assembled at runtime from two fragments that are not
    // path-shaped on their own ("/img/" has no extension, "lazy.png" has no
    // directory). That keeps it invisible to static extraction, which mines
    // literal asset paths out of inline scripts and would otherwise download
    // this image on its own — making the baseline below pass for the wrong
    // reason and proving nothing about scrolling.
    const LAZY =
      '<html><body><div style="height:3000px"></div><script>' +
      'var dir="/img/",file="lazy.png";' +
      'window.addEventListener("scroll",()=>{if(!document.getElementById("lz")){' +
      'const i=document.createElement("img");i.id="lz";i.src=dir+file;document.body.appendChild(i)}});' +
      '</script></body></html>';

    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/img')) {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(LAZY);
    });
    const origin = await listen(srv);

    const withoutScroll = await tmp();
    const withScroll = await tmp();

    try {
      // Assert on whether the image was actually downloaded, not on whether
      // the string appears in the HTML — the inline <script> that creates the
      // element mentions the URL either way, so matching text proves nothing.
      const downloadedLazyImage = async (dir) => {
        const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
        return entries.some((e) => e.isFile() && e.name === 'lazy.png');
      };

      await new Crawler(origin, withoutScroll, {
        respectRobots: false,
        render: true,
        maxPages: 1,
      }).run();
      assert.equal(
        await downloadedLazyImage(withoutScroll),
        false,
        'baseline: the lazy image should never load without scrolling'
      );

      await new Crawler(origin, withScroll, {
        respectRobots: false,
        render: true,
        autoScroll: true,
        maxPages: 1,
      }).run();
      assert.equal(
        await downloadedLazyImage(withScroll),
        true,
        '--scroll should trigger the lazy load and mirror the image'
      );
    } finally {
      await close(srv);
      await fsp.rm(withoutScroll, { recursive: true, force: true });
      await fsp.rm(withScroll, { recursive: true, force: true });
    }
  }
);

test(
  'a render failure falls back to the server HTML instead of aborting',
  { skip: !available, timeout: 120_000 },
  async () => {
    // The page never finishes loading a subresource, so networkidle times out.
    const srv = http.createServer((req, res) => {
      if (req.url === '/hang.js') return; // deliberately never respond
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>server copy<script src="/hang.js"></script></body></html>');
    });
    const origin = await listen(srv);
    const out = await tmp();

    try {
      const result = await new Crawler(origin, out, {
        respectRobots: false,
        render: true,
        timeout: 3000,
        maxPages: 2,
      }).run();

      const html = await fsp.readFile(path.join(out, result.entryFile), 'utf8');
      assert.match(html, /server copy/, 'should still have mirrored something usable');
    } finally {
      await close(srv);
      await fsp.rm(out, { recursive: true, force: true });
    }
  }
);
