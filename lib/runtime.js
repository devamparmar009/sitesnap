'use strict';

/**
 * Runtime URL mapping for the mirrored page.
 *
 * The rewrite pass repoints every reference it can *see*. A modern app has
 * references it cannot see, because they do not exist until the page runs:
 *
 *     const url = `https://cdn.example.com/models/${name}/${variant}.glb`;
 *     loader.load(url);
 *
 * No static rewriter can touch that — the string is assembled from three
 * variables at call time and appears nowhere in the source. three.js's own
 * glTF example does exactly this, and the consequence is a mirror that
 * *downloaded* the 3.7MB model, wrote it to disk, and then loaded the live one
 * off the internet anyway. The archive looks complete and is not: pull the
 * network and the page renders an empty canvas.
 *
 * So the mapping is also made available at runtime. A small script, loaded
 * before anything else on the page, wraps the handful of APIs a URL can be
 * handed to and translates any address it recognises into the local copy.
 *
 * Two properties keep this safe to have on by default:
 *
 *   - It is exact-match only. A URL absent from the manifest is passed through
 *     untouched, so a page that fetches something never mirrored still reaches
 *     the live site rather than a fabricated local 404. There is no guessing.
 *   - It is inert on a page that resolves nothing at runtime — every wrapper
 *     falls through to the original function.
 *
 * The manifest lives in one file at the mirror root rather than inline in
 * every page. Inlining cost a full copy per page, which on a large crawl is
 * hundreds of megabytes of duplicated JSON.
 */

const RUNTIME_FILENAME = 'sitesnap-runtime.js';

/**
 * The runtime script's source.
 *
 * @param {Array<[string, string]>} pairs  absolute URL -> mirror-root-relative path
 */
function buildRuntimeScript(pairs) {
  const map = {};
  for (const [url, local] of pairs) map[url] = local;

  return `/* sitesnap runtime URL map — generated, do not edit.
 *
 * Rewrites addresses the page builds while running, which the static pass
 * cannot see. Exact matches only: anything not listed here is left alone.
 */
(function () {
  'use strict';

  var MAP = ${JSON.stringify(map)};

  // Where this file sits relative to the page including it. Set by the tag.
  var script = document.currentScript;
  var BASE = (script && script.getAttribute('data-base')) || '';

  function lookup(raw) {
    var abs;
    try {
      abs = new URL(String(raw), document.baseURI).href;
    } catch (e) {
      return null;
    }
    var hit = MAP[abs];
    if (hit === undefined) {
      // A fragment identifies a place *within* a resource, so it plays no part
      // in which file is fetched — but it is part of the href, so it has to
      // come off before the lookup and go back on after.
      var h = abs.indexOf('#');
      if (h !== -1) {
        hit = MAP[abs.slice(0, h)];
        if (hit !== undefined) return BASE + hit + abs.slice(h);
      }
    }
    return hit === undefined ? null : BASE + hit;
  }

  /** Translate if we know the address; otherwise hand back exactly what we got. */
  function localize(raw) {
    if (raw === null || raw === undefined) return raw;
    // Never touch a scheme that does not name a fetchable http(s) resource.
    var s;
    try {
      s = String(raw);
    } catch (e) {
      return raw;
    }
    if (/^(data|blob|javascript|mailto|tel|about):/i.test(s)) return raw;
    var mapped = lookup(s);
    return mapped === null ? raw : mapped;
  }

  // --- fetch ---------------------------------------------------------------

  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function (resource, init) {
      try {
        if (typeof resource === 'string' || resource instanceof URL) {
          return nativeFetch.call(this, localize(resource), init);
        }
        // A Request object carries its URL immutably, so a changed address
        // means constructing a new one — using the original as the init, which
        // preserves method, headers, body, mode and credentials.
        if (resource && typeof resource.url === 'string') {
          var mapped = localize(resource.url);
          if (mapped !== resource.url) {
            return nativeFetch.call(this, new Request(mapped, resource), init);
          }
        }
      } catch (e) {
        /* fall through to the untouched call */
      }
      return nativeFetch.call(this, resource, init);
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------

  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        args[1] = localize(url);
      } catch (e) {
        /* keep the original */
      }
      return nativeOpen.apply(this, args);
    };
  }

  // --- element URL properties ---------------------------------------------

  // Covers img.src = url, script.src = url, link.href = url and friends: the
  // route a loader takes when it builds an element instead of calling fetch.
  // three.js's ImageLoader — every ordinary texture — goes through img.src.
  function patchProperty(ctor, prop) {
    if (!ctor || !ctor.prototype) return;
    var desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    if (!desc || !desc.set || !desc.configurable) return;
    Object.defineProperty(ctor.prototype, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (value) {
        return desc.set.call(this, localize(value));
      },
    });
  }

  patchProperty(window.HTMLImageElement, 'src');
  patchProperty(window.HTMLScriptElement, 'src');
  patchProperty(window.HTMLMediaElement, 'src');
  patchProperty(window.HTMLSourceElement, 'src');
  patchProperty(window.HTMLTrackElement, 'src');
  patchProperty(window.HTMLIFrameElement, 'src');
  patchProperty(window.HTMLEmbedElement, 'src');
  patchProperty(window.HTMLLinkElement, 'href');
  patchProperty(window.HTMLObjectElement, 'data');

  // The attribute route to the same thing.
  if (window.Element && Element.prototype.setAttribute) {
    var nativeSetAttribute = Element.prototype.setAttribute;
    var URL_ATTRS = { src: 1, href: 1, data: 1, poster: 1, srcset: 0 };
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (typeof name === 'string' && URL_ATTRS[name.toLowerCase()] === 1) {
          return nativeSetAttribute.call(this, name, localize(value));
        }
      } catch (e) {
        /* fall through */
      }
      return nativeSetAttribute.call(this, name, value);
    };
  }
})();
`;
}

/**
 * The tag that pulls the runtime in.
 *
 * Deliberately a plain, blocking `<script src>` placed first in <head>: it has
 * to finish patching before any page code runs, so neither `defer` nor `async`
 * nor `type="module"` will do — all three would let the app's own scripts fire
 * first and issue their requests against the unpatched originals.
 */
function runtimeTag(relativePath) {
  const base = relativePath.replace(new RegExp(`${RUNTIME_FILENAME}$`), '');
  return `<script src="${relativePath}" data-base="${base}"></script>`;
}

/**
 * Insert the tag as the first thing inside <head>.
 *
 * Falls back to <html>, then to the very start of the document, because a
 * mirrored page is not guaranteed to be well-formed and the script still needs
 * to run before everything else.
 */
function injectRuntime(html, tag) {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + `\n${tag}` + html.slice(at);
  }

  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + `\n${tag}` + html.slice(at);
  }

  return `${tag}\n${html}`;
}

module.exports = { buildRuntimeScript, runtimeTag, injectRuntime, RUNTIME_FILENAME };
