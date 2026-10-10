/* sitesnap · app.
 *
 * One rule governs everything below: text arriving over the socket is
 * untrusted. Titles, URLs and error strings originate from whatever site is
 * being saved, so every value reaching the DOM goes through textContent or an
 * attribute setter. There is no innerHTML in this file, and there should
 * never be one.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

  /** Build an element. Children may be strings (set as text) or nodes. */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const store = {
    get(key) {
      try {
        return localStorage.getItem(`sitesnap.${key}`);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) localStorage.removeItem(`sitesnap.${key}`);
        else localStorage.setItem(`sitesnap.${key}`, value);
      } catch {
        // private mode: preferences just are not remembered
      }
    },
  };

  const numberFmt = new Intl.NumberFormat();
  const fmt = (n) => numberFmt.format(Math.round(n || 0));
  const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

  function formatBytes(n) {
    if (!n || n < 1024) return `${n || 0} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function formatDuration(ms) {
    const s = Math.max(1, Math.round((ms || 0) / 1000));
    if (s < 60) return plural(s, 'second');
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m < 60) return rest && m < 10 ? `${plural(m, 'minute')} ${plural(rest, 'second')}` : plural(m, 'minute');
    return `${plural(Math.floor(m / 60), 'hour')} ${plural(m % 60, 'minute')}`;
  }

  function formatWhen(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, now)) return `Today, ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return `Yesterday, ${time}`;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  function pathLabel(url) {
    try {
      const u = new URL(url);
      const p = decodeURIComponent(u.pathname);
      return p === '/' ? u.hostname : p;
    } catch {
      return String(url || '');
    }
  }

  /**
   * A short name for headings. Page titles are often "Page | Site" or
   * "Page - Site"; the part after the last bar is usually the site's name.
   */
  function displayName(record) {
    if (!record) return '';
    if (record.siteName) return record.siteName;
    const title = String(record.title || '').trim();
    const parts = title.split(/\s+[|\u00b7]\s+/).filter(Boolean);
    const name = parts.length > 1 ? parts[parts.length - 1] : title;
    return name && name.length <= 60 ? name : record.host;
  }

  function initial(text) {
    return (String(text || '?').replace(/^www\./, '').trim().charAt(0) || '?').toUpperCase();
  }

  const el = {
    body: document.body,
    conn: $('conn'),
    connText: $('conn-text'),
    quit: $('quit'),
    libraryCount: $('library-count'),
    studio: $('studio'),
    library: $('library'),
    panes: [...document.querySelectorAll('[data-pane]')],
    // start
    form: $('address-form'),
    address: $('address'),
    lookup: $('lookup'),
    hint: $('address-hint'),
    checkError: $('check-error'),
    checkErrorTitle: $('check-error-title'),
    checkErrorText: $('check-error-text'),
    checkErrorAction: $('check-error-action'),
    checkErrorDetail: $('check-error-detail'),
    plan: $('plan'),
    siteCard: $('site-card'),
    siteMedia: $('site-media'),
    siteImage: $('site-image'),
    siteIcon: $('site-icon'),
    siteTitle: $('site-title'),
    siteHost: $('site-host'),
    siteDesc: $('site-desc'),
    siteFact: $('site-fact'),
    notices: $('notices'),
    scopeNoteSection: $('scope-section-note'),
    scopeNoteSite: $('scope-site-note'),
    sizeSet: $('choice-size'),
    more: $('more'),
    optModern: $('opt-modern'),
    optScroll: $('opt-scroll'),
    optPatient: $('opt-patient'),
    modernSub: $('modern-sub'),
    engineLine: $('engine-line'),
    engineText: $('engine-text'),
    engineSetup: $('engine-setup'),
    optGentle: $('opt-gentle'),
    optSubdomains: $('opt-subdomains'),
    subdomainNote: $('subdomain-note'),
    optRobots: $('opt-robots'),
    optSitemap: $('opt-sitemap'),
    optOnly: $('opt-only'),
    optSkip: $('opt-skip'),
    optPages: $('opt-pages'),
    optMb: $('opt-mb'),
    save: $('save'),
    change: $('change'),
    // saving
    savingTitle: $('saving-title'),
    meterBar: $('meter-bar'),
    meterFill: $('meter-fill'),
    meterPct: $('meter-pct'),
    meterEta: $('meter-eta'),
    tPages: $('t-pages'),
    tImages: $('t-images'),
    tOther: $('t-other'),
    tSize: $('t-size'),
    now: $('now'),
    notify: $('notify'),
    stop: $('stop'),
    activity: $('activity'),
    // done
    doneOver: $('done-over'),
    doneTitle: $('done-title'),
    doneFacts: $('done-facts'),
    openCopy: $('open-copy'),
    zip: $('zip'),
    reveal: $('reveal'),
    doneWhere: $('done-where'),
    notes: $('notes'),
    again: $('again'),
    update: $('update'),
    // failed
    failTitle: $('fail-title'),
    failText: $('fail-text'),
    failAction: $('fail-action'),
    failBack: $('fail-back'),
    failDetail: $('fail-detail'),
    // map
    mapCanvas: $('map'),
    mapHint: $('map-hint'),
    mapLegend: $('map-legend'),
    mapTip: $('map-tip'),
    mapTipTitle: $('map-tip-title'),
    mapTipPath: $('map-tip-path'),
    // library
    shelf: $('shelf'),
    libraryEmpty: $('library-empty'),
    libraryPath: $('library-path'),
    openFolder: $('open-folder'),
    // viewer
    viewer: $('viewer'),
    viewerIcon: $('viewer-icon'),
    viewerTitle: $('viewer-title'),
    viewerPage: $('viewer-page'),
    viewerPagesToggle: $('viewer-pages-toggle'),
    viewerPages: $('viewer-pages'),
    viewerSearch: $('viewer-search'),
    viewerList: $('viewer-list'),
    viewerFrame: $('viewer-frame'),
    viewerTab: $('viewer-tab'),
    viewerClose: $('viewer-close'),
    // sheets
    loginSheet: $('login-sheet'),
    loginTitle: $('login-title'),
    loginText: $('login-text'),
    loginGo: $('login-go'),
    loginClose: $('login-close'),
    engineSheet: $('engine-sheet'),
    engineSheetText: $('engine-sheet-text'),
    engineMeter: $('engine-meter'),
    engineBar: $('engine-bar'),
    engineFill: $('engine-fill'),
    engineStep: $('engine-step'),
    enginePct: $('engine-pct'),
    engineGo: $('engine-go'),
    engineClose: $('engine-close'),
    confirmSheet: $('confirm-sheet'),
    confirmTitle: $('confirm-title'),
    confirmText: $('confirm-text'),
    confirmYes: $('confirm-yes'),
    confirmNo: $('confirm-no'),
    toast: $('toast'),
    status: $('status'),
  };

  const SIZE_PAGES = { quick: 25, normal: 150, everything: 1000 };
  const CATEGORY_WORD = {
    image: 'Picture',
    style: 'Style',
    script: 'Script',
    font: 'Font',
    media: 'Video or sound',
    document: 'Document',
    other: 'File',
  };

  const state = {
    socket: null,
    connected: false,
    closedForGood: false,
    hello: null,
    viewPort: null,
    route: 'save',
    view: 'start',
    reqId: 0,
    inspection: null,
    engine: { state: 'missing' },
    login: null,
    job: null,
    snapshot: null,
    library: [],
    running: [],
    pendingAfterEngine: null,
    pendingViewer: null,
    pendingSnapshot: null,
    activityCount: 0,
  };

  // ---- small pieces ----------------------------------------------------------

  function announce(text) {
    el.status.textContent = '';
    window.setTimeout(() => {
      el.status.textContent = text;
    }, 30);
  }

  let toastTimer = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    if (!reduced.matches) {
      el.toast.animate(
        [
          { opacity: 0, transform: 'translate(-50%, 12px)' },
          { opacity: 1, transform: 'translate(-50%, 0)' },
        ],
        { duration: 320, easing: EASE_OUT }
      );
    }
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.toast.hidden = true;
    }, 4200);
  }

  function setBusy(button, busy) {
    if (busy) button.dataset.busy = 'true';
    else delete button.dataset.busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /** Count a number up to its new value. Real data only, never decoration. */
  function tick(node, to, format = fmt) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = String(to);
    if (reduced.matches || from === to || Math.abs(to - from) < 2) {
      node.textContent = format(to);
      return;
    }
    const start = performance.now();
    const dur = 420;
    const step = (t) => {
      if (node.dataset.value !== String(to)) return;
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      node.textContent = format(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function reveal(nodes, { stagger = 60, distance = 14 } = {}) {
    if (reduced.matches) return;
    nodes.filter(Boolean).slice(0, 6).forEach((node, i) => {
      node.animate(
        [
          { opacity: 0, transform: `translateY(${distance}px)` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 520, delay: i * stagger, easing: EASE_OUT, fill: 'backwards' }
      );
    });
  }

  function viewOrigin() {
    return `${location.protocol}//${location.hostname}:${state.viewPort}`;
  }

  function encodePath(rel) {
    return String(rel || '')
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
  }

  function viewUrl(id, local) {
    return `${viewOrigin()}/${id}/${encodePath(local || '')}`;
  }

  function iconFor(record, holder, { size = 'icon' } = {}) {
    holder.replaceChildren();
    if (record && record.icon && state.viewPort) {
      const img = h('img', { src: `${viewOrigin()}/${record.id}/__sitesnap/icon`, alt: '' });
      img.addEventListener('error', () => holder.replaceChildren(initial(record.siteName || record.host)));
      holder.append(img);
    } else {
      holder.append(initial(record && (record.siteName || record.host)));
    }
    return size;
  }

  function send(action, payload = {}) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ action, ...payload }));
      return true;
    }
    toast('Not connected to sitesnap yet. One moment.');
    return false;
  }

  // ---- map ---------------------------------------------------------------------

  const map = new window.SiteMap(el.mapCanvas, {
    onHover(node, x, y) {
      if (!node) {
        el.mapTip.hidden = true;
        return;
      }
      el.mapTipTitle.textContent = node.title || pathLabel(node.url);
      const openable = state.view === 'done' && node.local;
      el.mapTipPath.textContent = openable ? `${pathLabel(node.url)} · click to open` : pathLabel(node.url);
      el.mapTip.style.left = `${x}px`;
      el.mapTip.style.top = `${y}px`;
      el.mapTip.hidden = false;
    },
    onPick(node) {
      if (state.view === 'done' && state.snapshot) openViewer(state.snapshot, node.local);
    },
  });

  function mapLabel() {
    const host = (state.snapshot && state.snapshot.host) || (state.job && state.job.record.host) || '';
    const n = map.pageCount;
    el.mapCanvas.setAttribute(
      'aria-label',
      host ? `Map of ${host}: ${plural(n, 'page')} saved so far.` : 'A map of the site will appear here.'
    );
  }

  function mapCaption(view) {
    const legend = view === 'saving' || view === 'done';
    el.mapLegend.hidden = !legend;
    if (view === 'done') el.mapHint.textContent = 'Point at a page to see what it is. Click it to open the saved copy.';
    else if (view === 'saving') el.mapHint.textContent = 'Each point is a saved page. Sparks are pictures and files arriving.';
    else if (view === 'checking') el.mapHint.textContent = 'Having a look at the site.';
    else if (view === 'plan') el.mapHint.textContent = 'Ready when you are. The map fills in as pages are saved.';
    else el.mapHint.textContent = 'The site’s map draws itself here as it is saved.';
  }

  // ---- routes and views --------------------------------------------------------

  function setRoute(route) {
    state.route = route;
    el.body.dataset.route = route;
    el.studio.hidden = route !== 'save';
    el.library.hidden = route !== 'library';
    for (const link of document.querySelectorAll('[data-link]')) {
      if (link.dataset.link === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (route === 'library') {
      renderLibrary();
      reveal([...el.shelf.children], { stagger: 50 });
    }
    if (route === 'save') map.kick(true);
  }

  function setView(view) {
    const changed = view !== state.view;
    state.view = view;
    el.body.dataset.view = view;
    for (const pane of el.panes) {
      const show = pane.dataset.pane === (view === 'checking' || view === 'plan' ? 'start' : view);
      pane.hidden = !show;
      if (show && changed && view !== 'checking' && view !== 'plan') reveal([pane], { distance: 18 });
    }
    mapCaption(view);
    if (changed && ['saving', 'done', 'failed'].includes(view)) {
      window.scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
    }
    el.panes[0].dataset.planning = view === 'checking' || view === 'plan' ? 'true' : 'false';
    if (view !== 'saving') document.title = view === 'done' && state.snapshot ? `Ready · ${state.snapshot.host}` : 'sitesnap';
  }

  function routeFromHash() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [name, id] = hash.split('/');
    if (name === 'library') {
      setRoute('library');
      return;
    }
    setRoute('save');
    if (name === 'snap' && id) {
      if (!state.snapshot || state.snapshot.id !== id) {
        state.pendingSnapshot = id;
        if (state.connected) send('snapshot', { id });
      }
    } else if (name === 'job' && id) {
      if (!state.job || state.job.id !== id) {
        if (state.connected) send('attach', { id });
      }
    } else if (state.view === 'done' || state.view === 'failed') {
      resetToStart();
    }
  }

  function go(hash) {
    if (location.hash === hash) routeFromHash();
    else location.hash = hash;
  }

  function quietHash(hash) {
    history.replaceState(null, '', hash);
  }

  // ---- connection --------------------------------------------------------------

  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}`);
    state.socket = socket;

    socket.addEventListener('open', () => {
      state.connected = true;
      el.conn.dataset.live = 'true';
      el.connText.textContent = 'Ready';
      const hash = location.hash.replace(/^#\/?/, '').split('/');
      const attach = hash[0] === 'job' ? hash[1] : store.get('job');
      send('hello', { attach: attach || undefined });
    });

    socket.addEventListener('close', () => {
      state.connected = false;
      el.conn.dataset.live = 'false';
      if (state.closedForGood) {
        el.connText.textContent = 'Closed';
        return;
      }
      el.connText.textContent = 'Reconnecting';
      window.setTimeout(connect, 1500);
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(msg);
    });
  }

  /**
   * The free hosted page can't open folders, sign in for you, or run the
   * built-in browser, so those controls are removed rather than left to fail.
   */
  function applyHosted(hosted) {
    document.documentElement.dataset.hosted = hosted ? 'true' : 'false';
    const gone = [
      el.optModern.closest('.opt'),
      el.optRobots.closest('label'),
      el.optSubdomains && el.optSubdomains.closest('label'),
      el.reveal,
      el.openFolder,
      el.openCopy,
    ].filter(Boolean);
    for (const node of gone) node.hidden = Boolean(hosted);
    if (hosted) {
      el.optModern.checked = false;
      el.optRobots.checked = false;
      document.getElementById('library-lede').textContent =
        `Your saves stay here for ${hosted.keepMinutes} minutes, then they are deleted from this page. Download what you want to keep.`;
    }
  }

  function handle(msg) {
    switch (msg.type) {
      case 'hello':
        state.hello = msg;
        state.viewPort = msg.viewPort;
        state.engine = msg.engine || { state: 'missing' };
        el.quit.hidden = !msg.appMode;
        el.libraryPath.textContent = msg.libraryPath;
        applyHosted(msg.hosted);
        setLibrary(msg.items, msg.running);
        renderEngine();
        if (state.pendingSnapshot) send('snapshot', { id: state.pendingSnapshot });
        break;

      case 'library':
        setLibrary(msg.items, msg.running);
        break;

      case 'inspected':
        if (msg.reqId === state.reqId) onInspected(msg);
        break;

      case 'started':
        onStarted(msg.record);
        break;

      case 'start-failed':
        setBusy(el.save, false);
        showFailure(msg.error);
        break;

      case 'job':
        onJob(msg.job);
        break;

      case 'page':
        if (state.job && msg.id === state.job.id) onPage(msg.page);
        break;

      case 'file':
        if (state.job && msg.id === state.job.id) map.addFile(msg);
        break;

      case 'log':
        if (state.job && msg.id === state.job.id) onLog(msg);
        break;

      case 'progress':
        if (state.job && msg.id === state.job.id) onProgress(msg.progress);
        break;

      case 'done':
        if (state.job && msg.id === state.job.id) onDone(msg.record);
        break;

      case 'failed':
        if (!state.job || msg.id === state.job.id) onFailed(msg.error, msg.cancelled);
        break;

      case 'gone':
        onGone(msg.id);
        break;

      case 'snapshot':
        onSnapshot(msg.record);
        break;

      case 'engine':
        state.engine = msg;
        renderEngine();
        break;

      case 'login':
        onLogin(msg);
        break;

      case 'toast':
        toast(msg.text);
        break;

      case 'bye':
        state.closedForGood = true;
        toast('sitesnap has closed. You can close this tab.');
        break;

      default:
        break;
    }
  }

  // ---- step 1: look the site up ------------------------------------------------

  function looksLikeAddress(text) {
    return /^(https?:\/\/)?[^\s/]+\.[^\s/]{2,}/i.test(text.trim());
  }

  function lookup() {
    const value = el.address.value.trim();
    if (!value) {
      el.address.focus();
      el.form.dataset.state = 'error';
      el.hint.textContent = 'Type or paste a website address first.';
      return;
    }
    delete el.form.dataset.state;
    el.hint.textContent = 'Tip: copy it from the bar at the top of your browser.';
    if (!send('inspect', { url: value, reqId: ++state.reqId })) return;

    state.inspection = null;
    setBusy(el.lookup, true);
    el.checkError.hidden = true;
    el.plan.hidden = false;
    el.siteCard.dataset.loading = 'true';
    el.siteMedia.hidden = true;
    el.siteDesc.hidden = true;
    el.siteIcon.replaceChildren(initial(value.replace(/^https?:\/\//, '')));
    el.siteTitle.textContent = 'Looking';
    el.siteHost.textContent = '';
    el.siteFact.textContent = '';
    el.notices.replaceChildren();
    for (const node of el.plan.children) if (node !== el.siteCard) node.hidden = true;
    reveal([el.siteCard]);

    const guess = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    map.setRoot({ url: guess, title: value.replace(/^https?:\/\//, '').split('/')[0], icon: null });
    map.setState('checking');
    setView('checking');
    announce('Looking the site up.');
  }

  function onInspected(msg) {
    setBusy(el.lookup, false);
    const result = msg.result;
    if (!result.ok) {
      el.plan.hidden = true;
      map.reset();
      setView('start');
      showCheckError(result.error);
      return;
    }

    state.inspection = { token: msg.token, result };
    el.siteCard.dataset.loading = 'false';

    el.siteTitle.textContent = result.title || result.siteName || result.host;
    el.siteHost.textContent = result.finalUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    el.siteIcon.replaceChildren();
    if (result.icon) el.siteIcon.append(h('img', { src: result.icon, alt: '' }));
    else el.siteIcon.append(initial(result.siteName || result.host));

    if (result.image) {
      el.siteImage.src = result.image;
      el.siteMedia.hidden = false;
    }
    if (result.description) {
      el.siteDesc.textContent = result.description;
      el.siteDesc.hidden = false;
    }
    el.siteFact.textContent = factLine(result);

    const path = new URL(result.finalUrl).pathname;
    // The section is the folder the page sits in: /docs/intro.html is under /docs/.
    const folder = path.endsWith('/') ? path : path.replace(/[^/]*$/, '');
    const scope = result.singleFile ? 'page' : folder === '/' ? 'site' : 'section';
    document.querySelector(`input[name="scope"][value="${scope}"]`).checked = true;
    el.scopeNoteSection.textContent =
      folder === '/' ? 'Pages linked from here, up to a few clicks deep.' : `Everything under ${decodeURIComponent(folder)}`;
    el.scopeNoteSite.textContent = `Every page we can reach on ${result.host}.`;
    const base = result.host.split('.').slice(-2).join('.');
    el.subdomainNote.textContent = `Also save addresses like blog.${base} and shop.${base}.`;
    syncScope();

    el.optModern.checked = Boolean(result.needsJs && state.engine.state === 'ready');
    el.optRobots.checked = false;
    syncModern();
    renderNotices();

    for (const node of el.plan.children) node.hidden = false;
    reveal([...el.plan.children].slice(1));

    map.setRoot({ url: result.finalUrl, title: result.siteName || result.title || result.host, icon: result.icon || null });
    map.setState('plan');
    setView('plan');
    mapLabel();
    announce(`Found ${result.title || result.host}. Choose how much to save, then press Save this site.`);
  }

  function factLine(result) {
    if (result.singleFile) return 'A single file, ready to save.';
    if (result.sitemap && result.sitemap.found) {
      return `The site lists ${fmt(result.sitemap.count)}${result.sitemap.capped ? '+' : ''} pages.`;
    }
    if (result.links > 0) return `${plural(result.links, 'page is', 'pages are')} linked from this one.`;
    if (result.siteLinks > 0) return `It links to ${plural(result.siteLinks, 'page')} elsewhere on the site.`;
    return 'This page doesn’t link to other pages on the site.';
  }

  function notice(tone, text, extra) {
    return h('li', { class: 'notice', dataset: { tone } }, h('p', { class: 'notice__text' }, text), extra || null);
  }

  function renderNotices() {
    const result = state.inspection && state.inspection.result;
    el.notices.replaceChildren();
    if (!result) return;
    const items = [];

    if (result.singleFile) {
      items.push(notice('info', 'This address is a single file rather than a page. sitesnap will save just that file.'));
    }

    if (result.needsJs && state.hello && state.hello.hosted) {
      items.push(
        notice(
          'warn',
          'This site builds its pages with code, so the copy from this free page may come out blank. The sitesnap desktop app can handle sites like this.'
        )
      );
    } else if (result.needsJs) {
      if (state.engine.state === 'ready') {
        items.push(notice('good', 'This site builds its pages with code, so modern site mode is on. It takes a little longer.'));
      } else {
        items.push(
          notice(
            'warn',
            'This site builds its pages with code. Without modern site mode the copy may come out blank.',
            h('button', { class: 'btn btn--small btn--primary', type: 'button', onclick: () => openEngineSheet({ then: 'modern' }) }, 'Set up modern site mode')
          )
        );
      }
    }

    const signedIn = state.login && state.login.ready && state.login.host === result.host;
    if (signedIn) {
      items.push(notice('good', `You’re signed in to ${result.host}. sitesnap will save the pages as you see them.`));
    } else if (result.login && !(state.hello && state.hello.hosted)) {
      items.push(
        notice(
          'warn',
          'This page seems to want you signed in.',
          h('button', { class: 'btn btn--small', type: 'button', onclick: () => openLoginSheet(result.finalUrl, result.host) }, 'Sign in first')
        )
      );
    }

    if (result.robotsBlocksStart) {
      const box = h('input', { type: 'checkbox' });
      box.checked = el.optRobots.checked;
      box.addEventListener('change', () => {
        el.optRobots.checked = box.checked;
      });
      items.push(
        notice(
          'warn',
          'This site asks tools like sitesnap not to copy this page.',
          h('label', { class: 'check' }, box, h('span', {}, 'It’s my site, or I have permission'))
        )
      );
    }

    el.notices.append(...items);
  }

  function showCheckError(error) {
    el.checkError.hidden = false;
    el.checkErrorTitle.textContent = error.title;
    el.checkErrorText.textContent = error.message;
    el.checkErrorDetail.textContent = error.detail || 'No further details.';
    el.checkErrorAction.hidden = !error.action;
    el.checkErrorAction.textContent = error.actionLabel || '';
    el.checkErrorAction.onclick = () => runAction(error.action);
    el.form.dataset.state = 'error';
    reveal([el.checkError]);
    announce(`${error.title} ${error.message}`);
  }

  function syncScope() {
    const scope = document.querySelector('input[name="scope"]:checked').value;
    el.sizeSet.disabled = scope === 'page';
    $('size-aside').hidden = scope !== 'page';
  }

  function syncModern() {
    const on = el.optModern.checked;
    el.modernSub.dataset.off = on ? 'false' : 'true';
    el.optScroll.disabled = !on;
    el.optPatient.disabled = !on;
    el.engineLine.hidden = !(on && state.engine.state !== 'ready');
  }

  function renderEngine() {
    const s = state.engine.state;
    if (s === 'installing') {
      el.engineText.textContent = 'Setting up now.';
      el.engineSetup.hidden = true;
    } else if (s === 'error') {
      el.engineText.textContent = 'The last setup didn’t finish.';
      el.engineSetup.hidden = false;
      el.engineSetup.textContent = 'Try again';
    } else {
      el.engineText.textContent = 'Not set up yet. It is a one-time download of about 150 MB.';
      el.engineSetup.hidden = false;
      el.engineSetup.textContent = 'Set it up';
    }
    syncModern();
    renderEngineSheet();
    if (s === 'ready' && state.inspection) renderNotices();
  }

  function resetToStart({ keepAddress = true } = {}) {
    state.job = null;
    state.snapshot = null;
    state.inspection = null;
    store.set('job', null);
    el.plan.hidden = true;
    el.checkError.hidden = true;
    delete el.form.dataset.state;
    el.address.disabled = false;
    if (!keepAddress) el.address.value = '';
    setBusy(el.lookup, false);
    setBusy(el.save, false);
    map.reset();
    setView('start');
    mapLabel();
  }

  // ---- step 2: save ----------------------------------------------------------------

  function gatherRequest() {
    const scope = document.querySelector('input[name="scope"]:checked').value;
    const size = document.querySelector('input[name="size"]:checked').value;
    return {
      url: el.address.value.trim(),
      inspection: state.inspection ? state.inspection.token : null,
      scope,
      size,
      useLogin: Boolean(state.login && state.login.ready),
      advanced: {
        modern: el.optModern.checked,
        scroll: el.optScroll.checked,
        patient: el.optPatient.checked,
        gentle: el.optGentle.checked,
        subdomains: el.optSubdomains.checked,
        ignoreRobots: el.optRobots.checked,
        sitemap: el.optSitemap.value,
        only: el.optOnly.value,
        skip: el.optSkip.value,
        maxPages: el.optPages.value || null,
        maxMb: el.optMb.value || null,
      },
    };
  }

  function startSave() {
    if (el.optModern.checked && state.engine.state !== 'ready') {
      openEngineSheet({ then: 'save' });
      return;
    }
    if (send('start', gatherRequest())) setBusy(el.save, true);
  }

  function expectedPages(record, progress) {
    if (record.scope === 'page') return 1;
    const adv = record.advanced || {};
    const cap = Number(adv.maxPages) || SIZE_PAGES[record.size] || 150;
    const inspected = state.inspection && state.inspection.result;
    const hint = inspected ? (inspected.sitemap && inspected.sitemap.found ? inspected.sitemap.count : inspected.links + 1) : 0;
    const known = Math.max(progress ? progress.pagesQueued : 0, hint || 0, 1);
    return Math.min(cap, known);
  }

  function onStarted(record) {
    setBusy(el.save, false);
    state.snapshot = null;
    state.job = {
      id: record.id,
      record,
      shown: 0,
      eta: null,
      etaAt: 0,
    };
    store.set('job', record.id);
    quietHash(`#/job/${record.id}`);
    beginSavingView(record);
    announce(`Saving ${record.title || record.host}.`);
  }

  function beginSavingView(record) {
    el.savingTitle.textContent = displayName(record);
    for (const node of [el.tPages, el.tImages, el.tOther]) {
      node.dataset.value = '0';
      node.textContent = '0';
    }
    el.tSize.textContent = '0 B';
    el.meterFill.style.transform = 'scaleX(0)';
    el.meterPct.textContent = '0%';
    el.meterEta.textContent = 'Getting started';
    el.now.textContent = 'Looking at the first page';
    el.activity.replaceChildren();
    state.activityCount = 0;
    el.notify.checked = store.get('notify') === '1';

    const inspected = state.inspection && state.inspection.result;
    const icon = inspected && inspected.finalUrl === record.finalUrl ? inspected.icon : null;
    map.setRoot({ url: record.finalUrl || record.url, title: displayName(record), icon });
    if (!icon && record.icon && state.viewPort) {
      map.setRoot({ url: record.finalUrl || record.url, icon: `${viewOrigin()}/${record.id}/__sitesnap/icon` });
    }
    map.setState('saving');
    map.setProgress(0);
    setView('saving');
    setRoute('save');
  }

  function onJob(job) {
    const record = job.record;
    if (!state.job || state.job.id !== job.id) {
      state.job = { id: job.id, record, shown: 0, eta: null, etaAt: 0 };
      store.set('job', job.id);
      quietHash(`#/job/${job.id}`);
      beginSavingView(record);
      for (const page of job.pages) map.addPage(page);
      for (const entry of job.recent.slice(-80)) onLog(entry, { quiet: true });
    }
    onProgress(job.progress);
  }

  function onPage(page) {
    map.addPage(page);
    el.now.textContent = `Saved “${page.t || pathLabel(page.u)}”`;
    mapLabel();
  }

  const SKIP_WORDS = [
    [/robots/i, 'the site asked tools not to'],
    [/include/i, 'doesn’t match your “only save” rule'],
    [/exclude|excluded/i, 'matches your “skip” rule'],
    [/byte budget|budget/i, 'size limit reached'],
    [/blocked/i, 'private address'],
  ];

  function onLog(entry, { quiet = false } = {}) {
    let kind;
    let what;
    if (entry.k === 'page') {
      kind = 'Page';
      what = `${entry.text}  ${pathLabel(entry.url)}`;
    } else if (entry.k === 'file') {
      kind = CATEGORY_WORD[entry.c] || 'File';
      what = pathLabel(entry.url);
    } else if (entry.k === 'warn') {
      kind = 'Problem';
      what = `${pathLabel(entry.url)}: ${entry.detail || ''}`;
    } else if (entry.k === 'skip') {
      kind = 'Skipped';
      const reason = (SKIP_WORDS.find(([re]) => re.test(entry.detail || '')) || [null, entry.detail || ''])[1];
      what = `${pathLabel(entry.url)} (${reason})`;
    } else if (entry.k === 'slow') {
      kind = 'Slowing';
      what = 'The site asked us to wait between pages, so sitesnap is going gently.';
      if (!quiet) el.now.textContent = 'The site asked us to slow down, so we’re going gently.';
    } else {
      return;
    }
    const item = h('li', { dataset: { k: entry.k } }, h('span', { class: 'activity__kind' }, kind), h('span', { class: 'activity__what' }, what));
    el.activity.prepend(item);
    state.activityCount++;
    while (el.activity.childElementCount > 200) el.activity.lastElementChild.remove();
  }

  function onProgress(p) {
    const job = state.job;
    if (!job || !p) return;

    let target;
    if (p.phase === 'rewrite' && p.rewrite && p.rewrite.total) {
      target = 0.9 + 0.09 * (p.rewrite.done / p.rewrite.total);
      el.now.textContent = 'Fixing the links so the pages work offline';
    } else {
      const pagesFrac = p.pages / expectedPages(job.record, p);
      const filesFrac = p.files / Math.max(1, p.queued);
      target = Math.min(0.9, Math.min(pagesFrac, filesFrac) * 0.9);
    }
    // Never move backwards: a site that reveals more pages slows the bar
    // rather than rewinding it.
    job.shown = Math.max(job.shown, target);
    const pct = Math.min(99, Math.floor(job.shown * 100));

    el.meterFill.style.transform = `scaleX(${job.shown.toFixed(4)})`;
    el.meterBar.setAttribute('aria-valuenow', String(pct));
    el.meterPct.textContent = `${pct}%`;
    map.setProgress(job.shown);

    const images = (p.counts && p.counts.image) || 0;
    tick(el.tPages, p.pages);
    tick(el.tImages, images);
    tick(el.tOther, Math.max(0, p.files - p.pages - images));
    el.tSize.textContent = p.human;

    document.title = `${pct}% · Saving ${job.record.host}`;
    updateEta(job, p, job.shown);
  }

  function updateEta(job, p, frac) {
    const now = Date.now();
    if (p.elapsed < 8000 || frac < 0.04) return;
    const remaining = (p.elapsed * (1 - frac)) / frac;
    job.eta = job.eta === null ? remaining : job.eta * 0.8 + remaining * 0.2;
    if (now - job.etaAt < 2000) return;
    job.etaAt = now;
    const s = job.eta / 1000;
    let text;
    if (p.phase === 'rewrite') text = 'Almost done';
    else if (s < 45) text = 'Less than a minute left';
    else if (s < 90) text = 'About a minute left';
    else if (s < 3600) text = `About ${Math.round(s / 60)} minutes left`;
    else text = 'More than an hour left';
    el.meterEta.textContent = text;
  }

  function onDone(record) {
    const job = state.job;
    state.job = null;
    store.set('job', null);
    el.meterFill.style.transform = 'scaleX(1)';
    map.setProgress(1);
    showSnapshot(record, { fresh: true });
    if (job && store.get('notify') === '1') celebrate(record);
  }

  function onFailed(error, cancelled) {
    const job = state.job;
    state.job = null;
    store.set('job', null);
    if (cancelled) {
      resetToStart();
      toast('Stopped. Nothing had been saved yet.');
      quietHash('#/');
      return;
    }
    if (job) quietHash('#/');
    showFailure(error);
  }

  function showFailure(error) {
    el.failTitle.textContent = error.title;
    el.failText.textContent = error.message;
    el.failDetail.textContent = error.detail || 'No further details.';
    el.failAction.hidden = !error.action;
    el.failAction.textContent = error.actionLabel || '';
    el.failAction.onclick = () => runAction(error.action);
    map.setState('failed');
    setView('failed');
    setRoute('save');
    announce(`${error.title} ${error.message}`);
  }

  function onGone(id) {
    if (state.pendingSnapshot === id) state.pendingSnapshot = null;
    if (store.get('job') === id) store.set('job', null);
    const record = state.library.find((r) => r.id === id);
    if (record) {
      go(`#/snap/${id}`);
    } else if (location.hash.includes(id)) {
      quietHash('#/');
      resetToStart();
    }
  }

  /** Things an error or a note can offer to do. */
  function runAction(action) {
    const result = state.inspection && state.inspection.result;
    const address = (result && result.finalUrl) || el.address.value.trim();
    switch (action) {
      case 'retry':
        if (state.view === 'failed') {
          resetToStart();
          if (address) el.address.value = address;
        }
        lookup();
        break;
      case 'login': {
        let host = '';
        try {
          host = new URL(/^https?:/i.test(address) ? address : `https://${address}`).hostname;
        } catch {
          host = address;
        }
        openLoginSheet(address, host);
        break;
      }
      case 'install':
      case 'modern':
        openEngineSheet({ then: 'modern' });
        break;
      case 'robots':
        againWith({ ignoreRobots: true });
        break;
      case 'settings':
        againWith({});
        el.more.open = true;
        break;
      default:
        break;
    }
  }

  /** Back to the plan for the same address, with some options changed. */
  function againWith(changes) {
    const record = state.snapshot;
    const address = (record && record.url) || el.address.value.trim();
    resetToStart();
    el.address.value = address;
    if (changes.ignoreRobots) el.optRobots.checked = true;
    quietHash('#/');
    lookup();
  }

  // ---- step 3: the finished copy -----------------------------------------------------

  function onSnapshot(record) {
    if (state.pendingViewer === record.id) {
      state.pendingViewer = null;
      openViewer(record);
      return;
    }
    if (state.pendingSnapshot && state.pendingSnapshot !== record.id) return;
    state.pendingSnapshot = null;
    showSnapshot(record, { fresh: false });
  }

  function showSnapshot(record, { fresh }) {
    state.snapshot = record;
    const name = displayName(record);
    const stats = record.stats || {};
    const partial = record.status !== 'done';

    el.doneOver.textContent = partial ? 'Partly saved' : 'Saved';
    el.doneTitle.textContent = partial ? `Part of ${name} is saved.` : `Your copy of ${name} is ready.`;
    const size = formatBytes(stats.bytes);
    el.doneFacts.textContent = partial
      ? `It stopped early (${(record.stopReason || 'stopped').replace(/^cancelled by you$/, 'you stopped it')}), so this copy has ${plural(stats.pages || 0, 'page')} with ${fmt(Math.max(0, (stats.files || 0) - (stats.pages || 0)))} pictures and other files, ${size}.`
      : `${plural(stats.pages || 0, 'page')} with ${fmt(Math.max(0, (stats.files || 0) - (stats.pages || 0)))} pictures and other files, ${size}, saved in ${formatDuration(stats.durationMs)}.`;
    const hostedInfo = state.hello && state.hello.hosted;
    el.doneWhere.textContent = hostedInfo
      ? `Download the zip within ${hostedInfo.keepMinutes} minutes, because this page then deletes it. Unzip it and double-click “Open me.html”.`
      : `Saved ${formatWhen(record.finishedAt || record.updatedAt).replace(/^(Today|Yesterday),/, (m, d) => `${d.toLowerCase()} at`)}, in ${(state.hello && state.hello.libraryPath) || 'your library'}.`;
    el.zip.href = `/download/${record.id}`;
    el.zip.setAttribute('download', `${record.host}.zip`);
    el.update.hidden = false;

    el.notes.replaceChildren(
      ...(record.notes || []).map((n) => {
        const extra =
          n.action && n.actionLabel
            ? h('button', { class: 'btn btn--small', type: 'button', onclick: () => runAction(n.action) }, n.actionLabel)
            : null;
        return notice(n.tone === 'warn' ? 'warn' : 'info', n.text, extra);
      })
    );

    if (fresh) {
      for (const page of record.pages || []) map.addPage(page);
      map.setProgress(1);
      map.setState('done');
    } else {
      const icon = record.icon && state.viewPort ? `${viewOrigin()}/${record.id}/__sitesnap/icon` : null;
      map.load({ url: record.finalUrl || record.url, title: name, icon }, record.pages || []);
    }
    setView('done');
    setRoute('save');
    quietHash(`#/snap/${record.id}`);
    document.title = `Ready · ${record.host}`;
    mapLabel();
    if (fresh) {
      announce(`Done. Your copy of ${name} is ready.`);
      (el.openCopy.hidden ? el.zip : el.openCopy).focus({ preventScroll: true });
    }
  }

  function celebrate(record) {
    playChime();
    const name = displayName(record);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try {
        new Notification(`Your copy of ${name} is ready`, {
          body: `${plural((record.stats && record.stats.pages) || 0, 'page')} saved. Open sitesnap to see it.`,
          tag: `sitesnap-${record.id}`,
        });
      } catch {
        // some browsers only allow notifications from a service worker
      }
    }
  }

  function playChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const notes = [659.25, 987.77];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.14;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.07, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.55);
      });
      window.setTimeout(() => ctx.close(), 1200);
    } catch {
      // sound is a nicety
    }
  }

  // ---- library ------------------------------------------------------------------------

  function setLibrary(items, running) {
    state.library = items || [];
    state.running = running || [];
    el.libraryCount.hidden = state.library.length === 0;
    el.libraryCount.textContent = String(state.library.length);
    if (state.route === 'library') renderLibrary();
  }

  function renderLibrary() {
    const items = state.library;
    el.libraryEmpty.hidden = items.length > 0;
    el.shelf.replaceChildren(...items.map(card));
  }

  function card(record) {
    const running = state.running.includes(record.id);
    const name = record.title || displayName(record);
    const stats = record.stats || {};
    const canOpen = !running && stats.files > 0;

    const media = h('button', {
      class: 'snap__media',
      type: 'button',
      'aria-label': running ? `Watch ${name} being saved` : `Show ${name}`,
      onclick: () => (running ? go(`#/job/${record.id}`) : go(`#/snap/${record.id}`)),
    });
    if (record.cover && state.viewPort) {
      const img = h('img', { class: 'snap__cover', src: `${viewOrigin()}/${record.id}/__sitesnap/cover`, alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.remove());
      media.append(img);
    }
    const glyph = h('span', { class: 'snap__glyph', 'aria-hidden': 'true' });
    iconFor(record, glyph);
    if (!record.cover) media.append(glyph);
    if (running) media.append(h('span', { class: 'snap__status' }, 'Saving now'));
    else if (record.status !== 'done') media.append(h('span', { class: 'snap__status' }, 'Partly saved'));

    const meta = running
      ? `${record.host} · saving now`
      : `${record.host} · ${formatWhen(record.finishedAt || record.updatedAt)} · ${plural(stats.pages || 0, 'page')} · ${formatBytes(stats.bytes)}`;

    const actions = h(
      'div',
      { class: 'snap__actions' },
      canOpen && state.viewPort
        ? h('button', { class: 'btn btn--small btn--primary', type: 'button', onclick: () => openViewerById(record.id) }, 'Open')
        : running
          ? h('button', { class: 'btn btn--small btn--primary', type: 'button', onclick: () => go(`#/job/${record.id}`) }, 'Watch')
          : null,
      canOpen
        ? h('a', { class: `btn btn--small ${state.viewPort ? 'btn--quiet' : 'btn--primary'}`, href: `/download/${record.id}`, download: `${record.host}.zip` }, 'Zip file')
        : null,
      !running && state.viewPort
        ? h('button', { class: 'btn btn--small btn--quiet', type: 'button', onclick: () => send('reveal', { id: record.id }) }, 'Folder')
        : null,
      !running
        ? h('button', { class: 'btn btn--small btn--quiet', type: 'button', onclick: () => confirmDelete(record) }, 'Delete')
        : null
    );

    return h(
      'li',
      {},
      h(
        'article',
        { class: 'snap' },
        media,
        h(
          'div',
          { class: 'snap__body' },
          h('h2', { class: 'snap__title' }, h('button', { type: 'button', onclick: () => go(`#/snap/${record.id}`) }, name)),
          h('p', { class: 'snap__meta' }, meta)
        ),
        actions
      )
    );
  }

  function confirmDelete(record) {
    const name = displayName(record);
    el.confirmTitle.textContent = `Delete your copy of ${name}?`;
    el.confirmText.textContent = 'This removes it from your computer for good. The live website isn’t affected.';
    el.confirmYes.textContent = 'Delete it';
    el.confirmYes.onclick = () => {
      send('delete', { id: record.id });
      el.confirmSheet.close();
      if (state.snapshot && state.snapshot.id === record.id) {
        resetToStart();
        quietHash('#/library');
      }
      toast(`Deleted ${name}.`);
    };
    el.confirmSheet.showModal();
  }

  // ---- viewer ----------------------------------------------------------------------------

  function openViewerById(id) {
    const known = state.snapshot && state.snapshot.id === id ? state.snapshot : null;
    if (known && known.pages) {
      openViewer(known);
      return;
    }
    state.pendingViewer = id;
    send('snapshot', { id });
  }

  function openViewer(record, local) {
    if (!state.viewPort) return;
    const name = displayName(record);
    el.viewerTitle.textContent = name;
    iconFor(record, el.viewerIcon);

    const seenLocal = new Set();
    const pages = (record.pages || []).filter((p) => p.l && !seenLocal.has(p.l) && seenLocal.add(p.l));
    const entry = local || record.entry || (pages[0] && pages[0].l) || '';
    const list = pages
      .slice()
      .sort((a, b) => (a.l === record.entry ? -1 : b.l === record.entry ? 1 : pathLabel(a.u).localeCompare(pathLabel(b.u))));

    const show = (rel) => {
      const src = viewUrl(record.id, rel);
      el.viewerFrame.src = src;
      el.viewerTab.href = src;
      const page = pages.find((p) => p.l === rel);
      el.viewerPage.textContent = page ? page.t || pathLabel(page.u) : pathLabel(rel);
      for (const button of el.viewerList.querySelectorAll('button')) {
        button.setAttribute('aria-current', button.dataset.local === rel ? 'true' : 'false');
      }
      el.viewerPages.dataset.open = 'false';
      el.viewerPagesToggle.setAttribute('aria-expanded', 'false');
    };

    const renderList = () => {
      const q = el.viewerSearch.value.trim().toLowerCase();
      el.viewerList.replaceChildren(
        ...list
          .filter((p) => !q || `${p.t || ''} ${p.u}`.toLowerCase().includes(q))
          .slice(0, 400)
          .map((p) =>
            h(
              'li',
              {},
              h(
                'button',
                { type: 'button', dataset: { local: p.l }, onclick: () => show(p.l) },
                h('strong', {}, p.t || pathLabel(p.u)),
                h('span', {}, pathLabel(p.u))
              )
            )
          )
      );
    };

    el.viewerSearch.value = '';
    el.viewerSearch.oninput = renderList;
    renderList();
    show(entry);
    el.viewer.showModal();
    el.viewerClose.focus();
  }

  el.viewer.addEventListener('close', () => {
    el.viewerFrame.src = 'about:blank';
  });
  el.viewerClose.addEventListener('click', () => el.viewer.close());
  el.viewerPagesToggle.addEventListener('click', () => {
    const open = el.viewerPages.dataset.open !== 'true';
    el.viewerPages.dataset.open = open ? 'true' : 'false';
    el.viewerPagesToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // ---- sign in --------------------------------------------------------------------------

  let loginStep = 'intro';

  function openLoginSheet(url, host) {
    state.loginTarget = { url, host };
    loginStep = 'intro';
    el.loginTitle.textContent = `Sign in to ${host}`;
    el.loginText.textContent =
      `We’ll open a browser window on ${host}. Sign in the way you normally do. ` +
      'sitesnap never sees your password. It borrows the signed-in session for this download only, and forgets it afterwards.';
    el.loginGo.textContent = 'Open a sign-in window';
    setBusy(el.loginGo, false);
    if (!el.loginSheet.open) el.loginSheet.showModal();
  }

  el.loginGo.addEventListener('click', () => {
    const target = state.loginTarget;
    if (!target) return;
    if (loginStep === 'open') {
      setBusy(el.loginGo, true);
      send('login-finish');
      return;
    }
    if (state.engine.state !== 'ready') {
      el.loginSheet.close();
      openEngineSheet({ then: 'login' });
      return;
    }
    setBusy(el.loginGo, true);
    send('login-start', { url: target.url });
  });

  el.loginClose.addEventListener('click', () => {
    if (loginStep === 'open') send('login-cancel');
    el.loginSheet.close();
  });

  function onLogin(msg) {
    setBusy(el.loginGo, false);
    const host = msg.host || (state.loginTarget && state.loginTarget.host) || 'the site';
    switch (msg.state) {
      case 'open':
        loginStep = 'open';
        el.loginText.textContent = `A browser window is open on ${host}. Sign in there, then come back here and press the button below.`;
        el.loginGo.textContent = 'I’ve signed in';
        break;
      case 'ready':
        loginStep = 'intro';
        state.login = { host, ready: true };
        el.loginSheet.close();
        toast(`Signed in to ${host}.`);
        renderNotices();
        if (state.view === 'failed') runAction('retry');
        break;
      case 'empty':
        loginStep = 'intro';
        el.loginText.textContent = `We didn’t find a signed-in session for ${host}. Did the sign-in finish? Try once more.`;
        el.loginGo.textContent = 'Open a sign-in window';
        break;
      case 'needs-engine':
        el.loginSheet.close();
        openEngineSheet({ then: 'login' });
        break;
      case 'error':
        loginStep = 'intro';
        el.loginText.textContent = `The sign-in window couldn’t open. ${msg.message || ''}`;
        el.loginGo.textContent = 'Try again';
        break;
      default:
        break;
    }
  }

  // ---- modern site mode --------------------------------------------------------------

  function openEngineSheet({ then = null } = {}) {
    state.pendingAfterEngine = then;
    renderEngineSheet();
    if (!el.engineSheet.open) el.engineSheet.showModal();
  }

  function renderEngineSheet() {
    const s = state.engine;
    el.engineMeter.hidden = s.state !== 'installing';
    if (s.state === 'installing') {
      const pct = Number.isFinite(s.percent) ? s.percent : null;
      const step = s.step === 'browser' ? 'Downloading the built-in browser' : 'Getting the browser engine';
      el.engineStep.textContent = step;
      el.enginePct.textContent = pct === null ? '' : `${pct}%`;
      const overall = s.step === 'browser' ? 0.15 + 0.85 * ((pct || 0) / 100) : 0.15 * ((pct || 0) / 100);
      el.engineFill.style.transform = `scaleX(${overall.toFixed(3)})`;
      el.engineBar.setAttribute('aria-valuenow', String(Math.round(overall * 100)));
      el.engineGo.hidden = true;
      el.engineClose.textContent = 'Hide';
      el.engineSheetText.textContent = 'Setting up modern site mode. This can take a few minutes on a slow connection. You can keep using sitesnap.';
    } else if (s.state === 'ready') {
      el.engineGo.hidden = false;
      el.engineGo.textContent = 'Done';
      el.engineClose.hidden = true;
      el.engineSheetText.textContent = 'Modern site mode is ready. Sites that build their pages with code will now be saved properly.';
      if (el.engineSheet.open && state.pendingAfterEngine) {
        const then = state.pendingAfterEngine;
        state.pendingAfterEngine = null;
        window.setTimeout(() => continueAfterEngine(then), 700);
      }
    } else if (s.state === 'error') {
      el.engineGo.hidden = false;
      el.engineGo.textContent = 'Try again';
      el.engineClose.hidden = false;
      el.engineClose.textContent = 'Not now';
      el.engineSheetText.textContent = `The setup didn’t finish. Check your internet connection and try again. (${s.message || 'unknown error'})`;
    } else {
      el.engineGo.hidden = false;
      el.engineGo.textContent = 'Download and set up';
      el.engineClose.hidden = false;
      el.engineClose.textContent = 'Not now';
      el.engineSheetText.textContent =
        'Some websites build their pages with code after they load. To save those properly, sitesnap uses a built-in browser. It is a one-time download of about 150 MB.';
    }
  }

  function continueAfterEngine(then) {
    if (el.engineSheet.open) el.engineSheet.close();
    if (then === 'modern' || then === 'save') {
      el.optModern.checked = true;
      syncModern();
      renderNotices();
      if (then === 'save') startSave();
    } else if (then === 'login' && state.loginTarget) {
      openLoginSheet(state.loginTarget.url, state.loginTarget.host);
    }
  }

  el.engineGo.addEventListener('click', () => {
    if (state.engine.state === 'ready') {
      const then = state.pendingAfterEngine;
      state.pendingAfterEngine = null;
      if (then) continueAfterEngine(then);
      else el.engineSheet.close();
      return;
    }
    send('engine-install');
  });
  el.engineClose.addEventListener('click', () => el.engineSheet.close());
  el.engineSetup.addEventListener('click', () => openEngineSheet({ then: 'modern' }));

  // ---- wiring ------------------------------------------------------------------------

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    lookup();
  });

  el.address.addEventListener('paste', () => {
    window.setTimeout(() => {
      if (looksLikeAddress(el.address.value)) lookup();
    }, 40);
  });

  el.address.addEventListener('input', () => {
    delete el.form.dataset.state;
    if (state.inspection || !el.checkError.hidden) {
      state.inspection = null;
      el.plan.hidden = true;
      el.checkError.hidden = true;
      map.reset();
      setView('start');
    }
  });

  for (const radio of document.querySelectorAll('input[name="scope"]')) radio.addEventListener('change', syncScope);
  el.optModern.addEventListener('change', syncModern);
  el.save.addEventListener('click', startSave);
  el.change.addEventListener('click', () => {
    resetToStart();
    el.address.focus();
    el.address.select();
  });

  el.stop.addEventListener('click', () => {
    if (!state.job) return;
    send('cancel', { id: state.job.id });
    setBusy(el.stop, true);
    el.now.textContent = 'Stopping, and keeping what’s already saved';
    window.setTimeout(() => setBusy(el.stop, false), 4000);
  });

  el.notify.addEventListener('change', async () => {
    store.set('notify', el.notify.checked ? '1' : '0');
    if (el.notify.checked && 'Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // the chime still plays
      }
    }
  });

  el.openCopy.addEventListener('click', () => {
    if (state.snapshot) openViewerById(state.snapshot.id);
  });
  el.reveal.addEventListener('click', () => {
    if (state.snapshot) send('reveal', { id: state.snapshot.id });
  });
  el.again.addEventListener('click', () => {
    quietHash('#/');
    resetToStart({ keepAddress: false });
    el.address.focus();
  });
  el.update.addEventListener('click', () => {
    if (state.snapshot) send('update', { id: state.snapshot.id });
  });
  el.failBack.addEventListener('click', () => {
    quietHash('#/');
    resetToStart();
    el.address.focus();
    el.address.select();
  });
  el.openFolder.addEventListener('click', () => send('reveal-library'));
  el.confirmNo.addEventListener('click', () => el.confirmSheet.close());

  el.quit.addEventListener('click', () => {
    el.confirmTitle.textContent = 'Quit sitesnap?';
    el.confirmText.textContent = 'Anything still downloading stops and keeps what it has so far. Your library stays where it is.';
    el.confirmYes.textContent = 'Quit';
    el.confirmYes.onclick = () => {
      el.confirmSheet.close();
      send('quit');
    };
    el.confirmSheet.showModal();
  });

  window.addEventListener('hashchange', routeFromHash);

  // ---- go ------------------------------------------------------------------------------

  const firstHash = location.hash.replace(/^#\/?/, '').split('/');
  if (firstHash[0] === 'snap' && firstHash[1]) state.pendingSnapshot = firstHash[1];
  setRoute(firstHash[0] === 'library' ? 'library' : 'save');
  setView('start');
  mapLabel();
  connect();
})();
