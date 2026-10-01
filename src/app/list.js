/* ══ LIST ══════════════════════════════════════════════════════════════════════
   The list view: the collection in chronological order. The tag cloud beside it and the curves from its rows to
   the cloud are in tag.js (desktop only); the tag filter itself is shared state in core.js. */

// The list's rows, cached for tag.js's visible-id test; cleared whenever the rows are rebuilt.
let _listItemElsCache = null;

// Resize: recompute the tag sidebar (where there is one) and the map layout
window.addEventListener('resize', () => {
    if (_heightOnlyResizeOnTouch()) return;
    tagVis.invalidateSizes();
    _scheduleTagCloudUpdate(true);
    if (!_isPanelView()) update();
});
let listSelectedId = null;
let listOrderIds = [];
/* Find list DOM element by id (avoid CSS.escape dependency) */
function _getListItemEl(id) {
    if (!listView || !id) return null;
    const els = listView.querySelectorAll('.list-item');
    // Loop over matching DOM elements.
    for (const el of els) {
        if (el.getAttribute('data-id') === id) return el;
    }
    return null;
}

/** Helper: list thumb area, as an edge squared, so every thumb covers the same area whatever its aspect ratio. */
function _listThumbArea(open = false) {
    // Mobile sets both edges in CSS (see --listThumbRest / --listThumbOpen). Elsewhere they are unset and read as 0.
    const cssEdge = _cssLengthPx(listView, open ? '--listThumbOpen' : '--listThumbRest');
    if (cssEdge > 0) return cssEdge * cssEdge;
    const isWide = window.matchMedia('(min-width: 1100px)').matches;
    const edge = open
        ? _clamp(Math.round(window.innerWidth * (isWide ? 0.1475 : 0.119)), 131, (isWide ? 344 : 246))
        // Hover enlarges this via transform: scale(var(--listThumbHoverScale)), so the
        // layout box stays at the resting size and the row rhythm holds.
        : _clamp(Math.round(window.innerWidth * (isWide ? 0.0355 : 0.0395)), 47, 71);
    return edge * edge;
}

/** Update list hash for the current UI state. */
function _updateListHash(updateHash = true, push = false) {
    if (!updateHash) return;
    _writeAddress({ view: 'list', ..._filterParts(), i: listSelectedId }, push);
}

// ── JS-driven row hover (see the .row-hover CSS note) ─────────────────────
const _listHoverPtr = { x: -1, y: -1 };
let _listHoverRow = null;

/** Horizontal content band of a row: the span the title and the thumbnail together occupy, gap included.
 *  Everything outside is empty margin that shouldn't trigger hover. */
function _listRowContentBand(row) {
    const wrap = row.querySelector('.list-thumb-wrap');
    const title = row.querySelector('.list-title');
    if (!wrap || !title) return null;
    const wr = wrap.getBoundingClientRect();
    const tr = title.getBoundingClientRect();
    if (!wr.width || !tr.width) return null;
    // wrap's rect widens while hovered (the thumb is scaled up); that simply
    // yields a little hysteresis at its outer edge, which prevents flicker.
    return { left: Math.min(wr.left, tr.left), right: Math.max(wr.right, tr.right) };
}

function _setListRowHover(row) {
    if (_listHoverRow && !_listHoverRow.isConnected) _listHoverRow = null; // re-rendered away
    if (row === _listHoverRow) return;
    if (_listHoverRow) _listHoverRow.classList.remove('row-hover');
    _listHoverRow = row;
    // Only the hovered row responds to the pointer.
    if (row) row.classList.add('row-hover');
    // The sidebar answers the same hover: see _setItemPeek.
    if (typeof _setItemPeek === 'function') _setItemPeek(row ? row.getAttribute('data-id') : '');
}

function _updateListHoverFromPointer() {
    const { x, y } = _listHoverPtr;
    if (x < 0) return;
    const el = document.elementFromPoint(x, y);
    const row = el && el.closest ? el.closest('.list-item') : null;
    if (!row || !listView.contains(row)) { _setListRowHover(null); return; }
    const band = _listRowContentBand(row);
    if (!band || x < band.left || x > band.right) { _setListRowHover(null); return; }
    _setListRowHover(row);
}

/** Deselect a list item from a pointer click, landing in the hovered state. CSS handles the collapse when the
 *  pointer stays on the row; two things need JS help:
 *  1. META: dropping .selected swaps it static-to-absolute instantly, and the overlay's top:100% anchor still
 *  contains the mid-collapse .list-extra height, so the meta teleports below the folding text.
 *  2. IMAGE: open width times rising scale is never monotonic, without delay it overshoots the open size, with
 *  delay it dips below the hover size. */
function _deselectListItemFromClick(itemEl, id) {
    const hov = !isMobile && itemEl.classList.contains('row-hover');

    // Capture the OPEN thumb size before setListSelection resets it, so both paths can animate the image from open to rest rather than letting _applyListThumbSize snap it, which made the image go astray while the wrap's lift transform was still animating.
    const _wrap0 = itemEl.querySelector('.list-thumb-wrap');
    const _img0 = itemEl.querySelector('img.list-thumb');
    const _openW = _img0 ? (parseFloat(_img0.style.width) || 0) : 0;
    const _openH = _img0 ? (parseFloat(_img0.style.height) || 0) : 0;

    setListSelection(id, false, true, true, true); // toggle off

    if (!hov) {
        // No hover means no scale(2) involved, so a straightforward shrink from open to the rest size setListSelection already wrote inline, on the collapse clock.
        if (_wrap0 && _img0 && _openW > 0 && _openH > 0) {
            const restW = parseFloat(_img0.style.width) || _openW;
            const restH = parseFloat(_img0.style.height) || _openH;
            _img0.style.setProperty('transition', 'none', 'important');
            _img0.style.width = _openW + 'px';
            _img0.style.height = _openH + 'px';
            requestAnimationFrame(() => {
                _img0.style.removeProperty('transition');
                // rely on the .animating sync transition for width/height
                _img0.style.width = restW + 'px';
                _img0.style.height = restH + 'px';
            });
        }
        return;
    }
    const wrap = itemEl.querySelector('.list-thumb-wrap');
    const img = itemEl.querySelector('img.list-thumb');
    if (wrap && img) {
        const rw = parseFloat(img.style.width) || 0;
        const rh = parseFloat(img.style.height) || 0;
        if (rw > 0 && rh > 0) {
            // Collapse at scale 1 (the inline transform outranks the hover rule) toward twice the rest size, reading the CSS hover scale rather than hardcoding it.
            const hs = parseFloat(getComputedStyle(listView).getPropertyValue('--listThumbHoverScale')) || 1.5;
            // Hover lifts the row, so the inline transform that holds scale 1 through the collapse has to carry the lift too, otherwise clearing it at settle drops the image by --listHoverLift in one frame.
            wrap.style.transform = 'translate3d(0, calc(-1 * var(--listHoverLift)), 0)';
            img.style.width = (rw * hs) + 'px';
            img.style.height = (rh * hs) + 'px';
            setTimeout(() => {
                if (!img.isConnected || itemEl.classList.contains('selected')) return;
                const wt = wrap.style.transition, it = img.style.transition;
                // Reach the resting hover state (rest-size img plus the hover rule's scale(2)) without a same-frame multi-write
                // race.
                wrap.style.setProperty('transition', 'none', 'important');
                img.style.setProperty('transition', 'none', 'important');
                wrap.style.transform = ''; // hover rule's scale(2) governs now
                img.style.width = rw + 'px';
                img.style.height = rh + 'px';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        wrap.style.removeProperty('transition');
                        img.style.removeProperty('transition');
                        if (wt) wrap.style.transition = wt;
                        if (it) img.style.transition = it;
                    });
                });
            }, _cssMs('--listTrans') + 20);
        }
    }
}

/** Apply list thumb size. */
function _applyListThumbSize(itemEl) {
    if (!itemEl) return;
    const img = itemEl.querySelector('img.list-thumb');
    if (!img) return;

    const nw = img.naturalWidth || parseFloat(img.dataset.nw) || 0;
    const nh = img.naturalHeight || parseFloat(img.dataset.nh) || 0;
    if (!(nw > 0 && nh > 0)) return;

    img.dataset.nw = nw;
    img.dataset.nh = nh;

    const open = itemEl.classList.contains('selected');
    const isPlaceholder = itemEl.classList.contains('placeholder-img');
    // A selected placeholder takes a fixed edge when the mobile block sets one (one button across); otherwise placeholders take a share of the image area.
    const phEdge = (isPlaceholder && open) ? _cssLengthPx(listView, '--listThumbOpenPlaceholder') : 0;
    const area = _listThumbArea(open) * (isPlaceholder ? (open ? 1/95 : 1/15) : 1);

    // Respect available left-column width (prevents overlap into the text column)
    const rect = itemEl.getBoundingClientRect();
    const cs = getComputedStyle(itemEl);
    const gap = parseFloat(cs.columnGap) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;

    let colW = rect.width;

    // Prefer measuring the actual start of the text column (robust across fr/minmax layouts).
    const main = itemEl.querySelector('.list-main');
    if (main) {
        const mr = main.getBoundingClientRect();
        colW = Math.max(0, mr.left - rect.left - padL - gap);
        // Desktop: the image's left edge stays one window-to-button gap right of the corner buttons, whose column the list's padding otherwise lets a wide selected image reach into (the grid keeps the same margin).
        if (!isMobile && colW > 0) {
            const btn = document.getElementById('info-btn');
            if (btn) {
                const br = btn.getBoundingClientRect();
                const room = (mr.left - gap) - (br.right + br.left);
                if (room > 0) colW = Math.min(colW, room);
            }
        }
        // Text starting at the row's left edge means the row is stacked (a selected row on mobile), so the image has the
        // whole content width.
        if (mr.width > 0 || mr.height > 0) {
            if (mr.left - rect.left - padL < 1) colW = Math.max(0, rect.width - padL - (parseFloat(cs.paddingRight) || 0));
        } else {
            colW = 0;
        }
    } else {
        // Fallback: try parsing px columns; otherwise assume a 1/3 split.
        const cols = (cs.gridTemplateColumns || '').trim().split(/\s+/).filter(Boolean);
        if (cols.length > 1) {
            const mm = cols[0].match(/^([0-9.]+)px$/);
            colW = mm ? parseFloat(mm[1]) : Math.max(0, (rect.width - gap) * (1/3));
        }
    }

    /* Prevent thumbnail resize animations during search updates / lazy loading. The edge colour is exempt: it is
       what the tag preview lifts to --fg and back, and a blanket 'none' wrote that straight over the stylesheet's
       own easing, so the edge arrived and left in a single frame. Nothing is sized from it, so it cannot jitter. */
    const allowTrans = itemEl.classList.contains('selected') || itemEl.classList.contains('animating');
    img.style.transition = allowTrans ? '' : 'border-color var(--uiHoverTrans) var(--uiEase)';

    let scale = Math.sqrt(area / (nw * nh));
    if (colW > 0 && (nw * scale) > colW) scale = colW / nw;
    // Open cap on both sides, set on mobile only (--listThumbOpenMax). Placeholders take their own edge below and skip it.
    if (open) {
        const maxS = _cssLengthPx(listView, '--listThumbOpenMax');
        if (maxS > 0) {
            if ((nw * scale) > maxS) scale = maxS / nw;
            if ((nh * scale) > maxS) scale = maxS / nh;
        }
    }

    // The placeholder edge is left unrounded so the square matches the button to the subpixel.
    const w = phEdge > 0 ? phEdge : Math.max(1, Math.round(nw * scale));
    const h = phEdge > 0 ? phEdge : Math.max(1, Math.round(nh * scale));

    img.style.width = w + 'px';
    img.style.height = h + 'px';
}

// List thumbnail sizing can be expensive (many DOM reads). Do it progressively to keep Safari smooth.
let __deferListThumbSizing = false;
/** Helper: cancel list thumb sizing. */
function _cancelListThumbSizing() {
    _cancel('list.thumbSizingFrame');
}
/** Propagate an item's no-image verdict to its DOM elements, for both map/monad articles and list rows, so the
 *  class applies regardless of entry view. The verdict itself comes from items.json via _applyImageBundle. */
function _detectAndMarkPlaceholder(img, itemEl) {
    const id = (img.dataset && img.dataset.id) || (itemEl && itemEl.getAttribute('data-id'));
    if (!id) return;
    const itemById = _getTagItemById();
    const item = itemById[id];
    if (!item) return;

    // Propagate flag to all relevant DOM elements
    if (item._isPlaceholderImg) {
        if (itemEl) itemEl.classList.add('placeholder-img');
        const article = _articleById(id);
        if (article) article.classList.add('placeholder-img');
        const _lv = document.getElementById('list-view');
        const li = _lv && _lv.querySelector('.list-item[data-id="' + id + '"]');
        if (li) li.classList.add('placeholder-img');
    }
}

/** Apply list thumb size once. */
function _applyListThumbSizeOnce(itemEl) {
    if (!itemEl) return;
    const img = itemEl.querySelector('img.list-thumb');
    if (!img) return;
    const hasMeta = !!(img.dataset.nw && img.dataset.nh && parseFloat(img.dataset.nw) > 0 && parseFloat(img.dataset.nh) > 0);
    if (hasMeta || (img.complete && img.naturalWidth)) {
        // Run placeholder detection if image is already loaded
        _detectAndMarkPlaceholder(img, itemEl);
        if (img.naturalWidth) _applySizingFromLoadedImg(img, itemEl.dataset.id);
        _applyListThumbSize(itemEl);
    }
    // Register a load handler if the image hasn't loaded. Some browsers set complete=true for lazy images that haven't, so register whenever naturalWidth is missing regardless of complete.
    if (!img.naturalWidth) {
        img.addEventListener('load', function _onListThumbLoad() {
            img.removeEventListener('load', _onListThumbLoad);
            img.dataset.nw = img.naturalWidth;
            img.dataset.nh = img.naturalHeight;
            // Run placeholder detection on load
            _detectAndMarkPlaceholder(img, itemEl);
            _applySizingFromLoadedImg(img, itemEl.dataset.id);
            _applyListThumbSize(itemEl);
        });
    }
}
/** Size the list's thumbnails, a chunk per frame. Rows the filter hides are skipped (they have no box to measure)
 *  and sized when they show again: by the fold animation, or, when they show at once, by the unsized-only pass
 *  _renderListFull runs after every filter change. */
function _bindListThumbSizing(onlyUnsized) {
    if (!listView) return;
    if (__deferListThumbSizing) {
        // Only size the selected item for stable geometry during mode switches.
        if (listSelectedId) _applyListThumbSizeOnce(_getListItemEl(listSelectedId));
        return;
    }

    _cancelListThumbSizing();
    let els = Array.from(listView.querySelectorAll('.list-item'));
    if (onlyUnsized) {
        els = els.filter(el => { const img = el.querySelector('img.list-thumb'); return img && !img.style.width; });
        if (!els.length) return;
    }
    let i = 0;
    const CHUNK = isAppleWebKit ? 18 : 40;

    const step = () => {
        const end = Math.min(i + CHUNK, els.length);
        // Loop.
        for (; i < end; i++) {
            // Hidden (filtered-out) items can't be measured while display:none;
            // they're sized when revealed by the fold animation.
            if (els[i].classList.contains('list-out')) continue;
            _applyListThumbSizeOnce(els[i]);
        }
        if (i < els.length) {
            _onFrame('list.thumbSizingFrame', step);
        }
    };
    _onFrame('list.thumbSizingFrame', step);
}
/** Open list extra. */
function _openListExtra(itemEl, instant = false) {
    // Fill before anything reads scrollHeight: see _ensureListExtra.
    const extra = _ensureListExtra(itemEl);
    if (!extra) return;
    // A collapse may still be easing this row's meta height toward 0 with a
    // forwards fill; release it before expanding.
    _cancelMetaFlowEase(itemEl);
    if (itemEl) {
        // Whichever box the ease was holding: the meta at level 1, the source at level 2.
        const _m = itemEl.__metaFlowEl || itemEl.querySelector('.list-source');
        if (_m) _m.style.removeProperty('overflow');
    }

    if (instant) {
        const prev = extra.style.transition;
        extra.style.transition = 'none';
        extra.style.maxHeight = 'none';
        requestAnimationFrame(() => { extra.style.transition = prev; });
        return;
    }

    // Ensure a clean start value so the transition always runs.
    extra.style.maxHeight = '0px';
    requestAnimationFrame(() => {
        extra.style.maxHeight = extra.scrollHeight + 'px';
    });
    /* No flow-height ease on the way in, deliberately, and the grid is the reference for why: there the meta snaps
       out of its clamp on the click and everything after that is one animation. */
    const onEnd = (ev) => {
        if (ev.propertyName !== 'max-height') return;
        extra.removeEventListener('transitionend', onEnd);
        // Avoid occasional cut-offs: once open, remove the max-height clamp.
        if (itemEl && itemEl.classList.contains('selected')) {
            extra.style.maxHeight = 'none';
        }
    };
    extra.addEventListener('transitionend', onEnd);
}

/** Cancel a running meta flow-height ease (e.g. the row is being re-selected). */
function _cancelMetaFlowEase(itemEl) {
    if (itemEl && itemEl.__metaFlowAnim) {
        try { itemEl.__metaFlowAnim.cancel(); } catch (e) { /* noop */ }
        itemEl.__metaFlowAnim = null;
    }
    if (itemEl && itemEl.__metaFlowStartTO) {
        clearTimeout(itemEl.__metaFlowStartTO);
        itemEl.__metaFlowStartTO = null;
    }
    if (itemEl && itemEl.__metaFlowTO) {
        clearTimeout(itemEl.__metaFlowTO);
        itemEl.__metaFlowTO = null;
    }
}

/** Ease the box that is about to LEAVE THE FLOW down to zero height over the tail of a collapse. Which box that is depends on the level. */
function _easeMetaFlowHeightOut(itemEl) {
    // The invariant: the box that leaves the flow at the end of a collapse is the one
    // whose flow height has to reach zero. The author line is permanent content now, so
    // the meta stays in flow and it is the SOURCE that swaps to absolute at the end.
    const target = itemEl ? itemEl.querySelector('.list-source') : null;
    if (!target || typeof target.animate !== 'function') return;
    _cancelMetaFlowEase(itemEl);
    itemEl.__metaFlowEl = target;

    const D = _cssMs('--listTrans');
    const delay = Math.round(D * 0.85);          // after the description has folded
    const durMs = Math.max(120, Math.round(D * 0.35));

    // Measure at the START of the ease, not now: in between the box shrinks on its own (font-size and rewrap), so seeding the keyframe with today's larger height snaps it back up and shoves the next row down.
    itemEl.__metaFlowStartTO = setTimeout(() => {
        itemEl.__metaFlowStartTO = null;
        if (!target.isConnected || itemEl.classList.contains('selected')) return;
        const h = target.offsetHeight;
        if (!h) return;
        target.style.overflow = 'visible'; // keep the text painted while height goes to 0
        itemEl.__metaFlowAnim = target.animate(
            [{ height: h + 'px' }, { height: '0px' }],
            { duration: durMs, easing: 'ease-in-out', fill: 'forwards' }
        );
    }, delay);

    // Release only after `.animating` has dropped: cancelling the forwards fill while the box is still in flow snaps its height back to auto, and every row below jumps down by a line; right after the ease had just pulled them up.
    const _release = () => {
        itemEl.__metaFlowTO = null;
        _cancelMetaFlowEase(itemEl);
        target.style.removeProperty('overflow');
    };
    let _waited = 0;
    const _poll = () => {
        if (!itemEl.isConnected) { _release(); return; }
        if (!itemEl.classList.contains('animating') || _waited >= 1200) { _release(); return; }
        _waited += 60;
        itemEl.__metaFlowTO = setTimeout(_poll, 60);
    };
    itemEl.__metaFlowTO = setTimeout(_poll, D + 100);
}

/** Close list extra. */
function _closeListExtra(itemEl, instant = false) {
    const extra = itemEl ? itemEl.querySelector('.list-extra') : null;
    if (!extra) return;

    if (instant) {
        const prev = extra.style.transition;
        extra.style.transition = 'none';
        extra.style.maxHeight = '0px';
        requestAnimationFrame(() => { extra.style.transition = prev; });
        return;
    }

    // Collapse from the current measured height for a smooth close.
    extra.style.maxHeight = extra.scrollHeight + 'px';
    requestAnimationFrame(() => {
        extra.style.maxHeight = '0px';
    });
    _easeMetaFlowHeightOut(itemEl);
}

/** Helper: scroll list el. */
function _scrollListEl(el, align) {
    if (!listView || !el) return;

    const padTop = parseFloat(getComputedStyle(listView).paddingTop) || 0;
    const offset10vh = Math.round(window.innerHeight * 0.08); // slightly tighter than 10vh
    // Phones aim at the shared band just under the corner buttons, so a row opens at the same height its grid card and its monad do.
    const desiredTop = isMobile ? _mobileSelectionTopPx() : Math.max(offset10vh, padTop + 8);
    // ...and at the row's CONTENT top rather than its box top: a selected row carries 2.7rem of its own padding, which would otherwise push the image that much further down than a grid card's, whose image starts at its top edge.
    const rowPadTop = isMobile ? (parseFloat(getComputedStyle(el).paddingTop) || 0) : 0;

    const r = el.getBoundingClientRect();
    const cr = listView.getBoundingClientRect();

    // Need scroll if the item top is above the desired band, or bottom is below viewport
    const needsScroll = (r.top < cr.top + desiredTop) || (r.bottom > cr.bottom - 12);

    // Two align modes: 'ensure-top10' scrolls only if needed to put the item top near 10vh, 'top10' always does.
    if (align === 'ensure-top10' && !needsScroll) return;

    // IMPORTANT: a true synchronous snap, never scrollTo({behavior}), so the geometry reads that follow a mode
    // switch or an instant selection see the final scroll position.
    listView.scrollTop = Math.max(0, el.offsetTop + rowPadTop - desiredTop);
}

/** Helper: sync list extra. */
function _syncListExtra(itemEl) {
    // Reached on a list rebuild that restores a selection, and on resize -
    // both with a row already open, so the content has to be there.
    const extra = _ensureListExtra(itemEl);
    if (!extra) return;
    extra.style.maxHeight = 'none';
}

/** Re-measure a row once its type has finished easing. The meta offsets come from the title's height, which is still moving when a selection is made, so one pass at settle corrects them. */
function _settleListRowMetrics(itemEl) {
    if (!itemEl) return;
    const id = itemEl.getAttribute('data-id');
    _after('list.metaSettle', () => {
        if (!itemEl.isConnected || !itemEl.classList.contains('selected')) return;
        if (id && listSelectedId !== id) return;
        _updateListMetaOffset(itemEl);
    }, UI_TRANS_MS + 40);
}

/** Update the list meta offset for the current UI state, computed from layout dimensions and known CSS transform constants so the result is independent of animation timing: no getBoundingClientRect during transitions. */
function _updateListMetaOffset(itemEl) {
    if (!itemEl) return;

    // Clear on collapse
    if (!itemEl.classList.contains('selected')) {
        itemEl.style.removeProperty('--metaOffset');
        itemEl.style.removeProperty('--subOffset');
        return;
    }

    const title = itemEl.querySelector('.list-title');
    if (!title) return;
    const subtitle = itemEl.querySelector('.list-subtitle');

    // px gap between the scaled text block and the authors line. Smaller without a subtitle, where the overflow is the scaled title's full box growth running past its visible descenders, so the optical gap already exceeds the geometric one.
    const SCALE = 1.35;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    // Match the CSS base margin for this row: no-subtitle rows use a tighter selected base so the title-to-meta gap isn't inflated by the missing line, and the offset clamp must use the same base.
    const hasSubForBase = itemEl.querySelector('.list-subtitle');
    const BASE_META_MARGIN = (hasSubForBase ? 1.0 : 0) * rem; // .list-item.selected .list-meta base margin-top
    const DESIRED_GAP = hasSubForBase ? 4 : 0; // px, see note above

    const titleH = title.offsetHeight;
    const hasSubtitle = subtitle && subtitle.offsetHeight > 0;
    const subtitleH = hasSubtitle ? subtitle.offsetHeight : 0;
    const subtitleGap = hasSubtitle
        ? (subtitle.offsetTop - (title.offsetTop + titleH))
        : 0;

    // Subtitle translateY: compensate for the title's downward scale overflow
    // so the visual gap between title and subtitle stays proportional.
    const subTranslateY = titleH * (SCALE - 1);
    itemEl.style.setProperty('--subOffset', subTranslateY.toFixed(1) + 'px');

    // With transform-origin: left top, scale(1.35) extends content downward.
    let overflow;
    if (hasSubtitle) {
        const titleExcess = titleH * (SCALE - 1) - subtitleGap - subtitleH;
        const subExcess  = subtitleH * (SCALE - 1) + subTranslateY;
        overflow = Math.max(titleExcess, subExcess);
    } else {
        overflow = titleH * (SCALE - 1);
    }

    const offset = Math.max(0, overflow - BASE_META_MARGIN + DESIRED_GAP);
    itemEl.style.setProperty('--metaOffset', offset.toFixed(1) + 'px');
}

const __listExpandedDelta = Object.create(null);
const __listCollapsedH = Object.create(null);

// Bumped whenever the anchor system is started or stopped. _holdListAnchor claims a token and ignores its own callbacks once it changes, so a user scroll cleanly ends the hold and its image-load re-pinning instead of fighting them.
let __listHoldToken = 0;
/** Stop list anchor scroll. */
// Detaches the user-input listeners of the anchor loop currently running (if any).
let __listAnchorDetach = null;
// True once the user has taken over the scroll during the anchor window. The deferred cut-off corrections must honour it: after scrolling away the focus IS cut off, and correcting would yank them back to the selected row.
let __listAnchorUserAborted = false;

function _stopListAnchorScroll() {
    _cancel('list.anchorFrame');
    __listHoldToken++;
    if (__listAnchorDetach) { __listAnchorDetach(); __listAnchorDetach = null; }
}

/** Abort the running anchor as soon as the user takes over the scroll. The loop writes scrollTop every frame, so
 *  `scroll` events can't distinguish us from the user: listen for the INPUT instead. */
function _armListAnchorUserAbort(endAfter) {
    const opts = { passive: true, capture: true };
    __listAnchorUserAborted = false;
    const abort = () => {
        __listAnchorUserAborted = true;
        _stopListQuickScroll();                    // kill any correction already gliding
        _stopListAnchorScroll();                   // also detaches, via __listAnchorDetach
    };
    const onKey = (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' ||
            e.key === 'PageDown' || e.key === 'Home' || e.key === 'End' || e.key === ' ') abort();
    };
    window.addEventListener('wheel', abort, opts);
    window.addEventListener('touchstart', abort, opts);
    window.addEventListener('keydown', onKey, opts);

    let expiry = 0;
    const detach = () => {
        clearTimeout(expiry);
        window.removeEventListener('wheel', abort, opts);
        window.removeEventListener('touchstart', abort, opts);
        window.removeEventListener('keydown', onKey, opts);
    };
    // Detach once the anchor window has passed, even if it ended on its own.
    expiry = setTimeout(() => {
        if (__listAnchorDetach === detach) __listAnchorDetach = null;
        detach();
    }, (typeof endAfter === 'number' ? endAfter : 650) + 80);

    __listAnchorDetach = detach;
}

// Fast (fixed-duration) scroll helper for list selection corrections.
let __listQuickScrollToken = 0;
/** Stop list quick scroll. */
function _stopListQuickScroll() {
    // 'Last call wins' for repeated selection navigation.
    __listQuickScrollToken++;
    _cancel('list.quickScrollFrame', 'list.quickScroll');
}
/** Helper: quick scroll list to. */
function _quickScrollListTo(targetTop, durMs = 180, easeFn = null, onDone = null) {
    if (!listView) return;
    _stopListQuickScroll();
    // Mobile: programmatic scrolls should snap, not animate. Skip the rAF tween entirely.
    if (isMobile) {
        listView.scrollTop = targetTop;
        if (typeof onDone === 'function') onDone();
        return;
    }
    const token = ++__listQuickScrollToken;
    const startTop = listView.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 0.5 || durMs <= 0) {
        listView.scrollTop = targetTop;
        return;
    }
    const start = performance.now();
    const linear = (t) => t;
    const ease = (typeof easeFn === 'function') ? easeFn : linear;
    const tick = (now) => {
        if (token !== __listQuickScrollToken) { return; }
        const t = Math.min(1, (now - start) / durMs);
        listView.scrollTop = startTop + delta * ease(t);
        if (t < 1) _onFrame('list.quickScrollFrame', tick);
        else if (typeof onDone === 'function' && token === __listQuickScrollToken) onDone();
    };
    // Start immediately at t=0 so the animation duration matches durMs precisely.
    tick(start);
}
/** Helper: scroll list to top. */
/* Set for the duration of a panel rebuild that is handing the reader back to where they were (the detail overlay closing). */
let _panelRestoreY = null;

function _scrollListToTop(durMs = 330) {
    if (!listView) return;
    if (_panelRestoreY !== null) return;
    // Cancel any in-flight list scroll/anchor corrections so "top" wins.
    _stopListAnchorScroll();
    _stopListQuickScroll();

    // In list-view mode the body is the scroll container, so listView.scrollTop is always 0 and the rAF tween below would be a no-op: animate window.scrollY instead. Other views still use the listView path.
    const bodyScrolls = document.body.classList.contains('list-view');

    if (bodyScrolls) {
        const cur = window.scrollY || document.documentElement.scrollTop || 0;
        if (cur <= 1) return;
        if (isMobile || durMs <= 0) {
            window.scrollTo(0, 0);
            return;
        }
        // rAF tween on window.scrollTo to match the listView path's feel: CSS scroll-behavior: smooth varies by browser and ignores the duration we want.
        const start = performance.now();
        const tick = (now) => {
            const t = Math.min(1, (now - start) / durMs);
            window.scrollTo(0, cur * (1 - t));
            // Written in rAF, after this frame's curves were drawn: redraw them against the new scroll.
            tagVis.drawLinksNow();
            if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return;
    }

    const cur = listView.scrollTop;
    if (cur <= 1) return;

    // Mobile Safari can ignore a scrollTop change when it happens in the same tick
    // as a large DOM rewrite (renderList). Schedule it for the next frame.
    requestAnimationFrame(() => {
        if (!listView) return;
        _quickScrollListTo(0, durMs);
    });

    // Failsafe: if smooth scrolling is blocked for any reason, snap after the window.
    setTimeout(() => {
        if (!listView) return;
        if (listView.scrollTop > 1) listView.scrollTop = 0;
    }, durMs + 140);
}
/** Anchor target that keeps a row vertically centred, as a function of the rect the caller has already measured this frame. */
function _listCenterTargetTop(r, cr) {
    return Math.max(0, (cr.height - r.height) / 2);
}

/** Get list desired top. */
function _getListDesiredTop() {
    const padTop = parseFloat(getComputedStyle(listView).paddingTop) || 0;
    const offset10vh = Math.round(window.innerHeight * 0.08); // slightly tighter than 10vh
    const desiredTop = Math.max(offset10vh, padTop + 8);
    return { padTop, desiredTop };
}
/** Helper: is list item cut off. */
function _isListItemCutOff(el) {
    if (!listView || !el) return false;
    const { desiredTop } = _getListDesiredTop();
    const r = el.getBoundingClientRect();
    const cr = listView.getBoundingClientRect();
    return (r.top < cr.top + desiredTop) || (r.bottom > cr.bottom - 12);
}

// List scrolling cares about the "focus" region at the top of an item (thumbnail, title, subtitle); expanded text and links may run past the viewport but shouldn't force an auto-scroll once the focus is visible.
function _getListFocusRect(itemEl) {
    if (!itemEl) return null;
    const parts = [];
    const thumb = itemEl.querySelector('.list-thumb'); // tighter than the wrapper
    const title = itemEl.querySelector('.list-title');
    const subtitle = itemEl.querySelector('.list-subtitle');
    if (thumb) parts.push(thumb.getBoundingClientRect());
    if (title) parts.push(title.getBoundingClientRect());
    if (subtitle) parts.push(subtitle.getBoundingClientRect());
    if (!parts.length) return itemEl.getBoundingClientRect();

    let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
    // Loop.
    for (const r of parts) {
        top = Math.min(top, r.top);
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
    }
    // Tighten the focus box a bit: ignore tiny top padding/margins so we don't
    // auto-scroll when the thumbnail/title are already effectively visible.
    const TOP_INSET = 6; // px
    if (isFinite(top) && isFinite(bottom) && (bottom - top) > TOP_INSET) top += TOP_INSET;
    return { top, left, right, bottom, width: right - left, height: bottom - top };
}

/** Get list focus offset. */
function _getListFocusOffset(itemEl) {
    if (!itemEl) return 0;
    const itemR = itemEl.getBoundingClientRect();
    const focusR = _getListFocusRect(itemEl) || itemR;
    return Math.max(0, focusR.top - itemR.top);
}

/** Helper: is list focus cut off. */
function _isListFocusCutOff(itemEl) {
    if (!listView || !itemEl) return false;
    const { desiredTop } = _getListDesiredTop();
    const cr = listView.getBoundingClientRect();
    const fr = _getListFocusRect(itemEl) || itemEl.getBoundingClientRect();
    return (fr.top < cr.top + desiredTop) || (fr.bottom > cr.bottom - 12);
}

/** Helper: scroll list el focus quick. */
function _scrollListElFocusQuick(itemEl, durMs = 160) {
    if (!listView || !itemEl) return;
    const { desiredTop } = _getListDesiredTop();
    const focusOffset = _getListFocusOffset(itemEl);
    const targetItemTop = Math.max(0, desiredTop - focusOffset);
    const top = Math.max(0, itemEl.offsetTop - targetItemTop);
    _quickScrollListTo(top, durMs);
}

// Arrow-key navigation in list mode should step through the items that are currently visible
// in the list viewport (no auto-scroll / no post-hoc correction).
function _stepListSelectionVisible(dir) {
    // Steps through the entire current list order, including search-filtered results. Keyboard navigation wants the same snappy behaviour as hash-driven selection: immediate state update, synchronous snap into the top band, and replaceState so history isn't spammed.
    if (!listView || viewMode !== 'list' || lightboxOpen) return;

    const ids = (listOrderIds && listOrderIds.length)
        ? listOrderIds.slice()
        : Array.from(listView.querySelectorAll('.list-item'))
            .map(el => el.getAttribute('data-id'))
            .filter(Boolean);

    if (!ids.length) return;

    let idx = listSelectedId ? ids.indexOf(listSelectedId) : -1;

    // If nothing selected: down selects first; up selects last.
    // If the current selection is no longer present (filtered), treat as none.
    if (idx === -1) idx = (dir > 0) ? -1 : ids.length;

    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= ids.length) return;

    const id = ids[nextIdx];
    if (!id) return;

    // Drop the pointer-hover state before switching: .row-hover is only updated by pointer events, so the last clicked row still carries it and would hold its authors/source at full opacity once it loses .selected.
    _setListRowHover(null);

    // Centred, as a shuffle lands. updateHash=true + push=false keeps the URL in sync without filling browser history.
    setListSelection(id, true, true, true, false, 'center');
}
// Keep an element's top position stable (or gently guided into the 10vh band) while
// list items expand/collapse, to avoid mobile hiccups from discrete scrollTo corrections.
function _startListAnchorScroll(el, targetTop, durMs) {
    _stopListAnchorScroll();
    if (!listView || !el) return;
    _armListAnchorUserAbort(typeof durMs === 'number' ? durMs : 650);

    // Mobile: discrete snaps at fixed delays instead of the rAF correction loop, which fights iOS Safari's own scroll updates (each frame reads as smooth-scroll animation) and adds compositor pressure across 310 rows.
    if (isMobile) {
        const snapDelays = [0, 80, 200, 400, 700, 1100];
        const limit = (typeof durMs === 'number' ? durMs : 650);
        const myToken = __listHoldToken; // bumped by _stopListAnchorScroll / user abort
        for (const d of snapDelays) {
            if (d > limit) break;
            setTimeout(() => {
                if (myToken !== __listHoldToken) return; // superseded, or user took over
                if (!el.isConnected || !listView) return;
                const cr = listView.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                const delta = (r.top - cr.top) - (typeof targetTop === 'function' ? targetTop(r, cr) : targetTop);
                if (Math.abs(delta) > 0.5) {
                    listView.scrollTop = Math.max(0, listView.scrollTop + delta);
                }
            }, d);
        }
        return;
    }

    const start = performance.now();
    // On mobile, collapsing a tall previous item can displace the new selection quickly.
    // Use a higher per-frame cap so the anchor correction can keep collapse+expand in sync.
    const maxStep = isMobile ? 72 : 96; // px per frame
    const endAfter = (typeof durMs === 'number' ? durMs : 650);

    const myToken = __listHoldToken;
    const tick = (now) => {
        if (myToken !== __listHoldToken) { return; } // superseded / user abort
        if (!el.isConnected) { return; }

        const cr = listView.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const curTop = r.top - cr.top;
        // targetTop may be a function of the live geometry (see _listCenterTargetTop), resolved against the rects this frame already has.
        const delta = curTop - (typeof targetTop === 'function' ? targetTop(r, cr) : targetTop);

        // Adaptive: lock tightly for small deltas, ease for larger ones.
        let step = delta;
        const ad = Math.abs(delta);
        if (ad > 24) step = delta * (isMobile ? 0.55 : 0.45);
        step = Math.max(-maxStep, Math.min(maxStep, step));

        if (ad > 0.5) listView.scrollTop += step;

        const age = now - start;
        // Stop strictly after the requested window. (Important: if the user scrolls away,
        // we must not keep fighting their scroll input.)
        if (age < endAfter) {
            _onFrame('list.anchorFrame', tick);
        }
    };

    _onFrame('list.anchorFrame', tick);
}

/** Pin an element's viewport-top to `targetTop` for `durMs`, correcting exactly each frame with no per-frame cap.
 *  `targetTop` may be a function of (rect, containerRect) for a target that moves with the row. */
function _holdListAnchor(el, targetTop, durMs, discrete) {
    _stopListAnchorScroll();          // cancels any prior loop and bumps the token
    if (!listView || !el) return;
    const token = ++__listHoldToken;  // claim this hold
    const limit = (typeof durMs === 'number' ? durMs : 900);

    const stillValid = () => {
        if (token !== __listHoldToken) return false; // superseded / user scrolled
        if (!el.isConnected || el.classList.contains('list-out')) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) return false;
        return true;
    };
    const repin = () => {
        if (!stillValid()) return;
        const cr = listView.getBoundingClientRect();
        const delta = (el.getBoundingClientRect().top - cr.top) - targetTop;
        if (Math.abs(delta) > 0.5) listView.scrollTop = Math.max(0, listView.scrollTop + delta);
    };

    // A late thumbnail decode above the anchor can shift layout after the fold ends, so re-pin on image loads within the hold window (in the capture phase, since load doesn't bubble). Coalesced to one re-pin per frame so a burst of decodes can't thrash layout.
    let _loadRepinQueued = false;
    const onLoad = () => {
        if (_loadRepinQueued || !stillValid()) return;
        _loadRepinQueued = true;
        requestAnimationFrame(() => { _loadRepinQueued = false; repin(); });
    };
    listView.addEventListener('load', onLoad, true);
    setTimeout(() => listView.removeEventListener('load', onLoad, true), limit + 140);

    // Discrete mode (mobile, and Safari's anchored selection transitions): timeout-driven snaps instead of per-frame
    // rAF, which fights iOS momentum and interleaves badly with the concurrent max-height transitions.
    if (isMobile || discrete) {
        const snapDelays = [0, 50, 110, 200, 320, 470, 640, 840, 1060, 1300];
        for (const d of snapDelays) {
            if (d > limit) break;
            setTimeout(repin, d);
        }
        return;
    }

    const start = performance.now();
    const tick = (now) => {
        if (!stillValid()) return; // another op owns list.anchorFrame now; don't touch it
        repin();
        // No else: the slot clears itself when the frame fires, so the loop
        // simply stops re-arming once the limit is reached.
        if (now - start < limit) _onFrame('list.anchorFrame', tick);
    };
    _onFrame('list.anchorFrame', tick);
}
// Thumbnail sizing can change heights above the selected item after we scrolled to it, pushing the selection out of view; this keeps the row pinned just below the top padding band until layout settles.
/* Desktop only: the phone shows a selection as the full-screen detail and the router returns before reaching
   this (see the isMobile branch above its one call site). */
function _pinInitialListSelection(id, durMs) {
    if (!listView || !id) return;
    const el = _getListItemEl(id);
    if (!el) return;

    /* A deep link and a hash change are the same arrival, so they land the same way: see the 'center' mode in setListSelection. */
    const target = _listCenterTargetTop;

    // One synchronous correction using live geometry.
    const cr = listView.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const curTop = r.top - cr.top;
    listView.scrollTop = Math.max(0, listView.scrollTop + (curTop - target(r, cr)));

    // Then keep it pinned while lazy sizing / image loads settle.
    _startListAnchorScroll(el, target, durMs);

    // Stop the pin on the first user interaction, so the anchor loop can't hold the selection in a scroll lock.
    const __pinOpts = { passive: true, capture: true };
    const __cancelPin = () => {
        _stopListAnchorScroll();
        if (!listView) return;
        listView.removeEventListener('wheel', __cancelPin, __pinOpts);
        listView.removeEventListener('touchstart', __cancelPin, __pinOpts);
        listView.removeEventListener('touchmove', __cancelPin, __pinOpts);
        listView.removeEventListener('pointerdown', __cancelPin, __pinOpts);
        window.removeEventListener('keydown', __cancelPin, true);
    };
    listView.addEventListener('wheel', __cancelPin, __pinOpts);
    listView.addEventListener('touchstart', __cancelPin, __pinOpts);
    listView.addEventListener('touchmove', __cancelPin, __pinOpts);
    listView.addEventListener('pointerdown', __cancelPin, __pinOpts);
    window.addEventListener('keydown', __cancelPin, true);
    setTimeout(__cancelPin, durMs + 30);

    // Final snap if it's still cut off.
    setTimeout(() => {
        if (listSelectedId !== id) return;
        if (_isListItemCutOff(el)) _scrollListEl(el, 'top10');
    }, durMs + 140);
}

/** Parse a CSS time token (e.g., "450ms", "0.22s") into milliseconds. */
function _parseCssMs(tok) {
    const t = (tok || '').trim();
    if (!t) return 0;
    if (t.endsWith('ms')) return parseFloat(t) || 0;
    if (t.endsWith('s')) return (parseFloat(t) || 0) * 1000;
    const v = parseFloat(t);
    return isFinite(v) ? v : 0;
}

/** Get total (delay + duration) for the max-height transition of a list-extra block. */
function _maxHeightTransitionMs(extraEl) {
    if (!extraEl) return 0;
    const cs = getComputedStyle(extraEl);
    const props = (cs.transitionProperty || '').split(',').map(s => s.trim());
    const durs = (cs.transitionDuration || '').split(',').map(_parseCssMs);
    const dels = (cs.transitionDelay || '').split(',').map(_parseCssMs);

    let best = 0;
    const n = Math.max(props.length, durs.length, dels.length, 1);
    for (let i = 0; i < n; i++) {
        const p = props[i] || props[0] || 'all';
        const d = durs[i] != null ? durs[i] : (durs[0] || 0);
        const dl = dels[i] != null ? dels[i] : (dels[0] || 0);
        if (p === 'all' || p === 'max-height') {
            best = Math.max(best, d + dl);
        }
    }
    return best;
}

/* ══ LIST VIEW ═════════════════════════════════════════════════════════════ */

/** Background click in list view: cancel the expanded row, then the tag filter, then the full-text query: one step per click, most specific first. Both the Escape and click handlers want this exact ladder, so it lives here. */
function _listBackgroundClear() {
    if (listSelectedId) {
        setListSelection(listSelectedId, false, true, true, true);
        return true;
    }
    if (activeTag) {
        _clearTagFilterKeepView(true);
        _animateListFilter();
        _updateListHash(true, true);
        _updateDocTitle();
        return true;
    }
    if (searchInput && searchInput.value && searchInput.value.trim()) {
        searchInput.value = '';
        document.body.classList.remove('search-has-query');
        searchQuery = '';
        searchScores = {};
        searchBox.classList.remove('open');
        renderList();
        _updateListHash(true, true);
        _updateDocTitle();
        return true;
    }
    return false;
}

/** Refold the list around the current filter, dropping any expanded row as part of the same fold. */
function _animateListFilterDeselecting() {
    const prevSel = listSelectedId;
    listSelectedId = null;
    // Same reason as _gridSetSelected: this is the list's combined close (selection plus the filter it sat in) and setListSelection's own toggle-off branch, which updates the ×, is not on this path.
    _updateCancelButton();
    _animateListFilter(prevSel
        ? { anchorId: prevSel, deselectId: prevSel, holdMs: UI_TRANS_MS + 320 }
        : undefined);
}

/** Collapse an expanded list row back to its resting state. */
function _collapseListRow(el, instant, dur) {
    if (!instant) el.classList.add('animating');
    _closeListExtra(el, instant);
    el.classList.remove('selected');
    el.style.removeProperty('--metaOffset');
    el.style.removeProperty('--subOffset');
    _applyListThumbSize(el);
    // Drop the cached collapsed height so the next measurement is fresh.
    const id = el.getAttribute('data-id');
    if (id) delete __listCollapsedH[id];
    const img = el.querySelector('img.list-thumb');
    if (img) setImgTier(img, 's');
    // dur + 300 because the meta's flow-height ease runs until 1.2x dur; dropping `.animating` earlier swaps the meta to its absolute overlay mid-ease and reintroduces the height jump.
    if (!instant) {
        setTimeout(() => el.classList.remove('animating'), dur + 300);
    } else {
        el.classList.remove('animating');
    }
}

function setListSelection(id, shouldScroll = false, animate = true, updateHash = true, push = false, scrollMode = 'auto') {
    // A phone never expands a row in place: whatever asked for the selection gets the shared detail instead.
    if (isMobile && id && id !== listSelectedId) { _openMobileItemDetail(id, 'list'); return; }
    if (!listView) return;

    // A selection sits inside any tag or search filter rather than clearing it: the list keeps its filtered rows and the address carries both. Escape and the reset button clear the two together.

    // Mobile forces instant transitions for programmatic selection (shuffle, hash change, history, search jump); direct user scrolling is unaffected.
    if (isMobile) animate = false;

    const dur = UI_TRANS_MS; // keep in sync with --listTrans
    const scrollAnim = !!animate;
    const instant = !animate;

    // 'center' (arrow keys, shuffle, hash jumps) snaps a long distance at once, then an anchor loop holds the row in the
    // middle of the window while the rows around it expand and collapse.
    const wantsCenter = (scrollMode === 'center');
    if (instant) {
        document.body.classList.add('list-instant');
        // Clear it after the immediate DOM/layout changes have landed.
        requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('list-instant')));
    }

    const prevEl = listView.querySelector('.list-item.selected');
    const nextEl = id ? _getListItemEl(id) : null;

    // Stop any ongoing list scroll corrections when changing selection.
    _stopListQuickScroll();

    // Stop any ongoing anchor corrections when changing selection.
    _stopListAnchorScroll();

    // Switching directly from one row to another, rather than opening or closing one.
    const isSwitch = !!(prevEl && nextEl && prevEl !== nextEl);

    // Deterministic scroll compensation: collapsing a previously expanded item ABOVE the new selection reduces the height above it and would pull it upward, so scroll up by exactly the previous expand delta to keep the clicked row stable.
    let __collapseCompDelta = 0;
    if (isSwitch && prevEl && nextEl && (prevEl.offsetTop < nextEl.offsetTop)) {
        const prevId = prevEl.getAttribute('data-id');
        const prevCollapsedH = (prevId && (typeof __listCollapsedH[prevId] === 'number')) ? __listCollapsedH[prevId] : null;
        if (prevCollapsedH != null) {
            const curH = prevEl.getBoundingClientRect().height;
            __collapseCompDelta = Math.max(0, curH - prevCollapsedH);
        } else {
            __collapseCompDelta = (prevId && __listExpandedDelta[prevId]) ? __listExpandedDelta[prevId] : 0;
        }
        if (__collapseCompDelta > 0 && instant) {
            listView.scrollTop = Math.max(0, listView.scrollTop - __collapseCompDelta);
        }
// Animated switches get no open-loop scroll correction: its guess at the collapse's displacement curve drifts
        // against the row's own easing, and the new row ends up pushed back down.
    }

    // Collapse previous (if different)
    if (prevEl && (!nextEl || prevEl !== nextEl)) {
        _collapseListRow(prevEl, instant, dur);
    }

    // Toggle off
    if (!id || (listSelectedId === id)) {
        // When toggling the current selection off, we must also collapse the currently selected element.
        if (prevEl) _collapseListRow(prevEl, instant, dur);
        listSelectedId = null;
        _updateListHash(updateHash, push);
        _updateDocTitle();
        if (instant) {
            _scheduleTagCloudUpdate(true);
        } else {
            const __extra = prevEl ? prevEl.querySelector('.list-extra') : null;
            tagVis.updateAfterListMotion(__extra);
        }
        _updateCancelButton();
        return;
    }

    listSelectedId = id;

    const el = nextEl;
    if (el) {
        // Auto-scroll only when the focus region is outside the viewport, or when collapsing a previously selected item above would likely push it out.
        let targetTop = null;
        // It now runs for every animated, non-keyboard selection.
        if (!wantsCenter && shouldScroll && !instant) {
            const { desiredTop } = _getListDesiredTop();
            const cr = listView.getBoundingClientRect();

            const focusR0 = _getListFocusRect(el) || el.getBoundingClientRect();
            const focusFullyVisible = (focusR0.top >= cr.top + desiredTop) && (focusR0.bottom <= cr.bottom - 12);

            // Guide only when the row is genuinely not fully visible.
            const needsGuide = !focusFullyVisible;

            if (needsGuide) {
                const focusOffset = _getListFocusOffset(el);
                targetTop = Math.max(0, desiredTop - focusOffset);
            } else {
                targetTop = null; // no animated scroll correction needed
            }
        }

        const __collapsedH = el.getBoundingClientRect().height;
        __listCollapsedH[id] = __collapsedH;

        if (!instant) el.classList.add('animating');
        el.classList.add('selected');

        // Prevent title/subtitle scaling from colliding with authors/source on multi-line items.
        // Measure after styles apply; then nudge meta down as needed.
        if (!instant) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (listSelectedId === id) _updateListMetaOffset(el);
            }));
            // Level 1 also eases the row's font-size back up on selection, so the pass above measures a title that is still growing. One re-measure at settle corrects it.
            _settleListRowMetrics(el);
        } else {
            _updateListMetaOffset(el);
        }

        // The selected row gets the large tier, deferred until the open animation settles: swapping src at animation
        // start made Safari fetch and decode the larger bitmap while animating the thumb's dimensions, which was visibly
        // choppy.
        const _selImg = isMobile ? null : el.querySelector('img.list-thumb');
        if (_selImg) {
            if (instant) {
                ensureImgTier(_selImg, 'l');
            } else {
                setTimeout(() => {
                    if (listSelectedId === id) ensureImgTier(_selImg, 'l');
                }, dur + 80);
            }
        }

        _applyListThumbSize(el);
        _openListExtra(el, instant);

        // Store expand delta so we can estimate displacement when this item collapses later.
        if (instant) {
            const __expandedH = el.getBoundingClientRect().height;
            __listExpandedDelta[id] = Math.max(0, __expandedH - __collapsedH);
        } else {
            setTimeout(() => {
                if (!el.classList.contains('selected')) return;
                const __expandedH = el.getBoundingClientRect().height;
                __listExpandedDelta[id] = Math.max(0, __expandedH - __collapsedH);
            }, dur + 20);
        }

        _updateListHash(updateHash, push);
        _updateDocTitle();

        if (shouldScroll) {
            if (wantsCenter && scrollAnim) {
                const startKeyboardScroll = () => {
                    requestAnimationFrame(() => {
                        if (listSelectedId !== id) return;

                        const targetItemTop = _listCenterTargetTop;

                        // Long jumps (hash or history navigation across the list): the anchor loop is capped at ~96px per frame, so a
                        // distant target was never reached and the item settled wherever the crawl ended.
                        const crJ = listView.getBoundingClientRect();
                        const rJ = el.getBoundingClientRect();
                        const deltaJ = (rJ.top - crJ.top) - (typeof targetItemTop === 'function' ? targetItemTop(rJ, crJ) : targetItemTop);
                        if (Math.abs(deltaJ) > window.innerHeight * 1.5) {
                            listView.scrollTop = Math.max(0, listView.scrollTop + deltaJ);
                        }

                        // Anchor scroll tracks the element's live position each frame,
                        // naturally absorbing margin/padding transition drift.
                        _startListAnchorScroll(el, targetItemTop, dur + 520);

                        // Final correction, but never against the user: if they
                        // scrolled on their own in the meantime, leave it be.
                        let __userMoved = false;
                        const __moveOpts = { passive: true, capture: true };
                        const __onUserMove = () => { __userMoved = true; };
                        window.addEventListener('wheel', __onUserMove, __moveOpts);
                        window.addEventListener('touchstart', __onUserMove, __moveOpts);
                        setTimeout(() => {
                            window.removeEventListener('wheel', __onUserMove, __moveOpts);
                            window.removeEventListener('touchstart', __onUserMove, __moveOpts);
                            if (__userMoved || __listAnchorUserAborted || listSelectedId !== id) return;
                            _startListAnchorScroll(el, _listCenterTargetTop, 220);
                        }, dur + 540);
                    });
                };

                const kDelay = (__collapseCompDelta > 0 && prevEl && (prevEl.offsetTop < el.offsetTop)) ? 150 : 0;
                if (kDelay > 0) {
                    _after('list.quickScroll', startKeyboardScroll, kDelay);
                } else {
                    startKeyboardScroll();
                }
            } else if (scrollAnim) {
                // Capture the row's position BEFORE the collapse/expand starts moving things, so the fallback anchor holds it exactly where the user clicked.
                const _crNow = listView.getBoundingClientRect();
                const _holdTop = el.getBoundingClientRect().top - _crNow.top;
                requestAnimationFrame(() => {
                    if (listSelectedId !== id) return;

                    // Anchor-based correction through the transition window: targetTop when the row must be guided into the reading band, otherwise its own starting offset; "stay put" is what keeps a switch from above from dragging it up.
                    _startListAnchorScroll(el, targetTop !== null ? targetTop : _holdTop, dur + 380);

                    // Final small correction only if the focus is still cut off, and only if the user hasn't taken the scroll over, without that check, scrolling away mid-unfold dragged them back to the selected row.
                    setTimeout(() => {
                        if (__listAnchorUserAborted) return;
                        if (listSelectedId !== id) return;
                        if (_isListFocusCutOff(el)) {
                            // Avoid native smooth-scroll durations (can be very long on mobile).
                            _scrollListElFocusQuick(el, 160);
                        }
                    }, dur + 420);
                });
            } else {
                // Instant snap (no rAF) so mode-switch image transitions measure the final target rect.
                _scrollListEl(el, 'top10');
            }
        }

        // +140, not +60, so the image handoff in _deselectListItemFromClick finishes inside the animating window; otherwise hover rules re-govern mid-handoff (meta wobble) and the animating-keyed padding gap-close releases a beat early (next-row hop).
        if (!instant) setTimeout(() => el.classList.remove('animating'), dur + 140);
        else el.classList.remove('animating');
    } else {
        _updateListHash(updateHash, push);
        _updateDocTitle();
    }

    if (instant) {
        _scheduleTagCloudUpdate(true);
    } else {
        // If we switched selection, the *collapse* (delayed) is the last thing that settles.
        // Otherwise, wait for the newly selected item's expansion.
        let __watch = null;
        if (prevEl && nextEl && prevEl !== nextEl) __watch = prevEl.querySelector('.list-extra');
        else if (nextEl) __watch = nextEl.querySelector('.list-extra');
        tagVis.updateAfterListMotion(__watch);
    }
    _updateCancelButton();
}

/** Helper: source line. */
function _sourceLine(item) {
    const year = item.date ? item.date.slice(0, 4) : '';
    if (item.source && year) return `${item.source}, ${year}`;
    if (item.source) return item.source;
    if (year) return year;
    return '';
}

/* ══ LIST VIEW (CONTINUED) ═════════════════════════════════════════════════ */

/** Markup for a single list item, shared by the full and search builds. The detail content .list-extra holds
 *  (abstract, tags, links, see-also) is only shown by the SELECTED row, so building it into all ~390 rows put
 *  more than half the list DOM on the page to serve one row. */
function _listExtraHtml(it, __byId) {
    const tags = (!_tagSidebarEnabled() && it.tags && it.tags.length)
        ? `<div class="list-tags">${it.tags.map(t => `<a class="list-tag" data-tag="${_esc(t)}" href="${_esc(_formatAddress({ view: 'list', t }))}">${_esc(t)}</a>`).join('')}</div>`
        : '';

    const seeAlso = (it.links && it.links.length)
        ? (() => {
            const uniq = [...new Set(it.links)]
                .map(x => (x || '').toString().trim())
                .filter(id => id && id !== it.id && __byId[id]);
            if (!uniq.length) return '';
            const links = uniq.map(id => {
                const t = (__byId[id] && __byId[id].shorttitle) ? __byId[id].shorttitle : id;
                return `<a class="list-seealso-link" href="${_esc(_formatAddress({ view: 'list', i: id }))}" data-id="${_esc(id)}">${_esc(t)}</a>`;
            }).join('');
            return `<div class="list-seealso">${links}</div>`;
        })()
        : '';

    const text = (it.textLines && it.textLines.length)
        ? (() => {
            return `<div class="list-text">${_paragraphsHtml(it.textLines)}</div>`;
        })()
        : '';

    return text + tags + seeAlso;
}

/* Recency window over built row content, same reasoning as _DETAIL_KEEP: eviction happens only when a NEW row is filled, so anything released is several selections old and cannot still be mid-fold. */
const _LIST_EXTRA_KEEP = 5;
const _listExtraBuiltIds = [];

/** Fill a row's .list-extra if it is still empty. Idempotent, and called from
 *  every path that is about to measure the block's height. */
function _ensureListExtra(itemEl) {
    const extra = itemEl ? itemEl.querySelector('.list-extra') : null;
    if (!extra || extra.firstChild) return extra;
    const id = itemEl.getAttribute('data-id');
    const it = id ? _getTagItemById()[id] : null;
    if (!it) return extra;
    extra.innerHTML = _listExtraHtml(it, _getTagItemById());

    const at = _listExtraBuiltIds.indexOf(id);
    if (at >= 0) _listExtraBuiltIds.splice(at, 1);
    _listExtraBuiltIds.push(id);
    while (_listExtraBuiltIds.length > _LIST_EXTRA_KEEP && _listExtraBuiltIds[0] !== listSelectedId) {
        _releaseListExtra(_listExtraBuiltIds.shift());
    }
    return extra;
}

/** Empty a row's .list-extra back to its shell. */
function _releaseListExtra(id) {
    const el = id ? _getListItemEl(id) : null;
    if (!el) return;
    const extra = el.querySelector('.list-extra');
    if (extra) extra.innerHTML = '';
}

function _listItemHtml(it) {
    const title = _esc(it.shorttitle);
    // Inert until the row is selected: see .title-link.
    const titleHtml = it.url
        ? `<a class="title-link" href="${_esc(it.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
        : title;
    // The subtitle carries the same link as the title: see .title-link, which keeps both inert until the row is open.
    const subtitleInner = it.subtitle
        ? (it.url
            ? `<a class="title-link" href="${_esc(it.url)}" target="_blank" rel="noopener noreferrer">${_esc(it.subtitle)}</a>`
            : _esc(it.subtitle))
        : '';
    const subtitle = it.subtitle ? `<div class="list-subtitle">${subtitleInner}</div>` : '';
    const noSubClass = it.subtitle ? '' : ' list-no-subtitle';
    const authors = it.authors ? `<div class="list-authors" title="">${_esc(it.authors)}</div>` : '';
    const source = _sourceLine(it);
    const sourceLine = source ? `<div class="list-source" title="">${_esc(source)}</div>` : '';

    const _m = imageMeta[it.id];
    const sw = (_m && _m.sw) ? _m.sw : 4;
    const sh = (_m && _m.sh) ? _m.sh : 3;
    // Stub colour under the thumbnail, as for the articles; placeholders keep the .placeholder-img grey.
    const thumbBg = it._isPlaceholderImg ? '' : `;background-color:${_stubFillForId(it.id)}`;

    return `
        <div class="list-item${it._isPlaceholderImg ? ' placeholder-img' : ''}${noSubClass}" data-id="${_esc(it.id)}">
            <div class="list-thumb-wrap">
                <div class="list-thumb-frame">
                <img class="list-thumb" loading="lazy" decoding="async" data-id="${_esc(it.id)}" data-tier="s" data-nw="${(imageMeta[it.id] && imageMeta[it.id].nw) ? imageMeta[it.id].nw : '0'}" data-nh="${(imageMeta[it.id] && imageMeta[it.id].nh) ? imageMeta[it.id].nh : '0'}" src="${_smallSrcFor(it.id)}" width="${sw}" height="${sh}" style="aspect-ratio:${sw} / ${sh}${thumbBg}" alt="${title}">
                </div>
            </div>
            <div class="list-main">
                <div class="list-title">${titleHtml}</div>
                ${subtitle}
                <div class="list-meta">
                    ${authors}
                    ${sourceLine}
                </div>
                <div class="list-extra"></div>
            </div>
        </div>
    `;
}

/** The heading an item belongs under. Items without a parseable year sort to the end and group under one 'n.d.' heading, which is emitted only if such items exist. */
function _listYearLabel(it) {
    const y = _monadYearNum(it);
    return Number.isFinite(y) ? String(y) : 'n.d.';
}

/** Rows interleaved with their year subheadings. Every year present in the collection gets a heading; whether it SHOWS is a filter question, answered by _updateListYearHeads. */
function _listBodyHtml(ordered) {
    let html = '';
    let prevYear = null;
    for (let i = 0; i < ordered.length; i++) {
        const y = _listYearLabel(ordered[i]);
        if (y !== prevYear) {
            html += `<div class="list-year" data-year="${_esc(y)}" role="heading" aria-level="2"><a class="list-year-link" href="${_esc(_formatAddress({ view: 'list', y }))}">${_esc(y)}</a></div>`;
            prevYear = y;
        }
        html += _listItemHtml(ordered[i]);
    }
    return html;
}

/** Show a year heading only while its group still holds a visible row. One DOM walk: each heading owns the rows up to the next heading.
 *  `reset` clears any fold state left on a heading, for the paths that land the list instantly. */
function _updateListYearHeads(reset) {
    if (!listView) return;
    const nodes = listView.children;
    const settle = (h, vis) => {
        if (reset) {
            h.classList.remove('list-folding');
            h.__foldDir = null;
            _clearFoldInline(h);
        }
        h.classList.toggle('list-out', !vis);
    };
    let head = null, any = false;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.classList.contains('list-year')) {
            if (head) settle(head, any);
            head = n;
            any = false;
        } else if (n.classList.contains('list-item') && !n.classList.contains('list-out')) {
            any = true;
        }
    }
    if (head) settle(head, any);
}

/** Scroll the list so a year's heading sits where the list starts, below the top controls. A year the filter leaves
 *  empty falls to the nearest year that still shows. With `settle`, the position is re-applied twice while rows
 *  above size their thumbnails, unless the reader scrolls first. */
function _scrollListToYear(year, animate, settle) {
    if (!listView) return;
    const heads = listView.querySelectorAll('.list-year:not(.list-out)');
    if (!heads.length) return;
    const want = parseInt(year, 10);
    let head = null, best = Infinity;
    for (const h of heads) {
        const y = h.getAttribute('data-year');
        if (y === year) { head = h; break; }
        const d = Math.abs(parseInt(y, 10) - want);
        if (d < best) { best = d; head = h; }
    }
    if (!head) head = heads[heads.length - 1];
    _stopListAnchorScroll();
    _stopListQuickScroll();
    const place = (behavior) => {
        const label = head.firstElementChild || head;
        const top = label.getBoundingClientRect().top + window.scrollY - (parseFloat(getComputedStyle(listView).paddingTop) || 0);
        window.scrollTo({ top: Math.max(0, top), behavior });
    };
    place(animate ? SCROLL_BEHAVIOR : 'instant');
    if (!settle) return;
    let moved = false;
    const opts = { passive: true, capture: true };
    const onMove = () => { moved = true; };
    window.addEventListener('wheel', onMove, opts);
    window.addEventListener('touchstart', onMove, opts);
    const again = () => { if (!moved && viewMode === 'list') place('instant'); };
    _after('list.yearSettle1', again, 450);
    _after('list.yearSettle2', () => {
        again();
        window.removeEventListener('wheel', onMove, opts);
        window.removeEventListener('touchstart', onMove, opts);
    }, 1200);
}

/** Which headings the AFTER state of a pending filter change leaves visible, keyed by element: the same walk as above, but asking _listItemPassesFilters instead of reading `.list-out`. */
function _listYearHeadPlan(byId) {
    const plan = new Map();
    if (!listView) return plan;
    const nodes = listView.children;
    let head = null, any = false;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.classList.contains('list-year')) {
            if (head) plan.set(head, any);
            head = n;
            any = false;
        } else if (n.classList.contains('list-item')) {
            const it = byId[n.getAttribute('data-id')];
            if (it && _listItemPassesFilters(it)) any = true;
        }
    }
    if (head) plan.set(head, any);
    return plan;
}

/** True when any row under this heading is folding in, so the heading can fold on the same clock instead of snapping. */
function _listYearHeadFolds(head, foldSet) {
    let n = head.nextElementSibling;
    while (n && !n.classList.contains('list-year')) {
        if (foldSet.has(n)) return true;
        n = n.nextElementSibling;
    }
    return false;
}

// What the live list DOM currently holds: 'full' (every item in chronological order, tag filter via .list-out), 'search' (score-ordered subset), or null (not built).
let _listDomMode = null;

/** The chronological order used for the permanent (full) list DOM. */
function _listChronoItems() {
    return items.slice().sort((a, b) => _compareItemsByYearAndSource(a, b));
}

/** True when item passes the current tag filter (search membership handled separately). */
function _listItemPassesTag(it) {
    const _t = (activeTag || '').trim();
    if (!_t) return true;
    return !!(it.tags && it.tags.includes(_t));
}

/** True when an item passes every active list filter (tag AND full-text search). The two are mutually exclusive
 *  in practice, but this stays correct if both are set. */
function _listItemPassesFilters(it) {
    if (!it) return false;
    if (!_listItemPassesTag(it)) return false;
    const q = (searchQuery || '').trim();
    if (q.length >= 2) {
        if ((searchScores && searchScores[it.id] ? searchScores[it.id] : 0) <= 0) return false;
    }
    return true;
}

/** Build or update the list view DOM. Search (q >= 2) keeps its own score-ordered subset render; everything else
 *  uses a PERMANENT chronological DOM where all items are always present and a tag filter only toggles
 *  `.list-out`. */
function renderList() {
    if (!listView) return;
    _cancelGroup('list.fold');
    // Tag and search are both predicate filters over one permanent chronological
    // DOM (see _renderListFull). Search no longer rebuilds a score-ordered list.
    _renderListFull();
}

/** Permanent chronological render: build the full item DOM once (rebuilding only when leaving search mode or after a teardown), then apply the current tag filter instantly by toggling `.list-out`. */
function _renderListFull() {
    const ordered = _listChronoItems();
    const needsBuild = (_listDomMode !== 'full') || !listView.querySelector('.list-item');

    if (needsBuild) {
        // The curves canvas (tag.js) lives inside the list, so that the rows paint over it, and the rebuild below
        // removes it. Held on to first and re-inserted rather than recreated: the same element keeps its context and
        // its sized backing store.
        const linksCanvas = document.getElementById('list-links');
        listView.innerHTML = _listBodyHtml(ordered);
        if (linksCanvas) listView.insertBefore(linksCanvas, listView.firstChild);
        _listDomMode = 'full';
        _listItemElsCache = null;
    }

    // Apply filter visibility instantly (clear any leftover fold inline styles too).
    const visible = [];
    const nodes = listView.querySelectorAll('.list-item');
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const id = node.getAttribute('data-id');
        const it = id ? _getTagItemById()[id] : null;
        _clearFoldInline(node);
        node.classList.remove('list-folding');
        if (it && _listItemPassesFilters(it)) {
            node.classList.remove('list-out');
            visible.push(id);
        } else {
            node.classList.add('list-out');
        }
    }
    listOrderIds = visible;

    _updateListYearHeads(true);

    // Drop any stale expanded row left over from a direct listSelectedId reset
    // (permanent DOM is not rebuilt on tag changes, so it wouldn't clear itself).
    if (!needsBuild) _collapseStaleListSelections();

    if (listSelectedId) {
        const el = _getListItemEl(listSelectedId);
        if (el && !el.classList.contains('list-out')) {
            el.classList.add('selected');
            _syncListExtra(el);
            _updateListMetaOffset(el);
        } else {
            listSelectedId = null;
        }
    }

    // A filter change that shows rows at once (an address, Escape, a cleared tag) has no fold to size them in, and an
    // unsized thumb falls back to the stylesheet's default box.
    _bindListThumbSizing(!needsBuild);
    if (needsBuild) tagVis.bindLinkRows();
    tagVis.linksSettle();
    _updateDocTitle();
    _scheduleTagCloudUpdate(true);
}

/** Remove any inline styles left over from a fold/unfold animation. */
function _clearFoldInline(node) {
    if (!node) return;
    const s = node.style;
    s.removeProperty('max-height');
    s.removeProperty('opacity');
    s.removeProperty('margin-top');
    s.removeProperty('margin-bottom');
    s.removeProperty('padding-top');
    s.removeProperty('padding-bottom');
    s.removeProperty('transition');
}

/** Collapse any row still showing as selected that is no longer the current listSelectedId. With the permanent
 *  DOM, paths that null listSelectedId directly would otherwise leave a stale expanded row. */
function _collapseStaleListSelections(exceptEl) {
    if (!listView) return;
    const sel = listView.querySelectorAll('.list-item.selected');
    for (let i = 0; i < sel.length; i++) {
        const el = sel[i];
        if (el === exceptEl) continue;
        if (el.getAttribute('data-id') === listSelectedId) continue;
        el.classList.remove('selected');
        el.style.removeProperty('--metaOffset');
        el.style.removeProperty('--subOffset');
        _closeListExtra(el, true);
        _applyListThumbSize(el);
        const pid = el.getAttribute('data-id');
        if (pid) delete __listCollapsedH[pid];
    }
}

/* ══ LIST VIEW (CONTINUED) ═════════════════════════════════════════════════ */

/** Force-complete any fold or unfold in flight, landing each pending node on its destined end state. Called before starting a new filter animation so overlapping tag clicks don't leave half-folded rows; safe to call anytime. */
function _finalizeListFold() {
    _cancelGroup('list.fold');
    if (!listView) return;
    const pend = listView.querySelectorAll('.list-folding');
    for (let i = 0; i < pend.length; i++) {
        const el = pend[i];
        if (el.__foldDir === 'out') el.classList.add('list-out');
        el.classList.remove('list-folding');
        el.__foldDir = null;
        _clearFoldInline(el);
    }
}

/** Animate a filter change (tag and/or full-text search) in the permanent chronological DOM by folding rows in
 *  and out while holding a chosen row's vertical position fixed, so the scroll position never jumps. */
function _animateListFilter(opts) {
    opts = opts || {};
    if (!listView || viewMode !== 'list') { renderList(); return; }

    // The list DOM is always chronological + permanent now. If it isn't built
    // yet, just build it.
    if (_listDomMode !== 'full' || !listView.querySelector('.list-item')) {
        renderList();
        if (!opts.anchorId) _scrollListToTop(330);
        return;
    }

    const FOLD_MS = 460; // keep in sync with --listFoldTrans
    const reduce = _prefersReducedMotion();
    const byId = _getTagItemById();
    const nodes = Array.from(listView.querySelectorAll('.list-item'));
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;

    const dEl = opts.deselectId ? _getListItemEl(opts.deselectId) : null;
    const dWillVis = dEl ? _listItemPassesFilters(byId[opts.deselectId]) : false;
    const holdMs = (typeof opts.holdMs === 'number') ? opts.holdMs : (FOLD_MS + 160);

    // Classify every row by before/after visibility.
    const leavers = [], enterers = [], stayers = [], afterVisible = [];
    const domIndex = new Map();
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        domIndex.set(node, i);
        const id = node.getAttribute('data-id');
        const it = id ? byId[id] : null;
        const wasVis = !node.classList.contains('list-out');
        const willVis = it ? _listItemPassesFilters(it) : wasVis;
        if (willVis) afterVisible.push(node);
        if (wasVis && willVis) stayers.push(node);
        else if (wasVis && !willVis) leavers.push(node);
        else if (!wasVis && willVis) enterers.push(node);
    }

    // Nothing to animate and nothing to deselect: normalize and bail.
    if (!leavers.length && !enterers.length && !dEl) { renderList(); return; }

    _finalizeListFold();
    _collapseStaleListSelections(dEl); // keep the deselect target; handled below

    // Anchoring on a visible row only makes sense once the list is scrolled down; at the top a filter should keep results at the top rather than pinning whatever happened to be in view. Selection transitions always pin.
    const pinTop = !opts.anchorId && listView.scrollTop < 50;

    // Anchor: explicit (selection cases), else topmost on-screen survivor, else
    // the deselect target even if it's off screen.
    let anchor = (opts.anchorId) ? _getListItemEl(opts.anchorId) : null;
    if (anchor && anchor.classList.contains('list-out')) anchor = null;
    let anchorTargetTop = null; // explicit viewport-top target (for an entering-row anchor)
    if (!anchor) {
        let bestTop = Infinity;
        for (let i = 0; i < stayers.length; i++) {
            const r = stayers[i].getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= vh) continue;
            if (r.top < bestTop) { bestTop = r.top; anchor = stayers[i]; }
        }
    }
    if (!anchor && dEl) anchor = dEl;

    // Big composition change with no surviving row on screen: anchor on the ENTERING row nearest the current viewport-top row in document order and pin it there, so the new rows fold in around roughly the same chronological position instead of flipping instantly.
    if (!anchor && !opts.anchorId && afterVisible.length) {
        let topVisDom = -1, topVisY = 0, bestT = Infinity;
        const cur = listView.querySelectorAll('.list-item:not(.list-out)');
        for (let i = 0; i < cur.length; i++) {
            const r = cur[i].getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= vh) continue;
            if (r.top < bestT) { bestT = r.top; topVisY = r.top; topVisDom = domIndex.get(cur[i]); }
        }
        if (topVisDom >= 0) {
            let best = null, bestDist = Infinity;
            for (let i = 0; i < afterVisible.length; i++) {
                const di = domIndex.get(afterVisible[i]);
                const d = Math.abs(di - topVisDom);
                if (d < bestDist) { bestDist = d; best = afterVisible[i]; }
            }
            if (best) { anchor = best; anchorTargetTop = Math.max(0, topVisY); }
        }
    }

    // Instant (still anchored) path: mobile, reduced-motion, or no survivor.
    if (!anchor || reduce || isMobile) {
        const aId = anchor ? anchor.getAttribute('data-id') : null;
        const t0a = anchor ? anchor.getBoundingClientRect().top : 0;
        if (dEl) {
            dEl.classList.remove('selected');
            dEl.style.removeProperty('--metaOffset');
            dEl.style.removeProperty('--subOffset');
            _closeListExtra(dEl, true);
            _applyListThumbSize(dEl);
            const di = dEl.querySelector('img.list-thumb');
            if (di) setImgTier(di, 's');
        }
        renderList();
        if (pinTop) {
            listView.scrollTop = 0;
        } else if (anchorTargetTop != null && aId) {
            const el = _getListItemEl(aId);
            if (el && !el.classList.contains('list-out')) {
                const c = el.getBoundingClientRect().top - anchorTargetTop;
                if (Math.abs(c) > 0.5) listView.scrollTop = Math.max(0, listView.scrollTop + c);
            }
        } else if (aId) {
            const el = _getListItemEl(aId);
            if (el && !el.classList.contains('list-out')) {
                const c = el.getBoundingClientRect().top - t0a;
                if (Math.abs(c) > 0.5) listView.scrollTop = Math.max(0, listView.scrollTop + c);
            }
        } else if (!opts.anchorId) {
            _scrollListToTop(330);
        }
        return;
    }

    const t0 = (anchorTargetTop != null) ? anchorTargetTop : anchor.getBoundingClientRect().top;

    // Safari only: rows animating above the pinned anchor force a scroll correction every frame, which thrashes
    // against the concurrent max-height transitions. Snap everything above the anchor instead and drive the hold
    // with a few timeout snaps.
    const safariSnap = isAppleWebKit;

    // A deselect target that stays visible collapses smoothly now (it shrinks downward, so pinning its top keeps it in place); one that is leaving is folded out whole by the fold-leave setup below.
    if (dEl && dWillVis) {
        dEl.classList.add('animating');
        _closeListExtra(dEl, false);
        dEl.classList.remove('selected');
        dEl.style.removeProperty('--metaOffset');
        dEl.style.removeProperty('--subOffset');
        _applyListThumbSize(dEl);
        const di = dEl.querySelector('img.list-thumb');
        if (di) setImgTier(di, 's');
        setTimeout(() => dEl.classList.remove('animating'), UI_TRANS_MS + 60);
    }

    // Fold only rows that are or will be in the viewport and snap the rest: off-screen folds are invisible, the
    // anchor stays pinned, and their height delta is absorbed by the one synchronous correction, which removes most
    // of the per-frame layout work that made Safari choppy.
    const aIdx = afterVisible.indexOf(anchor);
    const aRect = anchor.getBoundingClientRect();
    const VIS_MARGIN = Math.round(vh * 0.2); // small slack so rows that scroll in during the fold don't pop
    const visTop = -VIS_MARGIN, visBot = vh + VIS_MARGIN;

    // Representative row height from a few currently-visible rows (excluding the
    // possibly-expanded anchor), to turn "visible pixels" into a row count.
    let _rowSum = 0, _rowN = 0;
    for (let i = 0; i < stayers.length && _rowN < 6; i++) {
        if (stayers[i] === anchor) continue;
        const rr = stayers[i].getBoundingClientRect();
        if (rr.height > 0 && rr.bottom > 0 && rr.top < vh) { _rowSum += rr.height; _rowN++; }
    }
    const ROW = _rowN ? Math.max(48, _rowSum / _rowN) : 96;

    // How many rows of the after-order fall in view on each side of the anchor. pinTop folds from the very top instead and skips the Safari above-anchor exclusion, since it runs no per-frame hold.
    const refBottom = pinTop ? 0 : (anchorTargetTop != null ? anchorTargetTop + ROW : aRect.bottom);
    const refTop = pinTop ? 0 : (anchorTargetTop != null ? anchorTargetTop : aRect.top);
    const belowCount = Math.max(0, Math.ceil((visBot - refBottom) / ROW));
    const aboveCount = (safariSnap && !pinTop) ? 0 : Math.max(0, Math.ceil((refTop - visTop) / ROW));

    const base = pinTop ? 0 : aIdx;
    const foldSet = new Set(); // enterers (currently hidden) that will land in view
    if (base !== -1) {
        const lo = Math.max(0, base - aboveCount);
        const hi = Math.min(afterVisible.length - 1, base + belowCount);
        for (let i = lo; i <= hi; i++) {
            const n = afterVisible[i];
            if (n.classList.contains('list-out')) foldSet.add(n);
        }
    }

    // Leavers: fold those whose current rect is in the visible band; snap the rest.
    const foldLeave = [], snapLeave = [];
    for (let i = 0; i < leavers.length; i++) {
        const r = leavers[i].getBoundingClientRect();
        if (r.bottom > visTop && r.top < visBot) foldLeave.push(leavers[i]);
        else snapLeave.push(leavers[i]);
    }
    // The deselected, leaving row is the focal point: always fold it (smoothly).
    if (dEl && !dWillVis) {
        const si = snapLeave.indexOf(dEl);
        if (si !== -1) snapLeave.splice(si, 1);
        if (foldLeave.indexOf(dEl) === -1) foldLeave.push(dEl);
    }
    const foldEnter = [], snapEnter = [];
    for (let i = 0; i < enterers.length; i++) {
        if (foldSet.has(enterers[i])) foldEnter.push(enterers[i]);
        else snapEnter.push(enterers[i]);
    }

    // Year headings ride the same fold as their rows: a heading folds out with the last item of its year and folds in with the first, so a year label never sits alone over an empty stretch or arrives ahead of what it labels.
    const headPlan = _listYearHeadPlan(byId);
    headPlan.forEach((willVis, head) => {
        if (willVis === !head.classList.contains('list-out')) return; // no change
        let firstItem = head.nextElementSibling;
        while (firstItem && !firstItem.classList.contains('list-item')) firstItem = firstItem.nextElementSibling;
        const di = firstItem ? domIndex.get(firstItem) : null;
        if (di != null) domIndex.set(head, di);
        if (willVis) {
            (_listYearHeadFolds(head, foldSet) ? foldEnter : snapEnter).push(head);
        } else {
            const r = head.getBoundingClientRect();
            ((r.bottom > visTop && r.top < visBot) ? foldLeave : snapLeave).push(head);
        }
    });

    // Safari: snap everything above the anchor (keeping the anchor itself, which may be a leaving row folding in place) so it never needs per-frame correction. Below-anchor visible folds stay animated; skipped for pinTop, which holds scrollTop at 0 directly.
    if (safariSnap && !pinTop) {
        const aDom = domIndex.get(anchor);
        const demote = (foldArr, snapArr) => {
            for (let i = foldArr.length - 1; i >= 0; i--) {
                const el = foldArr[i];
                if (el === anchor) continue;
                const di = domIndex.get(el);
                if (di != null && di < aDom) { foldArr.splice(i, 1); snapArr.push(el); }
            }
        };
        demote(foldEnter, snapEnter);
        demote(foldLeave, snapLeave);
    }

    // ---- writes ----
    for (let i = 0; i < foldEnter.length; i++) {
        const el = foldEnter[i];
        el.classList.remove('list-out');
        el.classList.add('list-folding');
        el.__foldDir = 'in';
        _applyListThumbSizeOnce(el);
        _clearFoldInline(el);
        el.style.transition = 'none';
    }
    for (let i = 0; i < foldLeave.length; i++) {
        const el = foldLeave[i];
        // If this leaver is the expanded selection, drop its selected styling first so it collapses as one piece, and measure offsetHeight afterwards to keep the expanded-to-0 collapse rather than a tiny one.
        if (el.classList.contains('selected')) {
            el.classList.remove('selected');
            el.style.removeProperty('--metaOffset');
            el.style.removeProperty('--subOffset');
            const li = el.querySelector('img.list-thumb');
            if (li) setImgTier(li, 's');
        }
        el.classList.add('list-folding');
        el.__foldDir = 'out';
        el.style.transition = 'none';
    }
    for (let i = 0; i < snapEnter.length; i++) {
        const el = snapEnter[i];
        el.classList.remove('list-out');
        el.classList.remove('list-folding');
        el.__foldDir = null;
        _clearFoldInline(el);
        _applyListThumbSizeOnce(el);
    }
    for (let i = 0; i < snapLeave.length; i++) {
        const el = snapLeave[i];
        el.classList.add('list-out');
        el.classList.remove('list-folding');
        el.__foldDir = null;
        _clearFoldInline(el);
    }

    // Measure (border-box, via .list-folding).
    for (let i = 0; i < foldEnter.length; i++) foldEnter[i].__foldTo = foldEnter[i].offsetHeight;
    for (let i = 0; i < foldLeave.length; i++) foldLeave[i].__foldFrom = foldLeave[i].offsetHeight;

    // START states (transition off).
    for (let i = 0; i < foldEnter.length; i++) {
        const s = foldEnter[i].style;
        s.maxHeight = '0px'; s.opacity = '0';
        s.marginTop = '0px'; s.marginBottom = '0px';
        s.paddingTop = '0px'; s.paddingBottom = '0px';
    }
    for (let i = 0; i < foldLeave.length; i++) {
        const el = foldLeave[i];
        el.style.maxHeight = el.__foldFrom + 'px';
        el.style.opacity = '1';
    }

    // Commit START layout, then one synchronous correction. When pinned to the
    // top we just keep scrollTop at 0; otherwise re-pin the anchor.
    let _pinTopTok = 0;
    if (pinTop) {
        listView.scrollTop = 0;
        // Claim a token so the deferred top-resets bail the moment the user
        // interacts: we never want to fight a deliberate scroll.
        _pinTopTok = ++__listHoldToken;
        const o2 = { passive: true, capture: true };
        const cancel = () => {
            __listHoldToken++;
            listView.removeEventListener('wheel', cancel, o2);
            listView.removeEventListener('touchstart', cancel, o2);
            listView.removeEventListener('pointerdown', cancel, o2);
        };
        listView.addEventListener('wheel', cancel, o2);
        listView.addEventListener('touchstart', cancel, o2);
        listView.addEventListener('pointerdown', cancel, o2);
        setTimeout(cancel, 320);
    } else {
        const t1 = anchor.getBoundingClientRect().top;
        const corr = t1 - t0;
        if (Math.abs(corr) > 0.5) listView.scrollTop = Math.max(0, listView.scrollTop + corr);
    }

    const _keepTop = () => { if (_pinTopTok === __listHoldToken && viewMode === 'list' && listView) listView.scrollTop = 0; };

    // Next frame: enable transitions, set END states, start the exact hold.
    requestAnimationFrame(() => {
        for (let i = 0; i < foldEnter.length; i++) {
            const el = foldEnter[i], s = el.style;
            s.transition = '';
            s.maxHeight = el.__foldTo + 'px';
            s.opacity = '1';
            s.removeProperty('margin-top'); s.removeProperty('margin-bottom');
            s.removeProperty('padding-top'); s.removeProperty('padding-bottom');
        }
        for (let i = 0; i < foldLeave.length; i++) {
            const s = foldLeave[i].style;
            s.transition = '';
            s.maxHeight = '0px'; s.opacity = '0';
            s.marginTop = '0px'; s.marginBottom = '0px';
            s.paddingTop = '0px'; s.paddingBottom = '0px';
        }
        if (pinTop) _keepTop();
        else _holdListAnchor(anchor, t0, holdMs, safariSnap);
    });

    // pinTop: counter any reflow/scroll-anchoring drift as the fold settles.
    if (pinTop) {
        setTimeout(_keepTop, 80);
        setTimeout(_keepTop, 240);
    }

    // Finalize each folded row on transitionend (max-height), with a failsafe.
    const all = foldEnter.concat(foldLeave);
    const _finishOne = (el) => {
        if (el.__foldDir === 'out') {
            el.classList.add('list-out');
            // Reset a leftover open .list-extra so a future re-show is collapsed.
            const ex = el.querySelector('.list-extra');
            if (ex) ex.style.maxHeight = '';
        }
        el.classList.remove('list-folding');
        el.__foldDir = null;
        _clearFoldInline(el);
    };
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const onEnd = (ev) => {
            if (ev.target !== el || ev.propertyName !== 'max-height') return;
            el.removeEventListener('transitionend', onEnd);
            _finishOne(el);
        };
        el.addEventListener('transitionend', onEnd);
    }
    // A fan-out, so this joins the group rather than replacing it.
    _afterIn('list.fold', () => {
        for (let i = 0; i < all.length; i++) _finishOne(all[i]);
        for (let i = 0; i < foldEnter.length; i++) _applyListThumbSizeOnce(foldEnter[i]);
    }, FOLD_MS + 220);

    // The visible order is known now; keep dependent UI in sync.
    listOrderIds = afterVisible.map(n => n.getAttribute('data-id'));
    _updateDocTitle();
    _scheduleTagCloudUpdate(true);
    _updateCancelButton();
}

// List: single selection expands image + fans out details.
// Tags in the expanded view reuse search (stay in list mode).
if (listView) {
    /* A year heading is a link to that year in the current filter or search: its href is brought up to date whenever
       the pointer or focus reaches it (so copying the link gets the filter too), and a click scrolls there and puts the
       address in the bar. The address holds a selection or a year, so an open row closes. */
    const _refreshYearHref = (e) => {
        const a = e.target.closest && e.target.closest('.list-year-link');
        if (a) a.setAttribute('href', _viewAddress('list', { y: a.parentElement.getAttribute('data-year') }));
    };
    listView.addEventListener('pointerover', _refreshYearHref);
    listView.addEventListener('focusin', _refreshYearHref);
    listView.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('.list-year-link');
        if (!a) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const year = a.parentElement.getAttribute('data-year');
        if (listSelectedId) setListSelection(null, false, false, false);
        const h = _viewAddress('list', { y: year });
        if (window.location.hash !== h) history.pushState(null, '', h);
        _scrollListToYear(year, true, false);
    }, true);
    listView.addEventListener('click', (e) => {
        let itemEl = e.target.closest('.list-item');
        // Outside the row's content band the empty side margins aren't the item, so treat those clicks as background (matching .row-hover's gating). Only for unselected rows: a selected row's text, tags and links legitimately extend past the band.
        if (itemEl && !isMobile && !itemEl.classList.contains('selected')) {
            const band = _listRowContentBand(itemEl);
            if (band && (e.clientX < band.left || e.clientX > band.right)) itemEl = null;
        }
        if (!itemEl) {
            if (viewMode !== 'list') return;
            _listBackgroundClear();
            return;
        }

        // Tag click → toggle *tag filter* (tags-only; distinct from full-text search)
        const tagEl = e.target.closest('.list-tags a');
        if (tagEl) {
            e.preventDefault();
            const tag = (tagEl.getAttribute('data-tag') || tagEl.textContent || '').trim();
            if (!tag) return;

            // Clear list search when activating tag filter
            if (searchQuery || searchInput.value.trim()) _clearSearchState();

            // Toggle tag filter
            activeTag = (activeTag === tag) ? '' : tag;

            // The row whose chip was clicked is the expanded one: keep it pinned and collapse it as part of the fold so it doesn't jump away and bounce back.
            const prevSel = listSelectedId;
            listSelectedId = null;
            _applyTagFilterToMap();
            _syncTagToSearchBox();
            _updateCancelButton();

            _animateListFilter(prevSel
                ? { anchorId: prevSel, deselectId: prevSel, holdMs: UI_TRANS_MS + 320 }
                : undefined);

            // Update URL (list semantics)
            _writeAddress({ view: 'list', ...(activeTag ? { t: activeTag } : {}) }, true);

            _updateDocTitle();
            return;
        }

        // The title's link behaves normally; everywhere else in a selected row a title click still closes it.
        if (e.target.closest('.title-link')) return;

        const id = itemEl.getAttribute('data-id');
        if (!id) return;

        // In expanded state: clicking the image opens the lightbox; clicking title/subtitle/authors/source collapses.
        // (Tags/links are handled above.)
        if (itemEl.classList.contains('selected')) {
            // Internal "see also" links navigate without collapsing or opening the lightbox. The filter stays when the linked item is in it; otherwise the link lifts the filter so the item can open.
            const seeA = e.target.closest('.list-seealso a');
            if (seeA) {
                e.preventDefault();
                const to = seeA.getAttribute('data-id');
                const toItem = to ? _getTagItemById()[to] : null;
                if (!toItem) return;
                location.hash = _listItemPassesFilters(toItem) ? _viewAddress('list', { i: to }) : _formatAddress({ view: 'list', i: to });
                return;
            }
            if (e.target.closest('.list-seealso')) return;

            const imgHit = e.target.closest('.list-thumb, .list-thumb-wrap');
            if (imgHit && !itemEl.classList.contains('placeholder-img')) {
                e.preventDefault();
                e.stopPropagation();
                const img = itemEl.querySelector('img.list-thumb');
                if (!img) return;
                openLightboxUnified(img, id);
                return;
            }

            /* Authors and source are text to be read, and often text to be taken away: a name to paste into the
               search box, a reference to quote. They stay put under a click, as they do in the monad, so a
               click into them can place a caret and a drag across them can select. The title still closes. */
            if (e.target.closest('.list-authors, .list-source')) return;
            // A click that ends a highlight was the end of a drag over text, wherever it happens to land.
            if (_endsTextSelection()) return;
            const toggleEl = e.target.closest('.list-title');
            if (toggleEl) {
                _deselectListItemFromClick(itemEl, id);
                return;
            }
            // Background click inside the selected item (but not inside the extra text/tags/links): collapse
            if (!e.target.closest('.list-extra')) {
                _deselectListItemFromClick(itemEl, id);
            }
            return;
        }
// Collapsed rows select immediately on click.
        if (isMobile) { _openMobileItemDetail(id, 'list'); return; }
        setListSelection(id, true, true, true, true);
    });

    // Hover is JS-driven (.row-hover, not CSS :hover) so it engages only while the pointer is horizontally inside
    // the row's CONTENT band. Rows span the full list width: their vertical padding is what keeps hover contiguous.
    if (!isMobile) {
        listView.addEventListener('mousemove', (e) => {
            _listHoverPtr.x = e.clientX;
            _listHoverPtr.y = e.clientY;
            if (_pending('list.hoverFrame')) return;
            _onFrame('list.hoverFrame', _updateListHoverFromPointer);
        }, { passive: true });
        listView.addEventListener('mouseleave', () => {
            _cancel('list.hoverFrame');
            _setListRowHover(null);
        });
        // Rows move under a stationary cursor (shifts, select/deselect,
        // scrolling), so re-evaluate on scroll as well.
        listView.addEventListener('scroll', () => {
            if (_pending('list.hoverFrame')) return;
            _onFrame('list.hoverFrame', _updateListHoverFromPointer);
        }, { passive: true });
    }
}

// Keep thumbnail sizing stable on resize
window.addEventListener('resize', () => {
    if (viewMode !== 'list' || !listView || _heightOnlyResizeOnTouch()) return;
    const els = listView.querySelectorAll('.list-item');
    // Loop over matching DOM elements.
    for (const el of els) {
        if (el.classList.contains('list-out')) continue; // hidden: can't measure
        _applyListThumbSize(el);
        if (el.classList.contains('selected')) {
            _syncListExtra(el);
            _updateListMetaOffset(el);
        }
    }
}, { passive: true });

/** Switch UI into list view while preserving selection/search state. */
function switchToListView(updateHash = true, push = true, carry = true) {
    // As switchToMapView and switchToMonadView do: a view change closes the info panel, without touching history: the switch below writes the address.
    if (_infoOverlayRef && _infoOverlayRef.classList.contains('visible')) hideInfo(false);
    if (viewMode === 'grid') _exitGridView();
    // Stub-mode: clear monad cache since we may be leaving monad view.
    if (lightboxOpen) closeLightbox(true);
    _savedMapCamera = null; // forget map camera when switching to list
    // Clean up pending monad-related reveal timers/classes
    _cancel('monad.relatedReveal');
    document.body.classList.remove('monad-related-hidden');
    if (infoOverlay.classList.contains('visible')) hideInfo(false);

    /* Carry an active selection from the monad or the grid into the list, but only when the SWITCHER asked for the change. */
    const carryId = !carry ? null
        : (viewMode === 'monad' && selectedMonadId) ? selectedMonadId
        : (viewMode === 'grid' && gridSelectedId) ? gridSelectedId
        : null;

    // Leave monad/search canvas state, but keep the search input value as-is. updateHash is false on both legs, as
    // in switchToGridView: this is a step THROUGH the map, and letting it write pushed a bogus map entry into
    // history and overwrote the #list: hash that hash-driven callers had just navigated to.
    if (viewMode === 'monad' || viewMode === 'search') {
        switchToMapView(false, true, false, isMobile);
    }
    // The intermediate switchToMapView may have scheduled stagger-reveal timers that will never fire, since viewMode is about to become 'list': cancel them so monad-stagger-hide doesn't linger on articles.
    _cancel('monad.staggerReveal', 'monad.staggerRevealFrame');

    // Purge the LIVE map camera too, but only with no filter active. Nulling _savedMapCamera drops the snapshot
    // while zoom/panX/panY still hold the last map state, which a later list-to-monad entry would snapshot back and
    // restore as stale.
    if (!activeTag && !(searchQuery || '').trim()) {
        zoom = 0;
        panX = 0;
        panY = 0;
    }

    _setViewMode('list');
    document.body.classList.add('list-view');
    if (listView._applyBodyScroller) listView._applyBodyScroller();

    const q = searchInput.value.trim();
    document.body.classList.toggle('search-has-query', q.length > 0);
    searchQuery = q;
    searchScores = q.length >= 2 ? computeSearchScores(q) : {};

    // A carried selection keeps the filter it sits in (as from a filtered grid); only a filter that would hide it is lifted.
    if (carryId) {
        const _ci = _getTagItemById()[carryId];
        if (!(_ci && _listItemPassesFilters(_ci))) {
            _clearSearchState();
            if (activeTag) _clearTagFilterState();
        }
    }
    listSelectedId = null;
    renderList();

    if (carryId) {
        // Select and reveal the carried item (scroll instantly so shared-image transition has a stable target)
        setListSelection(carryId, true, false, updateHash, push);

        // Stabilise layout before measuring: the chunked thumbnail-sizing loop keeps changing heights above the target
        // for a few hundred ms, so a scroll position computed now is invalidated moments later.
        _cancelListThumbSizing();
        const _allItems = listView ? listView.querySelectorAll('.list-item') : [];
        for (let i = 0; i < _allItems.length; i++) {
            _applyListThumbSizeOnce(_allItems[i]);
        }

        const _el = _getListItemEl(carryId);
        if (_el && listView) {
            // The row is mid-expansion, so its current height isn't where it settles. Predict the settled height, or centring lands it too high and its lower half runs off the bottom.
            const _extra = _el.querySelector('.list-extra');
            const _grow = _extra ? Math.max(0, _extra.scrollHeight - _extra.offsetHeight) : 0;
            const _finalH = _el.offsetHeight + _grow;

            const _viewH = listView.clientHeight;
            if (_finalH < _viewH * 0.9) {
                // Fits: centre it vertically.
                listView.scrollTop = Math.max(0, _el.offsetTop - (_viewH - _finalH) / 2);
            } else {
                // Taller than the viewport: centring is meaningless; put its
                // top in the usual reading band instead.
                _scrollListEl(_el, 'top10');
            }

            // Pin the landed placement through late layout: thumbnails whose dimensions weren't preknown resize on load and push the row out of place. Anchored to whatever offset the landing produced; user interaction cancels the hold.
            const _lvTop = listView.getBoundingClientRect().top;
            const _curOffset = _el.getBoundingClientRect().top - _lvTop;
            _holdListAnchor(_el, _curOffset, 900, true);
        }
        purgeHighResImages();
        return;
    }

    if (updateHash) {
        _setHashForCurrentState(push);
    }
    _updateDocTitle();

    if (q.length > 0) searchBox.classList.add('open');
    purgeHighResImages();
    _stubMapBehindPanel();

    _scheduleTagCloudUpdate(true);
}

window.addEventListener('resize', () => {
    if (_heightOnlyResizeOnTouch()) return;
    // Same reflow, different cause: a narrower window re-wraps the list and re-columns the grid, and without an anchor the reader's place moves with it. Short, since a resize lands in one frame rather than animating.
    _holdPanelAnchor(180);
    document.body.classList.add('notransition');
    _cancel('render.notransitionClass');
    isInteracting = true;

    const minZoom = getMinZoom();
    if (zoom < minZoom) zoom = minZoom;

    update();

    if (viewMode === 'monad' && selectedMonadId) {
        const centerArticle = _articleById(selectedMonadId);
        if (centerArticle) {
            centerArticle.classList.remove('monad-text-geom-ready');
            requestAnimationFrame(() => {
                if (viewMode === 'monad' && selectedMonadId) {
                    _measureMonadTextGeometry(centerArticle);
                    update();
                }
            });
        }
    }

    _cancel('render.resize');
    _after('render.resize', () => {
        isInteracting = false;
        document.body.classList.remove('notransition');
    }, 150);
    tagVis.linksSettle(400);
});
