/* sitesnap · site map.
 *
 * The signature moment of the app: while a site downloads, its map draws
 * itself. The page you pasted sits in the middle; every page saved appears as
 * a point on a ring (one ring per level of the address, so /blog/ posts gather
 * around /blog), joined to the page it belongs under. Pictures, fonts and
 * styles fly in as small sparks and land on the page that needed them, so the
 * size of each point is how much it took to save.
 *
 * It exists to answer "is anything happening, and how much is there?" at a
 * glance, without reading a log. Everything it draws is real data from the
 * crawl; nothing is decorative or invented.
 *
 * Canvas 2D, no dependencies. It stops drawing when the canvas is off-screen,
 * the tab is hidden, or nothing is moving, and with reduced motion the layout
 * is computed up front and drawn once, with no sparks.
 */

(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

  function pathOf(url) {
    try {
      const u = new URL(url);
      const p = u.pathname.replace(/\/+$/, '') || '/';
      return { host: u.host, path: p };
    } catch {
      return { host: '', path: String(url) };
    }
  }

  function cssVar(style, name, fallback) {
    const v = style.getPropertyValue(name).trim();
    return v || fallback;
  }

  class SiteMap {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts]
     * @param {(node: object|null, x: number, y: number) => void} [opts.onHover]
     * @param {(node: object) => void} [opts.onPick]
     */
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onHover = opts.onHover || (() => {});
      this.onPick = opts.onPick || (() => {});

      this.nodes = [];
      this.byUrl = new Map();
      this.byKey = new Map();
      this.particles = [];
      this.root = null;
      this.rings = [];
      this.state = 'idle';
      this.progress = 0;
      this.shownProgress = 0;
      this.alpha = 0;
      this.hover = null;
      this.reveal = 1;
      this.revealStart = 0;

      this.camera = { x: 0, y: 0, s: 1 };
      this.target = { x: 0, y: 0, s: 1 };

      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.visible = true;
      this.raf = 0;
      this.now = performance.now();

      this.readColors();
      this.resize();

      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
      this.io = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        this.kick();
      });
      this.io.observe(canvas);
      document.addEventListener('visibilitychange', () => this.kick());
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        this.readColors();
        this.kick(true);
      });

      canvas.addEventListener('pointermove', (e) => this.#pointer(e));
      canvas.addEventListener('pointerleave', () => this.#setHover(null));
      canvas.addEventListener('click', (e) => {
        const node = this.#nodeAt(e);
        if (node && node.local) this.onPick(node);
      });
    }

    readColors() {
      const s = getComputedStyle(document.documentElement);
      this.colors = {
        node: cssVar(s, '--map-node', '#f4a77a'),
        nodeDim: cssVar(s, '--map-node-dim', 'rgba(244,167,122,.45)'),
        edge: cssVar(s, '--map-edge', 'rgba(160,170,200,.28)'),
        ring: cssVar(s, '--map-ring', 'rgba(160,170,200,.14)'),
        spark: cssVar(s, '--map-spark', '#dfe4f2'),
        rootFill: cssVar(s, '--map-root', '#1d2233'),
        track: cssVar(s, '--map-track', 'rgba(160,170,200,.2)'),
        label: cssVar(s, '--map-label', '#c9cddc'),
        glow: cssVar(s, '--map-glow', 'rgba(244,167,122,.35)'),
        font: cssVar(s, '--font-body', 'system-ui, sans-serif'),
      };
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.#fit(true);
      this.kick(true);
    }

    // ---- data -------------------------------------------------------------

    /** Clear everything back to an empty sky. */
    reset() {
      this.nodes = [];
      this.byUrl.clear();
      this.byKey.clear();
      this.particles = [];
      this.root = null;
      this.rings = [];
      this.progress = 0;
      this.shownProgress = 0;
      this.alpha = 0;
      this.state = 'idle';
      this.#setHover(null);
      this.camera = { x: 0, y: 0, s: 1 };
      this.target = { x: 0, y: 0, s: 1 };
      this.kick(true);
    }

    /**
     * Put the site in the middle of the map.
     * @param {{url: string, title?: string, icon?: string}} site
     */
    setRoot(site) {
      if (this.root && this.root.url === site.url) {
        if (site.title) this.root.title = site.title;
      } else {
        this.reset();
        const key = pathOf(site.url);
        const node = {
          url: site.url,
          key: key.host + key.path,
          path: key.path,
          title: site.title || key.host,
          local: null,
          parent: null,
          ring: 0,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          assets: 0,
          born: this.now,
          flash: 0,
          saved: false,
          isRoot: true,
          children: new Set(),
        };
        this.root = node;
        this.nodes.push(node);
        this.byUrl.set(node.url, node);
        this.byKey.set(node.key, node);
      }
      if (site.icon !== undefined) this.#loadIcon(site.icon);
      this.kick();
    }

    #loadIcon(src) {
      this.icon = null;
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        this.icon = img;
        this.kick();
      };
      img.src = src;
    }

    /** @param {'idle'|'checking'|'plan'|'saving'|'done'|'failed'} state */
    setState(state) {
      this.state = state;
      this.kick();
    }

    /** @param {number} p  0..1 */
    setProgress(p) {
      this.progress = Math.max(0, Math.min(1, p));
      if (reduced.matches) this.shownProgress = this.progress;
      this.kick();
    }

    /**
     * A page was saved.
     * @param {{u: string, p?: string|null, t?: string|null, d?: number|null, l?: string|null}} page
     */
    addPage(page) {
      if (!this.root) this.setRoot({ url: page.u, title: page.t });

      const existing = this.byUrl.get(page.u);
      if (existing) {
        existing.saved = true;
        if (page.t) existing.title = page.t;
        if (page.l) existing.local = page.l;
        return existing;
      }

      // The seed page may arrive under its redirected address.
      if (!this.root.saved && (page.d === 0 || page.d === null) && !page.p) {
        this.root.saved = true;
        this.root.title = page.t || this.root.title;
        this.root.local = page.l || null;
        this.byUrl.set(page.u, this.root);
        this.kick();
        return this.root;
      }

      const key = pathOf(page.u);
      const parent = this.#layoutParent(key, page.p);
      const ring = Math.min(6, parent.ring + 1);

      const angle = parent.isRoot ? Math.random() * TAU : Math.atan2(parent.y, parent.x) + (Math.random() - 0.5) * 0.6;
      const r0 = (parent.isRoot ? 40 : Math.hypot(parent.x, parent.y)) + 18;
      const node = {
        url: page.u,
        key: key.host + key.path,
        path: key.path,
        title: page.t || null,
        local: page.l || null,
        parent,
        ring,
        x: Math.cos(angle) * r0,
        y: Math.sin(angle) * r0,
        vx: 0,
        vy: 0,
        assets: 0,
        born: this.now,
        flash: 0,
        saved: true,
        isRoot: false,
        children: new Set(),
      };
      parent.children.add(node);
      this.nodes.push(node);
      this.byUrl.set(node.url, node);
      if (!this.byKey.has(node.key)) {
        this.byKey.set(node.key, node);
        this.#adopt(node);
      }
      this.#layoutRings();
      this.alpha = Math.max(this.alpha, 0.7);
      if (reduced.matches) this.#settle(80);
      this.kick();
      return node;
    }

    /**
     * Pages saved before their section page arrived were hung on whatever
     * was available. Now that the section exists, move them under it.
     */
    #adopt(section) {
      const prefix = `${section.key}/`;
      for (const n of this.nodes) {
        if (n === section || n.isRoot || !n.key.startsWith(prefix)) continue;
        const current = n.parent;
        if (current && current !== this.root && current.key.length >= section.key.length) continue;
        current.children.delete(n);
        n.parent = section;
        section.children.add(n);
        this.#setRing(n, section.ring + 1);
      }
    }

    #setRing(node, ring) {
      node.ring = Math.min(6, ring);
      for (const child of node.children) this.#setRing(child, node.ring + 1);
    }

    /**
     * Prefer the nearest saved page above this one in the address, so a
     * section's pages gather around it. Fall back to the page that linked
     * here, then to the middle.
     */
    #layoutParent(key, discoveredBy) {
      const parts = key.path.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 1; i--) {
        const candidate = this.byKey.get(`${key.host}/${parts.slice(0, i).join('/')}`);
        if (candidate) return candidate;
      }
      if (discoveredBy) {
        const by = this.byUrl.get(discoveredBy);
        if (by) return by;
      }
      return this.root;
    }

    /**
     * A file was saved. `parent` is the page that needed it.
     * @param {{c: string, p?: string|null}} file
     */
    addFile(file) {
      if (!this.root) return;
      const node = (file.p && this.byUrl.get(file.p)) || this.root;
      if (reduced.matches || this.particles.length > 160 || document.hidden) {
        node.assets++;
        return;
      }
      const spread = Math.max(this.w, this.h) / this.camera.s;
      const a = Math.random() * TAU;
      const from = {
        x: this.camera.x + Math.cos(a) * spread * 0.62,
        y: this.camera.y + Math.sin(a) * spread * 0.62,
      };
      this.particles.push({
        from,
        node,
        bend: (Math.random() - 0.5) * 0.9,
        start: this.now + Math.random() * 120,
        dur: 650 + Math.random() * 450,
        image: file.c === 'image',
      });
      this.kick();
    }

    /**
     * Draw a finished snapshot's map at once (from the library).
     * @param {{url: string, title?: string, icon?: string|null}} site
     * @param {Array} pages
     */
    load(site, pages) {
      this.reset();
      this.setRoot(site);
      for (const page of pages || []) this.addPage(page);
      this.root.saved = true;
      this.#settle(260);
      this.particles = [];
      this.progress = 1;
      this.shownProgress = 1;
      this.state = 'done';
      this.#fit(true);
      this.revealStart = this.now;
      this.reveal = reduced.matches ? 1 : 0;
      this.kick(true);
    }

    // ---- layout -----------------------------------------------------------

    /** Ring radii grow with how many pages each ring holds, so none overlap. */
    #layoutRings() {
      const counts = [];
      for (const n of this.nodes) if (!n.isRoot) counts[n.ring] = (counts[n.ring] || 0) + 1;
      const radii = [0];
      let prev = 0;
      for (let ring = 1; ring < counts.length; ring++) {
        const needed = ((counts[ring] || 0) * 15) / TAU;
        const r = Math.max(prev + (ring === 1 ? 96 : 74), needed);
        radii[ring] = r;
        prev = r;
      }
      this.rings = radii;
    }

    #step() {
      const nodes = this.nodes;
      const a = this.alpha;
      if (a < 0.002) return;

      // Neighbour grid, so repulsion stays linear in the number of pages.
      const cell = 34;
      const grid = new Map();
      for (const n of nodes) {
        const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`;
        let bucket = grid.get(k);
        if (!bucket) grid.set(k, (bucket = []));
        bucket.push(n);
      }

      for (const n of nodes) {
        if (n.isRoot) continue;

        // Hold to its ring.
        const r = Math.hypot(n.x, n.y) || 0.001;
        const target = this.rings[n.ring] || 96 * n.ring;
        const pull = (target - r) * 0.06;
        n.vx += (n.x / r) * pull * a;
        n.vy += (n.y / r) * pull * a;

        // Stay near the page it belongs under, around the ring.
        const p = n.parent;
        if (p && !p.isRoot) {
          const pa = Math.atan2(p.y, p.x);
          const tx = Math.cos(pa) * target;
          const ty = Math.sin(pa) * target;
          n.vx += (tx - n.x) * 0.012 * a;
          n.vy += (ty - n.y) * 0.012 * a;
        }

        // Keep clear of neighbours.
        const cx = Math.floor(n.x / cell);
        const cy = Math.floor(n.y / cell);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const bucket = grid.get(`${gx},${gy}`);
            if (!bucket) continue;
            for (const m of bucket) {
              if (m === n) continue;
              let dx = n.x - m.x;
              let dy = n.y - m.y;
              let d2 = dx * dx + dy * dy;
              if (d2 > cell * cell) continue;
              if (d2 < 0.01) {
                dx = Math.random() - 0.5;
                dy = Math.random() - 0.5;
                d2 = 0.25;
              }
              const d = Math.sqrt(d2);
              const push = ((cell - d) / d) * 0.09 * a;
              n.vx += dx * push;
              n.vy += dy * push;
            }
          }
        }
      }

      for (const n of nodes) {
        if (n.isRoot) continue;
        n.vx *= 0.78;
        n.vy *= 0.78;
        n.x += n.vx;
        n.y += n.vy;
      }

      this.alpha *= 0.985;
      if (this.alpha < 0.002) this.alpha = 0;
    }

    #settle(iterations) {
      this.alpha = 1;
      for (let i = 0; i < iterations && this.alpha > 0; i++) this.#step();
      this.alpha = 0;
      this.#fit(true);
    }

    #fit(instant = false) {
      if (!this.nodes.length || !this.w) {
        this.target = { x: 0, y: 0, s: 1 };
        if (instant) this.camera = { ...this.target };
        return;
      }
      let minX = -60;
      let maxX = 60;
      let minY = -60;
      let maxY = 60;
      for (const n of this.nodes) {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
      }
      const pad = Math.min(this.w, this.h) < 420 ? 36 : 64;
      const s = Math.min(
        (this.w - pad * 2) / Math.max(1, maxX - minX),
        (this.h - pad * 2) / Math.max(1, maxY - minY),
        1.5
      );
      this.target = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, s: Math.max(0.08, s) };
      if (instant) this.camera = { ...this.target };
    }

    // ---- loop -------------------------------------------------------------

    /** Make sure a frame is coming. `force` draws once even when idle. */
    kick(force = false) {
      if (this.raf) return;
      if (!this.visible || document.hidden) {
        if (force) this.#draw();
        return;
      }
      this.raf = requestAnimationFrame((t) => this.#frame(t));
    }

    #busy() {
      if (reduced.matches) return false;
      return (
        this.alpha > 0 ||
        this.particles.length > 0 ||
        Math.abs(this.shownProgress - this.progress) > 0.001 ||
        this.state === 'checking' ||
        this.state === 'saving' ||
        this.reveal < 1 ||
        this.nodes.some((n) => n.flash > 0.01 || this.now - n.born < 900) ||
        Math.abs(this.camera.s - this.target.s) > 0.002 ||
        Math.abs(this.camera.x - this.target.x) > 0.5 ||
        Math.abs(this.camera.y - this.target.y) > 0.5
      );
    }

    #frame(t) {
      this.raf = 0;
      this.now = t;

      if (!reduced.matches) {
        this.#step();
        this.#fit(false);
        const k = 0.08;
        this.camera.x += (this.target.x - this.camera.x) * k;
        this.camera.y += (this.target.y - this.camera.y) * k;
        this.camera.s += (this.target.s - this.camera.s) * k;
        this.shownProgress += (this.progress - this.shownProgress) * 0.08;
        if (this.reveal < 1) this.reveal = Math.min(1, (t - this.revealStart) / 900);
      } else {
        this.#fit(true);
        this.shownProgress = this.progress;
      }

      this.#draw();
      if (this.#busy() && this.visible && !document.hidden) {
        this.raf = requestAnimationFrame((next) => this.#frame(next));
      }
    }

    // ---- drawing ------------------------------------------------------------

    #toScreen(x, y) {
      return [
        (x - this.camera.x) * this.camera.s + this.w / 2,
        (y - this.camera.y) * this.camera.s + this.h / 2,
      ];
    }

    #draw() {
      const ctx = this.ctx;
      const c = this.colors;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      if (!this.root) {
        this.#drawEmpty();
        return;
      }

      const [rx, ry] = this.#toScreen(0, 0);
      const now = this.now;

      // Rings: one per level of the address.
      ctx.save();
      ctx.strokeStyle = c.ring;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 6]);
      for (let i = 1; i < this.rings.length; i++) {
        const r = this.rings[i] * this.camera.s;
        if (r < 6) continue;
        ctx.globalAlpha = this.reveal;
        ctx.beginPath();
        ctx.arc(rx, ry, r, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();

      // Links.
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.edge;
      for (const n of this.nodes) {
        if (n.isRoot || !n.parent) continue;
        const grow = reduced.matches ? 1 : easeOut((now - n.born) / 450);
        const vis = this.#revealFor(n);
        if (vis <= 0) continue;
        const [x1, y1] = this.#toScreen(n.parent.x, n.parent.y);
        const [x2, y2] = this.#toScreen(n.x, n.y);
        ctx.globalAlpha = vis * (this.hover && (this.hover === n || this.hover === n.parent) ? 1 : 0.8);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + (x2 - x1) * grow, y1 + (y2 - y1) * grow);
        ctx.stroke();
      }
      ctx.restore();

      // Sparks: files flying to the page that needed them.
      if (this.particles.length) {
        ctx.save();
        const keep = [];
        for (const p of this.particles) {
          const t = (now - p.start) / p.dur;
          if (t < 0) {
            keep.push(p);
            continue;
          }
          if (t >= 1) {
            p.node.assets++;
            p.node.flash = 1;
            continue;
          }
          const e = easeOut(t);
          const tx = p.node.x;
          const ty = p.node.y;
          const mx = (p.from.x + tx) / 2 + (ty - p.from.y) * p.bend;
          const my = (p.from.y + ty) / 2 - (tx - p.from.x) * p.bend;
          const bx = (1 - e) * (1 - e) * p.from.x + 2 * (1 - e) * e * mx + e * e * tx;
          const by = (1 - e) * (1 - e) * p.from.y + 2 * (1 - e) * e * my + e * e * ty;
          const [sx, sy] = this.#toScreen(bx, by);
          ctx.globalAlpha = Math.min(1, t * 4) * (1 - Math.max(0, t - 0.85) / 0.15);
          ctx.fillStyle = p.image ? c.node : c.spark;
          ctx.beginPath();
          ctx.arc(sx, sy, p.image ? 1.8 : 1.3, 0, TAU);
          ctx.fill();
          keep.push(p);
        }
        this.particles = keep;
        ctx.restore();
      }

      // Pages.
      ctx.save();
      for (const n of this.nodes) {
        if (n.isRoot) continue;
        const vis = this.#revealFor(n);
        if (vis <= 0) continue;
        const age = now - n.born;
        const grow = reduced.matches ? 1 : easeOut(age / 500);
        const r = (3 + Math.min(6, Math.sqrt(n.assets) * 0.7)) * grow;
        const [x, y] = this.#toScreen(n.x, n.y);

        if (!reduced.matches && age < 900) {
          const t = age / 900;
          ctx.globalAlpha = (1 - t) * 0.6;
          ctx.strokeStyle = c.node;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, r + 4 + t * 16, 0, TAU);
          ctx.stroke();
        }

        ctx.globalAlpha = vis;
        ctx.fillStyle = n.local ? c.node : c.nodeDim;
        ctx.beginPath();
        ctx.arc(x, y, r + n.flash * 1.6, 0, TAU);
        ctx.fill();

        if (this.hover === n) {
          ctx.strokeStyle = c.label;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, r + 4, 0, TAU);
          ctx.stroke();
        }
        n.flash *= 0.9;
      }
      ctx.restore();

      this.#drawRoot(rx, ry);
    }

    /**
     * Before any site is chosen: the empty map itself. A dashed place in the
     * middle where the site will sit, and the first rings it will fill.
     */
    #drawEmpty() {
      const ctx = this.ctx;
      const c = this.colors;
      const x = this.w / 2;
      const y = this.h / 2;
      const unit = Math.min(this.w, this.h) / 2;
      ctx.save();
      ctx.strokeStyle = c.ring;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 6]);
      for (const f of [0.34, 0.58, 0.82]) {
        ctx.beginPath();
        ctx.arc(x, y, unit * f, 0, TAU);
        ctx.stroke();
      }
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = c.track;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, this.w < 420 ? 20 : 26, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    #revealFor(n) {
      if (this.reveal >= 1) return 1;
      const order = n.ring / Math.max(1, this.rings.length);
      return Math.max(0, Math.min(1, (this.reveal - order * 0.6) / 0.4));
    }

    #drawRoot(x, y) {
      const ctx = this.ctx;
      const c = this.colors;
      const R = this.w < 420 ? 20 : 26;
      const now = this.now;

      // Glow: breathes while the site is being checked, steady when saved.
      let glow = 0;
      if (this.state === 'checking') glow = reduced.matches ? 0.5 : 0.35 + 0.25 * Math.sin(now / 420);
      else if (this.state === 'plan' || this.state === 'saving') glow = 0.45;
      else if (this.state === 'done') glow = 0.6;
      if (glow > 0) {
        const g = ctx.createRadialGradient(x, y, R * 0.6, x, y, R * 3.2);
        g.addColorStop(0, c.glow);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save();
        ctx.globalAlpha = glow;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, R * 3.2, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      // Progress ring.
      const ringR = R + 7;
      ctx.save();
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = c.track;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, TAU);
      ctx.stroke();
      if (this.shownProgress > 0.002) {
        ctx.strokeStyle = c.node;
        ctx.beginPath();
        ctx.arc(x, y, ringR, -Math.PI / 2, -Math.PI / 2 + TAU * this.shownProgress);
        ctx.stroke();
      }
      ctx.restore();

      // The site itself.
      ctx.save();
      ctx.fillStyle = c.rootFill;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, TAU);
      ctx.fill();
      if (this.icon) {
        const s = R * 1.05;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, R - 3, 0, TAU);
        ctx.clip();
        try {
          ctx.drawImage(this.icon, x - s / 2, y - s / 2, s, s);
        } catch {
          // a broken image is just not drawn
        }
        ctx.restore();
      } else {
        ctx.fillStyle = c.node;
        ctx.font = `600 ${Math.round(R * 0.9)}px ${c.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const letter = (this.root.title || '?').trim().charAt(0).toUpperCase() || '?';
        ctx.fillText(letter, x, y + 1);
      }
      if (this.hover === this.root) {
        ctx.strokeStyle = c.label;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, R + 12, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- pointer ----------------------------------------------------------

    #nodeAt(event) {
      const rect = this.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      let best = null;
      let bestD = Infinity;
      for (const n of this.nodes) {
        const [x, y] = this.#toScreen(n.x, n.y);
        const d = (x - px) * (x - px) + (y - py) * (y - py);
        const limit = n.isRoot ? 34 * 34 : 14 * 14;
        if (d <= limit && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    }

    #pointer(event) {
      this.#setHover(this.#nodeAt(event), event);
    }

    #setHover(node, event) {
      if (node === this.hover) {
        if (node && event) this.#emitHover(node);
        return;
      }
      this.hover = node;
      this.canvas.style.cursor = node && node.local ? 'pointer' : '';
      this.#emitHover(node);
      this.kick(true);
    }

    #emitHover(node) {
      if (!node) {
        this.onHover(null, 0, 0);
        return;
      }
      const [x, y] = this.#toScreen(node.x, node.y);
      this.onHover(node, x, y);
    }

    get pageCount() {
      return this.nodes.filter((n) => n.saved).length;
    }
  }

  window.SiteMap = SiteMap;
})();
