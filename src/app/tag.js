/* ══ TAG VIS ═══════════════════════════════════════════════════════════════════
   The tag cloud in the sidebar beside the map, the list and the grid, and the curves from the list's rows to it.
   Desktop only: index.html doesn't load this file on a phone, where the search box carries the tag filter instead.
   The other files reach it through tagVis (core.js), whose methods do nothing until the end of this file fills
   them in. */

let _tagCloudLast = 0;
let _tagCloudNeeds = false;

// While list rows expand/collapse, the viewport composition changes mid-transition.
// We hold off on scroll-driven tag updates and then recompute once layout settles.
let _tagCloudHoldUntil = 0;
/** Hold non-forced tag updates for a short window (ms). */
function _holdTagCloud(ms) {
    const now = performance.now();
    _tagCloudHoldUntil = Math.max(_tagCloudHoldUntil, now + Math.max(0, ms || 0));
}

/* A quiet window after a tag change, during which nothing recomputes the cloud. */
let _tagChangeQuietUntil = 0;
const TAG_CHANGE_QUIET_MS = UI_TRANS_MS + 120;
function _quietTagCloudForFilterChange() {
    _tagChangeQuietUntil = performance.now() + TAG_CHANGE_QUIET_MS;
}

// Tag cloud updates are suppressed during drag and wheel-zoom (forced layout across all items); this arms a trailing update once the interaction quiets.
const TAGCLOUD_SETTLE_MS = 140;
function _requestTagCloudSettle() {
    if (!document.body.classList.contains('map-interacting')) {
        document.body.classList.add('map-interacting');
    }
    _cancel('tag.cloudSettle');
    _after('tag.cloudSettle', () => {
        document.body.classList.remove('map-interacting');
        _scheduleTagCloudUpdate(true);
    }, TAGCLOUD_SETTLE_MS);
}

// will-change on ~300 chips would promote each to a permanent layer, which dominates Safari frame time; body.tagcloud-animating grants layers only for the transition (--tagTrans plus slack).
const TAGCLOUD_ANIMATING_MS = 840;
/* ══ TAG CLOUD & SIDEBAR ════════════════════════════════════════════════ */

function _markTagCloudAnimating() {
    if (!document.body.classList.contains('tagcloud-animating')) {
        document.body.classList.add('tagcloud-animating');
    }
    _cancel('tag.cloudAnimating');
    _after('tag.cloudAnimating', () => {
        document.body.classList.remove('tagcloud-animating');
    }, TAGCLOUD_ANIMATING_MS);
}

// A refresh timed to land after a view transition settles: the visible-id test reads live rects, so a
// mid-transition update samples interpolated positions, and the recount itself is a burst of forced layout in
// the middle of someone else's animation.
function _scheduleTagCloudUpdateAfterTransition() {
    _cancel('tag.cloudAfterTrans');
    const busy = () => document.body.classList.contains('animated')
        || document.body.classList.contains('zoom-animating')
        || _stubBridgeActive || _modeBridgeInFlight
        || !!(_gridInner && _gridInner.classList.contains('grid-moving'))
        || (viewMode === 'list' && performance.now() < _tagCloudHoldUntil)
        || performance.now() < _tagChangeQuietUntil;
    _afterSettled('tag.cloudAfterTrans', () => {
    // Cleared here rather than on a timer, so this call is the first one through and no scroll can slip in ahead of it.
    _tagChangeQuietUntil = 0;
    _scheduleTagCloudUpdate(true);
    }, { busy, capMs: 2000 });
}

/** Move the highlight and nothing else: the chip for the active tag takes .active, whichever had it gives it up.
 *  The newly active chip also sheds .dim, so a tag clicked while an item is selected (and dimmed for not being one
 *  of that item's tags) is at full strength at once rather than after the settled update. Nothing is locked in: the
 *  next full _updateTagCloud works out .dim afresh, so once the tag is released it dims again if it should. */
function _setTagCloudActiveOnly() {
    if (!_tagChipByTag || !_tagChipByTag.size) return;
    const t = (activeTag || '').trim();
    _tagChipByTag.forEach((el, tag) => {
        const on = !!t && tag === t;
        el.classList.toggle('active', on);
        if (on) el.classList.remove('dim');
    });
}

const __TAG_MAX_REM = 2;              // cap for most frequent tags
const __TAG_LINE_EM = 1.33;             // keep in sync with CSS
// Leading-edge debounce, so scroll start is still instant: this only sets the re-layout cadence during sustained scrolling. --tagTrans stays at 750ms in every view.
const __TAG_UPDATE_DEBOUNCE_MS = 250;
const _tagGapCoverEl = document.getElementById('tag-gap-cover');
const _tagCloudEl = document.getElementById('tag-cloud');
const _tagMeasureEl = document.getElementById('tag-measure');

function _setTagSidebarW(px) {
    const enabled = _tagSidebarEnabled();
    const w = enabled ? Math.max(220, Math.min(420, Math.round(px || 0))) : 0;
    if (Math.abs(w - _tagSidebarW) < 6) return; // avoid oscillation

    const wasOff = _tagSidebarW === 0;

    // Growing applies immediately so long tags are never clipped; shrinking debounces so transient widths don't jitter __mainCenterX.
    const commit = () => {
        _tagSidebarW = w;
        document.body.classList.toggle('has-tag-sidebar', enabled && w > 0);
        _syncTagToSearchBox();
        // Occlusion changed: drop the cache now, and again once the width
        // transition has settled (the rect read at appear-time is mid-anim).
        _invalidateMapOcc();
        setTimeout(_invalidateMapOcc, UI_TRANS_MS + 50);
    };

    _cancel('tag.shrink');
    if (w > _tagSidebarW || w === 0) {
        commit();
        // When the sidebar first appears, reposition map items so the center
        // shifts to match __mainCenterX (which now accounts for the sidebar).
        if (wasOff && w > 0 && (viewMode === 'map' || viewMode === 'search')) update();
    } else {
        _after('tag.shrink', commit, 350);
    }
}

/** Re-derive the cloud from the current state; debounced unless force. Reached through _scheduleTagCloudUpdate
 *  in core.js, which also refreshes the cancel button. */
function _tagCloudUpdate(force = false) {
    if (!_tagSidebarEnabled()) {
        _cancel('tag.cloudDebounce');
        _setTagSidebarW(0);
        if (_tagCloudEl) _tagCloudEl.innerHTML = '';
        _tagAllSorted = null;
        _tagChipByTag = new Map();
        document.body.classList.remove('has-tag-sidebar');
        return;
    }

    _tagCloudNeeds = true;

    const run = () => {
        if (_pending('tag.cloudFrame')) return;
        _onFrame('tag.cloudFrame', () => {
            if (!_tagCloudNeeds) return;
            const now = performance.now();
            // Mid tag change: the view is still rearranging, so any count taken now is of a subset on its way somewhere. The need is left standing for the poll that ends the window.
            if (now < _tagChangeQuietUntil) return;
            _tagCloudNeeds = false;

            // In list mode, avoid recomputing tag frequencies/sizes mid expand/collapse animation
            // (scrollTop changes and intermediate geometry would produce wrong viewport counts).
            if (viewMode === 'list' && !force && now < _tagCloudHoldUntil) {
                if (!_pending('tag.cloudHold')) {
                    const wait = Math.min(900, Math.max(16, (_tagCloudHoldUntil - now) + 12));
                    _after('tag.cloudHold', () => {
                        _scheduleTagCloudUpdate(true);
                    }, wait);
                }
                return;
            }

            const minDt = 32;
            if (!force && (now - _tagCloudLast) < minDt) {
                _scheduleTagCloudUpdate(false);
                return;
            }
            _tagCloudLast = now;
            _markTagCloudAnimating();
            _updateTagCloud();
        });
    };

    if (force) {
        _cancel('tag.cloudDebounce');
        run();
        return;
    }

    // Throttle, not debounce: fire immediately if enough time has passed, otherwise schedule one trailing call without resetting the pending timer, so the cloud keeps updating during a drag.
    const now = performance.now();
    const elapsed = now - _tagCloudLast;
    if (elapsed >= __TAG_UPDATE_DEBOUNCE_MS && !_pending('tag.cloudDebounce')) {
        // Enough time has passed: run on the next frame.
        run();
    } else if (!_pending('tag.cloudDebounce')) {
        // Schedule a trailing update for the remaining interval.
        const wait = Math.max(8, __TAG_UPDATE_DEBOUNCE_MS - elapsed);
        _after('tag.cloudDebounce', () => {
            run();
        }, wait);
    }
    // If a timer is already pending, do nothing: it will fire and pick up the latest state.
}

function _getVisibleIdsForTagCloud() {
    const ids = [];
    if (viewMode === 'grid') return _gridVisibleIds();
    if (viewMode === 'list') {
        const _lv = document.getElementById('list-view');
        if (!_lv) return ids;
        /* Body is the scroll container; use viewport rect for visibility checks */
        const listRect = { top: 0, bottom: window.innerHeight };
        if (!_listItemElsCache) {
            _listItemElsCache = _lv.querySelectorAll('.list-item[data-id]');
        }
        const els = _listItemElsCache;
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            // Permanent-DOM filtering: hidden items are display:none (zero rect);
            // skip them so they don't pollute the count or break the early-out.
            if (el.classList.contains('list-out')) continue;
            const r = el.getBoundingClientRect();
            if (r.bottom < listRect.top) continue;
            if (r.top > listRect.bottom) break;
            const id = el.getAttribute('data-id');
            if (id) ids.push(id);
        }
        return ids;
    }

    // Mobile shows no ring, so the cloud has only the selected item to describe.
    if (viewMode === 'monad' && selectedMonadId && isMobile) return [selectedMonadId];

    const __mainEl = document.querySelector('main');
    if (!__mainEl) return ids;
    const mainRect = __mainEl.getBoundingClientRect();
    for (let i = 0, len = items.length; i < len; i++) {
        const it = items[i];
        const article = it._article;
        if (!article) continue;
        if (viewMode === 'monad' && (article.classList.contains('monad-low') || article.classList.contains('monad-zero'))) continue;
        if (activeTag && (article.classList.contains('tag-filtered-out') || article.classList.contains('tag-transition-hide'))) continue;
        if (viewMode === 'search' && (searchQuery || '').trim().length >= 2) {
            const sc = (searchScores && searchScores[it.id]) ? (searchScores[it.id] || 0) : 0;
            if (sc <= 0) continue;
            if (article.classList.contains('search-hidden')) continue;
        }
        const r = article.getBoundingClientRect();
        if (r.right < mainRect.left || r.left > mainRect.right || r.bottom < mainRect.top || r.top > mainRect.bottom) continue;
        ids.push(it.id);
    }
    return ids;
}

let _tagAllSorted = null;
let _tagChipByTag = new Map();
const _tagWidthCache = new Map();
let _tagCloudAvailH = 0;
let _tagCloudRemPx = 0;

function _ensureTagCloudInitialized() {
    if (!_tagCloudEl) return;
    if (!items || items.length === 0) return;
    if (_tagAllSorted && _tagAllSorted.length && _tagChipByTag && _tagChipByTag.size) return;

    const set = new Set();
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || !it.tags) continue;
        for (let j = 0; j < it.tags.length; j++) {
            const t = (it.tags[j] || '').trim();
            if (t) set.add(t);
        }
    }
    _tagAllSorted = Array.from(set).sort((a,b)=>a.localeCompare(b));
    _tagChipByTag = new Map();

    // Build stable DOM nodes once (keeps transitions smooth).
    _tagCloudEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < _tagAllSorted.length; i++) {
        const t = _tagAllSorted[i];
        const a = document.createElement('a');
        a.className = 'tag-chip hidden';
        a.setAttribute('data-tag', t);
        a.textContent = t;
        a.href = _formatAddress({ t });
        // Keep hidden tags in the DOM (for smooth transitions); visibility is handled via CSS/transform.
        a.style.setProperty('--ty', '0px');
        a.style.setProperty('--ts', '0.001');
        frag.appendChild(a);
        _tagChipByTag.set(t, a);
    }
    _tagCloudEl.appendChild(frag);
}

/* The unfiltered map at rest shows the whole collection, so its tag frequencies are the collection's own: the
   same numbers every time, and expensive ones; the visible-id test reads a bounding rect per item, ~390 of them
   per refresh. */
let _tagCountsAllCache = null;
function _tagCloudShowsWholeCollection() {
    return viewMode === 'map'
        && !activeTag
        && !(searchQuery || '').trim()
        && zoom <= getMinZoom() + 0.001;
}
function _tagCountsForWholeCollection() {
    if (_tagCountsAllCache) return _tagCountsAllCache;
    const counts = new Map();
    for (let i = 0, len = items.length; i < len; i++) {
        const tags = items[i] && items[i].tags;
        if (!tags) continue;
        for (let j = 0; j < tags.length; j++) {
            const t = (tags[j] || '').trim();
            if (!t) continue;
            counts.set(t, (counts.get(t) || 0) + 1);
        }
    }
    _tagCountsAllCache = counts;
    return counts;
}

function _updateTagCloud() {
    if (!_tagSidebarEnabled() || !_tagCloudEl) return;
    _ensureTagCloudInitialized();
    if (!_tagAllSorted || _tagAllSorted.length === 0) return;

    const itemById = _getTagItemById();

    // Compute visible items (current viewport / mode). Skipped entirely on the resting unfiltered map, where the answer is "all of them" and the counts below are already known.
    const _wholeCollection = _tagCloudShowsWholeCollection();
    const visibleIds = _wholeCollection ? null : _getVisibleIdsForTagCloud();

    // Selected item tags (for opacity / weight cues only).
    let selectedTags = null;
    if (viewMode === 'monad' && selectedMonadId) {
        // Same rule as the grid and the list: the selected item's tags lead and the rest of the cloud describes what else is on screen: here the ring. An item with no tags leads with nothing rather than greying the whole cloud.
        const it = itemById[selectedMonadId];
        selectedTags = (it && it.tags && it.tags.length) ? new Set(it.tags) : null;
    } else if (viewMode === 'grid' && gridSelectedId) {
        // As in the list: the selected card's tags lead only while the card is in view; scrolled away, the cloud shows the visible cards' tags as if nothing were selected.
        const isSelVisible = (visibleIds && visibleIds.indexOf(gridSelectedId) !== -1);
        const it = isSelVisible ? itemById[gridSelectedId] : null;
        selectedTags = it && it.tags ? new Set(it.tags) : null;
    } else if (viewMode === 'list' && listSelectedId) {
        // Only emphasize the selected item's tags while the selected item is actually visible.
        const isSelVisible = (visibleIds && visibleIds.indexOf(listSelectedId) !== -1);
        if (isSelVisible) {
            const it = itemById[listSelectedId];
            selectedTags = it && it.tags ? new Set(it.tags) : null;
        } else {
            selectedTags = null;
        }
    }

    // Count tag frequencies among the currently visible items. Read-only from here on, which is what lets the whole-collection case hand back a shared Map.
    let counts;
    if (_wholeCollection) {
        counts = _tagCountsForWholeCollection();
    } else {
        counts = new Map();
        for (let i = 0; i < visibleIds.length; i++) {
            const it = itemById[visibleIds[i]];
            if (!it || !it.tags) continue;
            for (let j = 0; j < it.tags.length; j++) {
                const t = (it.tags[j] || '').trim();
                if (!t) continue;
                counts.set(t, (counts.get(t) || 0) + 1);
            }
        }
    }

    // Frequency range among tags that occur at least once.
    const present = [];
    let minC = Infinity;
    let maxC = 0;
    counts.forEach((c, t) => {
        if ((c || 0) > 0) {
            present.push(t);
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
        }
    });

    // On first load the sidebar may still be display:none, so its height reads 0 and we would overfill the pane. Make it measurable before computing the packing.
    if (_tagCloudAvailH < 20) {
        let _availRect = _tagCloudEl.getBoundingClientRect();
        if (_availRect.height < 20) {
            _setTagSidebarW(220);
            _availRect = _tagCloudEl.getBoundingClientRect();
        }
        _tagCloudAvailH = _availRect.height || (window.innerHeight * 0.9);
    }

    const availH = _tagCloudAvailH;
    if (!_tagCloudRemPx) {
        _tagCloudRemPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    }
    const remPx = _tagCloudRemPx;
    const baseRem = __TAG_MAX_REM; // tags are rendered at max size (2rem) and then scaled down
    const baseHPx = baseRem * remPx * __TAG_LINE_EM; // unscaled chip height at 2rem (used for center-anchored transforms)
    const gapPx = Math.max(0, remPx * 0.02); // tiny breathing room

    // If there are no tags for the current viewport, hide everything (keep ty stable).
    if (!(minC < Infinity) || present.length === 0) {
        for (let i = 0; i < _tagAllSorted.length; i++) {
            const t = _tagAllSorted[i];
            const el = _tagChipByTag.get(t);
            if (!el) continue;
            el.classList.remove('active', 'focus', 'dim');
            el.classList.add('hidden');
            // --ty is deliberately left alone so every chip collapses where it sits. Resetting it to 0 was harmless while the fade-out was instant, but on the layout clock the cloud visibly flies to the top edge.
            el.style.setProperty('--ts', '0.001');
        }
        _setTagSidebarW(0);
        return;
    }

    // Map counts to a scale band: max→__S_MAX, min→__S_MIN (linear).
    const __S_MIN = 0.55;
    const __S_MAX = 1.10;
    // With a filter active the filtered tag is pinned to __S_MAX and the rest are scaled against the most frequent OTHER tag, so the hierarchy stays meaningful.
    const _activeMaxC = activeTag
        ? present.reduce((m, t) => (t !== activeTag ? Math.max(m, counts.get(t) || 0) : m), 0)
        : maxC;
    const _activeMinC = activeTag
        ? present.reduce((m, t) => (t !== activeTag && (counts.get(t) || 0) > 0 ? Math.min(m, counts.get(t) || Infinity) : m), Infinity)
        : minC;
    // When all tags share the same frequency (no variance), use a reduced max
    // so the cloud doesn't appear at full size when there's no hierarchy to show.
    const __uniformScale = __S_MAX * 0.75;
    const __scaleForCount = (c, isActive) => {
        if (isActive) return __S_MAX;
        c = Math.max(0, c || 0);
        if (_activeMaxC <= 0 || !isFinite(_activeMinC) || _activeMaxC === _activeMinC) return __uniformScale;
        const rel = _clamp01((c - _activeMinC) / (_activeMaxC - _activeMinC));
        return __S_MIN + rel * (__S_MAX - __S_MIN);
    };

    // Determine which tags can be shown given the available vertical space.
    // We iterate tags by decreasing frequency and include them until the pane is filled.
    const byFreq = present.slice().sort((a, b) => {
        const ca = counts.get(a) || 0;
        const cb = counts.get(b) || 0;
        if (cb !== ca) return cb - ca;
        return a.localeCompare(b);
    });

    const includeScale = new Map(); // tag -> scale (0 means hidden)
    let used = 0;
    let nShown = 0;

    // Always try to show the active tag filter (if any) so the UI remains legible.
    if (activeTag) {
        const c = counts.get(activeTag) || minC;
        const s = __scaleForCount(c, true);
        includeScale.set(activeTag, s);
        used = baseHPx * s;
        nShown = 1;
    }

    // Always include the selected item's tags so the full context is visible,
    // even if a tag's frequency is too low to make the cut otherwise.
    if (selectedTags && selectedTags.size > 0) {
        for (const st of selectedTags) {
            if (includeScale.has(st)) continue;
            const c = counts.get(st) || 1;
            const s = __scaleForCount(c, false);
            includeScale.set(st, s);
            used += (nShown > 0 ? gapPx : 0) + baseHPx * s;
            nShown++;
        }
    }

    const limitH = Math.max(12, availH - 1);
    const epsilon = 0.15;

    for (let i = 0; i < byFreq.length; i++) {
        const t = byFreq[i];
        if (t === activeTag) continue;
        if (includeScale.has(t)) continue;
        const c = counts.get(t) || 0;
        const s = __scaleForCount(c, false);
        const h = baseHPx * s;
        const add = (nShown > 0 ? gapPx : 0) + h;

        if ((used + add) <= (limitH + epsilon)) {
            includeScale.set(t, s);
            used += add;
            nShown++;
            // Early out if nothing else can fit even at min scale.
            if ((limitH - used) < (baseHPx * __S_MIN * 0.75)) break;
        }
    }

    // Apply styles + compute packing (stable DOM nodes; animate via transforms).
    // Alphabetical DOM order is preserved; tags not included are kept at their alphabetical place with scale 0.
    let needW = 194;
    const flow = [];
    let totalHPx = 0;

    for (let i = 0; i < _tagAllSorted.length; i++) {
        const t = _tagAllSorted[i];
        const el = _tagChipByTag.get(t);
        if (!el) continue;

        const isActive = (activeTag === t);
        const isSelItemTag = (selectedTags && selectedTags.has(t));

        // href adapts to current mode (for copy/share); clicks are handled via JS.
        el.href = _formatAddress({ view: _isPanelView() ? viewMode : 'map', t });

        // Dimmed or not; the stylesheet owns how far (--tag-dim) and eases it.
        let isDim = false;
        if (_isPanelView() || viewMode === 'monad') { if (selectedTags) isDim = !selectedTags.has(t); }
        if (isActive) isDim = false;

        const s = includeScale.get(t) || 0;
        const visible = (s > 0);

        el.classList.toggle('active', isActive);
        el.classList.toggle('hidden', !visible);

        if (visible) {
            el.classList.toggle('focus', !isActive && !!isSelItemTag);
            el.classList.toggle('dim', isDim);

            // Width measurement for sidebar (match the *visual* size).
            if (_tagMeasureEl) {
                const fw = (isActive || isSelItemTag) ? '750' : '250';
                const sRound = Math.round(s * 100);
                const cacheKey = t + '|' + sRound + '|' + fw;
                let wpx = _tagWidthCache.get(cacheKey);
                if (wpx === undefined) {
                    _tagMeasureEl.style.fontSize = (baseRem * s) + 'rem';
                    _tagMeasureEl.style.fontWeight = fw;
                    _tagMeasureEl.style.fontVariationSettings = '"wght" ' + fw;
                    _tagMeasureEl.textContent = t;
                    wpx = _tagMeasureEl.getBoundingClientRect().width;
                    _tagWidthCache.set(cacheKey, wpx);
                }
                if (wpx > needW) needW = wpx;
            }

            const hpx = baseHPx * s;
            flow.push({ t, el, s, hpx });
            totalHPx += hpx + gapPx;
        } else {
            el.classList.remove('dim');
            el.classList.remove('focus');
            el.style.setProperty('--ts', '0.001');
        }
    }

    if (flow.length > 0) totalHPx -= gapPx;

    // Center vertically if there's room; otherwise start at the top.
    const startY = (totalHPx > 0 && totalHPx < availH) ? ((availH - totalHPx) / 2) : 0;

    // Final y positions and scales, transform-only. Hidden chips get a continuously updated --ty without reserving
    // height, so they travel with their neighbours and re-enter organically.
    const flowByTag = new Map();
    for (let i = 0; i < flow.length; i++) flowByTag.set(flow[i].t, flow[i]);

    let y = startY;
    for (let i = 0; i < _tagAllSorted.length; i++) {
        const t = _tagAllSorted[i];
        const el = _tagChipByTag.get(t);
        if (!el) continue;

        const o = flowByTag.get(t);
        if (o) {
            const centerY = y + (o.hpx / 2);
            const ty = centerY - (baseHPx / 2);
            el.style.setProperty('--ty', ty.toFixed(2) + 'px');
            el.style.setProperty('--ts', o.s.toFixed(4));
            y += o.hpx + gapPx;
        } else {
            el.style.setProperty('--ty', (y - baseHPx / 2).toFixed(2) + 'px');
        }
    }

    needW += 26; // padding + breathing room
    _setTagSidebarW(needW);
    /* The hover peek re-stated against what was just written: a peek held over from a click is released here, in
       the same task as the .dim and .focus writes above, so the chips step straight from the one state to the
       other with no frame at full in between. */
    _syncItemPeek(true);
    // The chips have just been retargeted and are about to ease there, so the curves that land on them have to follow rather than be drawn once against where they used to be.
    _scheduleListLinksSettle();
}

// Click in tag sidebar toggles tag filter (no full-text search)
if (_tagCloudEl) {
    _tagCloudEl.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-tag]');
        if (!a) return;
        e.preventDefault();
        const tag = (a.getAttribute('data-tag') || a.textContent || '').trim();
        if (!tag) return;
        /* The preview carries into the filter instead of being dropped first, so the items it dimmed keep going
           rather than flinching back to full. It also has to be ended here: the cloud is rebuilt under the
           pointer, so the mouseout that would otherwise clear it may never arrive. */
        _commitTagPeek();
        _toggleTagFilter(tag, true);
    });
    /* Backstop for the same reason: a pointer that leaves the cloud in one move, or a chip that is rebuilt or
       hidden while the pointer is on it, can skip the per-chip mouseout. */
    _tagCloudEl.addEventListener('mouseleave', () => {
        _listLinkHoverTag = '';
        _setTagPeek('');
        _scheduleListLinksDraw();
    });
}

// List scroll updates tag cloud on desktop
// (Do not reference `listView` here; it may be declared later and would trigger TDZ errors.)
(() => {
    const _lv = document.getElementById('list-view');
    if (!_lv) return;
    _lv.addEventListener('scroll', () => _scheduleTagCloudUpdate(false), { passive: true });
    // When body is the scroll container (list view), scroll events fire on document instead
    document.addEventListener('scroll', () => {
        if (document.body.classList.contains('list-view')) _scheduleTagCloudUpdate(false);
    }, { passive: true });
})();

function _handleTagSidebarBackgroundClick(e) {
    // Ignore tag links (handled elsewhere)
    if (e.target.closest('a[data-tag]')) return;

    // Suppress click if it followed a touch gesture (pan or pinch)
    if (touchMoved || wasPinching) {
        touchMoved = false;
        wasPinching = false;
        return;
    }

    // Ignore if it was effectively a drag (use pointerdown captured on the sidebar/gap cover)
    const now = performance.now();
    if (_tagSidebarDownT && (now - _tagSidebarDownT) < 1500) {
        const moveDistance = Math.hypot(e.clientX - _tagSidebarDownX, e.clientY - _tagSidebarDownY);
        if (moveDistance > 6) return;
    }

    // If lightbox is open, clicking anywhere closes it
    if (lightboxOpen) {
        closeLightbox();
        return;
    }

    if (viewMode === 'monad') {
        _monadCloseSelection();
    } else if (viewMode === 'list') {
        _listBackgroundClear();
    }
}

const __tagBgEls = [_tagSidebarEl, _tagGapCoverEl].filter(Boolean);
if (__tagBgEls.length) {
    __tagBgEls.forEach((el) => {
        el.addEventListener('pointerdown', (e) => {
            _tagSidebarDownX = e.clientX;
            _tagSidebarDownY = e.clientY;
            _tagSidebarDownT = performance.now();
        }, { passive: true });

        el.addEventListener('click', _handleTagSidebarBackgroundClick);
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('a[data-tag]')) return;
            if (_isPanelView()) return;

            const now = performance.now();
            if (_tagSidebarDownT && (now - _tagSidebarDownT) < 1500) {
                const moveDistance = Math.hypot(e.clientX - _tagSidebarDownX, e.clientY - _tagSidebarDownY);
                if (moveDistance > 6) return;
            }

            resetView(true);
        });
    });
}

/* The other end of the same gesture: pointing at a tag lights every curve arriving at it, which is the one
   reading the fan can't give on its own; a chip's own edges are the thing buried in it. mouseover/mouseout
   rather than enter/leave because these are delegated: the chips are rebuilt by _updateTagCloud and only they
   take pointer events, while #tag-cloud itself does not. */
if (_tagCloudEl) {
    _tagCloudEl.addEventListener('mouseover', (e) => {
        const a = e.target.closest && e.target.closest('a[data-tag]');
        const tag = a ? (a.getAttribute('data-tag') || a.textContent || '').trim() : '';
        if (tag === _listLinkHoverTag) return;
        _listLinkHoverTag = tag;
        _setTagPeek(tag);
        _scheduleListLinksDraw();
    });
    _tagCloudEl.addEventListener('mouseout', (e) => {
        // Moving within one chip fires mouseout at every child boundary; only a move that actually leaves the chip counts.
        const a = e.target.closest && e.target.closest('a[data-tag]');
        if (!a) return;
        if (e.relatedTarget && a.contains(e.relatedTarget)) return;
        if (!_listLinkHoverTag) return;
        _listLinkHoverTag = '';
        _setTagPeek('');
        _scheduleListLinksDraw();
    });
}

/* ── Tag peek ───────────────────────────────────────────────────────────────
   Pointing at a chip previews what clicking it would keep: the items carrying that tag are marked and the CSS
   drops everything else in the view to a third (see the tag-peek rules in the stylesheet). Only the view on
   screen is marked — the other two are not being looked at, and the gesture fires again for every chip the
   pointer crosses, so this is the difference between touching a few hundred elements and a few thousand. */
let _tagPeek = '';

/** The element standing for an item in the view currently on screen. The map, search and the detail view all
 *  draw items as articles; the panels have their own row and card. */
function _tagPeekElFor(id) {
    if (viewMode === 'list') return _getListItemEl(id);
    if (viewMode === 'grid') return (typeof _gridCardById !== 'undefined' && _gridCardById) ? _gridCardById[id] : null;
    return _articleById(id);
}

function _clearTagPeekMarks() {
    const marked = document.querySelectorAll('.tag-peek-match');
    for (let i = 0; i < marked.length; i++) marked[i].classList.remove('tag-peek-match');
}

function _setTagPeek(tag) {
    const t = (tag || '').trim();
    if (t === _tagPeek) return;
    const was = _tagPeek;
    _tagPeek = t;

    // Clear the previous pass wherever it landed: the view may have changed since, so this is not scoped by view.
    _clearTagPeekMarks();

    /* An empty tag, or a peek at the tag that is already the filter: nothing to preview, since everything still on
       screen carries it. */
    if (!t || t === (activeTag || '').trim()) {
        document.body.classList.remove('tag-peeking');
        _tagPeekIds = null;
        /* Hold the gesture's own clock for one transition past the release, so the items come back as quickly as
           they left. Temporary by construction: the class is dropped as soon as that transition is over. */
        if (was) {
            document.body.classList.add('tag-peek-fade');
            _after('tag.peekFade', () => document.body.classList.remove('tag-peek-fade'), _cssMs('--uiHoverTrans', 188) + 60);
        }
        _netRequestDraw(0);
        return;
    }
    const ids = new Set();
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.tags || !it.tags.includes(t)) continue;
        ids.add(it.id);
        const el = _tagPeekElFor(it.id);
        if (el) el.classList.add('tag-peek-match');
    }
    _tagPeekIds = ids;
    _cancel('tag.peekFade');
    document.body.classList.remove('tag-peek-fade');
    document.body.classList.add('tag-peeking');
    // The edges answer to the same preview: see the peek gate in the netvis draw.
    _netRequestDraw(0);
}

/* ── Item peek ──────────────────────────────────────────────────────────────
   The same gesture from the item's end: the views call this as the pointer enters and leaves an item, and the
   chips it does not carry step back. Only the chips are touched — a handful of elements — so this is cheap enough
   to run on a pointer sweep across a list. */
let _itemPeekHoverId = '';   // the item the views last reported under the pointer
let _itemPeekId = '';        // the item the cloud is answering, which is not always the same one

function _setItemPeek(id) {
    if (!_tagSidebarEnabled()) return;
    const v = (id || '').trim();
    if (v === _itemPeekHoverId) return;
    _itemPeekHoverId = v;
    /* Leaving the item that has just become the selection is a handover, not a release: the cloud is about to say
       the same thing in its own cue — .focus on this item's tags, .dim on the rest — and entering the monad holds
       that update back until the move is over. Letting go here would send every other chip up to full for the
       length of the transition and then down again. _syncItemPeek takes the marks off instead, in the same task
       that writes the cue. */
    if (!v && _itemPeekId && _itemPeekId === _selectedItemId()) return;
    _syncItemPeek();
}

/** Bring the marks in line with the pointer and the selection. Called again at the end of every cloud update, so a
 *  handover is released exactly when the cue replacing it lands, and so the marks survive a rebuild of the chips. */
function _syncItemPeek(force = false) {
    if (!_tagSidebarEnabled()) return;
    /* Pointing at the selected item asks what the cloud is already answering, so it draws no peek of its own. */
    const want = (_itemPeekHoverId && _itemPeekHoverId !== _selectedItemId()) ? _itemPeekHoverId : '';
    if (want === _itemPeekId && !force) return;
    _itemPeekId = want;

    const prev = _tagCloudEl ? _tagCloudEl.querySelectorAll('.item-peek-match') : [];
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove('item-peek-match');

    const it = want ? _getTagItemById()[want] : null;
    /* An item with no tags leads with nothing rather than greying the whole cloud, which is the same rule the
       resting cue for a selected item follows. */
    if (!it || !it.tags || !it.tags.length) {
        document.body.classList.remove('item-peeking');
        return;
    }
    for (let i = 0; i < it.tags.length; i++) {
        const chip = _tagChipByTag.get(it.tags[i]);
        if (chip) chip.classList.add('item-peek-match');
    }
    document.body.classList.add('item-peeking');
}

/** The click: carry the previewed state into the filter rather than dropping it first. The marks and the commit
 *  class stay only for the length of the fade the filter runs, then everything written here is taken back. */
function _commitTagPeek() {
    if (!_tagPeek) return;
    _tagPeek = '';
    _tagPeekIds = null;
    _cancel('tag.peekFade');
    document.body.classList.remove('tag-peeking', 'tag-peek-fade');
    document.body.classList.add('tag-peek-commit');
    _after('tag.peekCommit', () => {
        document.body.classList.remove('tag-peek-commit');
        _clearTagPeekMarks();
    }, UI_TRANS_MS + 120);
    _netRequestDraw(0);
}

/** In list mode, update the tag cloud only once layout has settled after an expand or collapse, so opacity, font-weight and viewport-based frequencies all update in one go. */
function _scheduleTagCloudUpdateAfterListMotion(extraEl) {
    if (!_tagSidebarEnabled()) return;

    // Cancel any pending "after-transition" update (selection may change quickly).
    _cancel('tag.cloudList');

    if (!extraEl) {
        _scheduleTagCloudUpdate(true);
        return;
    }

    const ms = _maxHeightTransitionMs(extraEl);
    // Suppress scroll-driven intermediate updates during the transition window.
    _holdTagCloud(ms + 40);

    let done = false;
    // Release the hold window immediately once we have the settled layout.
    const settle = () => {
        if (done) return;
        done = true;
        extraEl.removeEventListener('transitionend', onEnd);
        _tagCloudHoldUntil = 0;
        _cancel('tag.cloudHold');
        _scheduleTagCloudUpdate(true);
    };
    const onEnd = (ev) => {
        if (ev && ev.target !== extraEl) return;
        if (ev && ev.propertyName && ev.propertyName !== 'max-height') return;
        settle();
    };

    // Prefer the real transition end; keep a timeout fallback for Safari edge cases.
    extraEl.addEventListener('transitionend', onEnd);
    _after('tag.cloudList', settle, ms + 90);
}

/* ══ LIST LINKS ════════════════════════════════════════════════════════════
   A curve from the thumbnail of each visible list row to the sidebar chip of each tag it carries, drawn in the gutter the sidebar reserves on the left so the lines cross empty page rather than the rows they belong to.
   The image is the endpoint rather than the title: it is the one part of a row whose position says which row this is at a glance, and its left edge moves with the picture's own proportions, so the fan reads as attached to the items rather than to a ruled margin. The images also sit ON TOP of the fan (a curve running down the gutter passes behind every thumbnail it crosses, not just its own) which is paint order rather than anything this code does: see the canvas's own rules.
   The line width and colour are netvis's, read from the same _netGetRootCSCache, so the two can't drift apart and a colour-scheme change updates both at once.
   Three strengths at one width: the selected row's curves in --fg2, anything under the pointer in the same --fg2 at LIST_LINK_ALPHA, the rest in --gray at that same alpha. Two ways to be under the pointer: pointing at a row lights everything leaving it, pointing at a chip lights everything arriving at it.
   Under a tag filter the fan stays, minus the selected tag itself: every row on screen carries that one by definition, so a line to it from each of them restates the filter, while the other tags on those rows are the thing worth looking at.
   Only rows actually on screen are considered, and they are tracked by an IntersectionObserver rather than measured per frame: the list is ~310 rows, and a scroll that rect-read all of them every frame would cost more than the drawing does. */

const _listLinksCanvas = document.getElementById('list-links');
let _listLinksCtx = null;
let _listLinksW = 0, _listLinksH = 0, _listLinksDPR = 0;
let _listLinksRAF = 0;
let _listLinksSettleUntil = 0;
const _listLinkRows = new Set();   // rows currently intersecting the viewport
let _listLinkIO = null;
let _listLinkHoverTag = '';        // chip the pointer is on, '' when none

/* The alpha the two unselected tiers share; only the selection draws at full strength. */
const LIST_LINK_ALPHA = 0.5;
/* Clearance at each end, in rem: the curve leaves clear of the chip's right edge and stops short of the thumbnail's left edge, so neither looks tethered. */
const LIST_LINK_GAP_REM = 0.5;
/* How far the control points sit from their own end, as a share of the horizontal run. At 0.5 the curve is a pure S; below that it straightens toward the middle. */
const LIST_LINK_BOW = 0.45;
/* Depth of the fade band at the top and bottom of the window, in rem: a row's curves are at full strength once its
   thumbnail is this far inside, and reach zero as its centre meets the edge. About a row and a half, so a fan
   arrives and leaves over roughly its own row rather than being switched on at the moment of first contact. */
const LIST_LINK_EDGE_FADE_REM = 5;
/* Per-row strength is quantised to this many steps before it picks a bucket, so a whole fan of curves at the same
   strength is still one path and one stroke. Only rows inside the fade band, or mid-fold, land off the top step,
   so a still list draws in the same three strokes it always did. 24 is fine enough that a slow scroll reads as a
   fade rather than a staircase (each step is ~2% of alpha, under what the eye resolves against the background). */
const LIST_LINK_FADE_STEPS = 24;

function _listLinksEnabled() {
    if (!_listLinksCtx || isMobile) return false;
    if (viewMode !== 'list') return false;
    if (!document.body.classList.contains('has-tag-sidebar')) return false;
    return !!(_tagChipByTag && _tagChipByTag.size);
}

/** Size the backing store to the viewport at device resolution. setTransform rather than scale, so repeated calls don't compound the ratio. */
function _listLinksResize() {
    if (!_listLinksCanvas) return;
    if (!_listLinksCtx) {
        if (!_listLinksCanvas.getContext) return;
        _listLinksCtx = _listLinksCanvas.getContext('2d');
        if (!_listLinksCtx) return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === _listLinksW && h === _listLinksH && dpr === _listLinksDPR) return;
    _listLinksW = w; _listLinksH = h; _listLinksDPR = dpr;
    _listLinksCanvas.width = Math.round(w * dpr);
    _listLinksCanvas.height = Math.round(h * dpr);
    _listLinksCanvas.style.width = w + 'px';
    _listLinksCanvas.style.height = h + 'px';
    _listLinksCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _listLinksDraw() {
    /* Hold the last frame through a mode switch. Two reasons, and they pull the same way: mid cross-fade the list is pinned and translated and the chips are on their way somewhere, so anything drawn now would be drawn against geometry that is in motion; and the canvas has to keep its pixels for the CSS above to have something to fade out, where clearing it would blank the fan in one frame and leave the fade with nothing to do. */
    if (document.body.classList.contains('mode-xfade')) return;
    _listLinksResize();
    if (!_listLinksCtx) return;
    _listLinksCtx.clearRect(0, 0, _listLinksW, _listLinksH);
    if (!_listLinksEnabled() || !_listLinkRows.size) return;

    const rcs = _netGetRootCSCache();
    const gap = LIST_LINK_GAP_REM * _rootRemPx();
    const byId = _getTagItemById();
    // The selected tag, which every row on screen carries by definition: see the tag loop below.
    const activeNow = (activeTag || '').trim();
    // One rect per chip per draw, however many rows arrive at it.
    const chipRects = new Map();
    /* Three tiers: sel is the selected row's own curves, hov is anything under the pointer (a row being pointed at,
       or a chip, which lights everything arriving at it), rest is everything else. Each tier holds its segments as
       flat [x1, y1, x2, y2, ...] keyed by the row's quantised strength, so one strength is one path and one stroke
       however many rows share it. */
    const rest = new Map();
    const hov = new Map();
    const sel = new Map();
    const fade = LIST_LINK_EDGE_FADE_REM * _rootRemPx();

    _listLinkRows.forEach((row) => {
        if (!row.isConnected || row.classList.contains('list-out')) return;
        // The frame rather than the img for an item with no picture, whose grey stand-in is sized by transform and would measure its untransformed box here.
        const anchorEl = row.querySelector('img.list-thumb') || row.querySelector('.list-thumb-frame');
        if (!anchorEl) return;
        const ar = anchorEl.getBoundingClientRect();
        // A row the browser has skipped under content-visibility measures empty; so does one the observer has not caught leaving yet.
        if (ar.width <= 0 || ar.bottom < 0 || ar.top > _listLinksH) return;
        const it = byId[row.getAttribute('data-id')];
        if (!it || !it.tags || !it.tags.length) return;
        const x2 = ar.left - gap * 0.7;
        const y2 = ar.top + ar.height / 2;
        /* How strongly this row's fan draws. Two things dim it, and they multiply: how near the window edge the row
           has scrolled, and, while a tag or a search folds it in or out, the opacity the fold has it at. The second
           is read from the computed style rather than tracked, so the curves follow whatever the fold does without
           a second copy of its clock here; only a folding row pays for the read, and only while it folds. */
        let rowA = fade > 0 ? _clamp01(Math.min(y2, _listLinksH - y2) / fade) : 1;
        if (rowA > 0 && row.classList.contains('list-folding')) {
            const o = parseFloat(getComputedStyle(row).opacity);
            if (o >= 0) rowA *= o;
        }
        const lvl = Math.round(rowA * LIST_LINK_FADE_STEPS);
        if (lvl <= 0) return;
        // Row-level half of the highlight; the tag-level half is decided per edge below, since one row's curves can end at several chips and only the hovered one should light.
        const rowSel = row.classList.contains('selected');
        const rowHov = row.classList.contains('row-hover');

        for (let i = 0; i < it.tags.length; i++) {
            const tag = (it.tags[i] || '').trim();
            // The selected tag is the one thing every visible row has in common, so a line to it from each of them restates the filter and tells the reader nothing. Its chip is already marked .active.
            if (!tag || (activeNow && tag === activeNow)) continue;
            let cr = chipRects.get(tag);
            if (cr === undefined) {
                const chip = _tagChipByTag.get(tag);
                cr = (chip && !chip.classList.contains('hidden')) ? chip.getBoundingClientRect() : null;
                if (cr && (cr.width <= 0 || cr.height <= 0)) cr = null;
                chipRects.set(tag, cr);
            }
            if (!cr) continue;
            // 0.55 rather than 0.5 sits on the chip text's optical centre instead of its box's.
            const x1 = cr.right + gap;
            const y1 = cr.top + cr.height * 0.55;
            // A chip scrolled off the top or bottom of its own column, or one long enough to have overrun the thumbnail it would reach: nothing sensible to draw.
            if (x2 <= x1 || cr.bottom < 0 || cr.top > _listLinksH) continue;
            const bucket = rowSel ? sel
                : (rowHov || (_listLinkHoverTag && tag === _listLinkHoverTag)) ? hov
                : rest;
            let segs = bucket.get(lvl);
            if (segs === undefined) bucket.set(lvl, (segs = []));
            segs.push(x1, y1, x2, y2);
        }
    });

    /* One width for every tier, and it is netvis's own: max(0.5, rootFontSize * 0.1), off the same cache, so these curves and the map's edges stay the same weight as each other and both follow the window: the root size is a viewport formula and the cache is dropped on resize. */
    _listLinksCtx.lineWidth = rcs.lineWidth;
    _listLinksCtx.lineCap = 'butt';
    _listLinksCtx.lineJoin = 'miter';

    const _strokeAll = (segs, colour, alpha) => {
        if (!segs.length) return;
        _listLinksCtx.globalAlpha = alpha;
        _listLinksCtx.strokeStyle = colour;
        _listLinksCtx.beginPath();
        for (let i = 0; i < segs.length; i += 4) {
            const x1 = segs[i], y1 = segs[i + 1], x2 = segs[i + 2], y2 = segs[i + 3];
            // Both control points sit on their own end's y, so the curve leaves the chip flat, does all its bending in the middle of the gutter, and arrives flat at the thumbnail.
            const k = (x2 - x1) * LIST_LINK_BOW;
            _listLinksCtx.moveTo(x1, y1);
            _listLinksCtx.bezierCurveTo(x1 + k, y1, x2 - k, y2, x2, y2);
        }
        _listLinksCtx.stroke();
    };

    // One tier: its strength buckets, each stroked at the tier's alpha scaled by the bucket's own step.
    const _strokeTier = (buckets, colour, alpha) => {
        buckets.forEach((segs, lvl) => _strokeAll(segs, colour, alpha * lvl / LIST_LINK_FADE_STEPS));
    };

    // Painted weakest first, so where tiers cross, the stronger one is on top.
    _strokeTier(rest, rcs.gray, LIST_LINK_ALPHA);
    _strokeTier(hov, rcs.fg2 || rcs.fg, LIST_LINK_ALPHA);
    _strokeTier(sel, rcs.fg2 || rcs.fg, 1);
    _listLinksCtx.globalAlpha = 1;
}

/* Whether a row or a chip is still moving or resizing: counted from the browser's own transition events, as for the
   map's edges (_netMotionRunning), since a fixed settle window could end while the rows were still folding or the
   chips still easing, and the curves were left drawn against where things had been. --wght is in the list because a
   chip's weight sets its width, and with it where its curves start. */
const _LL_MOTION_PROPS = /^(transform|translate|scale|max-height|height|width|min-height|top|left|margin(-\w+)?|padding(-\w+)?|font-size|line-height|--ty|--ts|--wght)$/;
const _llMotions = new Map();   // element -> Set of transitioning property names
let _llMotionSince = 0;
function _llMotionTarget(e) {
    const t = e.target;
    if (!t || !_LL_MOTION_PROPS.test(e.propertyName) || !t.closest) return null;
    return (t.closest('#list-view') || t.closest('#tag-cloud')) ? t : null;
}
document.addEventListener('transitionrun', (e) => {
    const t = _llMotionTarget(e);
    if (!t) return;
    if (!_llMotions.size) _llMotionSince = performance.now();
    let set = _llMotions.get(t);
    if (!set) _llMotions.set(t, (set = new Set()));
    set.add(e.propertyName);
    _scheduleListLinksDraw();
}, true);
const _llMotionDone = (e) => {
    const t = _llMotionTarget(e);
    if (!t) return;
    const set = _llMotions.get(t);
    if (!set) return;
    set.delete(e.propertyName);
    if (!set.size) _llMotions.delete(t);
    // The last motion out: one more draw against the settled geometry.
    if (!_llMotions.size) { _llMotionSince = 0; _scheduleListLinksDraw(); }
};
document.addEventListener('transitionend', _llMotionDone, true);
document.addEventListener('transitioncancel', _llMotionDone, true);
/* A class change that moves rows without a transition (a selection closing, a row folding in one step) raises no
   transition event, so it is watched directly; the observer runs before the next frame, which then draws against
   the new layout rather than a frame late. */
if (listView && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
        if (viewMode === 'list') _scheduleListLinksDraw();
    }).observe(listView, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
function _listLinksMoving() {
    if (!_llMotions.size) return false;
    // Safety net: an element hidden or removed mid-transition may never report its end.
    if (performance.now() - _llMotionSince > 3000) { _llMotions.clear(); _llMotionSince = 0; return false; }
    return true;
}

function _scheduleListLinksDraw() {
    if (_listLinksRAF) return;
    _listLinksRAF = requestAnimationFrame(() => {
        _listLinksRAF = 0;
        _listLinksDraw();
        // Every frame while the settle window lasts or anything in the list or the cloud is still moving (list view only: elsewhere there are no curves to keep up).
        if (performance.now() < _listLinksSettleUntil || (viewMode === 'list' && _listLinksMoving())) _scheduleListLinksDraw();
    });
}

/** Chips ease to new positions on --tagTrans and rows fold and expand on their own clocks, so one draw after any of those lands on geometry that is still moving. Keep drawing until it has stopped. */
function _scheduleListLinksSettle(ms) {
    _listLinksSettleUntil = Math.max(_listLinksSettleUntil,
        performance.now() + (typeof ms === 'number' ? ms : 900));
    _scheduleListLinksDraw();
}

/** Observe the rows once, when the permanent list DOM is built. Filtered-out rows are display: none and so never report as intersecting, which is the filter handled for free. */
function _bindListLinkRows() {
    if (isMobile || !listView || typeof IntersectionObserver === 'undefined') return;
    if (_listLinkIO) _listLinkIO.disconnect();
    _listLinkRows.clear();
    _listLinkIO = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e.isIntersecting) _listLinkRows.add(e.target);
            else _listLinkRows.delete(e.target);
        }
        _scheduleListLinksDraw();
    }, { rootMargin: '15% 0px' });
    const els = listView.querySelectorAll('.list-item');
    for (let i = 0; i < els.length; i++) _listLinkIO.observe(els[i]);
    _scheduleListLinksSettle();
}

// The body is the scroller in list view, so this is the list's own scroll.
window.addEventListener('scroll', _scheduleListLinksDraw, { passive: true });
// The pointer moving between rows changes which fan is lit, and .row-hover is set from JS rather than by :hover, so there is no CSS state to key off.
if (listView) listView.addEventListener('mousemove', _scheduleListLinksDraw, { passive: true });
if (listView) listView.addEventListener('mouseleave', _scheduleListLinksDraw, { passive: true });

/* ══ HOOKS ════════════════════════════════════════════════════════════════════ */

Object.assign(tagVis, {
    update: _tagCloudUpdate,
    updateAfterTransition: _scheduleTagCloudUpdateAfterTransition,
    updateAfterListMotion: _scheduleTagCloudUpdateAfterListMotion,
    requestSettle: _requestTagCloudSettle,
    quietForFilterChange: _quietTagCloudForFilterChange,
    setActiveOnly: _setTagCloudActiveOnly,
    invalidateSizes() {
        _tagWidthCache.clear();
        _tagCloudAvailH = 0;
        _tagCloudRemPx = 0;
    },
    bindLinkRows: _bindListLinkRows,
    linksSettle: _scheduleListLinksSettle,
    drawLinksNow() { if (viewMode === 'list') _listLinksDraw(); },
});
