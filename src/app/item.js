/* ══ ITEM DETAIL (PHONE) ═══════════════════════════════════════════════════════
   On a phone an open item is a full-screen detail rather than a state of the view behind it. The list and the
   grid hand the selection to the monad (see map.js), which covers the screen, so all three views show the same
   detail. This file holds the phone-only parts: opening the detail from a panel, the page's scroll space for
   reading it, and the taps inside it. index.html loads it only on a phone, so every call from another file
   sits behind an isMobile check. */

// Mobile monad at zoom 1 uses native page scrolling to read the detail text, and the centre item is absolutely positioned, so padding is set dynamically to match the actual content height.
/* Two earlier sources now: a pass two frames after the zoom-in or swap, and a ResizeObserver on the centre's .detail-fields, which catches content that lays out late (the first build of the details, a font swap, a late image). */
let _monadScrollRO = null;
let _monadScrollObserved = null;
function _observeMonadDetails(el) {
    if (el === _monadScrollObserved) return;
    if (!_monadScrollRO) {
        if (typeof ResizeObserver !== 'function') return;
        _monadScrollRO = new ResizeObserver(() => updateMobileItemDetailScrollSpace(_zoomAnimating || _viewTransitionActive()));
    }
    if (_monadScrollObserved) _monadScrollRO.unobserve(_monadScrollObserved);
    _monadScrollObserved = el;
    if (el) _monadScrollRO.observe(el);
}

/** Open the page's scroll space for the mobile monad centre at zoom 1. growOnly keeps an existing larger value, for passes made while the layout may still be settling. */
function updateMobileItemDetailScrollSpace(growOnly = false) {
    const mainEl = document.querySelector('main');
    if (!mainEl) return;

    const active = isMobile && viewMode === 'monad' && document.body.classList.contains('monad-zoomed-in') && selectedMonadId;
    if (!active) {
        mainEl.style.paddingBottom = '';
        _observeMonadDetails(null);
        return;
    }

    const centerArticle = _articleById(selectedMonadId);
    if (!centerArticle) return;
    const details = centerArticle.querySelector('.detail-fields');
    if (!details) return;
    _observeMonadDetails(details);

    const vh = window.innerHeight || 1;

    // Measure in scroll-space coordinates so padding stays stable as user scrolls.
    const scrollEl = document.scrollingElement || document.documentElement;
    const scrollTop = (scrollEl && scrollEl.scrollTop) || document.body.scrollTop || document.documentElement.scrollTop || 0;

    // Use the detail-fields bounding rect: it's a flex column that encompasses all children.
    const detailsBottom = details.getBoundingClientRect().bottom + scrollTop;

    // Padding needed so the user can scroll the very bottom into view + comfort margin. The margin is the slack the
    // reader can pull past the end of the text.
    const _detailCs = getComputedStyle(details);
    let _lineHeightPx = parseFloat(_detailCs.lineHeight);
    if (!Number.isFinite(_lineHeightPx)) _lineHeightPx = (parseFloat(_detailCs.fontSize) || 16) * 1.5;
    const tailPad = Math.max(0, 80 - _lineHeightPx * 1.5);
    const requiredPad = Math.ceil(Math.max(0, detailsBottom - vh + tailPad));
    if (growOnly && requiredPad <= (parseFloat(mainEl.style.paddingBottom) || 0)) return;

    mainEl.style.paddingBottom = requiredPad + 'px';
}

/** The early pass: two frames after a zoom-in or a centre swap, once the snapped zoom-1 layout exists. */
function _earlyMobileItemDetailScrollSpace() {
    requestAnimationFrame(() => requestAnimationFrame(() => updateMobileItemDetailScrollSpace(true)));
}

/* Inside an open detail on a phone, a keyword and a linked item are plain hash anchors (#<tag> and #<id>) which
   land in the map's namespace and take the reader out of the panel they came from. */
document.addEventListener('click', (e) => {
    if (!isMobile || viewMode !== 'monad') return;
    const a = e.target.closest && e.target.closest('.detail-fields .tags a, .detail-fields .seealso a');
    if (!a) return;
    const panel = _detailPanelPrefix();
    if (!panel) return;
    if (panel === 'map') {
        /* A keyword tapped here means "show me the map of this keyword", which is the plain #<tag> the anchor already
           carries, and _tagClickFitIntent (set by the capture handler above) is what frames it. Left to navigate on its
           own. */
        if (a.closest('.tags')) return;
        e.preventDefault();
        e.stopPropagation();
        const linkedId = (() => {
            return _parseAddress(a.getAttribute('href') || '').i;
        })();
        if (!linkedId) return;
        const mh = _viewAddress('map', { i: linkedId });
        if (window.location.hash !== mh) history.pushState(null, '', mh);
        _enterMobileItemDetail(linkedId, true);
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    // The capture handler above set the map's fit-the-tag-subset intent, which the step through switchToMapView would then spend fitting a map nobody is going to see. This click lands in a panel instead.
    _tagClickFitIntent = false;
    if (a.closest('.tags')) {
        const tag = (a.getAttribute('data-tag') || a.textContent || '').trim();
        if (!tag) return;
        const h = _formatAddress({ view: panel, t: tag });
        if (window.location.hash !== h) history.pushState(null, '', h);
        handleHashChange(false);
        return;
    }
    const id = (() => {
        return _parseAddress(a.getAttribute('href') || '').i;
    })();
    if (!id) return;
    const h = _viewAddress(panel, { i: id });
    if (window.location.hash !== h) history.pushState(null, '', h);
    _enterMobileItemDetail(id, true);
}, true);

/** On a phone an open item is its own view rather than a state of the panel behind it: the list and the grid hand
 *  the selection to the monad, which already covers the screen and hides what is under it, so all three views
 *  show the same detail built by the same code and there is one layout to maintain rather than three. */
function _openMobileItemDetail(id, panel) {
    const hash = _viewAddress(panel, { i: id });
    if (window.location.hash !== hash) history.pushState(null, '', hash);
    _enterMobileItemDetail(id, true);
}

/** The entry itself, shared with the two hash branches. Note the argument order: switchToMonadView is (itemId,
 *  updateHash, animate), not (itemId, animate, updateHash). */
function _enterMobileItemDetail(id, animate) {
    const fromPanel = (viewMode === 'list' || viewMode === 'grid');
    if (fromPanel) {
        _panelScrollY[viewMode] = (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
    }
    /* From a panel the monad is entered in place, with the animation off: the panel is an opaque overlay over the map,
       so there is no position on screen for the centre to travel from. The phone stylesheet holds the whole centre
       stack at transition: none for the same reason. */
    switchToMonadView(id, false, fromPanel ? false : animate);
}
