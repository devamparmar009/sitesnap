/* sitesnap · the sky behind the start screen and the email page.
 *
 * Ported to plain JavaScript from the Originkit "Cloud Sky" component (a WebGL
 * fragment shader: layered noise clouds, soft shading, a sun glow, slow drift).
 * Differences from the original, all deliberate:
 *   - no React or Tailwind; one canvas, one program;
 *   - colours come from the page's own tokens (--sky-*), so day and night
 *     follow the theme;
 *   - it stops drawing when it is not visible, when the tab is hidden, or when
 *     the person asked for reduced motion (then it paints one still frame);
 *   - it draws at about half resolution and 30 frames a second. Clouds are soft,
 *     so nothing is lost, and a laptop battery notices.
 * If WebGL is missing the CSS fallback gradient on .sky is what people see.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('sky-canvas');
  if (!canvas) return;
  var holder = canvas.parentNode;

  var PUFF_UP = '0.340', PUFF_DOWN = '0.190', ERODE = '0.700', SHADOW_STEP = '0.085';
  var PUFF_WMAX = '2.150', SHADE_BLEND = '12.0', FAR_MIX = '0.550';
  var NEAR_CELL = '1.050', FAR_CELL = '2.150';
  var NEAR_DRIFT = 0.055, FAR_DRIFT = 0.026, CIRRUS_DRIFT = 0.014;

  var VERT =
    'attribute vec2 a_pos;\n' +
    'void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }\n';

  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 uRes;',
    'uniform float uNearX, uFarX, uCirrusX;',
    'uniform float uCoverage, uSize, uSoftness, uShadow, uCirrus;',
    'uniform vec3 uZenith, uHorizon, uCloud;',
    'uniform vec4 uGlow;',
    'uniform vec2 uSun;',
    'uniform vec2 uParallax;',
    'vec2 hash22(vec2 p){',
    '  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));',
    '  q += dot(q, q.yzx + 33.33);',
    '  return fract((q.xx + q.yz) * q.zy);',
    '}',
    'float hash12(vec2 p){',
    '  vec3 q = fract(vec3(p.xyx) * 0.1031);',
    '  q += dot(q, q.yzx + 33.33);',
    '  return fract((q.x + q.y) * q.z);',
    '}',
    'float vnoise(vec2 x){',
    '  vec2 i = floor(x), f = fract(x);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),',
    '             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}',
    'float fbm(vec2 p){',
    '  float a = 0.5, s = 0.0;',
    '  for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; }',
    '  return s;',
    '}',
    'vec2 blobs(vec2 uv, float seed){',
    '  vec2 id = floor(uv), f = fract(uv);',
    '  float best = -1e4;',
    '  float wsum = 0.0, ysum = 0.0;',
    '  float wMax = min(' + PUFF_WMAX + ', 0.72 * uSize);',
    '  float reach = min(2.0, ceil(wMax + 0.85) - 1.0);',
    '  for (int j = -2; j <= 2; j++){',
    '    for (int i = -2; i <= 2; i++){',
    '      vec2 o = vec2(float(i), float(j));',
    '      if (max(abs(o.x), abs(o.y)) > reach) continue;',
    '      vec2 h = hash22(id + o + seed);',
    '      if (fract(h.x * 37.1) > uCoverage) continue;',
    '      vec2 c = o + 0.15 + h * 0.7;',
    '      float w = min(' + PUFF_WMAX + ', (0.30 + 0.42 * fract(h.y * 19.7)) * uSize);',
    '      vec2 d = f - c;',
    '      float ry = (d.y > 0.0 ? ' + PUFF_UP + ' : ' + PUFF_DOWN + ') * uSize * (0.8 + 0.5 * fract(h.y * 7.3));',
    '      float e = length(vec2(d.x / max(w, 1e-3), d.y / max(ry, 1e-3)));',
    '      float val = 1.0 - e;',
    '      float yN = d.y / max(ry, 1e-3);',
    '      if (val > best){',
    '        float k = exp(' + SHADE_BLEND + ' * (best - val));',
    '        wsum = wsum * k + 1.0;',
    '        ysum = ysum * k + yN;',
    '        best = val;',
    '      } else {',
    '        float g = exp(' + SHADE_BLEND + ' * (val - best));',
    '        wsum += g;',
    '        ysum += g * yN;',
    '      }',
    '    }',
    '  }',
    '  return vec2(best, ysum / max(wsum, 1e-4));',
    '}',
    'vec2 cloudField(vec2 uv, float seed, float detailScale){',
    '  vec2 b = blobs(uv, seed);',
    '  float n = fbm(uv * detailScale + seed * 3.1) * 0.72',
    '          + fbm(uv * detailScale * 3.3 + seed * 7.7) * 0.28;',
    '  return vec2(b.x - (1.0 - n) * ' + ERODE + ', b.y);',
    '}',
    'vec3 shadeCloud(float dyNorm, vec3 sky){',
    '  float t = smoothstep(-0.95, 0.25, dyNorm);',
    '  vec3 base = mix(uCloud * 0.52, sky, 0.34);',
    '  return mix(mix(uCloud, base, uShadow), uCloud, t);',
    '}',
    'void main(){',
    '  vec2 frag = gl_FragCoord.xy / max(uRes.y, 1.0);',
    '  float aspect = uRes.x / max(uRes.y, 1.0);',
    '  vec2 p = vec2(frag.x, frag.y);',
    '  vec3 sky = mix(uHorizon, uZenith, smoothstep(-0.15, 1.05, p.y));',
    '  vec2 sunP = vec2(uSun.x * aspect, uSun.y);',
    '  float sd = length(p - sunP);',
    '  sky += uGlow.rgb * uGlow.a * exp(-sd * 3.4) * 0.30;',
    '  vec3 col = sky;',
    '  if (uCirrus > 0.0) {',
    '    vec2 cuv = vec2(p.x * 1.4 + uCirrusX, p.y * 5.5);',
    '    float veil = fbm(cuv) * fbm(cuv * 2.3 + 9.0);',
    '    veil = smoothstep(0.24, 0.55, veil) * smoothstep(0.15, 0.7, p.y);',
    '    col = mix(col, uCloud, veil * uCirrus * 0.5);',
    '  }',
    '  vec2 fuv = vec2(p.x + uFarX, p.y) * ' + FAR_CELL + ' + uParallax * 0.4;',
    '  vec2 fd = cloudField(fuv, 17.0, 11.0);',
    '  float fa = clamp(fd.x * uSoftness, 0.0, 1.0);',
    '  if (fa > 0.0) {',
    '    vec3 lit = shadeCloud(fd.y, sky);',
    '    col = mix(col, mix(lit, sky, ' + FAR_MIX + '), fa);',
    '  }',
    '  vec2 nuv = vec2(p.x + uNearX, p.y) * ' + NEAR_CELL + ' + uParallax;',
    '  vec2 nd = cloudField(nuv, 3.0, 8.5);',
    '  float na = clamp(nd.x * uSoftness, 0.0, 1.0);',
    '  if (na > 0.0) {',
    '    vec3 lit = shadeCloud(nd.y, sky);',
    '    float above = clamp(cloudField(nuv + vec2(0.0, ' + SHADOW_STEP + '), 3.0, 8.5).x * uSoftness, 0.0, 1.0);',
    '    lit *= 1.0 - 0.18 * uShadow * above;',
    '    lit += uGlow.rgb * uGlow.a * 0.22 * exp(-length(p - sunP) * 1.6);',
    '    col = mix(col, lit, na);',
    '  }',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false });
  if (!gl) return; // the CSS gradient stays

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('sitesnap sky shader:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  var locs = {};
  function u(name) {
    if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name);
    return locs[name];
  }

  /** "#rrggbb" or "rgb(a)(...)" to [r, g, b, a] in 0..1. */
  function parseColor(input, fallback) {
    var str = String(input || '').trim();
    if (str.charAt(0) === '#') {
      var hex = str.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (hex.length >= 6) {
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        if (!isNaN(r + g + b)) return [r / 255, g / 255, b / 255, 1];
      }
      return fallback;
    }
    var m = str.match(/[\d.]+/g);
    if (m && m.length >= 3) {
      return [Math.min(255, +m[0]) / 255, Math.min(255, +m[1]) / 255, Math.min(255, +m[2]) / 255, m.length >= 4 ? Math.min(1, +m[3]) : 1];
    }
    return fallback;
  }

  var colors = {};
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    colors.zenith = parseColor(cs.getPropertyValue('--sky-zenith'), [0.49, 0.71, 0.93, 1]);
    colors.horizon = parseColor(cs.getPropertyValue('--sky-horizon'), [0.86, 0.93, 0.98, 1]);
    colors.cloud = parseColor(cs.getPropertyValue('--sky-cloud'), [1, 1, 1, 1]);
    colors.glow = parseColor(cs.getPropertyValue('--sky-glow'), [1, 0.94, 0.82, 0.9]);
  }
  readColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    readColors();
    paintOnce();
  });

  // Gentler than the component's defaults: this sits behind text.
  var settings = {
    coverage: 0.7,
    size: 1.3,
    speed: 0.5,
    softness: 4.5,
    shadow: 0.45,
    cirrus: 0.45,
    sunX: 0.78,
    sunY: 0.92,
    parallax: 1.0,
    wind: 1.0,
  };

  var nearX = 0, farX = 0, cirrusX = 0, leanX = 0, leanY = 0;
  var pointer = { x: 0, y: 0, inside: false };
  var last = performance.now();
  var raf = 0;
  var lastDraw = 0;

  function draw(dt) {
    var k = 1 - Math.exp(-2.4 * dt);
    leanX += ((pointer.inside ? pointer.x : 0) - leanX) * k;
    leanY += ((pointer.inside ? pointer.y : 0) - leanY) * k;

    var rate = settings.speed * (1 + leanX * settings.wind);
    nearX = (nearX - NEAR_DRIFT * rate * dt) % 1000;
    farX = (farX - FAR_DRIFT * rate * dt) % 1000;
    cirrusX = (cirrusX - CIRRUS_DRIFT * rate * dt) % 1000;

    var scale = Math.min(window.devicePixelRatio || 1, 2) * 0.55;
    var bw = Math.max(2, Math.round((holder.clientWidth || window.innerWidth) * scale));
    var bh = Math.max(2, Math.round((holder.clientHeight || window.innerHeight) * scale));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    gl.viewport(0, 0, bw, bh);

    gl.uniform2f(u('uRes'), bw, bh);
    gl.uniform1f(u('uNearX'), nearX);
    gl.uniform1f(u('uFarX'), farX);
    gl.uniform1f(u('uCirrusX'), cirrusX);
    gl.uniform1f(u('uCoverage'), settings.coverage);
    gl.uniform1f(u('uSize'), settings.size);
    gl.uniform1f(u('uSoftness'), settings.softness);
    gl.uniform1f(u('uShadow'), settings.shadow);
    gl.uniform1f(u('uCirrus'), settings.cirrus);
    gl.uniform2f(u('uSun'), settings.sunX, settings.sunY);
    gl.uniform2f(u('uParallax'), -leanX * settings.parallax * 0.07, -leanY * settings.parallax * 0.05);
    gl.uniform3f(u('uZenith'), colors.zenith[0], colors.zenith[1], colors.zenith[2]);
    gl.uniform3f(u('uHorizon'), colors.horizon[0], colors.horizon[1], colors.horizon[2]);
    gl.uniform3f(u('uCloud'), colors.cloud[0], colors.cloud[1], colors.cloud[2]);
    gl.uniform4f(u('uGlow'), colors.glow[0], colors.glow[1], colors.glow[2], colors.glow[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    holder.dataset.live = 'true';
  }

  function paintOnce() {
    draw(0);
  }

  function frame(now) {
    raf = 0;
    if (!shouldRun()) return;
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < 33) return; // about 30 frames a second
    var dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    lastDraw = now;
    draw(dt);
  }

  function visibleView() {
    var d = document.body.dataset;
    if (document.body.hasAttribute('data-always-sky')) return true;
    return d.route === 'save' && (d.view === 'start' || d.view === 'checking');
  }

  function shouldRun() {
    return !document.hidden && !reduced.matches && visibleView();
  }

  function sync() {
    holder.dataset.on = visibleView() ? 'true' : 'false';
    if (shouldRun()) {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    } else if (visibleView()) {
      paintOnce(); // reduced motion or hidden tab: one still frame
    }
  }

  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['data-view', 'data-route'] });
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);

  window.addEventListener(
    'pointermove',
    function (e) {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = 1 - (e.clientY / window.innerHeight) * 2;
      pointer.inside = true;
    },
    { passive: true }
  );
  document.documentElement.addEventListener('pointerleave', function () {
    pointer.inside = false;
  });

  sync();
})();
