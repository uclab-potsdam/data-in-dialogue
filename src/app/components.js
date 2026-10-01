/* ══ COMPONENTS ═════════════════════════════════════════════════════════════
   The controls that sit over every view: the info overlay, the search box with its reset/cancel button, the
   random shuffle, the view switcher and the image lightbox, plus the press feedback they share. See the file list in core.js. */

/* ══ INFO OVERLAY ════════════════════════════════════════════════════════════ */
// Info button: load info.md and show overlay
const infoOverlay = _infoOverlayRef;
const infoCloseBtn = document.getElementById('info-overlay-close');
// Prefetch info.md eagerly so it's ready before the user opens the panel.
// The fetch fires immediately; parsing happens on resolve, well before images load.
const _infoPrefetch = fetch('info.md')
    .then(r => r.text())
    .then(md => {
        const lines = md.split('\n');
        let html = '';
        let inList = false;

        for (const line of lines) {
            // Apply inline formatting
            const fmt = line
                .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

            if (fmt.match(/^### /)) {
                if (inList) { html += '</ul>'; inList = false; }
                html += '<h3>' + fmt.slice(4) + '</h3>';
            } else if (fmt.match(/^## /)) {
                if (inList) { html += '</ul>'; inList = false; }
                html += '<h2>' + fmt.slice(3) + '</h2>';
            } else if (fmt.match(/^# /)) {
                if (inList) { html += '</ul>'; inList = false; }
                html += '<h1>' + fmt.slice(2) + '</h1>';
            } else if (fmt.match(/^[-*] /)) {
                if (!inList) { html += '<ul>'; inList = true; }
                html += '<li>' + fmt.replace(/^[-*] /, '') + '</li>';
            } else if (fmt.trim() === '') {
                if (inList) { html += '</ul>'; inList = false; }
            } else {
                if (inList) { html += '</ul>'; inList = false; }
                html += '<p>' + fmt + '</p>';
            }
        }
        if (inList) html += '</ul>';
        return html;
    });
// Inject the prefetched HTML as soon as it resolves (no user action needed).
_infoPrefetch.then(html => {
    infoOverlay.innerHTML = html;
}).catch(() => {
    infoOverlay.innerHTML = '<p>Could not load info.</p>';
});

/* The panel takes a strip off the left rather than covering one, so opening and closing it is a layout change
   for whatever view is underneath.
   - map, search and monad position articles by JS transform, so they are recomputed and animated to the new
   centre on the map's clock;
   - the grid measures its columns from the container's width, so the cards are re-laid out and glide to their
   new columns;
   - the list reflows from CSS and needs nothing. Both content containers are deliberately untransitioned (see
   their rules), so what moves is the content itself, once, rather than a box sliding under content that is also
   sliding. */
/** Open or close the info panel's strip, carrying the view underneath across the change of width. */
function _setInfoOpen(open) {
    if (document.body.classList.contains('info-open') === open) return;

    /* The map's layout square is derived from the width it has to work in (getBaseSquareSize reads __mainVW), so
       taking a strip away shrinks the whole map. pan is carried in screen pixels against that square, so leaving it
       untouched slides whatever the reader had at the centre off to one side: the wider the panel, the further off. */
    const _sqBefore = getSquareSize();

    /* Before the class flips, so the capture reads the layout as it still is. The hold runs
       a little past --infoTrans, because the panel's transition is what drives the reflow and
       the last of it lands on the closing frame. */
    const infoMs = _cssMs('--infoTrans', 450);
    _holdPanelAnchor(infoMs + 120);
    document.body.classList.toggle('info-open', open);
    _updateDocTitle();
    // Marks the window in which the content is travelling with the panel, so the map's items run on --infoTrans rather than their own 750ms move. Removed a little past the end so the last frame isn't cut short.
    document.body.classList.add('info-moving');
    _after('info.moving', () => document.body.classList.remove('info-moving'), infoMs + 70);
    _invalidateMainInset();
    _invalidateMapOcc();
    /* And again once the panel has finished travelling, the way _setTagSidebarW already pairs its own invalidation. */
    _after('info.occ', _invalidateMapOcc, UI_TRANS_MS + 50);

    const _sqAfter = getSquareSize();
    if (_sqBefore > 0 && _sqAfter > 0 && _sqAfter !== _sqBefore) {
        const k = _sqAfter / _sqBefore;
        panX *= k;
        panY *= k;
        clampPan();
    }

    if (viewMode === 'grid') {
        renderGrid(true);
        _gridRefreshImages(false);
    } else if (viewMode !== 'list') {
        triggerAnimation();
        update();
    }
    // The list and the grid have just re-laid out at the new width: put the held item back now, in this frame, rather than on the hold's first rAF.
    _restorePanelAnchor(_panelAnchorHold);
}

/** Show the info panel, adding #about to the address unless updateHash is false. */
function showInfo(updateHash, animate = true) {
    _setInfoOpen(true);
    // Ensure initial render before animating
    if (animate) {
        setTimeout(() => {
            infoOverlay.classList.add('visible');
            infoCloseBtn.classList.add('visible');
        }, 0);
    } else {
        infoOverlay.classList.add('visible');
        infoCloseBtn.classList.add('visible');
    }

    if (updateHash !== false && !(window.location.hash || '').startsWith('#about')) {
        /* Prefixed onto whatever the address already said, rather than replacing it. */
        const _under = (window.location.hash || '').slice(1);
        history.pushState(null, '', _under ? ('#about/' + _under) : '#about');
    }
}

/** Hide info. deferLayout keeps body.info-open, and with it the inset, until the caller says the pointer is free; the panel itself starts sliding either way. Only the outside-press path uses it: see _hideInfoOnRelease. */
function hideInfo(updateHash, deferLayout) {
    if (!deferLayout) _setInfoOpen(false);
    infoOverlay.classList.remove('visible');
    infoCloseBtn.classList.remove('visible');
    if (updateHash !== false && (window.location.hash || '').startsWith('#about')) {
        /* Hand the address back to what it said before rather than clearing it: the panel never changed the view
           underneath, so a reload or a shared link has to land on the same item, tag or list. pushState rather than
           back(), matching the open: there is no state to restore, only an address to correct. */
        const _under = (window.location.hash || '').slice(1).replace(/^about\/?/, '');
        history.pushState(null, '', _under
            ? ('#' + _under)
            : (window.location.pathname + window.location.search));
    }
}


/* Close the panel, but give the strip back only once the press that closed it is over. The panel now insets the
   page rather than covering it, so --main-inset moves main, the list, the grid and the corner controls. */
function _hideInfoOnRelease() {
    hideInfo(true, true);
    const settle = () => {
        window.removeEventListener('mouseup', settle);
        window.removeEventListener('touchend', settle);
        window.removeEventListener('touchcancel', settle);
        window.removeEventListener('blur', settle);
        // A frame late on purpose: click is dispatched straight after mouseup, and moving the page between the two is the whole problem.
        requestAnimationFrame(() => _setInfoOpen(false));
    };
    window.addEventListener('mouseup', settle);
    window.addEventListener('touchend', settle);
    window.addEventListener('touchcancel', settle);
    window.addEventListener('blur', settle);
}

// Close info overlay when clicking outside
['mousedown','touchstart'].forEach(evt => {
    document.addEventListener(evt, (e) => {
        if (!infoOverlay.classList.contains('visible')) return;
        if (e.target.closest && (e.target.closest('#info-overlay') || e.target.closest('#info-overlay-close') || e.target.closest('#info-btn'))) return;
        /* The two controls that ride --main-inset are left alone entirely rather than deferred: they travel the full width of the panel, so even the release-deferred move would take them out from under the pointer before the click. */
        if (e.target.closest && e.target.closest('#mode-btn')) return;
        _hideInfoOnRelease();
    }, { passive: true });
});
document.getElementById('info-btn').addEventListener('click', () => {
    if (infoOverlay.classList.contains('visible')) hideInfo();
    else showInfo();
});

infoCloseBtn.addEventListener('click', () => hideInfo());

// Prevent scroll/zoom passthrough and drag when overlay is visible
infoOverlay.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
infoOverlay.addEventListener('mousedown', (e) => e.stopPropagation());
infoOverlay.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });


/* Scrolling the view behind the panel closes it. The panel is an aside to whatever is on screen rather than a
   mode of its own, so reaching for the map or the list is already the reader saying they are done with it:
   before this they had to travel back to the × to say the same thing. wheel rather than scroll, because the map
   does not scroll at all: a wheel there is a zoom, and a scroll listener would miss the one view where the panel
   takes the most room. */
if (!isMobile) {
    window.addEventListener('wheel', (e) => {
        if (!document.body.classList.contains('info-open')) return;
        const t = e.target;
        if (t && t.closest && t.closest('#info-overlay')) return;
        hideInfo(true);
    }, { passive: true });
}

/* ══ WELCOME POPOVER ═════════════════════════════════════════════════════════
   A greeting over the loaded atlas, on a first sight of it and nothing else: an address that named an item, a tag,
   a query, a view or the about panel is either a reader who knows where they are going or a link someone shared,
   and a card in front of what they asked for is in the way. */

const _welcomeEl = document.getElementById('welcome');
/* Read at load, before the boot's own handleHashChange can rewrite the address: by the time the atlas is ready to
   show this, the hash may already say what the router made of it. */
const _welcomeAddressWasEmpty = !(window.location.hash || '').replace(/^#/, '')
    && !(window.location.search || '');

/** Whether the card is on screen. */
function _welcomeOpen() {
    return !!_welcomeEl && !_welcomeEl.hidden;
}

/** Take the card away. Nothing is remembered: the greeting belongs to an address with nothing in it, and asking
 *  for that address again is asking for it again. */
function _hideWelcome() {
    if (!_welcomeOpen()) return;
    _welcomeEl.classList.remove('visible');
    const done = () => {
        if (!_welcomeEl) return;
        _welcomeEl.hidden = true;
        // The card is off screen, so the title can name the view again.
        _updateDocTitle();
    };
    if (_prefersReducedMotion()) done();
    else _after('welcome.hide', done, _cssMs('--infoTrans', 450) + 40);
}

/** Show the card, if this load earned one. Called once, after the atlas has finished loading: over the loading
 *  overlay it would be a greeting on top of a spinner, and the reader would meet the atlas through it rather
 *  than beside it. */
function _maybeShowWelcome() {
    if (!_welcomeEl || !_welcomeAddressWasEmpty) return;
    // A reader who has already started (a tag, a search, an item, the panel) is past being welcomed.
    if ((window.location.hash || '').replace(/^#/, '')) return;

    /* Bind the last two words of each paragraph. text-wrap: pretty and balance are both capped at a few lines by
       the engines and measurably do nothing on a block this tall (seven lines on a phone, identical under either),
       so the orphan is prevented outright rather than asked for. \s matches the bound space too, so this is
       idempotent. */
    _welcomeEl.querySelectorAll('#welcome-card p').forEach((p) => {
        p.textContent = p.textContent.replace(/\s+(\S+)\s*$/, ' $1');
    });

    _welcomeEl.hidden = false;
    /* The boot wrote the view into the title a moment ago; behind the card that view is not what the reader is
       looking at yet, so the tab keeps the page's own name until they have come through (see _composeDocTitle). */
    _updateDocTitle();
    // Next frame, so the opacity has a state to travel from.
    requestAnimationFrame(() => {
        if (_welcomeOpen()) _welcomeEl.classList.add('visible');
    });
    /* Deliberately nothing is focused: focusing the primary action drew a focus ring around it the moment the card
       appeared, which read as a glow on the one button. Escape is caught at the window, and Tab still reaches both
       buttons, where the ring belongs. */
}

if (_welcomeEl) {
    const more = document.getElementById('welcome-more');
    const start = document.getElementById('welcome-start');
    // "Learn More" hands the reader to the panel that holds the long version, and takes the card away behind it.
    if (more) more.addEventListener('click', () => { _hideWelcome(); showInfo(); });
    if (start) start.addEventListener('click', _hideWelcome);
    /* A press on the scrim says the same thing as "Start Exploring". Only on the scrim itself: a press that lands
       on the card is a press on the card, including the drag that selects a line of it. */
    _welcomeEl.addEventListener('click', (e) => {
        if (e.target === _welcomeEl) _hideWelcome();
    });
    // The card is over the map: keep its own wheel and drag off the camera underneath.
    _welcomeEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
    _welcomeEl.addEventListener('mousedown', (e) => e.stopPropagation());
    _welcomeEl.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
}


/* ══ SEARCH BOX ══════════════════════════════════════════════════════════════
   The box itself, its tag mirroring, and the reset/cancel button beside it. */
/** Mirror an active tag filter in the search box as "#tag" wherever the box carries tags (_tagsInSearchBox). Where the
 *  tag pane shows (again, after a window grew), the mirrored "#tag" is taken back out. */
function _syncTagToSearchBox() {
    if (!_tagsInSearchBox()) {
        // Only the mirror of the active tag: a "#..." typed as a full-text search stays.
        if (activeTag && (searchInput.value || '').trim() === '#' + activeTag) {
            searchInput.value = '';
            document.body.classList.remove('search-has-query');
            if (viewMode !== 'search') {
                searchBox.classList.remove('open');
                document.body.classList.remove('search-open');
            }
        }
        return;
    }

    const cur = (searchInput.value || '').trim();
    if (activeTag) {
        const want = '#' + activeTag;
        if (cur !== want) searchInput.value = want;
        document.body.classList.add('search-has-query');
        searchBox.classList.add('open');
        document.body.classList.add('search-open');
    } else {
        if (cur.startsWith('#')) searchInput.value = '';
        // Keep "search-has-query" if the user is typing a real full-text search.
        if (!searchInput.value.trim()) document.body.classList.remove('search-has-query');
        if (viewMode !== 'search' && !searchInput.value.trim()) {
            searchBox.classList.remove('open');
            document.body.classList.remove('search-open');
        }
    }
}

/** Show or hide the cancel (x) button on desktop: visible whenever there is a tag filter, a monad selection or a search query: any state that can be cancelled back to the default overview. */
function _updateCancelButton() {
    const hasTarget = !!(
        activeTag ||
        (viewMode === 'monad' && selectedMonadId) ||
        (viewMode === 'search' && searchQuery) ||
        (viewMode === 'list' && listSelectedId) ||
        (viewMode === 'grid' && gridSelectedId)
    );
    document.body.classList.toggle('has-cancel-target', hasTarget);
    _updateShareButton();
}


// Search input handling
const searchInput = document.getElementById('search-input');
const searchBox = document.getElementById('search-box');
const searchIcon = document.getElementById('search-icon');

/** Open search. */
function openSearch() {
    // The box grows leftwards from a fixed right edge, so the loupe that was just pressed slides away from under the pointer. The cross sits where it was, and takes the press with it.
    _pressFeedback(document.getElementById('search-cancel-btn'));
    searchBox.classList.add('open');
    document.body.classList.add('search-open');
    // Focus immediately (synchronous with user gesture) so mobile browsers
    // recognise this as user-initiated and open the keyboard.
    searchInput.focus();
    // Also focus after the CSS transition in case the browser ignored the
    // early call (input was still width:0 / opacity:0).
    setTimeout(() => searchInput.focus(), 120);
}

/* The open box grows leftwards when the query is longer than its resting width, so the text is not cut off, and
   stops one --edge short of #info-btn. The CSS takes the larger of its resting width and --search-fit-w. */
let _searchFitCtx = null;
function _fitSearchBox() {
    const q = searchInput.value;
    if (!q || !searchBox.classList.contains('open')) {
        searchBox.style.removeProperty('--search-fit-w');
        if (searchBox.classList.contains('search-fit')) searchBox.classList.remove('search-fit');
        return;
    }
    const cs = getComputedStyle(searchInput);
    _searchFitCtx = _searchFitCtx || document.createElement('canvas').getContext('2d');
    _searchFitCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // Loupe, text, the input's padding (which makes room for the cross), and 12px of air between the text and the cross.
    const need = searchIcon.offsetWidth + _searchFitCtx.measureText(q).width
        + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 12;
    const info = document.getElementById('info-btn').getBoundingClientRect();
    const edge = _cssLengthPx(document.documentElement, '--edge');
    const room = searchBox.getBoundingClientRect().right - (info.width ? info.right : 0) - edge;
    searchBox.style.setProperty('--search-fit-w', Math.ceil(Math.min(need, room)) + 'px');
    if (!searchBox.classList.contains('search-fit')) searchBox.classList.add('search-fit');
}
function _scheduleSearchFit() { _onFrame('search.fit', _fitSearchBox); }
searchInput.addEventListener('input', _scheduleSearchFit);
window.addEventListener('resize', _scheduleSearchFit);
if (document.fonts) document.fonts.ready.then(_scheduleSearchFit);
// Only the three classes that change the box's width or the input's padding count: the body's classes change on
// every transition and drag, and a fit reads layout.
let _searchFitKey = '';
const _searchFitClassWatch = new MutationObserver(() => {
    const b = document.body.classList;
    const key = [searchBox.classList.contains('open'), b.contains('search-open'), b.contains('search-has-query')].join();
    if (key === _searchFitKey) return;
    _searchFitKey = key;
    _scheduleSearchFit();
});
_searchFitClassWatch.observe(searchBox, { attributes: true, attributeFilter: ['class'] });
_searchFitClassWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
{
    const _valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(searchInput, 'value', {
        get() { return _valueProp.get.call(this); },
        set(v) { _valueProp.set.call(this, v); _scheduleSearchFit(); },
        configurable: true,
    });
}

/** Blur search input if focused (hides mobile keyboard on pan/scroll). */
function _blurSearchIfFocused() {
    if (document.activeElement === searchInput) {
        searchInput.blur();
    }
}

/** Close search. */
function closeSearch() {
    _cancel('search.input');
    const prev = (searchInput.value || '').trim();
    const hadMobileTag = _tagsInSearchBox() && prev.startsWith('#');

    searchInput.value = '';
    document.body.classList.remove('search-has-query');
    document.body.classList.remove('search-open');
    searchInput.blur();
    searchBox.classList.remove('open');
    searchQuery = '';
    searchScores = {};

    // Where the box carries tags, a "#tag" in it is the tag filter: cancel clears the tag filter too.
    if (hadMobileTag && activeTag) {
        const t = prev.slice(1).trim();
        if (!t || t === activeTag) {
            activeTag = '';
            _applyTagFilterToMap();
        }
    }
    _syncTagToSearchBox();
    _updateCancelButton();

    if (viewMode === 'list') {
        // Keep list hash semantics: selection > tag > plain list
        const t = (listSelectedId || '').trim();
        if (t) {
            _writeAddress({ view: 'list', t }, true);
            _updateDocTitle();
        } else if (activeTag) {
            _writeAddress({ view: 'list', t: activeTag }, true);
            _updateDocTitle();
        } else {
            _writeAddress({ view: 'list' }, false);
            _updateDocTitle();
        }
        // Search state is already cleared, so this folds the previously hidden rows back in around a stable anchor instead of an abrupt rebuild and jump to the top.
        _animateListFilter();
        _scheduleTagCloudUpdate(true);
        return;
    }

    if (viewMode === 'grid') {
        _setHashForCurrentState(true);
        _updateDocTitle();
        renderGrid(true);
        return;
    }

    if (viewMode === 'search') {
        switchToMapView();
        // Clear hash (or keep tag if it exists)
        _writeAddress(activeTag ? { t: activeTag } : {}, false);
        _updateDocTitle();
        _scheduleTagCloudUpdate(true);
        return;
    }

    // Map view: if we just cleared a mobile tag filter, also clear the URL hash/title.
    if (viewMode === 'map' && hadMobileTag && !activeTag) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
        _updateDocTitle();
        _scheduleTagCloudUpdate(true);
    }
}

searchIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    if (viewMode === 'monad') {
        switchToMapView();
        openSearch();
        return;
    }
    if (searchBox.classList.contains('open')) {
        // Open: loupe is inert apart from refocusing the input. Closing/
        // resetting is the cancel button's job.
        searchInput.focus();
        return;
    }
    openSearch();
});

// Clicking the collapsed box (not yet open) also opens it, but not in monad view
searchBox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (viewMode === 'monad') return;
    // Ignore clicks on interactive children: they handle themselves
    if (e.target.closest('#search-icon')) return;
    if (!searchBox.classList.contains('open')) {
        openSearch();
    }
});

searchInput.addEventListener('input', (e) => {
    const raw = (e.target.value || '');
    const query = raw.trim();

    // Where the box carries tags (_tagsInSearchBox), "#tag" is a tag filter, not a full-text search for "#tag".
    // Immediate (no debounce), since it only toggles classes.
    if (_tagsInSearchBox() && query.startsWith('#')) {
        const tag = query.slice(1).trim();

        // Clear full-text search state (tag filters are a separate mode).
        searchQuery = '';
        searchScores = {};
        listSelectedId = null;

        activeTag = tag;
        _applyTagFilterToMap();

        // Keep the box open so the tag is visible and can be cancelled.
        document.body.classList.toggle('search-has-query', !!query && query !== '#');
        searchBox.classList.add('open');

        // If we were in search view, exit it but keep the map camera.
        if (viewMode === 'search') {
            switchToMapView(true, false, true);
        }

        if (viewMode === 'list') {
            renderList();
            if (tag) {
                _writeAddress({ view: 'list', t: tag }, false);
                _updateDocTitle();
            } else {
                _writeAddress({ view: 'list' }, false);
                _updateDocTitle();
            }
            _scrollListToTop(330);
        } else if (viewMode === 'grid') {
            renderGrid(true);
            _gridScrollToTop();
            _setHashForCurrentState(false);
            _updateDocTitle();
        } else if (tag) {
            _writeAddress({ t: tag }, false);
            _updateDocTitle();
            // Match desktop tag behavior: zoom/pan reset also recenters.
            if (zoom > 0.02 || Math.abs(panX) > 0.5 || Math.abs(panY) > 0.5) resetView(true);
            else {
                // Do not let beginInteraction() kill transitions on tag (un)filter.
                _resumeTransitions();
                requestAnimationFrame(() => update());
            }
        } else {
            history.replaceState(null, '', window.location.pathname + window.location.search);
            _updateDocTitle();
            _resumeTransitions();
            requestAnimationFrame(() => update());
        }

        _scheduleTagCloudUpdate(true);
        return;
    }

    // Immediate visual feedback for the search box state. search-has-query is kept while the input is focused, or the has-cancel-target:not(.search-has-query) rule hides the box.
    const inputFocused = document.activeElement === searchInput;
    document.body.classList.toggle('search-has-query', query.length > 0 || inputFocused);
    // Keep box open while the input has focus (even if query is empty)
    if (query.length > 0 || inputFocused) {
        searchBox.classList.add('open');
    }

    // Debounce the heavy search computation + layout update
    _after('search.input', () => {
        const currentQuery = (searchInput.value || '').trim();
        const isEffectiveSearch = currentQuery.length >= 2;

        // Full-text search and tag filter are distinct: entering search clears tag filter
        if (activeTag) {
            activeTag = '';
            _applyTagFilterToMap();
            _syncTagToSearchBox();
        }

        if (viewMode === 'list') {
            searchQuery = isEffectiveSearch ? currentQuery : '';
            searchScores = isEffectiveSearch ? computeSearchScores(currentQuery) : {};
            // Search is a predicate over the permanent chronological DOM, so typing folds matches in and out around a stable anchor instead of rebuilding and jumping to the top. A selected row is pinned and collapsed as part of the fold.
            _animateListFilterDeselecting();

            if (isEffectiveSearch) {
                _writeAddress({ view: 'list', q: currentQuery }, false);
                _updateDocTitle();
                searchBox.classList.add('open');
            } else {
                _writeAddress({ view: 'list', ...(activeTag ? { t: activeTag } : {}) }, false);
                _updateDocTitle();
                searchBox.classList.add('open');
            }

            _scheduleTagCloudUpdate(false);
            return;
        }

        if (viewMode === 'grid') {
            // As in the list: a predicate over the kept DOM, the layout from the top.
            searchQuery = isEffectiveSearch ? currentQuery : '';
            searchScores = isEffectiveSearch ? computeSearchScores(currentQuery) : {};
            renderGrid(true);
            _gridScrollToTop();
            _setHashForCurrentState(false);
            _updateDocTitle();
            searchBox.classList.add('open');
            return;
        }

        if (viewMode === 'search') {
            if (isEffectiveSearch) {
                searchQuery = currentQuery;
                searchScores = computeSearchScores(currentQuery);
                triggerAnimation();
                update();
                history.replaceState(null, '', '#q:' + encodeURIComponent(currentQuery));
                _updateDocTitle();
                _scheduleTagCloudUpdate(false);
            } else {
                searchQuery = '';
                searchScores = {};
                switchToMapView(true, true, false);
                _scheduleTagCloudUpdate(true);
            }
        } else if (isEffectiveSearch) {
            switchToSearchView(currentQuery, true);
            _scheduleTagCloudUpdate(true);
        } else {
            searchQuery = '';
            searchScores = {};
            _scheduleTagCloudUpdate(false);
        }
    }, 500);
});

// Open the search box when the input receives focus (e.g. via Tab)
searchInput.addEventListener('focus', () => {
    if (!searchBox.classList.contains('open')) {
        openSearch();
    }
    // Select existing query so it can be replaced
    if (searchInput.value) {
        searchInput.select();
    }
});

// Keep the search box open when focus leaves; reset is handled explicitly via Escape
// or Enter/Return for 0–1 character queries.
searchInput.addEventListener('blur', () => {
    setTimeout(() => {
        // Clean up the focus-held search-has-query when the input is empty
        const q = (searchInput.value || '').trim();
        if (!q) {
            document.body.classList.remove('search-has-query');
            // Not while the input still (or again) has focus.
            if (document.activeElement !== searchInput && searchBox.classList.contains('open')) {
                searchBox.classList.remove('open');
                document.body.classList.remove('search-open');
            }
        }
        _updateCancelButton();
    }, 100);
});

searchInput.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+F while the input is already focused: nothing needs opening, but the browser's native find bar must still be prevented. The window-level handler also does that, but the stopPropagation below keeps the event from reaching it, so handle it here.
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        return;
    }
    // Prevent keyboard navigation while typing
    e.stopPropagation();
    const q = (searchInput.value || '').trim();

    if (e.key === 'Escape') {
        e.preventDefault();
        _flashCancelButton(); // keyboard twin of clicking the ×
        closeSearch();
        return;
    }

    // "#tag" + Enter: if the text after the # matches an existing tag case-insensitively, drop the query and
    // activate that tag instead of a full-text search for the literal string.
    if (e.key === 'Enter' && q.charAt(0) === '#') {
        const match = _resolveTagName(q.slice(1));
        if (match) {
            e.preventDefault();
            _cancel('search.input');
            searchInput.blur();
            if (activeTag === match) {
                // Already active (mobile applies #tag live as you type): don't toggle it off, just reset the query and collapse the box.
                _clearSearchState();
                _syncTagToSearchBox();
                _updateCancelButton();
            } else {
                _toggleTagFilter(match);
            }
            return;
        }
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        if (q.length < 2) {
            closeSearch();
            return;
        }
        // Nothing to submit: the search has been running as you type since the second character, so the results are
        // already behind the keyboard. What Enter can do is hand the screen back, and blurring the field is what
        // dismisses a soft keyboard.
        searchInput.blur();
    }
});

// Prevent search box mousedown from triggering drag
searchBox.addEventListener('mousedown', (e) => {
    e.stopPropagation();
});

// Search cancel button (top-right cross during search view)
const searchCancelBtn = document.getElementById('search-cancel-btn');
function _runSearchCancel(e) {
    e.stopPropagation();

    /* The × is the reset, and an open info panel is part of what there is to reset. It doesn't close on its own
       here: this button stops mousedown from propagating, so the document-level outside-press handler never sees the
       press that reached it. */
    if (_infoOverlayRef && _infoOverlayRef.classList.contains('visible')) hideInfo(false);

    // 0a. A detail opened from the list or the grid closes on its own and nothing else happens.
    if (isMobile && viewMode === 'monad' && _detailPanelPrefix()) {
        // A frame before the leave, so the press state actually paints. Leaving synchronously runs the whole monad exit and the panel rebuild in the same task as the tap, so the button's own feedback and the finished panel arrived together and the × read as dead until it was already over.
        _onFrame('monad.leaveFromCancel', () => {
            if (viewMode === 'monad') _monadLeaveToOrigin();
        });
        return;
    }

    // 0. The grid's selection closes first and quietly, so the filter clearing below writes the one history entry for both.
    const _gridHadSel = (viewMode === 'grid' && !!gridSelectedId);
    if (_gridHadSel) _gridSelect(null, { updateHash: false, scroll: false });
    // The list's selection and filter fold away together, as Escape does.
    if (viewMode === 'list' && listSelectedId && (activeTag || (searchQuery || '').trim() || searchInput.value.trim())) {
        if (searchInput.value.trim() || searchQuery) { _clearSearchState(); searchInput.blur(); }
        if (activeTag) _clearTagFilterState();
        _animateListFilterDeselecting();
        _updateListHash(true, true);
        _updateDocTitle();
        _updateCancelButton();
        _scheduleTagCloudUpdate(true);
        return;
    }

    // Noted before step 1 clears it, for the camera reset at the end.
    const _hadQuery = !!(searchInput.value.trim() || (searchQuery || '').trim());

    // 1. Clear any search query (or close an open-but-empty box, since the × is now the sole close affordance once
    // the box is open).
    if (searchInput.value.trim() || searchQuery || searchBox.classList.contains('open')) {
        searchInput.blur();
        closeSearch();
    }

    // 2. Clear tag filter
    const hadTag = !!activeTag;
    if (activeTag) {
        _clearTagFilterKeepView(true);
    }

    // 3. Clear list selection
    if (viewMode === 'list' && listSelectedId) {
        setListSelection(listSelectedId, false, true, true, true);
    }

    // 3b. Re-render the list when a tag filter was cleared (the map-oriented
    //     _clearTagFilterKeepView does not rebuild the list DOM).
    if (viewMode === 'list' && hadTag) {
        _animateListFilter();
        _updateListHash(true, true);
        _updateDocTitle();
    }
    // (The grid re-renders inside closeSearch and _clearTagFilterKeepView; its selection closed at the top. With nothing else to clear, record the closed selection.)
    if (_gridHadSel && viewMode === 'grid' && !activeTag && !(searchQuery || '').trim()) _setHashForCurrentState(true);

    // 4. Exit monad → wherever it was opened from. On a phone the × IS the close for a detail opened in the list or the grid, so it has to read the hash like every other exit rather than heading straight for the map: that was the close still landing on the map with the right prefix sitting in the address.
    if (viewMode === 'monad') {
        /* The filter was cleared above, but the leave reads where to go from the address, which still carries it
           (#q:…/i:…): left there, the leave re-applied the search it had just cleared, and the × stayed on screen
           over a plain map. */
        if (_hadQuery || hadTag) {
            const a = _parseAddress();
            if (a.i) _writeAddress({ view: a.view, i: a.i }, false);
        }
        _monadLeaveToOrigin();
    }

    // 5. Exit search view → map
    if (viewMode === 'search') {
        switchToMapView();
    }

    /* 6. On a phone, the reset returns the map to its overview rather than only to no filter. */
    if (isMobile && viewMode === 'map' && (hadTag || _hadQuery)) _resetMapCamera();

    _updateCancelButton();
}

/* Two ways in, because on iOS a tap that also dismisses the keyboard often delivers touchend and no click at
   all: the keyboard goes down, the viewport resizes under the finger, and the click is never dispatched to what
   was tapped. */
let _searchCancelTouchT = 0;
searchCancelBtn.addEventListener('touchend', (e) => {
    _searchCancelTouchT = performance.now();
    e.preventDefault();
    _runSearchCancel(e);
}, { passive: false });
searchCancelBtn.addEventListener('click', (e) => {
    if (performance.now() - _searchCancelTouchT < 700) { e.stopPropagation(); return; }
    _runSearchCancel(e);
});

/* ══ RANDOM SHUFFLE ══════════════════════════════════════════════════════════ */


// Shuffle: pick a random item (excluding the current one) and open it. Shared by
// the shuffle button and the Alt/Option+Space shortcut so both behave identically.
function _doShuffle() {
    /* Same reason as the × in _runSearchCancel: every .ui-btn carries a mousedown stopPropagation (see the drag
       guard near the press-feedback block), so the document-level outside-press close never hears this button. */
    if (_infoOverlayRef && _infoOverlayRef.classList.contains('visible')) hideInfo(false);

    // Shuffle picks from the whole collection, so a tag filter or a search goes first, in every view. The views below
    // then build from the unfiltered state, and the address they write carries no filter to come back to.
    const hadFilter = !!activeTag || !!searchInput.value.trim() || !!(searchQuery || '').trim();
    if (activeTag) _clearTagFilterState();
    if (searchInput.value.trim() || (searchQuery || '').trim()) {
        _clearSearchState();   // also drops search-open, which otherwise kept the × on screen
        searchInput.blur();
    }

    // In the grid: select a random card in place.
    if (viewMode === 'grid') {
        if (hadFilter) renderGrid();
        const pool = _gridPlaced.map(p => p.id).filter(id => id !== gridSelectedId);
        const randomId = pool[Math.floor(Math.random() * pool.length)];
        if (!randomId) return;
        // A phone opens the shared detail rather than expanding the card, as a tap does: the branch below does the same for the list. Both filters have just been cleared, so the hash is the bare panel plus the new id.
        if (isMobile) { _openMobileItemDetail(randomId, 'grid'); return; }
        _gridSelect(randomId, { scroll: 'center', animate: !isMobile });
        return;
    }

    // In list mode: pick a random item from the full chronological list
    if (viewMode === 'list') {
        listSelectedId = null;

        // Mobile: reset scroll to 0 BEFORE rendering, or the user sees a jump from the old scrollTop to the new selection that iOS Safari can render as animated motion. Snapping only ever runs 0 to target, with the row's resolution work hidden behind body.list-instant.
        if (isMobile) {
            window.scrollTo(0, 0);
            document.body.classList.add('list-instant');
        }

        renderList();

        const pool = (listOrderIds && listOrderIds.length) ? listOrderIds : items.map(i => i.id);
        const randomId = pool[Math.floor(Math.random() * pool.length)];
        // A phone opens the shared detail rather than expanding the row in place, as a tap does.
        if (isMobile && randomId) { _openMobileItemDetail(randomId, 'list'); return; }
        // Shuffle, the same case as a hash jump: nowhere the reader was, so centre what they land on.
        if (randomId) setListSelection(randomId, true, true, true, true, 'center');
        return;
    }

    // Map / search / monad: pick a random item for monad view (excluding current)
    const candidates = selectedMonadId
        ? items.filter(i => i.id !== selectedMonadId)
        : items;
    const randomItem = candidates[Math.floor(Math.random() * candidates.length)];
    if (!randomItem) return;
    // Only a detail opened from the list or the grid (_detailPanelPrefix also answers 'map' for an item on the map).
    const _panel = _detailPanelPrefix();
    if (isMobile && (_panel === 'grid' || _panel === 'list')) {
        const hash = _viewAddress(_panel, { i: randomItem.id });
        if (window.location.hash !== hash) history.pushState(null, '', hash);
        _enterMobileItemDetail(randomItem.id, true);
        return;
    }
    switchToMonadView(randomItem.id, true, true, true);
}
/* ══ SHUFFLE WALK ════════════════════════════════════════════════════════════
   The shuffle held down rather than pressed once: a new item opens every few seconds and the atlas reads itself
   out to someone who is not driving it. Shift+R, or a shift-click on the shuffle button, and the button stays
   inverted for the length of it, because the thing the press started has not ended.
   Map side only. The list and the grid reach a selection by moving the reader's own scroll position, which is not
   something to do to them every few seconds unasked; the map simply opens an item where it stands.
   It ends on Escape, on the button again, and on any other press anywhere in the interface. The pointer moving,
   an item answering a hover, the text being scrolled: none of those is a decision, so none of them ends it. */

const SHUFFLE_WALK_STEP_MS = 10000;  // how long each item is held: long enough to read what opened
/* What the button says while Shift is down, so the modifier announces the walk rather than the reader having to
   know it is there. */
const SHUFFLE_TITLE = 'Random item (R)';
const SHUFFLE_WALK_TITLE = 'Random item walk (⇧ R)';
let _walkOn = false;

/** Readable by map.js, which asks before writing the address: see the pushState in switchToMonadView. */
function _walkRunning() { return _walkOn; }

/** The map and its two states. A panel view is not one, and switching into one ends the walk. */
function _walkEligible() {
    return viewMode === 'map' || viewMode === 'monad' || viewMode === 'search';
}

function _walkStep() {
    if (!_walkOn) return;
    if (!_walkEligible()) { _walkStop(); return; }
    _doShuffle();
    _after('walk.step', _walkStep, SHUFFLE_WALK_STEP_MS);
}

function _walkStart() {
    if (_walkOn || !_walkEligible()) return;
    _walkOn = true;
    /* The button turns once per item, and the two start together: one figure drives both, so the glyph coming back
       round is the cue that the next item is due rather than a decoration that happens to be nearby. */
    document.documentElement.style.setProperty('--walk-step', (SHUFFLE_WALK_STEP_MS / 1000) + 's');
    document.body.classList.add('walk-running');
    _walkStep();   // the first item at once, so the shortcut answers in the same press
}

function _walkStop() {
    if (!_walkOn) return;
    _walkOn = false;
    _cancel('walk.step');
    document.body.classList.remove('walk-running');
}

function _walkToggle() { if (_walkOn) _walkStop(); else _walkStart(); }

/* Shift held is the walk offered: the button says so while the modifier is down, and says what it normally does
   the moment it comes up. Read off the event rather than tracked, so a Shift released over another window, or a
   press that never reached us, cannot leave the wrong label behind; the blur is the same guard for a window that
   goes away mid-press. */
function _walkSyncShuffleTitle(down) {
    const el = document.getElementById('shuffle-btn');
    if (!el) return;
    const want = down ? SHUFFLE_WALK_TITLE : SHUFFLE_TITLE;
    if (el.getAttribute('title') !== want) el.setAttribute('title', want);
}
window.addEventListener('keydown', (e) => _walkSyncShuffleTitle(!!e.shiftKey));
window.addEventListener('keyup', (e) => _walkSyncShuffleTitle(!!e.shiftKey));
window.addEventListener('blur', () => _walkSyncShuffleTitle(false));

/* Any press ends it, wherever it lands — including the one that is about to do something else, which still does it.
   Capture, so a handler that stops propagation cannot keep the walk running behind its own click. The shuffle
   button is exempt because its own handler decides: while the walk runs, a press there is the stop. */
document.addEventListener('pointerdown', (e) => {
    if (!_walkOn) return;
    const t = e.target;
    if (t && t.closest && t.closest('#shuffle-btn')) return;
    _walkStop();
}, true);

document.getElementById('shuffle-btn').addEventListener('click', (e) => {
    if (_walkOn) { _walkStop(); return; }
    if (e.shiftKey) { _walkStart(); return; }
    _doShuffle();
});

/* ══ VIEW SWITCHER ═══════════════════════════════════════════════════════════ */
/** Mark the view switcher's current segment (active class and aria-pressed). */
function _syncViewSwitcher() {
    const btn = document.getElementById('mode-btn');
    if (!btn) return;
    const cur = _currentViewSeg();
    btn.querySelectorAll('.view-seg').forEach((seg) => {
        const on = seg.getAttribute('data-view') === cur;
        seg.classList.toggle('active', on);
        seg.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

const modeBtn = document.getElementById('mode-btn');

/** Switch to a view from the switcher or the 1/2/3 keys. The list and the map keep their bridged transitions between each other; the grid's switches use the rect bridge in direct mode. */
function _switchViewTo(target) {
    const cur = _currentViewSeg();
    if (!target || target === cur) return;
    // A selection scrolled out of view is not carried: taking it into the next view (its monad, its list row, its grid card) would open something the reader no longer has in front of them.
    _dropSelectionOutOfView();
    if (target === 'grid') {
        _gridRectSwitch(() => switchToGridView(true, true));
        return;
    }
    if (cur === 'grid') {
        if (target === 'list') {
            _gridRectSwitch(() => switchToListView(true, true));
            return;
        }
        // To the map side: a selection opens its monad, as from the list; otherwise a query typed in the grid goes to the search view.
        const sel = gridSelectedId;
        const q = (searchQuery || '').trim();
        _gridRectSwitch(() => _openMapSide(sel, q));
        return;
    }
    if (cur === 'list') {
        _listToMain();
        return;
    }
    _mainToList();
}

if (modeBtn) {
    modeBtn.addEventListener('click', (e) => {
        const seg = e.target.closest('.view-seg');
        if (!seg) return;
        e.stopPropagation();
        _switchViewTo(seg.getAttribute('data-view'));
    });
    _syncViewSwitcher();
}

/* ══ LIGHTBOX ══════════════════════════════════════════════════════════════
   The full-size image over any view: opened from the monad centre, a list thumbnail or a grid card (and from an
   address ending in /image, see "The lightbox in the address" in core.js), with pan, wheel and pinch zoom, and
   zoom-out or drag to close. */

// ── Image lightbox ──
const lightboxEl = document.getElementById('lightbox');
let lightboxOpen = false;
let _lightboxClone = null;
let _lightboxSourceImg = null;

// Pan + zoom state for lightbox
let _lbPanning = false;
let _lbPanStartX = 0, _lbPanStartY = 0;
let _lbOffsetX = 0, _lbOffsetY = 0;
let _lbStartOffsetX = 0, _lbStartOffsetY = 0;
let _lbMaxPanX = 0, _lbMaxPanY = 0;
let _lbDidPan = false;
let _lbImageFits = false;
let _lbZoom = 1, _lbMinZoom = 1, _lbMaxZoom = 1.5;
let _lbNatW = 0, _lbNatH = 0;
let _lbCx = 0, _lbCy = 0; // element center (fixed)

// Drag-to-dismiss (mobile, at fitted zoom): with regular pan disabled because the image already fits, the image
// follows the finger vertically in either direction, shrinks with the absolute distance, and closes past ~15% of
// viewport height.
let _lbDragDismiss = false;
let _lbDDStartX = 0, _lbDDStartY = 0;
// Absolute vertical finger distance for the gesture, used by touchend to decide close versus snap-back: distinct from _lbOffsetY, since the image is dampened to ~60% of the finger and the decision should follow what the user did.
let _lbDDFingerY = 0;
// 15vh, set per gesture in touchstart so rotation between gestures gets a fresh value; module-level so touchmove and touchend share it.
let _lbDDCloseDistance = 0;

// Suppress the synthetic click browsers fire after touchend: set once touchend has processed a tap or drag-dismiss, read and cleared by the click handler. Without it a single tap toggles twice and nets to nothing.
let _lbSuppressNextClick = false;

// Pinch state
let _lbPinching = false;
let _lbPinchStartDist = 0;
let _lbPinchStartZoom = 1;
let _lbPinchMidX = 0, _lbPinchMidY = 0;
let _lbPinchStartOffsetX = 0, _lbPinchStartOffsetY = 0;


// Allow pulling the lightbox image *under* its fitted min zoom, to enable a zoom-out-to-close gesture.
const _LB_UNDER_MIN_FACTOR = 0.6; // can shrink to 60% of fitted size
const _LB_CLOSE_THRESHOLD = 0.75; // release below 75% of fitted size to close

/* ── Opening, pan and zoom, closing ── */

/** Helper: lb maybe dismiss on release. */
function _lbMaybeDismissOnRelease(clone) {
    if (!lightboxOpen) return;
    if (!_lightboxClone || clone !== _lightboxClone) return;

    const closeBelow = _lbMinZoom * _LB_CLOSE_THRESHOLD;

    // If the user released while noticeably under 100% (fitted), close the lightbox.
    if (_lbZoom < closeBelow) {
        closeLightbox();
        return;
    }

    // Otherwise, if they just dipped slightly under, gently snap back to 100% (fitted).
    if (_lbZoom < _lbMinZoom) {
        _lbZoomToward(_lbCx, _lbCy, _lbMinZoom, clone);
    }
}

/** Helper: lb update bounds. */
function _lbUpdateBounds() {
    // Allow pointer-anchored zoom even when the image is smaller than the viewport (zoom < fitted size).
    // When smaller, we allow offsets within the available "letterbox" margin so the zoom origin stays under the cursor.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    _lbMaxPanX = Math.abs((_lbNatW * _lbZoom - vw) / 2);
    _lbMaxPanY = Math.abs((_lbNatH * _lbZoom - vh) / 2);
    _lbImageFits = (_lbNatW * _lbZoom <= vw && _lbNatH * _lbZoom <= vh);
}

/** Helper: lb clamp offset. */
function _lbClampOffset() {
    // When the image fits the viewport, force it centred: _lbMaxPanX/Y otherwise allow a letterbox pan budget so the zoom origin can track the cursor, which can leave the image off-centre after zooming back out.
    if (_lbImageFits) {
        _lbOffsetX = 0;
        _lbOffsetY = 0;
        return;
    }
    _lbOffsetX = Math.max(-_lbMaxPanX, Math.min(_lbMaxPanX, _lbOffsetX));
    _lbOffsetY = Math.max(-_lbMaxPanY, Math.min(_lbMaxPanY, _lbOffsetY));
}

/** Helper: lb exit cue t. */
function _lbExitCueT() {
    // 0 at fitted size (100%), 1 at the close threshold (e.g. 75%).
    if (!_lbMinZoom) return 0;
    const closeBelow = _lbMinZoom * _LB_CLOSE_THRESHOLD;

    if (_lbZoom >= _lbMinZoom) return 0;
    const denom = Math.max(1e-6, _lbMinZoom - closeBelow);
    return _clamp01((_lbMinZoom - _lbZoom) / denom);
}


// Lightbox exit cues: fade in only the UI controls actually visible behind the lightbox, so overlapping controls (search loupe plus cancel cross) don't blend.
const _LB_CUE_IDS = ['info-btn','shuffle-btn','mode-btn','search-box','search-cancel-btn','share-btn'];

/** Helper: lb clear exit cue targets. */
function _lbClearExitCueTargets() {
    for (const id of _LB_CUE_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.remove('lb-exit-cue-target');
        el.classList.remove('lb-exit-hide');
    }
}

/** Helper: lb is element visually active. */
function _lbIsElementVisuallyActive(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.pointerEvents === 'none') return false;
    const op = parseFloat(cs.opacity || '1');
    if (!Number.isFinite(op) || op < 0.05) return false;
    // offset* catches zero-size and detached nodes
    if ((el.offsetWidth || 0) < 2 || (el.offsetHeight || 0) < 2) return false;
    return true;
}

/** Helper: lb set exit cue targets. */
function _lbSetExitCueTargets() {
    _lbClearExitCueTargets();

    const body = document.body;

    // Top-right: pick exactly ONE control.
    // The cancel button is considered "active" in search view, or when a query is present (except in monad view).
    const cancelShouldBeActive =
        body.classList.contains('search-view') ||
        (body.classList.contains('search-has-query') && !body.classList.contains('monad-view'));

    const cancelBtn = document.getElementById('search-cancel-btn');

    if (cancelShouldBeActive && cancelBtn) {
        cancelBtn.classList.add('lb-exit-cue-target');
        searchBox.classList.add('lb-exit-hide');
    } else {
        searchBox.classList.add('lb-exit-cue-target');
        if (cancelBtn) cancelBtn.classList.add('lb-exit-hide');
    }

    // The share button has nothing to do over the lightbox.
    shareBtn.classList.add('lb-exit-hide');

    // Other visible UI buttons (corners / helpers)
    for (const id of ['info-btn','shuffle-btn','mode-btn']) {
        const el = document.getElementById(id);
        if (_lbIsElementVisuallyActive(el)) el.classList.add('lb-exit-cue-target');
    }
}

/** Helper: lb update exit cue. */
function _lbUpdateExitCue(t) {
    // Drives UI fade-in while the user "pulls" the image under 100%.
    document.body.style.setProperty('--lb-exit', (Number.isFinite(t) ? t : 0).toFixed(3));
}

/** Helper: lb apply transform. */
function _lbApplyTransform(clone) {
    const t = _lbExitCueT();

    // Standard lightbox behavior: zoom/pan around the current offsets,
    // while allowing temporary zoom-out under 100% for the pull-to-close gesture.
    clone.style.transform = `translate(${_lbOffsetX}px, ${_lbOffsetY}px) scale(${_lbZoom})`;

    // Fade in corner UI as an exit cue (0 at 100%, 1 at the close threshold).
    if (lightboxOpen) _lbUpdateExitCue(t);
}
/** Helper: lb update cursor. */
function _lbUpdateCursor(clone) {
    clone.classList.toggle('fits', _lbImageFits);
}

/** Start a pan from a pointer position. */
function _lbBeginPan(x, y, clone) {
    _lbPanning = true;
    _lbPanStartX = x;
    _lbPanStartY = y;
    _lbStartOffsetX = _lbOffsetX;
    _lbStartOffsetY = _lbOffsetY;
    clone.classList.add('panning');
}

/** Follow a pan to a pointer position. More than 3px either way counts as a pan rather than a click. */
function _lbPanTo(x, y, clone) {
    const dx = x - _lbPanStartX;
    const dy = y - _lbPanStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _lbDidPan = true;
    _lbOffsetX = _lbStartOffsetX + dx;
    _lbOffsetY = _lbStartOffsetY + dy;
    _lbClampOffset();
    _lbApplyTransform(clone);
}

/** Apply a new zoom whose offsets are already set. */
function _lbCommitZoom(newZoom, clone) {
    _lbZoom = newZoom;
    _lbUpdateBounds();
    _lbClampOffset();
    _lbApplyTransform(clone);
    _lbUpdateCursor(clone);
}

// Zoom toward a viewport point (px, py)
function _lbZoomToward(px, py, newZoom, clone) {
    const oldZoom = _lbZoom;
    const hardMin = _lbMinZoom * _LB_UNDER_MIN_FACTOR;
    newZoom = Math.max(hardMin, Math.min(_lbMaxZoom, newZoom));
    if (newZoom === oldZoom) return;
    const ratio = newZoom / oldZoom;
    _lbOffsetX = (px - _lbCx) * (1 - ratio) + _lbOffsetX * ratio;
    _lbOffsetY = (py - _lbCy) * (1 - ratio) + _lbOffsetY * ratio;
    _lbCommitZoom(newZoom, clone);
    // Keep the at-max class in sync with the zoom level. The cursor is zoom-out by default now, so this class no longer drives it and is retained only as a state hook for the zoomed-in level.
    if (clone) {
    }
}


// Compute an <img>'s actually visible content rectangle from its intrinsic ratio and current object-fit / object-position, so letterboxed boxes (fixed 4:3 list slots) don't produce squash artefacts.
function _objPosFrac(tok) {
    tok = (tok || '').trim().toLowerCase();
    if (!tok) return 0.5;
    if (tok.endsWith('%')) {
        const v = parseFloat(tok);
        return isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.5;
    }
    if (tok === 'left' || tok === 'top') return 0;
    if (tok === 'right' || tok === 'bottom') return 1;
    if (tok === 'center') return 0.5;
    // px values are rare here; treat as center.
    return 0.5;
}

/** Get fitted img rect. */
function _getFittedImgRect(img, natW, natH) {
    const r = img.getBoundingClientRect();
    const boxW = r.width, boxH = r.height;
    if (!boxW || !boxH || !natW || !natH) return r;

    const cs = getComputedStyle(img);
    const fit = (cs.objectFit || '').trim();
    if (!fit || fit === 'fill') return r;

    const ar = natW / natH;
    const boxAr = boxW / boxH;

    let w = boxW, h = boxH;

    if (fit === 'contain' || fit === 'scale-down') {
        if (ar > boxAr) { w = boxW; h = boxW / ar; }
        else { h = boxH; w = boxH * ar; }
    } else if (fit === 'cover') {
        if (ar > boxAr) { h = boxH; w = boxH * ar; }
        else { w = boxW; h = boxW / ar; }
    } else {
        return r;
    }

    const pos = (cs.objectPosition || '50% 50%').trim().split(/\s+/);
    const fx = _objPosFrac(pos[0]);
    const fy = _objPosFrac(pos[1] || pos[0]);

    const extraX = boxW - w;
    const extraY = boxH - h;

    return {
        left: r.left + extraX * fx,
        top: r.top + extraY * fy,
        width: w,
        height: h
    };
}


/** Open lightbox from image. */
function openLightboxFromImage(srcImg, natW, natH) {
    if (!srcImg) return;

    natW = natW || srcImg.naturalWidth;
    natH = natH || srcImg.naturalHeight;
    if (!natW || !natH) return;

    // An open during a close's landing (Back then Forward, say): finish that close now. Its timer would otherwise be
    // cancelled below with the old clone still in the page. No purge: this image is about to be shown large.
    if (_lightboxClone && !lightboxOpen) {
        _cancel('lightbox.close');
        _lbFinishClose(_lightboxClone, _lightboxSourceImg, false);
    }

    // Use the actually visible content rect (accounts for object-fit letterboxing in list thumbnails)
    const rect = _getFittedImgRect(srcImg, natW, natH);
    // Opens also when the image is already on screen at (or beyond) its native size: the lightbox is for looking at it on its own and into its pixels, not only for enlarging.

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    _lbNatW = natW;
    _lbNatH = natH;

    // Element is placed at native size, centered
    const targetLeft = (vw - natW) / 2;
    const targetTop = (vh - natH) / 2;
    _lbCx = targetLeft + natW / 2;
    _lbCy = targetTop + natH / 2;


    // Min zoom = fit in viewport; max = 1.5× native resolution. The max is set afresh on every open: a smaller file's correction below lowers it, and that must not carry over to the next image.
    _lbMinZoom = Math.min(1, Math.min(vw / natW, vh / natH));
    _lbMaxZoom = 1.5;
    _lbZoom = _lbMinZoom;
    _lbOffsetX = 0;
    _lbOffsetY = 0;
    _lbDidPan = false;
    _lbPinching = false;
    _lbUpdateBounds();

    // Create clone at native size: start from whatever the source already shows
    // so the scale-up animation is seamless, then confirm the full image below.
    const clone = document.createElement('img');
    clone.id = 'lightbox-img';
    const _lbId = _inferImgId(srcImg);
    // Always start from whatever the source image currently shows. A selection is
    // already at 'l', so this is usually the final image and the preload below is
    // a cache hit; opening straight off the map it can still be the inline 's'.
    clone.src = srcImg.currentSrc || srcImg.src;
    clone.removeAttribute('srcset');
    clone.removeAttribute('sizes');
    if (_lbId) {
        clone.dataset.id = _lbId;
        clone.dataset.tier = _imgTier(srcImg);
        // Load the full-size image and swap when ready. Even when the src is
        // already it, this pass is worth running: its onload is where the zoom
        // limits get corrected against the file's real natural size (see below).
        const largeSrc = _imgUrl(_lbId);
        const preload = new Image();
        preload.onload = () => {
            // Only swap if this lightbox instance is still open and clone is still ours.
            if (lightboxOpen && _lightboxClone === clone) {
                clone.src = largeSrc;
                clone.dataset.tier = 'l';

                // The cached _lbNatW/_lbNatH reflect theoretical large-tier dimensions, always upscaled to the cap, but the file on disk may be smaller. Cap min and max zoom by the real natural size so a small image isn't upscaled past its native resolution.
                const realW = preload.naturalWidth;
                const realH = preload.naturalHeight;
                if (realW > 0 && realH > 0 && _lbNatW > 0 && _lbNatH > 0) {
                    const naturalFrac = Math.min(realW / _lbNatW, realH / _lbNatH);
                    // Only tighten (never loosen) and only if meaningfully different.
                    if (naturalFrac < 0.999) {
                        const vw = window.innerWidth;
                        const vh = window.innerHeight;
                        const prevMin = _lbMinZoom;
                        const fitFrac = Math.min(vw / _lbNatW, vh / _lbNatH);
                        _lbMinZoom = Math.min(naturalFrac, fitFrac);
                        _lbMaxZoom = Math.max(_lbMinZoom, naturalFrac * 1.5);
                        // If the user hasn't manually zoomed, snap to the corrected minimum and re-render (the CSS transform transition smooths the shrink); if they were already past the new maximum, clamp down to it.
                        if (Math.abs(_lbZoom - prevMin) < 1e-4) {
                            _lbZoom = _lbMinZoom;
                            _lbOffsetX = 0;
                            _lbOffsetY = 0;
                            _lbUpdateBounds();
                            _lbApplyTransform(clone);
                            _lbUpdateCursor(clone);
                        } else if (_lbZoom > _lbMaxZoom) {
                            _lbZoom = _lbMaxZoom;
                            _lbUpdateBounds();
                            _lbClampOffset();
                            _lbApplyTransform(clone);
                            _lbUpdateCursor(clone);
                        }
                    }
                }
            }
        };
        preload.src = largeSrc;
    }
    clone.draggable = false;

    clone.style.left = targetLeft + 'px';
    clone.style.top = targetTop + 'px';
    clone.style.width = natW + 'px';
    clone.style.height = natH + 'px';

    _lbUpdateCursor(clone);

    // Start at original's position via scale + translate
    const initialScale = rect.width / natW;
    const srcCx = rect.left + rect.width / 2;
    const srcCy = rect.top + rect.height / 2;
    clone.style.transform = `translate(${srcCx - _lbCx}px, ${srcCy - _lbCy}px) scale(${initialScale})`;

    // Append to body (not inside #lightbox) so clone opacity is independent of backdrop
    document.body.appendChild(clone);
    _lightboxClone = clone;

    // Hide source image to avoid double-rendering during backdrop fade
    _lightboxSourceImg = srcImg;
    if (srcImg && srcImg.dataset) {
        if (srcImg.dataset._lbPrevOpacity === undefined) srcImg.dataset._lbPrevOpacity = (srcImg.style.opacity || '');
        srcImg.style.opacity = '0';
    }

    document.body.classList.add('lightbox-active');
    // A re-open inside a close would otherwise inherit the closing state and leave the text visible under the backdrop.
    document.body.classList.remove('lightbox-closing');
    document.body.style.setProperty('--lb-exit', '0');
    _lbSetExitCueTargets();
    lightboxEl.classList.add('visible');
    lightboxOpen = true;
    _cancel('lightbox.close');
    _pushImageAddress(srcImg);

    // Force browser to render initial state before animating
    _reflow(clone);

    setTimeout(() => {
        clone.style.transform = `translate(0, 0) scale(${_lbZoom})`;
    }, 0);

    // ── Mouse: pan ──
    clone.addEventListener('mousedown', (e) => {
        // Touch devices fire synthetic mouse events after touchend. Ignoring the synthetic mousedown matters because it would add `panning`, disabling the CSS transition and snapping the in-flight tap-toggle animation to its end state.
        if (_lbSuppressNextClick) return;
        if (!_lbImageFits) {
            _lbDidPan = false;
            _lbBeginPan(e.clientX, e.clientY, clone);
        }
        e.stopPropagation();
        e.preventDefault();
    });

    const onMouseMove = (e) => {
        if (!_lbPanning) return;
        _lbPanTo(e.clientX, e.clientY, clone);
    };

    const onMouseUp = () => {
        if (_lbPanning) {
            _lbPanning = false;
            clone.classList.remove('panning');
        }
        _lbMaybeDismissOnRelease(clone);
    };

    clone._lbMouseMove = onMouseMove;
    clone._lbMouseUp = onMouseUp;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // ── Mouse: scroll to zoom ──
    const onWheel = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const delta = -e.deltaY * 0.001;
        const factor = 1 + delta * (1 + _lbZoom * 2);
        clone.classList.add('panning'); // disable transition during scroll zoom
        // Show zoom-in or zoom-out cursor while actively scrolling
        if (delta > 0) {
            clone.classList.add('lb-zoom-in-cursor');
            clone.classList.remove('lb-zoom-out-cursor');
        } else {
            clone.classList.add('lb-zoom-out-cursor');
            clone.classList.remove('lb-zoom-in-cursor');
        }
        _lbZoomToward(e.clientX, e.clientY, _lbZoom * factor, clone);
        // Re-enable transition after a brief pause
        clearTimeout(clone._lbWheelTimer);
        clone._lbWheelTimer = setTimeout(() => {
            if (!_lbPanning) clone.classList.remove('panning');
            clone.classList.remove('lb-zoom-in-cursor', 'lb-zoom-out-cursor');
            _lbMaybeDismissOnRelease(clone);
        }, 45);
};

    clone._lbWheel = onWheel;
    clone.addEventListener('wheel', onWheel, { passive: false });

    // Clicking the image never zooms in: scrolled in past fitted size it returns to fitted, already fitted it closes. Zooming in is the wheel's job, the backdrop closes separately, and _lbDidPan suppresses the action after a real pan.
    clone.addEventListener('click', (e) => {
        // Touch devices fire a synthetic click after touchend, so if touchend already processed the tap it sets _lbSuppressNextClick: read and cleared here. Without it a single mobile tap toggles twice and nets to nothing.
        if (_lbSuppressNextClick) {
            _lbSuppressNextClick = false;
            e.stopPropagation();
            return;
        }
        if (_lbDidPan) {
            _lbDidPan = false;
            return;
        }
        // Stop propagation so the lightboxEl backdrop click handler
        // doesn't ALSO fire and close the lightbox.
        e.stopPropagation();
        // A click never zooms in: past fitted size it returns there, at fitted size it closes, matching the zoom-out cursor and backdrop dismissal. The 1.05 tolerance absorbs slight drift past _lbMinZoom.
        if (_lbZoom > _lbMinZoom * 1.05) {
            // Anchor at the element centre so the image lands centred, as when freshly opened; _lbZoomToward updates bounds and transform through its animation path, and at fitted size the offsets clamp back to centre.
            _lbZoomToward(_lbCx, _lbCy, _lbMinZoom, clone);
        } else {
            closeLightbox();
        }
    });

    // ── Touch: pan + pinch ──
    clone.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            // Start pinch
            _lbPanning = false;
            _lbPinching = true;
            _lbDragDismiss = false; // pinch overrides drag-dismiss
            _lbDidPan = true; // suppress tap-to-close
            const t0 = e.touches[0], t1 = e.touches[1];
            _lbPinchStartDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            _lbPinchStartZoom = _lbZoom;
            _lbPinchMidX = (t0.clientX + t1.clientX) / 2;
            _lbPinchMidY = (t0.clientY + t1.clientY) / 2;
            _lbPinchStartOffsetX = _lbOffsetX;
            _lbPinchStartOffsetY = _lbOffsetY;
            clone.classList.add('panning');
        } else if (e.touches.length === 1 && !_lbPinching) {
            if (!_lbImageFits) {
                // Start pan (image larger than viewport: standard pan)
                _lbDidPan = false;
                _lbBeginPan(e.touches[0].clientX, e.touches[0].clientY, clone);
            } else {
                // Start drag-dismiss tracking (the image fits, so it can't pan). Not committed until touchmove sees a clear downward motion: before that the touch should still resolve as a tap on touchend.
                _lbDragDismiss = true;
                _lbDidPan = false;
                _lbDDStartX = e.touches[0].clientX;
                _lbDDStartY = e.touches[0].clientY;
                _lbDDFingerY = 0;
                // Close distance scales with the viewport (15vh, ~120px on a typical phone). Both the shrink ramp and the close trigger derive from it, so a shorter value shrinks sooner and dismisses on a shorter swipe.
                _lbDDCloseDistance = window.innerHeight * 0.15;
            }
        }
        e.stopPropagation();
    }, { passive: true });

    clone.addEventListener('touchmove', (e) => {
        if (_lbPinching && e.touches.length === 2) {
            const t0 = e.touches[0], t1 = e.touches[1];
            const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            const hardMin = _lbMinZoom * _LB_UNDER_MIN_FACTOR;
            const newZoom = Math.max(hardMin, Math.min(_lbMaxZoom, _lbPinchStartZoom * (dist / _lbPinchStartDist)));
            const midX = (t0.clientX + t1.clientX) / 2;
            const midY = (t0.clientY + t1.clientY) / 2;

            // Zoom toward the original pinch midpoint
            const ratio = newZoom / _lbPinchStartZoom;
            _lbOffsetX = (_lbPinchMidX - _lbCx) * (1 - ratio) + _lbPinchStartOffsetX * ratio;
            _lbOffsetY = (_lbPinchMidY - _lbCy) * (1 - ratio) + _lbPinchStartOffsetY * ratio;

            // Also allow panning by tracking midpoint drift
            _lbOffsetX += midX - _lbPinchMidX;
            _lbOffsetY += midY - _lbPinchMidY;

            _lbCommitZoom(newZoom, clone);
            e.preventDefault();
            e.stopPropagation();
        } else if (_lbPanning && e.touches.length === 1) {
            _lbPanTo(e.touches[0].clientX, e.touches[0].clientY, clone);
            e.preventDefault();
            e.stopPropagation();
        } else if (_lbDragDismiss && e.touches.length === 1) {
            // Drag-dismiss: with the image fitting the viewport, a vertical drag in either direction follows the finger and
            // shrinks the image toward the close threshold; past it on release the lightbox closes, otherwise it snaps back.
            const dx = e.touches[0].clientX - _lbDDStartX;
            const dy = e.touches[0].clientY - _lbDDStartY;
            const DEAD_ZONE = 3;
            const absDy = Math.abs(dy);
            // Below the dead zone, don't move the image and don't preventDefault, so a tap-toggle resolves cleanly from a clean rest position.
            if (Math.abs(dx) < DEAD_ZONE && absDy < DEAD_ZONE) return;
            // First crossing: disable CSS transition so the transform
            // follows the finger directly without animation lag.
            if (!_lbDidPan) {
                _lbDidPan = true;
                clone.classList.add('panning');
            }
            _lbDDFingerY = absDy; // record for touchend close check
            // Drag progress from 0 to 1 at the close threshold, measured on the absolute finger distance so "15vh in either direction" is the criterion, independent of the dampened visual offset.
            const _t = Math.min(1, absDy / _lbDDCloseDistance);
            // Dampened follow at 60% of the finger's travel, so the image resists slightly rather than snapping to it. The vertical offset preserves the finger's sign, so it moves the way the user pulls.
            const FOLLOW_RATE = 0.6;
            _lbOffsetX = dx * FOLLOW_RATE;
            _lbOffsetY = dy * FOLLOW_RATE;
            // Shrink up to 40% toward the close threshold, so the impending close is clear at a glance; the shrink also fades in the exit-cue backdrop UI via _lbExitCueT.
            _lbZoom = _lbMinZoom * (1 - _t * 0.4);
            _lbUpdateBounds();
            _lbApplyTransform(clone);
            e.preventDefault();
            e.stopPropagation();
        }
    }, { passive: false });

    clone.addEventListener('touchend', (e) => {
        if (_lbPinching) {
            if (e.touches.length < 2) {
                _lbPinching = false;
                clone.classList.remove('panning');
                // If one finger remains, start panning from it
                if (e.touches.length === 1 && !_lbImageFits) {
                    _lbBeginPan(e.touches[0].clientX, e.touches[0].clientY, clone);
                }
            }
            // On iOS, "pinch release" often ends in touchend (not touchmove). Decide close here.
            if (e.touches.length === 0) _lbMaybeDismissOnRelease(clone);
            e.stopPropagation();
            return;
        }
        if (_lbPanning) {
            _lbPanning = false;
            clone.classList.remove('panning');
        }
        // Drag-dismiss release: past the close distance, close; a shorter but real drag (_lbDidPan set) snaps back. A pure tap with _lbDragDismiss armed but _lbDidPan false falls through to the tap-toggle below.
        if (_lbDragDismiss && _lbDidPan) {
            // The close decision uses the raw finger distance, not the dampened image offset: intent is best measured by what the finger did, and the slower follow rate is purely visual.
            const droppedFar = (_lbDDFingerY >= _lbDDCloseDistance);
            _lbDragDismiss = false;
            // Re-enable transitions: `panning` was added during touchmove so the transform tracked the finger without lag, but snap-back and close should animate.
            clone.classList.remove('panning');
            // Always suppress the synthetic click after touchend, or it arrives after closeLightbox() or the snap-back and tries to toggle zoom or hit the backdrop close.
            _lbSuppressNextClick = true;
            if (droppedFar) {
                // The image's current translated and shrunk position is the visible starting point for the close animation in closeLightbox().
                closeLightbox();
            } else {
                // Snap back through the clone's existing CSS transform transition so the recovery animates.
                _lbSnapBack(clone);
            }
            _lbDidPan = false;
            e.stopPropagation();
            return;
        }
        // Clear the armed flag for pure-tap cases: the drag-dismiss
        // never engaged, the user just tapped.
        _lbDragDismiss = false;
        // Tap with no pan or pinch, mirroring the desktop click handler: past fitted size it returns to fitted, at
        // fitted size it closes. Zooming in is pinch's job; the backdrop and a drag past the close distance also
        // dismiss.
        if (!_lbDidPan && e.changedTouches.length) {
            // Reset any sub-commit drag offset from the pre-commit hint phase, which would otherwise persist into the zoom-out animation.
            if (_lbOffsetX !== 0 || _lbOffsetY !== 0) {
                _lbOffsetX = 0;
                _lbOffsetY = 0;
            }
            if (_lbZoom > _lbMinZoom * 1.05) {
                // Pinched in: return to fitted size, centered.
                _lbZoomToward(_lbCx, _lbCy, _lbMinZoom, clone);
            } else {
                // Already fitted: a tap dismisses the lightbox.
                closeLightbox();
            }
            _lbSuppressNextClick = true;
        }
        _lbDidPan = false;
        if (e.touches.length === 0) _lbMaybeDismissOnRelease(clone);
        e.stopPropagation();
    });

    clone.addEventListener('touchcancel', (e) => {
        _lbPanning = false;
        _lbPinching = false;
        // Always re-enable transitions on touchcancel, and do it BEFORE any snap-back transform write so the recovery animates rather than snapping.
        clone.classList.remove('panning');
        // A drag-dismiss in progress snaps back rather than closing: touchcancel usually means a system gesture (notification swipe), not an intentional release.
        if (_lbDragDismiss) {
            _lbDragDismiss = false;
            _lbSnapBack(clone);
        }
        if (e && e.touches && e.touches.length === 0) _lbMaybeDismissOnRelease(clone);
    });
}


/** Return the lightbox image to its fitted, centred resting state. The clone
 *  keeps its transform transition, so this animates rather than jumping. */
function _lbSnapBack(clone) {
    _lbOffsetX = 0;
    _lbOffsetY = 0;
    _lbZoom = _lbMinZoom;
    _lbUpdateBounds();
    _lbApplyTransform(clone);
    _lbUpdateExitCue(0);
}

/** Open lightbox unified. */
function openLightboxUnified(srcImg, idHint) {
    if (!srcImg) return;

    const id = ((idHint || (srcImg.dataset && srcImg.dataset.id) || _inferImgId(srcImg) || '') + '').trim();

    // Don't open lightbox for solid-color placeholder images
    const item = id && _getTagItemById()[id];
    if (item && item._isPlaceholderImg) return;

    // Prefer nat-w/h set on map/monad articles (these point to the large-tier native size),
    // but treat them as a hint only: we may need to refresh meta from a loaded thumbnail.
    let natW = 0;
    let natH = 0;
    const art = (srcImg.closest) ? srcImg.closest('article') : null;
    if (art) {
        natW = parseInt(art.style.getPropertyValue('--nat-w')) || 0;
        natH = parseInt(art.style.getPropertyValue('--nat-h')) || 0;
    }

    // The file's own size, from items.json.
    if ((!natW || !natH) && id && imageMeta[id]) {
        natW = imageMeta[id].nw;
        natH = imageMeta[id].nh;
    }

    // Still no dimensions (image not loaded yet): load the small tier once to derive correct meta.
    if ((!natW || !natH) && id) {
        const tmp = new Image();
        tmp.decoding = 'async';
        tmp.src = _imgUrl(id);
        tmp.onload = () => {
            if (!lightboxOpen && srcImg.isConnected) openLightboxFromImage(srcImg, tmp.naturalWidth, tmp.naturalHeight);
        };
        return;
    }

    natW = natW || srcImg.naturalWidth;
    natH = natH || srcImg.naturalHeight;
    if (!natW || !natH) return;

    openLightboxFromImage(srcImg, natW, natH);
}


/** Open lightbox. */
function openLightbox(article) {
    if (!article) return;
    // Don't open lightbox for solid-color placeholder images
    if (article.classList.contains('placeholder-img')) return;
    const srcImg = article.querySelector('img');
    openLightboxUnified(srcImg);
}


/** The end of a close: the source image back in place, the clone gone, the state cleared. Runs when the close
 *  animation has landed, straight away for an immediate close, and early when an open arrives mid-close. */
function _lbFinishClose(clone, srcImg, purge = true) {
    document.body.classList.remove('lightbox-active', 'lightbox-closing');
    _lbClearExitCueTargets();
    if (srcImg) {
        // Reappear instantly (no opacity transition). The inline override is cleared after a verified paint: a double rAF guarantees at least one frame rendered with transition:none, which setTimeout(0) doesn't on Safari.
        srcImg.style.transition = 'none';
        srcImg.style.opacity = (srcImg.dataset._lbPrevOpacity || '');
        delete srcImg.dataset._lbPrevOpacity;
        requestAnimationFrame(() => { requestAnimationFrame(() => { srcImg.style.transition = ''; }); });
    }
    if (clone) { clone.src = ''; clone.removeAttribute('srcset'); clone.removeAttribute('sizes'); clone.remove(); }
    _lightboxClone = null;
    _lightboxSourceImg = null;
    if (purge) purgeHighResImages();
}

/** Close the lightbox: animated back onto the source image, or at once with immediate. */
function closeLightbox(immediate) {
    if (!lightboxOpen) return;
    lightboxOpen = false;
    // A close the reader made (animated) goes back in history; a forced one (immediate) edits the address.
    _dropImageAddress(!immediate);
    _lbPanning = false;
    _lbPinching = false;

    const clone = _lightboxClone;
    const centerArticle = _centerArticle();
    const srcImg = _lightboxSourceImg || (centerArticle ? centerArticle.querySelector('img') : null);

    // Clean up mouse/wheel listeners
    if (clone) {
        if (clone._lbMouseMove) {
            window.removeEventListener('mousemove', clone._lbMouseMove);
            window.removeEventListener('mouseup', clone._lbMouseUp);
        }
        if (clone._lbWheel) {
            clone.removeEventListener('wheel', clone._lbWheel);
        }
        clearTimeout(clone._lbWheelTimer);
    }

    if (immediate) {
        lightboxEl.classList.remove('visible');
        _cancel('lightbox.close');
        _lbFinishClose(clone, srcImg);
        return;
    }

    // Animate clone back to original position
    if (clone && srcImg) {
        const rect = _getFittedImgRect(srcImg, (_lbNatW || srcImg.naturalWidth || 0), (_lbNatH || srcImg.naturalHeight || 0));
        const cloneW = parseFloat(clone.style.width);
        const cloneLeft = parseFloat(clone.style.left);
        const cloneTop = parseFloat(clone.style.top);
        const cloneCx = cloneLeft + cloneW / 2;
        const cloneCy = cloneTop + parseFloat(clone.style.height) / 2;
        const srcCx = rect.left + rect.width / 2;
        const srcCy = rect.top + rect.height / 2;
        const returnScale = rect.width / cloneW;
        // Re-enable transition for close animation
        clone.classList.remove('panning');
        clone.style.transform = `translate(${srcCx - cloneCx}px, ${srcCy - cloneCy}px) scale(${returnScale})`;
    }

    lightboxEl.classList.remove('visible');
    // Everything that was only hidden BEHIND the backdrop comes back now, on the backdrop's own clock. lightbox-active stays until the clone has landed, for the source image alone.
    document.body.classList.add('lightbox-closing');

    // Wait for the full close shrink (transform var(--uiTrans)) to finish, plus a frame, before snapping back.
    _after('lightbox.close', () => _lbFinishClose(clone, srcImg), UI_TRANS_MS + 30);
}

// Backdrop click/tap closes lightbox
lightboxEl.addEventListener('click', () => closeLightbox());
// Block all events from reaching the canvas underneath
lightboxEl.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
lightboxEl.addEventListener('mousedown', (e) => e.stopPropagation());
lightboxEl.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
lightboxEl.addEventListener('touchmove', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });

/* ══ SHARE ═════════════════════════════════════════════════════════════════════
   The selected item, shared through the system share sheet (Web Share API) where the browser has one, and
   otherwise copied to the clipboard as the same text. The button sits left of the × while an item is selected,
   and steps aside when the search box is open as a pill (see the #share-btn rules). */

const shareBtn = document.getElementById('share-btn');

/** The item a share would send: the open item on the map (and the phone's detail), or the selected list row or
 *  grid card. null when nothing is selected. */
function _shareItem() {
    const id = viewMode === 'monad' ? selectedMonadId
        : viewMode === 'list' ? listSelectedId
        : viewMode === 'grid' ? gridSelectedId
        : null;
    return id ? (_getTagItemById()[id] || null) : null;
}

/** Whether the selected row or card is on screen at all, by the rule the tag cloud uses to stop leading with its tags
 *  (_getVisibleIdsForTagCloud): any part of it overlapping the window. Desktop list and grid only: a map selection is
 *  always in view, and on a phone a selection is the full-screen detail. */
function _shareItemInView() {
    if (isMobile) return true;
    if (viewMode === 'list' && listSelectedId) {
        const row = listView.querySelector('.list-item.selected');
        if (!row) return false;
        const r = row.getBoundingClientRect();
        return r.bottom >= 0 && r.top <= window.innerHeight;
    }
    if (viewMode === 'grid' && gridSelectedId) {
        return _gridCardsNear(0).some(p => p.id === gridSelectedId);
    }
    return true;
}

/** Show the button while there is something to share, faded out while the selection is scrolled out of view.
 *  Called from _updateCancelButton, which nearly every state change passes through, and on scroll below. */
function _updateShareButton() {
    const has = !!_shareItem();
    document.body.classList.toggle('has-share-target', has);
    shareBtn.classList.toggle('share-off-screen', has && !_shareItemInView());
}

// Scrolling the list or the grid moves the selection in and out of view; one check per frame at most.
window.addEventListener('scroll', () => {
    if (isMobile || (viewMode !== 'list' && viewMode !== 'grid') || !document.body.classList.contains('has-share-target')) return;
    if (!_pending('share.inView')) _onFrame('share.inView', _updateShareButton);
}, { passive: true });

/** The shared text: full title, authors, source and year, the item's own link, and where it was found. */
function _shareText(it) {
    const here = window.location.origin + window.location.pathname + _formatAddress({ i: it.id });
    const lines = [it.title, it.authors, _sourceLine(it), it.url].filter(Boolean);
    return lines.join('\n') + '\n\nvia Data in Dialogue: ' + here;
}

/** Copy text to the clipboard. The async Clipboard API needs a secure context, which a page on a local network
 *  address over plain http is not, so the old selection-and-copy route stands behind it. */
async function _copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
}

async function _doShare(e) {
    if (e) e.stopPropagation();
    const it = _shareItem();
    if (!it) return;
    const text = _shareText(it);
    if (navigator.share) {
        try {
            // Text only: it already opens with the title, and targets that are handed a title as well (Chrome's, among
            // others) put it in front of the text, so it arrived twice.
            await navigator.share({ text });
            return;
        } catch (err) {
            // Dismissing the sheet is an answer, not a failure: nothing more to do.
            if (err && err.name === 'AbortError') return;
            // Anything else (no share target, a refused payload): copy instead.
        }
    }
    if (await _copyText(text)) {
        // The tick is the only sign the copy happened, so it stays long enough to be seen.
        shareBtn.classList.add('share-copied');
        _after('share.copied', () => shareBtn.classList.remove('share-copied'), 1400);
    }
}
shareBtn.addEventListener('click', _doShare);
// Without a share sheet the button's whole job is copying, so its glyph and title say that.
if (!navigator.share) {
    shareBtn.classList.add('share-no-api');
    shareBtn.title = 'Copy this item';
}

/* ══ BUTTON PRESS FEEDBACK ═══════════════════════════════════════════════════
   Shared by every .ui-btn. */
// Prevent all UI buttons from triggering drag
document.querySelectorAll('.ui-btn').forEach(el => {
    el.addEventListener('mousedown', (e) => e.stopPropagation());
});

// Held active-state feedback: CSS :active only persists while the user is physically pressing, so a quick tap flashes for milliseconds and reverts before the view transition even starts.
const _RECENT_PRESS_MS = 750;
/* Not the search box: the press that opens it is answered by the box itself growing into the open field, and an
   inverted loupe held over that read as lagging behind the box it had just opened. */
const _recentPressTargets =
    '.ui-btn, .view-seg, .welcome-btn';
// Core feedback: identical for pointer presses and programmatic triggers
// (keyboard shortcuts light up the equivalent button via _flashButton).
function _pressFeedback(el) {
    if (!el) return;
    el.classList.add('recent-press');
    if (el._recentPressTimer) clearTimeout(el._recentPressTimer);
    el._recentPressTimer = setTimeout(() => {
        el._recentPressTimer = null;
        el.classList.remove('recent-press');
    }, _RECENT_PRESS_MS);
}
/** Flash whichever control actually closes the about panel. It is not the same element in both layouts. */
function _flashInfoClose() {
    const x = document.getElementById('info-overlay-close');
    const shown = x && getComputedStyle(x).display !== 'none';
    _flashButton(shown ? 'info-overlay-close' : 'info-btn');
}

// Light up a button by id as if clicked, so keyboard shortcuts give the same held-active confirmation as taps. Flashing a hidden button is a harmless no-op.
function _flashButton(id) {
    _pressFeedback(document.getElementById(id));
}
// Cancel-button variant with a visibility guard: .recent-press forces opacity 1 so the glow survives the button's own hide, which means flashing it while hidden would pull a cross into view even though Escape had nothing to cancel.
function _flashCancelButton() {
    const el = document.getElementById('search-cancel-btn');
    if (!el) return;
    if (parseFloat(getComputedStyle(el).opacity) < 0.1) return;
    _pressFeedback(el);
}
function _attachHeldActive(el) {
    if (!el || el._recentPressBound) return;
    el._recentPressBound = true;
    // pointerdown fires immediately on tap (before click), giving the most
    // responsive feedback. Both touch and mouse map to it.
    el.addEventListener('pointerdown', () => _pressFeedback(el), { passive: true });
}
document.querySelectorAll(_recentPressTargets).forEach(_attachHeldActive);

/* user-select: none on the controls stops their OWN text being selected; it does not stop a drag that begins on one from running out across the page and selecting everything it crosses. */
document.addEventListener('mousedown', (e) => {
    // Pointers only. On a touch device mousedown is a compatibility event synthesised after the tap, and preventing it there can swallow the click that follows, which is a real interaction lost to guard against a drag that cannot happen.
    if (isMobile) return;
    const ctrl = e.target.closest(
        '.ui-btn, #mode-btn, .view-seg, #search-icon, #search-box, #tag-sidebar');
    if (ctrl && !e.target.closest('#search-input')) e.preventDefault();
});
