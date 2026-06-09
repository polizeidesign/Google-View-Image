/**
 * Polizei Google Image V1.9 - Mete Uzun — pgi-content.js
 * Restores "View image" on Google Images (single content script).
 *
 * Resolution:
 *   On the current build the visible panel image is itself the original, so we
 *   read its URL directly when it is non-Google-hosted. Otherwise we map the
 *   encrypted-tbn token of the thumbnail to the original URL using data parsed
 *   from the inline bootstrap script(s).
 */
(function () {
  'use strict';

  /* §1 CONSTANTS & STATE */

  const MARKER_CLASS = 'pgi-view-image';
  const VIEW_IMAGE_LABEL = 'View image';
  const MIN_PREVIEW_PX = 180;
  const GAP_PX = 8;
  const OVERLAY_Z = 2147483646;

  let initialized = false;
  let rafId = 0;
  let scriptObserver = null;
  let onPageHide = null;

  let overlay = null; // our persistent <a>, child of <body>
  let cachedVisit = null; // last known native Visit anchor
  let cachedSelectionKey = null; // visit.href the cached URL belongs to
  let cachedImageUrl = null;

  const imageMap = new Map();
  const parsedScripts = new WeakSet();

  function isVisible(el) {
    if (!el || !el.isConnected) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function isImageSearchPage() {
    const params = new URLSearchParams(location.search);
    return params.get('udm') === '2' || params.get('tbm') === 'isch';
  }

  /* §2 URL / STRING HELPERS */

  function isAllowedImageUrl(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function isGoogleHosted(url) {
    try {
      const host = new URL(url).host.toLowerCase();
      return (
        host === 'google.com' ||
        host.endsWith('.google.com') ||
        host.endsWith('.gstatic.com') ||
        host.endsWith('.googleusercontent.com')
      );
    } catch (_) {
      return false;
    }
  }

  function unescapeJsString(raw) {
    if (!raw) {
      return '';
    }
    try {
      return JSON.parse('"' + raw + '"');
    } catch (_) {
      return raw
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\');
    }
  }

  function extractTbnToken(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }
    const match = url.match(/tbn:([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /* §3 BOOTSTRAP PARSING — thumbnail-token -> original-image map */

  const THUMB_ORIGINAL_RE =
    /\["(https:\/\/encrypted-tbn0\.gstatic\.com\/images[^"]*)",\d+,\d+\]\s*,\s*\["(https?:[^"]+)",\d+,\d+\]/g;

  function findBootstrapScripts() {
    const scripts = document.querySelectorAll('script:not([src])');
    const out = [];
    for (let i = 0; i < scripts.length; i++) {
      const text = scripts[i].textContent;
      if (text && text.indexOf('encrypted-tbn0.gstatic.com') !== -1) {
        out.push(scripts[i]);
      }
    }
    return out;
  }

  function parseBootstrapText(text) {
    const entries = [];
    if (!text) {
      return entries;
    }
    THUMB_ORIGINAL_RE.lastIndex = 0;
    let match;
    while ((match = THUMB_ORIGINAL_RE.exec(text)) !== null) {
      const token = extractTbnToken(match[1]);
      if (!token) {
        continue;
      }
      const imageUrl = unescapeJsString(match[2]);
      if (!isAllowedImageUrl(imageUrl)) {
        continue;
      }
      entries.push({ token: token, imageUrl: imageUrl });
    }
    return entries;
  }

  function buildImageMap() {
    const scripts = findBootstrapScripts();
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      if (parsedScripts.has(script)) {
        continue;
      }
      parsedScripts.add(script);
      const entries = parseBootstrapText(script.textContent || '');
      for (let e = 0; e < entries.length; e++) {
        const entry = entries[e];
        if (!imageMap.has(entry.token)) {
          imageMap.set(entry.token, { imageUrl: entry.imageUrl });
        }
      }
    }
  }

  /* §4 RESOLUTION & VISIT DISCOVERY */

  function getLargestVisibleImage() {
    const imgs = document.images;
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (!isVisible(img)) {
        continue;
      }
      const rect = img.getBoundingClientRect();
      if (rect.width < MIN_PREVIEW_PX || rect.height < MIN_PREVIEW_PX) {
        continue;
      }
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    }
    return best;
  }

  /**
   * Resolve the original image URL for the open panel.
   *   1. If the visible panel image is itself the original (non-Google host),
   *      use its src directly.
   *   2. Otherwise treat it as an encrypted-tbn thumbnail and map its token to
   *      the original URL from the bootstrap data.
   */
  function resolveImageUrl() {
    const img = getLargestVisibleImage();
    if (!img) {
      return null;
    }
    const src = img.currentSrc || img.src || '';

    if (isAllowedImageUrl(src) && !isGoogleHosted(src)) {
      return src;
    }

    const token = extractTbnToken(src);
    if (token) {
      let entry = imageMap.get(token);
      if (!entry) {
        buildImageMap();
        entry = imageMap.get(token);
      }
      if (entry && isAllowedImageUrl(entry.imageUrl)) {
        return entry.imageUrl;
      }
    }
    return null;
  }

  function getRenderedText(el) {
    return (el.innerText || el.textContent || '').trim();
  }

  function isVisitTextAnchor(anchor) {
    if (!anchor || anchor.classList.contains(MARKER_CLASS)) {
      return false;
    }
    if (!isVisible(anchor)) {
      return false;
    }
    return getRenderedText(anchor).toLowerCase() === 'visit';
  }

  function findVisitButton() {
    const nodes = document.querySelectorAll('a');
    const matches = [];
    for (let i = 0; i < nodes.length; i++) {
      if (isVisitTextAnchor(nodes[i])) {
        matches.push(nodes[i]);
      }
    }
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  /**
   * Return the live Visit anchor, reusing the cached node while it is still
   * valid to avoid scanning every anchor each animation frame.
   */
  function currentVisit() {
    if (cachedVisit && cachedVisit.isConnected && isVisitTextAnchor(cachedVisit)) {
      return cachedVisit;
    }
    cachedVisit = findVisitButton();
    return cachedVisit;
  }

  /* §5 OVERLAY BUTTON (body-level, pinned to Visit) */

  function stripInteractiveAttributes(root) {
    const ATTRS = ['jsaction', 'ping', 'data-ved', 'jsname', 'data-jsarwt', 'oncontextmenu'];
    const nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      for (let a = 0; a < ATTRS.length; a++) {
        if (node.removeAttribute) {
          node.removeAttribute(ATTRS[a]);
        }
      }
    }
  }

  function setButtonLabel(root, label) {
    const leaves = root.querySelectorAll('*');
    for (let i = 0; i < leaves.length; i++) {
      const node = leaves[i];
      if (node.children.length === 0 && (node.textContent || '').trim().length > 0) {
        node.textContent = label;
        return;
      }
    }
    if (root.children.length === 0) {
      root.textContent = label;
    }
  }

  /**
   * Build the persistent overlay by cloning the native Visit anchor (so it
   * inherits Google's pill styling) and parking it on <body>. Rebuilt only if
   * it has somehow been lost.
   */
  function ensureOverlay(visit) {
    if (overlay && overlay.isConnected) {
      return;
    }
    const node = visit.cloneNode(true);
    stripInteractiveAttributes(node);
    node.classList.add(MARKER_CLASS);
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    node.setAttribute('aria-label', VIEW_IMAGE_LABEL);
    node.setAttribute('title', VIEW_IMAGE_LABEL);
    setButtonLabel(node, VIEW_IMAGE_LABEL);
    node.style.position = 'fixed';
    node.style.zIndex = String(OVERLAY_Z);
    node.style.margin = '0';
    node.style.display = 'none';
    document.body.appendChild(node);
    overlay = node;
  }

  function hideOverlay() {
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  function positionOverlay(visit) {
    const rect = visit.getBoundingClientRect();
    overlay.style.display = '';
    let left = rect.left - overlay.offsetWidth - GAP_PX;
    if (left < 4) {
      left = rect.right + GAP_PX;
    }
    overlay.style.top = Math.round(rect.top) + 'px';
    overlay.style.left = Math.round(left) + 'px';
  }

  /* §6 ANIMATION-FRAME LOOP */

  function tick() {
    rafId = requestAnimationFrame(tick);

    if (!isImageSearchPage()) {
      hideOverlay();
      return;
    }

    const visit = currentVisit();
    if (!visit || !isVisible(visit)) {
      hideOverlay();
      return;
    }

    // Resolve only when the selection changes (cheap steady state). Retries
    // naturally on subsequent frames until the original image is available.
    if (visit.href !== cachedSelectionKey) {
      const resolved = resolveImageUrl();
      if (resolved) {
        cachedSelectionKey = visit.href;
        cachedImageUrl = resolved;
      }
    }

    if (!cachedImageUrl || cachedSelectionKey !== visit.href) {
      hideOverlay();
      return;
    }

    ensureOverlay(visit);
    if (overlay.dataset.pgiUrl !== cachedImageUrl) {
      overlay.setAttribute('href', cachedImageUrl);
      overlay.href = cachedImageUrl;
      overlay.dataset.pgiUrl = cachedImageUrl;
    }
    positionOverlay(visit);
  }

  /* §7 SCRIPT OBSERVER (incremental bootstrap data from infinite scroll) */

  function installScriptObserver() {
    if (scriptObserver) {
      return;
    }
    scriptObserver = new MutationObserver(function (mutations) {
      let hasNewData = false;
      for (let m = 0; m < mutations.length; m++) {
        const added = mutations[m].addedNodes;
        for (let n = 0; n < added.length; n++) {
          const node = added[n];
          if (node.nodeType === 1 && node.tagName === 'SCRIPT' && !node.src) {
            const text = node.textContent;
            if (text && text.indexOf('encrypted-tbn0.gstatic.com') !== -1) {
              hasNewData = true;
            }
          }
        }
      }
      if (hasNewData) {
        buildImageMap();
      }
    });
    scriptObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  /* §8 LIFECYCLE */

  function init() {
    if (initialized) {
      return;
    }
    initialized = true;

    buildImageMap();
    installScriptObserver();
    rafId = requestAnimationFrame(tick);

    onPageHide = function () {
      destroy();
    };
    window.addEventListener('pagehide', onPageHide, { once: false });
  }

  function destroy() {
    if (!initialized) {
      return;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (scriptObserver) {
      scriptObserver.disconnect();
      scriptObserver = null;
    }
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    cachedVisit = null;
    cachedSelectionKey = null;
    cachedImageUrl = null;
    initialized = false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
