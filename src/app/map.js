/* ══ MAP ═══════════════════════════════════════════════════════════════════════
   The map (items placed by similarity) and the monad view of a selected item on it, the NetVis canvas that
   draws their links, the search view, and the map's layout, camera, zoom and pointer input. On a phone the
   monad is shown as a full-screen detail, whose phone-only parts are in item.js. See core.js for the
   file list. */

/* ══ NETVIS CANVAS ═════════════════════════════════════════════════════════ */

// One-shot redraw for expiring edge graces; the draw re-checks all graces and re-arms if any are still fading.
function _netScheduleGraceRedraw(until) {
    if (_pending('net.graceRedraw')) return;
    const delay = Math.max(16, until - performance.now() + 30);
    _after('net.graceRedraw', () => {
        _netRequestDraw(0);
    }, delay);
}




/* ── NetVis canvas (background) ─────────────────────────────────────────────
   Draws gray edges between items linked via item.links (an array of ids). */
let _netCanvas = document.getElementById('netvis');
// No net vis on mobile (see the mode in index.html); it also saves memory and CPU on iOS Safari.
if (isMobile && _netCanvas) {
    try { _netCanvas.remove(); } catch (e) { if (_netCanvas.parentNode) _netCanvas.parentNode.removeChild(_netCanvas); }
    _netCanvas = null;
}
const _netCtx = _netCanvas ? _netCanvas.getContext('2d') : null;

let _netKeepUntil = 0;
let _netNeedsDraw = true;
let _netW = 0, _netH = 0, _netDpr = 1;
let _netInteractionUntil = 0;

// Per-article image-centre offset cache (article._netDx/_netDy), valid while _netOffEpoch matches; bump the epoch to invalidate every article at once.
let _netOffsetEpoch = 1;
function _netBumpOffsetEpoch() { _netOffsetEpoch++; }

/* Whether anything that moves an item's image is still transitioning: an item's position (--art-tx/--art-ty) or
   its own transforms, or the root --zoom / --item-scale a zoom animates. Counted from the browser's own transition
   events rather than inferred from body classes and timers, which could end before the CSS did and leave the edges
   drawn where the items were a moment before they stopped. (Polling document.getAnimations() each frame gave the
   same answer at 2-3ms a frame.) */
const _NET_MOTION_PROPS = /^(--art-tx|--art-ty|--zoom|--item-scale|--scale|--enter-offset|--img-x-shift|--taghide|transform)$/;
const _netMotions = new Map();   // element -> Set of transitioning property names
let _netMotionSince = 0;
function _netMotionTarget(e) {
    const t = e.target;
    if (!t || !_NET_MOTION_PROPS.test(e.propertyName)) return null;
    if (t === document.documentElement || (t.closest && t.closest('main'))) return t;
    return null;
}
document.addEventListener('transitionrun', (e) => {
    const t = _netMotionTarget(e);
    if (!t) return;
    if (!_netMotions.size) _netMotionSince = performance.now();
    let set = _netMotions.get(t);
    if (!set) _netMotions.set(t, (set = new Set()));
    set.add(e.propertyName);
    _netRequestDraw(0);
}, true);
const _netMotionDone = (e) => {
    const t = _netMotionTarget(e);
    if (!t) return;
    const set = _netMotions.get(t);
    if (!set) return;
    set.delete(e.propertyName);
    if (!set.size) _netMotions.delete(t);
    if (!_netMotions.size) _netMotionSince = 0;
};
document.addEventListener('transitionend', _netMotionDone, true);
document.addEventListener('transitioncancel', _netMotionDone, true);
function _netMotionRunning() {
    if (!_netMotions.size) return false;
    // Safety net: an element removed mid-transition may never report its end. No transition here runs past ~1.5s.
    if (performance.now() - _netMotionSince > 3000) { _netMotions.clear(); _netMotionSince = 0; return false; }
    return true;
}
let _netWasMoving = false;

// Hover highlight state (screen-space, zoom/scale-invariant)
let _netHoverId = null;
let _netHoverT = 0;          // 0..1
let _netHoverTarget = 0;     // 0..1
let _netHoverLastTs = 0;

// Root CSS values for the draw, cached until the colour scheme changes: they are otherwise stable.
let _netRootCSCache = null;
function _netInvalidateRootCSCache() { _netRootCSCache = null; }
function _netGetRootCSCache() {
    if (_netRootCSCache) return _netRootCSCache;
    const rootCS = getComputedStyle(document.documentElement);
    const fontSize = parseFloat(rootCS.fontSize) || 16;
    _netRootCSCache = {
        bg: (rootCS.getPropertyValue('--bg') || '').trim() || '#fff',
        fg: (rootCS.getPropertyValue('--fg') || '').trim() || 'black',
        fg2: (rootCS.getPropertyValue('--fg2') || '').trim() || '',
        gray: (rootCS.getPropertyValue('--gray') || '').trim() || 'gray',
        midgray: (rootCS.getPropertyValue('--midgray') || '').trim() || '',
        lineWidth: Math.max(0.5, fontSize * 0.1),
    };
    return _netRootCSCache;
}

/* ── Linked-items cache ────────────────────────────────────────────────────
   Only items with at least one link can carry an edge: far fewer than items.length -
   so keep a cached subset and a deduped edge list, both invalidated on data changes. */
let _netLinkedItems = null;   // Array<item>: items where (item.links && item.links.length)
let _netEdgeList = null;      // Array<[idA, idB]>: undirected, deduplicated

function _netInvalidateLinkCache() {
    _netLinkedItems = null;
    _netEdgeList = null;
}

function _netBuildLinkCache() {
    const linked = [];
    const edges = [];
    const seen = new Set();
    for (let i = 0, len = items.length; i < len; i++) {
        const it = items[i];
        if (!it || !it.links || !Array.isArray(it.links) || it.links.length === 0) continue;
        linked.push(it);
        for (let j = 0, ln = it.links.length; j < ln; j++) {
            const tid = it.links[j];
            if (!tid || tid === it.id) continue;
            const k = (it.id < tid) ? (it.id + '\u0000' + tid) : (tid + '\u0000' + it.id);
            if (seen.has(k)) continue;
            seen.add(k);
            edges.push([it.id, tid]);
        }
    }
    _netLinkedItems = linked;
    _netEdgeList = edges;
}


/** Advance hover highlight animation (linear; matches CSS hover duration). */
function _netUpdateHover(now) {
    if (_netHoverLastTs === 0) _netHoverLastTs = now;
    const dt = Math.max(0, Math.min(50, now - _netHoverLastTs));
    _netHoverLastTs = now;

    if (_netHoverId) {
        // Duration driven by the JS constant (synced to CSS at boot by _syncUiCssVars).
        const durationMs = UI_HOVER_MS || 100;

        const step = dt / durationMs;
        if (_netHoverTarget > _netHoverT) _netHoverT = Math.min(_netHoverTarget, _netHoverT + step);
        else if (_netHoverTarget < _netHoverT) _netHoverT = Math.max(_netHoverTarget, _netHoverT - step);

        if (_netHoverTarget === 0 && _netHoverT <= 0.001) {
            _netHoverT = 0;
            _netHoverId = null;
        }
    } else {
        _netHoverT = 0;
    }
}

/** Extract item id from an event target (article id "i_<id>" or img[data-id]). */
function _netExtractIdFromTarget(t) {
    if (!t || !t.closest) return null;
    const art = t.closest('article');
    if (art && typeof art.id === 'string' && art.id.startsWith('i_')) return art.id.slice(2);
    const img = t.closest('img[data-id]');
    if (img) return img.getAttribute('data-id') || null;
    return null;
}

/** Set hovered id + animate hover highlight. */
function _netSetHover(id, on) {
    if (!id) return;
    if (on) {
        if (_netHoverId !== id) {
            _netHoverId = id;
            _netHoverT = 0;
        }
        _netHoverTarget = 1;
    } else if (_netHoverId === id) _netHoverTarget = 0;
    // Reset timing so the new duration is applied immediately (no "sticky" dt).
    _netHoverLastTs = performance.now();
    // One draw kicks off the hover animation; subsequent frames are driven by _netHoverAnimating.
    _netRequestDraw(0);
}

/** Attach delegated hover listeners (pointer-based, works for mouse/pen). */
(function _netInitHoverDelegation() {
    if (!_netCtx) return;
    const main = document.querySelector('main');
    if (!main) return;

    main.addEventListener('pointerover', (e) => {
        const id = _netExtractIdFromTarget(e.target);
        if (!id) return;
        const rel = _netExtractIdFromTarget(e.relatedTarget);
        if (id !== rel) {
            _netSetHover(id, true);
            _stubHoverReveal(id);
        }
    }, true);

    main.addEventListener('pointerout', (e) => {
        const id = _netExtractIdFromTarget(e.target);
        if (!id) return;
        const rel = _netExtractIdFromTarget(e.relatedTarget);
        if (id !== rel) {
            _netSetHover(id, false);
            _stubHoverRelease(id);
        }
    }, true);
})();

/* ══ NETVIS CANVAS (CONTINUED) ═════════════════════════════════════════════ */

function _netHasRecentInteraction() {
    return performance.now() < _netInteractionUntil;
}

function _netMarkInteraction(ms = 220) {
    if (!_netCtx) return;
    const until = performance.now() + Math.max(0, ms || 0);
    if (until > _netInteractionUntil) _netInteractionUntil = until;
    _cancel('net.interaction');
    _after('net.interaction', () => {
        _netUpdateSuspendedClass();
        // Final settle draw once interaction times out, so lines snap to
        // the last positions after the low-fps loop exits.
        _netRequestDraw(0);
    }, Math.max(0, Math.ceil(_netInteractionUntil - performance.now())) + 16);
    _netUpdateSuspendedClass();
    // Seed the low-fps draw loop so lines track items during the interaction.
    // Cheap: _netRequestDraw coalesces into a single rAF.
    _netRequestDraw(0);
}

/** Ensure canvas matches viewport size (HiDPI-aware). */
function _netResizeIfNeeded() {
    if (!_netCanvas || !_netCtx) return;

    // iOS Safari can "resize" the viewport by a few px as browser UI shows/hides.
    // Resizing a HiDPI canvas repeatedly is expensive and can trigger memory churn.
    const de = document.documentElement;
    const w = Math.round((de && de.clientWidth) ? de.clientWidth : (window.innerWidth || 0));
    const h = Math.round((de && de.clientHeight) ? de.clientHeight : (window.innerHeight || 0));

    let dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    // Mobile: cap DPR to reduce canvas backing-store memory (large stability win on iOS).
    if (isMobile) dpr = Math.min(dpr, 2);

    const tolW = 1;
    const tolH = isMobile ? 20 : 0;
    if (Math.abs(w - _netW) <= tolW && Math.abs(h - _netH) <= tolH && dpr === _netDpr) return;

    _netW = w;
    _netH = h;
    _netDpr = dpr;

    _netCanvas.width = Math.max(1, Math.round(w * dpr));
    _netCanvas.height = Math.max(1, Math.round(h * dpr));
    _netCanvas.style.width = w + 'px';
    _netCanvas.style.height = h + 'px';

    _netCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Heavy UI states where NetVis must not draw at all: either the canvas is forced to opacity 0 by dedicated CSS rules, so drawing is wasted, or the surface itself is gone (list-switching).
 *  `animated` and `zoom-animating` are NOT hard-suspend signals: during those the draw loop falls back to getBoundingClientRect so the lines track the CSS-interpolated transforms rather than the already-snapped _tx/_ty. */
function _netIsHardSuspended() {
    const b = document.body;
    if (b.classList.contains('list-view')) return true;
    if (b.classList.contains('grid-view')) return true;
    if (b.classList.contains('lightbox-active')) return true;
    if (b.classList.contains('list-switching')) return true;
    if (b.classList.contains('mode-bridging')) return true;
    // to-list fades the canvas out via CSS; to-main fades it back in, so only the former hard-suspends.
    if (b.classList.contains('mode-xfade') && b.classList.contains('to-list')) return true;
    return false;
}

/** Active interaction states (pan, drag, zoom, pinch) and map/monad view-switch animations, during which the edges
 *  redraw every frame so they track the moving items. */
function _netIsInteracting() {
    const b = document.body;
    // try/catch: viewMode/isMobile may still be in TDZ during early boot.
    try {
        if (viewMode === 'monad' && !isMobile) {
            // Monad-desktop already runs at full rate during zoom/scroll
            // (only a handful of edges are visible at a time). No throttle.
            return false;
        }
    } catch (_) { /* fall through */ }
    return (
        _netHasRecentInteraction() ||
        b.classList.contains('zoom-animating') ||
        b.classList.contains('dragging') ||
        b.classList.contains('notransition') ||
        b.classList.contains('animated')
    );
}

/** Whether we should draw right now (skip in list view / lightbox / view-switch). */
function _netShouldDraw() {
    if (!_netCtx) return false;
    return !_netIsHardSuspended();
}

/** Request a redraw; optionally keep drawing for N ms (covers CSS transitions). */
function _netRequestDraw(keepMs) {
    if (!_netCtx) return;

    _netNeedsDraw = true;

    if (keepMs && keepMs > 0) {
        const until = performance.now() + keepMs;
        if (until > _netKeepUntil) _netKeepUntil = until;
    }

    // If the canvas is currently hidden/suspended, don't schedule work.
    // We'll redraw once we become visible again.
    if (!_netShouldDraw()) return;

    if (!_pending('net.draw')) _onFrame('net.draw', _netDrawFrame);
}

/** Draw the netvis synchronously, now: call from the end of update() so lines render in the same rAF as the just-written _tx/_ty, with no one-frame lag. */
function _netDrawNow() {
    if (!_netCtx) return;
    _netNeedsDraw = true;
    _cancel('net.draw');
    _netDrawFrame();
}

// Keep body.netvis-suspended in sync with transition classes (for fade out/in)
// and trigger a redraw once transitions finish.
let _netPrevTransitioning = null;
function _netScheduleFinalDraw() {
    if (!_netCtx) return;
    _cancel('net.finalDrawTail', 'net.finalDraw1', 'net.finalDraw2');
    _after('net.finalDrawTail', () => {
        _onFrame('net.finalDraw1', () => {
            _onFrame('net.finalDraw2', () => {
                _netRequestDraw(0);
            });
        });
    }, 150);
}

function _netUpdateSuspendedClass() {
    if (!_netCtx) return;
    const t = _netIsHardSuspended();
    if (_netPrevTransitioning === t) {
        // A class changed without hard-suspending: seed a draw so the self-rearming interaction loop starts up.
        if (!t && _netIsInteracting()) _netRequestDraw(0);
        return;
    }
    _netPrevTransitioning = t;
    document.body.classList.toggle('netvis-suspended', t);
    if (!t) {
        _netRequestDraw(0);
        _netScheduleFinalDraw();
    }
}

(function _netInitSuspensionObserver() {
    if (!_netCtx || !document.body) return;
    _netUpdateSuspendedClass();
    // Body classes that change article box geometry: flipping any of them invalidates every cached image-centre offset.
    const _geomClasses = [
        'zoom-animating', 'animated', 'monad-view', 'monad-zoomed-in',
        'monad-detail-visible', 'list-view', 'labels-hidden',
        'monad-related-hidden'
    ];
    let _prevGeom = 0;
    for (let i = 0; i < _geomClasses.length; i++) {
        if (document.body.classList.contains(_geomClasses[i])) _prevGeom |= (1 << i);
    }
    const obs = new MutationObserver(() => {
        _netUpdateSuspendedClass();
        let nextGeom = 0;
        for (let i = 0; i < _geomClasses.length; i++) {
            if (document.body.classList.contains(_geomClasses[i])) nextGeom |= (1 << i);
        }
        if (nextGeom !== _prevGeom) {
            _prevGeom = nextGeom;
            _netBumpOffsetEpoch();
        }
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();

/* Redraw when the OS/browser colour scheme flips (light/dark). Both canvases, not just this one: a canvas holds
   pixels, not a stylesheet, so nothing about a media query repaints what is already on it. */
(function _netInitColorSchemeListener() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => {
        _netInvalidateRootCSCache();
        _netRequestDraw(0);
        /* A settle rather than one draw: the media query and the computed custom properties land in the same frame in every browser I would bet on, and in the one I would not this costs a few frames once in a session. */
        tagVis.linksSettle(250);
    };
    mq.addEventListener('change', onChange);
})();

/** Draw frame (runs via rAF). */
function _netDrawFrame() {

    const now = performance.now();
    const keep = now < _netKeepUntil;

    if (!_netNeedsDraw && !keep) return;

    /* No frame skipping while things move. The edges used to be held to ~25fps during interaction and transitions,
       and a line a few frames behind its image read as sluggish; the endpoints now cost a few rect reads against a
       layout the frame computes anyway, so every frame is drawn. */
    _netNeedsDraw = false;

    _netResizeIfNeeded();
    if (!_netW || !_netH || !_netCtx) return;

    // Clear/skip when hidden
    if (!_netShouldDraw()) {
        _netCtx.clearRect(0, 0, _netW, _netH);
        // Drop any keep-window; we'll redraw when visible again.
        _netKeepUntil = 0;
        return;
    }

    // clearRect, not fillRect: #netvis carries background: var(--bg), so transparent pixels already read as background.
    _netCtx.clearRect(0, 0, _netW, _netH);
    const rcs = _netGetRootCSCache();
    _netCtx.lineWidth = rcs.lineWidth;

    // Colors
    const lineCol = rcs.gray;
    // midgray sits between --gray and the foreground, so the highlight reads correctly in both colour schemes.
    const hoverLineCol = rcs.midgray || lineCol;

    _netCtx.strokeStyle = lineCol;
    _netCtx.lineCap = 'butt';
    _netCtx.lineJoin = 'miter';

    // Update hover animation before drawing (so edges share the same timing)
    _netUpdateHover(now);
    const hoverId = _netHoverId;
    const hoverAlpha = hoverId ? _clamp01(_netHoverT || 0) : 0;

    // Gather visible image rects (screen-space; already accounts for CSS transforms)
    const positions = Object.create(null);

    // Build/refresh linked-items cache (only items with at least one link)
    if (!_netLinkedItems) _netBuildLinkCache();
    const linkedItems = _netLinkedItems;

    // Endpoints: fast path reads article._tx/_ty (no DOM reads); the rect fallback tracks the compositor while CSS
    // interpolates, since _tx/_ty has already snapped to the destination.
    let _useRectFallback = false;
    const _bcl = document.body.classList;
    const _moving = _netMotionRunning();
    if (_bcl.contains('animated') || _moving) {
        _useRectFallback = true;
    } else if (_bcl.contains('zoom-animating')) {
        // Monad-desktop's rAF-driven zoom sync keeps _tx/_ty current.
        _useRectFallback = !(viewMode === 'monad' && !isMobile);
    }
    // Just come to rest: the cached image-centre offsets were last written mid-motion (or at another item scale), so
    // re-seed them from the settled layout now, and once more a moment later in case a transition was still in its
    // last frame.
    if (_netWasMoving && !_useRectFallback) {
        _netBumpOffsetEpoch();
        _after('net.restReseed', () => { _netBumpOffsetEpoch(); _netRequestDraw(0); }, 120);
    }
    _netWasMoving = _useRectFallback;
    // Keep drawing every frame for as long as anything is moving, whatever the keep-window says.
    if (_useRectFallback) {
        _netNeedsDraw = true;
        _onFrame('net.draw', _netDrawFrame);
    }

    // Loop over items that actually have links (much smaller than items.length)
    for (let i = 0, len = linkedItems.length; i < len; i++) {
        const it = linkedItems[i];
        const article = it ? (it._article || null) : null;
        if (!article) continue;

        // Class-based visibility test, cheaper than getComputedStyle. map-offscreen is deliberately not excluded: per-edge culling happens below via _edgeVisible.
        const cls = article.classList;
        if (_isSuppressedHidden(article)) continue;

        // Wait for the `loaded` class: edges drawn before the bitmap arrives point at empty space.
        if (!cls.contains('loaded')) continue;

        // Hold the edges of freshly revealed items until their fade completes; reveal paths stamp _edgeGraceUntil.
        if (it._edgeGraceUntil) {
            if (performance.now() < it._edgeGraceUntil) {
                _netScheduleGraceRedraw(it._edgeGraceUntil);
                continue;
            }
            it._edgeGraceUntil = 0;
        }

        // The hovered item scales, tracked through the whole tween, so it needs live-rect endpoints: see below.
        const isHoverScaled = hoverId && it.id === hoverId;
        let cx, cy;
        if (_useRectFallback) {
            // CSS is interpolating the transform, so read the live rect; costs one forced layout per linked item per frame.
            if (!_measureImgCenter(article)) continue;
            cx = _imgCenterOut.cx;
            cy = _imgCenterOut.cy;
            // Side effect: refresh the image-centre offset cache for the next fast-path frame (not from a culled article,
            // whose image has no real box).
            const tx = article._tx, ty = article._ty;
            if (tx != null && ty != null && !cls.contains('map-offscreen')) {
                article._netDx = cx - tx;
                article._netDy = cy - ty;
                article._netOffEpoch = _netOffsetEpoch;
            }
        } else if (isHoverScaled) {
            // Hover-scaled items shift their image centre mid-transition, so read the live rect. Deliberately does NOT write the offset cache, which must stay un-hovered.
            if (!_measureImgCenter(article)) continue;
            cx = _imgCenterOut.cx;
            cy = _imgCenterOut.cy;
        } else {
            // Fast path: (_tx,_ty) is the article's bottom anchor, so add the cached image-centre offset. Seeded lazily, then zero DOM reads per frame.
            const tx = article._tx;
            const ty = article._ty;
            if (tx == null || ty == null) continue;

            let dx, dy;
            const culled = cls.contains('map-offscreen');
            if (article._netOffEpoch === _netOffsetEpoch && !culled
                && article._netDx != null && article._netDy != null) {
                dx = article._netDx;
                dy = article._netDy;
            } else {
                // Seed the cache from the current visual rect. A culled article (content-visibility: hidden) has no
                // real image box, so what it measures is used for this frame only and never cached: cached, it stayed
                // wrong by hundreds of px once a pan brought the item into view.
                if (!_measureImgCenter(article)) continue;
                dx = _imgCenterOut.cx - tx;
                dy = _imgCenterOut.cy - ty;
                if (!culled) {
                    article._netDx = dx;
                    article._netDy = dy;
                    article._netOffEpoch = _netOffsetEpoch;
                }
            }
            cx = tx + dx;
            cy = ty + dy;
        }

        positions[it.id] = { cx, cy };
    }

    // In monad view: only show links of the current selection.
    const monadSelId = (viewMode === 'monad' && selectedMonadId) ? selectedMonadId : null;

    // hoverSegs collects edges touching the hovered item so they can be re-stroked in --midgray on top of the base lines.
    const hoverSegs = (hoverAlpha > 0 && hoverId) ? [] : null;
    // Viewport culling: skip edges where both endpoints lie outside the same side.
    const _nvW = _netW, _nvH = _netH;
    function _edgeVisible(ax, ay, bx, by) {
        const aIn = ax >= 0 && ax <= _nvW && ay >= 0 && ay <= _nvH;
        const bIn = bx >= 0 && bx <= _nvW && by >= 0 && by <= _nvH;
        return aIn || bIn;
    }
    _netCtx.beginPath();


    if (monadSelId) {
        const a = positions[monadSelId];
        const sel = (_selectedMonadItem && _selectedMonadItem.id === monadSelId) ? _selectedMonadItem : _getTagItemById()[monadSelId];
        if (a && sel && Array.isArray(sel.links)) {
            // Loop.
            for (let j = 0; j < sel.links.length; j++) {
                const tid = sel.links[j];
                if (!tid || tid === monadSelId) continue;
                const b = positions[tid];
                if (!b) continue;
                if (!_edgeVisible(a.cx, a.cy, b.cx, b.cy)) continue;

                _netCtx.moveTo(a.cx, a.cy);
                _netCtx.lineTo(b.cx, b.cy);

                // Only highlight when a linked peripheral is hovered: hovering the centre would light every edge.
                if (hoverSegs && tid === hoverId) {
                    hoverSegs.push([a.cx, a.cy, b.cx, b.cy]);
                }
            }
        }
    } else {
        // Use the precomputed, deduplicated edge list. We still need to
        // check positions[] (some endpoints may have been culled above).
        const edges = _netEdgeList || [];
        for (let i = 0, len = edges.length; i < len; i++) {
            const e = edges[i];
            const idA = e[0], idB = e[1];
            const a = positions[idA];
            if (!a) continue;
            const b = positions[idB];
            if (!b) continue;
            if (!_edgeVisible(a.cx, a.cy, b.cx, b.cy)) continue;

            _netCtx.moveTo(a.cx, a.cy);
            _netCtx.lineTo(b.cx, b.cy);

            if (hoverSegs && (idA === hoverId || idB === hoverId)) {
                hoverSegs.push([a.cx, a.cy, b.cx, b.cy]);
            }
        }
    }

    _netCtx.stroke();

    // Hover: highlight connected edges in --midgray over the --gray base
    // (applies in both map and monad views).
    if (hoverSegs && hoverSegs.length) {
        _netCtx.save();
        _netCtx.globalAlpha = hoverAlpha;
        _netCtx.strokeStyle = hoverLineCol;
        _netCtx.beginPath();
        for (let i = 0; i < hoverSegs.length; i++) {
            const s = hoverSegs[i];
            _netCtx.moveTo(s[0], s[1]);
            _netCtx.lineTo(s[2], s[3]);
        }
        _netCtx.stroke();
        _netCtx.restore();
        _netCtx.strokeStyle = lineCol;
    }

    // Keep drawing only for the hover fade.
    const _netHoverAnimating = (_netHoverId && Math.abs((_netHoverTarget || 0) - (_netHoverT || 0)) > 0.001);

    // Self-rearm during interaction, every frame; the loop exits once _netIsInteracting() goes false.
    if (_netIsInteracting()) {
        _netNeedsDraw = true;
        if (!_pending('net.draw')) _onFrame('net.draw', _netDrawFrame);
        return;
    }

    if (keep || _netHoverAnimating) _netRequestDraw(0);
}

// Monad: items with similarity below this are treated as "unrelated". They still animate to their peripheral
// ring position, but are rendered at 0 size and do not contribute to the tag list.
const MONAD_SIM_CUTOFF = isMobile ? 0.45 : 0.35;

/* Cap on similarity-based peripherals around a monad; linked items are always shown and don't count against it.
   Highest attraction wins. A dozen is about as many neighbours as the ring can show at a size worth looking at:
   past that the thumbnails are too small to read and the band too crowded to pick one out. */
const MONAD_VISIBLE_CAP = 12;

/* Floor at the other end. MONAD_SIM_CUTOFF is a judgement about what counts as related, and for a few items (an
   odd subject, an idiosyncratic set of tags) nothing clears it, leaving a centre with an empty ring and no way
   on from it. */
const MONAD_MIN_RELATED = 3;

// How far the zoom-0 ring is pushed toward even angular spacing: 0 keeps the raw UMAP directions, 1 spaces every
// visible peripheral equally.
const MONAD_ANGULAR_SPREAD = 0.8;

/* Where the reveal restarts from when one item is swapped for another. Entering from the map, --zoom climbs from wherever the camera was; on a swap it is already 1 and there is nothing to climb, so the new item's fields would simply be there. */
const MONAD_SWAP_REVEAL_FROM = 0;

/* The detail text's reveal, which rides an eased --zoom (see the per-field thresholds in the CSS) and is armed
   on entry by _armZoomEase. It waits: the image and title travel first, and the text arrives into a layout that
   has stopped moving. */
const MONAD_TEXT_REVEAL_DELAY_MS = Math.round(UI_TRANS_MS * 0.6);
const MONAD_TEXT_REVEAL_MS = 350;

/* Centre image in the detail view: a constant pixel AREA rather than a constant width or height, so a panorama
   and a portrait occupy the same amount of the window and the layout doesn't lurch as the reader moves between
   items. */
/* How far above the middle an item with no image rides, in rem, on top of its own anchor. */
const MONAD_NOIMG_LIFT_REM = 5;

const MONAD_CENTER_IMG_AREA_VH = 0.25;   // side of the equivalent square, as a fraction of window height
const MONAD_CENTER_IMG_MAX_H_VH = 0.25;  // height cap, same units: a quarter of the window, which a 4:3 image is already inside, so this binds only on the tall ones
const MONAD_CENTER_IMG_MAX_W_VW = 0.25;  // width cap, as a fraction of window width: the same quarter, binding only on the wide ones.

/** The centre image's --scale: the area box above, expressed against the item's own layout box, which is the same in every view. */
function _monadCenterImgScale(article) {
    if (!article) return 1;
    const natW = parseInt(article.style.getPropertyValue('--nat-w')) || 4;
    const natH = parseInt(article.style.getPropertyValue('--nat-h')) || 3;
    const box = _monadCenterImgBox(natW, natH, article.classList.contains('placeholder-img'));
    const layoutW = (parseFloat(article.style.getPropertyValue('--w')) || 16) * (Math.min(window.innerWidth, window.innerHeight) / 100);
    return layoutW > 0 ? (box.w / layoutW) : 1;
}

/** Visual box for the centre image at the given natural aspect. Falls back to 4:3 before real dimensions are
 *  known (the same fallback the map uses) so the box only ever changes if the true ratio differs. */
function _monadCenterImgBox(natW, natH, isPlaceholder) {
    if (isPlaceholder) {
        const e = _uiBtnWpx();
        return { w: e, h: e };
    }
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const aspect = (natW > 0 && natH > 0) ? (natW / natH) : (4 / 3);
    // Phones: the square the list and the grid already open a selected image into (min(width, height) less the edges, see --listThumbOpenMax) so the same item is the same size in all three views.
    if (isMobile) {
        const side = Math.min(vw, vh) - 2 * (_cssLengthPx(document.documentElement, '--edge') || 1.3 * _rootRemPx());
        let mh = Math.sqrt((side * side) / aspect);
        let mw = mh * aspect;
        if (mw > side) { mw = side; mh = mw / aspect; }
        if (mh > side) { mh = side; mw = mh * aspect; }
        return { w: mw, h: mh };
    }
    const area = (MONAD_CENTER_IMG_AREA_VH * vh) * (MONAD_CENTER_IMG_AREA_VH * vh);
    let h = Math.sqrt(area / aspect);
    let w = h * aspect;
    const maxH = MONAD_CENTER_IMG_MAX_H_VH * vh;
    if (h > maxH) { h = maxH; w = h * aspect; }
    const maxW = MONAD_CENTER_IMG_MAX_W_VW * vw;
    if (w > maxW) { w = maxW; h = w / aspect; }
    return { w, h };
}

/* ── The monad ring ───────────────────────────────────────────────────────────
   The monad has ONE state. The centre card (image, title, meta, description, tags, tags) holds the middle of the
   window and the related items ride a circular band around it: the inner radius clears the card, the outer stays
   inside the window, and the normalised similarity t picks the radius in between; most related closest. */
const MONAD_RING_INNER_V = 0.40;    // vertical clearance, as a fraction of window height, with the title at the middle of the window the card hangs BELOW centre, so this is sized against its bottom: a three-line title, five lines of description and tags
const MONAD_RING_INNER_H = 0.26;    // horizontal clearance, as a fraction of WINDOW width (well clear of the reading measure, which is what the middle needs to feel like a middle rather than a gap) sized against the 46ch reading measure and the 40ch title, whichever is wider: the card's text column is sized against the window (min(60ch, 90vw)) and doesn't narrow when the tag pane opens, so the clearance can't be measured against the visible width the way the outer edge is.
const MONAD_RING_EDGE = 0.025;      // clearance from the outer edge of the band to the window, as a fraction of min(vw, vh).
const MONAD_RING_MIN_BAND = 0.08;   // the band's depth, as a fraction of min(vw, vh). Written as a floor (clearance yields to it, never the other way round) but on any landscape window the clearances are already larger than the room available, so this is what actually sets the depth.
/* Ring thumbnails, relative to the size they had on the old zoom-0 ring. Raised 25% from 1.35 when the ring was
   capped at MONAD_VISIBLE_CAP: a dozen items sit far enough apart to be shown larger. Both tiers take it, so
   linked and merely similar keep their relative sizes. Mirrored in the CSS as --monad-ring-boost. */
const MONAD_RING_IMG_BOOST = 1.6875;
const MONAD_LINKED_LABEL_SCALE = 0.55; // --monad-h2-scale for linked items on the ring. Raised 30% from 0.42, in step with --monadLabelScale for the merely similar ones, so the two tiers keep their relative sizes.
/* Mirrored onto the root so the stylesheet can aim at the same number: hovering a merely similar item promotes its label to exactly the size a linked one carries at rest, and a second copy of the value written into the CSS would drift from this one. */
document.documentElement.style.setProperty('--monadLabelScaleLinked', String(MONAD_LINKED_LABEL_SCALE));

/** Map similarity (0..1) to a radial proportion (0..1).
 *  High similarity → small radius (close to center), low → large radius. */
function __monadRadialT(sim) {
    return 1 - _clamp01(sim || 0);
}

/** The band's two radii for the current window, plus the point it is centred on. imgHalfW is the centre image's
 *  half width, the only per-item term: a wide image pushes the inner radius out so the ring can't cross it. */
function __monadRingGeom(vw, vh, imgHalfW) {
    const u = Math.min(vw, vh);
    const edge = u * MONAD_RING_EDGE;
    const band = u * MONAD_RING_MIN_BAND;
    const cx = __mainCenterX();
    const cy = vh / 2;
    // Visible width excludes the desktop tag pane, so the band isn't laid out under it. On the left now, so it is the distance from the centre to the pane's inner edge that is short, not the one to the window's right edge.
    const visLeft = __mapTagOcclusionPx();
    const rOut = Math.max(40, Math.min(Math.min(cx - visLeft, vw - cx), cy) - edge);
    let rIn = Math.max(vw * MONAD_RING_INNER_H, vh * MONAD_RING_INNER_V, imgHalfW + edge);
    // Clearance yields to the band, never the other way round: an item that can't be
    // placed outside the card still has to be placed somewhere on screen.
    if (rIn > rOut - band) rIn = Math.max(0, rOut - band);
    return { cx, cy, rIn, rOut };
}

/* Height the description is about to gain, in px, for the frames between the expand being armed and the layout showing it. The centring reads the block's CURRENT height, so without this it would aim at the clamped stack and then have to correct. */

/** Open or close that state: the body class, the outward push, and the animation window they travel on. Idempotent.
 *  redraw=false for callers already inside update(), which would otherwise re-enter it. */

/** Radius at radial position t: 0 rides the inner circle, 1 the outer. */
function __monadRingRadius(g, t) {
    return g.rIn + _clamp01(t) * Math.max(0, g.rOut - g.rIn);
}

// Deferred cleanup when leaving monad → map: keep hi-res image src while the CSS transition runs,
// then downgrade/purge afterwards (prevents Safari/iOS from dropping the transform animation).
/** Drop any pending map-exit cleanup so it can't apply stale tiers/dimensions. */
function _cancelMapExitCleanup() {
    _cancel('map.exitCleanup', 'map.exitCleanupFrame');
}

/** After monad→map transitions, downgrade image tiers to avoid WebKit animation glitches. */
function _scheduleMapExitCleanup(oldCenterId) {
    _cancelMapExitCleanup();
    // Pure at-rest bookkeeping, so it runs after the move settles on the shared transition clock: at a flat 520ms it landed two thirds through the 750ms move and stalled it.
    const _run = () => {
        // Only apply if we're still in map mode (user may have switched again).
        if (viewMode !== 'map') return;

        // Downgrade a monad-tier image to 's' without a layout jump: snapshot the rendered aspect-ratio, swap, pin it back (rationale on the centre block below).
        const _downgradeTierPinned = (img) => {
            const _arBefore = getComputedStyle(img).aspectRatio;
            setImgTier(img, 's');
            if (_arBefore && _arBefore !== 'auto') {
                img.style.aspectRatio = _arBefore;
            }
        };

        /* monad-leaving, on everything that carried it. A class that outlives the transition it was added for is a remnant whatever the rule attached to it says, and this function is the at-rest bookkeeping pass for exactly that. */
        for (let i = 0, len = items.length; i < len; i++) {
            const it = items[i];
            if (!it) continue;
            const _lArt = it._article;
            if (_lArt) _lArt.classList.remove('monad-leaving');
        }

        // Previous linked items (and any other stray non-center 'l' tiers).
        for (let i = 0, len = items.length; i < len; i++) {
            const it = items[i];
            if (!it || (oldCenterId && it.id === oldCenterId)) continue;
            const art = it._article;
            const im = art ? art.querySelector('img') : null;
            if (!im || !im.dataset || im.dataset.tier !== 'l') continue;
            _downgradeTierPinned(im);
        }

        if (oldCenterId) {
            const a = _articleById(oldCenterId);
            const img = a ? a.querySelector('img') : null;
            if (img) {
                // Remove pinned dimensions set during monad→map transition.
                img.style.removeProperty('width');
                img.style.removeProperty('height');
                img.style.removeProperty('--scale');
                // setImgTier re-asserts the small tier's independently rounded dimensions, and Safari re-resolves the image's CSS size formula on that aspect-ratio change,
                // shifting it by a sub-pixel. Pinning the aspect-ratio lets the lower-res bitmap fill the same box.
                _downgradeTierPinned(img);
            }
        }
        // Remove --attraction left over from monad view (set to 0 during cleanup
        // to keep the peripheral scale formula valid during the transition).
        for (let i = 0, len = items.length; i < len; i++) {
            const art = items[i]._article;
            if (art) art.style.removeProperty('--attraction');
        }
        purgeHighResImages();
        // Safety net: re-establish src where a hidden class was removed without a follow-up setImgTier, and retry failed loads.
        _sweepImageHealth();
    };
    const _arm = () => {
        _after('map.exitCleanup', _run, _transitionRemainingMs(TRANS_TAIL_MS + 40));
    };
    if (document.hidden) _arm();
    else _onFrame('map.exitCleanupFrame', _arm);
}

 // Precomputed pairwise cos/sin for monad view
let _pairCos = null;
let _pairSin = null;
// Per-(centre, peripheral) radial t, normalised per centre: highest similarity 0, lowest 1. Hidden peripherals fall back to a global 1 - sim.
let _pairRadialT = null;

/** Approx. left-side occlusion in px caused by the desktop tag sidebar overlay (incl. the gap cover beside it), in __mainVW coordinates: i.e. measured from the left edge of the already-inset content box, which is where the map's own coordinates start. */
// Cached: occlusion depends only on window width and sidebar width/visibility, none of which move during a pan
// or wheel-zoom.
let _mapOccVal = -1;       // cached px; <0 means "needs recompute"
let _mapOccKeyW = -1;      // innerWidth at cache time
let _mapOccKeyTagW = -1;   // _tagSidebarW at cache time
function _invalidateMapOcc() { _mapOccVal = -1; }
function __mapTagOcclusionPx() {
    // Only relevant when the desktop tag sidebar is actually shown.
    if (!_tagSidebarEnabled || !_tagSidebarEnabled()) return 0;
    if (!document.body.classList.contains('has-tag-sidebar')) return 0;
    const el = _tagSidebarEl;
    if (!el) return 0;

    const vw = window.innerWidth || 0;
    if (_mapOccVal >= 0 && _mapOccKeyW === vw && _mapOccKeyTagW === _tagSidebarW) {
        return _mapOccVal;
    }

    let val = 0;
    const cs = getComputedStyle(el);
    if (!(cs.display === 'none' || cs.visibility === 'hidden')) {
        /* Layout geometry, deliberately not the painted rect. The pane rides the info panel by transform:
           translateX(var(--main-inset)), which animates on --infoTrans, while _mainInsetPx() reports the panel's new
           width the instant it is dismissed. */
        const w = el.offsetWidth || 0;
        const left = parseFloat(cs.left);
        if (w >= 8) val = Math.max(0, (isFinite(left) ? left : 0) + w);
    }
    _mapOccVal = val;
    _mapOccKeyW = vw;
    _mapOccKeyTagW = _tagSidebarW;
    return val;
}

function _applyTagFilterToMap() {
    _clearDeferredTagHideState();
    const t = (activeTag || '').trim();
    // On mobile setImgTier(img,'s') strips src for structurally-hidden articles, and removing the class doesn't re-trigger the setter: re-apply tier 's' to repopulate. No-op on desktop.
    const _restoreSrcIds = (isMobile && viewMode !== 'monad') ? [] : null;
    for (let i = 0, len = items.length; i < len; i++) {
        const it = items[i];
        const article = _ensureArticle(it);
        if (!article) continue;
        article.classList.remove('tag-transition-hide');
        const wasHidden = article.classList.contains('tag-filtered-out');
        if (!t) {
            article.classList.remove('tag-filtered-out');
            if (_restoreSrcIds && wasHidden) _restoreSrcIds.push(it.id);
        } else {
            const has = (it.tags && it.tags.includes(t));
            article.classList.toggle('tag-filtered-out', !has);
            if (_restoreSrcIds && wasHidden && has) _restoreSrcIds.push(it.id);
        }
    }
    // Breathing layout: rearrange visible items to fill space
    if (t) {
        _breatheLayout(function(it) { return it.tags && it.tags.includes(t); });
    } else {
        _resetBreathingLayout();
    }
    // Re-establish src for items whose tag-filtered-out class was just
    // removed (mobile only: see comment above).
    if (_restoreSrcIds && _restoreSrcIds.length > 0) {
        for (let i = 0; i < _restoreSrcIds.length; i++) {
            const a = _articleById(_restoreSrcIds[i]);
            const img = a ? a.querySelector('img') : null;
            if (img && !img.getAttribute('src')) setImgTier(img, 's');
        }
    }
}


/** Breathing layout: gently rearrange visible items to fill space evenly while preserving overall UMAP topology.
 *  @param {function} isVisible  predicate (item) => boolean */

/* ══ MAP LAYOUT & BREATHING ════════════════════════════════════════════════ */

function _breatheLayout(isVisible) {
    const visible = [];
    for (let i = 0; i < items.length; i++) {
        if (isVisible(items[i])) visible.push(i);
    }

    // Nothing filtered, or too few to matter: reset to UMAP positions. The forces below are density-derived, so near-full subsets degrade to identity anyway.
    if (visible.length === items.length || visible.length < 2) {
        for (let i = 0; i < items.length; i++) {
            items[i]._dx = items[i].umap_x;
            items[i]._dy = items[i].umap_y;
        }
        return;
    }

    const n = visible.length;

    // Collect original UMAP positions of visible items
    const origX = new Float32Array(n);
    const origY = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        origX[i] = items[visible[i]].umap_x;
        origY[i] = items[visible[i]].umap_y;
    }

    // Rescale to fill [0,1]: closes border gaps, preserves topology
    let minX = origX[0], maxX = origX[0], minY = origY[0], maxY = origY[0];
    for (let i = 1; i < n; i++) {
        if (origX[i] < minX) minX = origX[i];
        if (origX[i] > maxX) maxX = origX[i];
        if (origY[i] < minY) minY = origY[i];
        if (origY[i] > maxY) maxY = origY[i];
    }
    const rangeX = maxX - minX || 1e-6;
    const rangeY = maxY - minY || 1e-6;
    // Use uniform scale to preserve aspect ratio of the original layout
    const range = Math.max(rangeX, rangeY);
    const padX = (range - rangeX) / 2;
    const padY = (range - rangeY) / 2;

    // The sim frame is the unit square whatever the window's shape, so a filtered map keeps the proportions of the UMAP
    // layout it came from; the window only sets how far the result is contracted for the camera fit (below).
    const _bVw = __mainVW();
    const _bVh = window.innerHeight || 1;
    const _bInset = _bVw * 0.1 + __mapTagOcclusionPx();

    // Density-derived spread need: natural spacing scales with sqrt(1/n), so the ratio to the full map's spacing measures the freed space.
    // spreadNeed ramps 0 to 1 as that spacing grows from resting to double: a near-full subset gets ~0 and the forces approach identity.
    const spacingRatio = Math.sqrt(items.length / n);
    // Soft-start at 1.15: gains under ~15% count as no need (the resting layout already fits them); full effect once spacing would double.
    const spreadNeed = _clamp01((spacingRatio - 1.15) / 0.85);


    // Anchor positions (rescaled originals) and working positions
    const ax = new Float32Array(n);
    const ay = new Float32Array(n);
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        ax[i] = px[i] = (origX[i] - minX + padX) / range;
        ay[i] = py[i] = (origY[i] - minY + padY) / range;
    }

    // Force simulation parameters. Twelve iterations separate the items as well as twenty did (no image overlapping another
    // in the filtered maps measured); without the simulation a quarter to a half of them overlap. A phone, whose square
    // is packed tighter, gets a few more.
    const iterations = isMobile ? 15 : 12;
    // Anchor spring: how hard each item is held at its rescaled UMAP position, and so what keeps a dense subset's
    // clumping intact. It survives the camera fit (a uniform scale inverts contraction, not shape).
    const anchorStrength = 0.15;
    const centroidPull = 0.3;
    const repulsionStrength = 0.25;
    // Repulsion radius, the larger of two terms: (a) density: ~1.15x the expected nearest-neighbour spacing for n points in the unit square, capped at 0.25;
    // (b) visual footprint: what one item occupies on screen at the landing zoom zStar, via _fitVisualOverhangs, converted to sim units through the same reserve-capped span the contraction uses,
    // padded x1.25 for breathing room and capped at 0.6 so tiny subsets don't degenerate into a corner-pinned layout. zStar and the reserves are reused by the contraction below.
    const zStar = _subsetTargetZoom(n);
    const _resStar = _fitEdgeReservesPx(zStar, isVisible);
    const _oFoot = _fitVisualOverhangs(zStar, isVisible);
    const _footprintPx = Math.max(
        2 * Math.max(_oFoot.imgHalfW, _oFoot.titleHalfW),
        _oFoot.imgH + _oFoot.labelH);
    const _pxPerSimUnit = Math.max(1, Math.min(
        _fitSpanFor(n, _bVh, _resStar.y),
        _fitSpanFor(n, _bVw, _resStar.x)));
    const _footprintSim = Math.min(0.6, 1.25 * _footprintPx / _pxPerSimUnit);
    const repulsionDist = Math.max(0.02,
        Math.max(Math.min(0.25, 1.15 * Math.sqrt(1 / n)), _footprintSim));
    const boundaryStrength = 0.1;
    const boundaryDist = 0.1;
    const boundaryDistBottom = 0.05;
    const repulsionDist2 = repulsionDist * repulsionDist;
    const inv = 1 / repulsionDist;

    for (let iter = 0; iter < iterations; iter++) {
        const decay = 1 - iter / iterations;

        // Compute centroid of current positions
        let cx = 0, cy = 0;
        for (let i = 0; i < n; i++) { cx += px[i]; cy += py[i]; }
        cx /= n; cy /= n;
        // Rigid recentering by a uniform shift: a per-point pull toward the centroid would be a topology-changing contraction.
        const _shiftX = (0.5 - cx) * centroidPull;
        const _shiftY = (0.5 - cy) * centroidPull;

        // Spatial hash for neighbor lookup (overlap repulsion)
        const grid = new Map();
        for (let i = 0; i < n; i++) {
            const gx = Math.floor(px[i] * inv);
            const gy = Math.floor(py[i] * inv);
            const key = gx + ',' + gy;
            let bucket = grid.get(key);
            if (!bucket) grid.set(key, (bucket = []));
            bucket.push(i);
        }

        const dxs = new Float32Array(n);
        const dys = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            // Rigid recentering (uniform shift, preserves shape exactly)
            dxs[i] += _shiftX;
            dys[i] += _shiftY;

            // Anchor spring (pull back toward rescaled original)
            dxs[i] += (ax[i] - px[i]) * anchorStrength;
            dys[i] += (ay[i] - py[i]) * anchorStrength;

            // Soft boundary cushion: linear inward ramp from 0 at the zone's inner edge to boundaryStrength at the wall. Hard clamping made items slide tangentially and pile at the edges.
            if (px[i] < boundaryDist) {
                dxs[i] += boundaryStrength * (boundaryDist - px[i]) / boundaryDist;
            } else if (px[i] > 1 - boundaryDist) {
                dxs[i] -= boundaryStrength * (px[i] - (1 - boundaryDist)) / boundaryDist;
            }
            if (py[i] < boundaryDist) {
                dys[i] += boundaryStrength * (boundaryDist - py[i]) / boundaryDist;
            } else if (py[i] > 1 - boundaryDistBottom) {
                dys[i] -= boundaryStrength * (py[i] - (1 - boundaryDistBottom)) / boundaryDistBottom;
            }

            // Repulsion from nearby items (overlap prevention)
            const gx = Math.floor(px[i] * inv);
            const gy = Math.floor(py[i] * inv);
            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    const bucket = grid.get((gx + ox) + ',' + (gy + oy));
                    if (!bucket) continue;
                    for (let k = 0; k < bucket.length; k++) {
                        const j = bucket[k];
                        if (j <= i) continue;
                        let dx = px[j] - px[i];
                        let dy = py[j] - py[i];
                        let d2 = dx * dx + dy * dy;
                        if (d2 === 0) {
                            const jit = _coincidentJitter(i, j);
                            dx = jit.dx; dy = jit.dy; d2 = jit.d2;
                        }
                        if (d2 < repulsionDist2) {
                            const d = Math.sqrt(d2);
                            const overlap = repulsionDist - d;
                            const push = (overlap / (d || 1e-6)) * 0.5 * repulsionStrength;
                            dxs[i] -= dx * push;
                            dys[i] -= dy * push;
                            dxs[j] += dx * push;
                            dys[j] += dy * push;
                        }
                    }
                }
            }
        }

        // Apply forces with decay
        for (let i = 0; i < n; i++) {
            px[i] += dxs[i] * decay;
            py[i] += dys[i] * decay;
            // Hard clamp as a safety net; the cushion does the primary work, but step sizes can overshoot in dense regions.
            px[i] = Math.min(1, Math.max(0, px[i]));
            py[i] = Math.min(1, Math.max(0, py[i]));
        }
    }

    // Density-targeted contraction: instead of writing the sim frame back at full size (which left the camera fit
    // landing near zoom 0 and every filtered map reading as sparse), contract it uniformly toward the subset's UMAP
    // gravity centre, sized so the subsequent fit (same margin ramp, inverse formula) lands at _subsetTargetZoom
    // less the kOut slack.
    const baseSqFit = Math.min(_bVw - _bInset, _bVh);
    const sqStar = baseSqFit * (1 + zStar * _MAP_ZOOM_RANGE);
    const bScaleFit = 1 - 2 * 0.04;
    // Uniform frame scale: the binding axis of the contracted box fits the viewport at zStar exactly (same reserve-capped spans as the camera fits), never expanding past the natural frame.
    const unit = Math.min(1,
        _fitSpanFor(n, _bVw, _resStar.x) / (sqStar * bScaleFit),
        _fitSpanFor(n, _bVh, _resStar.y) / (sqStar * bScaleFit));
    // Subset gravity centre in UMAP space, clamped to keep the contracted box inside the square AND far enough from
    // its edges that clampPan can centre it.
    let _gcU = 0, _gcV = 0;
    for (let i = 0; i < n; i++) { _gcU += origX[i]; _gcV += origY[i]; }
    _gcU /= n; _gcV /= n;
    const _halfU = Math.min(0.5, unit / 2);
    const _halfV = Math.min(0.5, unit / 2);
    const _bufPx = 0.04 * sqStar; // render mapping: X = (0.04 + u·bScale)·sq
    const _edgeU = (window.innerWidth / 2 - _bufPx) / (bScaleFit * sqStar);
    const _edgeV = (window.innerHeight / 2 - _bufPx) / (bScaleFit * sqStar);
    const _loU = Math.max(_halfU, _edgeU), _hiU = Math.min(1 - _halfU, 1 - _edgeU);
    const _loV = Math.max(_halfV, _edgeV), _hiV = Math.min(1 - _halfV, 1 - _edgeV);
    _gcU = (_loU <= _hiU) ? Math.max(_loU, Math.min(_hiU, _gcU)) : 0.5;
    _gcV = (_loV <= _hiV) ? Math.max(_loV, Math.min(_hiV, _gcV)) : 0.5;
    // Contraction slack: 0 inverts exactly and lands the fit on zStar; a small positive value leaves the frame a few
    // percent wider, trading item size for breathing room.
    const _BREATHE_CONTRACT_SLACK = 0.08;
    const kOut = Math.min(1,
        (1 + (unit - 1) * spreadNeed) * (1 + _BREATHE_CONTRACT_SLACK)); // lerp(1 → unit), loosened
    const cxOut = 0.5 + (_gcU - 0.5) * spreadNeed; // lerp(frame center → gravity center)
    const cyOut = 0.5 + (_gcV - 0.5) * spreadNeed;

    // Write display positions
    for (let i = 0; i < n; i++) {
        const fx = cxOut + (px[i] - 0.5) * kOut;
        const fy = cyOut + (py[i] - 0.5) * kOut;
        items[visible[i]]._dx = Math.round(fx * 10000) / 10000;
        items[visible[i]]._dy = Math.round(fy * 10000) / 10000;
    }
    // Non-visible items keep their original UMAP positions
    for (let i = 0; i < items.length; i++) {
        if (!isVisible(items[i])) {
            items[i]._dx = items[i].umap_x;
            items[i]._dy = items[i].umap_y;
        }
    }
}

/** Reset all display positions to original UMAP coordinates. */
function _resetBreathingLayout() {
    for (let i = 0; i < items.length; i++) {
        items[i]._dx = items[i].umap_x;
        items[i]._dy = items[i].umap_y;
    }
}


/* ══ MAP GEOMETRY (ZOOM, SCALE, FITS) ══════════════════════════════════════
   Everything that turns (zoom, viewport, subset size) into screen geometry: the
   item-scale and label-boost ramps, the reveal thresholds they cross, the camera-fit
   spans and edge reserves, and the density-derived target zoom a filtered subset is
   fitted to. It touches no DOM and mutates no state; from outside itself it reads only
   zoom (as _computeItemScale's default argument), isMobile, the viewport dimensions,
   items/imageMeta and getComputedStyle (both in _fitVisualOverhangs).

   Keeping it in one piece matters because _breatheLayout's contraction and
   _fitVisibleBounds' camera fit are inverses of each other THROUGH these functions: if
   the two sides ever evaluate different margins, reserves or ramps, a filtered subset
   stops landing on the zoom it was contracted for.
   ═════════════════════════════════════════════════════════════════════════ */

// Map zoom depth: zoom in [0,1] grows the layout square by (1 + zoom * _MAP_ZOOM_RANGE).
const _MAP_ZOOM_RANGE = 30;

// Mobile gets a higher maxS multiplier so users can zoom in deeper; minS is unified at 0.03, giving effective maxS 0.304 mobile / 0.135 desktop. Per-platform because min and max moved by different factors. The desktop cap keeps a fully zoomed thumbnail within the size of its inline small image (138px median on its long side), which is all the map shows since image files load only for a selection.
const _MAX_S_MUL = isMobile ? 10.125 : 4.5;
// How fast the labels grow with the items (the label boost's slope, see _computeLabelBoost). Desktop's is steeper
// so that, with its smaller images, a fully zoomed title still reads large: 25% above mobile's at zoom 1.
const _LABEL_BOOST_SLOPE = isMobile ? 1.2 : 1.7;
// Deep-half growth rates (zoom 0.5 to 1); everything at or below 0.5 is anchored by the fit machinery and
// untouched.
const _DEEP_SCALE_RATE = 0.8;
const _DEEP_BOOST_RATE = 0.3;

function _computeItemScale(z = zoom) {
    const minS = 0.03;
    const maxS = minS * _MAX_S_MUL;

    // Pure geometric semantic zoom: item scale is a function of zoom only. The ramp reaches maxS at 0.5 and
    // continues at _DEEP_SCALE_RATE to ~1.8x maxS at zoom 1, where the large tier takes over.
    z = _clamp01(z);
    if (z <= 0.5) return minS + (maxS - minS) * z * 2;
    return maxS + (maxS - minS) * (z - 0.5) * 2 * _DEEP_SCALE_RATE;
}

function _computeLabelBoost(itemScale) {
    // Map item scale to label boost linearly: minS (0.03, matching _computeItemScale) gives 1.0, the per-platform maxS
    // gives 1 + _LABEL_BOOST_SLOPE (2.2 on mobile, 2.7 on desktop).
    const minS = 0.03;
    const maxS = minS * _MAX_S_MUL;
    const t = (itemScale - minS) / (maxS - minS);
    if (t <= 1) return 1 + _LABEL_BOOST_SLOPE * t;
    // Past maxS (deep zoom): heavily reduced slope: the deep half reveals
    // additional label lines rather than growing the font.
    return 1 + _LABEL_BOOST_SLOPE + _LABEL_BOOST_SLOPE * (t - 1) * _DEEP_BOOST_RATE;
}

// Reveal thresholds on the --zoom scale, fixed points rather than the old viewport item count (which shifted
// with window size and local density). The ladder reads: images (see below), 0.2 titles, 0.3 subtitle, 0.45
// authors, 0.55 large tier, 0.65 source.

// The one rung that differs by device. Both sides of the trade changed when the small tier moved inline: a
// reveal costs no requests, only decode and resident bitmap memory, which is a desktop nuisance and a mobile
// ceiling. desktop 0.05: the map opens at zoom 0, so 0.1 meant a tenth of the way up before the first real
// thumbnail.
const STUB_REVEAL_ZOOM = isMobile ? 0.15 : 0.05;
const LABEL_REVEAL_ZOOM = 0.2;
// Below this the subtitle/authors/source nodes don't exist at all (see _ensureLabelStack). Set just under LABEL_REVEAL_ZOOM so they are in the DOM before anything can reveal them: created at their own crossing they would pop in at full opacity.
const LABEL_STACK_ZOOM = 0.18;
// The three rungs below the title, mirroring --map-rung-sub / --map-rung-authors / --map-rung-source in :root;
// keep both sides in step.
const LABEL_SUB_REVEAL_ZOOM = 0.3;
const LABEL_AUTHORS_REVEAL_ZOOM = 0.45;
const LABEL_SOURCE_REVEAL_ZOOM = 0.65;

/** A rung of the label ladder for the view on screen. On a filtered map (a search or a tag) the camera starts at the
 *  subset's fitted zoom rather than at 0, so the fixed rungs came in within a few wheel steps of it; there they are
 *  measured against the range left above the fit instead. The title's own rung (LABEL_REVEAL_ZOOM) stays fixed, the
 *  unfiltered map (fit 0) is unchanged, and the monad's detail, which shares the CSS rungs, keeps the base values. */
function _labelRung(base) {
    if (viewMode !== 'map' && viewMode !== 'search') return base;
    return base + getMinZoom() * (1 - base);
}

/** Write the three rungs to the CSS (--map-rung-*) when they change; without a filter the stylesheet's own values
 *  stand. Called from update(). */
let _labelRungsKey = '';
function _syncLabelRungs() {
    const sub = _labelRung(LABEL_SUB_REVEAL_ZOOM);
    const authors = _labelRung(LABEL_AUTHORS_REVEAL_ZOOM);
    const source = _labelRung(LABEL_SOURCE_REVEAL_ZOOM);
    const shifted = sub !== LABEL_SUB_REVEAL_ZOOM;
    const key = shifted ? sub.toFixed(3) + ',' + authors.toFixed(3) + ',' + source.toFixed(3) : '';
    if (key === _labelRungsKey) return;
    _labelRungsKey = key;
    const de = document.documentElement.style;
    if (shifted) {
        de.setProperty('--map-rung-sub', sub.toFixed(3));
        de.setProperty('--map-rung-authors', authors.toFixed(3));
        de.setProperty('--map-rung-source', source.toFixed(3));
    } else {
        de.removeProperty('--map-rung-sub');
        de.removeProperty('--map-rung-authors');
        de.removeProperty('--map-rung-source');
    }
}

/** Fill fraction of the viewport a fitted subset's bounding box should span; fewer items get more padding so they
 *  don't cluster at the edges around an empty centre. */
function _fitMarginForCount(count) {
    // Under the density-targeted contraction this is a pure spacing knob: the breathing layout inverts the fit formula with the same margin, so widening it spreads the subset over a bigger box at unchanged item size.
    if (count <= 5) return 0.70;
    if (count >= 20) return 0.90;
    return 0.70 + 0.20 * (count - 5) / 15;
}

/** Usable span in px for a fitted bounding box along one viewport axis: the count-based margin fraction, capped
 *  so an absolute edge reserve stays free on each side. */
const _FIT_EDGE_RESERVE_X = 150;
const _FIT_EDGE_RESERVE_Y = 90;
// Ceiling on what one side's reserve may claim, as a fraction of the axis extent.
const _FIT_EDGE_RESERVE_MAX_FRAC = 0.25;
/* Phones get a lower cap than 0.25 for a reason specific to them: the root font is fluid, so 1rem is ~3% of a
   390px viewport against ~1.1% on a 1440px desktop, and a title at its 40ch cap is roughly HALF the phone's
   screen width. */
const _FIT_EDGE_RESERVE_MAX_FRAC_MOBILE = 0.15;
// Read at call time, not module-evaluation time: isMobile is declared later.
function _fitEdgeReserveMaxFrac() {
    return isMobile ? _FIT_EDGE_RESERVE_MAX_FRAC_MOBILE : _FIT_EDGE_RESERVE_MAX_FRAC;
}
function _fitSpanFor(count, extentPx, reservePx) {
    // Small viewports keep a proportional buffer rather than an unpayable one.
    const res = Math.min(reservePx, extentPx * _fitEdgeReserveMaxFrac());
    return Math.max(extentPx * 0.3,
        Math.min(_fitMarginForCount(count) * extentPx, extentPx - 2 * res));
}

/** Visual overhangs (px) of a fitted subset around its ANCHOR bounding box at landing zoom z.
 *  - imgH: max visual image height in the subset, from the --w area normalisation at the zoom's item scale
 *  (placeholders at half size), falling back to 4:3 when imageMeta is missing.
 *  - labelH: rendered height of whatever of the stack is revealed at z, rung by rung on the same unscaled offsets
 *  the CSS is built from; title 3.3rem, subtitle 2.9rem, authors and source ~2rem each. */
function _fitVisualOverhangs(z, isVisible) {
    const minS = 0.03, maxS = 0.03 * _MAX_S_MUL;
    const zc = _clamp01(z);
    // Mirrors _computeItemScale exactly (incl. the deep-half kink, moot at
    // fit zooms which cap at 0.5).
    const s = zc <= 0.5
        ? minS + (maxS - minS) * zc * 2
        : maxS + (maxS - minS) * (zc - 0.5) * 2 * _DEEP_SCALE_RATE;
    const vminPx = Math.min(window.innerWidth, window.innerHeight) / 100;
    let maxHVmin = 0, maxWVmin = 0;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!isVisible(it)) continue;
        const meta = imageMeta[it.id];
        let hVmin, wVmin;
        if (meta && meta.nw > 0 && meta.nh > 0) {
            // --w area normalization: w = 40·sqrt(nw/nh) vmin, h = w·nh/nw.
            wVmin = 40 * Math.sqrt(meta.nw / meta.nh);
            hVmin = 40 * Math.sqrt(meta.nh / meta.nw);
        } else {
            wVmin = 40 * Math.sqrt(4 / 3);
            hVmin = 40 * Math.sqrt(3 / 4);
        }
        if (it._isPlaceholderImg) { hVmin *= 0.5; wVmin *= 0.5; }
        if (hVmin > maxHVmin) maxHVmin = hVmin;
        if (wVmin > maxWVmin) maxWVmin = wVmin;
    }
    const imgH = maxHVmin * vminPx * s;
    const imgHalfW = maxWVmin * vminPx * s / 2;
    let labelH = 0, titleHalfW = 0;
    if (z > LABEL_REVEAL_ZOOM) {
        const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const h2Scale = 0.25 * _computeLabelBoost(s);
        let stackRem = 3.3;
        if (zc > _labelRung(LABEL_SUB_REVEAL_ZOOM)) stackRem += 2.9;
        if (zc > _labelRung(LABEL_AUTHORS_REVEAL_ZOOM)) stackRem += 2.1;
        if (zc > _labelRung(LABEL_SOURCE_REVEAL_ZOOM)) stackRem += 2.0;
        labelH = stackRem * remPx * h2Scale;
        // Title width cap: 35ch at 2rem is about 35 * 1.1rem unscaled. Real titles are often shorter, so this errs toward more edge room, never less.
        titleHalfW = 35 * 1.1 * remPx * h2Scale / 2;
    }
    return { imgH: imgH, labelH: labelH, imgHalfW: imgHalfW, titleHalfW: titleHalfW };
}

/** Downward and lateral extent (px) of a map item's LABEL STACK around its anchor at the current live label
 *  scale. Same geometry as _fitVisualOverhangs, but evaluated at what is on screen right now, because this feeds
 *  the per-frame cull rather than a one-off fit. */
const _MAP_LABEL_STACK_REM = 10.4;
const _MAP_LABEL_WIDEST_CH = 45;
let _mapLabelExtCache = null;
let _mapLabelExtKey = '';
function _mapLabelExtentsPx() {
    // Resting --map-label-scale is 0.25 * --subset-label-boost. A hovered item is on screen by definition, so the resting value is the right one for a cull margin.
    const boost = (_lastLabelBoostNum > 0) ? _lastLabelBoostNum : 1;
    const scale = 0.25 * boost;
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const key = scale.toFixed(3) + '|' + remPx.toFixed(2);
    if (_mapLabelExtCache && _mapLabelExtKey === key) return _mapLabelExtCache;
    _mapLabelExtKey = key;
    _mapLabelExtCache = {
        down: _MAP_LABEL_STACK_REM * remPx * scale,
        half: _MAP_LABEL_WIDEST_CH * 1.1 * remPx * scale / 2
    };
    return _mapLabelExtCache;
}

/** Zoom-dependent edge reserves for the camera fits: the base constants plus the subset's visual extents beyond
 *  its anchors at zHint; laterally the wider of image and title half-width, vertically half the
 *  image-above/label-below sum. */
function _fitEdgeReservesPx(zHint, isVisible) {
    const o = _fitVisualOverhangs(zHint, isVisible);
    return {
        x: _FIT_EDGE_RESERVE_X + Math.max(o.imgHalfW, o.titleHalfW),
        y: _FIT_EDGE_RESERVE_Y + (o.imgH + o.labelH) / 2
    };
}

/** Downward panY bias that re-centres the fitted subset's VISUAL block: half the overhang asymmetry, clamped so
 *  both visual edges keep an 8px pad inside the viewport. */
function _fitVerticalBiasPx(z, isVisible, realizedSpanYPx, vh) {
    const o = _fitVisualOverhangs(z, isVisible);
    const freeHalf = Math.max(0, (vh - realizedSpanYPx) / 2);
    const bias = (o.imgH - o.labelH) / 2;
    const biasMax = freeHalf - o.labelH - 8;
    const biasMin = o.imgH - freeHalf + 8;
    return Math.max(biasMin, Math.min(biasMax, bias));
}

/** Density-derived target zoom for a subset of n items: the zoom whose purely geometric item scale lets n items
 *  cover about FILL of the window area. On a phone the budget is set against the square the filtered layout
 *  actually fills (as wide as the window), not the whole portrait window, which packed it about twice as tight. */
function _subsetTargetZoom(n) {
    if (isMobile) {
        const vw = __mainVW(), vh = window.innerHeight;
        const zWindow = _subsetTargetZoomFor(n, vw * vh);
        const zSquare = _subsetTargetZoomFor(n, Math.min(vw, vh) ** 2);
        return Math.max(zSquare, Math.min(zWindow, STUB_REVEAL_ZOOM + 0.01));
    }
    return _subsetTargetZoomFor(n, __mainVW() * window.innerHeight);
}
function _subsetTargetZoomFor(n, areaPx) {
    const vminPx = Math.min(window.innerWidth, window.innerHeight) / 100; // px per vmin unit
    const minS = 0.03, maxS = 0.03 * _MAX_S_MUL;
    // FILL budgets only the thumbnails, but each item also carries a title and, past the deep boundary, the
    // subtitle/authors/source stack, so the real footprint is a multiple of the image.
    // Window-area fraction the subset's thumbnails should cover. Lowered from 0.03 when the desktop max item scale
    // dropped (7.875 to 4.5): the target is an item scale, so smaller images at every zoom meant a higher landing
    // zoom and a harder contraction toward the centre for the same coverage. 0.015 lands near the old zooms and a
    // touch softer (the subset keeps ~15-40% of its UMAP spread, against ~10-20% at 0.03). A phone's max scale never
    // changed, so it keeps 0.03.
    const FILL = isMobile ? 0.03 : 0.015;
    const ITEM_W = 40;   // typical unscaled item width in vmin (--w is area-normalized)
    const targetS = Math.sqrt(FILL * areaPx / Math.max(1, n)) / (ITEM_W * vminPx);
    const s = Math.min(maxS * 2, Math.max(minS, targetS));
    const z = (s - minS) / ((maxS - minS) * 2);
    // Cap at 0.5, just below the deep half where the staggered subtitle/authors/source reveal begins and label widths outgrow thumbnail widths: a filtered fit shows the subset large but uncluttered.
    return Math.max(0.05, Math.min(0.5, z));
}

/** Fit the map camera to the bounding box of visible (breathing) items. */
function _fitVisibleBounds(isVisible, animate) {
    if (viewMode !== 'map' && viewMode !== 'search') return;
    if (viewMode === 'search') switchToMapView(false, false);

    const buffer = 0.04;
    const bScale = 1 - 2 * buffer;
    const vw = __mainVW();
    const vh = window.innerHeight;
    const padLR = vw * 0.05;
    const hInset = padLR * 2 + __mapTagOcclusionPx();
    const baseSq = Math.min(vw - hInset, vh);

    // Compute bounding box in _dx/_dy space
    let minDx = Infinity, maxDx = -Infinity, minDy = Infinity, maxDy = -Infinity;
    let count = 0;
    for (let i = 0; i < items.length; i++) {
        if (!isVisible(items[i])) continue;
        const dx = items[i]._dx;
        const dy = items[i]._dy;
        if (dx < minDx) minDx = dx;
        if (dx > maxDx) maxDx = dx;
        if (dy < minDy) minDy = dy;
        if (dy > maxDy) maxDy = dy;
        count++;
    }
    if (count < 1) return;

    // Single item (or degenerate bbox): center it at the density-derived
    // zoom so a lone match is shown detailed rather than at overview scale.
    if (count === 1 || (maxDx - minDx < 0.001 && maxDy - minDy < 0.001)) {
        const cx = (minDx + maxDx) / 2;
        const cy = (minDy + maxDy) / 2;
        if (animate) triggerAnimation();
        zoom = _subsetTargetZoom(count);
        _subsetFitZoom = zoom;
        const sqOne = baseSq * (1 + zoom * _MAP_ZOOM_RANGE);
        panX = sqOne * (0.5 - buffer - cx * bScale);
        // Anchor is the image bottom: shift down so the visual block
        // (image above, label below) is what gets centered.
        panY = sqOne * (0.5 - buffer - cy * bScale)
            + _fitVerticalBiasPx(zoom, isVisible, 0, vh);
        clampPan();
        update();
        return;
    }

    // Target fill of the viewport by the bbox: 50% at 5 items or fewer, ramping to 75% at 20 or more, so a handful of items don't cluster at the edges around an empty centre.
    const dxRange = maxDx - minDx;
    const dyRange = maxDy - minDy;
    // Reserves at the density target zoom: the same zHint the breathing
    // contraction used, keeping its inversion exact (see _fitEdgeReservesPx).
    const _res = _fitEdgeReservesPx(_subsetTargetZoom(count), isVisible);
    const targetSqX = (dxRange > 0) ? _fitSpanFor(count, vw, _res.x) / (dxRange * bScale) : baseSq;
    const targetSqY = (dyRange > 0) ? _fitSpanFor(count, vh, _res.y) / (dyRange * bScale) : baseSq;
    const targetSq = Math.min(targetSqX, targetSqY);

    // Convert to a zoom level.
    const targetZoom = Math.max(0, Math.min(1.5, (targetSq / baseSq - 1) / _MAP_ZOOM_RANGE));
    _subsetFitZoom = targetZoom;
    const sq = baseSq * (1 + targetZoom * _MAP_ZOOM_RANGE);

    // Pan to center the bbox
    const cx = (minDx + maxDx) / 2;
    const cy = (minDy + maxDy) / 2;

    if (animate) triggerAnimation();
    zoom = targetZoom;
    panX = sq * (0.5 - buffer - cx * bScale);
    // Centre the visual block, not the anchor box: anchors sit at image bottoms, so the box is top-heavy by the image overhang. Bias panY down by half that asymmetry (see _fitVerticalBiasPx).
    panY = sq * (0.5 - buffer - cy * bScale)
        + _fitVerticalBiasPx(targetZoom, isVisible, dyRange * bScale * sq, vh);
    clampPan();
    update();
}

// Viewport-count-based image and label scaling


// Last-written values for the three :root custom properties below. They are registered INHERITING @properties,
// so each write invalidates the computed style of every article and image that reads them: a whole-tree
// recompute.
let _lastItemScaleStr = '';
let _lastItemScaleNum = -1;
let _lastLabelBoostStr = '';
let _lastLabelBoostNum = -1;
let _lastLabelOpacityStr = '';
let _lastLabelOpacityNum = -1;
// Holds the release of the lagging border denominator (--item-scale-border).
// Interaction step sizes: small enough to be imperceptible mid-gesture.
const _ITEM_SCALE_STEP = 0.001;
const _LABEL_BOOST_STEP = 0.01;
const _LABEL_OPACITY_STEP = 0.03;

function _setViewportScale() {
    const s = _computeItemScale();
    const lb = _computeLabelBoost(s);
    // Label opacity is a single binary crossing at LABEL_REVEAL_ZOOM; the visible fade comes from the elements' own
    // 0.33s transitions.
    const lo = (zoom > LABEL_REVEAL_ZOOM) ? 0.7 : 0;

    const de = document.documentElement.style;
    const interacting = isInteracting;

    const sStr = s.toFixed(4);
    if (sStr !== _lastItemScaleStr
        && (!interacting || _lastItemScaleNum < 0 || Math.abs(s - _lastItemScaleNum) >= _ITEM_SCALE_STEP)) {
        // Delayed border thickening: the border is calc(base / --item-scale * 1.5rem), so when --item-scale drops in one
        // step during an animated transition it flashes thick while the transform is still animating down.
        const _prevStr = _lastItemScaleStr;
        const _meaningfulDrop = _lastItemScaleNum > 0 && s < _lastItemScaleNum * 0.92;
        const _inViewTransition = document.body.classList.contains('animated')
            && !document.body.classList.contains('zoom-animating');
        if (!interacting && _meaningfulDrop && _inViewTransition && _prevStr) {
            de.setProperty('--item-scale-border', _prevStr);
            _cancel('render.borderLag');
            _after('render.borderLag', function() {
                document.documentElement.style.removeProperty('--item-scale-border');
            }, UI_TRANS_MS);
        } else if (interacting || (_lastItemScaleNum > 0 && s > _lastItemScaleNum * 1.02)) {
            // Live interaction, or a meaningful RAISE (images growing): never keep
            // a stale denominator: let the border track --item-scale immediately.
            _cancel('render.borderLag');
            document.documentElement.style.removeProperty('--item-scale-border');
        }

        de.setProperty('--item-scale', sStr);
        // The image-centre offsets the edges add to each anchor scale with the item: re-seed them.
        _netBumpOffsetEpoch();
        _lastItemScaleStr = sStr;
        _lastItemScaleNum = s;
    }

    const lbStr = lb.toFixed(3);
    if (lbStr !== _lastLabelBoostStr
        && (!interacting || _lastLabelBoostNum < 0 || Math.abs(lb - _lastLabelBoostNum) >= _LABEL_BOOST_STEP)) {
        de.setProperty('--subset-label-boost', lbStr);
        _lastLabelBoostStr = lbStr;
        _lastLabelBoostNum = lb;
    }

    const loStr = lo.toFixed(2);
    if (loStr !== _lastLabelOpacityStr
        && (!interacting || _lastLabelOpacityNum < 0 || Math.abs(lo - _lastLabelOpacityNum) >= _LABEL_OPACITY_STEP)) {
        de.setProperty('--label-opacity', loStr);
        _lastLabelOpacityStr = loStr;
        _lastLabelOpacityNum = lo;
    }

    // Stub mode: reveal real thumbs for visible items past STUB_REVEAL_ZOOM, which leads the label reveal.
    _stubReconcileFromViewport();
}

// Compute attraction (similarity) matrix based on shared tags
function computeAttraction(items) {
    // Output shape unchanged: enhanced[a][b] = min(1, jaccard(a,b) + 0.1 * sum_k jaccard(a,k)*jaccard(k,b)), diagonal 1.
    const N = items.length;
    const allTags = [...new Set(items.flatMap(item => item.tags))];
    const tagIndex = Object.fromEntries(allTags.map((tag, i) => [tag, i]));

    // Sparse tag vectors: sorted Int32Array of tag indices per item.
    const sv = items.map(item => {
        const ids = [...new Set(item.tags.map(t => tagIndex[t]))];
        ids.sort((a, b) => a - b);
        return Int32Array.from(ids);
    });

    const similarity = _sortedOverlapRatio;

    // Direct similarity, stored densely for output plus per-item adjacency lists of the nonzero neighbours, so the two-hop pass skips zero pairs: O(N^3) becomes roughly O(N * k^2).
    const dir = new Float64Array(N * N);
    const nbr = Array.from({ length: N }, () => []); // [neighbourIndex, sim]
    for (let i = 0; i < N; i++) {
        dir[i * N + i] = 1; // diagonal forced to 1 (matches original output)
        const vi = sv[i];
        for (let j = i + 1; j < N; j++) {
            const s = similarity(vi, sv[j]);
            if (s > 0) {
                dir[i * N + j] = s;
                dir[j * N + i] = s;
                nbr[i].push(j, s); // flat [idx, sim, idx, sim, ...] to avoid sub-arrays
                nbr[j].push(i, s);
            }
        }
    }

    // enhanced = direct + 0.1 * (direct · direct), only over nonzero paths.
    const enh = new Float64Array(N * N);
    enh.set(dir);
    for (let i = 0; i < N; i++) {
        const ni = nbr[i];
        const base = i * N;
        for (let a = 0; a < ni.length; a += 2) {
            const k = ni[a];
            const w = 0.1 * ni[a + 1]; // 0.1 * dir[i][k]
            const nk = nbr[k];
            for (let b = 0; b < nk.length; b += 2) {
                const j = nk[b];
                if (j === i) continue;
                enh[base + j] += w * nk[b + 1]; // dir[k][j]
            }
        }
    }

    // Materialize to the id-keyed object-of-objects the rest of the app expects.
    const enhanced = {};
    for (let i = 0; i < N; i++) {
        const row = {};
        const base = i * N;
        const idi = items[i].id;
        for (let j = 0; j < N; j++) {
            row[items[j].id] = (i === j) ? 1 : Math.min(1, enh[base + j]);
        }
        enhanced[idi] = row;
    }
    return enhanced;
}

// Assign angular positions based on UMAP coordinates
function assignAngularPositions(items) {
    const centerX = 0.5;
    const centerY = 0.5;
    
    // Loop over all items.
    for (const item of items) {
        const dx = item.umap_x - centerX;
        const dy = item.umap_y - centerY;
        item.baseAngle = Math.atan2(dy, dx);
    }
}

// Get angle from selected to item using direct UMAP positions
function getRelativeAngle(item, selectedItem) {
    const dx = item.umap_x - selectedItem.umap_x;
    const dy = item.umap_y - selectedItem.umap_y;
    return Math.atan2(dy, dx);
}

let isInteracting = false;

/** Begin interaction. */
let _suppressBeginInteractionOnce = false;

function beginInteraction() {
    if (_suppressBeginInteractionOnce) {
        _suppressBeginInteractionOnce = false;
        return;
    }
    // Skip when 'animated' is active: we want CSS transitions then,
    // and notransition has higher specificity so it would kill them
    if (document.body.classList.contains('animated')) return;
    // Skip during CSS-driven zoom animation
    if (_zoomAnimating) return;
    if (!isInteracting) {
        isInteracting = true;
        document.body.classList.add('notransition');
    }
    _cancel('render.notransitionClass');
    _after('render.notransitionClass', function(){
        isInteracting = false;
        document.body.classList.remove('notransition');
        // Clear any stale inline --scale values (e.g. from animateZoomTo or monad view)
        // so the CSS variable (--item-scale) chain resumes for transitions.
        if (viewMode === 'map') {
            for (let i = 0, len = items.length; i < len; i++) {
                const img = items[i]._article && items[i]._article.firstElementChild;
                if (img && img.tagName === 'IMG') img.style.removeProperty('--scale');
            }
        }
        // Interaction over: write the exact unthrottled item-scale and label values, in case the gesture ended a sub-step short. _setViewportScale doesn't call beginInteraction, so this doesn't re-arm the interaction state.
        if (viewMode === 'map' || viewMode === 'search') {
            _setViewportScale();
            _sweepLabelStacks();
        }
    }, 200);
}

// Direct update: no rAF throttling needed

// rAF-coalesced update() for high-rate input (mousemove, touchmove, wheel), which fires well above vsync: a
// 120Hz mouse would otherwise iterate all items ~3x per frame for no visual gain.
function _scheduleUpdate() {
    if (_pending('render.update')) return;
    _onFrame('render.update', () => {
        update();
    });
}

// Track previous states to avoid redundant class toggles
/** True while the monad is at, or animating toward, full zoom. During CSS-driven zoom this keys off the TARGET so the html fixed-to-relative switch doesn't happen abruptly at the very end, which caused a visible jump on click-zoom. */
function _isMonadZoomedIn() {
    if (viewMode !== 'monad') return false;
    // A phone's detail has one state: always the full page, scrolled as one.
    if (isMobile) return true;
    return (_zoomAnimating && typeof _zoomAnimatingTarget === 'number')
        ? (_zoomAnimatingTarget >= 0.99)
        : (zoom >= 0.99);
}

/** Keep body.monad-detail-visible in step with the zoom (tags/text/links). The guard reads the CLASS, not a cached flag. */
function _syncMonadDetailVisible() {
    const detailVisible = viewMode === 'monad' && zoom >= 0.3;
    if (detailVisible === document.body.classList.contains('monad-detail-visible')) return;
    document.body.classList.toggle('monad-detail-visible', detailVisible);
}

/** Reset every scroll container: the monad's scroll must not survive zoom-out. */
function _resetAllScrollTops() {
    // All three scroll roots: iOS Safari, desktop Safari and Chromium each treat them differently. Guarded because scrollTo can throw in embedded contexts and none of this is worth an exception.
    try {
        window.scrollTo(0, 0);
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
    } catch (e) { /* noop */ }
}

let _prevLabelsHidden = false;
let _prevZoomVal = -1;

/** Keep the URL hash on the selected item. Uses replaceState, so a correction inside a monad doesn't clutter history. */
function _syncMonadHash() {
    if (viewMode !== 'monad' || !selectedMonadId) return;
    // A detail opened from the list or the grid keeps that view in the address: it is the only record of where the close goes (see _detailReturnHash).
    const a = _parseAddress();
    if (a.i === selectedMonadId) return;
    const q = (searchQuery || '').trim(), t = (activeTag || '').trim();
    const desired = _formatAddress({ view: 'map', ...((q.length >= 2) ? { q } : (t ? { t } : {})), i: selectedMonadId, image: a.image });
    if (window.location.hash !== desired) history.replaceState(null, '', desired);
}

/** Force a synchronous style and layout pass (so a class change is committed before the next one), by reading a layout property. */
function _reflow(el = document.body) {
    return el.offsetHeight;
}

/** Recompute derived state and apply DOM updates/transforms for the active view. */
function update() {
    // A phone's detail sits at zoom 1: an interrupted zoom animation can't leave it half open (text half faded, page not scrolling).
    if (isMobile && viewMode === 'monad' && !_zoomAnimating && zoom !== 1) zoom = 1;
    beginInteraction();

    // Keep the About pane open across layout updates (e.g., resize).
    // Only auto-hide it if we somehow ended up visible while not on #about.
    if (_infoOverlayRef.classList.contains('visible') && !(window.location.hash || '').startsWith('#about')) hideInfo(false);

    
    _updateActiveView();

    // Stub mode in monad view: the map's viewport heuristic doesn't apply, so reconcile by the monad rule (linked items real, other ring items stubbed until hovered). Idempotent.
    if (viewMode === 'monad') {
        _stubReconcileMonad();
    }

    // Set --zoom only when it actually changed by enough (throttle during interaction).
    // During CSS-driven zoom animation, CSS owns --zoom; we only *read* it.
    if (!_zoomAnimating && zoom !== _prevZoomVal) {
        if (!isInteracting || Math.abs(zoom - _lastCSSZoom) >= _ZOOM_CSS_STEP || zoom === 0 || zoom === 1) {
            document.documentElement.style.setProperty('--zoom', zoom);
            _lastCSSZoom = zoom;
        }
        _prevZoomVal = zoom;
    } else if (_zoomAnimating) {
        _prevZoomVal = zoom;
    }

    // The label ladder follows the filter's fitted zoom (see _labelRung).
    _syncLabelRungs();

    // Toggle monad-detail-visible class when zoom >= 0.3 (for showing tags/text/link)
    _syncMonadDetailVisible();

    /* Toggle monad-zoomed-in class for mobile scrolling behavior. The class itself is the state compared against, not a
       remembered copy: the exits clear it directly, and a copy left saying "on" after a detail was closed into the list
       stopped the next detail (opened from the grid) from getting it, so that detail and every one after could not scroll. */
    const zoomedIn = _isMonadZoomedIn();
    const _wasZoomedIn = document.body.classList.contains('monad-zoomed-in');
    if (zoomedIn !== _wasZoomedIn) {
        /* Only when a monad is what is on screen. In a panel view the body scroll belongs to the list or the grid, and
           throwing it away there is not a reset, it is losing the reader's place. */
        if (!zoomedIn && _wasZoomedIn && !_isPanelView()) {
            _resetAllScrollTops();
            /* Clear anything inline left on the description, so the CSS clamp is in sole control on the way out. Nothing expands it, but a scroll position and a stale listener can still be sitting on it. */
            if (selectedMonadId) {
                const _ca = _articleById(selectedMonadId);
                const _tx = _ca && _ca.querySelector('.detail-fields .text');
                if (_tx) {
                    _tx.style.removeProperty('transition');
                    _tx.style.removeProperty('max-height');
                    // Deliberately keep --text-fit-max, --text-fit-slope and .text-fits-all across zoom-out: the clamp formula shrinks to ~1.5em at zoom 0 regardless, so the cap is harmless, and zooming back in restores the computed fit immediately instead of waiting for the recompute.
                    if (_tx._expandEndHandler) {
                        _tx.removeEventListener('transitionend', _tx._expandEndHandler);
                        _tx._expandEndHandler = null;
                    }
                    if (_tx._collapseEndHandler) {
                        _tx.removeEventListener('transitionend', _tx._collapseEndHandler);
                        _tx._collapseEndHandler = null;
                    }
                    if (_tx._collapseFailsafeTimer) {
                        clearTimeout(_tx._collapseFailsafeTimer);
                        _tx._collapseFailsafeTimer = null;
                    }
                    _tx._savedScrollY = null;
                }
            }
        }
        document.body.classList.toggle('monad-zoomed-in', zoomedIn);
        document.documentElement.classList.toggle('monad-zoomed-in', zoomedIn);

        _syncMonadHash();

        // Check native size only when entering zoomed-in state
        if (zoomedIn && selectedMonadId) _syncMonadNativeSize();
    }

    // Toggle labels-hidden at the LABEL_REVEAL_ZOOM crossing, matching the --label-opacity flip: the visibility gates and the opacity must flip together.
    if (viewMode === 'map' || viewMode === 'search') {
        const labelsHidden = zoom <= LABEL_REVEAL_ZOOM;
        if (labelsHidden !== _prevLabelsHidden) {
            document.body.classList.toggle('labels-hidden', labelsHidden);
            _prevLabelsHidden = labelsHidden;
        }
    } else if (_prevLabelsHidden) {
        document.body.classList.remove('labels-hidden');
        _prevLabelsHidden = false;
    }

    // Monad center image tiering (lazy upgrade)
    updateMonadCenterTiering();

    if (isMobile && !_zoomAnimating) updateMobileItemDetailScrollSpace();

    // Skip the tag cloud during animated transitions: its forced-layout reads thrash Safari's compositor
    // mid-transition, and switchToMonadView / switchToMapView update it once the transition ends.
    if (!document.body.classList.contains('animated')) {
        const _interacting = isInteracting && (viewMode === 'map' || viewMode === 'search');
        if (_interacting) {
            tagVis.requestSettle();
        } else {
            _scheduleTagCloudUpdate(false);
        }
    }
    _updateCancelButton();
    // Draw netvis synchronously here so it sees the _tx/_ty just written above in the same rAF. The throttle inside _netDrawFrame keeps the real rate near 30fps during a drag, so this is cheap on skipped frames.
    _netDrawNow();
}


/** Update map view layout, visibility, and transforms for current zoom/pan. */
function _measureMonadTextGeometry(article) {
    if (!article) return false;
    const h2El = article.querySelector('h2');
    const metaEl = article.querySelector('h3');
    if (!h2El) {
        article.classList.remove('monad-text-geom-ready');
        return false;
    }

    // Entering monad-centre, the h2's max-height animates from the single-line clamp up to 8em, so offsetHeight
    // taken mid-animation returns the clipped height and h3 overlaps the title. scrollHeight is the answer to that
    // on its own: with overflow hidden it reports the content's full height whatever the clamp is doing.
    const h2Height = h2El.scrollHeight;
    const metaHeight = metaEl ? metaEl.scrollHeight : 0;

    if (!Number.isFinite(h2Height) || h2Height <= 0) {
        article.classList.remove('monad-text-geom-ready');
        return false;
    }

    // The stack is positioned from the 100% the title is pinned at, so the title's own height is the only thing the CSS needs from here.
    article.style.setProperty('--h2-offset-height', h2Height + 'px');
    article.style.setProperty('--meta-offset-height', metaHeight + 'px');
    // Where the authors line's middle sits inside .detail-fields, which is what the centring puts at the middle of
    // the window.
    {
        const df = article.querySelector('.detail-fields');
        const au = df ? df.querySelector('.authors') : null;
        // The three offsets below are read with the fold lifted. The lines' heights ride --zoom, and this runs while
        // that is still at the bottom of the ramp, so measuring as-is gives the geometry of a stack with no lines in it:
        // the card is then centred on a version of itself that lasts half a second, and moves again when the real one
        // arrives.
        const _lift = [];
        const _liftEls = [metaEl, au, df ? df.querySelector('.source') : null];
        for (let i = 0; i < _liftEls.length; i++) {
            const el = _liftEls[i];
            if (!el) continue;
            _lift.push([el, el.style.maxHeight, el.style.transition]);
            el.style.transition = 'none';
            el.style.maxHeight = 'none';
        }
        if (_lift.length) void article.offsetHeight;

        if (au) article._authorsMidPx = au.offsetTop + au.offsetHeight / 2;
        // And where the identifying lines stop and the description begins: the bottom of the source, or of the authors if there is no source. An item with no image is anchored on this instead, so everything that names it sits above the middle of the window.
        const so = df ? df.querySelector('.source') : null;
        const last = so || au;
        if (last) article._metaEndPx = last.offsetTop + last.offsetHeight;
        // And the description's own top edge, which is what an item with no image is anchored on: with only a small grey square above it, everything that names the item fits above the middle of the window and the description starts there.
        const tx = df ? df.querySelector('.text') : null;
        if (tx) article._textTopPx = tx.offsetTop;

        for (let i = 0; i < _lift.length; i++) {
            const el = _lift[i][0];
            if (_lift[i][1]) el.style.maxHeight = _lift[i][1]; else el.style.removeProperty('max-height');
            if (_lift[i][2]) el.style.transition = _lift[i][2]; else el.style.removeProperty('transition');
        }
        if (_lift.length) void article.offsetHeight;
    }
    article.classList.add('monad-text-geom-ready');
    // The title's height is what the centring reads, so a fresh measurement wants a fresh pass.
    if (viewMode === 'monad' && _selectedMonadItem && _selectedMonadItem._article === article) updateMonadView();
    // Detail-fields layout depends on these CSS vars: re-measure mobile scroll space
    // after a frame so the browser has applied the new positions.
    if (isMobile) requestAnimationFrame(() => updateMobileItemDetailScrollSpace());
    // Also measure whether the abstract overflows the desktop threshold; .text-overflowing gates the mask gradient and the click-to-expand handler.
    _measureMonadTextOverflow(article);
    return true;
}

/** Detect whether the monad centre's .text exceeds the overflow threshold (5 lines) and toggle .text-overflowing.
 *  Skipped on mobile, which uncaps the text at zoom 1 and so has no clamp to compare against. */
function _measureMonadTextOverflow(article) {
    if (!article) return;
    if (isMobile) return;
    const textEl = article.querySelector('.detail-fields .text');
    if (!textEl) return;

    // Snapshot the inline styles we're about to override: the expand/collapse paths set inline max-height, so there may be real values to restore.
    const prevMaxHeight = textEl.style.maxHeight;
    const prevOverflow = textEl.style.overflow;
    const prevMask = textEl.style.maskImage;
    const prevWebkitMask = textEl.style.webkitMaskImage;

    // Defeat the height and clipping constraints so offsetHeight returns the natural wrapped height; the gradient-fade design only needs max-height, overflow and mask reset.
    textEl.style.maxHeight = 'none';
    textEl.style.overflow = 'visible';
    textEl.style.maskImage = 'none';
    textEl.style.webkitMaskImage = 'none';
    // Force a reflow so the style overrides apply before we read.
    void textEl.offsetWidth;

    const naturalHeight = textEl.offsetHeight;
    const cs = getComputedStyle(textEl);
    // line-height may be a multiplier or a length; getComputedStyle normalises non-`normal` values to px, so fall back to the font-size approximation only in the rare `normal` case.
    let lineHeightPx = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineHeightPx)) {
        const fontSizePx = parseFloat(cs.fontSize) || 16;
        lineHeightPx = fontSizePx * 1.3;
    }
    const clampLines = _monadClampLines(textEl);
    const overflowThresholdPx = (clampLines - 1) * lineHeightPx;
    // Tolerance: a sub-pixel rounding fluctuation shouldn't flip the
    // class. 2px is well under one visual line at any reasonable size.
    const isOverflowing = naturalHeight > overflowThresholdPx + 2;

    // Restore with removeProperty when the original was empty, so the inline declaration disappears rather than becoming an empty string that still outranks the stylesheet in some engines.
    if (prevMaxHeight) textEl.style.maxHeight = prevMaxHeight;
    else textEl.style.removeProperty('max-height');
    if (prevOverflow) textEl.style.overflow = prevOverflow;
    else textEl.style.removeProperty('overflow');
    if (prevMask) textEl.style.maskImage = prevMask;
    else textEl.style.removeProperty('mask-image');
    if (prevWebkitMask) textEl.style.webkitMaskImage = prevWebkitMask;
    else textEl.style.removeProperty('-webkit-mask-image');

    textEl.classList.toggle('text-overflowing', isOverflowing);

    // .text-fits-all is the narrower verdict: everything is on screen, so the "more below" mask has nothing to
    // foreshadow and the expand affordance nothing to reveal. It covers two cases.
    const wholePx = (clampLines + _MONAD_TEXT_CLAMP_SLACK_LINES) * lineHeightPx + 2;
    const fitsAll = naturalHeight <= wholePx;
    const needsRaisedCap = fitsAll && naturalHeight > clampLines * lineHeightPx + 2;
    if (needsRaisedCap) {
        // Raise this item's cap to its own height, and the slope with it: the base rule's max-height reaches the cap exactly at --zoom 1, so the slope has to be the cap over that 0.65 range or the reveal stops short.
        const capPx = Math.ceil(naturalHeight + 2);
        textEl.style.setProperty('--text-fit-max', capPx + 'px');
        textEl.style.setProperty('--text-fit-slope', Math.ceil(capPx / 0.65) + 'px');
    } else {
        textEl.style.removeProperty('--text-fit-max');
        textEl.style.removeProperty('--text-fit-slope');
    }
    textEl.classList.toggle('text-fits-all', fitsAll);

    // The content key is kept: it is what tells a resize re-measure of the SAME item from a genuine change of centre, which the callers below still rely on.
    const contentKey = textEl.innerHTML.length + ':' + textEl.innerHTML.charCodeAt(0);
    if (textEl.dataset.contentKey !== contentKey) textEl.dataset.contentKey = contentKey;
}



/* True while the centre has been brought in front of the ring by a click. Only for items with nothing to expand: everything else gets the same room by opening, which clears the ring out of the way entirely. */
let _monadCenterFront = false;
/* The element carrying the class, held so it can be released even after the centre has changed: a swap raises the class on one article and would otherwise leave it on another. */
let _monadFrontArticle = null;

/** Raise or lower the centre. Cleared by anything that changes what the centre is. */
function _setMonadCenterFront(front) {
    front = !!front;
    if (_monadFrontArticle) {
        _monadFrontArticle.classList.remove('center-front');
        _monadFrontArticle = null;
    }
    _monadCenterFront = front;
    if (!front) return;
    const art = _centerArticle();
    if (art) {
        art.classList.add('center-front');
        _monadFrontArticle = art;
    }
}

/** Open or close every clamped field of the centre at once: description and meta lines travel together, and the
 *  ring moves out and back with them. Nothing animates them: the lines are capped at two and stay there. */
function _toggleMonadDetails(article) {
    if (!article) return;
    /* A click on the open card raises it in front of the ring, where a thumbnail is not lying across the line being read. Again to send it back. */
    _setMonadCenterFront(!_monadCenterFront);
}


/* ══ MONAD VIEW ════════════════════════════════════════════════════════════ */

// Positional map-offscreen has no callback that re-triggers an src assignment when it clears, and updateMapView
// is the only place that sees the offscreen-to-onscreen flip, so mark a reveal here.
let _revealSweepPending = false;
function _noteItemRevealed() {
    _revealSweepPending = true;
    _cancel('img.revealSweep');
    _after('img.revealSweep', function _runRevealSweep() {
        if (!_revealSweepPending) return;
        // Don't reveal or sweep mid-transition: _stubRevealVisible() swaps src on visible items, which flashes them in Chromium while they animate. Re-defer in small steps, then run once against the final state.
        if (_viewTransitionActive()) {
            _after('img.revealSweep', _runRevealSweep, 90);
            return;
        }
        _revealSweepPending = false;
        if (viewMode !== 'map') return;
        // Stub mode owns the stub-to-real transition, and the crossing-gated reconcile won't fire when we're already inside the reveal regime, so reveal newly arrived stubs directly, then sweep for hard failures on both kinds of item.
        const _below = zoom > STUB_REVEAL_ZOOM;
        if (_below) {
            _stubRevealVisible();
        }
        _sweepImageHealth();
    }, 180);
}

function updateMapView() {
    const sq = getSquareSize();
    const buffer = 0.04;
    const vw = __mainVW();
    const vh = window.innerHeight;

    // Viewport culling margin: generous to cover image size + label height.
    // Extra top margin because articles use translateY(-100%).
    const margin = 300;


    if (isMobile) {
        const bScale = 1 - 2 * buffer;
        const offX = (vw - sq) / 2;
        const offY = (vh - sq) / 2;
        // Mobile runs its own loop and does no label cull, so the stack build
        // keys on the article cull alone. Same zoom gate as the desktop loop.
        const _wantLabelStack = zoom > LABEL_STACK_ZOOM;
        // Loop over all items.
        for (let i = 0, len = items.length; i < len; i++) {
            const item = items[i];
            const x = (buffer + item._dx * bScale) * sq + panX + offX;
            const y = (buffer + item._dy * bScale) * sq + panY + offY;
            const article = _ensureArticle(item);
            // Viewport culling (generous margin for rendering)
            const offscreen = x < -margin || x > vw + margin || y < -margin * 2 || y > vh + margin;
            _setArticleTranslate(article, x, y, offscreen);
            if (offscreen !== !!item._mapOffscreen) {
                item._mapOffscreen = offscreen;
                article.classList.toggle('map-offscreen', offscreen);
                // Re-entering the viewport: schedule a coalesced sweep so a
                // stranded empty/failed src gets recovered once movement settles.
                if (!offscreen) _noteItemRevealed();
            }
            if (_wantLabelStack && !offscreen && !item._labelStackBuilt) _ensureLabelStack(item);
        }
        _setViewportScale();
        return;
    }

    // Hot path: every item on every pan/zoom frame. itemRawPos() + wrapToViewport() allocated two objects per item
    // (~620 short-lived objects a frame) and re-read __mainCenterX() per item though it is loop-constant.
    const bScale = 1 - 2 * buffer;
    const baseOffX = panX + __mainCenterX() - sq / 2;
    const baseOffY = panY + (vh - sq) / 2;
    // Label-stack extents hoisted: they depend only on the live label scale and root font size, so the per-item cost is just the change-guarded class toggle.
    const _lblExt = _mapLabelExtentsPx();
    const _lblDown = _lblExt.down;
    const _lblHalf = _lblExt.half;
    // Constant across the loop: below this zoom no item needs a label stack.
    const _wantLabelStack = zoom > LABEL_STACK_ZOOM;
    for (let i = 0, len = items.length; i < len; i++) {
        const item = items[i];
        const posX = (buffer + item._dx * bScale) * sq + baseOffX;
        const posY = (buffer + item._dy * bScale) * sq + baseOffY;
        const article = _ensureArticle(item);
        // Viewport culling (generous margin for rendering)
        const offscreen = posX < -margin || posX > vw + margin || posY < -margin * 2 || posY > vh + margin;
        _setArticleTranslate(article, posX, posY, offscreen);
        if (offscreen !== !!item._mapOffscreen) {
            item._mapOffscreen = offscreen;
            article.classList.toggle('map-offscreen', offscreen);
            // Re-entering the viewport: schedule a coalesced sweep so a
            // stranded empty/failed src gets recovered once movement settles.
            if (!offscreen) _noteItemRevealed();
        }
        // Label culling is tighter than the article cull, whose 300px band exists to keep IMAGES from popping in during
        // a pan. The stack spans x within +/- half and y from the anchor down, since the image is what extends upward.
        const labelsOff = offscreen
            || posX + _lblHalf < 0 || posX - _lblHalf > vw
            || posY + _lblDown < 0 || posY > vh;
        // Only ever REMOVE the cull mid-transition. Positions written during one are destinations, so an item on its way
        // out would lose its labels on the first frame instead of travelling off screen with them.
        const labelsCullNow = (labelsOff && !item._labelsCulled && _viewTransitionActive())
            ? false
            : labelsOff;
        if (labelsCullNow !== !!item._labelsCulled) {
            item._labelsCulled = labelsCullNow;
            article.classList.toggle('labels-culled', labelsCullNow);
        }
        // Build only: releasing is the settled sweep's job (_sweepLabelStacks).
        if (_wantLabelStack && !labelsCullNow && !item._labelStackBuilt) _ensureLabelStack(item);
    }
    _setViewportScale();
}

/* ══ MONAD VIEW (CONTINUED) ════════════════════════════════════════════════ */

/** Update monad view for the current UI state: the centre card, and the ring of
 *  related items around it. One state: see the ring constants above. */
function updateMonadView() {
    if (!selectedMonadId || !_selectedMonadItem) return;

    const selectedItem = _selectedMonadItem;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const centerX = __mainCenterX();
    const centerY = vh / 2;
    const vminPx = Math.min(vw, vh) / 100;

    const attractionRow = attractionMatrix[selectedMonadId];

    // Centre item. The title sits at the middle of the window, the image directly above it, everything else below: one anchor, and the only measurement behind it is the title's own height.
    const centerArticle = _ensureArticle(selectedItem);
    const natW = parseInt(centerArticle.style.getPropertyValue('--nat-w')) || 4;
    const natH = parseInt(centerArticle.style.getPropertyValue('--nat-h')) || 3;
    const imgBox = _monadCenterImgBox(natW, natH, centerArticle.classList.contains('placeholder-img'));

    // Change-guarded: this runs every frame, and an identical inline write still invalidates the element in Chromium, forcing a re-raster per frame on a composited image.
    const centerImg = centerArticle.querySelector('img');
    if (centerImg) {
        const _sStr = String(_monadCenterImgScale(centerArticle));
        if (centerImg.style.getPropertyValue('--scale') !== _sStr) centerImg.style.setProperty('--scale', _sStr);
    }

    // The article's transform y is the image's bottom edge (width 0, justify-end, translateY(-100%)), and the title
    // is pinned to that same edge by `article h2 { top: 100% }`, growing downward from a top-centre transform
    // origin.
    const monadScale = (vw >= 768 && !isMobile) ? 1.15 : 1.0;
    const h2H = parseFloat(centerArticle.style.getPropertyValue('--h2-offset-height')) || (3 * _rootRemPx());
    const titleMidBelowAnchor = (h2H / 2) * monadScale;

    // Left-align the centre IMAGE on a phone, by shifting the image alone rather than the article's anchor.
    /* The shift is written and withdrawn by the same branch, and the condition is the STATE rather than the platform. */
    if (isMobile && viewMode === 'monad') {
        const _edgePx = _cssLengthPx(document.documentElement, '--edge') || 1.3 * _rootRemPx();
        centerArticle.style.setProperty('--img-x-shift', (_edgePx + imgBox.w / 2 - centerX) + 'px');
        // Only ever one article carries this, so remembering which makes _clearImgXShift a single write rather than a sweep.
        _imgXShiftArticle = centerArticle;
    } else if (centerArticle.style.getPropertyValue('--img-x-shift')) {
        centerArticle.style.removeProperty('--img-x-shift');
        if (_imgXShiftArticle === centerArticle) _imgXShiftArticle = null;
    }

    let centerYPos;
    if (isMobile) {
        // centerYPos is the image's BOTTOM edge, so this puts its top on the shared band just below the corner buttons: the height the list row and the grid card open at.
        centerYPos = _mobileSelectionTopPx() + imgBox.h;
    } else {
        // Closed, the authors line is what sits at the middle of the window: the title above it, the description and the
        // rest below, which balances the block against the image better than centring the title did.
        const noImg = centerArticle.classList.contains('placeholder-img');
        const metaH = parseFloat(centerArticle.style.getPropertyValue('--meta-offset-height')) || 0;
        // An image-less item anchors on the top edge of its description, falling back to the end of the meta lines when it has none.
        const within = noImg
            ? (centerArticle._textTopPx
                || centerArticle._metaEndPx || 0)
            : (centerArticle._authorsMidPx || 0);
        const anchorToMiddle = (within > 0
            ? ((h2H + metaH) * monadScale + 0.3 * _rootRemPx() + within)
            : titleMidBelowAnchor)
            + (noImg ? MONAD_NOIMG_LIFT_REM * _rootRemPx() : 0);
        centerYPos = centerY - anchorToMiddle;
    }
    _setArticleTranslate(centerArticle, centerX, centerYPos);

    /* Related items: one ring, anchored to the window rather than to the card, so it holds still across item swaps and while the card scrolls. Desktop only. */
    if (isMobile) return;

    const ring = __monadRingGeom(vw, vh, imgBox.w / 2);

    for (let i = 0, len = items.length; i < len; i++) {
        const item = items[i];
        if (item.id === selectedMonadId) continue;

        const article = _ensureArticle(item);
        const sim = (attractionRow && attractionRow[item.id]) || 0;
        const radialT = (_pairRadialT && _pairRadialT[selectedMonadId] && _pairRadialT[selectedMonadId][item.id] != null)
            ? _pairRadialT[selectedMonadId][item.id]
            : __monadRadialT(sim);
        const radius = __monadRingRadius(ring, radialT);
        // The y is the article's bottom edge; half the image's visual height puts its CENTRE on the circle (see _monadImgHalfVmin).
        _setArticleTranslate(article, ring.cx + item._monadCos * radius,
            ring.cy + item._monadSin * radius + (item._monadImgHalfVmin || 0) * vminPx);
    }
}

/** The ring around a centre: its linked items plus the others ranked by similarity. Those over MONAD_SIM_CUTOFF join up to MONAD_VISIBLE_CAP, and if the ring is still short of MONAD_MIN_RELATED (linked items included) the next best with any similarity top it up. `inPool` narrows the candidates, as a tag filter does. */
function _monadRingMembers(centerId, inPool) {
    const attRow = attractionMatrix && attractionMatrix[centerId];
    const linkedSet = _preLinkedSet[centerId] || new Set();
    const ring = new Set();
    const candidates = [];
    for (const p of items) {
        if (p.id === centerId) continue;
        if (inPool && !inPool(p)) continue;
        if (linkedSet.has(p.id)) { ring.add(p.id); continue; }
        const att = (attRow && attRow[p.id]) || 0;
        if (att > 0) candidates.push({ id: p.id, att });
    }
    candidates.sort((x, y) => y.att - x.att);
    let shown = 0;
    for (const c of candidates) {
        if (c.att < MONAD_SIM_CUTOFF) break;
        if (MONAD_VISIBLE_CAP > 0 && shown >= MONAD_VISIBLE_CAP) break;
        ring.add(c.id);
        shown++;
    }
    for (let i = 0; i < candidates.length && ring.size < MONAD_MIN_RELATED; i++) ring.add(candidates[i].id);
    return ring;
}

/** The ids allowed on the ring when an item was opened from a tag-filtered map, or null when the whole collection is. The ranking is re-run inside the tag's subset rather than filtered afterwards, so the subset gets its own best neighbours. A search query does not gate: it orders relevance rather than stating which items belong together. Mobile has no ring. */
function _monadRingGate(centerId) {
    const t = (activeTag || '').trim();
    if (!t || isMobile || !centerId) return null;
    return _monadRingMembers(centerId, p => p.tags && p.tags.includes(t));
}

// One-time setup when entering monad view: classes and CSS custom properties.
function setupMonadClasses() {
    if (!selectedMonadId) return;

    // Use precomputed linked ids/sets (built once during init)
    _monadLinkedIds = _preLinkedIds[selectedMonadId] || [];
    _monadLinkedSet = _preLinkedSet[selectedMonadId] || new Set();

    /* Narrowed to the active tag, if there is one. The linked sets go through the same gate, since updateMonadView and _scheduleMonadTierRetarget both read them to decide ring placement and image tier: a linked item left in here after being hidden would be given a position and a large image it never shows. */
    const _ringGate = _monadRingGate(selectedMonadId);
    if (_ringGate) {
        _monadLinkedIds = _monadLinkedIds.filter(id => _ringGate.has(id));
        _monadLinkedSet = new Set(_monadLinkedIds);
    }

    
    // Loop over all items: batch class + style changes per article to minimise
    // style invalidations that Safari evaluates eagerly (unlike Chrome/FF).
    for (const item of items) {
        const article = getOrCreateArticle(item);
        // Single regex strips all view-specific and state classes at once.
        let cn = article.className
            /* center-front is EXIT state and belongs here; monad-leaving deliberately does NOT. */
            .replace(/\b(search-hidden|monad-show-label|monad-center|monad-native-size|monad-zero|monad-low|monad-linked|monad-stagger-hide|center-front|tag-filtered-out|monad-text-geom-ready|map-offscreen|labels-culled)\b/g, '')
            .replace(/  +/g, ' ').trim();
        item._mapOffscreen = false;
        item._labelsCulled = false;

        if (item.id === selectedMonadId) {
            cn += ' monad-center monad-show-label';
            article.className = cn;
            article.style.setProperty('--attraction', 1);
            article.style.removeProperty('--monad-h2-scale');
            item._monadLow = false;
            const img = article.querySelector('img');
            // In the same pass as the class: see _monadCenterImgScale.
            if (img) img.style.setProperty('--scale', String(_monadCenterImgScale(article)));
            
            // Keep subtitle/detail hidden until the new center item's text geometry is known.
            _measureMonadTextGeometry(article);
            requestAnimationFrame(() => {
                if (viewMode === 'monad' && selectedMonadId === item.id) {
                    _measureMonadTextGeometry(article);
                }
            });
        } else if (isMobile) {
            // Whatever this item was last time, it is not the centre now, and only the centre carries the phone's left-align shift. A hop from one item to the next never passes through the map, so neither of the other two releases is reached.
            if (_imgXShiftArticle === article) _imgXShiftArticle = null;
            article.style.removeProperty('--img-x-shift');
            /* Mobile has no ring. The detail overlay is a single item read full-screen, not a centre with satellites around it, so every other item takes the hidden tier and nothing below this branch runs: no similarity class, no linked label, no ring scale, no half-height for a circle it will never sit on.
               monad-low rather than a new class, so every mechanism that already knows about hidden peripherals keeps working unchanged: the display: none in the CSS, the _wasHidden capture and staggered return in switchToMapView, and setImgTier's suppress path, which strips src for anything carrying it and hands the bitmap back. */
            cn += ' monad-low';
            article.className = cn;
            article.style.setProperty('--attraction', 0);
            article.style.removeProperty('--monad-h2-scale');
            item._monadLow = true;
            const img = article.querySelector('img');
            if (img) img.style.removeProperty('--scale');
            item._monadImgHalfVmin = 0;
        } else {
            // Use precomputed monad class state: zero computation, pure write.
            const mc = item._mc[selectedMonadId];
            // Outside the active tag: the hidden tier, whatever the similarity ranking made of it.
            const _gatedOut = !!(_ringGate && !_ringGate.has(item.id));
            cn += _gatedOut ? ' monad-low' : mc.cls;
            article.className = cn;
            article.style.setProperty('--attraction', _gatedOut ? 0 : mc.att);
            const isLinked = !_gatedOut && _monadLinkedSet.has(item.id);
            // Linked items keep their title on show, at a size between the peripheral label and the centre's.
            if (isLinked) article.style.setProperty('--monad-h2-scale', MONAD_LINKED_LABEL_SCALE);
            else article.style.removeProperty('--monad-h2-scale');
            item._monadLow = _gatedOut || mc.isLow;

            // Use precomputed trig from init
            item._monadCos = _pairCos[selectedMonadId][item.id];
            item._monadSin = _pairSin[selectedMonadId][item.id];

            // Ring scale is static, so the CSS rule on body.monad-view article img owns it: one formula, carrying the same
            // --monad-ring-boost this constant mirrors.
            const img = article.querySelector('img');
            const _ringScale = _gatedOut ? 0 : isLinked
                ? (mc.imgScale * MONAD_RING_IMG_BOOST)
                // Mirrors the CSS rule, which carries one further factor (--mobile-item-detail-img-bump) that is 1 on every platform this branch runs on.
                : ((0.015 + mc.att * 0.03) * 1.2 * MONAD_RING_IMG_BOOST);
            if (img) {
                if (isLinked) img.style.setProperty('--scale', _ringScale);
                else img.style.removeProperty('--scale');
            }

            // Half the image's visual height (see _monadRefreshImgHalf), kept in vmin so it survives a resize without recomputing. The ring scale is kept with it, since the recompute needs it and cannot derive it.
            item._monadRingScale = _ringScale;
            _monadRefreshImgHalf(item);

            // Image tiers are deliberately NOT set here. Swapping src on the first frame of the entry animation flashed the
            // very items that were flying and growing, and duplicated _stubReconcileMonad as a writer.
        }
    }

    _scheduleMonadTierRetarget();
}

// Re-derive the centring after late layout settles. The entry computes it in a single pass, so a first-selection
// or pre-font measurement error would stick and leave the centre off-target.
/** Half an item's visual image height, in vmin, which is what lifts it from the ring to sit centred ON it. */
/** Article currently carrying the phone's left-align shift, or null. */
let _imgXShiftArticle = null;

/** Release the phone's left-align shift. It is written on the centre article by updateMonadView every frame it
 *  runs, and it is a plain pixel translate inside the image's transform: NOT scaled by the scale() beside it, so
 *  on the map it stays the same number of pixels while the item shrinks and reads as a bigger and bigger
 *  displacement the further you zoom out. */
function _clearImgXShift() {
    if (_imgXShiftArticle) {
        _imgXShiftArticle.style.removeProperty('--img-x-shift');
        _imgXShiftArticle = null;
    }
}

function _monadRefreshImgHalf(item) {
    if (!item) return;
    const article = item._article;
    if (!article) { item._monadImgHalfVmin = 0; return; }

    /* The aspect comes from the remembered image meta first, and only falls back to the article's inline vars. Those
       are rewritten on EVERY image load, including the 1x1 stub the map swaps in, which reports itself as square. */
    const _meta = (imageMeta) ? imageMeta[item.id] : null;
    let _nw = (_meta && _meta.nw) || 0;
    let _nh = (_meta && _meta.nh) || 0;
    if (!(_nw > 0 && _nh > 0)) {
        _nw = parseInt(article.style.getPropertyValue('--nat-w')) || 4;
        _nh = parseInt(article.style.getPropertyValue('--nat-h')) || 3;
    }
    if (_nw === 1 && _nh === 1) { _nw = 4; _nh = 3; }

    const _wv = parseFloat(article.style.getPropertyValue('--w')) || 16;
    const _ph = article.classList.contains('placeholder-img') ? 0.45 : 1;
    item._monadImgHalfVmin = (_wv * (_nh / _nw)) * (item._monadRingScale || 0) * _ph / 2;
}

function _monadReconcileLayout(forId) {
    if (viewMode !== 'monad' || selectedMonadId !== forId) return;
    const a = _articleById(forId);
    if (a) _measureMonadTextGeometry(a); // re-runs updateMonadView with the fresh title height
    // The fades depend on whether the block overflows, which a re-measure can change.
    _syncMonadTextMask();
    /* Both callers of this arrive because an image's natural dimensions turned up late, and the ring offsets were computed from those. */
    if (items) {
        for (let i = 0; i < items.length; i++) {
            if (items[i].id !== forId) _monadRefreshImgHalf(items[i]);
        }
    }
    // Lower the animation flag for this pass so updateMonadView writes the static inline --scale numbers instead of handing the centre image to the interpolating --zoom chain mid-morph. --zoom itself is untouched.
    const _wasAnim = _zoomAnimating;
    _zoomAnimating = false;
    update();
    _zoomAnimating = _wasAnim;
}

// Deferred tier pass for monad entry: waits for the entry transition to settle, then applies the policy in one batch. Bails if the user has already left.
function _scheduleMonadTierRetarget() {
    _cancel('monad.tierRetarget');
    const forId = selectedMonadId;
    if (!forId) return;
    _afterSettled('monad.tierRetarget', () => {
        if (viewMode !== 'monad' || selectedMonadId !== forId) return;
        for (let i = 0, len = items.length; i < len; i++) {
            const item = items[i];
            if (!item || item.id === forId) continue; // center owned by selection path
            const article = item._article;
            if (!article) continue;
            const img = _articleImg(article);
            if (!img) continue;
            // The lightbox's source image is hands-off while it is open. The centre is already excluded above, so the
            // lightbox is all that needs protecting here.
            const tier = _imgTier(img);
            if (lightboxOpen && img === _lightboxSourceImg) continue;
            // Only the selected item loads its image file; everything around it, linked items included, keeps the inline small image.
            if (tier !== 's') setImgTier(img, 's');
        }
    });
}

/* ══ SEARCH VIEW ═════════════════════════════════════════════════════════════ */

/** Update search view for the current UI state. */
function updateSearchView() {
    // Breathing layout: rearrange visible items when search result set changes
    {
        const matchIds = [];
        for (let i = 0; i < items.length; i++) {
            if ((searchScores[items[i].id] || 0) > 0) matchIds.push(items[i].id);
        }
        const key = matchIds.join(',');
        if (key !== _searchBreathingKey) {
            _searchBreathingKey = key;
            if (matchIds.length > 0 && matchIds.length < items.length) {
                const matchSet = new Set(matchIds);
                _breatheLayout(function(it) { return matchSet.has(it.id); });

                // Fit camera to the breathing result set (set zoom/pan directly -
                // the rest of this function will pick up the new values via getSquareSize).
                const buffer = 0.04;
                const bScale = 1 - 2 * buffer;
                const vwFit = __mainVW();
                const vhFit = window.innerHeight;
                const padLR = vwFit * 0.05;
                const hInset = padLR * 2 + __mapTagOcclusionPx();
                const baseSq = Math.min(vwFit - hInset, vhFit);
                let minDx = Infinity, maxDx = -Infinity, minDy = Infinity, maxDy = -Infinity;
                for (let i = 0; i < items.length; i++) {
                    if (!matchSet.has(items[i].id)) continue;
                    const dx = items[i]._dx, dy = items[i]._dy;
                    if (dx < minDx) minDx = dx;
                    if (dx > maxDx) maxDx = dx;
                    if (dy < minDy) minDy = dy;
                    if (dy > maxDy) maxDy = dy;
                }
                const dxRange = maxDx - minDx;
                const dyRange = maxDy - minDy;
                const matchCount = matchIds.length;
                const _resS = _fitEdgeReservesPx(_subsetTargetZoom(matchCount),
                    function(it) { return matchSet.has(it.id); });
                const targetSqX = (dxRange > 0) ? _fitSpanFor(matchCount, vwFit, _resS.x) / (dxRange * bScale) : baseSq;
                const targetSqY = (dyRange > 0) ? _fitSpanFor(matchCount, vhFit, _resS.y) / (dyRange * bScale) : baseSq;
                const targetSq = Math.min(targetSqX, targetSqY);
                if (_suppressSearchFitOnce) {
                    // A restored pre-monad camera takes precedence: keep the freshly computed breathing positions but leave zoom/pan/_subsetFitZoom at their reinstated values.
                    _suppressSearchFitOnce = false;
                } else {
                    // Degenerate bbox (single or coincident matches): use the density-derived zoom directly, mirroring _fitVisibleBounds' single-item branch.
                    const targetZoom = (dxRange < 0.001 && dyRange < 0.001)
                        ? _subsetTargetZoom(matchCount)
                        : Math.max(0, Math.min(1.5, (targetSq / baseSq - 1) / _MAP_ZOOM_RANGE));
                    _subsetFitZoom = targetZoom;
                    const sq = baseSq * (1 + targetZoom * _MAP_ZOOM_RANGE);
                    const cx = (minDx + maxDx) / 2;
                    const cy = (minDy + maxDy) / 2;
                    zoom = targetZoom;
                    panX = sq * (0.5 - buffer - cx * bScale);
                    // Same visual-block centering bias as _fitVisibleBounds
                    // (anchors are image bottoms; see _fitVerticalBiasPx).
                    panY = sq * (0.5 - buffer - cy * bScale)
                        + _fitVerticalBiasPx(targetZoom,
                            function(it) { return matchSet.has(it.id); },
                            dyRange * bScale * sq, vhFit);
                    clampPan();
                }
            } else {
                _resetBreathingLayout();
                if (_suppressSearchFitOnce) {
                    // Near-full match set (breathing skipped upstream too):
                    // honor the restored camera instead of recentering.
                    _suppressSearchFitOnce = false;
                } else {
                    zoom = 0;
                    panX = 0;
                    panY = 0;
                }
            }
        }
    }

    // Use UMAP positions (like map view)
    const vw = __mainVW();
    const vh = window.innerHeight;
    const sq = getSquareSize();
    const buffer = 0.04;

    // Loop over all items.
    const margin = 300;
    const bScale = 1 - 2 * buffer;
    const baseOffX = panX + __mainCenterX() - sq / 2;
    const baseOffY = panY + (vh - sq) / 2;
    // Same label-stack extents as updateMapView. Search view must maintain the class too: nothing strips it on a
    // view switch and the culling rule is scoped to body:not(.monad-view):not(.list-view), so a leftover would apply
    // here.
    const _lblExtS = _mapLabelExtentsPx();
    const _lblDownS = _lblExtS.down;
    const _lblHalfS = _lblExtS.half;
    // Constant across the loop: below this zoom no item needs a label stack.
    const _wantLabelStack = zoom > LABEL_STACK_ZOOM;
    for (const item of items) {
        const article = _ensureArticle(item);
        const match = (searchScores[item.id] || 0) > 0;
        const posX = (buffer + item._dx * bScale) * sq + baseOffX;
        const posY = (buffer + item._dy * bScale) * sq + baseOffY;
        // Coarser translate updates for items that won't be visible -
        // search-hidden items (no match) and items off the viewport.
        const offscreen = !match
            || posX < -margin || posX > vw + margin
            || posY < -margin * 2 || posY > vh + margin;
        _setArticleTranslate(article, posX, posY, offscreen);

        const wasSearchHidden = article.classList.contains('search-hidden');
        article.classList.toggle('search-hidden', !match);
        article.classList.remove('monad-center');

        const labelsOffS = offscreen
            || posX + _lblHalfS < 0 || posX - _lblHalfS > vw
            || posY + _lblDownS < 0 || posY > vh;
        // Remove-only while a transition runs: see the note in updateMapView.
        const labelsCullNowS = (labelsOffS && !item._labelsCulled && _viewTransitionActive())
            ? false
            : labelsOffS;
        if (labelsCullNowS !== !!item._labelsCulled) {
            item._labelsCulled = labelsCullNowS;
            article.classList.toggle('labels-culled', labelsCullNowS);
        }
        if (_wantLabelStack && !labelsCullNowS && !item._labelStackBuilt) _ensureLabelStack(item);

        // Mobile: setImgTier(img,'s') strips src for search-hidden items, and re-including one removes the class without a tier call, so re-establish src or newly matching items appear blank.
        if (isMobile && wasSearchHidden && match) {
            const img = article.querySelector('img');
            if (img && !img.getAttribute('src')) setImgTier(img, 's');
        }

    }
    _setViewportScale();
}

/** Switch UI into map view while preserving selection and search state, putting the camera back where the map was left: the snapshot taken on monad entry, or the plain overview when there is nothing to restore.
   fitTagSubset means the user clicked a keyword in the monad detail, so the saved camera is ignored and the whole tag subset is fitted instead. */
function _restoreMapCamera(previousMode, preserveCamera, fitTagSubset) {
    if (preserveCamera) return;   // caller keeps the current zoom/pan
    if (previousMode === 'monad' && _savedMapCamera && !fitTagSubset) {
        zoom = _savedMapCamera.zoom;
        panX = _savedMapCamera.panX;
        panY = _savedMapCamera.panY;
    } else {
        zoom = 0;
        panX = 0;
        panY = 0;
    }
}

/* forPanel: the caller is switchToListView or switchToGridView, so the map this leaves behind is covered by an
   opaque view before the next frame and none of it is seen. Everything that TEARS DOWN monad state still runs;
   everything that PRESENTS a map is skipped. */
function switchToMapView(updateHash = true, keepSearchOpen = false, keepCamera = false, forPanel = false) {
    _monadPendingId = null;
    if (viewMode === 'grid') _exitGridView();
    _setMonadCenterFront(false);
    _releaseLingerLabel();
    const __oldCenterId = selectedMonadId;
    // Coming out of a selection the title rides along and fades a beat after the move; every other route drops it now.
    if (viewMode === 'monad' && __oldCenterId) {
        // Same hover lock as the way in: the item going back to the map is under the pointer whenever the reader closed it by clicking its own title.
        _lockHoverForMorph();
        _holdLabelThroughExit(__oldCenterId);
        // And if the pointer is on the item as it leaves, it keeps its hover for the move rather than acquiring it in one jump at the end: see the exit-hover-hold rules.
        const _leaving = _articleById(__oldCenterId);
        if (_leaving && _leaving.matches(':hover')) _leaving.classList.add('exit-hover-hold');
    } else {
        _releaseSelectLabelHold();
    }

    // Mobile: reset the native body scroll BEFORE any class change. The body is scrollable under monad-zoomed-in,
    // and when that clears iOS Safari can keep the old scroll position as a visual offset (momentum racing the
    // overflow change), leaving the page looking unhinged with content shifted up.
    if (isMobile && viewMode === 'monad') {
        _resetAllScrollTops();
    }

    // Stub mode: clear the monad reconcile cache so re-entry re-applies the policy from scratch. _stubLastBelow is deliberately kept: the map heuristic is still meaningful, and the reveal pass below covers items the cleanup loop stubs wrongly.

    // Fully stop any CSS-driven zoom animation before changing viewMode, or the zoom-sync rAF keeps calling purgeHighResImages() and downgrades the centre image immediately (a visible snap).
    _stopZoomSync();
    _cancel('zoom.transition');
    if (_zoomAnimating) {
        document.documentElement.style.transition = '';
        document.body.classList.remove('zoom-animating');
        _zoomAnimating = false;
        _zoomAnimatingTarget = null;
    }
    // Drop any geometry re-measure parked by a mid-animation image load: we're leaving monad view, so it has nothing to correct and would be flushed by whichever zoom animation finishes next.
    _monadGeomAfterZoom = null;

    // Clean up pending monad-related reveal timers/classes
    _cancel('monad.relatedReveal', 'monad.staggerReveal', 'monad.staggerRevealFrame', 'monad.openSettle', 'monad.closeAfterCollapse');
    document.body.classList.remove('monad-related-hidden');

    _closeOverlaysForViewChange();
    
    const previousMode = viewMode;
    const previousMonadId = selectedMonadId;

    // A stale snapshot (monad-to-monad jumps since it was taken) behaves as if absent, unless handleHashChange un-staled it because history walked back to the exact filter it belongs to.
    if (_savedMapCamera && _savedMapCamera.stale) _savedMapCamera = null;

    // Restore pre-monad state: redirect to search or reinstate tag filter
    let _restoringPreMonadCamera = false;
    if (previousMode === 'monad' && _savedMapCamera) {
        if (_savedMapCamera.viewMode === 'search' && _savedMapCamera.searchQuery && !activeTag) {
            const q = _savedMapCamera.searchQuery;
            // Carry the pre-monad camera into the search view. Nulling the snapshot before the redirect discarded zoom and pan entirely, and switchToSearchView's breathing fit then re-framed the subset from scratch.
            const cam = _takeSavedCamera();
            searchInput.value = q;
            searchBox.classList.add('open');
            document.body.classList.add('search-open');
            document.body.classList.add('search-has-query');
            switchToSearchView(q, updateHash, cam);
            return;
        }
        if (_savedMapCamera.activeTag && !activeTag) {
            activeTag = _savedMapCamera.activeTag;
        }
        // Always mark as restoring when returning from a monad with a saved camera, so non-matching items are hidden immediately rather than via the deferred path, which flashes in Safari when handleHashChange already set activeTag.
        _restoringPreMonadCamera = true;
    }

    // Capture and clear the tag-click fit intent: the user clicked a keyword in the monad detail to see everything tagged with it, so ignore the saved camera and let _fitVisibleBounds frame the whole subset.
    const _fitTagSubset = _tagClickFitIntent;
    _tagClickFitIntent = false;
    if (_fitTagSubset) _restoringPreMonadCamera = false;

    // Snapshot positions AND clean up monad/search classes in one pass
    const oldPositions = {};
    const fromSearch = previousMode === 'search';
    const preserveCamera = !!(keepCamera && fromSearch);
    const targetTag = (activeTag || '').trim();
    const deferredTagHideIds = [];
    // Track items that were invisible in monad/search: they will fade in after the move.
    const _wasHidden = new Set();
    let _centerImgSnap = null; // {img, w, h, visualH} for the old monad center
    if (previousMode === 'monad' || previousMode === 'search') {
        // Snapshot centre image dimensions BEFORE stripping monad-center: the 39vh height cap disappears with the class, which would make portrait images jump.
        if (previousMode === 'monad' && previousMonadId) {
            const centerArt = _articleById(previousMonadId);
            const centerImg = centerArt ? centerArt.querySelector('img') : null;
            // Skip the special handling for placeholders: their visual size comes entirely from --placeholder-scale-factor while the layout box stays at regular dimensions, so they already exit without a layout-height transition.
            const isPlaceholder = centerArt && centerArt.classList.contains('placeholder-img');
            if (centerImg && !isPlaceholder) {
                const cs = getComputedStyle(centerImg);
                _centerImgSnap = {
                    img: centerImg,
                    w: cs.width,
                    h: cs.height,
                    // Thin monad-centre border-width, captured before the cleanup loop strips monad-center and the thick map rule applies. Held through the exit so the border doesn't flash thick while the image shrinks.
                    borderWidth: cs.borderWidth,
                    // Rendered visual height while still monad-centre. The desktop exit reproduces it with a compensating transform scale so the departing image starts at its monad size with no layout-height transition.
                    visualH: centerImg.getBoundingClientRect().height
                };
            }
        }

        // Pre-sync --item-scale before the cleanup loop, which bridges the departing centre's inline --scale by reading it: a stale value snaps the image and only corrects after the map-exit cleanup, a visible shrink-then-grow.
        _setViewportScale();

        // Loop over all items.
        for (let i = 0, len = items.length; i < len; i++) {
            const it = items[i];
            const article = _ensureArticle(it);

            // Record invisible state before cleanup
            let _hidden = false;
            if (previousMode === 'monad' && previousMonadId && it.id !== previousMonadId) {
                // Capture by the actual hidden class rather than the _mc.isLow cache, so every invisible peripheral is held at scale 0 and grown from 0 on reveal, not just the ones the cache flags. monad-zero is included defensively.
                if (article.classList.contains('monad-low')
                    || article.classList.contains('monad-zero')
                    || (it._mc && it._mc[previousMonadId] && it._mc[previousMonadId].isLow)) {
                    _hidden = true;
                }
            }
            if (previousMode === 'search' && article.classList.contains('search-hidden')) {
                _hidden = true;
            }
            if (_hidden) _wasHidden.add(it.id);

            // Read cached translate (set by _setArticleTranslate). Falls
            // back gracefully for articles that haven't been positioned yet.
            if (typeof article._tx === 'number' && typeof article._ty === 'number') {
                oldPositions[it.id] = { x: article._tx, y: article._ty };
            }

            if (targetTag) {
                const hasTargetTag = !!(it.tags && it.tags.includes(targetTag));
                const isAlreadyHidden = article.classList.contains('monad-low')
                    || article.classList.contains('monad-zero')
                    || article.classList.contains('search-hidden');
                // _fitTagSubset is a tag clicked in the detail view. That exit already contracts the subset and re-frames the camera; letting the non-matching items fade first puts a SECOND contraction and a second camera fit behind the first, on their own clock, while it is still running.
                if (!hasTargetTag && (isAlreadyHidden || _restoringPreMonadCamera || _fitTagSubset)) {
                    // Immediately hide: either already invisible, restoring a
                    // pre-monad filter, or leaving on the same move (no need for a fade-out animation).
                    article.classList.add('tag-filtered-out');
                    article.classList.remove('tag-transition-hide');
                } else if (!hasTargetTag) {
                    article.classList.remove('tag-filtered-out');
                    article.classList.remove('tag-transition-hide');
                    deferredTagHideIds.push(it.id);
                } else {
                    article.classList.remove('tag-filtered-out');
                    article.classList.remove('tag-transition-hide');
                }
            }

            // Batch class cleanup: one className write instead of 5× classList.remove. An item that was hidden takes
            // monad-stagger-hide in the SAME write that drops monad-low, so there is never a style state in which it is
            // neither.
            article.className = article.className
                .replace(/\b(monad-center|monad-show-label|monad-native-size|monad-zero|monad-low|monad-linked|monad-stagger-hide|monad-text-geom-ready|search-hidden|map-offscreen|labels-culled)\b/g, '')
                .replace(/  +/g, ' ').trim()
                + (_hidden ? ' monad-stagger-hide' : '');
            it._mapOffscreen = false;
        it._labelsCulled = false;
            // Zero --attraction rather than removing it: an undefined value makes the peripheral --scale formula invalid and flashes the item to unscaled size in the window where monad-view is still present but monad-center has been stripped.
            article.style.setProperty('--attraction', '0');
            // Clean up inline --scale on images (set during monad view)
            const img = article.querySelector('img');
            if (img) {
                // Bridge the departing centre's --scale to its map target rather than removing it, with monad-view still present, the peripheral formula kicks in far too small and shrinks it visibly before the map scale takes over.
                if (previousMonadId && it.id === previousMonadId) {
                    // The same class the outgoing centre of a monad-to-monad swap gets, for the same reason and one more: its title
                    // has to shrink from the centre's size to the map's on the move's clock, not on the 0.15s hover clock it would
                    // otherwise fall back to the moment monad-center is stripped.
                    article.classList.add('monad-leaving');
                    // Bridge the departing centre's --scale to its map target rather than removing it, or the peripheral formula
                    // shrinks it visibly while body.monad-view is still present.
                    const isPlaceholderItem = article.classList.contains('placeholder-img');
                    const target = isPlaceholderItem
                        ? 'min(var(--item-scale), 0.11)'
                        : 'var(--item-scale)';
                    img.style.setProperty('--scale', target);
                } else if (_hidden) {
                    // Held at 0 for the move, so it grows from nothing on reveal rather than from whatever size the intermediate formulas would have given it.
                    img.style.setProperty('--scale', '0');
                } else {
                    img.style.removeProperty('--scale');
                }
                // The previous linked items' m-to-s downgrade no longer happens here. It fired at the start of the exit,
                // swapping src on visible items still flying to their map positions: a bitmap-drop flash in Chromium that the
                // post-transition reveal then partly undid.
            }
        }
    }

    // Carry the departing centre image from its monad size to its map size.
    if (_centerImgSnap) {
        const _ci = _centerImgSnap.img;
        if (isMobile) {
            // Mobile: pin the layout box to the 39vh-capped monad dimensions for the whole move and let the map-exit cleanup release it. Kept static, because animating layout height while translateY(-100%) depends on it jitters the position.
            _ci.style.width = _centerImgSnap.w;
            _ci.style.height = _centerImgSnap.h;
        } else {
            // Desktop: drive the size change entirely through transform scale, never the layout box, so it is smooth
            // everywhere.
            const uncappedH = _ci.offsetHeight;
            if (uncappedH > 0 && _centerImgSnap.visualH > 0) {
                const startScale = _centerImgSnap.visualH / uncappedH;
                // Commit the compensated start scale with no transition so it becomes the transition's "from" and the first paint still shows monad size despite the uncapped box.
                _ci.style.transition = 'none';
                _ci.style.setProperty('--scale', String(startScale));
                // Hold the thin monad-centre border as the transition's "from". monad-center is already stripped, so the thick
                // map rule is live and would render at full thickness while the image is still large.
                if (_centerImgSnap.borderWidth) {
                    _ci.style.borderWidth = _centerImgSnap.borderWidth;
                }
                void _ci.offsetHeight;
                // Animate transform, opacity and border-color to the map resting state over --uiTrans, matching the article
                // move. Re-asserting --scale: var(--item-scale) makes it animate from the compensated start.
                _ci.style.transition =
                    'transform var(--uiTrans) var(--uiEase), ' +
                    'opacity var(--uiTrans) var(--uiEase), ' +
                    'border-color var(--uiTrans) var(--uiEase)';
                _ci.style.setProperty('--scale', 'var(--item-scale)');
                // Release the inline overrides once the move finishes. The inline transition otherwise outlives the exit and,
                // being inline, overrides every stylesheet transition on this image: most visibly the hover bump, which then
                // eased at 0.75s on any former centre.
                clearTimeout(_ci._mapExitBorderTimer);
                if (_ci._mapExitBorderRAF) cancelAnimationFrame(_ci._mapExitBorderRAF);
                const _release = function() {
                    _ci.style.removeProperty('border-width');
                    _ci.style.transition = '';
                    _ci._mapExitBorderTimer = null;
                };
                const _armRelease = function() {
                    _ci._mapExitBorderRAF = 0;
                    _ci._mapExitBorderTimer = setTimeout(
                        _release, _transitionRemainingMs(TRANS_TAIL_MS + 20));
                };
                if (document.hidden) _armRelease();
                else _ci._mapExitBorderRAF = requestAnimationFrame(_armRelease);
            }
        }
    }

    _setViewMode('map');
    _mobileMapDropFiles();
    /* After the mode flips, not before. Called at the top this ran while viewMode was still 'monad', so any
       updateMonadView later in the same exit wrote the shift back, which is why three earlier releases all appeared
       to do nothing. */
    _clearImgXShift();
    selectedMonadId = null;
    // Defer downgrading/purging until the map transition has finished.
    _selectedMonadItem = null;
    searchQuery = '';
    searchScores = {};
    _searchBreathingKey = '';
    // Delay search-view removal when animating from search: triggers scale change under transition
    if (!fromSearch) {
        document.body.classList.remove('search-view');
    }
    const __preserveMobileTag = _tagsInSearchBox() && (activeTag || '').trim();

    if (!keepSearchOpen && !__preserveMobileTag) {
        // searchInput cached at module level
        searchInput.value = '';
        searchInput.blur();
        document.body.classList.remove('search-has-query');
        searchBox.classList.remove('open');
    }

    // iOS Safari: touchstart may set body.notransition which disables image transitions.
    // Clear it before removing view-mode classes so the monad→map scale doesn't snap.
    document.body.classList.remove('notransition');
    _cancel('render.notransitionClass');
    isInteracting = false;

    // Ensure the leaving transition uses the animated easing before view-mode class changes. There is no leaving transition to ease when a panel is about to cover this.
    if (!forPanel) triggerAnimation();

    if (forPanel) {
        // The teardown the FLIP branch below does on its way past, without the positioning: --zoom synced, the monad classes off, the centre's inline scale bridge released.
        document.documentElement.style.setProperty('--zoom', zoom);
        document.body.classList.remove('monad-view', 'monad-zoomed-in', 'monad-detail-visible');
        document.documentElement.classList.remove('monad-view-active', 'monad-zoomed-in');
        if (_centerImgSnap) _centerImgSnap.img.style.removeProperty('--scale');
    } else if ((previousMode === 'monad' || previousMode === 'search') && Object.keys(oldPositions).length > 0) {
        _restoreMapCamera(previousMode, preserveCamera, _fitTagSubset);
        // Animate all items from their current positions to map targets
        for (const it of items) {
            const article = getOrCreateArticle(it);
            const old = oldPositions[it.id];
            if (!old) continue;

            article.style.transition = 'none';
            _setArticleTranslate(article, old.x, old.y);
        }
        _reflow();
        // Loop over all items.
        for (const it of items) {
            getOrCreateArticle(it).style.transition = '';
        }

        // No pin release needed for the departing centre here: desktop never pins (it drives size through transform scale), and mobile keeps its pin until the map-exit cleanup.

        // Sync --zoom before removing monad-view, so the map scale formula takes over at the target zoom 0 instead of a stale monad zoom that briefly inflates the departing centre.
        document.documentElement.style.setProperty('--zoom', zoom);

        // Now remove monad-view: after starting positions are committed
        document.body.classList.remove('monad-view', 'monad-zoomed-in', 'monad-detail-visible');
        document.documentElement.classList.remove('monad-view-active', 'monad-zoomed-in');

        // monad-view is gone, so the peripheral formula no longer applies: remove the inline --scale bridge so the centre image tracks --item-scale, which _fitVisibleBounds may update for the new subset.
        if (_centerImgSnap) {
            _centerImgSnap.img.style.removeProperty('--scale');
        }
    } else {
        document.body.classList.remove('monad-view', 'monad-zoomed-in', 'monad-detail-visible');
        document.documentElement.classList.remove('monad-view-active', 'monad-zoomed-in');
        _restoreMapCamera(previousMode, preserveCamera, _fitTagSubset);
        // Coming from list or grid: strip stale monad/search classes whose timed cleanup bailed while viewMode was
        // 'list' or 'grid'; monad-stagger-hide in particular sets opacity: 0 !important.
        if (previousMode === 'list' || previousMode === 'grid') {
            _cancel('monad.staggerReveal', 'monad.staggerRevealFrame');
            for (let i = 0, len = items.length; i < len; i++) {
                const it = items[i];
                const art = it._article;
                if (!art) continue;
                art.classList.remove(
                    'monad-stagger-hide', 'monad-zero', 'monad-low',
                    'monad-linked', 'monad-center', 'monad-show-label',
                    // The map-exit cleanup that normally clears this bails while a panel is the view, so an exit that ended in the list or the grid leaves it on.
                    'monad-leaving',
                    'monad-native-size', 'monad-text-geom-ready',
                    'search-hidden', 'tag-transition-hide',
                    // The culling classes too, with their flags: the pass that maintains them is change-guarded, so a class and a flag that agree with each other and disagree with the camera would never be revisited.
                    'map-offscreen', 'labels-culled'
                );
                it._mapOffscreen = false;
                it._labelsCulled = false;
                // A scale-0 pin from a monad exit that was interrupted by the panel view: its reveal phase owns the release and never ran.
                const img = art.querySelector('img');
                if (img && img.style.getPropertyValue('--scale') === '0') img.style.removeProperty('--scale');
            }
            // Items that were off screen when the list or grid took over can still hold stubs or empty srcs, and nothing would fix them: the panel view skipped update(), the offscreen flags were reset above without a flip for _noteItemRevealed to see, and the stub reconcile only acts on a zoom crossing.
            _stubLastBelow = null;
            _noteItemRevealed();
            // One more pass next frame. The update() at the end of this function runs against a layout that is still settling (the tag filter is re-applied after it, the breathing reset lands with it) and the cull it derives is only as good as the camera it sees.
            requestAnimationFrame(() => { if (viewMode === 'map') update(); });
        }
    }
    
    _updateDocTitle();
    
    if (updateHash) {
        _setHashForCurrentState(true);
    }

    // Remove search-view AFTER animation class is added so scale change transitions smoothly
    if (fromSearch) {
        document.body.classList.remove('search-view');
    }

    // Ensure tag filter state is applied when returning to the map.
    if (targetTag && (previousMode === 'monad' || previousMode === 'search')) {
        // Compute breathing layout BEFORE applying tag classes so _dx/_dy are ready
        // for the FLIP target positions (avoids a mid-animation course change).
        _breatheLayout(function(it) { return it.tags && it.tags.includes(targetTag); });

        for (let i = 0, len = items.length; i < len; i++) {
            const it = items[i];
            const article = _ensureArticle(it);
            if (!article) continue;
            if (deferredTagHideIds.includes(it.id)) continue;
            const has = !!(it.tags && it.tags.includes(targetTag));
            article.classList.remove('tag-transition-hide');
            article.classList.toggle('tag-filtered-out', !has);
        }
        _scheduleDeferredTagHide(deferredTagHideIds, targetTag);
    } else {
        _applyTagFilterToMap();
    }

    // With a tag filter active, fit the camera to the visible items, but not over an explicitly preserved or pre-monad-restored camera, unless the tag changed (making the saved framing wrong). A tag click from the monad detail always fits.
    if (!forPanel && activeTag && !preserveCamera && (_fitTagSubset || !_restoringPreMonadCamera || (_savedMapCamera && _savedMapCamera.activeTag !== activeTag))) {
        const __t = activeTag;
        _fitVisibleBounds(function(it) { return it.tags && it.tags.includes(__t); }, false);
    }

    _syncTagToSearchBox();
    // Nothing to lay out for a map that is about to be covered, and nothing to re-derive: update() runs on arrival when the reader comes back to it.
    if (!forPanel) {
        update();
    }

    // Stub mode: the cleanup loop above may have stubbed items through _setSmallSrc, so run a reveal pass now and again next frame.
    if (!forPanel) {
        const _shouldReveal = () => {
            return viewMode === 'map' && zoom > STUB_REVEAL_ZOOM;
        };
        // If we got here inside an animated transition (e.g. a tag click from the monad detail), revealing now swaps src on mid-animation items and flashes them: defer to the shared post-transition reconcile.
        if (_viewTransitionActive()) {
            _scheduleStubReconcileAfterTransition();
        } else {
            if (_shouldReveal()) _stubRevealVisible();
            requestAnimationFrame(() => { if (_shouldReveal()) _stubRevealVisible(); });
        }
    }

    // There is no move to follow, and the reveal's own viewMode guard would decline it a beat later anyway.
    if (!forPanel && (previousMode === 'monad' || previousMode === 'search') && _wasHidden.size > 0) {
        _cancel('monad.staggerReveal', 'monad.staggerRevealFrame');
        // Timed off the shared transition clock plus a buffer, so it tracks the frame the move actually started.
        const _revealPhase = function() {
            if (viewMode !== 'map') return;
            const _reveal = [];
            for (const it of items) {
                if (_wasHidden.has(it.id)) _reveal.push(it);
            }
            /* Two things were wrong beyond the timing. It ignored the tag filter, so it decoded items the filter had already
               culled and that this reveal will never show, and a keyword tap is exactly the case where most of them are
               culled. */
            triggerAnimation();
            // Mark this as the TAIL of the exit, not a fresh view transition. The reveal genuinely needs body.animated
            // (items fade in and grow from scale 0 on its clock), but it fires after the move has settled and
            // triggerAnimation re-arms the removal timer, so body.animated spanned roughly twice the transition's length and
            // left map hover stuck on the slow clock for most of a second.
            document.body.classList.add('stagger-reveal');
            // Chunked reveal in all browsers: dropping the hide classes on ~250 items at once forces style, layout and paint
            // for the whole set in the same frame their transitions start; a raster spike Chromium presents mid-flight and
            // that costs other engines a dropped frame.
            const _CHUNK = 90;
            let _ri = 0;
            const _revealChunk = function() {
                if (viewMode !== 'map') return;
                const _end = Math.min(_ri + _CHUNK, _reveal.length);
                const _gNow = performance.now();
                for (; _ri < _end; _ri++) {
                    // Hold this item's netvis edges back until its fade-in
                    // completes (see _edgeGraceUntil in the netvis loop).
                    _reveal[_ri]._edgeGraceUntil = _gNow + UI_TRANS_MS;
                    const _a = getOrCreateArticle(_reveal[_ri]);
                    _a.classList.remove('monad-stagger-hide');
                    // Release the scale-0 hold from the stagger-hide site so the image grows from 0 to its map --scale as it fades in, rather than appearing at the peripheral size.
                    const _img = _a.querySelector('img');
                    if (_img) _img.style.removeProperty('--scale');
                    /* Warm the bitmap: after a spell under content-visibility: hidden Chromium may have evicted it, and unhiding
                       then paints the img empty for a frame or two while it re-decodes; a blink that reads as flicker when hundreds
                       reveal at once. */
                    if (!isMobile && _img && _img.decode && _img.getAttribute('src')
                        && !_a.classList.contains('tag-filtered-out')) {
                        try { _img.decode().catch(() => {}); } catch (e) { /* noop */ }
                    }
                }
                if (_ri < _reveal.length) {
                    requestAnimationFrame(_revealChunk);
                    return;
                }
                // Safety net: monad-stagger-hide is in the suppress list, so newly revealed items have empty src on mobile. _sweepImageHealth also retries loads that failed in the meantime.
                _sweepImageHealth();
            };
            _revealChunk();
        };
        const _armReveal = function() {
            _after('monad.staggerReveal', 
                _revealPhase, _transitionRemainingMs(TRANS_TAIL_MS + 60));
        };
        if (document.hidden) _armReveal();
        else _onFrame('monad.staggerRevealFrame', _armReveal);
    }

    // After the move, and only once. The exit has several places that would each like to refresh the cloud (this,
    // the stagger reveal, the hash handler) and every refresh reads a rect per item, so on Safari they showed up as
    // the cloud reflowing two or three times over a second.
    tagVis.updateAfterTransition();
    _scheduleMapExitCleanup(__oldCenterId);

    // Unconditional safety-net sweep after the transition settles. The per-mode recovery paths cover the common
    // transitions, but several entries fall through: search to map with nothing hidden, list to map with no prior
    // filter, and some history navigations.
    requestAnimationFrame(() => {
        _scheduleImageHealthSweep(_transitionRemainingMs(TRANS_TAIL_MS + 120));
    });
}

/** Tracks the outgoing monad centre's image while it fades out, so a follow-up
 *  swap can cancel/clean up its pinned transform before reusing the element. */
let _monadLeaveImg = null;

/** Enter monad view for the current selection (center item + related items). */
// Title pin for the item being selected (see the hold in switchToMonadView), tracked so a rapid second selection releases the first item's pin instead of stranding it.
let _selHoldArticle = null;
/** Hold hover off for the length of an item morph: see body.item-morphing. Re-armed rather than stacked, so a second selection mid-move extends the lock instead of ending it early. */
function _lockHoverForMorph() {
    document.body.classList.add('item-morphing');
    _after('morph.hoverLock', () => document.body.classList.remove('item-morphing'), UI_TRANS_MS + 40);
}

/** Drop the selection title pin now. The map exit re-arms it on a timer instead: see _holdLabelThroughExit. */
function _releaseSelectLabelHold() {
    _cancel('monad.selectLabelHold');
    if (_selHoldArticle) _selHoldArticle.classList.remove('select-label-hold', 'select-hover-hold', 'exit-hover-hold');
    _selHoldArticle = null;
}

/** Drop a lingering title now, for the paths that change what is on screen before its timer is up: a view switch, or a third selection while the second is still settling. */
function _releaseLingerLabel() {
    _cancel('monad.lingerLabel');
    if (_selLingerArticle) _selLingerArticle.classList.remove('label-linger');
    _selLingerArticle = null;
}

/* How long the departing item keeps its title after the move has landed, before it fades on the labels' own
   clock. Long enough to find the item again; short enough that the map isn't left with one label standing. */
const MAP_RETURN_LABEL_HOLD_MS = 600;
const MONAD_SWAP_LABEL_HOLD_MS = 150;

/* The article whose title is riding out a move it is no longer the subject of. Separate from _selHoldArticle, which belongs to the item being selected: during a swap both are pinned at once, on opposite errands. */
let _selLingerArticle = null;

/** Hold a departing centre's title through the move and a beat beyond, then let it fade on the labels' own clock.
 *  label-linger rather than select-label-hold because the item may land as monad-low, which takes it out of paint entirely; the class has to keep the article rendered as well as the title lit. */
function _lingerLabelOnLeaving(article, ms) {
    if (!article) return;
    if (_selLingerArticle && _selLingerArticle !== article) {
        _selLingerArticle.classList.remove('label-linger');
    }
    _selLingerArticle = article;
    article.classList.add('label-linger');
    _cancel('monad.lingerLabel');
    _after('monad.lingerLabel', () => {
        if (_selLingerArticle) _selLingerArticle.classList.remove('label-linger');
        _selLingerArticle = null;
    }, UI_TRANS_MS + (ms || 0));
}

/** Leaving the monad: pin the departing centre's title for the move and a beat beyond, so the eye can follow the
 *  item back to its place rather than losing it the moment the class changes and the overview's labels-hidden
 *  state takes over. */
function _holdLabelThroughExit(id) {
    const art = id ? _articleById(id) : null;
    if (!art) { _releaseSelectLabelHold(); return; }
    if (_selHoldArticle && _selHoldArticle !== art) {
        _selHoldArticle.classList.remove('select-label-hold', 'select-hover-hold', 'exit-hover-hold');
    }
    _selHoldArticle = art;
    art.classList.add('select-label-hold');
    // Hover geometry is the monad's, not the map's, so it goes at once; only the visibility pin stays.
    art.classList.remove('select-hover-hold');
    _cancel('monad.selectLabelHold');
    _after('monad.selectLabelHold', () => {
        if (_selHoldArticle) {
            _selHoldArticle.classList.remove('select-label-hold', 'select-hover-hold', 'exit-hover-hold');
        }
        _selHoldArticle = null;
    }, UI_TRANS_MS + MAP_RETURN_LABEL_HOLD_MS);
}

/* ══ MONAD VIEW (CONTINUED) ════════════════════════════════════════════════ */

/* The item switchToMonadView is currently on its way to. The image preload inside it can defer the switch and finish asynchronously, and this is what says whether the answer is still wanted by the time it does: see the re-entry there. */
let _monadPendingId = null;

/* One motion, not three. The phases were there because an item dropping below the cutoff lands as monad-low,
   which hides it in one frame (content-visibility, forced scale 0) rather than fading it. monad-leaving already
   solves that for the outgoing centre: it holds the item painted and gives it transform and opacity transitions
   for the length of the move. */
function switchToMonadView(itemId, updateHash = true, animate = true, _isShuffle = false) {
    _monadPendingId = itemId;
    // From the grid the monad is entered in place: the map underneath has no positions to animate from, and the grid's own fade-out over it is the transition.
    if (viewMode === 'grid') { _exitGridView(); animate = false; }
    const item = _getTagItemById()[itemId];
    // Cancel any pending monad-related reveals from earlier transitions
    _cancel('monad.relatedReveal', 'monad.staggerReveal', 'monad.staggerRevealFrame', 'monad.openSettle', 'monad.closeAfterCollapse');
    // Cancel any pending map exit cleanup (prevents stale dimension/tier changes)
    _cancelMapExitCleanup();
    // Clear any pinned image dimensions left by a previous monad→map transition.
    {
        const prevCenterArt = _centerArticle();
        const prevCenterImg = prevCenterArt ? prevCenterArt.querySelector('img') : null;
        if (prevCenterImg) {
            prevCenterImg.style.removeProperty('width');
            prevCenterImg.style.removeProperty('height');
            prevCenterImg.style.removeProperty('transition');
            prevCenterImg.style.removeProperty('--scale');
        }
    }
    if (!item) return;

    // Detail fields exist only while an item is (recently) the centre. Built here, before any FLIP measurement, so the insertion can't invalidate layout mid-move.
    _ensureDetailContent(item);

    // Hold the incoming item's title visible for the whole selection sequence.
    const _selArt = getOrCreateArticle(item);
    if (_selHoldArticle && _selHoldArticle !== _selArt) {
        _selHoldArticle.classList.remove('select-label-hold', 'select-hover-hold', 'exit-hover-hold');
    }
    _selHoldArticle = _selArt;
    _selArt.classList.add('select-label-hold');
    // select-hover-hold additionally freezes the hover geometry for the move, but only when the item really was
    // hovered: a hash, keyboard or see-also selection never was, and pinning hover there would pop the label up
    // instead of stopping it dropping.
    if (_selArt.matches(':hover')) {
        _selArt.classList.add('select-hover-hold');
    }
    _cancel('monad.selectLabelHold');
    _after('monad.selectLabelHold', function() {
        if (_selHoldArticle) _selHoldArticle.classList.remove('select-label-hold', 'select-hover-hold', 'exit-hover-hold');
        _selHoldArticle = null;
    }, UI_TRANS_MS + 350);

    // Entering a monad cancels any tag filter, but DOM class cleanup is deferred to setupMonadClasses() so filtered-out items don't reappear for a frame. Save the full pre-monad state for the return trip.
    if (_isShuffle) {
        // Shuffle jumps to an unrelated item, so the zoom, pan and filter the user was looking at have no relationship to where they land: forget the camera and let leaving return to the default unfiltered map.
        _savedMapCamera = null;
    } else if (_isPanelView()) {
        // The list and grid have no camera, and zoom/panX/panY still hold a map the user has navigated away from:
        // snapshotting it here is how a stale pre-list camera came back on map to list to monad to map.
        _savedMapCamera = null;
    } else if (viewMode !== 'monad') {
        _savedMapCamera = {
            zoom: zoom, panX: panX, panY: panY,
            activeTag: (activeTag || '').trim(),
            searchQuery: (searchQuery || '').trim(),
            viewMode: viewMode,
            // Search-view returns also need the subset-fit zoom bookkeeping reinstated, or later fit comparisons work against a stale value.
            subsetFitZoom: _subsetFitZoom
        };
    } else if (_savedMapCamera) {
        // Monad-to-monad jump: the original map context is more than one step behind, so a plain exit should return to
        // the default map rather than a stale filter.
        _savedMapCamera.stale = true;
    }
    _clearDeferredTagHideState();
    /* The tag is KEPT. This is the line that made an item opened from a filtered map forget what it was opened
       inside: the address was written afterwards, from state that had already been emptied, so it came out as a bare
       id and the close returned to the whole collection. */

    _closeOverlaysForViewChange();

    // Snapshot each item's current screen position before changing anything
    const previousMode = viewMode;

    // First list-to-monad entry can jitter while the centre image is on a placeholder ratio or the large tier hasn't decoded, so preload once and restart the transition with stable intrinsic dimensions.
    if (previousMode === 'list' && animate) {
        const preArticle = getOrCreateArticle(item);
        const preImg = preArticle ? preArticle.querySelector('img') : null;
        const meta = imageMeta[itemId];
        const hasStableMeta = !!(meta && meta.nw && meta.nh);
        const hasDecodedImg = !!(preImg && preImg.complete && preImg.naturalWidth > 0 && preImg.naturalHeight > 0);
        if ((!hasStableMeta || !hasDecodedImg) && !item._monadPreloading) {
            item._monadPreloading = true;
            if (preArticle) preArticle.classList.add('monad-pending');
            Promise.allSettled([
                _preloadTier(itemId, 'l')
            ]).then(() => {
                item._monadPreloading = false;
                if (preArticle) preArticle.classList.remove('monad-pending');
                const imgNow = preArticle ? preArticle.querySelector('img') : null;
                if (imgNow) setImgTier(imgNow, 'l');
                // Was `viewMode === 'list' && listSelectedId === itemId`, which described exactly one way of getting here.
                if (_monadPendingId === itemId) {
                    switchToMonadView(itemId, updateHash, animate);
                }
            });
            return;
        }
    }
    /* #list-view is an opaque fixed overlay above main, so the class has to come off or the detail is built underneath it and never seen. */
    if (previousMode === 'list') document.body.classList.remove('list-view');
    const oldSq = getSquareSize();
    const buffer = 0.04;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const oldPositions = {};

    if (animate) {
        if (previousMode === 'map') {
            // Loop over all items.
            for (const it of items) {
                const raw = itemRawPos(it, oldSq, buffer);
                const pos = wrapToViewport(raw.x + panX, raw.y + panY, oldSq, vw, vh);
                oldPositions[it.id] = pos;
            }
        } else if (previousMode === 'monad' || previousMode === 'search') {
            // Loop over all items.
            for (const it of items) {
                const article = getOrCreateArticle(it);
                // Read cached translate (set by _setArticleTranslate).
                if (typeof article._tx === 'number' && typeof article._ty === 'number') {
                    oldPositions[it.id] = { x: article._tx, y: article._ty };
                }
            }
        }
    }

    const previousMonadId = selectedMonadId;
    // Every related item is on the ring before and after a monad-to-monad swap, so they all glide to their new radius.

    // A previous swap may still be fading out its outgoing centre's image (pinned inline, see the deferred fade below): cancel and clean it up so this swap starts from a clean element.
    if (_monadLeaveImg) {
        clearTimeout(_monadLeaveImg._monadLeaveTimer);
        _monadLeaveImg._monadLeaveTimer = null;
        _monadLeaveImg.style.removeProperty('transition');
        _monadLeaveImg.style.removeProperty('transform');
        _monadLeaveImg.style.removeProperty('opacity');
        _monadLeaveImg = null;
    }
    for (let i = 0, len = items.length; i < len; i++) {
        // Clear any stale "leaving" flag from a previous swap (see below).
        getOrCreateArticle(items[i]).classList.remove('monad-leaving');
    }

    // Everything that was on the ring and won't be: painted and faded for the length of the move, rather than cut in one frame by monad-low's content-visibility. The outgoing centre gets the same class just below.
    if (animate && previousMode === 'monad' && previousMonadId && previousMonadId !== itemId) {
        for (let i = 0, len = items.length; i < len; i++) {
            const it = items[i];
            if (!it._mc || it.id === itemId || it.id === previousMonadId) continue;
            const was = it._mc[previousMonadId];
            const will = it._mc[itemId];
            if (was && will && !was.isLow && will.isLow) {
                getOrCreateArticle(it).classList.add('monad-leaving');
            }
        }
    }

    // Mark the outgoing centre so it eases to its new place instead of snapping: it is the one low item that was
    // fully visible, so the monad-low transition skip and the FLIP layer optimisation would otherwise freeze it.
    if (animate && previousMode === 'monad' && previousMonadId && previousMonadId !== itemId) {
        const _leavingArt = _articleById(previousMonadId);
        if (_leavingArt) {
            _leavingArt.classList.add('monad-leaving');
            // Its title travels with its image and fades a moment after the move, as it does on the way back to the map.
            _lingerLabelOnLeaving(_leavingArt, MONAD_SWAP_LABEL_HOLD_MS);
        }
        /* And taken off again once the move is over. Not in setupMonadClasses: that runs inside this same task, which is
           too early; the class would be gone before the transition it was added for could start. */
        _cancel('monad.leaveClear');
        _after('monad.leaveClear', () => {
            for (let i = 0, len = items.length; i < len; i++) {
                const a = items[i] && items[i]._article;
                if (a) a.classList.remove('monad-leaving');
            }
        }, UI_TRANS_MS + TRANS_TAIL_MS);
    }

    _setViewMode('monad');
    selectedMonadId = itemId;
    _selectedMonadItem = item;
    /* The query is kept for the same reason the tag above is: an item opened out of a set of search results belongs
       to those results, and dropping the query here is what made the address, the close and a reload all forget
       them. searchScores go with it, since the ranking is what the subset means. */
    
    // Clear and hide search input (searchInput/searchBox cached at module level)
    searchInput.value = '';
    document.body.classList.remove('search-has-query');
    searchBox.classList.remove('open');
    
    // A new selection is never opened mid-read: clear the expanded state before any position is computed, so the ring is laid out at its resting radius. No redraw: the switch runs its own update() at the end.
    _setMonadCenterFront(false);

    // The monad is a single state at zoom 1. Entering sets it outright, and the FLIP below morphs map positions straight into the ring in one motion; --zoom is then eased from where the map left it, purely to carry the text reveal, and armed just before the update() at the end.
    const _enterMorph = animate && previousMode !== 'monad';
    zoom = 1;
    panX = 0;
    panY = 0;
    // Mobile: reset the native body scroll too. Mobile monad zoom 1 uses body overflow-y: auto for the detail text,
    // so a new monad would inherit the previous scroll position; showing it mid-page and breaking pull-to-zoom-out,
    // which only arms near scrollY 0.
    if (isMobile) {
        _resetAllScrollTops();
    }
    
    // Classify items by travel distance
    // Precompute which items become monad-low (invisible, below the attraction cutoff, not linked). They need no CSS transitions, and skipping them halves Safari's compositor layer count.
    const _precomputedLow = new Set();
    if (animate) {
        for (let i = 0, len = items.length; i < len; i++) {
            const it = items[i];
            if (it.id === selectedMonadId) continue;
            if (it._mc && it._mc[selectedMonadId] && it._mc[selectedMonadId].isLow) {
                _precomputedLow.add(it.id);
            }
        }
    }
    if (animate && Object.keys(oldPositions).length > 0) {
        // Loop over all items.
        for (const it of items) {
            const old = oldPositions[it.id];
            if (!old) continue;

            // Start where the item currently is; update() writes the ring position and the CSS transition covers the distance.
            const startX = old.x;
            const startY = old.y;

            const article = getOrCreateArticle(it);

            article.style.transition = 'none';
            _setArticleTranslate(article, startX, startY);
        }
        _reflow();

        // Re-enable transitions, skipping items that will be invisible so Safari doesn't create layers for them: except the outgoing centre (monad-leaving), which was fully visible and must animate out rather than snap.
        for (const it of items) {
            if (_precomputedLow.has(it.id) && it.id !== previousMonadId) continue;
            getOrCreateArticle(it).style.transition = '';
        }
    }

    // Apply monad classes after starting positions committed
    document.body.classList.add('monad-view');
    document.body.classList.remove('search-view');
    // On mobile, also add class to html for scroll support (for browsers without :has())
    if (isMobile) {
        document.documentElement.classList.add('monad-view-active');
    }

    // During list → monad transition, keep peripherals hidden until the center image lands.
    if (previousMode === 'list' && animate) {
        document.body.classList.add('monad-related-hidden');
        _cancel('monad.relatedReveal');
        const myToken = ++_monadRelatedRevealToken;
        _after('monad.relatedReveal', () => {
            if (_monadRelatedRevealToken !== myToken) return;
            if (viewMode === 'monad' && selectedMonadId === itemId) {
                document.body.classList.remove('monad-related-hidden');
            }
        }, 600);
    } else {
        document.body.classList.remove('monad-related-hidden');
    }


    // FLIP pattern for img scale transitions (cross-browser, including Safari).
    // First: snapshot current computed transforms before class swap.
    const newCenterArticle = getOrCreateArticle(item);
    const newCenterImg = newCenterArticle.querySelector('img');
    // A new centre starts clean: drop the measured fit and the content key so the next measure runs, and clear any inline transition/max-height and pending transitionend listener left on the previous description.
    {
        const _newTextEl = newCenterArticle.querySelector('.detail-fields .text');
        if (_newTextEl) {
            _newTextEl.classList.remove('text-fits-all');
            if (_newTextEl.dataset) {
                delete _newTextEl.dataset.contentKey;
            }
            _newTextEl.style.removeProperty('transition');
            _newTextEl.style.removeProperty('max-height');
            _newTextEl.style.removeProperty('--text-fit-max');
            _newTextEl.style.removeProperty('--text-fit-slope');
            if (_newTextEl._expandEndHandler) {
                _newTextEl.removeEventListener('transitionend', _newTextEl._expandEndHandler);
                _newTextEl._expandEndHandler = null;
            }
            if (_newTextEl._collapseEndHandler) {
                _newTextEl.removeEventListener('transitionend', _newTextEl._collapseEndHandler);
                _newTextEl._collapseEndHandler = null;
            }
            if (_newTextEl._collapseFailsafeTimer) {
                clearTimeout(_newTextEl._collapseFailsafeTimer);
                _newTextEl._collapseFailsafeTimer = null;
            }
            _newTextEl._savedScrollY = null;
        }
    }
    let oldCenterImg = null;
    let newImgSnap = null, oldImgSnap = null;
    let oldBorderWidthSnap = null, oldBorderColorSnap = null;
    if (animate) {
        if (newCenterImg && newCenterImg.complete && newCenterImg.naturalWidth > 0 && newCenterImg.naturalHeight > 0) {
            newImgSnap = getComputedStyle(newCenterImg).transform;
        }
        if (previousMode === 'monad' && previousMonadId) {
            const oldCenterArticle = getOrCreateArticle(items.find(i => i.id === previousMonadId));
            oldCenterImg = oldCenterArticle ? oldCenterArticle.querySelector('img') : null;
            if (oldCenterImg) {
                const oldCenterStyle = getComputedStyle(oldCenterImg);
                oldImgSnap = oldCenterStyle.transform;
                oldBorderWidthSnap = oldCenterStyle.borderWidth;
                oldBorderColorSnap = oldCenterStyle.borderColor;
            }
        }
    }

    // Last: apply all class changes + final positions (target state).
    if (animate) triggerAnimation();
    setupMonadClasses();


    // Image tiering: keep thumbnails light; the monad center is upgraded lazily when it actually grows (see update()).
    try {
        if (previousMonadId && previousMonadId !== itemId) {
            const oldA = _articleById(previousMonadId);
            const oldImg = oldA ? oldA.querySelector('img') : null;
            if (oldImg) setImgTier(oldImg, 's');
        }
        const centerA = _articleById(itemId);
        const centerImg = centerA ? centerA.querySelector('img') : null;
        if (centerImg) setImgTier(centerImg, 'l');
    } catch (err) { /* noop */ }

    // Keep memory low (esp. iOS Safari)
    purgeHighResImages();

    // Clear notransition BEFORE update: on mobile, touchstart adds notransition
    // which has higher specificity than animated, killing CSS transitions
    document.body.classList.remove('notransition');
    _cancel('render.notransitionClass');
    isInteracting = false;

    // Force text geometry measurement with a layout flush so the first updateMonadView()
    // computes the correct centered position: prevents a jump after the transition.
    {
        const _geomArticle = getOrCreateArticle(item);
        _reflow(_geomArticle);
        _measureMonadTextGeometry(_geomArticle);
    }

    // Monad-to-monad swap origin: the incoming centre glides from its CURRENT monad position (the FLIP start
    // committed above); ring position at zoom 0, linked-rail position at zoom 1.

    // A selection supersedes any --zoom ease still in flight, including one this function armed a moment ago for the
    // item being replaced.
    _cancel('zoom.transition');
    if (_zoomAnimating) {
        document.documentElement.style.transition = '';
        _zoomAnimating = false;
        _zoomAnimatingTarget = null;
    }

    // Hover is off for the length of the move. The item under the pointer is the one changing role (a ring item becoming the centre, most often) and letting it swap one set of hover rules for another halfway through puts a 0.15s reaction inside a 0.75s move.
    if (animate) _lockHoverForMorph();

    // Ease --zoom from the value the map was left at to 1 over the position morph, so the description reveal fades
    // in while the centre travels instead of snapping when update() writes --zoom = 1.
    const _swapReveal = animate && previousMode === 'monad' && !isMobile;
    const _armZoomEase = (_enterMorph || _swapReveal) && !isMobile;
    // Measure the title once the monad classes are on and a layout has been flushed, so the FIRST update() centres
    // on its real height. setupMonadClasses measures too, but from inside its own write loop, before the browser has
    // re-laid out under the new classes.
    {
        const _centerA = _articleById(itemId);
        if (_centerA) {
            void _centerA.offsetHeight;
            _measureMonadTextGeometry(_centerA);
        }
    }

    if (_armZoomEase) {
        {
            // Put --zoom at the bottom of the ramp with no transition, and tell the JS side it is there, so the update()
            // below writes 1 again and the ease has the whole range to travel.
            const _from = MONAD_SWAP_REVEAL_FROM;
            const _de = document.documentElement;
            _de.style.transition = 'none';
            _de.style.setProperty('--zoom', _from);
            void _de.offsetHeight;
            _lastCSSZoom = _from;
            _prevZoomVal = _from;
        }
        document.documentElement.style.transition =
            `--zoom ${MONAD_TEXT_REVEAL_MS}ms ease-in-out ${MONAD_TEXT_REVEAL_DELAY_MS}ms`;
        // Bridge transitions for the centre's text elements (see body.monad-direct-enter in CSS).
        document.body.classList.add('monad-direct-enter');
        setTimeout(() => document.body.classList.remove('monad-direct-enter'), MONAD_TEXT_REVEAL_DELAY_MS + MONAD_TEXT_REVEAL_MS + 100);
    }

    update();

    if (_armZoomEase) {
        _zoomAnimating = true;
        _zoomAnimatingTarget = 1;
        _after('zoom.transition', () => {
            document.documentElement.style.transition = '';
            _zoomAnimating = false;
            _zoomAnimatingTarget = null;
            update();
        }, MONAD_TEXT_REVEAL_DELAY_MS + MONAD_TEXT_REVEAL_MS + 30);
    }

    // First-selection correction: the title height comes from the synchronous measurement above, and on an item's first selection (or before a web font lands) that can be off.
    if (_enterMorph) {
        requestAnimationFrame(() => requestAnimationFrame(() =>
            _monadReconcileLayout(itemId)));
    }

    // Keep netvis redrawing while items animate: in monad-desktop the canvas stays visible, but without a keep-window no frames are scheduled during the CSS transition and stale edges linger until the next interaction.
    if (!isMobile) _netRequestDraw(UI_TRANS_MS + 120);

    // Invert and play: set snapshots with transition:none, flush, release. Skipped for list-to-monad, where the article img was invisible so the FLIP snapshot is a tiny scale that doesn't match the list thumb the user saw.
    if (animate && previousMode !== 'map' && previousMode !== 'list' && newImgSnap) {
        // Invert: put back snapshot transforms, suppress transition
        if (newCenterImg) {
            newCenterImg.style.transition = 'none';
            newCenterImg.style.transform = newImgSnap;
        }
        if (oldCenterImg && oldImgSnap) {
            oldCenterImg.style.transition = 'none';
            oldCenterImg.style.transform = oldImgSnap;
            if (oldBorderWidthSnap) oldCenterImg.style.borderWidth = oldBorderWidthSnap;
            if (oldBorderColorSnap) oldCenterImg.style.borderColor = oldBorderColorSnap;
        }
        // Flush: force browser to commit the inverted state
        _reflow();
        // Play: remove overrides → transition from snapshot to CSS target
        if (newCenterImg) {
            newCenterImg.style.transition = '';
            newCenterImg.style.transform = '';
        }
        if (oldCenterImg) {
            oldCenterImg.style.transition = '';
            oldCenterImg.style.transform = '';
            clearTimeout(oldCenterImg._borderReleaseTimer);
            oldCenterImg._borderReleaseTimer = setTimeout(() => {
                oldCenterImg.style.removeProperty('border-width');
                oldCenterImg.style.removeProperty('border-color');
            }, UI_TRANS_MS + 30);
        }
    }

    // Deferred fade-out for an outgoing centre that lands invisible. monad-low collapses it in one frame via
    // content-visibility:hidden and --scale: 0, and since --scale isn't registered with @property,
    // transition:transform can't interpolate it; the image snaps to nothing.
    if (animate && !isMobile && previousMonadId && previousMonadId !== itemId && oldImgSnap && oldImgSnap !== 'none') {
        const _leaveArt = _articleById(previousMonadId);
        const _leaveImg = _leaveArt ? _leaveArt.querySelector('img') : null;
        if (_leaveArt && _leaveImg &&
            (_leaveArt.classList.contains('monad-low') || _leaveArt.classList.contains('monad-zero'))) {
            // Hold the image at its centre transform and opacity (overriding monad-low's --scale: 0), commit that, then ease it down as the article fades.
            _leaveImg.style.setProperty('transition', 'none', 'important');
            _leaveImg.style.setProperty('transform', oldImgSnap, 'important');
            _leaveImg.style.setProperty('opacity', '1', 'important');
            void _leaveImg.offsetHeight;
            _leaveImg.style.setProperty('transition', 'transform var(--uiTrans) var(--uiEase)', 'important');
            _leaveImg.style.setProperty('transform', oldImgSnap + ' scale(0.4)', 'important');
            _monadLeaveImg = _leaveImg;
            clearTimeout(_leaveImg._monadLeaveTimer);
            _leaveImg._monadLeaveTimer = setTimeout(function () {
                _leaveImg._monadLeaveTimer = null;
                _leaveImg.style.removeProperty('transition');
                _leaveImg.style.removeProperty('transform');
                _leaveImg.style.removeProperty('opacity');
                if (_monadLeaveImg === _leaveImg) _monadLeaveImg = null;
            }, UI_TRANS_MS + 50);
        }
    }

    // Update page title
    _updateDocTitle();
    
    // One state, one address: the item with whatever filter it was opened inside.
    if (updateHash) {
        const _newHash = _viewAddress('map', { i: itemId });
        if (window.location.hash !== _newHash) {
            history.pushState(null, '', _newHash);
        }
    }
    
    // On mobile, scroll to top for the scrollable monad view
    if (isMobile) {
        setTimeout(() => {
            window.scrollTo(0, 0);
            document.body.scrollTop = 0;
            document.documentElement.scrollTop = 0;
        }, 50);
    }

    /* The fades come from whether the description overflows, and on the way in it always
       does: --zoom starts at the bottom of the ramp, so max-height is a fraction of its final value for the length
       of the reveal. */
    _cancel('monad.textMask');
    _after('monad.textMask', () => {
        if (viewMode === 'monad') _syncMonadTextMask();
    }, MONAD_TEXT_REVEAL_DELAY_MS + MONAD_TEXT_REVEAL_MS + 80);

    // Defer the tag cloud until after the transition so its forced-layout reads don't trigger style recalculation while Safari's compositor is still digesting the class changes (map-to-monad choppiness).
    if (animate) {
        if (isMobile) _earlyMobileItemDetailScrollSpace();
        setTimeout(() => {
            if (viewMode === 'monad' && selectedMonadId === itemId) {
                _scheduleTagCloudUpdate(true);
                // Re-measure mobile scroll space after the transition settles: the immediate call in update() fires before layout is final and clips the tags on items with long descriptions.
                if (isMobile) requestAnimationFrame(() => updateMobileItemDetailScrollSpace());
            }
        }, UI_TRANS_MS + 50);
    } else {
        _scheduleTagCloudUpdate(true);
        if (isMobile) requestAnimationFrame(() => updateMobileItemDetailScrollSpace());
    }

    // List → monad: the bridge animation in the mode-button handler cross-fades while a clone flies.
}

/** Switch to search view. */
function switchToSearchView(query, updateHash = true, restoreCamera = null) {
    if (viewMode === 'grid') _exitGridView();
    // Stub-mode: clear monad cache since we may be leaving monad view.
    const previousMode = viewMode;
    const vh = window.innerHeight;
    // As in switchToMapView: after a list or grid, let the next reconcile apply the stub regime afresh.
    if (previousMode === 'list' || previousMode === 'grid') _stubLastBelow = null;

    // Snapshot current screen positions before changing state
    const oldPositions = {};
    if (previousMode === 'map') {
        // Use direct UMAP positions relative to viewport center.
        const sq = getSquareSize();
        const buffer = 0.04;
        const centerX = __mainCenterX();
        // Loop over all items.
        for (const it of items) {
            const raw = itemRawPos(it, sq, buffer);
            const x = raw.x + panX + centerX - sq / 2;
            const y = raw.y + panY + (vh - sq) / 2;
            oldPositions[it.id] = { x, y };
        }
    } else if (previousMode === 'search' || previousMode === 'monad') {
        // Loop over all items.
        for (const it of items) {
            const article = getOrCreateArticle(it);
            // Read cached translate (set by _setArticleTranslate).
            if (typeof article._tx === 'number' && typeof article._ty === 'number') {
                oldPositions[it.id] = { x: article._tx, y: article._ty };
            }
        }
    }

    _setViewMode('search');
    _mobileMapDropFiles();
    selectedMonadId = null;
    _selectedMonadItem = null;
    searchQuery = query;
    searchScores = query.length >= 2 ? computeSearchScores(query) : {};

    // The breathing layout and its fit sit behind a memo keyed on the match-id list, which is right while a query is
    // edited in place but survives a trip through the monad: the one case where the fit MUST run again.
    if (previousMode !== 'search') _searchBreathingKey = '';

    // Zoom out to the full layout, unless returning from a monad with a saved camera, then reinstate it exactly, centred overview or zoomed state alike. The one-shot flag below keeps updateSearchView's breathing fit from re-framing over the restored values.
    if (restoreCamera) {
        zoom = restoreCamera.zoom || 0;
        panX = restoreCamera.panX || 0;
        panY = restoreCamera.panY || 0;
        _subsetFitZoom = restoreCamera.subsetFitZoom || 0;
    } else {
        zoom = 0;
        panX = 0;
        panY = 0;
    }
    // Assigned unconditionally, not only in the restore branch: it is a one-shot consumed by the breathing block, so leaving it alone let a stale true survive from an entry whose block never ran.
    _suppressSearchFitOnce = !!restoreCamera;

    document.body.classList.remove('monad-view', 'monad-zoomed-in', 'monad-detail-visible');
    document.body.classList.add('search-view');
    document.documentElement.classList.remove('monad-view-active', 'monad-zoomed-in');

    // Clean up monad, stagger, and map artifacts
    for (const it of items) {
        const article = getOrCreateArticle(it);
        article.className = article.className
            .replace(/\b(monad-center|monad-show-label|monad-native-size|monad-zero|monad-low|monad-linked|monad-stagger-hide|monad-text-geom-ready|tag-filtered-out|map-offscreen|labels-culled)\b/g, '')
            .replace(/  +/g, ' ').trim();
        it._mapOffscreen = false;
        it._labelsCulled = false;
        article.style.removeProperty('--attraction');
        // Clean up inline --scale and pinned dimensions on images
        const img = article.querySelector('img');
        if (img) {
            img.style.removeProperty('--scale');
            img.style.removeProperty('width');
            img.style.removeProperty('height');
            img.style.removeProperty('transition');
        }
    }

    // Animate from previous positions
    if ((previousMode === 'map' || previousMode === 'monad') && Object.keys(oldPositions).length > 0) {
        // Set starting positions (no transition) then let CSS animation take over
        for (const it of items) {
            const article = getOrCreateArticle(it);
            const old = oldPositions[it.id];
            if (!old) continue;
            article.style.transition = 'none';
            _setArticleTranslate(article, old.x, old.y);
        }

        _reflow();
        // Loop over all items.
        for (const it of items) {
            getOrCreateArticle(it).style.transition = '';
        }

        triggerAnimation();
        update();
        purgeHighResImages();
    } else {
        // Already in search (query changed): just update positions
        triggerAnimation();
        update();
        purgeHighResImages();
    }

    // Update page title and hash
    if (query.length >= 2) {
        _updateDocTitle();
        if (updateHash) {
            history.replaceState(null, '', '#q:' + encodeURIComponent(query));
        }
    } else {
        _updateDocTitle();
    }

    _scheduleTagCloudUpdate(true);
}

let zoom = 0;
let panX = 0;
let panY = 0;

let _monadRelatedRevealToken = 0;

// Ensure an <img> has a stable intrinsic size before we use it for %-based transforms (iOS Safari can report 0-height briefly).
let _pendingMonadSwitchToken = 0;
/** Helper: when img ready. */
// Ceiling on the decode wait below, which exists only to stop mobile Safari measuring translateY(-100%) against
// a not-yet-decoded image box: cosmetic, not correctness. Unbounded, it held the selection open for as long as
// the thumbnail's fetch took.
const _IMG_READY_MAX_WAIT_MS = 120;
function _whenImgReady(img) {
    if (!img) return Promise.resolve();
    const done = () => {
        if (img.decode) {
            try { return img.decode().catch(() => {}); } catch (e) { /* noop */ }
        }
        return Promise.resolve();
    };
    const ready = (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0)
        ? done()
        : new Promise((resolve) => {
            const onDone = () => {
                img.removeEventListener('load', onDone);
                img.removeEventListener('error', onDone);
                Promise.resolve(done()).then(resolve);
            };
            img.addEventListener('load', onDone, { once: true });
            img.addEventListener('error', onDone, { once: true });

            // If it completes between checks, resolve quickly.
            if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) onDone();
        });

    // Whichever comes first: the image being ready, or the cap.
    return Promise.race([
        ready,
        new Promise((resolve) => setTimeout(resolve, _IMG_READY_MAX_WAIT_MS))
    ]);
}


// Minimum zoom, when a tag/search filter is active, prevent zooming out
// beyond the level that already fits all filtered items in the viewport.
let _subsetFitZoom = 0; // updated by _fitVisibleBounds / search view fit
function getMinZoom() {
    if ((activeTag || (searchQuery || '').trim()) && _subsetFitZoom > 0) {
        return _subsetFitZoom;
    }
    return 0;
}


// The wheel/pinch/keyboard steps are expressed as zoom-per-input and were calibrated at range 18, so a wider range would make the same gesture cover proportionally more growth.
const _MAP_ZOOM_INPUT_ADJ = 18 / _MAP_ZOOM_RANGE;

/* Zoom-input gain. Every path multiplies its base step by (1 + k * zoom); the k values live in one table below so the paths can be compared. */
const _ZOOM_GAIN_K = {
    wheel:    10,
    keyboard: 6,
    // Pinch ran at k = 0 (a 22.8x falloff). k = _MAP_ZOOM_RANGE removes the falloff entirely but reads as too fast,
    // so this sits below it: ~1.5x residual, still short of the wheel's 2.1x.
    pinch:    _MAP_ZOOM_RANGE * 0.64,
};
function _zoomStepGain(path) {
    return 1 + _ZOOM_GAIN_K[path] * _clamp01(zoom);
}

// Deep map tier thresholds with hysteresis, so wheel jitter at the boundary doesn't thrash image loads. The subtitle/authors/source reveal needs no JS gate: CSS drives it from --zoom 0/1 opacity gates; the earlier rungs are JS-gated on the same scale.
/** On a phone the map holds no image files: whatever the detail loaded goes back to its inline thumbnail as soon as
 *  the map returns, rather than after the exit transition. */
function _mobileMapDropFiles() {
    if (!isMobile) return;
    for (let i = 0, len = items.length; i < len; i++) {
        const article = items[i]._article;
        const img = article && article.firstElementChild;
        if (img && img.tagName === 'IMG' && img.dataset.tier === 'l') setImgTier(img, 's');
    }
}

/* ══ MAP CAMERA & RENDERING ════════════════════════════════════════════════ */

// The UMAP square size at current zoom
function getSquareSize() {
    return getBaseSquareSize() * (1 + zoom * _MAP_ZOOM_RANGE);
}

// Base (zoom 0) layout square: same calculation as getSquareSize without the zoom factor, for zoom-around math that needs a base size accounting for the tag-sidebar occlusion.
function getBaseSquareSize() {
    const vw = __mainVW();
    const vh = window.innerHeight;
    // In portrait-ish viewports the square would fill the full width, so subtract symmetric left/right padding (matching the natural top/bottom buffer) plus the tag-sidebar occlusion on the right.
    const padLR = vw * 0.04;
    const hInset = padLR * 2 + __mapTagOcclusionPx();
    return Math.min(vw - hInset, vh);
}

// Clamp pan so some of the content stays visible. The old symmetric +/-sq/2 clamp assumed content in [0,1]^2
// with the square centred on the visible area, which breaks twice: breathed layouts write _dx up to ar ~2.5, so
// items on the right became unreachable when zoomed in; and the tag sidebar means the visible map area is
// narrower than the window.
function clampPan() {
    if (viewMode !== 'map' && viewMode !== 'search') return;
    const sq = getSquareSize();
    const buffer = 0.04;
    const bScale = 1 - 2 * buffer;
    const vw = __mainVW();
    const vh = window.innerHeight;
    const cx = __mainCenterX();
    const tagOcc = __mapTagOcclusionPx();

    // Content extent in layout coords: the breathing layout writes outside [0,1] when ar > 1, unfiltered UMAP fits inside it. Iterating items is cheap (~310) and correct without tracking state.
    let minDx = Infinity, maxDx = -Infinity, minDy = Infinity, maxDy = -Infinity;
    let any = false;
    for (let i = 0, len = items.length; i < len; i++) {
        const dx = items[i]._dx;
        const dy = items[i]._dy;
        if (dx == null || dy == null) continue;
        if (dx < minDx) minDx = dx;
        if (dx > maxDx) maxDx = dx;
        if (dy < minDy) minDy = dy;
        if (dy > maxDy) maxDy = dy;
        any = true;
    }
    if (!any) {
        // Fallback to old behaviour if items haven't been positioned yet.
        const m = sq * 0.5;
        panX = Math.max(-m, Math.min(m, panX));
        panY = Math.max(-m, Math.min(m, panY));
        return;
    }

    // Map layout-coord extents to screen pixels at panX = 0, using pos.x = (buffer + _dx * bScale) * sq + panX + cx - sq/2.
    const contentLeft0 = (buffer + minDx * bScale) * sq + cx - sq / 2;
    const contentRight0 = (buffer + maxDx * bScale) * sq + cx - sq / 2;
    const contentTop0 = (buffer + minDy * bScale) * sq + (vh - sq) / 2;
    const contentBottom0 = (buffer + maxDy * bScale) * sq + (vh - sq) / 2;

    // Keep at least this much content inside the visible area in each
    // dimension. One typical image width / height of slack.
    const keepVisiblePx = 80;
    // The pane covers the left of the content box now, so it comes off the near edge rather than the far one.
    const visibleLeft = Math.min(tagOcc, Math.max(0, vw - 1));
    const visibleRight = vw;
    const visibleTop = 0;
    const visibleBottom = vh;

    // Bounds so at least keepVisiblePx of content overlaps the visible band: panX >= visibleLeft + keepVisiblePx - contentRight0 and panX <= visibleRight - keepVisiblePx - contentLeft0.
    const panXMin = visibleLeft + keepVisiblePx - contentRight0;
    const panXMax = visibleRight - keepVisiblePx - contentLeft0;
    const panYMin = visibleTop + keepVisiblePx - contentBottom0;
    const panYMax = visibleBottom - keepVisiblePx - contentTop0;

    // If the content is smaller than the visible area on an axis the bounds swap, so centre it rather than clamping to a degenerate range.
    if (panXMin <= panXMax) {
        panX = Math.max(panXMin, Math.min(panXMax, panX));
    } else {
        panX = (panXMin + panXMax) / 2;
    }
    if (panYMin <= panYMax) {
        panY = Math.max(panYMin, Math.min(panYMax, panY));
    } else {
        panY = (panYMin + panYMax) / 2;
    }
}

// Compute item position within the square (before wrapping)
function itemRawPos(item, sq, buffer) {
    return {
        x: (buffer + item._dx * (1 - 2 * buffer)) * sq,
        y: (buffer + item._dy * (1 - 2 * buffer)) * sq
    };
}

// Wrap a position into [0, sq) and offset to center the square in the viewport
function wrapToViewport(x, y, sq, vw, vh) {
    return { x: x + __mainCenterX() - sq / 2, y: y + (vh - sq) / 2 };
}

// Choose the wrap offset that places the item closest to a reference screen position
// Returns the screen position (already viewport-centered)
function resetView(animate) {
    // In monad or search view, go directly to map
    if (viewMode === 'monad' || viewMode === 'search') {
        switchToMapView();
        return;
    }
    // Already in map: zoom to min and center
    if (animate) triggerAnimation();
    zoom = getMinZoom();
    panX = 0;
    panY = 0;
    update();
    _scheduleTagCloudUpdate(true);
    if (animate) {
        // The immediate update above samples mid-animation geometry; refresh once the zoom-out has settled: a fixed 560ms timer fired before the 750ms transition finished, leaving edge items outside the viewport and the cloud stale.
        tagVis.updateAfterTransition();
    }
}

// Set when an image load wants to re-measure the monad centre's text geometry while a zoom animation is in flight. Consumed by _flushDeferredMonadGeom, which every zoom-exit path calls, normal or interrupted.
let _monadGeomAfterZoom = null;
function _flushDeferredMonadGeom() {
    const id = _monadGeomAfterZoom;
    if (!id) return;
    _monadGeomAfterZoom = null;
    if (viewMode !== 'monad' || selectedMonadId !== id) return;
    const a = _articleById(id);
    if (!a) return;
    _measureMonadTextGeometry(a);
    update();
}

/** Stop an in-flight CSS zoom animation without a visual discontinuity. The naive cancel (drop the root
 *  transition, clear the flag) snaps --zoom to the animation's TARGET for at least one rendered frame, since the
 *  inline property still holds the destination and the corrective write is deferred to the next update(). */
function _cancelZoomAnimation() {
    if (!_zoomAnimating) return;
    const de = document.documentElement;
    const cv = parseFloat(getComputedStyle(de).getPropertyValue('--zoom'));
    const visual = Number.isFinite(cv) ? cv : zoom;
    de.style.transition = 'none';
    de.style.setProperty('--zoom', visual);
    // Commit the pinned value in its own style pass, before the transition declaration goes away, otherwise removal and new value land together and the engine may render the old target once.
    void de.offsetHeight;
    de.style.transition = '';
    document.body.classList.remove('zoom-animating');
    _zoomAnimating = false;
    _zoomAnimatingTarget = null;
    _cancel('zoom.transition');
    _stopZoomSync();
    // Continue from the visual position, not from whatever the sync loop last wrote (which can be a frame behind) or the destination the JS state already snapped to.
    zoom = visual;
    _lastCSSZoom = visual;
    _prevZoomVal = visual;
    _flushDeferredMonadGeom();
}

/* ══ ZOOM CONTROL & ANIMATION ══════════════════════════════════════════════ */

/** Apply a zoom delta around a screen point, keeping the content under it fixed. Shared by the immediate and coalesced entry points, which differ only in whether the repaint happens now or next frame. */
function _applyZoomDelta(delta, centerX, centerY) {
    if (isMobile && (viewMode === 'map' || viewMode === 'search')) _tuckForZoom(delta);
    // Cancel any running animated zoom (rAF or CSS-driven)
    _cancel('zoom.animation');
    _cancelZoomAnimation();

    const minZoom = (viewMode === 'monad') ? 0 : getMinZoom();
    const oldZoom = zoom;
    zoom = Math.max(minZoom, Math.min(1, zoom + delta));

    // Reset monad scroll offset when zooming out from max

    if (viewMode === 'map' || viewMode === 'search') {
        const vw = __mainVW();
        const vh = window.innerHeight;
        // Use the inset-aware base size so zoom-around math matches the
        // size that getSquareSize() / clampPan() / rendering all use.
        const size = getBaseSquareSize();
        const oldSq = size * (1 + oldZoom * _MAP_ZOOM_RANGE);
        const newSq = size * (1 + zoom * _MAP_ZOOM_RANGE);
        const cx = __mainCenterX();

        // Content point under cursor in the old square
        const _ax = Math.max(0, Math.min(vw, centerX));
        const contentX = _ax - cx + oldSq / 2 - panX;
        const contentY = centerY - (vh - oldSq) / 2 - panY;

        // Scale that point and keep it under the cursor
        const ratio = newSq / oldSq;
        panX = _ax - cx + newSq / 2 - contentX * ratio;
        panY = centerY - (vh - newSq) / 2 - contentY * ratio;
        clampPan();
    }
}

/** Update zoom for the current UI state. */
function updateZoom(delta, centerX, centerY) {
    _applyZoomDelta(delta, centerX, centerY);
    update();
}

// Coalesced variant for high-rate input: the zoom applies now, update() a frame later.
function updateZoomCoalesced(delta, centerX, centerY) {
    _applyZoomDelta(delta, centerX, centerY);
    _scheduleUpdate();
}

// Smooth animated zoom to a target value: CSS-transition driven
let _zoomAnimating = false;
let _zoomAnimatingTarget = null;
let _lastCSSZoom = -1;
// Coarser steps on Safari: each --zoom write invalidates every CSS calc() depending on it, and Safari's calc evaluator is meaningfully slower than Blink's. A larger step cuts invalidations without visible loss, since the JS pan side still runs per frame.
const _ZOOM_CSS_STEP = isMobile ? 0.02 : (isAppleWebKit ? 0.015 : 0.01);

let _savedMapCamera = null; // {zoom, panX, panY, activeTag, searchQuery, viewMode} saved when entering monad
// Set when the user clicks a tag inside the monad detail, meaning "see all items with this keyword", so the monad-to-map transition fits the whole subset instead of restoring the pre-monad camera. Consumed and cleared by switchToMapView.
let _tagClickFitIntent = false;


/** Consume the pre-monad camera snapshot: returns its four numbers and clears
 *  the snapshot, so a later restore can't reuse a camera already spent. */
function _takeSavedCamera() {
    const c = _savedMapCamera || {};
    _savedMapCamera = null;
    return {
        zoom: c.zoom || 0,
        panX: c.panX || 0,
        panY: c.panY || 0,
        subsetFitZoom: c.subsetFitZoom || 0
    };
}

/** Stop zoom sync. */
function _stopZoomSync() {
    _cancel('zoom.syncFrame');
}
/** Start zoom sync. */
function _startZoomSync(durationMs = 550) {
    _stopZoomSync();
    const t0 = performance.now();
    const step = () => {
        if (!_zoomAnimating) { _stopZoomSync(); return; }

        // Read the *visual* zoom from CSS (it is transitioning), and drive JS layout from it.
        const cssZ = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom'));
        if (Number.isFinite(cssZ)) zoom = cssZ;
        if (viewMode === 'monad') {
            updateMonadView();
            // Netvis edges must track the moving items each frame.
            // Synchronous draw: see _netDrawNow comment for rationale.
            if (!isMobile) _netDrawNow();
        }

        // Keep monad classes in sync with the visual zoom (important on mobile).
        _syncMonadDetailVisible();
        const zoomedIn = _isMonadZoomedIn();
        const _wasZoomedIn = document.body.classList.contains('monad-zoomed-in');
        if (zoomedIn !== _wasZoomedIn) {
            // Same guard as the other site: see the note there.
            if (!zoomedIn && _wasZoomedIn && !_isPanelView()) {
                _resetAllScrollTops();
            }
            document.body.classList.toggle('monad-zoomed-in', zoomedIn);
            document.documentElement.classList.toggle('monad-zoomed-in', zoomedIn);
                _syncMonadHash();
        }

        updateMonadCenterTiering();
        purgeHighResImages();

        // Stop after the expected duration (plus a small buffer), or once we're effectively stable.
        const dt = performance.now() - t0;
        if (dt > durationMs + 120 || zoom === 0 || zoom === 1) {
            // Allow one last frame after stability
        }
        _onFrame('zoom.syncFrame', step);
    };
    _onFrame('zoom.syncFrame', step);
}

/** Animate zoom to. */
function animateZoomTo(target, anchorX, anchorY, easeOverride) {
    // Clamp target to current min zoom
    const _azMinZoom = (viewMode === 'monad') ? 0 : getMinZoom();
    target = Math.max(_azMinZoom, Math.min(1, target));
    // Cancel any pending animations
    _cancel('zoom.animation', 'monad.scrollAnim', 'monad.scroll', 'zoom.transition');
    _stopZoomSync();

    const duration = UI_TRANS_MS;
    const ease = easeOverride || UI_EASE;

    // Interrupting a running CSS zoom: snapshot the current VISUAL zoom (the mid-transition computed value) so the pan anchor math and the new transition both start from the right place.
    let visualZoom = zoom;
    if (_zoomAnimating) {
        const cv = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom'));
        if (Number.isFinite(cv)) visualZoom = cv;
        // Force a clean transition restart: drop the old transition, pin --zoom to the current visual value, force a recalc, then re-apply with the new target.
        document.documentElement.style.transition = 'none';
        document.documentElement.style.setProperty('--zoom', visualZoom);
        _lastCSSZoom = visualZoom;
        // Force style recalc so the browser registers the intermediate value
        // before we set the new transition + target.
        void document.documentElement.offsetHeight;
    }

    // Clear any stale inline --scale values from prior wheel interactions
    // (beginInteraction's cleanup timeout may have been cancelled).
    if (viewMode === 'map') {
        for (let i = 0, len = items.length; i < len; i++) {
            const img = items[i]._article && items[i]._article.firstElementChild;
            if (img && img.tagName === 'IMG' && img.style.getPropertyValue('--scale')) {
                img.style.removeProperty('--scale');
            }
        }
    }

    // Pre-compute target pan for map view (keep anchor point stable).
    // Use visualZoom (= actual current zoom) for correct geometry.
    let targetPanX = panX;
    let targetPanY = panY;
    if ((viewMode === 'map' || viewMode === 'search') && anchorX !== undefined) {
        const vw = __mainVW();
        const vh = window.innerHeight;
        const size = getBaseSquareSize();
        const oldSq = size * (1 + visualZoom * _MAP_ZOOM_RANGE);
        const newSq = size * (1 + target * _MAP_ZOOM_RANGE);
        const cx = __mainCenterX();
        const _ax = Math.max(0, Math.min(vw, anchorX));
        const contentX = _ax - cx + oldSq / 2 - panX;
        const contentY = anchorY - (vh - oldSq) / 2 - panY;
        const ratio = newSq / oldSq;
        targetPanX = anchorX - cx + newSq / 2 - contentX * ratio;
        targetPanY = anchorY - (vh - newSq) / 2 - contentY * ratio;
    }

    _suppressHoverForTransition();

    // 1. Remove notransition so CSS transitions can work
    document.body.classList.remove('notransition');
    isInteracting = false;
    _cancel('render.notransitionClass');

    // Mobile skips the CSS transition entirely: animating --zoom cascades through --item-scale into every article's resolved style each frame, which iOS Safari's compositor can't sustain.
    if (isMobile) {
        document.documentElement.style.transition = '';
    } else {
        // Safari composites the position transform on the GPU but interpolates --item-scale on the main thread, and
        // under throttling WebKit can defer those style passes entirely: the scale HOLDS its large value while positions
        // converge, so the map reads as a pile of overlapping full-size images for a beat.
        const _wkZoomOut = isAppleWebKit && (viewMode === 'map' || viewMode === 'search') && target < visualZoom;
        document.documentElement.style.transition = _wkZoomOut
            ? `--zoom ${duration}ms ${ease}, --subset-label-boost ${duration}ms ${ease}`
            : `--zoom ${duration}ms ${ease}, --item-scale ${duration}ms ${ease}, --subset-label-boost ${duration}ms ${ease}`;
    }
    document.body.classList.add('zoom-animating');
    _zoomAnimating = true;
    _zoomAnimatingTarget = target;
    if (isMobile && viewMode === 'monad' && target >= 0.99) _earlyMobileItemDetailScrollSpace();

    // Clear inline --scale on center img so CSS calc chain drives the animation
    if (viewMode === 'monad' && selectedMonadId) {
        const ca = _articleById(selectedMonadId);
        if (ca) {
            const img = ca.querySelector('img');
            if (img) img.style.removeProperty('--scale');
        }
    }

    // 3. Set destination state
    zoom = target;
    panX = targetPanX;
    panY = targetPanY;
    clampPan();

    // 4. Update --zoom (browser will transition it)
    document.documentElement.style.setProperty('--zoom', target);
    _lastCSSZoom = target;
    _prevZoomVal = target;

    // For monad: keep JS zoom in sync with the *current* visual zoom during the CSS transition.
    if (viewMode === 'monad') {
        const cssZ0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom'));
        if (Number.isFinite(cssZ0)) zoom = cssZ0;
    }

    // 5. Set final positions: CSS transitions will interpolate
    _updateActiveView();

    // During CSS zoom transitions, keep JS layout synced to the visual zoom.
    if (viewMode === 'monad') _startZoomSync(duration + 80);


    const labelsHidden = (viewMode === 'map' || viewMode === 'search') && zoom <= LABEL_REVEAL_ZOOM;
    if (labelsHidden !== _prevLabelsHidden) {
        document.body.classList.toggle('labels-hidden', labelsHidden);
        _prevLabelsHidden = labelsHidden;
    }

    // 6. Clean up after transition completes
    _after('zoom.transition', () => {
        document.documentElement.style.transition = '';
        document.body.classList.remove('zoom-animating');
        _zoomAnimating = false;
        _zoomAnimatingTarget = null;
        _stopZoomSync();

        // Snap JS state to the final target (CSS has finished).
        zoom = target;
        _updateActiveView();

        // Ensure monad state classes match the final zoom.
        const _finalDetailVisible = viewMode === 'monad' && zoom >= 0.3;
        document.body.classList.toggle('monad-detail-visible', _finalDetailVisible);
        const _finalZoomedIn = _isMonadZoomedIn();
        document.body.classList.toggle('monad-zoomed-in', _finalZoomedIn);
        document.documentElement.classList.toggle('monad-zoomed-in', _finalZoomedIn);
        _syncMonadHash();

        // Check native size when arriving at zoomed-in state
        if (_finalZoomedIn && selectedMonadId) _syncMonadNativeSize();
        // An image that loaded mid-animation may have parked a geometry re-measure rather than moving the arrangement in motion. Run it now, before the final netvis frame, so the lines use settled positions.
        _flushDeferredMonadGeom();
        _scheduleTagCloudUpdate(true);
        // One final netvis frame with the settled positions.
        _netRequestDraw(0);
        // Mobile scroll space: measure after a frame so layout reflects final --zoom.
        if (isMobile) requestAnimationFrame(() => updateMobileItemDetailScrollSpace());
    }, duration + 50);
}


window.addEventListener('wheel', (e) => {
    // In monad view on desktop, keep the netvis visible and smoothly updating
    // instead of fading it out during zoom/scroll interactions.
    const _monadDesktop = (viewMode === 'monad' && !isMobile);
    if (!_monadDesktop) _netMarkInteraction(260);
    // Blur search on scroll/zoom
    _blurSearchIfFocused();
    if (_isPanelView()) return;
    /* A wheel over the monad's description is the browser's to handle: that block scrolls itself now, and
       preventDefault here would stop it before it started. Everything else on the map is still swallowed below. */
    if (viewMode === 'monad' && !isMobile && e.target && e.target.closest
        && e.target.closest('article.monad-center .detail-fields .text')) return;
    e.preventDefault();
    if (lightboxOpen) return;
    const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const rawDelta = e.deltaY * multiplier;

    // Desktop monad scroll at max zoom (keep synchronous: it's cheap)
    if (_monadDesktop) {
        /* Nothing moves the article. The monad has no zoom of its own either, so a wheel anywhere else here is swallowed
           rather than falling through to the map's zoom. */
        _netRequestDraw(180);
        return;
    }

    // Base rate per input unit; the zoom-dependent part is shared with the pinch and keyboard paths via _zoomStepGain, and _MAP_ZOOM_INPUT_ADJ holds the feel steady when _MAP_ZOOM_RANGE is retuned.
    const step = rawDelta * _zoomStepGain('wheel') * 0.00025 * _MAP_ZOOM_INPUT_ADJ;
    updateZoomCoalesced(-step, e.clientX, e.clientY);
}, { passive: false });


// Pinch gesture
let lastPinchDist = 0;
let touchMoved = false;
let wasPinching = false;

// A selection is left by the close button, the mode switcher or the browser's own back gesture.


window.addEventListener('touchstart', (e) => {
    _netMarkInteraction(260);
    // Blur search input on touch to dismiss mobile keyboard (unless touching the search box, or the cross, which blurs and closes on its own, and whose tap would otherwise race the blur handler's own delayed close for the same gesture).
    if (!e.target.closest('#search-box, #search-cancel-btn')) _blurSearchIfFocused();
    if (lightboxOpen) return;
    if (_isPanelView()) return;
    document.body.classList.add('notransition');
    touchMoved = false;
    if (e.touches.length === 1) {
        isDragging = true;
        wasPinching = false;
        dragStartX = e.touches[0].clientX;
        dragStartY = e.touches[0].clientY;
        dragStartPanX = panX;
        dragStartPanY = panY;
    }
    else if (e.touches.length === 2) {
        isDragging = false;
        wasPinching = true;
        lastPinchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
    }
}, { passive: true });

window.addEventListener('touchmove', (e) => {
    _netMarkInteraction(260);
    if (lightboxOpen) return;
    if (_isPanelView()) return;
    touchMoved = true;
    if (e.touches.length === 1 && isDragging && (viewMode === 'map' || viewMode === 'search')) {
        panX = dragStartPanX + (e.touches[0].clientX - dragStartX);
        panY = dragStartPanY + (e.touches[0].clientY - dragStartY);
        clampPan();
        _scheduleUpdate();
        // Panning tucks the controls away, except at the widest zoom, where the whole map is already in view.
        if (zoom > getMinZoom() + 0.002) _setUiTucked(true);
    }
    else if (e.touches.length === 2) {
        // Prevent page scroll/zoom while pinching
        e.preventDefault();
        wasPinching = true;
        const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const center = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
        if (lastPinchDist > 0 && viewMode !== 'monad') {
            // Pinch carried no zoom-dependent term at all: see _ZOOM_GAIN_K.
            const _pinchRate = _zoomStepGain('pinch') * 0.001 * _MAP_ZOOM_INPUT_ADJ;
            updateZoomCoalesced((dist - lastPinchDist) * _pinchRate, center.x, center.y);
        }
        lastPinchDist = dist;
    }
}, { passive: false });

window.addEventListener('touchend', () => {
    _netMarkInteraction(240);
    lastPinchDist = 0;
    isDragging = false;
    _cancel('render.notransitionClass');
    _after('render.notransitionClass', function(){
        isInteracting = false;
        document.body.classList.remove('notransition');
    }, 100);
}, { passive: true });


let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;

// Mouse drag
window.addEventListener('mousedown', (e) => {
    _netMarkInteraction(260);
    if (lightboxOpen) return;
    if (_isPanelView()) return;
    // Blur search on map drag start (unless clicking the search box)
    if (!e.target.closest('#search-box')) _blurSearchIfFocused();
    // Allow text selection in monad detail fields
    if (viewMode === 'monad' && e.target.closest('.detail-fields .text, .detail-fields .source, .detail-fields .authors')) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = panX;
    dragStartPanY = panY;
    // Prevent text selection while dragging
    e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
    if (isDragging) _netMarkInteraction(260);
    if (isDragging && (viewMode === 'map' || viewMode === 'search')) {
        if (!document.body.classList.contains('dragging')) {
            const moveDistance = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
            if (moveDistance > 3) document.body.classList.add('dragging');
        }
        panX = dragStartPanX + (e.clientX - dragStartX);
        panY = dragStartPanY + (e.clientY - dragStartY);
        clampPan();
        _scheduleUpdate();
    }
});

window.addEventListener('mouseup', () => {
    _netMarkInteraction(240);
    isDragging = false;
    document.body.classList.remove('dragging');
});

document.querySelector('main').addEventListener('click', (e) => {
    // Suppress click if it followed a touch gesture (pan or pinch)
    if (touchMoved || wasPinching) {
        touchMoved = false;
        wasPinching = false;
        return;
    }
    
    const moveDistance = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
    if (moveDistance > 5) return;
    
    // Let link clicks pass through to the browser
    if (e.target.closest('a')) return;
    
    // If lightbox is open, clicking the image closes it
    if (lightboxOpen) {
        closeLightbox();
        return;
    }
    
    const article = e.target.closest('article');
    if (article) {
        // Only respond to clicks on the image, title, subtitle, or (on a map item, where they are an extra click target rather than text) the authors/source fields.
        const clickedImg = e.target.closest('img');
        const clickedTitle = e.target.closest('h2');
        const clickedSubtitle = e.target.closest('h3');
        const clickedDetailMeta = e.target.closest('.detail-fields .authors, .detail-fields .source');
        // In the monad, authors and source are selectable text, but an ellipsed one is also the expand affordance for the whole detail block, so a plain click on it opens or closes the set. A click that ends a selection stays a selection.
        if (clickedDetailMeta && viewMode === 'monad') {
            const _metaArt = e.target.closest('article');
            if (_metaArt && _metaArt.classList.contains('monad-center') && !isMobile
                && document.body.classList.contains('monad-zoomed-in')) {
                const _sel = window.getSelection && window.getSelection();
                const _selecting = !!(_sel && !_sel.isCollapsed);
                if (!_selecting) {
                    _toggleMonadDetails(_metaArt);
                    e.stopPropagation();
                }
            }
            return;
        }
        if (!clickedImg && !clickedTitle && !clickedSubtitle && !clickedDetailMeta) return;
        
        const itemId = article.id.replace('i_', '');

        const _enterMonad = () => { switchToMonadView(itemId); };

        // Already in monad view and clicking the centre: the image opens the lightbox, which is where an image is seen full, and the title closes the selection: the same second click on the same title that closes a row in the list or a card in the grid.
        if (viewMode === 'monad' && itemId === selectedMonadId) {
            /* Not when the click landed on the link itself. The list and the grid have carried this guard all along; the monad did not, so a click on the open item's title both opened the url in a new tab AND closed the selection behind it. */
            if (e.target.closest('.title-link')) return;
            if (clickedImg) openLightbox(article);
            else if (clickedTitle || clickedSubtitle) _monadCloseSelection();
            return;
        }

        // Mobile Safari renders translateY(-100%) against a not-yet-decoded image box as a one-frame jump, so always wait for the tapped image to decode before switching the centre. Fast when it already is.
        if (isMobile) {
            const imgEl = article.querySelector('img');
            if (imgEl) {
                _pendingMonadSwitchToken++;
                const tok = _pendingMonadSwitchToken;
                article.classList.add('monad-pending');
                _whenImgReady(imgEl).then(() => {
                    if (tok !== _pendingMonadSwitchToken) return;
                    if (!article.isConnected) return;
                    article.classList.remove('monad-pending');
                    _enterMonad();
                });
                return;
            }
        }

        _enterMonad();
    } else if (e.target === e.currentTarget) {
        // During a transition every item but the monad centre has pointer-events: none, so a click aimed at one lands here on main. Reading that as a BACKGROUND click would close the selection or zoom the map out: swallow it; real background clicks are worth the wait.
        if (_viewTransitionActive()) return;
        if (viewMode === 'monad') {
            _netMarkInteraction(260);
            _monadCloseSelection();
        } else {
            _mapBackgroundReset();
        }
    }
});

// Tag links in the monad detail navigate via the hash and pass straight through the main handler, so mark the intent here in the capture phase. switchToMapView reads it to fit the whole tag subset instead of restoring the pre-monad camera.
document.addEventListener('click', (e) => {
    if (viewMode !== 'monad') return;
    if (e.target.closest('.detail-fields .tags a')) {
        _tagClickFitIntent = true;
    }
}, true);

// Tag sidebar / gap cover background click should behave like a background click on the map canvas.
// (Tag clicks are handled by the tag cloud itself.)
let _tagSidebarDownX = 0, _tagSidebarDownY = 0, _tagSidebarDownT = 0;

/** The view an open item closes back into, taken from the address rather than remembered. */
function _detailPanelPrefix() {
    const a = _parseAddress();
    return a.i ? a.view : null;
}

/** Where an open item's close goes: its view with the filter, without the item. A query on the map comes back to the search view. */
function _detailReturnHash() {
    const a = _parseAddress();
    if (!a.i) return null;
    return _formatAddress({ view: a.view, t: a.t, q: a.q }) || (window.location.pathname + window.location.search);
}

/** Close the selection. An item opened from the map leaves the monad for that map, with its zoom, pan, search and
 *  tag filter intact: switchToMapView restores all four from the snapshot switchToMonadView took on entry. */
function _monadCloseSelection() {
    // Nothing to fan back in: the description is never open, it is scrolled in place.
    _monadLeaveToOrigin();
}

/** The leave itself, once any fan-in or scroll has played out. */
function _monadLeaveToOrigin() {
    // Any deferred entry still in flight is no longer wanted.
    _monadPendingId = null;
    const panel = _detailPanelPrefix();
    const back = _detailReturnHash();
    if (!back) {
        switchToMapView();
        return;
    }
    /* The reading position goes back in the SAME task as the rebuild, before anything paints. _panelRestoreY
       silences those scroll-to-top calls for the duration, so the position is written once and there is nothing to
       correct. */
    const y = _panelScrollY[panel] || 0;
    _panelRestoreY = y;
    try {
        if (window.location.hash !== back) history.pushState(null, '', back);
        handleHashChange(false);
        if (document.scrollingElement) document.scrollingElement.scrollTop = y;
    } finally {
        _panelRestoreY = null;
    }
    _onFrame('panel.restoreScroll', () => {
        const el = document.scrollingElement;
        if (el && Math.abs((el.scrollTop || 0) - y) > 1) el.scrollTop = y;
    });
}

/** Background click outside the monad: clear a search, or reset the map. With a tag filter active, clearing it already resets zoom and pan as part of the staggered fade-out; without one, zoom out and recentre if needed. */
function _mapBackgroundReset() {
    _setUiTucked(false);
    if (viewMode === 'search') {
        switchToMapView(true, false, false);
        return;
    }
    if (viewMode !== 'map') return;
    if (activeTag) {
        _clearTagFilterKeepView(true);
        return;
    }
    if (Math.abs(panX) > 0.5 || Math.abs(panY) > 0.5) {
        triggerAnimation();
        panX = 0;
        panY = 0;
        update();
    }
    if (zoom > 0.01) {
        animateZoomTo(0);
    }
}





/* ══ MONAD TEXT MASK ═══════════════════════════════════════════════════════
   The description's two fades, kept honest about what is actually past them.
   A fade that is always on says "more below" even at the last line, which is
   the one moment it is wrong, and the top edge has no other way of saying that
   something has scrolled by, since the block does not move and has no bar.
   Threshold rather than zero for the top: a scroll of a pixel or two is a
   trackpad settling, not a line going past, and a fade appearing for it reads as
   a flicker. Half a line is the smallest amount that means something was read. */
const MONAD_TEXT_MASK_TOP_EM = 2.5;   // matches the gradient's own depth
/* The bottom fade is 25% deeper than the top one. At 2.5em it was about two lines, close enough to the line grid
   that whether the reader saw a gradient at all depended on where the last visible line happened to fall; at
   3.125em it always crosses part of a line, so the cue is there whatever the description's length. The top edge
   keeps 2.5em: it appears on scroll, where there is no such coincidence to avoid. */
const MONAD_TEXT_MASK_BOT_EM = 3.125;
/* How much overflow counts as scrollable. A line box rarely resolves to a whole number of pixels, so a block
   that fits exactly still reports a scrollHeight a pixel or two past its clientHeight, and at 1 that read as
   scrollable, which is why a short description carried a fade. */
const MONAD_TEXT_SCROLL_EPS = 6;

/* The measurement is only right once the block has its final height, and the reveal grows it from 0 over a transition
   that outlasts the timed call on entry: measured at 1px tall, every description read as scrollable and kept its
   bottom fade for good. So it is re-taken whenever the block changes size (the reveal, its end, a window resize). */
const _monadTextRO = (typeof ResizeObserver === 'function')
    ? new ResizeObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const t = entries[i].target;
            if (t.isConnected && t.closest('article.monad-center')) _syncMonadTextMask(t);
        }
    })
    : null;
let _monadTextObserved = null;

function _syncMonadTextMask(el) {
    const t = el || (function () {
        const a = _centerArticle();
        return a ? a.querySelector('.detail-fields .text') : null;
    })();
    if (!t) return;
    if (_monadTextRO && t !== _monadTextObserved) {
        if (_monadTextObserved) _monadTextRO.unobserve(_monadTextObserved);
        _monadTextObserved = t;
        _monadTextRO.observe(t);
    }
    const max = t.scrollHeight - t.clientHeight;
    // Not a scroller at all: no fade at either end, whatever the scroll position says.
    if (max <= MONAD_TEXT_SCROLL_EPS) {
        t.style.setProperty('--text-mask-top', '0px');
        t.style.setProperty('--text-mask-bot', '0px');
        return;
    }
    const half = (parseFloat(getComputedStyle(t).lineHeight) || 16) / 2;
    t.style.setProperty('--text-mask-top', t.scrollTop > half ? MONAD_TEXT_MASK_TOP_EM + 'em' : '0px');
    t.style.setProperty('--text-mask-bot', (max - t.scrollTop) > 1 ? MONAD_TEXT_MASK_BOT_EM + 'em' : '0px');
}

/* Capturing, because scroll does not bubble: one listener answers for whichever
   centre article is current, rather than being re-attached every time the item
   changes. The filter is cheap and the event only fires on a real scroll. */
document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('text')) return;
    if (!t.closest || !t.closest('article.monad-center .detail-fields')) return;
    _syncMonadTextMask(t);
}, true);
