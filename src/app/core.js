/* ══ CORE ═══════════════════════════════════════════════════════════════════
   Shared state and machinery that every view relies on. The app is a set of plain scripts that share one global
   scope, loaded in order by the loader in index.html:

     core.js         this file: timers, shared helpers, app state, tag filter, image tiers, routing and the
                     address, search index, item DOM factory, detail contraction, panel scrolling,
                     view transitions and the bridges between views, keyboard input, panel scroll anchor
     components.js   info overlay, search box (with its reset/cancel button), random shuffle, view switcher,
                     image lightbox
     map.js          map and monad views, NetVis canvas, map layout, camera and zoom, search view
     list.js         list view
     grid.js         grid view
     tag.js          tag cloud in the sidebar, and the list's curves to it (desktop only)
     item.js         the phone's full-screen item detail (loaded on a phone only)
     main.js         fetches items.json and starts the app; loaded last

   Code at the top level of a file may only use what is declared in the same file or an earlier one; a function
   body can use anything, since it only runs once all files are in. Search for a heading in CAPITALS to jump to it. */

const UI_TRANS_MS = 750;
const UI_HOVER_MS = 188;
const UI_EASE = 'ease-in-out';
const NETVIS_FADE_MS = Math.max(80, Math.round(UI_HOVER_MS * 0.6));

/* ══ TIMER REGISTRY ════════════════════════════════════════════════════════ */

/* ── Timer registry ────────────────────────────────────────────────────────
   Every deferred callback belongs to a named SLOT, and scheduling into a slot cancels whatever it was holding,
   so "the newer intent wins" is a property of the system rather than something each call site re-implements with
   its own handle. */
const _timerSlots = new Map();     // slot -> { id, isFrame }
const _timerGroups = new Map();    // group -> array of ids (all timeouts)

/** Drop pending work in the named slots. Unknown or empty slots are no-ops. */
function _cancel(...slots) {
    for (let i = 0; i < slots.length; i++) {
        const entry = _timerSlots.get(slots[i]);
        if (!entry) continue;
        if (entry.isFrame) cancelAnimationFrame(entry.id);
        else clearTimeout(entry.id);
        _timerSlots.delete(slots[i]);
    }
}

/** Run fn once `busy` stops reporting motion, polling every stepMs and giving up waiting after capMs. With keep, a call
 *  while the slot is still polling leaves that poll alone rather than restarting it. */
function _afterSettled(slot, fn, { busy = _viewTransitionActive, stepMs = 90, capMs = 3000, keep = false } = {}) {
    if (keep && _pending(slot)) return;
    let waited = 0;
    const poll = () => {
        if (busy() && waited < capMs) {
            waited += stepMs;
            _after(slot, poll, stepMs);
            return;
        }
        fn();
    };
    _after(slot, poll, stepMs);
}

/** True while the slot holds work that has not fired or been cancelled. */
function _pending(slot) {
    return _timerSlots.has(slot);
}

/** Run fn after ms, replacing whatever the slot held. Mirrors setTimeout's
 *  argument order so call sites read the same as the code they replaced. */
function _after(slot, fn, ms) {
    _cancel(slot);
    const id = setTimeout(() => {
        _timerSlots.delete(slot);   // clear BEFORE fn, so fn can re-arm the slot
        fn();
    }, ms);
    _timerSlots.set(slot, { id: id, isFrame: false });
    return id;
}

/** Run fn on the next animation frame, replacing whatever the slot held. */
function _onFrame(slot, fn) {
    _cancel(slot);
    const id = requestAnimationFrame((t) => {
        _timerSlots.delete(slot);   // clear BEFORE fn, so a loop can re-arm
        fn(t);
    });
    _timerSlots.set(slot, { id: id, isFrame: true });
    return id;
}

/** Add a timer to a GROUP rather than a slot: groups accumulate instead of
 *  replacing, for fan-outs that arm several timers at once (the list fold). */
function _afterIn(group, fn, ms) {
    const ids = _timerGroups.get(group) || [];
    const id = setTimeout(() => {
        const live = _timerGroups.get(group);
        if (live) {
            const at = live.indexOf(id);
            if (at >= 0) live.splice(at, 1);
        }
        fn();
    }, ms);
    ids.push(id);
    _timerGroups.set(group, ids);
    return id;
}

/** Drop every timer in a group. */
function _cancelGroup(group) {
    const ids = _timerGroups.get(group);
    if (!ids) return;
    for (let i = 0; i < ids.length; i++) clearTimeout(ids[i]);
    _timerGroups.delete(group);
}

/* ══ SHARED HELPERS ════════════════════════════════════════════════════════
   Small things used by more than one file or subsystem, which is the only reason they are here rather than
   beside their callers. */

/** The <article> for an item id, or null. Item ids are prefixed to keep them
 *  out of the same namespace as the UI chrome's element ids. */
function _articleById(id) {
    return document.getElementById('i_' + id);
}

/** The <article> for the current monad centre, or null when nothing is selected. */
function _centerArticle() {
    return selectedMonadId ? _articleById(selectedMonadId) : null;
}

/** An article's image: fast path via firstElementChild, query as fallback. */
function _articleImg(article) {
    return (article.firstElementChild && article.firstElementChild.tagName === 'IMG')
        ? article.firstElementChild
        : article.querySelector('img');
}

/** Current image tier: 's' when unset. */
function _imgTier(img) {
    return (img.dataset && img.dataset.tier) || 's';
}

/** An image's current src, '' when it has none. */
function _imgSrc(img) {
    return img.currentSrc || img.getAttribute('src') || '';
}

/** True once the image shows real pixels. An EMPTY src counts as not real -
 *  it happens when _setSmallSrc runs before the element is connected. */
function _hasRealSrc(img) {
    const cur = _imgSrc(img);
    // The small tier arrives inline from items.json, so "real" can no longer mean "not
    // a data: URI": every small image is one. _STUB_SRC is a single shared
    // constant, so identity with it is the exact test.
    return !!cur && cur !== _STUB_SRC;
}

/** True while the image still shows its inline data: stub. */
function _hasStubSrc(img) {
    return _imgSrc(img) === _STUB_SRC;
}

/** Clamp to the unit interval: the shape most of the zoom/progress maths wants. */
function _clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

/** Clamp n to [a, b]. */
function _clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

/** A time custom property on :root in ms ("450ms" or "0.45s"), or the fallback when unset or unitless. */
function _cssMs(name, fallback = 350) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    if (v.endsWith('ms')) return n;
    if (v.endsWith('s')) return n * 1000;
    return fallback;
}

/** A length custom property in px, 0 when unset. A registered <length> computes to px; an engine without @property hands back the declared token instead, so plain rem, vmin and vh are resolved here as well (vh against innerHeight, close enough for a fallback). */
function _cssLengthPx(el, name) {
    if (!el) return 0;
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (v.endsWith('rem')) return n * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    if (v.endsWith('vmin')) return n * Math.min(window.innerWidth, window.innerHeight) / 100;
    if (v.endsWith('vh')) return n * window.innerHeight / 100;
    return v.endsWith('px') ? n : 0;
}

/** Escape text for HTML (content and attribute values). */
function _esc(s) {
    return ((s === undefined || s === null) ? '' : s).toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* Items carrying the tag currently under the pointer in the sidebar, or null when no chip is hovered. Written by
   tag.js, which is desktop-only, and read by the netvis draw in map.js, which is not — hence declared here, where
   both can see it in every configuration. */
let _tagPeekIds = null;

/** Whether the click that is being handled ended a drag over text rather than being a plain click. A selection is
 *  still live at click time, so anything that would close or navigate away has to stand down: the reader is
 *  highlighting an author or a source to copy it, not asking for the thing under the pointer. */
function _endsTextSelection() {
    const s = window.getSelection && window.getSelection();
    return !!(s && !s.isCollapsed && String(s).trim());
}

/** Whether the reader asked for reduced motion. */
function _prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** Text lines to paragraph markup: lines are grouped at empty-line boundaries and each group becomes a <span
 *  class="para"> of <br>-separated lines, with the inter-paragraph gap coming from a CSS margin on adjacent .para
 *  siblings. */
function _paragraphsHtml(textLines) {
    const paras = [];
    let cur = [];
    for (const ln of (textLines || [])) {
        if (ln === '') { if (cur.length) { paras.push(cur); cur = []; } }
        else cur.push(ln);
    }
    if (cur.length) paras.push(cur);
    return paras.map(p => `<span class="para">${p.map(_esc).join('<br>')}</span>`).join('');
}

/** Live screen-space centre of an article's image; false when it can't be measured yet.
 *  Writes into a module-level scratch rather than returning a fresh object, since the netvis loop calls this per linked item per frame. */
const _imgCenterOut = { cx: 0, cy: 0 };
function _measureImgCenter(article) {
    const img = article.querySelector('img');
    if (!img || !img.complete || !img.naturalWidth) return false;
    const r = img.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return false;
    _imgCenterOut.cx = r.left + r.width / 2;
    _imgCenterOut.cy = r.top + r.height / 2;
    return true;
}

/** Re-render whichever view is active. The three renderers are mutually
 *  exclusive and every caller wants the same dispatch. */
function _updateActiveView() {
    if (viewMode === 'map') updateMapView();
    else if (viewMode === 'search') updateSearchView();
    else if (viewMode === 'monad') updateMonadView();
}

/** Re-enable transitions and stop the next pointer interaction from killing them again.
 *  cancelPending also drops a queued notransition re-arm; the two staged-tag-transition sites deliberately leave that queue alone. */
function _resumeTransitions(cancelPending = true) {
    document.body.classList.remove('notransition');
    if (cancelPending) _cancel('render.notransitionClass');
    isInteracting = false;
    _suppressBeginInteractionOnce = true;
}

/** Back to the centred overview and repaint. */
function _resetMapCamera() {
    zoom = 0;
    panX = 0;
    panY = 0;
    update();
}

/* Two points at exactly the same position have no direction to separate along, so derive a deterministic angle
   from the pair's indices: the same pair always gets the same nudge and layouts stay reproducible. */
const _jitterOut = { dx: 0, dy: 0, d2: 0 };
function _coincidentJitter(i, j) {
    const h = (i * 73856093) ^ (j * 19349663);
    const a = (h % 6283) / 1000;
    _jitterOut.dx = Math.cos(a) * 1e-6;
    _jitterOut.dy = Math.sin(a) * 1e-6;
    _jitterOut.d2 = _jitterOut.dx * _jitterOut.dx + _jitterOut.dy * _jitterOut.dy;
    return _jitterOut;
}

/** Jaccard overlap of two SORTED index lists, merged in O(|a|+|b|) instead of scanning a full one-hot vector.
 *  UMAP wants the distance (1 - this), the attraction matrix wants the similarity. */
function _sortedOverlapRatio(a, b) {
    let i = 0, j = 0, inter = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { inter++; i++; j++; }
        else if (a[i] < b[j]) i++;
        else j++;
    }
    const union = a.length + b.length - inter;
    return union === 0 ? 0 : inter / union;
}

// The classes that hide an item structurally (filtered out, off the ring, not yet revealed), as opposed to off screen.
const _SUPPRESSED_HIDE_CLASSES = ['monad-zero', 'monad-low', 'search-hidden', 'tag-filtered-out', 'tag-transition-hide', 'monad-stagger-hide'];
/** True when an article carries a class that legitimately strips its src, so
 *  an image sweep must not treat the missing image as a failed load. */
function _isSuppressedHidden(article) {
    for (let k = 0; k < _SUPPRESSED_HIDE_CLASSES.length; k++) {
        if (article.classList.contains(_SUPPRESSED_HIDE_CLASSES[k])) return true;
    }
    return false;
}

/** Toggle monad-native-size on the centre item: true once the image is displayed at or beyond its natural pixel width, where zooming further stops adding detail.
 *  Called from both paths that can be first to observe the zoomed-in flip. */
function _syncMonadNativeSize() {
    if (!selectedMonadId) return null;
    const ca = _articleById(selectedMonadId);
    if (!ca) return null;
    const img = ca.querySelector('img');
    const natW = parseInt(ca.style.getPropertyValue('--nat-w')) || (img && img.naturalWidth) || 0;
    ca.classList.toggle('monad-native-size',
        !!(img && natW > 0 && img.getBoundingClientRect().width >= natW));
    // Returned because both callers go on to use the element for text-fit.
    return ca;
}

/** Keep CSS timing vars in sync with the JS constants (single source of truth). */
(function _syncUiCssVars(){
    const r = document.documentElement;
    if (!r) return;
    r.style.setProperty('--uiTrans', UI_TRANS_MS + 'ms');
    r.style.setProperty('--uiHoverTrans', UI_HOVER_MS + 'ms');
    r.style.setProperty('--uiEase', UI_EASE);
    // Used by the canvas opacity transition (time token, e.g. "150ms").
    r.style.setProperty('--netvisFadeTrans', NETVIS_FADE_MS + 'ms');
})();
let items = [];


/* ══ VIEW TRANSITIONS & MODE SWITCHING ═════════════════════════════════════ */

/** Drop any hover state that was active when a transition begins.
 *
 *  The CSS rules keep hover from being ARMED during a transition (pointer-events: none), but a hover already in effect would be stranded:
 *  pointerout never fires for an element that merely stopped being a hit target, so the netvis highlight would persist for the whole motion. */
function _suppressHoverForTransition() {
    if (_netHoverId) _netSetHover(_netHoverId, false);
}

const _loadingOverlay = document.getElementById('loading-overlay');

/** Show/hide the center loading indicator. */
function _setLoading(isLoading) {
    if (!_loadingOverlay) return;
    const _ind = document.getElementById('loading-indicator');
    if (isLoading) {
        _loadingOverlay.classList.remove('hidden');
        _loadingOverlay.setAttribute('aria-busy', 'true');
    } else {
        // Pin the indicator where the pulse currently is, then ease it out with the overlay's fade so it blends rather than snapping off.
        if (_ind) {
            const _cur = getComputedStyle(_ind).opacity;
            _ind.style.animation = 'none';
            _ind.style.opacity = _cur;
            void _ind.offsetWidth; // commit the pinned value as the fade's start
            _ind.style.transition = 'opacity 0.5s ease';
            _ind.style.opacity = '0';
        }
        _loadingOverlay.classList.add('hidden');
        _loadingOverlay.setAttribute('aria-busy', 'false');

        // Remove the overlay on its OWN fade end (the indicator's transitionend also bubbles), with a timeout fallback for backgrounded tabs.
        let _removed = false;
        const _removeOverlay = function() {
            if (_removed) return;
            _removed = true;
            _loadingOverlay.removeEventListener('transitionend', _onEnd);
            if (_loadingOverlay.parentNode) {
                _loadingOverlay.parentNode.removeChild(_loadingOverlay);
            }
        };
        const _onEnd = function(e) {
            if (e.target !== _loadingOverlay || e.propertyName !== 'opacity') return;
            _removeOverlay();
        };
        _loadingOverlay.addEventListener('transitionend', _onEnd);
        setTimeout(_removeOverlay, 800);
    }
}


// Start in loading state (main.js fetches and prepares items.json).
_setLoading(true);


// WebKit/Safari detection (desktop + iOS). Used for a few performance workarounds.
const __ua = navigator.userAgent || '';
const isAppleWebKit = /AppleWebKit/.test(__ua) && /Apple/.test(navigator.vendor || '');
document.body.classList.toggle('is-webkit', isAppleWebKit);
// Inside an iframe the corner controls step back (see body.is-embedded in the stylesheet). A cross-origin parent
// still allows the comparison; the catch is for browsers that refuse to name window.top at all.
const isEmbedded = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
document.body.classList.toggle('is-embedded', isEmbedded);

// Address-bar jank: the root font scales with vh, so a toolbar toggle reflows every rem-based dimension
// mid-scroll. Read the px the stylesheet's calc() produced and pin that, re-pinning only on width change
// (orientation).
let _rootFontLastW = -1;
function _pinRootFont() {
    if (!isMobile) return; // desktop: leave the CSS calc() untouched
    const w = window.innerWidth || 0;
    if (!w || w === _rootFontLastW) return; // width unchanged → keep the pinned size
    _rootFontLastW = w;
    const de = document.documentElement;
    de.style.fontSize = '';                            // let the stylesheet calc() resolve
    de.style.fontSize = getComputedStyle(de).fontSize; // pin that resolved px value
}
_pinRootFont();
requestAnimationFrame(_pinRootFont); // retry once dimensions have settled
/* Whether the last resize changed the width. On a touch screen a height-only resize is the browser's bars sliding in or
   out while the page scrolls, and re-laying out the list, the grid or the detail for it made scrolling judder. The
   first resize listener registered, so the others can read it for the same event. */
let _resizeLastW = window.innerWidth;
let _resizeWidthChanged = true;
function _heightOnlyResizeOnTouch() {
    return !_resizeWidthChanged && isMobile && (_isPanelView() || viewMode === 'monad');
}
window.addEventListener('resize', () => {
    _resizeWidthChanged = window.innerWidth !== _resizeLastW;
    _resizeLastW = window.innerWidth;
    _pinRootFont();
    _rootRemPxVal = 0; // the root size is a viewport formula; re-read it lazily
    /* And so is everything derived from it. _netGetRootCSCache holds the line width as fontSize * 0.1 and was only ever dropped on a colour-scheme change, so a resized window kept drawing at the old weight: in the map's edges as much as in the list's tag curves, since both read this one cache. */
    _netInvalidateRootCSCache();
});
window.addEventListener('orientationchange', () => {
    // After a rotation the viewport settles a moment later; force a re-pin.
    setTimeout(() => { _rootFontLastW = -1; _pinRootFont(); }, 250);
});


// Use SCROLL_BEHAVIOR for any programmatic scroll: instant on mobile, smooth on desktop. Direct gestures never route through scrollTo({}).
const SCROLL_BEHAVIOR = isMobile ? 'instant' : 'smooth';

// View state
let viewMode = 'map'; // 'map', 'monad', 'search', 'list' or 'grid'
/** The two views that replace the map surface with a scrolling panel of their own. The map's pan, zoom and drag input stands down in both, and the map stays in its plain state underneath. */
function _isPanelView() { return viewMode === 'list' || viewMode === 'grid'; }
let selectedMonadId = null;
let _selectedMonadItem = null;
let attractionMatrix = null;

// Monad: direct internal links of the selected item. They ride the same ring as
// every other related item and are told apart only by class, label and image tier.
let _monadLinkedIds = [];
let _monadLinkedSet = new Set();
// Pre-computed linked ids/sets per center item (built once during init)
let _preLinkedIds = {};   // centerId -> [linkedId, ...]
let _preLinkedSet = {};   // centerId -> Set(linkedId, ...)

/** Root font size in px. The root size is a viewport formula, so this is cached until the window changes. */
let _rootRemPxVal = 0;
function _rootRemPx() {
    if (!_rootRemPxVal) _rootRemPxVal = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return _rootRemPxVal;
}

/** The corner buttons' diameter in px, measured on #info-btn: phones set their own size (--ui-btn-w), and the custom
 *  property's computed value keeps its clamp() unresolved. Falls back to the desktop clamp while the button has no box. */
function _uiBtnWpx() {
    const b = document.getElementById('info-btn');
    const w = b ? parseFloat(getComputedStyle(b).width) : 0;
    return w > 0 ? w : Math.max(36, Math.min(3 * _rootRemPx(), 48));
}

/* The gap between the corner buttons and a selected item's image on a phone, in rem. Small: the image should read as sitting just clear of the chrome, not as starting a new block below it. */
const MOBILE_SELECTION_GAP_REM = 0.9;

/** Where a selected item's image starts on a phone, in px from the top of the window: clear of the corner buttons
 *  by MOBILE_SELECTION_GAP_REM. One number for the list, the grid and the monad, so an item opens at the same
 *  height whichever view opened it. */
function _mobileSelectionTopPx() {
    const rem = _rootRemPx();
    const edge = _cssLengthPx(document.documentElement, '--edge') || 1.3 * rem;
    const btn = _cssLengthPx(document.documentElement, '--ui-btn-w') || 4 * rem;
    return edge + btn + MOBILE_SELECTION_GAP_REM * rem;
}


/** Safety net over the visible, unhidden map images, run after transitions settle and on load errors. It repairs an
 *  empty src (left on a phone when a hide class that stripped it goes without a follow-up setImgTier), retries a failed
 *  load at the image's own tier, and re-asserts a reveal that was superseded (a stub showing where dataset._wantReal asks for a real image). */
const MAX_IMG_RETRIES = 2;
let _imgSweepDeferrals = 0;
function _sweepImageHealth() {
    if (viewMode !== 'map') return 0;
    if (items.length === 0) return 0;

    // Never swap src mid-transition: Chromium drops the in-flight bitmap, so an item would
    // flash while it is still moving. Re-arm and run once against the settled state, with a
    // cap so a stuck transition class can't keep the sweep polling forever.
    if (_viewTransitionActive()
        && _imgSweepDeferrals < 20) {
        _imgSweepDeferrals++;
        _scheduleImageHealthSweep(250);
        return 0;
    }
    _imgSweepDeferrals = 0;

    // Repair items that lost src to the suppress path. Cheap when nothing to do.
    let _retried = 0;
    for (let i = 0, len = items.length; i < len; i++) {
        const article = items[i]._article;
        if (!article) continue;
        // Skip if currently hidden: src is correctly absent or stale-OK.
        if (_isSuppressedHidden(article)) continue;
        if (article.classList.contains('placeholder-img')) continue;
        if (article.classList.contains('map-offscreen')) continue;

        const img = article.querySelector('img');
        if (!img) continue;

        // src set but bitmap missing: complete && naturalWidth === 0. Images still in flight (complete false) are skipped.
        const _src = img.getAttribute('src') || '';
        if (!_src) {
            if (isMobile) setImgTier(img, 's');
            continue;
        }

        // A stub data: URI is normally the intended state: off-viewport, or zoomed out past
        // the reveal, and skipping it unconditionally is what made a lost reveal permanent.
        // _wantReal marks the one case where a stub IS wrong: a real bitmap was asked for here.
        const _isStubSrc = _src === _STUB_SRC;
        const _wantReal = !!(img.dataset && img.dataset._wantReal === '1');
        if (_isStubSrc && !_wantReal) continue;

        const _failedFlag = img.dataset && img.dataset._loadFailed === '1';
        const _decodeFailed = img.complete && img.naturalWidth === 0;
        // Reveal wanted but a stub is still showing: the assignment was abandoned rather than
        // attempted and failed, so there is no error flag to key off.
        const _lostReveal = _isStubSrc && _wantReal;
        if (!_failedFlag && !_decodeFailed && !_lostReveal) continue;
        // A real request still in flight is not a failure yet.
        if (!_lostReveal && !img.complete) continue;

        // Retry cap per img, reset when src changed since the failure, otherwise an image that failed at tier 's' stays capped after upgrading to 'l'.
        let _retries = (img.dataset && parseInt(img.dataset._retryCount, 10)) || 0;
        const _recordedFailedSrc = (img.dataset && img.dataset._failedSrc) || '';
        if (_recordedFailedSrc && _recordedFailedSrc !== _src) {
            _retries = 0;
            delete img.dataset._failedSrc;
        }
        if (_retries >= MAX_IMG_RETRIES) continue;

        // Clear the failure flag and bump the counter; onload/onerror re-settle it on the next attempt.
        img.dataset._retryCount = String(_retries + 1);
        delete img.dataset._loadFailed;
        delete img.dataset._failedSrc;
        // Retry at the tier the image is actually on. At 's' call _setSmallSrc with forceReal directly: routing through
        // setImgTier with a cleared dataset.tier lands in its new-request branch, where stub mode assigns a STUB, so the
        // retry spent its budget turning a failed load into a coloured square that only a hover could clear, and the
        // stub src then made every later sweep skip the item.
        const _tier = _imgTier(img);
        if (_tier === 's') {
            _setSmallSrc(img, items[i].id, { forceReal: true });
        } else {
            delete img.dataset.tier;
            setImgTier(img, _tier);
        }
        _retried++;
    }
    return _retried;
}

/** Debounced wrapper around _sweepImageHealth, coalescing bursts of onerror callbacks (many images timing out during a network blip) into a single sweep. */
function _scheduleImageHealthSweep(delayMs) {
    _after('img.healthSweep', function() {
        _sweepImageHealth();
    }, typeof delayMs === 'number' ? delayMs : 250);
}

/* ── Tag filter + tag sidebar ─────────────────────────────────────────────── */
let activeTag = '';          // tag-only filter (distinct from full-text search)

function __mainVW() {
    // Map/monad stay centered on the full window; the tag pane is an overlay.
    return Math.max(1, window.innerWidth - _mainInsetPx());
}

/** Px width of the strip the info panel has taken, 0 when it is closed. Read from --main-inset, which is a registered <length> and so computes to px. */
let _mainInsetVal = -1;
let _mainInsetKeyW = -1;
let _mainInsetKeyH = -1;
function _invalidateMainInset() { _mainInsetVal = -1; }
function _mainInsetPx() {
    if (!document.body.classList.contains('info-open')) return 0;
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    if (_mainInsetVal >= 0 && _mainInsetKeyW === w && _mainInsetKeyH === h) return _mainInsetVal;
    _mainInsetVal = Math.max(0, Math.round(_cssLengthPx(document.body, '--main-inset')));
    _mainInsetKeyW = w;
    _mainInsetKeyH = h;
    return _mainInsetVal;
}

/* Horizontal bias applied to the map/monad centre while the desktop tag pane is shown. Deliberately a CONSTANT rather than _tagSidebarW / 3. */
const _TAG_PANE_CENTER_BIAS_PX = 73;

function __mainCenterX() {
    const cx = __mainVW() / 2;
    // Bias the centre away from the tag pane so the layout doesn't feel lopsided.
    if (document.body.classList.contains('has-tag-sidebar') && _tagSidebarW > 0) {
        return cx + _TAG_PANE_CENTER_BIAS_PX;
    }
    return cx;
}

function _clearSearchState() {
    searchInput.value = '';
    document.body.classList.remove('search-has-query');
    document.body.classList.remove('search-open');
    searchBox.classList.remove('open');
    searchQuery = '';
    searchScores = {};
    _searchBreathingKey = '';
    _subsetFitZoom = 0;
    if (!activeTag) _resetBreathingLayout();
}

/* ══ TAG VIS HOOKS ══════════════════════════════════════════════════════════════
   The tag vis (tag.js: the tag cloud in the sidebar and the list's curves to it) is desktop only; a phone never
   loads it. The other files reach it through tagVis, whose methods do nothing until tag.js fills them in, plus the
   few things about the sidebar that the layout needs either way. */

const tagVis = {
    update(force) {},                   // re-derive the cloud (debounced unless force)
    updateAfterTransition() {},         // the same, once the view transition in flight has settled
    updateAfterListMotion(extraEl) {},  // the same, once a list row's fold has settled
    requestSettle() {},                 // a trailing update once a drag or wheel-zoom quiets
    quietForFilterChange() {},          // hold recomputes for the length of a tag change
    setActiveOnly() {},                 // move the active highlight, nothing else
    invalidateSizes() {},               // forget measured chip sizes (resize)
    bindLinkRows() {},                  // re-observe the list's rows for the curves
    linksSettle(ms) {},                 // redraw the curves for a while as things move
    drawLinksNow() {},                  // redraw the curves in this frame (after a scroll written from code)
};

/** After a state change: the cancel button follows the state, and almost every state change passes through here;
 *  then the tag vis, where there is one. */
function _scheduleTagCloudUpdate(force = false) {
    _updateCancelButton();
    requestAnimationFrame(_updateCancelButton);
    tagVis.update(force);
}

const _tagSidebarEl = document.getElementById('tag-sidebar');

let _tagSidebarW = 0;        // px; the sidebar's width, written by tag.js

/** Whether the tag sidebar shows: on desktop, in a window wide enough for it. */
function _tagSidebarEnabled() {
    return !isMobile && window.innerWidth > 820;
}

/** Without the tag pane (a phone, or a window too narrow for it) the search box carries the tag filter: "#tag" typed
 *  there filters by the tag, and an active tag shows there as "#tag". */
function _tagsInSearchBox() {
    return !_tagSidebarEnabled();
}
/** Items by id, rebuilt when the collection changes size. */
let _tagItemByIdCache = null;
let _tagItemByIdCacheN = 0;


/** The item the current view has open, whichever view that is: the map's monad, an expanded grid card, an
 *  expanded list row. Empty when nothing is selected. */
function _selectedItemId() {
    if (viewMode === 'monad') return selectedMonadId || '';
    if (viewMode === 'grid') return gridSelectedId || '';
    if (viewMode === 'list') return listSelectedId || '';
    return '';
}

function _getTagItemById() {
    if (!_tagItemByIdCache || _tagItemByIdCacheN !== (items ? items.length : 0)) {
        _tagItemByIdCache = Object.create(null);
        _tagItemByIdCacheN = items ? items.length : 0;
        for (let i = 0; i < (items ? items.length : 0); i++) {
            const it = items[i];
            if (it && it.id) _tagItemByIdCache[it.id] = it;
        }
    }
    return _tagItemByIdCache;
}

/* ══ TAG FILTER ══════════════════════════════════════════════════════════════ */

function _clearTagFilterState() {
    activeTag = '';
    _subsetFitZoom = 0;
    _applyTagFilterToMap();
    _syncTagToSearchBox();
}

/** Clear tag filter with staggered animation (fade out → move → fade in). */
function _clearTagFilterKeepView(push = true) {
    if (!activeTag) return;
    const oldTag = activeTag;
    activeTag = '';
    if (!(searchQuery || '').trim()) _subsetFitZoom = 0;    // Ensure tag fade transitions are not suppressed.
    _resumeTransitions();

    _syncTagToSearchBox();

    // List view: no stagger, just apply immediately.
    if (viewMode === 'list') {
        _applyTagFilterToMap();
        _commitFilterChange(push);
        return;
    }
    if (viewMode === 'grid') {
        _applyTagFilterToMap();
        _gridFilterChanged(push);
        return;
    }

    // --- Staggered: fade out → move/zoom → fade in ---

    // All items that were hidden (not matching old tag) will be entering.
    const entering = [];
    for (let i = 0; i < items.length; i++) {
        const wasVis = items[i].tags && items[i].tags.includes(oldTag);
        if (!wasVis) entering.push(i);
    }

    // Phase 1: pre-hide entering items so they don't flash.
    // Items that were visible stay visible: no leaving items when clearing.
    triggerAnimation();
    for (let i = 0; i < entering.length; i++) {
        const article = getOrCreateArticle(items[entering[i]]);
        article.classList.add('tag-filtered-out');
    }

    // Phase 2: reset breathing, zoom/pan to default, move items.
    const phaseDelay = 20; // no leaving items, proceed almost immediately
    setTimeout(() => {
        if (activeTag !== '') return; // stale: user selected another tag

        _resetBreathingLayout();
        _applyTagFilterToMap(); // removes tag-filtered-out from items matching old tag (all of them)

        // Re-add tag-filtered-out on entering items (applyTagFilterToMap just removed it)
        for (let i = 0; i < entering.length; i++) {
            const article = getOrCreateArticle(items[entering[i]]);
            article.classList.add('tag-filtered-out');
        }

        _resumeTransitions(false);
        triggerAnimation();

        if (viewMode === 'map') {
            _resetMapCamera();
        } else {
            update();
        }

        // Phase 3: fade in entering items after move completes.
        if (entering.length > 0) {
            setTimeout(() => {
                if (activeTag !== '') return;
                triggerAnimation();
                for (let i = 0; i < entering.length; i++) _revealTagEntering(items[entering[i]]);
                // Update tag cloud once entering items have faded in.
                setTimeout(() => {
                    if (activeTag !== '') return;
                    _scheduleTagCloudUpdate(true);
                }, UI_TRANS_MS + 50);
            }, 500);
        }

        // Update tag cloud once items finish moving to final positions.
        setTimeout(() => {
            if (activeTag !== '') return;
            _scheduleTagCloudUpdate(true);
        }, UI_TRANS_MS + 50);
    }, phaseDelay);

    _commitFilterChange(push);
}

/** Everything that must follow a tag/search filter change: hash, document title,
 *  tag cloud refresh and the cancel button's visibility. */
function _commitFilterChange(push) {
    _setHashForCurrentState(push);
    _updateDocTitle();
    // The highlight follows the click immediately; the frequencies follow the view.
    tagVis.setActiveOnly();
    // Order matters: the highlight above has already moved, so the window that follows holds back only the frequencies.
    tagVis.quietForFilterChange();
    tagVis.updateAfterTransition();
    _updateCancelButton();
}

let _deferredTagHideToken = 0;

function _clearDeferredTagHideState() {
    _cancel('tag.deferredHide', 'tag.deferredHideFinalize');
    _deferredTagHideToken++;
    for (let i = 0, len = items.length; i < len; i++) {
        const it = items[i];
        const article = it._article;
        if (!article) continue;
        article.classList.remove('tag-transition-hide');
    }
}

function _scheduleDeferredTagHide(itemIds, tag) {
    const ids = Array.isArray(itemIds) ? itemIds.filter(Boolean) : [];
    const targetTag = (tag || '').trim();
    if (!ids.length || !targetTag) return;

    _clearDeferredTagHideState();
    const token = _deferredTagHideToken;
    const startDelay = Math.max(70, Math.min(120, Math.round(UI_TRANS_MS * 0.18)));

    // Both stages abort if the user has moved on: a newer deferred hide, a
    // view change, or a different tag all invalidate this one.
    const stillCurrent = () => token === _deferredTagHideToken
        && viewMode === 'map'
        && (activeTag || '').trim() === targetTag;
    const swapClass = (from, to) => {
        for (let i = 0; i < ids.length; i++) {
            const article = _articleById(ids[i]);
            if (!article) continue;
            article.classList.remove(from);
            article.classList.add(to);
        }
    };

    _after('tag.deferredHide', () => {
        if (!stillCurrent()) return;
        swapClass('tag-filtered-out', 'tag-transition-hide');

        _after('tag.deferredHideFinalize', () => {
            if (!stillCurrent()) return;
            swapClass('tag-transition-hide', 'tag-filtered-out');
            _scheduleTagCloudUpdate(true);
        }, UI_TRANS_MS);
    }, startDelay);
}

/** The payload of a #list: or #grid: hash for the current filter and a selection: the filter ("q:<query>", a tag, or nothing), then "/" and the selected id. A selection sits inside a filter rather than replacing it, so both are written. */
/* ── Addresses ────────────────────────────────────────────────────────────
   #[view][/t:<tag> | /q:<query>][/i:<id>[/image] | /y:<year>] The view is list or grid, or left out for the map.
   Every other part names itself with its prefix, each value is URL-encoded on its own, and the parts are written
   in that order and read in any. #about/<address> opens the info panel over an address. */
function _parseAddress(raw = window.location.hash) {
    const a = { about: false, view: 'map', t: '', q: '', i: '', y: '', image: false };
    let h = String(raw || '').replace(/^#/, '');
    if (h === 'about' || h.startsWith('about/')) { a.about = true; h = h.slice(6); }
    if (!h) return a;
    const segs = h.split('/');
    const glued = /^(map|list|grid):(.*)$/.exec(segs[0]);   // the older #list:<value>
    if (glued) { a.view = glued[1]; segs[0] = glued[2]; }
    for (const seg of segs) {
        if (!seg) continue;
        let v;
        try { v = decodeURIComponent(seg).trim(); } catch (e) { v = seg.trim(); }
        if (v === 'map' || v === 'list' || v === 'grid') a.view = v;
        else if (v === 'image') a.image = true;
        else if (/^[tqiy]:/.test(v)) a[v[0]] = v.slice(2);
        else if (_getTagItemById()[v]) a.i = v;   // an older bare id
        else a.t = v;                               // an older bare tag
    }
    if (a.q) a.t = '';
    if (a.i) a.y = ''; else a.image = false;
    return a;
}

/** The address for a set of parts (see _parseAddress), or '' for the plain map. */
function _formatAddress({ about = false, view = 'map', t = '', q = '', i = '', y = '', image = false } = {}) {
    const segs = [];
    if (view === 'list' || view === 'grid') segs.push(view);
    if (q) segs.push('q:' + encodeURIComponent(q));
    else if (t) segs.push('t:' + encodeURIComponent(t));
    if (i) {
        segs.push('i:' + encodeURIComponent(i));
        if (image) segs.push('image');
    } else if (y) segs.push('y:' + encodeURIComponent(y));
    const body = segs.join('/');
    if (about) return '#about' + (body ? '/' + body : '');
    return body ? '#' + body : '';
}

/** The live filter as address parts: a search of two or more characters, else the tag, else nothing. */
function _filterParts() {
    const q = (searchQuery || '').trim();
    const t = (activeTag || '').trim();
    return (q.length >= 2) ? { q } : (t ? { t } : {});
}

/** The address of a view with the live filter, plus an item or a year. */
function _viewAddress(view, extra) {
    return _formatAddress({ view, ..._filterParts(), ...extra });
}

/** Put an address in the bar, as a new history entry (push) or in place. */
function _writeAddress(parts, push) {
    const h = _formatAddress(parts) || (window.location.pathname + window.location.search);
    if (push) history.pushState(null, '', h);
    else history.replaceState(null, '', h);
}

/** Put the list's or grid's filter into the state an address names (a search, a tag, or none; an unknown tag counts as none). Returns true when the tag or query actually changed. */
function _setPanelFilterFromAddress(a) {
    const q0 = (searchQuery || '').trim();
    const t0 = (activeTag || '').trim();
    const filter = a.q ? '' : a.t;
    if (a.q) {
        const q = a.q;
        if (t0) _clearTagFilterState();
        searchInput.value = q;
        searchQuery = q;
        searchScores = (q.length >= 2) ? computeSearchScores(q) : {};
        document.body.classList.toggle('search-has-query', !!q);
        searchBox.classList.toggle('open', q.length > 0);
        document.body.classList.toggle('search-open', q.length > 0);
    } else if (filter) {
        if (q0 || (searchInput && searchInput.value.trim())) _clearSearchState();
        activeTag = _tagExists(filter) ? filter : '';
        _syncTagToSearchBox();
        _applyTagFilterToMap();
    } else {
        if (q0 || (searchInput && searchInput.value.trim())) _clearSearchState();
        if (t0) _clearTagFilterState();
    }
    return q0 !== (searchQuery || '').trim() || t0 !== (activeTag || '').trim();
}

function _setHashForCurrentState(push = false) {
    const q = (searchQuery || '').trim();
    const t = (activeTag || '').trim();
    const filter = (q.length >= 2) ? { q } : (t ? { t } : {});
    if (viewMode === 'grid') return _writeAddress({ view: 'grid', ...filter, i: gridSelectedId }, push);
    if (viewMode === 'list') return _writeAddress({ view: 'list', ...filter, i: listSelectedId }, push);
    if (viewMode === 'search' && q.length >= 2) return _writeAddress({ q }, push);
    // An open item keeps its id in the address, under the view it was opened from.
    if (viewMode === 'monad' && selectedMonadId) return _writeAddress({ view: _parseAddress().view, ...filter, i: selectedMonadId }, push);
    _writeAddress(t ? { t } : {}, push);
}

/** Fade in an item a tag change brings back (phase 3 of both staged tag transitions). tag-filtered-out is
 *  content-visibility:hidden, so on reveal Chrome and Firefox interpolate the still-transitioned transforms from a
 *  stale state: the image from its native size, the article from --art-tx/--art-ty at the origin. For the length of
 *  the fade only opacity transitions, and the resolved transforms are committed before it starts. */
function _revealTagEntering(item) {
    // Edge grace: lines to this item appear only after its fade-in completes (see _edgeGraceUntil, netvis loop).
    item._edgeGraceUntil = performance.now() + UI_TRANS_MS;
    const article = getOrCreateArticle(item);
    const img = article.querySelector('img');
    if (img) img.style.transition = 'opacity var(--uiTrans) var(--uiEase)';
    article.style.transition = 'opacity 0.375s ease';
    article.classList.remove('tag-filtered-out');
    void article.offsetWidth;
    clearTimeout(article._tagRevealTransTimer);
    article._tagRevealTransTimer = setTimeout(function() {
        article.style.removeProperty('transition');
        if (img) img.style.removeProperty('transition');
        article._tagRevealTransTimer = null;
    }, UI_TRANS_MS + 30);
    // Mobile: re-establish src stripped by the suppress path under the previous filter, or the item arrives blank.
    if (isMobile && img && !img.getAttribute('src')) setImgTier(img, 's');
}

/** Staged tag switch on the map: fade out the items the new filter drops, move and re-fit what remains, then fade in the items it adds. Shared by the tag cloud toggle and hash-driven navigation. */
function _runStagedTagTransition(oldTag, newTag) {
    // Membership predicates for the outgoing and incoming filter.
    const isOldVisible = oldTag
        ? function(it) { return it.tags && it.tags.includes(oldTag); }
        : function() { return true; };
    const isNewVisible = newTag
        ? function(it) { return it.tags && it.tags.includes(newTag); }
        : function() { return true; };

    // Classify items into leaving / staying / entering.
    const leaving = [];
    const entering = [];
    for (let i = 0; i < items.length; i++) {
        const wasVis = isOldVisible(items[i]);
        const willVis = isNewVisible(items[i]);
        if (wasVis && !willVis) leaving.push(i);
        else if (!wasVis && willVis) entering.push(i);
    }

    _suppressBeginInteractionOnce = true;

    // Phase 1: fade leaving items out, keeping entering items hidden until phase 3. Must use tag-transition-hide,
    // not tag-filtered-out: the resting class carries content-visibility: hidden, which stops painting in the same
    // frame and kills the fade.
    triggerAnimation();
    for (let i = 0; i < leaving.length; i++) {
        const article = getOrCreateArticle(items[leaving[i]]);
        article.classList.remove('tag-filtered-out');
        article.classList.add('tag-transition-hide');
    }
    for (let i = 0; i < entering.length; i++) {
        const article = getOrCreateArticle(items[entering[i]]);
        article.classList.add('tag-filtered-out');
    }

    // Phase 2 delay waits for the fade-out, or runs immediately if nothing is leaving. Mobile skips it: transitions are off there, so waiting only adds latency to the tap.
    const fadeOutMs = (leaving.length > 0 && !isMobile) ? 250 : 0;

    setTimeout(() => {
        if (activeTag !== newTag) return;   // stale: user toggled/navigated again

        // Leaving items have finished fading: settle them into the culled
        // resting class (an invisible snap) before the movement starts.
        for (let i = 0; i < leaving.length; i++) {
            const article = items[leaving[i]]._article;
            if (!article) continue;
            article.classList.remove('tag-transition-hide');
            article.classList.add('tag-filtered-out');
        }

        // Contract the surviving subset toward its gravity center (or restore
        // the full layout when the filter is cleared).
        if (newTag) {
            _breatheLayout(isNewVisible);
        } else {
            _resetBreathingLayout();
        }

        // Ensure transitions are active, then move items + fit camera.
        _resumeTransitions(false);
        triggerAnimation();

        if (viewMode === 'map' && newTag) {
            _fitVisibleBounds(isNewVisible, false);
        } else if (viewMode === 'map') {
            _resetMapCamera();
        } else {
            update();
        }

        // Phase 3: after items finish moving, fade in entering items.
        if (entering.length > 0) {
            setTimeout(() => {
                if (activeTag !== newTag) return;
                triggerAnimation();
                for (let i = 0; i < entering.length; i++) _revealTagEntering(items[entering[i]]);
                // Catch any failed-load images on both platforms with a
                // debounced sweep. No-op when there's nothing to recover.
                _scheduleImageHealthSweep();
                // Update the tag cloud once entering items have faded in.
                setTimeout(() => {
                    if (activeTag !== newTag) return;
                    _scheduleTagCloudUpdate(true);
                }, UI_TRANS_MS + 50);
            }, 500);
        }

        // Update the tag cloud once items finish moving to final positions.
        setTimeout(() => {
            if (activeTag !== newTag) return;
            _scheduleTagCloudUpdate(true);
        }, UI_TRANS_MS + 50);
    }, fadeOutMs);
}

/* ══ TAG FILTER (CONTINUED) ══════════════════════════════════════════════════ */

function _toggleTagFilter(tag, push = true) {
    const t = (tag || '').trim();
    if (!t) return;

    // Tag filter and full-text search are mutually exclusive
    if (searchQuery || (searchInput && searchInput.value.trim())) _clearSearchState();

    // Capture old state before toggling
    const oldTag = activeTag;

    // Toggle
    activeTag = (activeTag === t) ? '' : t;
    const newTag = activeTag;

    // Selecting a tag filter exits monad/search
    if (newTag && (viewMode === 'monad' || viewMode === 'search')) {
        // Clicking a tag while viewing an item means "show me everything with this keyword": fit the camera to the whole subset rather than restoring the pre-monad camera.
        if (viewMode === 'monad') _tagClickFitIntent = true;
        switchToMapView(false);
        // switchToMapView already does the breathing layout, camera fit, tag classes and stagger reveal; return early so phase 2's _fitVisibleBounds can't interrupt the monad-to-map transition mid-flight.
        _commitFilterChange(push);
        return;
    }

    // Safari (and iOS): interaction may have enabled body.notransition just before the click.
    // Clear it BEFORE toggling .tag-filtered-out so opacity fades remain visible.
    _resumeTransitions();

    _syncTagToSearchBox();

    if (viewMode === 'grid') {
        _applyTagFilterToMap();
        _gridFilterChanged(push);
        return;
    }

    // List view: no staggered animation, just apply immediately.
    if (viewMode === 'list') {
        _applyTagFilterToMap();
        // Keep a selected row pinned and collapse it as part of the fold so it doesn't jump and bounce; otherwise hold a surviving on-screen row fixed to preserve the scroll position.
        _animateListFilterDeselecting();
        _commitFilterChange(push);
        return;
    }

    /* Monad view, and by here that means the tag was DESELECTED: selecting one leaves for the map above, because
       "show me everything with this keyword" is a request about the collection and the open item is only where it
       was made. */
    if (viewMode === 'monad') {
        // The map this item returns to is now the unfiltered one. The saved camera was framed on the tag's subset, so it goes too, as on shuffle: the close lands on the overview.
        _savedMapCamera = null;
        setupMonadClasses();
        update();
        _commitFilterChange(push);
        return;
    }

    _runStagedTagTransition(oldTag, newTag);

    _commitFilterChange(push);
}

let searchQuery = '';
let searchScores = {}; // item.id -> 1 for every matching item
let _searchBreathingKey = ''; // tracks which items are visible to avoid recomputing breathing
// One-shot: skip the breathing-fit camera write in updateSearchView (positions are still computed), set when switchToSearchView reinstates a pre-monad camera the fit would overwrite.
let _suppressSearchFitOnce = false;

// True while a view transition (CSS `animated` move/fade or rAF-driven zoom) is in flight. Stub src swaps must not run then: images are still painted at pre-transition size, and Chromium drops the bitmap on src change.
function _viewTransitionActive() {
    return document.body.classList.contains('animated')
        || document.body.classList.contains('zoom-animating');
}

// Crossing detector + rAF coalescer: avoids per-frame DOM walks while panning.
let _stubLastBelow = null;     // last known state of "below threshold"
let _stubReconcilePending = false;
function _stubReconcileFromViewport() {
    // The JS `zoom` jumps to its destination as soon as an animated zoom begins, while CSS --zoom eases visually.
    const below = zoom > STUB_REVEAL_ZOOM;
    // Only act on crossings, not on every frame inside the same regime.
    if (below === _stubLastBelow) return;
    _stubLastBelow = below;
    // The two directions want opposite timing. Reveal (stub to real) stays deferred until the transition settles:
    // real bitmaps decode asynchronously, so swapping mid-move blinks every affected image in Chromium and competes
    // for frame budget.
    if (below) {
        if (_viewTransitionActive()) {
            _scheduleStubReconcileAfterTransition();
            return;
        }
        if (_stubReconcilePending) return;
        _stubReconcilePending = true;
        requestAnimationFrame(() => {
            _stubReconcilePending = false;
            if (_stubLastBelow) _stubRevealVisible();
            else _stubRestoreAll();
        });
        return;
    }
    // Destination is the stub regime → downgrade synchronously, on the
    // still-static frame in which the transition is being set up.
    _stubRestoreAll();
}

// Wait for the active transition, then apply the final stub regime once. _stubLastBelow is re-read at fire time, so a quick zoom-out and back settles on the real resting state.
function _scheduleStubReconcileAfterTransition() {
    _afterSettled('stub.reconcile', () => {
        if (_stubLastBelow) _stubRevealVisible();
        else _stubRestoreAll();
    }, { keep: true });
}

/** The map images the stub passes may touch: each item's article image at tier 's' (higher tiers belong to the
 *  selection and the lightbox). The hovered article is left to the hover handler unless includeHovered. */
function _forEachStubImage(fn, includeHovered) {
    for (let i = 0, len = items.length; i < len; i++) {
        const it = items[i];
        const article = it && it._article;
        if (!article || (!includeHovered && article === _stubHoveredArticle)) continue;
        const img = _articleImg(article);
        if (!img || _imgTier(img) !== 's') continue;
        fn(it, article, img);
    }
}

function _stubRevealVisible() {
    /* Never behind a panel. Most of the callers are timers armed while a transition was still in flight and its
       destination still open (a monad exit that ended in the list is the case that matters) and firing then gives a
       real src to every non-culled map item underneath a view that covers all of them. */
    if (viewMode === 'list' || viewMode === 'grid') return;
    _forEachStubImage((it, article, img) => {
        // An empty src counts as needing assignment: see _hasRealSrc.
        if (it._mapOffscreen || _hasRealSrc(img)) return;
        _setSmallSrc(img, it.id, { forceReal: true });
    }, true);
}

/** Hand the map's bitmaps back once a panel has taken over, on a phone. purgeHighResImages leaves the map at tier
 *  's', which is still one real thumbnail per item, and none of them is visible behind the list or the grid,
 *  while the panel's own set of the same images is live on top. */
function _stubMapBehindPanel() {
    if (!isMobile) return;
    /* Off the close's critical path. _stubRestoreAll swaps the src of every map image, and _setSmallSrc sets decoding='sync' on each so the swap presents atomically: three hundred of those is a long task, and running it in the one that closes a detail put it exactly where the phone had least to spare. */
    _after('panel.stubMap', function () {
        if (viewMode !== 'list' && viewMode !== 'grid') return;
        _stubRestoreAll();
    }, 400);
}

// Re-apply stubs to all small-tier images (called when zooming back out).
function _stubRestoreAll() {
    // The selection in the view that is showing stays real: it is the image the reader is watching, often carried across by a bridge.
    // A panel's selection counts only while that panel is showing, since the grid keeps its id after handing the item to the map side.
    const _selId = selectedMonadId
        || (viewMode === 'list' ? listSelectedId : viewMode === 'grid' ? gridSelectedId : null);
    _forEachStubImage((it, article, img) => {
        if ((_selId && it.id === _selId) || _hasStubSrc(img)) return;
        _setSmallSrc(img, it.id);
    });
}

// Monad stub policy, independent of the map viewport heuristic: every visible ring item carries its real small
// tier, hidden ones stay stubbed. The small tier is inlined in the bundle, so a ring of a dozen costs decodes and
// no requests — cheap enough that the average-colour stub isn't worth the thumbnails it costs.
function _scheduleMonadStubReconcile() {
    // update() re-runs _stubReconcileMonad with fresh state.
    _afterSettled('stub.monadReconcile', () => { if (viewMode === 'monad') update(); }, { keep: true });
}

/* ══ IMAGE TIERS & STUBS ═══════════════════════════════════════════════════ */

function _stubReconcileMonad() {
    // Never swap src mid-transition: Chromium drops the current bitmap, so upgrading linked items on the first monad frame flashed them several times while they were still flying in. Defer to a post-transition pass.
    if (_viewTransitionActive()) { _scheduleMonadStubReconcile(); return; }

    _forEachStubImage((it, article, img) => {
        const cls = article.classList;
        // Center is handled by the selection upgrade path elsewhere; skip.
        if (cls.contains('monad-center')) return;
        // Hidden monad tiers: don't bother: they're invisible anyway.
        // Leaving them stubbed is fine; reveals would just waste decode work.
        if (cls.contains('monad-low') || cls.contains('monad-zero')) return;
        // Everything left is on the ring, linked or merely similar, and shows its thumbnail.
        if (!_hasRealSrc(img)) _setSmallSrc(img, it.id, { forceReal: true });
    });
}

// Track the currently hovered article so a viewport rebuild doesn't re-stub
// the image the user is looking at. (_stubHoveredArticle is declared with the image tiers.)
function _stubHoverReveal(id) {
    const article = _articleById(id);
    if (!article) return;
    _stubHoveredArticle = article;
    const img = _articleImg(article);
    if (!img) return;
    const tier = _imgTier(img);
    if (tier !== 's') return; // selection / lightbox already loaded real bits
    if (_hasRealSrc(img)) return; // already real (an empty src still needs one)
    _setSmallSrc(img, id, { forceReal: true });
}
function _stubHoverRelease(id) {
    const article = _articleById(id);
    if (_stubHoveredArticle && _stubHoveredArticle.id === ('i_' + id)) {
        _stubHoveredArticle = null;
    }
    if (!article) return;
    const img = _articleImg(article);
    if (!img) return;
    // Only re-stub if still on the small tier.
    const tier = _imgTier(img);
    if (tier !== 's') return;
    if (_hasStubSrc(img)) return; // already stubbed

    /* Per-view re-stub policy. In monad nothing goes back to a stub: the centre is owned by the selection upgrade
       and everything else on show is a ring item, which keeps its thumbnail (see _stubReconcileMonad). Map and
       search re-stub when the viewport is in the "many items" regime where the global heuristic would stub. */
    if (viewMode !== 'monad' && !_stubLastBelow) {
        _setSmallSrc(img, id);
    }
}

// Store original title
const originalTitle = document.title;
const titleBase = originalTitle.split(':')[0].trim();

/* ══ VIEW TRANSITIONS & MODE SWITCHING (CONTINUED) ═════════════════════════ */

// ── Chromium layer promotion lifecycle (see the .lyr CSS comment) ──────────
function _promoteLayers() {
    // Cancel any in-flight demotion; a new transition needs the layers.
    _cancel('render.layerDemote', 'render.layerDemoteFrame');
    /* Never on a phone. This promotes every article AND its image to its own compositor layer (around 730 layers for
       the collection) and iOS Safari answers a layer population that size by killing the renderer. */
    if (isMobile) return;
    for (let i = 0, len = items.length; i < len; i++) {
        const a = items[i]._article;
        if (a) a.classList.add('lyr'); // no-op when already present
    }
}
function _scheduleLayerDemotion() {
    _cancel('render.layerDemote');
    // Grace period past the transition end so back-to-back moves (stagger
    // phases, chunked reveals) reuse the layers instead of thrashing them.
    _after('render.layerDemote', function() {
        // A transition started meanwhile? Its triggerAnimation re-armed us.
        if (document.body.classList.contains('animated')) return;
        const promoted = [];
        if (Array.isArray(items)) {
            for (let i = 0, len = items.length; i < len; i++) {
                const a = items[i]._article;
                if (a && a.classList.contains('lyr')) promoted.push(a);
            }
        }
        let di = 0;
        const CHUNK = 40;
        const demoteChunk = function() {
            // Abort if a new transition claimed the layers again.
            if (document.body.classList.contains('animated')) return;
            const end = Math.min(di + CHUNK, promoted.length);
            for (; di < end; di++) promoted[di].classList.remove('lyr');
            if (di < promoted.length) _onFrame('render.layerDemoteFrame', demoteChunk);
        };
        demoteChunk();
    }, 400);
}

// Transition clock. body.animated SUPPLIES the item transitions, so removing the class CANCELS whatever is
// running: the remaining distance lands in a single frame.
const TRANS_TAIL_MS = 60;
let _transitionEndsAt = 0;

/** Milliseconds from now until the current transition's committed end, plus `extra`. */
function _transitionRemainingMs(extra = 0) {
    const end = _pending('render.transitionAnchor')
        ? (performance.now() + UI_TRANS_MS)
        : _transitionEndsAt;
    return Math.max(0, end - performance.now()) + extra;
}

/** Anchor the clock on the frame the transition starts and arm the
 *  body.animated removal for its end plus the tail buffer. */
function _armTransitionClock() {
    _cancel('render.animatedClass', 'render.transitionAnchor');
    const commit = function() {
        _transitionEndsAt = performance.now() + UI_TRANS_MS;
        _after('render.animatedClass', function() {
            document.body.classList.remove('animated', 'stagger-reveal');
            _scheduleLayerDemotion();
        }, UI_TRANS_MS + TRANS_TAIL_MS);
    };
    // rAF is throttled/suspended in background tabs: fall back to the old
    // call-anchored timing there rather than leaving body.animated stuck on.
    if (document.hidden) commit();
    else _onFrame('render.transitionAnchor', commit);
}

function triggerAnimation() {
    // Before the transition is declared, so a hover active right now can't
    // ride along with the motion. See _suppressHoverForTransition.
    _suppressHoverForTransition();
    _promoteLayers();
    // A fresh transition is never a stagger tail, so clear the marker; switchToMapView re-adds it immediately after calling this.
    document.body.classList.remove('stagger-reveal');
    document.body.classList.add('animated');
    _netMarkInteraction(UI_TRANS_MS + 180);
    // In monad-desktop the netvis stays visible, so the interaction marker alone won't trigger redraws: schedule a keep-window so edges track the animating items.
    if (viewMode === 'monad' && !isMobile) _netRequestDraw(UI_TRANS_MS + 120);
    _armTransitionClock();
}

// Yield so pending paint frames can run between heavy synchronous init phases, keeping the loading indicator smooth through UMAP, attraction matrix and _mc precompute.
function _yieldToBrowser() {
    return new Promise(resolve => {
        if (document.hidden) {
            // rAFs are throttled / suspended in background tabs.
            setTimeout(resolve, 0);
        } else {
            requestAnimationFrame(() => resolve());
        }
    });
}

// Handle hash changes for browser history support
let _knownTagSet = null;
let _knownTagSetN = 0;

function _tagExists(tag) {
    if (!tag) return false;
    if (!_knownTagSet || _knownTagSetN !== items.length) {
        _knownTagSet = new Set();
        for (let i = 0, len = items.length; i < len; i++) {
            const it = items[i];
            if (!it || !it.tags) continue;
            for (let j = 0; j < it.tags.length; j++) {
                const t = it.tags[j];
                if (t) _knownTagSet.add(t);
            }
        }
        _knownTagSetN = items.length;
    }
    return _knownTagSet.has(tag);
}

/** Resolve a user-typed tag string to a real tag name: exact spelling first, then case-insensitive, returning the canonically-cased form stored in items' .tags. Null if nothing matches. */
function _resolveTagName(input) {
    const t = (input || '').trim();
    if (!t) return null;
    if (_tagExists(t)) return t;
    const lc = t.toLowerCase();
    if (_knownTagSet) {
        for (const k of _knownTagSet) {
            if (k.toLowerCase() === lc) return k;
        }
    }
    return null;
}

/* ══ ROUTING & DOCUMENT TITLE ══════════════════════════════════════════════ */

/* ── The lightbox in the address ────────────────────────────────────────────
   An open image is the item's own address with /image after it: #<id>/image, #map:<filter>/<id>/image,
   #list:<filter>/<id>/image, #grid:<filter>/<id>/image. Opening pushes it and closing goes back, so Back closes
   the image and Forward reopens it; an address arriving with /image (a link, a pasted URL, a script driving an
   embed) routes the item and then opens its image over it. */
const _IMAGE_SUFFIX = '/image';
let _imageHashBase = null;   // address the open image sits on (canonical, without /image), while /image is in the address
let _imageHashPushed = false; // whether that /image entry was pushed here, so closing can go back to its item
let _shownBase = null;       // address the router last put on screen (canonical, without /image)
let _lbFromAddress = false;  // set while the router, not a click, opens the image

/** The image a selection shows, in whichever view is showing: the monad centre (also a phone's detail), the list's open row, the grid's open card. */
function _selectedImageForLightbox() {
    if (viewMode === 'monad') {
        const a = _centerArticle();
        return a ? a.querySelector('img') : null;
    }
    if (viewMode === 'list' && listSelectedId) {
        const el = _getListItemEl(listSelectedId);
        return el ? el.querySelector('img.list-thumb') : null;
    }
    if (viewMode === 'grid' && gridSelectedId) {
        const card = _gridCardById[gridSelectedId];
        return card ? card.querySelector('img.grid-thumb') : null;
    }
    return null;
}

/** Open the image the address names, once the view has settled (wait) or at once. An item without an image has
 *  nothing to open, so its /image is dropped. */
function _openLightboxForAddress(wait) {
    const run = () => {
        if (lightboxOpen) return;
        if (!_parseAddress().image) return; // the address moved on meanwhile
        const img = _selectedImageForLightbox();
        const id = img && ((img.dataset && img.dataset.id) || _inferImgId(img));
        const item = id && _getTagItemById()[id];
        if (!img || !item || item._isPlaceholderImg) {
            history.replaceState(null, '', window.location.hash.slice(0, -_IMAGE_SUFFIX.length));
            _imageHashBase = null;
            return;
        }
        _lbFromAddress = true;
        try { openLightboxUnified(img, id); } finally { _lbFromAddress = false; }
    };
    if (!wait) { run(); return; }
    // Past the entrance: a list row or grid card takes its selection animation to grow into the rect the image leaves from.
    _after('lightbox.fromHash', () => _afterSettled('lightbox.fromHash', run), 800);
}

/** A click opened the image: put /image on the item's address as a new history entry. */
function _pushImageAddress(srcImg) {
    if (_lbFromAddress) return;
    const cur = _parseAddress();
    if (cur.image) return;
    const id = ((srcImg && srcImg.dataset && srcImg.dataset.id) || _inferImgId(srcImg) || '').trim();
    if (!id) return;
    const named = cur.i === id;
    const rawBase = named ? window.location.hash : _viewAddress(_isPanelView() ? viewMode : 'map', { i: id });
    history.pushState(null, '', rawBase + _IMAGE_SUFFIX);
    _imageHashBase = _shownBase = _formatAddress(_parseAddress(rawBase));
    _imageHashPushed = true;
}

/** The image closed: take /image off the address. A user's close of an image opened here goes back to the item's
 *  entry; anything else (an image that arrived with the address, or a close forced by a change of view) edits the
 *  address in place. */
function _dropImageAddress(userClose) {
    if (_imageHashBase === null) return;
    const pushed = _imageHashPushed;
    _imageHashPushed = false;
    if (!_parseAddress().image) { _imageHashBase = null; return; }
    if (userClose && pushed) {
        history.back();   // the router sees the item's address come back and leaves the view as it is
        return;
    }
    history.replaceState(null, '', window.location.hash.slice(0, -_IMAGE_SUFFIX.length));
    _imageHashBase = null;
}

/** The bridge the switcher would use for the change of view an address asks for, or null when the address stays in
 *  the current view. Not on a phone (views switch instantly there) and not for the about panel, which opens over
 *  whatever is showing. */
function _bridgeForHashView(a) {
    if (isMobile || a.about) return null;
    const from = _currentViewSeg();
    if (a.view === from) return null;
    if (a.view === 'grid' || from === 'grid') return _gridRectSwitch;
    // Between the map side and the list the selected item's own image travels, when both sides show the same one.
    const cur = (from === 'list') ? listSelectedId : selectedMonadId;
    if (cur && cur === a.i) return (doSwitch) => _modeBridgeSelected(cur, doSwitch);
    return _stubRectSwitch;
}
let _hashBridgeInner = false;

function handleHashChange(isInitialLoad) {
    // A new hash change supersedes any pending staged zoom-up, so rapid history flips can't fire a stale animateZoomTo(1) at the wrong item.
    _cancel('map.hashChangeZoom');
    const _addr = _parseAddress();
    // The bar shows the canonical form of whatever arrived (an older link, a hand-typed one), without a history entry.
    const _canon = _formatAddress(_addr);
    // Only once the items are in: an older bare #<id> is told from a bare #<tag> by looking the id up.
    if (items && items.length && (window.location.hash || '') !== _canon) {
        history.replaceState(null, '', _canon || (window.location.pathname + window.location.search));
    }

    // /image on the end of the address: the lightbox over the item's address (see "The lightbox in the address").
    const wantsImage = _addr.image;
    const base = _formatAddress({ ..._addr, image: false });
    if (!_hashBridgeInner) {
        if (!wantsImage && _imageHashBase !== null && base === _imageHashBase) {
            // Back (or a script) took /image off: close the image over the state that is already showing.
            _imageHashBase = null;
            _imageHashPushed = false;
            if (lightboxOpen) closeLightbox();
            _shownBase = base;
            return;
        }
        if (wantsImage && !isInitialLoad && base === _shownBase) {
            // Forward (or a script) put /image back on the state that is showing: open over it.
            _imageHashBase = base;
            if (!lightboxOpen) _openLightboxForAddress(false);
            return;
        }
    }
    if (_imageHashBase !== null) {
        _imageHashBase = null;
        _imageHashPushed = false;
    }
    if (lightboxOpen) closeLightbox(true);
    if (wantsImage) {
        // Route the item's address in place, then open its image over it: the same re-entry #about/ uses.
        const full = window.location.hash;
        history.replaceState(null, '', full.slice(0, -_IMAGE_SUFFIX.length));
        handleHashChange(isInitialLoad);
        history.replaceState(null, '', full);
        _imageHashBase = _shownBase = base;
        _openLightboxForAddress(true);
        return;
    }
    _shownBase = base;

    /* An address that changes the view (a link, Back or Forward, a pasted URL) gets the transition the switcher gives
       the same change: the routing below re-runs from inside the bridge, where the switch happens under its curtain
       and the rects fly to where it puts them. It reads the address again then, so a newer one wins. */
    if (!isInitialLoad && !_hashBridgeInner) {
        const bridge = _bridgeForHashView(_addr);
        if (bridge) {
            bridge(() => {
                _hashBridgeInner = true;
                try { handleHashChange(false); } finally { _hashBridgeInner = false; }
            });
            return;
        }
    }

    /* The about panel is an overlay ON something, so it prefixes rather than replaces: #about/t:<tag>/i:<id>,
       #about/list/q:…, or a bare #about over an unfiltered map. */
    if (_addr.about) {
        const _target = _formatAddress({ ..._addr, about: false });
        if (_target) {
            // Route the underlying state by re-entering with it in place, then open over it.
            if (window.location.hash !== _target) {
                history.replaceState(null, '', _target);
                handleHashChange(isInitialLoad);
                history.replaceState(null, '', _canon);
            }
        }
        showInfo(false, true);
        update();
        return;
    } else if (infoOverlay.classList.contains('visible')) {
        hideInfo(false);
    }

    const __clearAll = () => {
        _clearSearchState();
        _clearTagFilterState();
        listSelectedId = null;
    };

    // The plain map: no view, filter or item.
    if (_addr.view === 'map' && !_addr.t && !_addr.q && !_addr.i) {
        if (viewMode === 'map' && activeTag) {
            // Tag → full map: use staggered animation (don't push to history: we're already here)
            _clearTagFilterKeepView(false);
        } else {
            // History walked back to the unfiltered map, which is exactly what a filterless pre-monad snapshot belongs to: un-stale it so the zoom/pan is restored.
            if (_savedMapCamera && _savedMapCamera.stale
                && !(_savedMapCamera.activeTag || '')
                && !(_savedMapCamera.searchQuery || '')) {
                delete _savedMapCamera.stale;
            }
            // The address asks for the unfiltered map, so a snapshot taken under a filter goes: closing an item into it
            // would put that filter back (switchToMapView restores the snapshot's tag or query when none is active).
            if (_savedMapCamera && ((_savedMapCamera.activeTag || '') || (_savedMapCamera.searchQuery || ''))) _savedMapCamera = null;
            __clearAll();
            if (viewMode === 'list') {
                document.body.classList.remove('list-view');
                switchToMapView(false);
            } else if (viewMode === 'monad' || viewMode === 'search' || viewMode === 'grid') {
                switchToMapView(false);
            } else if (viewMode === 'map') {
                // Map without tag but maybe with zoom/pan: reset
                triggerAnimation();
                _resetMapCamera();
            }
        }
        _updateDocTitle();
        _scheduleTagCloudUpdate(true);
        return;
    }

    if (items.length === 0) return;

    // The grid: a filter (a search, a tag or none) and an item selected inside it.
    if (_addr.view === 'grid') {
        const sel = _addr.i;

        // Phone, already inside the detail: a hop from one open item to another (a linked item, or browser back/forward over one) is a swap of the centre, not a round trip out to the grid and back in.
        if (isMobile && viewMode === 'monad' && sel && _getTagItemById()[sel]) {
            if (sel !== selectedMonadId) _enterMobileItemDetail(sel, !isInitialLoad);
            _updateCancelButton();
            _scheduleTagCloudUpdate(true);
            return;
        }

        // carry: false, because the hash names the selection (below) and switchToGridView must not reinstate the monad's.
        if (viewMode !== 'grid') switchToGridView(false, true, false);
        const anim = !isInitialLoad;
        const hadSel = gridSelectedId;
        const filterChanged = _setPanelFilterFromAddress(_addr);
        listSelectedId = null;
        const selItem = sel ? _getTagItemById()[sel] : null;
        const selOk = !!(selItem && _listItemPassesFilters(selItem));
        const want = selOk ? sel : null;

        // Phone: the same state, shown as the full-screen detail. The grid underneath is given its filter and selection first, so closing is a switch back and not a rebuild.
        if (isMobile && want) {
            _gridSetSelected(want);
            renderGrid(false);
            _gridRefreshImages(false);
            _enterMobileItemDetail(want, !isInitialLoad);
            _updateCancelButton();
            _scheduleTagCloudUpdate(true);
            return;
        }

        if (filterChanged) {
            // One layout pass for filter and selection together, as _gridStopMoving's note explains: the selection is set before the collection is laid out again.
            const resized = (anim && !isMobile) ? _gridCaptureResized([hadSel, want]) : [];
            _gridSetSelected(want);
            renderGrid(anim, resized);
            _gridRefreshImages(false);
            if (want) _gridScrollToCard(want);
            else _gridScrollToTop();
        } else if (want !== gridSelectedId) {
            _gridSelect(want, { animate: anim, scroll: want ? 'center' : false, updateHash: false });
        } else if (want) {
            _gridScrollToCard(want);
        }
        // A selection the filter hides, or an unknown tag, is corrected in place.
        if ((sel && !selOk) || (_addr.t && !activeTag)) _setHashForCurrentState(false);
        _updateDocTitle();
        _updateCancelButton();
        _scheduleTagCloudUpdate(true);
        return;
    }

    // The list, as for the grid, or a year instead of an item. The filter is applied first, then the selection, which is dropped if the filter hides it.
    if (_addr.view === 'list') {
        const sel = _addr.i, year = _addr.y;

        // Phone, already inside the detail: as in the grid branch above, swap the centre rather than tearing the overlay down to rebuild the list and re-enter from it.
        if (isMobile && viewMode === 'monad' && sel && _getTagItemById()[sel]) {
            if (sel !== selectedMonadId) {
                listSelectedId = sel;
                _enterMobileItemDetail(sel, !isInitialLoad);
            }
            _updateCancelButton();
            _scheduleTagCloudUpdate(true);
            return;
        }

        const cameFromOtherMode = (viewMode !== 'list');

        if (cameFromOtherMode) {
            // carry: false, because the hash names the selection (below) and switchToListView must not reinstate the monad's.
            switchToListView(false, true, false);
        } else {
            document.body.classList.add('list-view');
            _syncViewSwitcher();
        }

        const filterChanged = _setPanelFilterFromAddress(_addr);
        const selItem = sel ? items.find(i => i.id === sel) : null;
        const selOk = !!(selItem && _listItemPassesFilters(selItem));

        // No selection (or one the filter hides): the filtered or plain list.
        if (!selOk) {
            listSelectedId = null;
            renderList();
            if (year) {
                // A linked year: after two frames, once the rows the filter keeps have their heights.
                const first = isInitialLoad || cameFromOtherMode;
                requestAnimationFrame(() => requestAnimationFrame(() => _scrollListToYear(year, !first, first)));
            } else if (!_addr.t && !_addr.q) {
                // History navigation back to the bare list always lands at the top; otherwise the previous selection's scroll position lingers.
                _scrollListToTop(isInitialLoad ? 0 : 330);
            } else if (_addr.q) {
                const _s = document.body.classList.contains('list-view') ? window : listView;
                if (_s) _s.scrollTo({ top: 0, behavior: SCROLL_BEHAVIOR });
            }
            // A selection the filter hides, or an unknown tag, is corrected in place.
            if ((sel && !selOk) || (_addr.t && !activeTag)) _setHashForCurrentState(false);
            _updateDocTitle();
            _scheduleTagCloudUpdate(true);
            return;
        }

        // A selection, inside the filter if there is one. After a filter change the rows are rebuilt first, so setListSelection finds the item in the DOM.
        if (filterChanged) renderList();
        // Phone: the same state, shown as the full-screen detail rather than expanded in place: see _openMobileItemDetail. The list underneath keeps its filter and its rows, so closing is a switch back and not a rebuild.
        if (isMobile) {
            listSelectedId = sel;
            _enterMobileItemDetail(sel, !isInitialLoad);
            _updateCancelButton();
            _scheduleTagCloudUpdate(true);
            return;
        }
        if (listSelectedId !== sel) {
            const animateNav = !isInitialLoad && !cameFromOtherMode;
            requestAnimationFrame(() => {
                // Hash-induced: centre it. A jump the reader did not make with their own scroll has no context to preserve, so the row is put where it can be read rather than pushed to the top band the way a click leaves it.
                setListSelection(sel, true, animateNav, false, false, animateNav ? 'center' : 'auto');
                if (isInitialLoad || cameFromOtherMode) {
                    requestAnimationFrame(() => requestAnimationFrame(() => _pinInitialListSelection(sel, 1200)));
                }
            });
        } else {
            const el = _getListItemEl(sel);
            if (el) _scrollListEl(el, 'ensure-top10');
            _updateDocTitle();
        }
        _updateCancelButton();
        _scheduleTagCloudUpdate(true);
        return;
    }

    // The map with a search and no item: the search view.
    if (_addr.q && !_addr.i) {
        const q = _addr.q;
        _clearTagFilterState();
        listSelectedId = null;

        searchInput.value = q;
        document.body.classList.toggle('search-has-query', !!q);
        searchBox.classList.add('open');
        document.body.classList.add('search-open');

        if (viewMode === 'list') document.body.classList.remove('list-view');

        if (q.length >= 2) {
            if (viewMode !== 'search' || searchQuery !== q) {
                // Returning from a monad via history: carry the pre-monad camera into the search view, mirroring the reset-button path, or the subset is re-framed from scratch. A matching query also un-stales a snapshot parked by monad-to-monad jumps.
                let _cam = null;
                if (viewMode === 'monad' && _savedMapCamera
                    && _savedMapCamera.viewMode === 'search'
                    && (_savedMapCamera.searchQuery || '') === q) {
                    _cam = _takeSavedCamera();
                }
                switchToSearchView(q, false, _cam);
            }
        } else if (viewMode !== 'map') switchToMapView(false);

        _scheduleTagCloudUpdate(true);
        return;
    }

    /* An item open on the map, inside the filter it was opened in. */
    if (_addr.i) {
        const sel = _addr.i;
        const target = sel ? items.find(i => i.id === sel) : null;
        _setPanelFilterFromAddress(_addr);
        listSelectedId = null;
        if (viewMode === 'list') document.body.classList.remove('list-view');
        if (target) {
            if (viewMode !== 'monad' || selectedMonadId !== sel) {
                switchToMonadView(sel, false, !isInitialLoad);
                if (isInitialLoad) {
                    update();
                    requestAnimationFrame(() => requestAnimationFrame(() =>
                        _monadReconcileLayout(sel)));
                }
            }
            _scheduleTagCloudUpdate(true);
            _updateCancelButton();
            _updateDocTitle();
            return;
        }
        /* No selection, or one that no longer resolves: the filtered map itself, which is a state this writes. Only a dead id is corrected, and then only by dropping it. */
        if (_isPanelView() || viewMode === 'monad' || viewMode === 'search') switchToMapView(false);
        if (sel) _setHashForCurrentState(false);
        if (activeTag) {
            const __t = activeTag;
            _fitVisibleBounds(function(it) { return it.tags && it.tags.includes(__t); }, !isInitialLoad);
        } else {
            update();
        }
        _scheduleTagCloudUpdate(true);
        _updateCancelButton();
        _updateDocTitle();
        return;
    }

    // Otherwise: a tag on the map.
    const tag = _addr.t;
    _clearSearchState();
    if (!_tagExists(tag)) {
        // Invalid tag in hash: reset to full collection
        activeTag = '';
        _syncTagToSearchBox();
        _applyTagFilterToMap();
        if (_isPanelView() || viewMode === 'search' || viewMode === 'monad') {
            switchToMapView(false);
        }
        update();
        history.replaceState(null, '', window.location.pathname + window.location.search);
        return;
    }
    const oldTag = activeTag;
    activeTag = tag;
    _syncTagToSearchBox();

    // History landed on exactly the tag filter the pre-monad snapshot belongs to, so un-stale it and let switchToMapView restore the zoom/pan.
    if (_savedMapCamera && _savedMapCamera.stale
        && (_savedMapCamera.activeTag || '') === tag) {
        delete _savedMapCamera.stale;
    }

    // Ensure tag fade transitions are not suppressed (Safari can have body.notransition set briefly).
    document.body.classList.remove('notransition');
    _cancel('render.notransitionClass');
    isInteracting = false;

    if (viewMode === 'list') {
        document.body.classList.remove('list-view');
        switchToMapView(false);
    } else if (viewMode === 'search' || viewMode === 'monad' || viewMode === 'grid') {
        // Let switchToMapView() apply the new tag filter after monad/search cleanup so
        // items do not briefly flicker in the old state during history-driven transitions.
        switchToMapView(false);
    } else {
        _runStagedTagTransition(oldTag, activeTag);

        _scheduleTagCloudUpdate(true);
        _updateCancelButton();
        _updateDocTitle();
        return;
    }

    // Non-map view modes: fit visible bounds immediately after switchToMapView.
    if (viewMode === 'map' && activeTag) {
        const __t = activeTag;
        _fitVisibleBounds(function(it) { return it.tags && it.tags.includes(__t); }, !isInitialLoad);
    } else if (viewMode === 'map') {
        update();
    }

    _updateDocTitle();
    _scheduleTagCloudUpdate(true);
}

/* ══ SEARCH INDEX & SCORING ══════════════════════════════════════════════════ */

// Porter stemmer: reduces English words to a root form so "visualizing", "visualization" and "visualize" all match.
const porterStem = (() => {
    const step2list = {
        ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance',
        izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent', eli: 'e',
        ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate',
        alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous',
        aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log'
    };
    const step3list = {
        icate: 'ic', ative: '', alize: 'al', iciti: 'ic',
        ical: 'ic', ful: '', ness: ''
    };
    const c  = '[^aeiou]';
    const v  = '[aeiouy]';
    const C  = c + '[^aeiouy]*';
    const V  = v + '[aeiou]*';
    const mgr0 = new RegExp('^(' + C + ')?' + V + C);
    const meq1 = new RegExp('^(' + C + ')?' + V + C + '(' + V + ')?$');
    const mgr1 = new RegExp('^(' + C + ')?' + V + C + V + C);
    const s_v  = new RegExp('^(' + C + ')?' + v);

    return function stem(w) {
        if (w.length < 3) return w;

        let stem, suffix, re, re2, re3, re4;
        const firstch = w.charAt(0);
        if (firstch === 'y') w = firstch.toUpperCase() + w.slice(1);

        // Step 1a
        re = /^(.+?)(ss|i)es$/;
        re2 = /^(.+?)([^s])s$/;
        if (re.test(w)) w = w.replace(re, '$1$2');
        else if (re2.test(w)) w = w.replace(re2, '$1$2');

        // Step 1b
        re = /^(.+?)eed$/;
        re2 = /^(.+?)(ed|ing)$/;
        if (re.test(w)) {
            const fp = re.exec(w);
            if (mgr0.test(fp[1])) w = w.slice(0, -1);
        } else if (re2.test(w)) {
            const fp = re2.exec(w);
            stem = fp[1];
            if (s_v.test(stem)) {
                w = stem;
                re2 = /(at|bl|iz)$/;
                re3 = /([^aeiouylsz])\1$/;
                re4 = new RegExp('^' + C + v + '[^aeiouwxy]$');
                if (re2.test(w)) w += 'e';
                else if (re3.test(w)) w = w.slice(0, -1);
                else if (re4.test(w)) w += 'e';
            }
        }

        // Step 1c
        re = /^(.+?)y$/;
        if (re.test(w)) {
            const fp = re.exec(w);
            stem = fp[1];
            if (s_v.test(stem)) w = stem + 'i';
        }

        // Step 2
        re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
        if (re.test(w)) {
            const fp = re.exec(w);
            stem = fp[1]; suffix = fp[2];
            if (mgr0.test(stem)) w = stem + step2list[suffix];
        }

        // Step 3
        re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
        if (re.test(w)) {
            const fp = re.exec(w);
            stem = fp[1]; suffix = fp[2];
            if (mgr0.test(stem)) w = stem + step3list[suffix];
        }

        // Step 4
        re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
        re2 = /^(.+?)(s|t)(ion)$/;
        if (re.test(w)) {
            const fp = re.exec(w);
            stem = fp[1];
            if (mgr1.test(stem)) w = stem;
        } else if (re2.test(w)) {
            const fp = re2.exec(w);
            stem = fp[1] + fp[2];
            if (mgr1.test(stem)) w = stem;
        }

        // Step 5
        re = /^(.+?)e$/;
        if (re.test(w)) {
            const fp = re.exec(w);
            stem = fp[1];
            re2 = new RegExp('^' + C + v + '[^aeiouwxy]$');
            if (mgr1.test(stem) || (meq1.test(stem) && !re2.test(stem))) w = stem;
        }
        re = /ll$/;
        if (re.test(w) && mgr1.test(w)) w = w.slice(0, -1);

        if (firstch === 'y') w = firstch.toLowerCase() + w.slice(1);
        return w;
    };
})();

// ── Tokenizer shared by indexing and querying ───────────────────────
function tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/** Stem tokens for search. */
function stemTokens(tokens) {
    return tokens.map(porterStem);
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSearchTerms(query) {
    const terms = [];
    const re = /(["'])(.*?)\1|[^\s]+/g;
    let match;

    while ((match = re.exec(query)) !== null) {
        if (match[2] !== undefined) {
            const phrase = match[2].trim().toLowerCase();
            if (phrase) terms.push({ type: 'phrase', value: phrase });
        } else {
            const token = match[0].trim();
            if (!token) continue;
            for (const part of tokenize(token)) {
                if (!part) continue;
                terms.push({ type: 'token', value: part, stem: porterStem(part) });
            }
        }
    }

    return terms;
}

// Search scoring: case-insensitive across authors, source, title, subtitle, tags, text, url and precomputed stems. Every term has to match; a matching item scores 1.
function computeSearchScores(query) {
    const scores = {};

    if (!query) {
        for (const item of items) scores[item.id] = 0;
        return scores;
    }

    const terms = parseSearchTerms(query);
    if (!terms.length) {
        for (const item of items) scores[item.id] = 0;
        return scores;
    }

    for (const item of items) {
        const rawFields = [
            // The full title, which already contains the subtitle text: indexing
            // item.subtitle beside it would weight those words twice.
            item.title,
            item.authors,
            item.source,
            item.tags.join(' '),
            item.text,
            (item.url || '').replace(/\/\/www\./g, '//')
        ];
        const haystack = rawFields.join(' ').toLowerCase();
        const stemHaystack = item.stems || '';

        let matchesAllTerms = true;

        for (const term of terms) {
            let found = false;

            if (term.type === 'phrase') {
                found = haystack.indexOf(term.value) !== -1;
            } else {
                // 1. Whole-word match on raw or stemmed text
                const rawRe = new RegExp('(?<![a-z0-9])' + escapeRegex(term.value) + '(?![a-z0-9])', '');
                const stemRe = new RegExp('(?<![a-z0-9])' + escapeRegex(term.stem) + '(?![a-z0-9])', '');
                // 2. Prefix match: term starts a word (covers partial typing)
                const prefixRe = new RegExp('(?<![a-z0-9])' + escapeRegex(term.value), '');
                const stemPrefixRe = new RegExp('(?<![a-z0-9])' + escapeRegex(term.stem), '');
                found = rawRe.test(haystack) || stemRe.test(stemHaystack)
                    || prefixRe.test(haystack) || stemPrefixRe.test(stemHaystack);
            }

            if (!found) {
                matchesAllTerms = false;
                break;
            }
        }

        scores[item.id] = matchesAllTerms ? 1 : 0;
    }

    return scores;
}

// The first separator PRESENT in this list splits a title from its subtitle, in list order rather than by
// position: a colon wins over a dash even when the dash comes first.
const TITLE_SEPARATORS = [
    { sep: ': ', include: false },
    { sep: ' - ', include: false },
    { sep: '? ', include: true },
    { sep: '! ', include: true },
];

/** Split a full title into the part to display and the subtitle under it. */
function splitTitle(full) {
    const line = String(full || '').trim();
    for (const { sep, include } of TITLE_SEPARATORS) {
        const idx = line.indexOf(sep);
        if (idx === -1) continue;
        return {
            shorttitle: line.slice(0, idx + (include ? 1 : 0)),
            subtitle: line.slice(idx + sep.length),
        };
    }
    return { shorttitle: line, subtitle: '' };
}

// Adopt items.json. prepare.js writes the fields this file reads, so nothing is parsed here: what remains is
// defaulting (an absent field must not become undefined halfway through a render), the two derivations the
// interface needs but the file has no reason to carry (textLines, stems), and the link closure.
function hydrate(data) {
    // Tolerate a bare array or a { items: [...] } wrapper.
    const raw = Array.isArray(data)
        ? data
        : (data && Array.isArray(data.items) ? data.items : []);

    const items = raw
        .filter(src => src && typeof src === 'object' && src.id && src.id !== 'cite-key')
        .map((src, index) => {
            const full = src.title || '';
            // Where a title breaks into a display title and a subtitle is a matter of
            // FORMATTING, not of what the record says, so items.json carries the full
            // string and the split happens here. `title` stays the whole thing: it is
            // what alt text, the document title and the search index want, and
            // `shorttitle` is what gets drawn, with `subtitle` under it.
            const { shorttitle, subtitle } = splitTitle(full);
            const item = {
                id: String(src.id),
                url: (typeof src.url === 'string') ? src.url : '',
                title: full,
                shorttitle,
                subtitle,
                authors: src.authors || '',
                source: src.source || '',
                // Always a string starting with the 4-digit year; the interface
                // slices it rather than parsing it.
                date: src.date ? String(src.date) : '',
                // The day the entry joined the collection, ISO (YYYY-MM-DD), which is what orders the list and the
                // grid inside a year. Same fixed shape for every record, so it compares as a string.
                added: src.added ? String(src.added) : '',
                text: src.text || '',
                tags: Array.isArray(src.tags) ? src.tags.slice() : [],
                links: [],
                // The small tier rides along on the item; _ingestItemImages reads it.
                image: (src.image && src.image.src) ? src.image : null,
                // Map position, precomputed by prepare.js.
                umap_x: +src.umap_x,
                umap_y: +src.umap_y,
                // Curated one-directional related keys, closed both ways below.
                _relatedKeys: Array.isArray(src.links) ? src.links.slice() : [],
                // Position in the file: the collection's own order, and the last tiebreak when two entries were
                // added on the same day (see _compareItemsByYearAndSource).
                _parseIndex: index
            };
            // Sorted here rather than trusted from the file, so display order does
            // not depend on which build wrote it.
            item.tags.sort((a, b) => a.localeCompare(b));
            // Blank lines survive as empty entries, which the renderer relies on.
            item.textLines = item.text.split('\n');
            return item;
        });

    // Resolve bidirectional links against a local lookup: the global `items` array isn't assigned yet, so _getTagItemById() would return an empty map.
    const itemById = Object.create(null);
    for (const it of items) {
        if (it && it.id) itemById[it.id] = it;
    }
    for (const item of items) {
        for (const key of item._relatedKeys) {
            if (itemById[key] && !item.links.includes(key)) {
                item.links.push(key);
            }
            if (itemById[key] && !itemById[key].links.includes(item.id)) {
                itemById[key].links.push(item.id);
            }
        }
        delete item._relatedKeys;
    }

    // Links are now resolved: invalidate netvis cache so it rebuilds on first draw.
    _netInvalidateLinkCache();

    // Pre-compute stemmed tokens for search
    for (const item of items) {
        const fields = [item.title, item.authors, item.tags.join(' '), item.source, item.text];
        item.stems = stemTokens(tokenize(fields.join(' '))).join(' ');
    }

    return items;
}

function _monadYearNum(item) {
    if (!item || !item.date) return NaN;
    const y = parseInt(String(item.date).slice(0, 4), 10);
    return Number.isFinite(y) ? y : NaN;
}

function _compareItemsByYearAndSource(a, b) {
    const ay = _monadYearNum(a);
    const by = _monadYearNum(b);

    if (Number.isFinite(ay) && Number.isFinite(by) && ay !== by) {
        return by - ay; // newer years first
    }
    if (Number.isFinite(ay) !== Number.isFinite(by)) {
        return Number.isFinite(by) - Number.isFinite(ay);
    }

    /* Within a year, most recently added first, matching the years' own newest-first order: a reader returning to
       the list meets what has arrived since they last looked at the top of its year. ISO dates of one fixed shape,
       so a string compare is a date compare. An entry with no date sorts after the dated ones rather than jumping
       to the top, and two added on the same day fall through to the file's own order. */
    const aa = (a && a.added) || '';
    const ba = (b && b.added) || '';
    if (aa !== ba) {
        if (!aa || !ba) return aa ? -1 : 1;
        return ba < aa ? -1 : 1;
    }

    const ai = Number.isFinite(a && a._parseIndex) ? a._parseIndex : 0;
    const bi = Number.isFinite(b && b._parseIndex) ? b._parseIndex : 0;
    if (ai !== bi) return ai - bi;

    return (a.id || '').localeCompare(b.id || '');
}

const imageMeta = {};

// Two tiers: 's' is the thumbnail inlined in items.json, capped by max side; 'l' is the image file,
// whose pixel size items.json carries as image.w / image.h.
const IMG_TIER_MAX = { s: 128 };

/** Helper: img url. One image per item, directly in images/. */
function _imgUrl(id) {
    return `images/${id}.webp`;
}

/** Helper: infer img id. */
function _inferImgId(img) {
    if (!img) return '';
    if (img.dataset && img.dataset.id) return img.dataset.id;
    const src = (img.currentSrc || img.src || '');
    const m = src.match(/\/([^\/\?#]+)\.webp(?:[\?#].*)?$/);
    return m ? m[1] : '';
}

/** Helper: dims for max. */
function _dimsForMax(nw, nh, maxSide) {
    nw = Math.max(1, nw || 1);
    nh = Math.max(1, nh || 1);
    if (nw >= nh) {
        return { w: maxSide, h: Math.max(1, Math.round(maxSide * (nh / nw))) };
    }
    return { w: Math.max(1, Math.round(maxSide * (nw / nh))), h: maxSide };
}

/** An item's image dimensions, set once at load from items.json: the image file's own pixel size (nw/nh, the same as lw/lh) and the inline thumbnail's size at its side cap (sw/sh). */
function _setImageMeta(id, w, h) {
    const s = _dimsForMax(w, h, IMG_TIER_MAX.s);
    imageMeta[id] = { nw: w, nh: h, sw: s.w, sh: s.h, lw: w, lh: h };
    return imageMeta[id];
}


// Preload upgraded tiers (helps avoid iOS Safari layout jumps during src swaps)
const __imgPreload = new Map();
/** Preload image to avoid visible image swaps. */
function _preloadImage(url) {
    if (!url) return Promise.resolve();
    if (__imgPreload.has(url)) return __imgPreload.get(url);
    const p = new Promise((resolve, reject) => {
        const im = new Image();
        im.decoding = 'async';
        im.onload = () => resolve(true);
        im.onerror = () => reject(new Error('preload failed'));
        im.src = url;
        // decode() can resolve after onload; use it when available for a steadier swap. Its rejection is left to
        // onerror/onload: a failed load rejects decode() too, and resolving on that hid the failure.
        if (im.decode) {
            im.decode().then(() => resolve(true)).catch(() => {});
        }
    });
    __imgPreload.set(url, p);
    // Failures are deliberately NOT cached. A rejected promise left under this key made every later attempt at the
    // same URL resolve instantly to the original failure, so a single transient network error permanently defeated
    // the priming for that image, and on desktop nothing ever evicted it.
    p.catch(() => { if (__imgPreload.get(url) === p) __imgPreload.delete(url); });

    // Mobile Safari: keep the preload cache bounded to avoid memory growth over time.
    if (isMobile && __imgPreload.size > 35) {
        while (__imgPreload.size > 30) {
            const k = __imgPreload.keys().next().value;
            if (!k) break;
            __imgPreload.delete(k);
        }
    }
    return p;
}
/** True when an item has no image file at all: no image property in items.json (see _applyImageBundle). */
function _hasNoImage(id) {
    if (!id) return false;
    return !_imgBundle[id];
}

/** Preload tier to avoid visible image swaps. */
function _preloadTier(id, tier) {
    if (_hasNoImage(id)) return Promise.resolve();
    return _preloadImage(_imgUrl(id));
}

// Keep a stable intrinsic ratio across tier swaps by setting width/height and aspect-ratio to the requested tier's dimensions, so translateY(-100%) never resolves against a 0-height box on iOS Safari.
function _applyImgIntrinsic(img, id, tier) {
    if (!img) return;
    id = id || _inferImgId(img);
    if (!id) return;

    const meta = imageMeta[id];
    if (!meta) return;
    const w = (tier === 'l') ? meta.lw : meta.sw;
    const h = (tier === 'l') ? meta.lh : meta.sh;

    if (w && h) {
        img.style.aspectRatio = `${w} / ${h}`;
        img.setAttribute('width', w);
        img.setAttribute('height', h);
        if (img.dataset) { img.dataset.nw = String(w); img.dataset.nh = String(h); }
    }
}


/** Helper: tier rank. */
function _tierRank(t) { return (t === 'l') ? 1 : 0; }
/** Helper: is src tier. */
function _isSrcTier(img, tier) {
    if (!img) return false;
    const src = (img.currentSrc || img.getAttribute('src') || img.src) || '';
    if (!src) return false;
    // Only ever asked about the large tier (setImgTier answers 's' before it gets here). The tiers have no path to
    // match on — the small one is inlined in items.json and the large one is the single file in images/ — so they
    // are told apart by how they arrive: inline is small, a request is large.
    return src.indexOf('data:') !== 0;
}
/** Set img src. */
function _setImgSrc(img, url) {
    // Skip a redundant assignment to the same URL: re-running resource selection can make Chromium drop and re-decode the bitmap even when the value is unchanged, and the per-frame passes reach here with correct URLs.
    try {
        if (img.getAttribute('src') === url && !img.getAttribute('srcset')) return;
    } catch (e) { /* fall through and set */ }
    try {
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
    } catch (e) { /* noop */ }
    img.src = url;
    // The stub colour is left in place under a real bitmap: it is set for good when the image element is created (see the article factory and _listItemHtml).
}

/** The item's actual small image, inline from items.json, or the stub when it has no image. Used wherever a real small image is wanted unconditionally: list rows and the markup builder. */
function _smallSrcFor(id) {
    const b = _imgBundle[id];
    return b ? b.src : _STUB_SRC;
}

function _resolveSmallSrc(id, opts) {
    const forceReal = !!(opts && opts.forceReal);
    const b = _imgBundle[id];
    // No image property means no image exists. There is nothing to reveal and
    // nothing to request: the average-colour stub is the final state.
    if (!b || !forceReal) return _STUB_SRC;
    // The small tier is inline, so revealing costs a decode and no round trip.
    return b.src;
}

/** Assign the resolved small-tier src. When it is a stub data URL the existing img.onload won't fire (it ignores
 *  data: URIs), so .loaded is added here and the article fades in; the img may not be attached to its article yet
 *  during initial creation, hence the next-frame fallback. netvis also requires `loaded` for edge endpoints. */
function _setSmallSrc(img, id, opts) {
    // List-thumbs always get the real small image, even in stub mode: list view
    // shows at most a screenful, so there is nothing to defer.
    if (img && img.classList && img.classList.contains('list-thumb')) {
        _setImgSrc(img, _smallSrcFor(id));
        return;
    }
    const url = _resolveSmallSrc(id, opts);
    const isStub = url === _STUB_SRC;
    // Record the intent, so _sweepImageHealth can tell a DELIBERATE stub (off-viewport, or
    // zoomed out past the reveal) from a reveal that was asked for and never landed. Keyed
    // on the resolved URL rather than on opts.forceReal.
    try {
        if (isStub) delete img.dataset._wantReal;
        else img.dataset._wantReal = '1';
    } catch (e) { /* noop */ }
    // Bump a per-img token so an in-flight reveal decode is abandoned if a
    // newer _setSmallSrc call (e.g. a re-stub) supersedes it before it resolves.
    const token = (img._smallSrcToken || 0) + 1;
    img._smallSrcToken = token;
    // Stubs bypass the img.onload 'loaded' path: ensure it here. Idempotent.
    const applyClass = () => {
        if (!isStub) return;
        const a = img.closest && img.closest('article');
        if (a && !a.classList.contains('loaded')) a.classList.add('loaded');
    };
    // Present the new bitmap atomically: map imgs decode off-thread, so a plain src change lets Chromium paint an
    // empty frame mid-decode, and a whole set swapping at once reads as flicker. decoding='sync' holds the old frame
    // until the new one is ready, then swaps in one paint; restored afterwards so ordinary lazy loads stay off the
    // main thread.
    const present = () => {
        if (!img.isConnected || img._smallSrcToken !== token) return;
        // The stub bitmap is a transparent pixel: its colour is the element's
        // background, written here so it lands in the same paint as the src.
        if (isStub) img.style.backgroundColor = _stubFillForId(id);
        try { img.decoding = 'sync'; } catch (e) { /* noop */ }
        _setImgSrc(img, url);
        const restoreDecoding = () => { try { img.decoding = 'auto'; } catch (e) { /* noop */ } };
        try {
            if (img.decode) img.decode().then(restoreDecoding, restoreDecoding);
            else requestAnimationFrame(restoreDecoding);
        } catch (e) { restoreDecoding(); }
        if (img.isConnected) applyClass();
        requestAnimationFrame(applyClass);
    };
    if (!isStub) {
        // Inline small tier: the bytes are already here, so priming an off-screen
        // Image would just decode them a second time. Straight to the swap.
        if (url.indexOf('data:') === 0) { present(); return; }
        // Real reveal over the network: prime the encoded cache off-screen first so
        // the sync decode is CPU-only (not a network stall), then present atomically.
        try {
            _preloadImage(url).then(present).catch(present);
        } catch (e) {
            present();
        }
        return;
    }
    present();
}

/* ══ IMAGE TIERS & STUBS (CONTINUED) ═══════════════════════════════════════ */

// Strict tier policy: 's' for map/list, 'l' for a selection, the monad centre and its linked items, and the lightbox. The higher tier is preloaded and decoded before the src swap so Safari doesn't blink mid-transform.
function setImgTier(img, tier) {
    if (!img) return;
    const id = _inferImgId(img);
    if (!id) return;

    // On a phone the map shows only stub colours and the inline thumbnails: the image file is for the open detail alone.
    if (tier === 'l' && isMobile && !(viewMode === 'monad' && img.closest('article.monad-center'))) tier = 's';

    // An item with no image has no tier above 's' to request. COERCE rather than return: ensureImgTier compares ranks and would keep asking on every sweep, whereas coercing lands each repeat in the idempotent 's' branch below at no cost.
    if (tier !== 's' && _hasNoImage(id)) tier = 's';

    // Mobile: skip the real load for STRUCTURALLY hidden articles (monad-low, monad-stagger-hide, search-hidden),
    // whose view-mode logic re-runs setImgTier on transitions.
    const _hiddenArticle = (tier === 's' && isMobile && !img.classList.contains('list-thumb')) ? img.closest('article') : null;
    if (_hiddenArticle && _isSuppressedHidden(_hiddenArticle)) {
        if (img.dataset) img.dataset.tier = 's';
        img.loading = 'lazy';
        img.fetchPriority = 'low';
        // No placeholder bitmap, just remove src: the element still takes its layout from --w / --nat-*, and the decoded bitmap is released with no new decode work.
        if (img.getAttribute('src')) {
            try {
                img.removeAttribute('srcset');
                img.removeAttribute('sizes');
                img.removeAttribute('src');
            } catch (e) { /* noop */ }
        }
        return;
    }

    const prev = (img.dataset && img.dataset.tier) ? img.dataset.tier : '';
    if (img.dataset) img.dataset.tier = tier;

    // If we are already at the desired tier (or have a pending request), keep it idempotent.
    if (prev === tier) {
        // Ensure the base tier is actually applied to src (important for downgrades).
        if (tier === 's') {
            _applyImgIntrinsic(img, id, 's');
            const curSrc = img.currentSrc || img.getAttribute('src') || '';
            // Leave an existing src alone: the stub/real choice for tier 's' belongs to the stub paths, and re-stubbing here
            // would let every purgeHighResImages() undo a reveal that just happened.
            // Empty-src recovery: the suppress branch also sets dataset.tier = 's', so a later setImgTier(img,'s') lands in
            // this idempotent branch with curSrc empty and would return without restoring anything.
            if (!curSrc) {
                _setSmallSrc(img, id);
            }
            // Return here: falling through reaches the new-tier-'s' branch, which re-stubs the image and causes the post-monad real to stub to real flash.
            return;
        } else {
            _applyImgIntrinsic(img, id, tier);
        }
        if (img._tierPendingTier === tier) return;
        if (_isSrcTier(img, tier)) return;
    }

    // New request → bump token and cancel any older completion.
    img._tierToken = (img._tierToken || 0) + 1;
    const token = img._tierToken;
    img._tierPendingTier = '';

    // Prioritize the currently requested tier.
    if (tier === 's') {
        img.loading = 'lazy';
        img.fetchPriority = 'low';
    } else {
        img.loading = 'eager';
        img.fetchPriority = 'high';
    }

    if (tier === 's') {
        _applyImgIntrinsic(img, id, 's');
        // On a downgrade from 'l', keep the real small image while the item is in the reveal regime, or the monad
        // centre's deferred downgrade re-stubs it over a map that should show real pixels.
        if (prev === 'l'
            && (_stubLastBelow === true || viewMode === 'monad')) {
            _setSmallSrc(img, id, { forceReal: true });
        } else {
            _setSmallSrc(img, id);
        }
        return;
    }

    // Pre-apply intrinsic dims for the requested tier so layout stays stable while the new bitmap loads.
    _applyImgIntrinsic(img, id, tier);

    const targetUrl = _imgUrl(id);
    if (_isSrcTier(img, tier)) {
        _setImgSrc(img, targetUrl);
        return;
    }

    img._tierPendingTier = tier;
    _preloadTier(id, tier).then(() => {
        if (!img.isConnected) return;
        if (img._tierToken !== token) return;
        if (img.dataset && img.dataset.tier !== tier) return;
        img._tierPendingTier = '';
        _setImgSrc(img, targetUrl);
    }).catch(() => {
        if (!img.isConnected) return;
        if (img._tierToken !== token) return;
        if (img.dataset && img.dataset.tier !== tier) return;
        img._tierPendingTier = '';
        // Even on preload failure, attempt the swap: the browser may still load it.
        _setImgSrc(img, targetUrl);
    });
}

/** Ensure img tier is available and consistent. */
function ensureImgTier(img, minTier) {
    if (!img) return;
    if (_tierRank(_imgTier(img)) >= _tierRank(minTier)) return;
    setImgTier(img, minTier);
}


/** Purge high res images to reduce memory/paint cost. */
function purgeHighResImages() {
    // Keep decoded image memory low (Mobile Safari stability): map and search all at 's', monad only the centre at 'l', list only the selected row at 'l'.
    if (lightboxOpen) return;

    try {
        // MAIN (map/monad/search)
        const mainImgs = document.querySelectorAll('main article img');
        for (const img of mainImgs) {
            const art = img.closest && img.closest('article');
            const id = art && art.id ? art.id.replace(/^i_/, '') : _inferImgId(img);
            if (viewMode === 'monad' && id && selectedMonadId && id === selectedMonadId) {
                // Monad center: use the large tier immediately (avoids iOS Safari jump during click-zoom).
                setImgTier(img, 'l');
            } else {
                setImgTier(img, 's');
            }
        }

        // LIST
        for (const img of listView.querySelectorAll('img.list-thumb')) {
            const itemEl = img.closest && img.closest('.list-item');
            const id = itemEl ? itemEl.getAttribute('data-id') : null;
            if (viewMode === 'list' && id && listSelectedId && id === listSelectedId) {
                ensureImgTier(img, 'l');
            } else {
                setImgTier(img, 's');
            }
        }
    } catch (err) { /* noop */ }
}

// Monad centre tiering: the centre image goes to the large tier as soon as it is the centre.
function updateMonadCenterTiering() {
    // Keep the monad center image at the large tier immediately (no zoom-threshold upgrades),
    // so iOS Safari doesn't jump when zooming in.
    if (viewMode !== 'monad' || !selectedMonadId) return;
    const ca = _articleById(selectedMonadId);
    const ci = ca ? ca.querySelector('img') : null;
    if (ci) setImgTier(ci, 'l');
}


// Stub colours, no-image verdicts and dimensions all arrive in items.json and are applied by _applyImageBundle
// before the first render, so nothing is derived from pixels.


// The map shows each item's stub colour until STUB_REVEAL_ZOOM, on hover, or a tier upgrade to 'l' brings in a real image.
// Images reveal before titles, so zooming in reads as a two-step reveal and the head start covers image load latency.

// Per-item average RGB, seeded from items.json by _applyImageBundle. An item with no entry has no image, and _stubFillForId serves --midgray; no colour is ever fabricated.
const _stubColor = Object.create(null);
/* ══ SMALL TIER (inline in items.json) ═════════════════════════════════════
   The entire small tier travels with the data: every item that has an image
   carries an image object: w, h, the average colour its stub is painted in,
   and the small webp itself as a data: URI.
   An item with no image has NO image property: absence is the signal, so
   nothing needs a placeholder file and no request is ever spent on one.
   This removes the per-thumbnail requests, the separate manifest request, and
   the boot probe that fetched and canvas-sampled every small image to learn
   dimensions, the placeholder verdict and the colour. m and l stay file-based:
   they are fetched one at a time for a selection or the lightbox. Written by
   prepare.js. */
const _imgBundle = Object.create(null);
// Side length seeded for an item with no image, so it lays out as a square. Only the 1:1 ratio matters.
const _NO_IMAGE_DIM = 1000;

/** Fill the bundle from the image property each item carries. An item with no image has no entry, and that absence is the whole no-image signal. */
function _ingestItemImages(list) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const it of list) {
        const im = it && it.image;
        if (!im || !im.src) continue;
        // Channels are read with a finite test rather than `|| 128`, so a
        // dominant colour with a zero channel keeps its zero instead of
        // silently becoming mid-grey.
        const ch = (v) => (Number.isFinite(+v) ? +v : 128);
        _imgBundle[it.id] = {
            nw: (+im.w) || 0,
            nh: (+im.h) || 0,
            rgb: [ch(im.r), ch(im.g), ch(im.b)],
            src: im.src,
        };
        n++;
    }
    return n;
}

/** Seed each item's dimensions, no-image verdict and stub colour from items.json, where prepare.js computed them from the source image. */
function _applyImageBundle(list) {
    if (!Array.isArray(list)) return 0;
    let seeded = 0;
    for (const it of list) {
        const b = _imgBundle[it.id];
        if (!b) {
            it._isPlaceholderImg = true;
            // Seed SQUARE dimensions, or the article falls back to the CSS defaults (--w 16vmin, 4:3). Any square gives the same --w, since the formula normalises by area.
            _setImageMeta(it.id, _NO_IMAGE_DIM, _NO_IMAGE_DIM);
            continue;
        }
        if (b.nw > 0 && b.nh > 0) _setImageMeta(it.id, b.nw, b.nh);
        _stubColor[it.id] = b.rgb.slice();
        seeded++;
    }
    return seeded;
}

// Currently-hovered article (so viewport rebuilds don't re-stub it).
let _stubHoveredArticle = null;

// Every stub is this one transparent 1x1 PNG over the element's background-color. Per-colour solid PNGs meant
// ~350 distinct data URIs and as many decodes to say what one background declaration says.
const _STUB_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAAAAAAABQABZHiVOAAAAABJRU5ErkJggg==';

/** An article's width in vmin for an image of nw × nh: every image gets the same area (500 × 500 px worth), so a
 *  wide one is wide and a tall one narrow, scaled by 0.08. */
function _articleWVmin(nw, nh) {
    return nw * Math.sqrt(250000 / (nw * nh)) * 0.08;
}

/** Apply article sizing vars (--w, --nat-w, --nat-h) and img intrinsic dims from known natural dimensions, mirroring the real img.onload formula so stub-rendered articles lay out identically. Idempotent: skips if --w is already set. */
function _applyArticleSizingFromDims(article, img, nw, nh) {
    if (!article || !nw || !nh) return;
    // Already sized? Skip.
    if (img && img.dataset && img.dataset._wDone) return;
    const meta = imageMeta[_inferImgId(img) || article.id.slice(2)];
    const natW = (meta && meta.nw) || nw;
    const natH = (meta && meta.nh) || nh;
    article.style.setProperty('--w', _articleWVmin(nw, nh) + 'vmin');
    article.style.setProperty('--nat-w', natW);
    article.style.setProperty('--nat-h', natH);
    // Same late-dimension reconcile as the img.onload path (see there).
    /* Any item in the current monad, not just the centre and the linked ones: a merely similar item on the ring
       derives its lift from these dimensions too, and gating on the linked set meant its late load never asked for
       the correction. */
    if (viewMode === 'monad' && selectedMonadId) {
        _onFrame('monad.lateDims', () => _monadReconcileLayout(selectedMonadId));
    }
    if (img) {
        img.style.aspectRatio = nw + ' / ' + nh;
        img.setAttribute('width', nw);
        img.setAttribute('height', nh);
        if (img.dataset) {
            img.dataset.nw = String(nw);
            img.dataset.nh = String(nh);
            img.dataset._wDone = '1';
        }
    }
}

/* ══ IMAGE TIERS & STUBS (CONTINUED) ═══════════════════════════════════════ */

/** Apply article sizing from a loaded image's natural dimensions. Cheap and idempotent, so every load handler can call it. */
function _applySizingFromLoadedImg(img, id) {
    if (!img || !id || !img.naturalWidth || !img.naturalHeight) return;
    const article = _articleById(id);
    if (!article) return;
    _applyArticleSizingFromDims(article, _articleImg(article), img.naturalWidth | 0, img.naturalHeight | 0);
}

/** Set article translate via custom properties: faster than rebuilding style.transform each frame, since only the
 *  registered <length> --tx/--ty change. The values are cached as article._tx/_ty so FLIP readback paths avoid
 *  string parsing. */
function _setArticleTranslate(article, x, y, offscreen) {
    if (!article) return;
    // Sub-pixel writes still trigger Safari's full invalidation chain per article, and pan input differs only in the
    // fractional part between frames: 310 property writes for sub-pixel changes.
    let rx, ry;
    if (offscreen) {
        rx = Math.round(x / 8) * 8;
        ry = Math.round(y / 8) * 8;
    } else {
        rx = Math.round(x);
        ry = Math.round(y);
    }
    if (article._tx !== rx) {
        article._tx = rx;
        article.style.setProperty('--art-tx', rx + 'px');
    }
    if (article._ty !== ry) {
        article._ty = ry;
        article.style.setProperty('--art-ty', ry + 'px');
    }
    // Restore the var()-based transform if it was cleared by some
    // transition path. Cheap idempotent check via a marker flag.
    if (!article._txInitialized) {
        article.style.transform = 'translate(var(--art-tx, 0px), var(--art-ty, 0px)) translateY(-100%)';
        article._txInitialized = true;
    }
}

/* ══ ITEM DOM FACTORY ══════════════════════════════════════════════════════ */

/** Get or create article. */
function getOrCreateArticle(item) {
    if (item._article) return item._article;

    let article = _articleById(item.id);

    if (!article) {
        const main = document.querySelector('main');
        article = document.createElement('article');
        article.id = 'i_' + item.id;

        // Set the transform once in var() form so later updates change only --tx/--ty (registered <length> properties) and the expression isn't reparsed each frame. A notable Safari pan/zoom win.
        article.style.transform = 'translate(var(--art-tx, 0px), var(--art-ty, 0px)) translateY(-100%)';
        article._tx = 0;
        article._ty = 0;
        article._txInitialized = true;

        const img = document.createElement('img');
        img.dataset.id = item.id;
        // The item's stub colour sits under the bitmap for the element's whole life, not only while the stub is showing, so any gap before a real bitmap paints (a lazy fetch, or a decode when a filter or a monad change brings an image back) shows the colour instead of nothing.
        if (!item._isPlaceholderImg) img.style.backgroundColor = _stubFillForId(item.id);
        // 'auto', not 'async': async decoding lets Chromium paint an empty frame while decoding a re-presented bitmap, which is the Chromium-only flicker during tag filter transitions. Stub/real swaps additionally force a sync decode (see _setSmallSrc).
        img.decoding = 'auto';
        // Default tier 's', with low fetch priority and lazy loading so the initial render doesn't choke the network on offscreen images; setImgTier upgrades on selection or lightbox.
        img.loading = 'lazy';
        img.fetchPriority = 'low';
        img.draggable = false;
        img.alt = item.title;
        // Default intrinsic ratio to prevent 0-height during first load / candidate swaps (notably iOS Safari)
        img.width = 4;
        img.height = 3;
        img.style.aspectRatio = '4 / 3';
        img.onload = function() {
            // Ignore the 1x1 stub, which would corrupt intrinsic dimensions and the
            // loaded class. Tested against _STUB_SRC, not the data: prefix: the small
            // tier is inlined from items.json, so it is a data: URI with REAL dimensions
            // and must run through everything below.
            const cur = this.currentSrc || this.src || '';
            if (cur === _STUB_SRC) return;

            const nw = this.naturalWidth || 0;
            const nh = this.naturalHeight || 0;
            if (!nw || !nh) return;

            // Keep intrinsic ratio in sync with the *actual loaded file* (prevents distortion).
            this.style.aspectRatio = nw + ' / ' + nh;
            this.setAttribute('width', nw);
            this.setAttribute('height', nh);
            if (this.dataset) {
                this.dataset.nw = String(nw);
                this.dataset.nh = String(nh);
            }

            const _meta = imageMeta[item.id] || { nw, nh };

            // Precompute width in vmin so CSS needs no calc. vmin tracks min(vw, vh), exactly what the layout square is
            // bounded by, so image size and item spacing scale together: in rem they diverged, because the root font formula
            // is width-weighted for legibility and images outgrew the layout on wide windows.
            if (!(this.dataset && this.dataset._wDone)) {
                article.style.setProperty('--w', _articleWVmin(nw, nh) + 'vmin');
                if (this.dataset) this.dataset._wDone = '1';
            }

            // Store "native" large-tier dimensions on the article (used by lightbox + icon geometry).
            article.style.setProperty('--nat-w', _meta.nw || nw);
            article.style.setProperty('--nat-h', _meta.nh || nh);
            imageMeta[item.id] = _meta;

            article.classList.add('loaded');

            // Late natural dimensions change the predicted centre-image height that the monad centring and the ring's inner
            // clearance derive from, so re-derive if this image is in the current monad. No-op when the pre-detected meta
            // already matched.
            if (viewMode === 'monad' && selectedMonadId) {
                _onFrame('monad.lateDims', () => _monadReconcileLayout(selectedMonadId));
            }

            // A newly visible image may now be a valid edge endpoint, so ask netvis to redraw (cheap: coalesced into one rAF, early-exits when suspended). Also invalidate the image-centre offset cache, since the box just gained real dimensions.
            _netRequestDraw(0);
            _netBumpOffsetEpoch();

            // Detect solid-color placeholder images (e.g., gray squares) and mark as non-expandable.
            _detectAndMarkPlaceholder(this, article);

            // Re-run update for the monad centre once real dimensions are in: they change the image box's aspect, and with it the title's place.
            if (viewMode === 'monad' && article.classList.contains('monad-center')) {
                if (_zoomAnimating) {
                    _monadGeomAfterZoom = item.id;
                } else {
                    // Update h2/h3 geometry now that intrinsic image dimensions are known.
                    _measureMonadTextGeometry(article);
                    update();
                }
            }

            // A real bitmap is now on screen, so the reveal intent may not survive it: a reveal that was superseded, re-stubbed and later retried can arrive with _wantReal still set. Cleared here, where the load is a fact rather than an intention.
            // (Stub loads returned at the top.)
            delete this.dataset._wantReal;

            // Mark that we've successfully loaded at least once.
            if (this.dataset) {
                this.dataset._loadedOnce = '1';
                // Clear failure markers on success, so a transient error followed by a good load resets the retry budget for any future failure.
                if (this.dataset._loadFailed) delete this.dataset._loadFailed;
                if (this.dataset._failedSrc) delete this.dataset._failedSrc;
                if (this.dataset._retryCount) delete this.dataset._retryCount;
            }
        };
        img.onerror = function() {
            // Mark the img for recovery by the next sweep, recording the attempted src so a permanently 404'd resource can't loop. The sweep clears _failedSrc on a legitimate src change, so a tier upgrade isn't mistaken for a retry.
            this.dataset._loadFailed = '1';
            const _failedSrc = this.currentSrc || this.getAttribute('src') || '';
            if (_failedSrc) this.dataset._failedSrc = _failedSrc;
            // Debounce the health sweep so a burst of failures coalesces into one recovery pass; the sweep is a no-op when there's nothing to recover.
            _scheduleImageHealthSweep();
        };

        // Propagate the boot-time placeholder probe to the article class up front, both for layout (size and circle styling) and so the suppressed-src path doesn't briefly try to load anything.
        if (item._isPlaceholderImg) {
            article.classList.add('placeholder-img');
        }

        // Pre-set --w from imageMeta (populated by _applyImageBundle from items.json) so articles don't fall back to the CSS default 16vmin before src loads. Mirrors the formula in img.onload.
        const _meta = imageMeta[item.id];
        if (_meta && _meta.nw > 0 && _meta.nh > 0) {
            article.style.setProperty('--w', _articleWVmin(_meta.nw, _meta.nh) + 'vmin');
            article.style.setProperty('--nat-w', _meta.nw);
            article.style.setProperty('--nat-h', _meta.nh);
            // Width/height as HTML attributes give stable intrinsic dimensions before src loads, and help iOS Safari hit-testing when src is empty under the suppress path.
            img.setAttribute('width', _meta.nw);
            img.setAttribute('height', _meta.nh);
            img.style.aspectRatio = _meta.nw + ' / ' + _meta.nh;
        }

        article.appendChild(img);

        const title = document.createElement('h2');
        // The item's one url hangs off its title. The anchor is always in the DOM but inert outside the monad centre (see .title-link): on the map a click on a title selects the item, and a live link there would navigate away instead.
        _fillTitle(title, item, item.shorttitle);
        article.appendChild(title);

        // Marker for the deep-zoom CSS: articles with a subtitle offset their stack by --map-sub-h. A class avoids :has(), and it lives here rather than on the h3, which comes and goes with the zoom.
        if (item.subtitle) article.classList.add('has-sub');

        // The subtitle, authors/source and .detail-fields are built in _ensureLabelStack; tags, abstract and see-also in _ensureDetailContent.

        // Apply current tag filter immediately (important on initial load / list→map switches).
        const __t = (activeTag || '').trim();
        if (__t && !(item.tags && item.tags.includes(__t))) {
            article.classList.add('tag-filtered-out');
        }

        main.appendChild(article);

        // Deliberately AFTER the appends: _setSmallSrc's stub path assigns synchronously and both its isConnected guard
        // and the .loaded helper need the img inside the connected article.
        setImgTier(img, 's');
    }

    item._article = article;
    return article;
}

/** A title or subtitle's text, inside the link to the item's url when it has one (inert outside the open item, see .title-link). */
function _fillTitle(el, item, text) {
    if (!item.url) { el.textContent = text; return; }
    const a = document.createElement('a');
    a.className = 'title-link';
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    el.appendChild(a);
}

/** The map label stack: subtitle, plus the .detail-fields box holding authors and source. */
function _ensureLabelStack(item) {
    if (!item) return;
    const article = item._article || _articleById(item.id);
    if (!article) return;
    // The flag lives on the ITEM and the stack in the ARTICLE, and the two can part company: an article rebuilt while the map was not on screen comes back with only its image and title, while the flag still says the stack is there.
    if (item._labelStackBuilt && article.querySelector('.detail-fields')) return;
    item._labelStackBuilt = true;

    const frag = document.createDocumentFragment();

    // Subtitle as h3, positioned below h2 in monad view
    if (item.subtitle) {
        const sub = document.createElement('h3');
        // The subtitle carries the item's url too, so the whole heading is one target rather than a live line above a dead one. Inert outside the open item, exactly as the title's anchor is: see .title-link.
        _fillTitle(sub, item, item.subtitle);
        frag.appendChild(sub);
    }

    // Detail fields container: shown progressively as zoom increases in monad
    // Order: authors → source · year → tags → text → link
    const detailFields = document.createElement('div');
    detailFields.className = 'detail-fields';

    // Authors (without year now)
    if (item.authors) {
        const authors = document.createElement('p');
        authors.className = 'authors';
        authors.textContent = item.authors;
        detailFields.appendChild(authors);
    }

    // Source, year combined
    if (item.source || item.date) {
        const source = document.createElement('p');
        source.className = 'source';
        const parts = [];
        if (item.source) parts.push(item.source);
        if (item.date) parts.push(item.date.slice(0, 4));
        source.textContent = parts.join(', ');
        detailFields.appendChild(source);
    }

    frag.appendChild(detailFields);
    // h2 is absolutely positioned, as are these, so appending after it is
    // equivalent to the original source order.
    article.appendChild(frag);

    // Mid-transition the rungs are already open, so a freshly created element would arrive at final opacity with no
    // transition to run: a pop where there used to be a fade. Give it a clean start value (same trick as
    // _openListExtra).
    if (_viewTransitionActive()) {
        const h3El = article.querySelector('h3');
        if (h3El) _armLabelStackFade(h3El);
        _armLabelStackFade(detailFields.querySelector('.authors'));
        _armLabelStackFade(detailFields.querySelector('.source'));
    }
}

/* One frame at opacity 0, then hand the element back to the cascade so its own 0.33s transition runs from there. Batched, so several items built in one frame clear together. */
const _labelStackFadeIn = [];
function _armLabelStackFade(el) {
    if (!el) return;
    el.style.opacity = '0';
    _labelStackFadeIn.push(el);
    if (_pending('render.labelStackFade')) return;
    _onFrame('render.labelStackFade', () => {
        for (let i = 0; i < _labelStackFadeIn.length; i++) {
            _labelStackFadeIn[i].style.removeProperty('opacity');
        }
        _labelStackFadeIn.length = 0;
    });
}

/** Drop an item's label stack. Refuses while the item still holds monad detail
 *  content: .detail-fields is that content's parent. */
function _releaseLabelStack(item) {
    if (!item || !item._labelStackBuilt || item._detailBuilt) return;
    const article = item._article || _articleById(item.id);
    if (article) {
        const kids = Array.prototype.slice.call(article.children);
        for (let i = 0; i < kids.length; i++) {
            const k = kids[i];
            if (k.tagName === 'H3' || k.classList.contains('detail-fields')) k.remove();
        }
    }
    item._labelStackBuilt = false;
}

/* Release pass, deliberately not inline in updateMapView: during an animated zoom-out the JS `zoom` reaches its
   target on the first frame while CSS is still interpolating through the rungs, so removing on that reading
   would snap the labels off mid-fade. */
function _sweepLabelStacks() {
    if (_viewTransitionActive() || _zoomAnimating) {
        _after('render.labelStackSweep', _sweepLabelStacks, 200);
        return;
    }
    if (viewMode !== 'map' && viewMode !== 'search') return;
    const wantStack = zoom > LABEL_STACK_ZOOM;
    for (let i = 0, len = items.length; i < len; i++) {
        const it = items[i];
        if (!it || !it._labelStackBuilt) continue;
        // _labelsCulled is the desktop/search cull; mobile only tracks
        // _mapOffscreen. Either means "nothing to show here".
        if (!wantStack || it._labelsCulled || it._mapOffscreen) _releaseLabelStack(it);
    }
}

/** Monad-only detail content: tags, abstract, external links, see-also. Every rule that displays these is scoped
 *  to article.monad-center, so building them for all ~390 items up front put about two thirds of the item DOM on
 *  the page to serve one item at a time. */
function _ensureDetailContent(item) {
    if (!item) return;
// The article may not exist yet: a cold load straight into a detail runs this before the map's DOM is built, so
    // the centre is created here rather than looked up.
    const article = getOrCreateArticle(item);
    if (!article) return;
    // The stack comes and goes with the map zoom, and .detail-fields is where
    // this content lands: a selection from the overview finds none.
    _ensureLabelStack(item);
    const detailFields = article.querySelector('.detail-fields');
    if (!detailFields) return;
    // Marked on the .detail-fields node as well as on the item, for the reason given in _ensureLabelStack: the flag survives a rebuilt article, the marker doesn't, and it is the marker that says whether this content is actually on the page.
    if (item._detailBuilt && detailFields.dataset.built === '1') return;
    detailFields.dataset.built = '1';
    item._detailBuilt = true;

    // One insertion rather than four. Nothing here has layout yet: the map scope hides every .detail-fields child that isn't .authors/.source, so the nodes land inert until body.monad-view arrives.
    const frag = document.createDocumentFragment();

    // Tags before text, as flat <a> children: the old <li> wrapper carried only the inter-tag margin, which now sits on the anchor. Matches how the list view builds .list-tags.
    if (item.tags.length > 0) {
        const tags = document.createElement('div');
        tags.className = 'tags';
        // Loop over tags.
        for (const tag of item.tags) {
            const a = document.createElement('a');
            a.href = _formatAddress({ t: tag });
            a.textContent = tag;
            tags.appendChild(a);
        }
        frag.appendChild(tags);
    }

    // Text
    if (item.text) {
        const text = document.createElement('p');
        text.className = 'text';
        text.innerHTML = _paragraphsHtml(item.textLines);
        // Desktop expand-on-click: once _measureMonadTextOverflow marks the text as overflowing, clicking toggles
        // clamped and expanded with animated transitions, and CSS swaps the cursor between s-resize and n-resize.
        if (!isMobile) {
            text.addEventListener('click', function(e) {
                // Only act at full zoom: the resize-cursor affordance is itself gated on monad-zoomed-in in CSS, so at intermediate zooms there's no cursor and there should be no action.
                if (!document.body.classList.contains('monad-zoomed-in')) return;
                // What the click does (expand, close, or simply bring the card in front of the ring) is the shared toggle's decision, not this handler's.
                // A click that ends a text selection is a selection, not an expand.
                if (_endsTextSelection()) return;
                _toggleMonadDetails(article);
                e.stopPropagation();
            });
        }
        frag.appendChild(text);
    }


    // Linked items (internal)
    if (item.links && item.links.length) {
        const itemById = _getTagItemById();
        const uniq = [...new Set(item.links)]
            .map(x => (x || '').toString().trim())
            .filter(id => id && id !== item.id && itemById && itemById[id]);
        if (uniq.length) {
            const see = document.createElement('div');
            see.className = 'seealso';
            for (let i = 0; i < uniq.length; i++) {
                const id = uniq[i];
                const a = document.createElement('a');
                a.className = 'seealso-link';
                a.href = _formatAddress({ i: id });
                a.textContent = (itemById[id] && itemById[id].shorttitle) ? itemById[id].shorttitle : id;
                see.appendChild(a);
            }
            frag.appendChild(see);
        }
    }

    detailFields.appendChild(frag);
    _noteDetailBuilt(item.id);
}

/* Recency window over built detail content. Small but non-zero: a monad is often left and re-entered (linked
   swaps, browser back), where a rebuild would land mid-transition. */
const _DETAIL_KEEP = 5;
const _detailBuiltIds = [];

function _noteDetailBuilt(id) {
    const at = _detailBuiltIds.indexOf(id);
    if (at >= 0) _detailBuiltIds.splice(at, 1);
    _detailBuiltIds.push(id);
    while (_detailBuiltIds.length > _DETAIL_KEEP && _detailBuiltIds[0] !== selectedMonadId) {
        _releaseDetailContent(_detailBuiltIds.shift());
    }
}

/** Drop an item's detail fields back to the map shell. */
function _releaseDetailContent(id) {
    const item = id ? _getTagItemById()[id] : null;
    if (!item || !item._detailBuilt) return;
    const article = item._article || _articleById(id);
    const detailFields = article ? article.querySelector('.detail-fields') : null;
    if (detailFields) {
        // The abstract may carry a collapse failsafe; detaching the element would leave that timer firing against a node nobody can see.
        const textEl = detailFields.querySelector('.text');
        if (textEl && textEl._collapseFailsafeTimer) {
            clearTimeout(textEl._collapseFailsafeTimer);
            textEl._collapseFailsafeTimer = null;
        }
        // Direct children only, and by class rather than a selector, so this
        // can never reach into .authors/.source (which map view needs).
        const kids = Array.prototype.slice.call(detailFields.children);
        for (let i = 0; i < kids.length; i++) {
            const cls = kids[i].classList;
            if (cls.contains('tags') || cls.contains('text') || cls.contains('seealso')) {
                kids[i].remove();
            }
        }
        delete detailFields.dataset.built;
    }
    item._detailBuilt = false;
}
const _infoOverlayRef = document.getElementById('info-overlay');

/* The monad-centre text clamp in lines, kept manually in sync with the --text-fit-max pair in the CSS (lines x 1.3em, and the slope is that over 0.65). */
const _MONAD_TEXT_VISIBLE_LINES_CLAMPED = 8;
const _MONAD_TEXT_VISIBLE_LINES_NOIMG = 15;
/* How far past the clamp a description may run and still be shown whole. Hiding one or two lines behind a fade
   and a click is a poor bargain for the reader: the cue promises more than it delivers, and the click gives back
   less than the interruption cost. */
const _MONAD_TEXT_CLAMP_SLACK_LINES = 2;

/** How many lines this item's description shows before it clamps. An item with no image gets more of them: see the placeholder rule in the CSS, which this mirrors. */
function _monadClampLines(el) {
    const art = (el && el.closest) ? el.closest('article') : null;
    return (art && art.classList.contains('placeholder-img'))
        ? _MONAD_TEXT_VISIBLE_LINES_NOIMG
        : _MONAD_TEXT_VISIBLE_LINES_CLAMPED;
}

/** What sits over a view is closed before it changes: a running zoom animation, the lightbox and the info panel. */
function _closeOverlaysForViewChange() {
    _cancel('zoom.animation');
    if (lightboxOpen) closeLightbox(true);
    if (_infoOverlayRef.classList.contains('visible')) hideInfo(false);
}


/* ── Panel scrolling (list and grid) ───────────────────────────────────────────────────────── */
const listView = document.getElementById('list-view');

/* ── Body-scroll proxy ──────────────────────────────────────────────────────
   In list AND grid view the <body> is the scroll container, not #list-view or #grid-view. Monkey-patch the
   scroll-related properties on the element so the existing call sites route to document.scrollingElement /
   window transparently. */
const _bodyScrollHtml = document.documentElement;
/* iOS moves position: fixed with the document's rubber band, so the corner controls ride down with a pull-to-refresh and off the bottom of the screen. */
let _overscrollY = 0;
let _overscrollRAF = 0;
/** Measure the overshoot and write it if it changed. Returns the current value. Only the list and the grid scroll
 *  the document, and only on a touch screen does it bounce, so anywhere else the value is 0. */
function _measureOverscroll() {
    const el = document.scrollingElement;
    let over = 0;
    if (el && isMobile && _isPanelView()) {
        const y = window.scrollY || el.scrollTop || 0;
        // The furthest the page scrolls without bouncing is set by the visual viewport, which Safari's toolbars resize;
        // the document's clientHeight does not follow them, and bounded by it an ordinary scroll to the bottom read as a bounce.
        const max = Math.max(0, el.scrollHeight - window.innerHeight);
        // Negative at the top, positive past the bottom, 0 in between, which is every ordinary frame, so the common case writes nothing.
        over = y < 0 ? y : (y > max ? y - max : 0);
    }
    if (over === _overscrollY) return over;
    _overscrollY = over;
    document.documentElement.style.setProperty('--overscroll-y', over + 'px');
    return over;
}
/* The bounce and the spring back from it are composited, and scroll events do not arrive on every frame of either: least of all at the end of a fast pull, where the document travels a long way over a few frames in near silence. */
const _OVERSCROLL_SETTLE_FRAMES = 3;
function _trackOverscroll() {
    if (_measureOverscroll() === 0 || _overscrollRAF) return;
    let settled = 0;
    const tick = () => {
        settled = (_measureOverscroll() === 0) ? settled + 1 : 0;
        if (settled >= _OVERSCROLL_SETTLE_FRAMES) { _overscrollRAF = 0; return; }
        _overscrollRAF = requestAnimationFrame(tick);
    };
    _overscrollRAF = requestAnimationFrame(tick);
}
window.addEventListener('scroll', _trackOverscroll, { passive: true });

/** Hand scrolling to the document, overriding the <html> styles directly: CSS-only overrides of the base `html { position: fixed; overflow: hidden; height: 100% }` are fragile across browsers. */
function _applyBodyScroller() {
    _bodyScrollHtml.style.position = 'static';
    _bodyScrollHtml.style.overflowX = 'clip';
    _bodyScrollHtml.style.overflowY = 'auto';
    _bodyScrollHtml.style.overscrollBehaviorX = 'none';
    /* The document's own overscroll stays on, so the pull-to-refresh gesture still works. iOS drags position: fixed along with the bounce, which took the switcher and the shuffle button off screen; the controls are pinned back by hand instead: see _trackOverscroll. */
    _bodyScrollHtml.style.overscrollBehaviorY = 'auto';
    _bodyScrollHtml.style.height = 'auto';
    _bodyScrollHtml.style.width = '100%';
    _bodyScrollHtml.style.maxWidth = '100vw';
}
/** Take it back. */
function _clearBodyScroller() {
    _bodyScrollHtml.style.position = '';
    _bodyScrollHtml.style.overflowX = '';
    _bodyScrollHtml.style.overflowY = '';
    _bodyScrollHtml.style.overscrollBehaviorX = '';
    _bodyScrollHtml.style.overscrollBehaviorY = '';
    _bodyScrollHtml.style.height = '';
    _bodyScrollHtml.style.width = '';
    _bodyScrollHtml.style.maxWidth = '';
}

/** Hold the grid where it is while it fades out. The document's scroll is about to be reset to 0 and the grid
 *  flipped back to a fixed overlay, which together would snap it to its first row in full view. */
function _pinGridForExit() {
    const sy = (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
    if (sy <= 0) return;
    if (_bodyScrollHtml.style.getPropertyValue('--xfade-scroll-y')) return;
    _bodyScrollHtml.style.setProperty('--xfade-scroll-y', sy + 'px');
    document.body.classList.add('grid-exiting');
    setTimeout(() => {
        document.body.classList.remove('grid-exiting');
        _bodyScrollHtml.style.removeProperty('--xfade-scroll-y');
    }, GRID_FADE_MS + 40);
}

/** Route one view's scroll API to the document while its body class is on. */
function _installBodyScrollProxy(el, viewClass) {
    if (!el) return;
    const isScroller = () => document.body.classList.contains(viewClass);

    /* scrollTop */
    const _origScrollTopGet = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop').get;
    const _origScrollTopSet = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop').set;
    Object.defineProperty(el, 'scrollTop', {
        get() { return isScroller() ? document.scrollingElement.scrollTop : _origScrollTopGet.call(this); },
        set(v) {
            if (isScroller()) {
                document.scrollingElement.scrollTop = v;
                // A scroll written from code (the anchor loops write theirs in rAF) moves the rows after this frame's
                // curves were drawn; redraw them now so they don't trail by a frame.
                if (el === listView) tagVis.drawLinksNow();
            } else _origScrollTopSet.call(this, v);
        },
        configurable: true
    });

    /* clientHeight */
    const _origClientH = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight').get;
    Object.defineProperty(el, 'clientHeight', {
        get() { return isScroller() ? window.innerHeight : _origClientH.call(this); },
        configurable: true
    });

    /* scrollTo */
    const _origScrollTo = el.scrollTo.bind(el);
    el.scrollTo = function() { (isScroller() ? window : { scrollTo: _origScrollTo }).scrollTo(...arguments); };

    /* getBoundingClientRect: return viewport rect when body scrolls */
    const _origBCR = el.getBoundingClientRect.bind(el);
    el.getBoundingClientRect = function() {
        if (isScroller()) return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
        return _origBCR();
    };

    // Both views' switch functions call this on the element directly, for a synchronous handoff the observer below can't give them.
    el._applyBodyScroller = _applyBodyScroller;
    el._clearBodyScroller = _clearBodyScroller;
}

(function _installBodyScrollProxies() {
    _installBodyScrollProxy(listView, 'list-view');
    // By id: the gridView const is declared in grid.js, which loads after this file. Same element either way, so the patched properties are the ones that const will see.
    _installBodyScrollProxy(document.getElementById('grid-view'), 'grid-view');

    const _inBodyScrollView = () => document.body.classList.contains('list-view')
        || document.body.classList.contains('grid-view');
    let _wasBodyScroll = _inBodyScrollView();
    let _wasGrid = document.body.classList.contains('grid-view');
    // Apply immediately if a hash already put us in one of them at init time.
    if (_wasBodyScroll) _applyBodyScroller();

    /* MutationObserver as safety net: catches classList changes we
       don't control directly (e.g. hash-based init). */
    new MutationObserver(() => {
        const now = _inBodyScrollView();
        const wasGrid = _wasGrid;
        _wasGrid = document.body.classList.contains('grid-view');
        if (now === _wasBodyScroll) return;
        _wasBodyScroll = now;
        if (now) {
            _applyBodyScroller();
        } else {
            // Before the reset below, which is what would otherwise move it.
            if (wasGrid) _pinGridForExit();
            _clearBodyScroller();
            document.scrollingElement.scrollTop = 0;
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();

/* The window title, composed from state rather than written wherever the state changes. */
const DOC_TITLE_SEP = ' · ';

function _docTitleView() {
    if (viewMode === 'grid') return 'Grid';
    if (viewMode === 'list') return 'List';
    // The monad is the map's detail and search is the map filtered, so both read as Map.
    return 'Map';
}

/** The page title for the list or grid: the filter (the query, or #tag) and the selected item's title, whichever are present ("Data in Dialogue: #tag - Title", ": query - Title", ": Title", ": #tag") or the plain title. */
function _composeDocTitle() {
    /* Behind the welcome card the reader has not arrived at a view yet, so the tab carries the page's own name,
       whole, rather than naming a map they are not looking at. _hideWelcome writes the real title on its way out. */
    if (typeof _welcomeOpen === 'function' && _welcomeOpen()) return originalTitle;
    const selId = (viewMode === 'list') ? listSelectedId
        : (viewMode === 'grid') ? gridSelectedId
        : selectedMonadId;
    const it = selId ? _getTagItemById()[selId] : null;
    const q = (searchQuery || '').trim();
    const t = (activeTag || '').trim();
    const parts = [];
    // The panel is the narrowest thing on screen while it is open, so it reads first, and the view behind it is still named, because it is still what the reader returns to.
    if (document.body.classList.contains('info-open')) parts.push('About');
    if (q.length >= 2) parts.push(q);
    else if (t) parts.push('#' + t);
    /* shorttitle, which is what the interface sets in bold everywhere an item is named: the map label, the list row,
       the grid card, the detail heading. `title` is the whole citation with its subtitle attached (see splitTitle),
       long enough that the rest of the tab's text would be cut off before it. */
    if (it && (it.shorttitle || it.title)) parts.push(it.shorttitle || it.title);
    parts.push(titleBase);
    parts.push(_docTitleView());
    return parts.join(DOC_TITLE_SEP);
}

/** Re-read the state and write the title. Composing from scratch means there is no ordering to get wrong beyond calling it after a change rather than before. */
function _updateDocTitle() {
    document.title = _composeDocTitle();
}

/* Where the list and the grid were scrolled to when the detail took over. */
const _panelScrollY = { list: 0, grid: 0 };

// ── View switcher (map | grid | list) ─────────────────────────────────────────

/** Close the list's or the grid's selection when none of it is on screen. */
function _dropSelectionOutOfView() {
    if (viewMode === 'grid' && gridSelectedId) {
        if (!_gridVisibleIds().includes(gridSelectedId)) {
            _gridSelect(null, { animate: false, updateHash: false, scroll: false });
        }
        return;
    }
    if (viewMode === 'list' && listSelectedId && listView) {
        const row = listView.querySelector('.list-item[data-id="' + CSS.escape(listSelectedId) + '"]');
        const r = row ? row.getBoundingClientRect() : null;
        if (!r || r.bottom <= 0 || r.top >= window.innerHeight) {
            setListSelection(listSelectedId, false, false, false, false);
            listSelectedId = null;
        }
    }
}

/** The switcher segment for the current view: monad and search belong to the map. */
function _currentViewSeg() {
    return (viewMode === 'list' || viewMode === 'grid') ? viewMode : 'map';
}

/** Every change of view goes through here: the switcher shows it, and the bounce correction, which only the list
 *  and the grid use, is cleared rather than left offsetting the corner buttons in the next view. */
function _setViewMode(mode) {
    viewMode = mode;
    _syncViewSwitcher();
    _measureOverscroll();
}

// Selected-item image bridge, used only when switching between a selected list row and its monad view: a cloned <img> morphs from source rect to target rect while both surfaces cross-fade. Other transitions need no bridge.

let _modeBridgeInFlight = false;

/** Find the visible image rect for item id in the current viewMode, or null. */
function _imageRectFor(id) {
    if (!id) return null;
    if (viewMode === 'list') {
        const img = listView ? listView.querySelector('img.list-thumb[data-id="' + CSS.escape(id) + '"]') : null;
        if (!img) return null;
        const r = img.getBoundingClientRect();
        if (!(r && r.width > 0 && r.height > 0)) return null;
        return { rect: r, src: img.currentSrc || img.src };
    }
    // main-side (monad / map / search)
    const article = _articleById(id);
    const img = article ? article.querySelector('img') : null;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    if (!(r && r.width > 0 && r.height > 0)) return null;
    return { rect: r, src: img.currentSrc || img.src };
}

/* ══ VIEW TRANSITIONS & MODE SWITCHING (CONTINUED) ═════════════════════════ */

/** Settle the monad centre before a bridge reads its rect: force layout, re-measure the title against the image,
 *  update, and force layout again so the rect read next is the settled one. */
function _settleMonadCentre() {
    if (viewMode !== 'monad' || !_selectedMonadItem) return;
    const a = getOrCreateArticle(_selectedMonadItem);
    if (!a) return;
    void a.offsetHeight;
    _measureMonadTextGeometry(a);
    update();
    void a.offsetHeight;
}

/** Bridge a selected-item transition between list and monad: `id` is the item that morphs across, `doSwitch` performs the view-mode change synchronously. */
function _modeBridgeSelected(id, doSwitch) {
    const bridge = document.getElementById('mode-bridge');
    if (!bridge || !id) { doSwitch(); return; }
    if (_modeBridgeInFlight) { _stubBridgeCancel(); doSwitch(); return; }
    // Mobile: skip the morph bridge entirely. View transitions snap.
    if (isMobile) { doSwitch(); return; }

    const STAGE_MS = 375;
    const MOVE_MS = UI_TRANS_MS;   // clone travel = the app's normal 750ms move
    const BRIDGE_DUR_MS = 2 * STAGE_MS + MOVE_MS;

    // 1. Capture source rect.
    const source = _imageRectFor(id);

    // 2) Run the switch synchronously with the real images hidden, so the clone is the only visible imagery during the morph. The mode-xfade direction class gives the surfaces a STAGE_MS fade out, then a STAGE_MS fade in.
    _modeBridgeInFlight = true;
    const startWasList = (viewMode === 'list');
    const directionClass = startWasList ? 'to-main' : 'to-list';

    // On list-to-main, pin #list-view at its current scroll position: the fixed-overlay pin translates by the
    // snapshotted offset, so doSwitch's body-scroll reset doesn't visually move the content.
    if (startWasList) {
        const sy = (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
        document.documentElement.style.setProperty('--xfade-scroll-y', sy + 'px');
    }

    document.body.classList.add('mode-bridging', 'mode-xfade', 'mode-xfade-staged', directionClass);
    // Flush style recalc so the new transition rules and pinned layout are
    // observed before doSwitch changes opacity-driving classes.
    void document.body.offsetHeight;
    try {
        doSwitch();
    } catch (err) {
        document.body.classList.remove('mode-bridging', 'mode-xfade', 'mode-xfade-staged', 'mode-xfade-out', 'mode-xfade-in', 'to-main', 'to-list');
        document.documentElement.style.removeProperty('--xfade-scroll-y');
        _stubBridgeCancel();
        _modeBridgeInFlight = false;
        throw err;
    }
    // Trigger outgoing fade on the next frame (only list-side; see CSS).
    if (startWasList) {
        requestAnimationFrame(() => {
            document.body.classList.add('mode-xfade-out');
        });
    } else {
        // to-list Safari workaround: a staged rule holds #list-view invisible, because Safari sometimes ignores the
        // staged transition-delay when body.list-view is added in the same frame as mode-xfade-staged.
        setTimeout(() => {
            // Guard: only release if the bridge is still active (e.g.
            // a fast follow-up nav may have torn it down already).
            if (document.body.classList.contains('mode-xfade-staged')) {
                document.body.classList.add('mode-xfade-in');
            }
        }, STAGE_MS + MOVE_MS);
    }

    // 3) Force layout and, entering monad, run the deferred text-geometry measurement synchronously, so the centre article is at its final position before the target rect is measured. Otherwise the clone lands provisionally and the real article snaps ~20px later.
    const mainEl = document.querySelector('main');
    if (mainEl) void mainEl.offsetHeight;
    if (listView) void listView.offsetHeight;
    _settleMonadCentre();

    const cleanup = () => {
        bridge.innerHTML = '';
        _stubBridgeCancel();
        document.body.classList.add('mode-bridge-settling');
        document.body.classList.remove('mode-bridging', 'mode-xfade', 'mode-xfade-staged', 'mode-xfade-out', 'mode-xfade-in', 'to-main', 'to-list');
        document.documentElement.style.removeProperty('--xfade-scroll-y');
        requestAnimationFrame(() => requestAnimationFrame(() => {
            document.body.classList.remove('mode-bridge-settling');
            _modeBridgeInFlight = false;
            // Netvis may have last drawn during the bridge at stale positions, so force a redraw now that the view has settled.
            _netRequestDraw(0);
            _netScheduleFinalDraw();
        }));
    };

    // 4) Capture the target rect; if either end is missing, skip the clone and let the surface cross-fade run alone.
    if (!startWasList) _stubSizeVisibleListThumbs();
    const target = _imageRectFor(id);

    if (!source || !target) {
        setTimeout(cleanup, BRIDGE_DUR_MS + 30);
        return;
    }

    // 5) One clone, animated source to target. Intrinsic size is about max(source, target) so Safari has a texture close to display size and scales without severe blur.
    const intrinsicW = Math.max(32, Math.min(1024, Math.ceil(Math.max(source.rect.width, target.rect.width))));
    const intrinsicH = Math.max(32, Math.min(1024, Math.ceil(Math.max(source.rect.height, target.rect.height))));
    const setRect = (img, rect) => {
        img.style.transform =
            'translate3d(' + rect.left + 'px, ' + rect.top + 'px, 0)' +
            ' scale(' + (rect.width / intrinsicW) + ', ' + (rect.height / intrinsicH) + ')';
    };

    bridge.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'bridge-img';
    // If the bridged item is a placeholder (a solid grey square file), tag the clone so CSS drops the 1px outline, which would otherwise read as a ring against the flat fill.
    const _bridgedItem = items.find(it => it.id === id);
    if (_bridgedItem && _bridgedItem._isPlaceholderImg) {
        img.classList.add('bridge-img-placeholder');
    }
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    img.src = source.src || target.src || '';
    // Carry the stub colour across like the articles do: under a stub (a transparent pixel) it is the whole picture, and under a real image it covers the clone's own decode. Placeholder items already get --midgray from the class above.
    if (!(_bridgedItem && _bridgedItem._isPlaceholderImg)) img.style.backgroundColor = _stubFillForId(id);
    img.style.width = intrinsicW + 'px';
    img.style.height = intrinsicH + 'px';
    setRect(img, source.rect);
    bridge.appendChild(img);

    // 6) Two rAF steps so the browser observes the transition-in-effect state before the transform changes. The transform waits STAGE_MS, so it starts after the source fade-out, and runs MOVE_MS.
    void bridge.offsetHeight;
    requestAnimationFrame(() => {
        img.style.transition = 'transform ' + MOVE_MS + 'ms var(--uiEase, ease-in-out) ' + STAGE_MS + 'ms';
        void bridge.offsetHeight;
        requestAnimationFrame(() => {
            setRect(img, target.rect);
        });
    });

    // 7. Cleanup after the full 3-stage transition completes.
    setTimeout(cleanup, BRIDGE_DUR_MS + 30);
}

// Stub-colour rect bridge for UNSELECTED view switches (list to map/search): every item travels between its two
// positions as a stub-coloured rectangle on the single #stub-bridge canvas.

const _SB_STAGE_MS = 375;      // fade stages; equals the image bridge's STAGE_MS
const _SB_MOVE_MS = 2 * UI_TRANS_MS;   // both travel legs; double the normal
                                       // move: the column moment needs room
const _SB_GATHER_MS = Math.round(_SB_MOVE_MS * 0.4);   // leg 1: source → column
const _SB_DISPERSE_MS = _SB_MOVE_MS - _SB_GATHER_MS;   // leg 2: column → target
const _SB_RESOLVE_CAP_MS = 900;   // max stall absorbed by re-anchoring the legs
const _SB_EDGE_MARGIN = 140;   // "onscreen" tolerance band beyond the viewport
let _stubBridgeActive = false;
let _stubBridgeResolveTargets = null;   // set by _stubBridgeAnimate; fed at t=375
let _stubSwitchPendingMid = null;   // deferred doSwitch: must ALWAYS run
let _stubThumbSizingDeferred = false;   // chunked sizing held until teardown

/* ══ IMAGE TIERS & STUBS (CONTINUED) ═══════════════════════════════════════ */

/** Stop the rect animation, clear the canvas, drop body.stub-bridging.
 *  Safe to call anytime (idempotent). */
function _stubBridgeCancel() {
    _stubBridgeResolveTargets = null;
    _cancel('stub.bridgeFrame');
    const c = document.getElementById('stub-bridge');
    if (c) {
        const ctx = c.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    }
    document.body.classList.remove('stub-bridging');
    _stubBridgeActive = false;
}

/** Canvas fill style for an item's stub color: the sampled average color if
 *  available, otherwise the same neutral --midgray the stub images use. */
function _stubFillForId(id) {
    const byId = _getTagItemById();
    const item = byId && byId[id];
    if (!item || item._isPlaceholderImg) return 'rgb(128,128,128)';
    const rgb = _stubColor[id];
    return rgb ? ('rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')') : 'rgb(128,128,128)';
}

/** Measure per-item image rects in the CURRENT view (viewport coordinates), returning id to {x, y, w, h}. */
function _stubCaptureRects() {
    const out = Object.create(null);

    if (viewMode === 'grid') {
        if (!_gridInner) return out;
        const imgs = _gridInner.querySelectorAll('.grid-card:not(.grid-out) img.grid-thumb');
        for (let i = 0; i < imgs.length; i++) {
            const r = imgs[i].getBoundingClientRect();
            if (r.width > 0.5 && r.height > 0.5) out[imgs[i].getAttribute('data-id')] = { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        return out;
    }

    if (viewMode === 'list') {
        if (!listView) return out;
        const rows = listView.querySelectorAll('.list-item[data-id]');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.classList.contains('list-out')) continue;
            const id = row.getAttribute('data-id');
            if (!id) continue;
            const img = row.querySelector('img.list-thumb');
            const r = img ? img.getBoundingClientRect() : null;
            if (r && r.width > 0.5 && r.height > 0.5) {
                out[id] = { x: r.left, y: r.top, w: r.width, h: r.height };
                continue;
            }
            // Thumb has no box yet (rare: sizes usually come from the markup's width/height attributes): approximate with a square near the thumb column's inner edge.
            const rr = row.getBoundingClientRect();
            if (!(rr.width > 0.5 && rr.height > 0.5)) continue;
            const s = 44;
            out[id] = { x: rr.left + rr.width / 3 - s - 14, y: rr.top + (rr.height - s) / 2, w: s, h: s };
        }
        return out;
    }

    // Main-side (map / search / monad): article image rects.
    for (let i = 0, len = items.length; i < len; i++) {
        const item = items[i];
        const article = item._article || _articleById(item.id);
        if (!article) continue;
        const cl = article.classList;
        if (_isSuppressedHidden(article)) continue;
        const img = article.querySelector('img');
        const r = img ? img.getBoundingClientRect() : null;
        if (r && r.width > 0.5 && r.height > 0.5) {
            out[item.id] = { x: r.left, y: r.top, w: r.width, h: r.height };
            continue;
        }
        // Positional fallback only for viewport-culled articles, whose content boxes are gone via content-visibility;
        // the article anchors its bottom edge at _ty and only the travel direction matters offscreen.
        if (!cl.contains('map-offscreen')) continue;
        if (typeof article._tx === 'number' && typeof article._ty === 'number') {
            const s = 20;
            out[item.id] = { x: article._tx, y: article._ty - s, w: s, h: s };
        }
    }
    return out;
}

/** Synchronously apply aspect-aware thumb sizing to the list rows that will be visible after a to-list switch lands. */
function _stubSizeVisibleListThumbs() {
    if (!listView || viewMode !== 'list') return;
    const rows = listView.querySelectorAll('.list-item[data-id]');
    if (!rows.length) return;

    // Read pass: one reference row yields the shared column width.
    let ref = null;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.classList.contains('list-out') || row.classList.contains('selected')) continue;
        ref = row;
        break;
    }
    if (!ref) return;
    const rect = ref.getBoundingClientRect();
    const cs = getComputedStyle(ref);
    const gap = parseFloat(cs.columnGap) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    let colW = rect.width;
    const refMain = ref.querySelector('.list-main');
    if (refMain) {
        const mr = refMain.getBoundingClientRect();
        colW = Math.max(0, mr.left - rect.left - padL - gap);
    } else {
        colW = Math.max(0, (rect.width - gap) / 3);
    }
    const areaBase = _listThumbArea(false);

    // Write pass: sizes come from the markup's data-nw/nh: no layout reads.
    const maxRows = Math.min(rows.length, Math.ceil(window.innerHeight / 48) + 12);
    let done = 0;
    for (let i = 0; i < rows.length && done < maxRows; i++) {
        const row = rows[i];
        if (row.classList.contains('list-out')) continue;
        done++;
        if (row.classList.contains('selected')) {
            // The selected row uses the open-size routine: rare, full path.
            _applyListThumbSizeOnce(row);
            continue;
        }
        const img = row.querySelector('img.list-thumb');
        if (!img) continue;
        const nw = parseFloat(img.dataset.nw) || 0;
        const nh = parseFloat(img.dataset.nh) || 0;
        if (!(nw > 0 && nh > 0)) continue;
        const area = areaBase * (row.classList.contains('placeholder-img') ? 1 / 15 : 1);
        let scale = Math.sqrt(area / (nw * nh));
        if (colW > 0 && nw * scale > colW) scale = colW / nw;
        img.style.transition = 'none';
        img.style.width = Math.max(1, Math.round(nw * scale)) + 'px';
        img.style.height = Math.max(1, Math.round(nh * scale)) + 'px';
    }
}

/** Animate stub-coloured rects (id to rect) through the mid-transition column keyframe. */
function _stubBridgeAnimate(sources, opts) {
    opts = opts || {};
    const canvas = document.getElementById('stub-bridge');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!ctx) return;
    if (_stubBridgeActive) _stubBridgeCancel();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const M = _SB_EDGE_MARGIN;
    const inView = (r) => {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        return cx > -M && cx < vw + M && cy > -M && cy < vh + M;
    };
    // Clamp endpoint centres into a band just beyond the viewport, so far-offscreen endpoints enter and exit through the edge at sane speeds instead of teleporting in from thousands of px away.
    const clampCX = (v) => Math.max(-M, Math.min(vw + M, v));
    const clampCY = (v) => Math.max(-M, Math.min(vh + M, v));
    // Guard against pathological rects only. Now the cap is twice the viewport's longer side, applied to both sides by the same factor, so a real measurement always passes through at its own size and ratio.
    const sizeCap = 2 * Math.max(vw, vh);
    const clampRectSize = (w, h) => {
        const k = Math.min(1, sizeCap / Math.max(w, h, 1));
        return [Math.max(2, w * k), Math.max(2, h * k)];
    };

    const listSideIsTarget = (opts.listSide === 'target');
    // Direct mode (the grid's switches): each rect travels straight from source to target over one eased leg, with no column keyframe between: a column is the list's own shape and means nothing to a masonry. opts.moveMs sets that leg.
    const direct = !!opts.direct;
    const MOVE_MS = opts.moveMs || _SB_MOVE_MS;

    // ── Sprites from sources; endpoints completed later by the resolver ──
    const sprites = [];
    const byId = Object.create(null);
    for (const id in sources) {
        const src = sources[id];
        const [w0, h0] = clampRectSize(src.w, src.h);
        const srcOn = inView(src);
        // The carried selection (opts.image = { id, el }) is drawn as its own picture, fully opaque; el can be swapped for a sharper copy while the bridge runs.
        const imgRef = (opts.image && opts.image.id === id) ? opts.image : null;
        const _it = _getTagItemById()[id];
        const sp = {
            color: _stubFillForId(id),
            // Items without an image travel as the grey square the views draw them as (see the placeholder rule in the CSS).
            placeholder: !!(_it && _it._isPlaceholderImg),
            imgRef,
            c0x: clampCX(src.x + src.w / 2), c0y: clampCY(src.y + src.h / 2),
            w0, h0,
            c1x: 0, c1y: 0, w1: 0, h1: 0,
            cbx: 0, cby: 0, wb: 0, hb: 0,
            // Raw list-side geometry drives the column: the RIGHT edge is where the item's thumb sits (thumbs share a common right edge), and y gives the order. Refined by the resolver when the list is the target side.
            listR: src.x + src.w,
            listY: src.y + src.h / 2,
            listH: src.h,
            // Prefer the main-side rect for aspect: map and monad images always carry the real ratio, while deep list rows may wear the uniform fallback box. For to-list the source is the main side; for to-main the resolver refines it.
            aspect: src.w / Math.max(1, src.h),
            enter: !srcOn,   // fades in while gathering into the column
            exit: false,     // set by the resolver (offscreen target)
            fadeOnly: false, // set by the resolver (no counterpart)
            hasTarget: false
        };
        byId[id] = sp;
        sprites.push(sp);
    }
    // The picture is drawn last, above the colour rects it passes.
    const _imgAt = sprites.findIndex(sp => sp.imgRef);
    if (_imgAt >= 0) sprites.push(sprites.splice(_imgAt, 1)[0]);

    if (!sprites.length) { _stubBridgeCancel(); return; }

    document.body.classList.add('stub-bridging');
    _stubBridgeActive = true;

    // Curtain colour is the page background, dark-mode aware; the curtain replaces the CSS surface fades.
    let curtainColor = '';
    try {
        curtainColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    } catch (e) { /* noop */ }
    if (!curtainColor) {
        try { curtainColor = getComputedStyle(document.body).backgroundColor; } catch (e) { /* noop */ }
    }
    if (!curtainColor) curtainColor = '#fff';
    // Map stubs and list thumbs both draw a midgray border inside their measured box, so the rects replicate it and the handoffs are pixel-matched, without it 310 borders vanished on the first frame and popped back on the last, which read as a blink.
    let strokeColor = '';
    try {
        strokeColor = getComputedStyle(document.documentElement).getPropertyValue('--midgray').trim();
    } catch (e) { /* noop */ }
    if (!strokeColor) strokeColor = 'hsl(0,0%,50%)';

    let targetsReady = false;
    let legStart = _SB_STAGE_MS;   // re-anchored when targets resolve (below)
    const t0 = performance.now();

    _stubBridgeResolveTargets = (targets) => {
        _stubBridgeResolveTargets = null;
        if (!_stubBridgeActive) return;
        // The deferred doSwitch and measurement can stall Safari for hundreds of ms (renderList of ~310 rows plus fresh
        // layout), so anchor the travel legs to when the targets actually arrived.
        legStart = Math.min(_SB_STAGE_MS + _SB_RESOLVE_CAP_MS,
            Math.max(_SB_STAGE_MS, performance.now() - t0));
        const columnRects = [];
        for (const id in byId) {
            const sp = byId[id];
            const tgt = targets[id];
            if (!tgt) { sp.fadeOnly = true; continue; }   // fades out at its source
            sp.hasTarget = true;
            sp.exit = !inView(tgt);
            sp.c1x = clampCX(tgt.x + tgt.w / 2);
            sp.c1y = clampCY(tgt.y + tgt.h / 2);
            [sp.w1, sp.h1] = clampRectSize(tgt.w, tgt.h);
            if (listSideIsTarget) {
                sp.listR = tgt.x + tgt.w;
                sp.listY = tgt.y + tgt.h / 2;
                sp.listH = tgt.h;
            } else {
                sp.aspect = tgt.w / Math.max(1, tgt.h);
            }
            columnRects.push(sp);
        }

        if (direct) {
            targetsReady = true;
            return Math.max(0, (legStart + MOVE_MS) - (performance.now() - t0));
        }

        // Column keyframe: mid-transition the whole selection lines up as the LIST ITSELF under one uniform zoom.
        columnRects.sort((a, b) => a.listY - b.listY);
        const COL_PAD = 24;
        const colSpan = Math.max(1, vh - 2 * COL_PAD);
        const colN = columnRects.length;
        let colZoom = 1;
        let colTop = 0;
        let colAnchor = COL_PAD;
        if (colN) {
            const first = columnRects[0];
            const last = columnRects[colN - 1];
            colTop = first.listY - first.listH / 2;
            const extent = Math.max(1, (last.listY + last.listH / 2) - colTop);
            if (extent <= colSpan) {
                // Everything fits at full list scale: anchor the column at the rows' own positions so the list-side leg is vertically a no-op, shifting only as far as needed to keep the block inside the padded viewport.
                colZoom = 1;
                colAnchor = colTop;
                if (colTop < COL_PAD) {
                    colAnchor = COL_PAD;
                } else if (colTop + extent > vh - COL_PAD) {
                    colAnchor = Math.max(COL_PAD, vh - COL_PAD - extent);
                }
            } else {
                colZoom = colSpan / extent;
                colAnchor = COL_PAD;
            }
        }
        for (let i = 0; i < colN; i++) {
            const sp = columnRects[i];
            const hb = Math.max(1, sp.listH * colZoom);
            sp.hb = hb;
            sp.wb = Math.max(1, hb * sp.aspect);
            sp.cbx = clampCX(sp.listR - sp.wb / 2);   // right-aligned, as in the list
            sp.cby = colAnchor + (sp.listY - colTop) * colZoom;
        }
        targetsReady = true;
        // Remaining ms until the reveal window opens, so the caller can schedule the list release and teardown in sync with the re-anchored legs.
        return Math.max(0, (legStart + MOVE_MS) - (performance.now() - t0));
    };

    const easeInOut = (p) => (p < 0.5) ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    const easeOut = (p) => 1 - (1 - p) * (1 - p);

    const frame = (now) => {
        const t = now - t0;
        if (!_stubBridgeActive) return;
        const travelEnd = legStart + MOVE_MS;
        if (t >= travelEnd + _SB_STAGE_MS) {
            // Handoff: clear the rects but leave body.stub-bridging and the canvas for _stubSwitchTeardown to lift together with the mode-xfade classes.
            ctx.clearRect(0, 0, vw, vh);
            return;
        }
        ctx.clearRect(0, 0, vw, vh);

        // Curtain: covers the outgoing surface over the first stage, stays opaque through the travel while the surfaces swap beneath it, and lifts over the incoming surface during the reveal.
        let curtainA;
        if (t < _SB_STAGE_MS) {
            curtainA = easeOut(t / _SB_STAGE_MS);
        } else if (t < travelEnd) {
            curtainA = 1;
        } else if (t < travelEnd + _SB_STAGE_MS) {
            curtainA = 1 - easeInOut((t - travelEnd) / _SB_STAGE_MS);
        } else {
            curtainA = 0;
        }
        if (curtainA > 0.002) {
            ctx.globalAlpha = curtainA;
            ctx.fillStyle = curtainColor;
            ctx.fillRect(0, 0, vw, vh);
        }

        // Leg progress: gather from source to column, then disperse from column to target, with the longer share going
        // to the disperse, which carries the richer motion. Legs hold at 0 until the deferred doSwitch has fed the
        // targets.
        const pD = (direct && targetsReady) ? Math.min(1, Math.max(0, (t - legStart) / MOVE_MS)) : 0;
        const t1 = direct ? pD : (targetsReady
            ? Math.min(1, Math.max(0, (t - legStart) / _SB_GATHER_MS)) : 0);
        const t2 = direct ? pD : (targetsReady
            ? Math.min(1, Math.max(0, (t - legStart - _SB_GATHER_MS) / _SB_DISPERSE_MS)) : 0);
        const e1 = easeInOut(t1);
        const e2 = easeInOut(t2);
        try {
        // Rects HOLD at peak while the curtain lifts (a flat colour at falling alpha over the revealed image reads as muddy darkening or a second fade) then vanish in the same frame the curtain reaches zero, like the image bridge's clone removal.

        for (let i = 0; i < sprites.length; i++) {
            const sp = sprites[i];

            // Phase alpha.
            /* Every sprite peaks fully opaque: the final frame hands off to the identical stub beneath it with no
               alpha jump. */
            let alpha;
            if (t >= travelEnd) {
                alpha = (sp.exit || sp.fadeOnly) ? 0 : 1;
            } else if (t < _SB_STAGE_MS) {
                alpha = sp.enter ? 0 : easeOut(t / _SB_STAGE_MS);
            } else {
                alpha = 1;
            }
            // Offscreen-source rects fade in while gathering into the column;
            // offscreen-target rects fade out while dispersing toward the edge.
            if (sp.enter) alpha = Math.min(alpha, Math.min(1, t1 / 0.5));
            if (sp.exit) alpha = Math.min(alpha, _clamp01((1 - t2) / 0.4));
            if (sp.fadeOnly) alpha = Math.min(alpha, 1 - e1);

            let cx, cy, w, h;
            if (sp.fadeOnly || !sp.hasTarget) {
                const k = 1 - 0.3 * e1;   // mild shrink while fading in place
                cx = sp.c0x; cy = sp.c0y;
                w = sp.w0 * k; h = sp.h0 * k;
            } else if (direct) {
                cx = sp.c0x + (sp.c1x - sp.c0x) * e1;
                cy = sp.c0y + (sp.c1y - sp.c0y) * e1;
                w = sp.w0 + (sp.w1 - sp.w0) * e1;
                h = sp.h0 + (sp.h1 - sp.h0) * e1;
            } else if (t2 <= 0) {
                cx = sp.c0x + (sp.cbx - sp.c0x) * e1;
                cy = sp.c0y + (sp.cby - sp.c0y) * e1;
                w = sp.w0 + (sp.wb - sp.w0) * e1;
                h = sp.h0 + (sp.hb - sp.h0) * e1;
            } else {
                cx = sp.cbx + (sp.c1x - sp.cbx) * e2;
                cy = sp.cby + (sp.c1y - sp.cby) * e2;
                w = sp.wb + (sp.w1 - sp.wb) * e2;
                h = sp.hb + (sp.h1 - sp.hb) * e2;
            }
            if (alpha <= 0.004 || w < 0.5 || h < 0.5) continue;
            if (cx + w / 2 < 0 || cx - w / 2 > vw || cy + h / 2 < 0 || cy - h / 2 > vh) continue;
            ctx.globalAlpha = alpha;
            // The carried selection travels as its own picture (opts.image), so it never turns into a colour field; everything else is its stub colour.
            const im = sp.imgRef ? sp.imgRef.el : null;
            if (sp.placeholder) {
                // No border, as in the views: the item's box, filled.
                ctx.fillStyle = sp.color;
                ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
                continue;
            }
            if (im && im.complete && im.naturalWidth > 0) {
                ctx.drawImage(im, cx - w / 2, cy - h / 2, w, h);
            } else {
                ctx.fillStyle = sp.color;
                ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
            }
            if (w >= 6 && h >= 6) {
                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = 1;
                ctx.strokeRect(cx - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1);
            }
        }
        } catch (err) {
            console.error('[stub-bridge] draw failed', err);
            _stubBridgeCancel();
            return;
        }
        _onFrame('stub.bridgeFrame', frame);
    };
    _onFrame('stub.bridgeFrame', frame);
}

/** Lift the staged cross-fade classes set by _stubRectSwitch or _gridRectSwitch. Also cancels the canvas layer (the rAF loop normally self-cancels, but rAF is throttled in a background tab, so the timer path must clean up too)
 *  and, if the deferred doSwitch hasn't fired yet, runs it now: the view change must never be lost to an early teardown. */
function _stubSwitchTeardown() {
    _cancel('stub.switchClass', 'stub.switchXfadeIn', 'stub.switchMid', 'stub.listMeasure');
    // #list-view carries opacity 1 from the pin rule while the xfade classes are on, but its base state is opacity 0
    // with a transition, over an opaque fullscreen background above main.
    if (listView) {
        listView.style.transition = 'none';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            listView.style.removeProperty('transition');
        }));
    }
    document.body.classList.remove('mode-xfade', 'mode-xfade-staged', 'mode-xfade-out', 'mode-xfade-in', 'to-main', 'to-list');
    document.documentElement.style.removeProperty('--xfade-scroll-y');
    _stubBridgeCancel();
    if (_stubSwitchPendingMid) {
        const mid = _stubSwitchPendingMid;
        _stubSwitchPendingMid = null;
        mid();
    }
    // Release the held chunked thumb-sizing pass (see mid in
    // _stubRectSwitch) and run it now that nothing is animating.
    if (_stubThumbSizingDeferred) {
        _stubThumbSizingDeferred = false;
        __deferListThumbSizing = false;
        if (viewMode === 'list') _bindListThumbSizing();
    }
}

/** Staged view switch with the all-items rect animation, used when NO item is selected (the selected case runs
 *  through _modeBridgeSelected, which morphs only that image). doSwitch is DEFERRED to t=375ms, after the
 *  outgoing fade: running it at t=0 caused a visible reflow blink on the still-opaque outgoing surface. */
function _stubRectSwitch(doSwitch) {
    const reducedMotion = _prefersReducedMotion();
    /* Phones switch instantly. Every view there is an opaque full-screen overlay, so there is nothing for the
       surfaces to blend THROUGH (the fade only held the arriving view back) and this was the last path still setting
       body.mode-xfade on mobile. */
    if (isMobile) { doSwitch(); return; }
    if (reducedMotion || !document.getElementById('stub-bridge')) {
        _crossfadeSwitch(doSwitch);
        return;
    }
    if (_stubBridgeActive || _modeBridgeInFlight) {
        // A previous transition is still in flight (rapid toggling): tear it down (which also fires its pending doSwitch, keeping the view sequence intact) and switch instantly, mirroring the image bridge's guard.
        _stubSwitchTeardown();
        doSwitch();
        return;
    }

    const startWasList = (viewMode === 'list');
    const directionClass = startWasList ? 'to-main' : 'to-list';

    // 1. Capture source rects on untouched geometry (current scroll).
    const sources = _stubCaptureRects();

    // 2) Pin the outgoing list at its current scroll position, as in _crossfadeSwitch: the fixed-overlay pin translates by the snapshotted offset, so the eventual body-scroll reset doesn't move the content the sources were measured against.
    if (startWasList) {
        const sy = (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
        document.documentElement.style.setProperty('--xfade-scroll-y', sy + 'px');
    }

    // stub-bridging goes on now so the to-list rules fade the outgoing main and netvis from t=0 without body.list-view, and so the article transition suppression is already in place when the deferred doSwitch runs -
    // triggerAnimation and the camera fit then snap the incoming view straight to its final layout behind the held-invisible surface.
    document.body.classList.add('mode-xfade', 'mode-xfade-staged', directionClass, 'stub-bridging');
    void document.body.offsetHeight;

    // No mode-xfade-out on the stub path: the outgoing surface is covered by the curtain rather than faded via CSS. The list release and teardown are scheduled in mid, below, once the re-anchored timeline is known.

    // 3. Start the rect layer on the sources; targets follow at t=375ms.
    _stubBridgeAnimate(sources, { listSide: startWasList ? 'source' : 'target' });

    // 4) The deferred switch runs once the outgoing surface has fully faded, so none of its reflow is visible; it measures the targets and feeds them to the running animation just before the gather leg.
    const mid = () => {
        // Entering the list, hold renderList's chunked thumb-sizing until the transition ends: its per-frame layout
        // reads and writes otherwise compete with the rAF rect loop for the whole travel; the main source of Safari
        // choppiness.
        if (!startWasList) {
            __deferListThumbSizing = true;
            _stubThumbSizingDeferred = true;
        }
        _bridgeSwitchMid(doSwitch, _SB_MOVE_MS, startWasList ? null : _stubSizeVisibleListThumbs, (revealDelay) => {
            if (startWasList) return;
            // The staged rule holds #list-view at opacity 0; releasing it at the reveal makes it appear under the still-opaque curtain.
            _after('stub.switchXfadeIn', () => {
                if (document.body.classList.contains('mode-xfade-staged')) {
                    document.body.classList.add('mode-xfade-in');
                }
            }, revealDelay);
        });
    };
    _armBridgeMid(mid, _SB_MOVE_MS);
}

/** The selection a view switch carries, as { id, el } for the rect bridge to draw as a picture: the grid's selected card, the list's selected row or the monad centre. el starts as the element already on screen (decoded, whatever its tier) and is swapped for the full image file once that decodes, which is usually at once, since a selection has already loaded it. */
function _bridgeCarriedImage() {
    let id = null;
    let el = null;
    if (viewMode === 'grid' && gridSelectedId && _gridCardById && _gridCardById[gridSelectedId]) {
        id = gridSelectedId;
        el = _gridCardById[id].querySelector('img.grid-thumb');
    } else if (viewMode === 'list' && listSelectedId && listView) {
        id = listSelectedId;
        el = listView.querySelector('.list-item[data-id="' + CSS.escape(id) + '"] .list-thumb');
    } else if (viewMode === 'monad' && selectedMonadId) {
        id = selectedMonadId;
        const art = _articleById(id);
        el = art ? art.querySelector('img') : null;
    }
    if (!id || !el) return null;
    const it = _getTagItemById()[id];
    if (it && it._isPlaceholderImg) return null;
    const ref = { id, el };
    const big = new Image();
    big.decoding = 'async';
    big.src = _imgUrl(id);
    if (big.decode) big.decode().then(() => { ref.el = big; }, () => {});
    return ref;
}

/** The grid's animated switch, to or from any view: the list-map rect bridge in direct mode. */
const GRID_BRIDGE_MOVE_MS = UI_TRANS_MS;
function _gridRectSwitch(doSwitch) {
    const reducedMotion = _prefersReducedMotion();
    if (isMobile || reducedMotion || !document.getElementById('stub-bridge')) {
        doSwitch();
        return;
    }
    if (_stubBridgeActive || _modeBridgeInFlight) {
        _stubSwitchTeardown();
        doSwitch();
        return;
    }
    const sources = _stubCaptureRects();
    document.body.classList.add('stub-bridging');
    _stubBridgeAnimate(sources, { direct: true, moveMs: GRID_BRIDGE_MOVE_MS, image: _bridgeCarriedImage() });

    const mid = () => _bridgeSwitchMid(doSwitch, GRID_BRIDGE_MOVE_MS, () => {
        if (viewMode === 'list') {
            _stubSizeVisibleListThumbs();
            /* Then let the list settle before the targets are read: on the first switch into it the DOM has just been built
               and never laid out, so the thumbnails have no size yet and every row measures high. */
            _updateListYearHeads(true);
            void listView.offsetHeight;
        }
        // Entering a selection: force the layout and re-run the centre's text measurement before the targets are read, so the rect the clone flies to is the settled one.
        _settleMonadCentre();
    });
    _armBridgeMid(mid, GRID_BRIDGE_MOVE_MS);
}

/** The middle of a rect-bridge switch, shared by _stubRectSwitch and _gridRectSwitch: run the switch under the curtain,
 *  measure where the rects land (after `prepare`), and arm the teardown for the end of the reveal. onReveal, when
 *  given, is called with the ms until the reveal once that is known. */
function _bridgeSwitchMid(doSwitch, moveMs, prepare, onReveal) {
    _cancel('stub.switchMid');
    _stubSwitchPendingMid = null;
    try {
        doSwitch();
    } catch (err) {
        _stubSwitchTeardown();
        throw err;
    }
    try {
        if (prepare) prepare();
    } catch (err) {
        console.error('[stub-bridge] target preparation failed', err);
    }
    // body.animated is pointless under the curtain, but the deferred settle passes poll _viewTransitionActive() and wait for it.
    _cancel('render.animatedClass', 'render.transitionAnchor');
    if (document.body.classList.contains('animated')) {
        document.body.classList.remove('animated', 'stagger-reveal');
        _scheduleLayerDemotion();
    }
    const resolve = () => {
        let revealDelay = moveMs;
        try {
            if (_stubBridgeResolveTargets) {
                const r = _stubBridgeResolveTargets(_stubCaptureRects());
                if (typeof r === 'number') revealDelay = r;
            }
        } catch (err) {
            // Measurement must never kill the transition: without targets the rects fade out at their sources.
            console.error('[stub-bridge] target measurement failed', err);
        }
        _after('stub.switchClass', _stubSwitchTeardown, revealDelay + _SB_STAGE_MS + 30);
        if (onReveal) onReveal(revealDelay);
    };
    /* Arriving in the list, the targets are read two frames later rather than now. The rows are content-visibility:
       auto, and a row only takes its real height in a rendering update that finds it on screen; read in this task
       they all still stood at their 6rem placeholder, so every rect landed a little low, further down the more so,
       and the list shifted up under them at the reveal. The rect layer re-anchors its legs to when the targets
       arrive, so the wait costs a couple of frames of the gather and nothing else. */
    if (viewMode === 'list') _onFrame('stub.listMeasure', () => _onFrame('stub.listMeasure', resolve));
    else resolve();
}

/** Arm a bridge's middle, plus a safety-net teardown at the longest possible timeline in case it never completes. */
function _armBridgeMid(mid, moveMs) {
    _stubSwitchPendingMid = mid;
    _after('stub.switchMid', mid, _SB_STAGE_MS + 40);
    _after('stub.switchClass', _stubSwitchTeardown, _SB_STAGE_MS + _SB_RESOLVE_CAP_MS + moveMs + _SB_STAGE_MS + 90);
}

/** Wrap a view-mode switch in sequential cross-fade classes (reduced motion). main to list (parallel-ish): the
 *  outgoing main fades out while the incoming list fades in, with doSwitch at t=0, since adding body.list-view is
 *  what drives #list-view's own fade-in. list to main (fully sequenced): the list fades out on its untouched
 *  layout, doSwitch runs at t=375ms once it is invisible so removing body.list-view can't cause visible reflow,
 *  and the incoming main fades in after. */
function _crossfadeSwitch(doSwitch) {
    const startWasList = (viewMode === 'list');
    const directionClass = startWasList ? 'to-main' : 'to-list';

    // On list-to-main, snapshot the body scroll offset first: it translates #list-view during the fade so the content stays visually where it was scrolled to, even after body.list-view is removed and the body scroll resets to 0.
    if (startWasList) {
        const sy = document.scrollingElement.scrollTop || 0;
        document.documentElement.style.setProperty('--xfade-scroll-y', sy + 'px');
    }

    document.body.classList.add('mode-xfade', directionClass);
    // Flush style so the new transition rules and pinned layout are observed
    // before doSwitch changes opacity-driving classes.
    void document.body.offsetHeight;

    const cleanup = () => {
        document.body.classList.remove('mode-xfade', 'mode-xfade-seq', 'mode-xfade-out', 'to-main', 'to-list');
        document.documentElement.style.removeProperty('--xfade-scroll-y');
    };

    const runSwitchSafely = () => {
        try {
            doSwitch();
        } catch (err) {
            cleanup();
            throw err;
        }
    };

    if (startWasList) {
        // list to main: fade the list out first on its untouched geometry, then run doSwitch once it is invisible.
        document.body.classList.add('mode-xfade-seq');
        requestAnimationFrame(() => {
            document.body.classList.add('mode-xfade-out');
        });
        setTimeout(() => {
            runSwitchSafely();
        }, 375);
    } else {
        // main to list keeps the parallel flow: doSwitch adds the list-view class, which drives #list-view's own fade-in, while the outgoing main fades via the to-list rule.
        runSwitchSafely();
    }
    // Cleanup window: the sequenced path needs its fade-out, the switch and its fade-in (1125ms), the parallel path just UI_TRANS_MS.
    const totalMs = startWasList ? 1125 : UI_TRANS_MS;
    setTimeout(cleanup, totalMs + 20);
}

/** List to the map side: the carried selection's monad, the search view for a query, or the map. The selected item's image is bridged; otherwise all items travel as stub-coloured rects. */
function _listToMain() {
    const q = searchInput.value.trim();
    const sel = listSelectedId;

    const doSwitch = () => {
        // Reset body scroll to 0 BEFORE removing body.list-view: with list-view the body is the scroll container, without it body scroll is always 0, and leaving scrollTop non-zero makes the eventual layout cleanup jump upward.
        try {
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
        } catch (_) { /* noop */ }

        document.body.classList.remove('list-view');
        _openMapSide(sel, q);

        // The list DOM is intentionally retained: dormant it is removed from rendering via content-visibility, and _renderListFull's reuse path lets the next entry skip the ~310-row rebuild: the dominant cost of the map-to-list transition.
    };

    if (sel) {
        _modeBridgeSelected(sel, doSwitch);
    } else {
        _stubRectSwitch(doSwitch);
    }
}

/** Map side to list. From a monad, bridge only the selected item's image; otherwise all items travel as stub-coloured rects via _stubRectSwitch, which switches instantly on a phone and cross-fades under reduced motion. */
function _mainToList() {
    if (viewMode === 'monad' && selectedMonadId) {
        _modeBridgeSelected(selectedMonadId, () => switchToListView(true, true));
    } else {
        _stubRectSwitch(() => switchToListView(true, true));
    }
}

/** Leave the list or the grid for the map side: a selection opens its monad, a query of two or more characters the search view, anything else the map. */
function _openMapSide(sel, q) {
    if (sel) {
        switchToMonadView(sel, true, false);
    } else if (q.length >= 2) {
        switchToSearchView(q, false);
        history.pushState(null, '', '#q:' + encodeURIComponent(q));
    } else {
        switchToMapView(true);
    }
}

/* ══ UI CHROME & INPUT ═══════════════════════════════════════════════════════
   Keyboard shortcuts and continuous key input, for every view. */

const activeKeys = new Set();

/** The held key's name, with + and = as one key: Shift released before = would otherwise send keyup '=' for a
 *  keydown '+', and the '+' would stay held. */
function _heldKey(e) {
    return e.key === '+' ? '=' : e.key;
}

/** Stop the continuous-key interval. */
function _stopHeldKeys() {
    if (_keyIntervalId === null) return;
    clearInterval(_keyIntervalId);
    _keyIntervalId = null;
}
let _keyIntervalId = null;

/** Helper: continuous update. */
function continuousUpdate() {
    const panSpeed = 5;
    const zoomSpeed = 0.005;
    const centerX = __mainCenterX();
    const centerY = window.innerHeight / 2;

    let moved = false;

    // Only allow panning in map view
    if (viewMode === 'map') {
        if (activeKeys.has('ArrowUp')) {
            panY += panSpeed;
            moved = true;
        }
        if (activeKeys.has('ArrowDown')) {
            panY -= panSpeed;
            moved = true;
        }
        if (activeKeys.has('ArrowLeft')) {
            panX += panSpeed;
            moved = true;
        }
        if (activeKeys.has('ArrowRight')) {
            panX -= panSpeed;
            moved = true;
        }
    }
    // +/- zoom the map; the monad and the panel views have no zoom to step.
    if (viewMode === 'map' || viewMode === 'search') {
        const _kbZoomStep = zoomSpeed * _zoomStepGain('keyboard') * 0.5 * _MAP_ZOOM_INPUT_ADJ;
        if (activeKeys.has('=')) {
            updateZoom(_kbZoomStep, centerX, centerY);
            moved = true;
        }
        if (activeKeys.has('-')) {
            updateZoom(-_kbZoomStep, centerX, centerY);
            moved = true;
        }
    }

    if (moved) {
        update();
    }

    if (activeKeys.size === 0) _stopHeldKeys();
}

// Shared body of the search-open shortcut (Cmd/Ctrl+F and plain F): exits
// monad, clears any tag filter, resets the list selection, then opens the box.
function _openSearchShortcut() {
    if (viewMode === 'monad') switchToMapView(true, true);

    // Clear active tag filter: reset tag, zoom out to overview, clear search box of any "#tag" value
    if (activeTag) {
        _clearTagFilterState();
        _setHashForCurrentState(false);
        _updateDocTitle();
        _scheduleTagCloudUpdate(true);
        // Clear "#tag" text from search input before opening
        if (searchInput && searchInput.value.trim().startsWith('#')) {
            searchInput.value = '';
            document.body.classList.remove('search-has-query');
        }
        // Zoom out to the centred overview. animateZoomTo(0) only animates --zoom and keeps pan as-is, so the map stayed panned over where the subset was; _clearTagFilterState has already restored the centred breathing layout, so resetView zeroes pan and zoom together.
        if (viewMode === 'map' || viewMode === 'search') resetView(true);
        _updateCancelButton();
    }

    // In the grid: a fresh search, so the selection and any earlier query go too (the tag went above).
    if (viewMode === 'grid') {
        if (gridSelectedId) _gridSelect(null, { updateHash: false, scroll: false });
        if ((searchQuery || '').trim() || (searchInput && searchInput.value.trim())) _clearSearchState();
        renderGrid(true);
        _gridScrollToTop();
        _setHashForCurrentState(false);
        _updateDocTitle();
        _updateCancelButton();
    }

    // In list view: deselect any selected item, re-render, scroll to top
    if (viewMode === 'list') {
        if (listSelectedId) {
            setListSelection(listSelectedId, false, true, true, true);
            listSelectedId = null;
        }
        _updateCancelButton();
        renderList(); // instant (no fade): the box is opening and will filter as you type
        if (listView) _scrollListToTop(330);
    }

    openSearch();
}

window.addEventListener('keydown', (e) => {
    /* A key pressed over the welcome card is the reader getting on with it, so the card steps aside and the
       shortcut runs on the atlas behind in the same press: reaching for a view or the search should not cost a
       dismissal first. Two exceptions: Tab, which belongs to the card's own two buttons, and Escape, which has
       nothing to reset on the parameterless address the card appears on, so dismissing is all it means there. */
    if (typeof _welcomeOpen === 'function' && _welcomeOpen()) {
        if (e.key === 'Tab') return;
        _hideWelcome();
        if (e.key === 'Escape') { e.preventDefault(); return; }
    }

    /* A key is a decision, so a running shuffle walk ends here — before the branches below, so the key it ends on
       still does its own work: Escape resets, a digit switches view, and the walk simply is not running any more.
       Shift+R is its own toggle and is handled below; a bare modifier is nobody pressing anything. */
    if (typeof _walkRunning === 'function' && _walkRunning() && e.key !== 'R'
        && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
        _walkStop();
    }

    // Cmd+F / Ctrl+F opens search (override browser find, exits monad first)
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        _netMarkInteraction(260);
        e.preventDefault();
        _openSearchShortcut();
        return;
    }

    // Don't intercept when search input is focused
    if (document.activeElement === searchInput) return;

    // Alt+Space triggers shuffle: identical to clicking/tapping the shuffle button.
    if (e.altKey && e.code === 'Space') {
        _netMarkInteraction(260);
        e.preventDefault();
        _flashButton('shuffle-btn'); // same held-active glow as a click
        _doShuffle();
        return;
    }

    // Ignore other modifier combinations (allows browser shortcuts like cmd+left)
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Plain letter and digit shortcuts mirroring the corner buttons, with the same held-active glow. Typing in the search box never reaches here, and lowercase-only comparisons leave Shift combinations untouched.
    if (e.key === 'i') { // toggle info panel
        _netMarkInteraction(260);
        e.preventDefault();
        if (infoOverlay.classList.contains('visible')) {
            _flashInfoClose();
            hideInfo();
        } else {
            _flashButton('info-btn');
            showInfo();
        }
        return;
    }
    /* 1, 2, 3 name the views in the switcher's own left-to-right order, so the key is the position and there is nothing to learn beyond reading the button. */
    if (e.key === '1' || e.key === '2' || e.key === '3') {
        _netMarkInteraction(260);
        e.preventDefault();
        const next = ({ '1': 'map', '2': 'grid', '3': 'list' })[e.key];
        if (next === _currentViewSeg()) return;
        _pressFeedback(modeBtn ? modeBtn.querySelector('.view-seg[data-view="' + next + '"]') : null);
        _switchViewTo(next);
        return;
    }
    if (e.key === 'r') { // random item, same as Alt+Space / shuffle button
        _netMarkInteraction(260);
        e.preventDefault();
        _flashButton('shuffle-btn');
        _doShuffle();
        return;
    }
    if (e.key === 'R') { // Shift+R: the same jump, repeated, until something stops it. See the shuffle walk.
        _netMarkInteraction(260);
        e.preventDefault();
        _flashButton('shuffle-btn');
        if (typeof _walkToggle === 'function') _walkToggle();
        return;
    }
    if (e.key === 'f') { // open search (plain-letter twin of Cmd/Ctrl+F)
        _netMarkInteraction(260);
        e.preventDefault();
        // No flash: #search-box is deliberately excluded from the held-active feedback, since its toggle is instantaneous.
        _openSearchShortcut();
        return;
    }

    // Space pages the list and the grid, and closes the lightbox. On the map and in an open item it does nothing: see the note at the end of this block.
    if (e.key === ' ') {
        // Close lightbox on Space regardless of view mode
        if (lightboxOpen) {
            e.preventDefault();
            closeLightbox();
            return;
        }

        if (_isPanelView()) {
            _panelScrollKey(e);
            return;
        }

        _netMarkInteraction(260);
        e.preventDefault();
        /* Nothing on the map or in an open item. Space pages the list and the grid, where a page is an obvious unit; neither of the other two has one. */
        return;
    }

    // Enter opens the current monad's link in a new tab
    /* Enter opens the source of whatever entry is open, in any of the three views: the keyboard twin of clicking
       its title. With nothing open it does nothing, rather than guessing at one. */
    if (e.key === 'Enter') {
        const openId = _selectedItemId();
        const openItem = openId ? _getTagItemById()[openId] : null;
        if (openItem && openItem.url) {
            window.open(openItem.url, '_blank', 'noopener');
        }
        return;
    }

    if (e.key === 'Escape') {
        _netMarkInteraction(260);
        if (lightboxOpen) { closeLightbox(); return; }
        if (infoOverlay.classList.contains('visible')) { _flashInfoClose(); hideInfo(); return; }

        const hadSearch = !!(searchInput && searchInput.value && searchInput.value.trim()) || ((searchQuery || '').trim().length >= 2);
        const hadTag = !!(activeTag && activeTag.trim());

        // Escape is the keyboard twin of the cancel button: the branches below flash it (guarded when hidden) whenever the keypress actually cancels something. Intermediate steps that only change the camera keep the selection and don't flash.

        // LIST: clear what is in the list: the selection and the filter it sits in go together; filter removal folds the hidden rows back in, a lone selection is removed in place, and only a further Escape scrolls to the top.
        if (viewMode === 'list') {
            _flashCancelButton();
            if (listSelectedId && (hadSearch || hadTag)) {
                // Both at once: drop the query or tag, then one fold that also collapses the selected row, keeping it pinned.
                if (hadSearch) { _clearSearchState(); if (searchInput) searchInput.blur(); }
                if (hadTag) _clearTagFilterState();
                _animateListFilterDeselecting();
            } else if (hadSearch) {
                closeSearch();                 // folds the search-hidden rows back in
            } else if (hadTag) {
                _clearTagFilterState();
                _animateListFilterDeselecting();
            } else if (listSelectedId) {
                // Route through the click helper so the image scale handoff
                // (no expand-before-shrink) matches click-to-deselect exactly.
                const _selEl = _getListItemEl(listSelectedId);
                if (_selEl) _deselectListItemFromClick(_selEl, listSelectedId);
                else setListSelection(listSelectedId, false, true, true, true);
            } else if (listView) {
                // Escape clears what is IN the list (a selection, then the filters) and then returns to the top.
                _scrollListToTop(330);
            }

            _updateCancelButton();
            _writeAddress({ view: 'list' }, false);
            _updateDocTitle();
            _scheduleTagCloudUpdate(true);
            return;
        }

        // GRID: clear the selection and the filter it sits in together, then (on a further Escape) return to the top.
        if (viewMode === 'grid') {
            if (gridSelectedId || hadSearch || hadTag) _flashCancelButton();
            if (!_gridClearSelectionAndFilter(true) && gridView) {
                // Animated, as the list's Escape scrolls back up.
                gridView.scrollTo({ top: 0, behavior: SCROLL_BEHAVIOR });
            }
            _updateCancelButton();
            _scheduleTagCloudUpdate(true);
            return;
        }

        // MONAD: one step per press, most specific first, as in the list and the grid. Escape closes the selection and lands back on the map the item was opened from, filter and camera intact; a further Escape then clears that filter through the MAP branch below.
        if (viewMode === 'monad') {
            _flashCancelButton();
            _monadCloseSelection();
            _scheduleTagCloudUpdate(true);
            return;
        }

        // MAP/SEARCH: clear filters with staggered animation and reset view
        _flashCancelButton();
        if (hadTag && viewMode === 'map') {
            // Staggered tag-clear handles its own zoom/pan reset
            if (hadSearch) closeSearch();
            _clearTagFilterKeepView(false);
            _setHashForCurrentState(false);
            _updateDocTitle();
            _scheduleTagCloudUpdate(true);
            return;
        }
        if (hadSearch) closeSearch();
        if (hadTag) { _clearTagFilterState(); }

        // Ensure the URL hash/title reflect the cleared tag/search (Escape should fully cancel filters).
        _setHashForCurrentState(false);
        _updateDocTitle();

        // Animate back to centered map
        triggerAnimation();
        _resetBreathingLayout();
        zoom = 0;
        panX = 0;
        panY = 0;
        if (viewMode === 'search') {
            switchToMapView(false, false, false);
        } else {
            update();
        }
        _scheduleTagCloudUpdate(true);
        tagVis.updateAfterTransition();
        return;
    }


    /* In the grid the arrows walk the selection in the direction they point: left and right to the previous or
       next card in the list's order, up and down to the card drawn above or below this one. Only with a selection;
       without one they fall through to the scrolling below, as the list's do. */
    if (viewMode === 'grid' && gridSelectedId && !lightboxOpen
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const ae = document.activeElement;
        const tag = ae ? ae.tagName : '';
        if (!(ae && (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable))) {
            e.preventDefault();
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') _gridStepSelection(e.key === 'ArrowRight' ? 1 : -1);
            else _gridStepSelectionVertical(e.key === 'ArrowDown' ? 1 : -1);
            return;
        }
    }

    // In the grid, the reading keys scroll the grid, which is its own scroller.
    if (viewMode === 'grid' && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
        _panelScrollKey(e);
        return;
    }

    /* In list mode, arrow keys step through the list order when an item is selected, and scroll normally when
       nothing is. Left and right go with down and up: the list is one column, so there is no second direction for
       them to mean, and a reader who reaches for them should not find nothing there. */
    if (viewMode === 'list' && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (lightboxOpen) { e.preventDefault(); closeLightbox(); return; }
        if (!listView) return;

        // If nothing is selected, don't hijack arrows for selection: scroll instead. Sideways there is nothing to
        // scroll, so those two are left alone rather than scrolling the page by a line.
        if (!listSelectedId) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') _panelScrollKey(e);
            return;
        }

        e.preventDefault();
        _stepListSelectionVisible((e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1);
        return;
    }
    // In the list, the page keys scroll it, as in the grid.
    if (viewMode === 'list' && ['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
        _panelScrollKey(e);
        return;
    }

    const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-'];
    if (!navKeys.includes(e.key)) return;

    // In list or grid mode, keep native scrolling / caret movement.
    if (_isPanelView()) return;

    // Close lightbox on arrow keys in any view
    if (lightboxOpen) { e.preventDefault(); closeLightbox(); return; }

    _netMarkInteraction(260);
    e.preventDefault();

    const key = _heldKey(e);
    if (!activeKeys.has(key)) {
        activeKeys.add(key);

        if (_keyIntervalId === null) {
            continuousUpdate(); // immediate first tick
            _keyIntervalId = setInterval(continuousUpdate, 16);
        }
    }
});

window.addEventListener('keyup', (e) => {
    activeKeys.delete(_heldKey(e));
    if (activeKeys.size === 0) _stopHeldKeys();
});

// A keyup that never arrives (the window loses focus with a key down) would otherwise leave the map panning or
// zooming on its own.
window.addEventListener('blur', () => {
    activeKeys.clear();
    _stopHeldKeys();
});


document.querySelector('main').addEventListener('dblclick', (e) => {
    if (e.target === e.currentTarget) resetView(true);
});

window.addEventListener('contextmenu', () => {
    isDragging = false;
});


/* ══ PANEL SCROLL ANCHOR ═══════════════════════════════════════════════════
   Hold the list or the grid still while something reflows it.

   Both views reflow when the info panel slides in or out: it takes a strip off
   the left, so the column narrows, rows re-wrap and the grid re-columns, and
   again on a window resize. Either way the content above the reader grows or
   shrinks and carries whatever they were reading off the screen.

   Anchoring on the item at the CENTRE of the viewport rather than on the
   selection, which is what makes this work when nothing is selected and when the
   selection is nowhere near the screen. elementFromPoint finds it in one call
   instead of measuring every row, and the item under the middle of the window is
   by definition the one the reader is looking at.

   Held for the length of the move rather than corrected once at the end: the
   panel animates on --infoTrans and the reflow arrives progressively with it, so
   a single correction afterwards would let everything drift and then snap back. */

let _panelAnchorHold = null;

function _panelScroller() {
    if (viewMode === 'grid') return gridView;
    if (viewMode === 'list') return listView;   // proxied to the body scroller in list view
    return null;
}

/** The item under the middle of the window, and how far down the window it sits. */
function _capturePanelAnchor() {
    if (!_panelScroller()) return null;
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    const hit = document.elementFromPoint(x, y);
    const node = (hit && hit.closest)
        ? hit.closest('#list-view .list-item[data-id], #grid-view .grid-card[data-id]')
        : null;
    if (!node) return null;
    return { node, top: node.getBoundingClientRect().top };
}

/** Scroll the panel so the anchored item is back where it was captured. */
function _restorePanelAnchor(a) {
    if (!a || !a.node || !a.node.isConnected) return;
    const sc = _panelScroller();
    if (!sc) return;
    const delta = a.node.getBoundingClientRect().top - a.top;
    // Sub-pixel drift is not worth a write, and writing every frame would fight momentum.
    if (Math.abs(delta) < 0.5) return;
    sc.scrollTop = Math.max(0, sc.scrollTop + delta);
}

/** Capture now, then hold that item in place for durMs. Call BEFORE the change that reflows. */
function _holdPanelAnchor(durMs) {
    const a = _capturePanelAnchor();
    if (!a) return;
    _panelAnchorHold = a;
    const end = performance.now() + Math.max(0, durMs || 0);
    const tick = () => {
        // Superseded by a later hold, or the reader has scrolled away from it.
        if (_panelAnchorHold !== a) return;
        _restorePanelAnchor(a);
        if (performance.now() < end) { requestAnimationFrame(tick); return; }
        _panelAnchorHold = null;
    };
    requestAnimationFrame(tick);
}

/* A scroll the reader starts themselves ends the hold: without this, dragging during the
   panel's travel would be undone on the next frame. The panel's own reflow does not scroll,
   so it never trips this. */
['wheel', 'touchstart', 'keydown'].forEach((evt) => {
    // Capture phase, so this runs BEFORE the keydown handler: a key that opens or closes the info panel starts a new hold there, which must survive.
    window.addEventListener(evt, () => { _panelAnchorHold = null; }, { passive: true, capture: true });
});
