/* ══ GRID VIEW ══════════════════════════════════════════════════════════════
   A masonry of the collection: each card is the item's image with its short title underneath, in the list's chronological order and under the same tag and search filters (_listItemPassesFilters).
   Like the list, the DOM is built once and kept; a filter change toggles .grid-out and re-runs the layout. The map stays underneath in its plain state (switchToGridView leaves a monad or search first), which is also why leaving the grid is only a class removal before the target view's own switch runs.
   Images: every card starts on the small image inlined in items.json; the cards in the viewport, once scrolling pauses, swap in the image file, and cards far outside it go back to the small one (_gridRefreshImages).
   Selection: a card expands below its title with the detail (subtitle, authors, source, description, tags, links, linked items) at the column's width, so the image keeps its size. Columns are assigned from the collapsed heights and kept, so an expansion only pushes down the cards below it in its own column. */

const gridView = document.getElementById('grid-view');
const _gridInner = gridView ? gridView.querySelector('.grid-inner') : null;
const GRID_FADE_MS = 375;            // keep in sync with the #grid-view opacity transition
const GRID_COL_BREAKS = [1000, 1750, 2500];   // desktop: window widths (px) from which a 3rd, 4th and 5th column are added to the base 2 (see _gridLayout)
const GRID_MAX_TALL = 1;             // tallest image, as height over card width (a square, as a selected list image fits one); taller ones narrow instead
const GRID_FILL_RATIO = 4 / 3;       // at rest every image has the same area, the one at which this ratio exactly fills the column (see _gridCardHtml)
const GRID_SEL_AREA = 0.5;           // selected, every image has this share of the card width squared (a 2:1 image fills the card; a square one is 71% of it)
const GRID_IMG_IDLE_MS = 140;        // scroll pause before the viewport's cards load their image files
let _gridBuilt = false;
let _gridCardById = null;            // id -> card element
let _gridCols = 0;
let _gridColW = 0;
let _gridGap = 0;
let _gridRowGap = 0;
let _gridAssign = [];                // visible cards in order: { el, id, col }
let _gridPlaced = [];                // visible cards in order: { id, el, y, h }
let _gridLayoutPending = false;
let gridSelectedId = null;

/** The grid's hash. After the colon: nothing for the plain grid, `q:<query>` for a search, otherwise an item id (a selection) or a tag. */
function _gridCardHtml(it) {
    const m = imageMeta[it.id];
    // The ratio at full precision, from the file's size in items.json (the small tier's sw/sh are rounded to whole pixels at 128); the loaded file's own ratio replaces it (_gridLoadLarge).
    const sw = (m && m.nw) || 4;
    const sh = (m && m.nh) || 3;
    const ph = !!it._isPlaceholderImg;
    // Stub colour under the bitmap, as for the articles and list thumbnails; placeholders take their grey from CSS.
    const bg = ph ? '' : `;background-color:${_stubFillForId(it.id)}`;
    // Widths as fractions of the card, so they hold at any column width. Both states give every image the same area,
    // as the map and list size theirs; wider images are capped to the card's width and lose some.
    const ar = sw / sh;
    const tallCap = ar * GRID_MAX_TALL;
    const fRest = ph ? 1 : Math.min(1, Math.sqrt(ar / GRID_FILL_RATIO), tallCap);
    const fSel = ph ? 1 : Math.min(1, Math.sqrt(ar * GRID_SEL_AREA), tallCap);
    // Phones fill the selected card's width instead (the list's selected image does, from the left button's edge to the right one's), still no taller than it is wide.
    const fFill = ph ? 1 : Math.min(1, tallCap);
    const widths = ph ? '' : `;--gridImgRest:${(fRest * 100).toFixed(2)}%;--gridImgSel:${(fSel * 100).toFixed(2)}%;--gridImgFill:${(fFill * 100).toFixed(2)}%`;
    // Never wider than the file's own pixels, which items.json carries.
    const natW = (!ph && m) ? m.lw : 0;
    const cap = natW ? `;max-width:${natW}px` : '';
    // As a list row rests: title, subtitle and the author line, with the source as an overlay below them that hover reveals (and a selection sets in flow).
    // As in the list and the monad: the subtitle is the second half of one link.
    const sub = it.subtitle
        ? `<div class="grid-subtitle">${it.url
            ? `<a class="title-link" href="${_esc(it.url)}" target="_blank" rel="noopener noreferrer">${_esc(it.subtitle)}</a>`
            : _esc(it.subtitle)}</div>`
        : '';
    const authors = it.authors ? `<div class="grid-authors">${_esc(it.authors)}</div>` : '';
    const source = _sourceLine(it);
    const sourceLine = source ? `<div class="grid-source">${_esc(source)}</div>` : '';
    // A div, not a link: the expanded detail holds links of its own, and anchors cannot nest.
    return `<div class="grid-card${ph ? ' placeholder-img' : ''}" data-id="${_esc(it.id)}" tabindex="0">`
        + `<img class="grid-thumb" src="${_smallSrcFor(it.id)}" data-id="${_esc(it.id)}" width="${sw}" height="${sh}" style="aspect-ratio:${sw} / ${sh}${bg}${widths}${cap}" alt="" decoding="async" draggable="false">`
        + `<div class="grid-text"><div class="grid-title">${it.url ? `<a class="title-link" href="${_esc(it.url)}" target="_blank" rel="noopener noreferrer">${_esc(it.shorttitle || it.title || '')}</a>` : _esc(it.shorttitle || it.title || '')}</div>${sub}<div class="grid-meta">${authors}${sourceLine}</div></div>`
        + `</div>`;
}

/** The expanded detail of a card, built on first selection, below the card's own text. The description and tags reuse the list's classes and so its typography; tags appear only without the desktop tag pane, as in the list. */
function _gridExtraHtml(it) {
    const byId = _getTagItemById();
    const text = (it.textLines && it.textLines.length)
        ? `<div class="list-text">${_paragraphsHtml(it.textLines)}</div>` : '';
    const tags = (!_tagSidebarEnabled() && it.tags && it.tags.length)
        ? `<div class="list-tags">${it.tags.map(t => `<a data-tag="${_esc(t)}" href="${_esc(_formatAddress({ view: 'grid', t }))}">${_esc(t)}</a>`).join('')}</div>` : '';
    const linked = [...new Set(it.links || [])]
        .map(x => (x || '').toString().trim())
        .filter(id => id && id !== it.id && byId[id]);
    const seeAlso = linked.length
        ? `<div class="grid-seealso">${linked.map(id => `<a href="${_esc(_formatAddress({ view: 'grid', i: id }))}" data-id="${_esc(id)}">${_esc(byId[id].shorttitle || id)}</a>`).join('')}</div>` : '';
    return text + tags + seeAlso;
}

function _gridBuild() {
    if (!_gridInner) return;
    _gridInner.innerHTML = _listChronoItems().map(_gridCardHtml).join('');
    _gridCardById = Object.create(null);
    const els = _gridInner.children;
    for (let i = 0; i < els.length; i++) _gridCardById[els[i].getAttribute('data-id')] = els[i];
    _gridBuilt = true;
}

/** The grid's durations, from the list and map variables its CSS uses: move is a selection's (and a staying card's) travel, fold a leaving card's slide, and an arriving card lands when the moves do. */
function _gridDur() {
    const move = _cssMs('--listTrans', UI_TRANS_MS);
    const fold = _cssMs('--listFoldTrans', 460);
    return { move, fold, enterEnd: Math.max(move, _cssMs('--uiTrans', UI_TRANS_MS)) };
}

/** Apply the current filters to the grid and lay it out. A selection the filters hide is dropped. animate
 *  (interactive filter changes, in the grid, without reduced motion): cards that drop out slide up and fade,
 *  cards that come in slide in at their new places, and cards that stay ease there, across columns too. */
function renderGrid(animate, resized) {
    if (!_gridInner) return;
    if (!_gridBuilt) { _gridBuild(); animate = false; }
    if (animate) {
        const reduced = _prefersReducedMotion();
        animate = (viewMode === 'grid') && !reduced && !isMobile;
    }
    const byId = _getTagItemById();
    const els = _gridInner.children;
    const entering = [];
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const it = byId[el.getAttribute('data-id')];
        const pass = !!(it && _listItemPassesFilters(it));
        const wasOut = el.classList.contains('grid-out');
        if (pass) {
            // Also rescues a card still leaving from a filter moments ago: it stays and moves from where it is.
            el.classList.remove('grid-leaving', 'grid-out');
            if (wasOut && animate) entering.push(el);
        } else if (!wasOut) {
            if (animate) {
                el.classList.add('grid-leaving');
            } else {
                el.classList.remove('grid-leaving');
                el.classList.add('grid-out');
            }
        }
    }
    if (gridSelectedId) {
        const sel = _gridCardById[gridSelectedId];
        if (!sel || sel.classList.contains('grid-out') || sel.classList.contains('grid-leaving')) _gridSetSelected(null);
    }
    // Arriving cards take their places without travelling from wherever they last were; their slide is the gridEnter animation.
    for (let i = 0; i < entering.length; i++) {
        entering[i].classList.remove('grid-entering');
        entering[i].classList.add('grid-entering');
    }
    _gridLayout(animate, animate ? resized : null);
    if (animate) {
        _after('grid.leave', () => {
            const out = _gridInner.querySelectorAll('.grid-card.grid-leaving');
            for (let i = 0; i < out.length; i++) {
                out[i].classList.remove('grid-leaving');
                out[i].classList.add('grid-out');
            }
        }, _gridDur().fold + 20);
        _after('grid.enter', () => {
            const inn = _gridInner.querySelectorAll('.grid-card.grid-entering');
            for (let i = 0; i < inn.length; i++) inn[i].classList.remove('grid-entering');
        }, _gridDur().enterEnd + 40);
    } else {
        _cancel('grid.leave', 'grid.enter');
        const inn = _gridInner.querySelectorAll('.grid-card.grid-entering, .grid-card.grid-leaving');
        for (let i = 0; i < inn.length; i++) inn[i].classList.remove('grid-entering', 'grid-leaving');
    }
    _scheduleTagCloudUpdate(true);
}

/** A card's height at rest: a card still folding its detail away is measured without it, so the cards below are
 *  placed where the fold ends and ease there on the same clock. */
function _gridRestHeight(el) {
    const h = el.offsetHeight;
    if (!el.classList.contains('grid-closing')) return h;
    const extra = el.querySelector('.grid-extra');
    return extra ? h - extra.offsetHeight : h;
}

/** Full layout: the column count steps with the window width (see GRID_COL_BREAKS), and each card goes into the shortest column by its COLLAPSED height, taking the leftmost of near-equal ones so the order still reads across the rows. Then the positions. */
function _gridLayout(animate, resized) {
    _gridLayoutPending = false;
    if (!_gridInner || !_gridBuilt) return;
    _gridStopMoving();
    const W = _gridInner.clientWidth;
    if (!W) return;
    _gridGap = _cssLengthPx(gridView, '--gridColGap') || 16;
    _gridRowGap = _cssLengthPx(gridView, '--gridRowGap') || 24;
    // Phones: two columns upright, three on their side. Elsewhere 2 plus one for every GRID_COL_BREAKS width the window reaches: 2 below 1000px, 3 from 1000, 4 from 1750, 5 from 2500 (the most); wider windows widen the columns instead.
    if (isMobile) {
        _gridCols = (window.innerWidth > window.innerHeight) ? 3 : 2;
    } else {
        _gridCols = 2 + GRID_COL_BREAKS.filter(w => window.innerWidth >= w).length;
    }
    _gridColW = (W - _gridGap * (_gridCols - 1)) / _gridCols;
    _gridInner.style.setProperty('--gridColW', _gridColW + 'px');
    _gridInner.style.setProperty('--gridSpanW', (2 * _gridColW + _gridGap) + 'px');

    const cards = [];
    const els = _gridInner.children;
    for (let i = 0; i < els.length; i++) {
        if (!els[i].classList.contains('grid-out') && !els[i].classList.contains('grid-leaving')) cards.push(els[i]);
    }
    // One read pass after the width write. The selected card is measured collapsed (its class lifted for the read, with no transition running), so a selection never moves cards between columns.
    const selEl = (gridSelectedId && _gridCardById) ? _gridCardById[gridSelectedId] : null;
    if (selEl) selEl.classList.remove('selected');
    const hs = new Array(cards.length);
    for (let i = 0; i < cards.length; i++) hs[i] = _gridRestHeight(cards[i]);
    if (selEl) selEl.classList.add('selected');
    const colH = new Array(_gridCols).fill(0);
    const assign = new Array(cards.length);
    for (let i = 0; i < cards.length; i++) {
        let c = 0;
        for (let k = 1; k < _gridCols; k++) {
            if (colH[k] < colH[c] - 1) c = k;
        }
        assign[i] = { el: cards[i], id: cards[i].getAttribute('data-id'), col: c };
        colH[c] += hs[i] + _gridRowGap;
    }
    _gridAssign = assign;
    _gridPosition(!!animate, resized);
    _gridRefreshImages(true);
}

/** The column pair a selected card spans: its own column and the neighbour whose stack ends higher, so it drops as little as possible (right on a tie). */
function _gridSpanStart(col, colH) {
    if (_gridCols < 2) return 0;
    const cand = [];
    if (col <= _gridCols - 2) cand.push(col);
    if (col >= 1) cand.push(col - 1);
    let best = cand[0];
    for (let i = 1; i < cand.length; i++) {
        const c = cand[i];
        if (Math.max(colH[c], colH[c + 1]) < Math.max(colH[best], colH[best + 1]) - 0.5) best = c;
    }
    return best;
}

/** Stack each column's cards at their current heights, keeping the column assignment. */
function _gridPosition(animate, resized) {
    if (!_gridInner) return;
    _gridStopMoving();
    const n = _gridAssign.length;
    const hs = new Array(n);
    for (let i = 0; i < n; i++) hs[i] = _gridRestHeight(_gridAssign[i].el);
    if (animate) {
        if (resized) {
            for (let i = 0; i < resized.length; i++) {
                const r = resized[i];
                r.el.style.width = r.fromW + 'px';
                if (r.sq) r.sq.style.width = r.sqW;
                for (const [node, fs, mt] of (r.text || [])) {
                    if (fs) node.style.fontSize = fs;
                    node.style.marginTop = mt;
                }
            }
            void _gridInner.offsetWidth;
        }
        _gridInner.classList.add('grid-moving');
        _after('grid.moving', () => _gridInner.classList.remove('grid-moving'), _gridDur().move + 40);
    }
    const colH = new Array(_gridCols).fill(0);
    const placed = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = _gridAssign[i];
        let c = a.col;
        let y;
        if (a.el.classList.contains('selected')) {
            c = _gridSpanStart(a.col, colH);
            y = Math.max(colH[c], colH[c + 1]);
            colH[c] = colH[c + 1] = y + hs[i] + _gridRowGap;
        } else {
            y = colH[c];
            colH[c] = y + hs[i] + _gridRowGap;
        }
        const x = c * (_gridColW + _gridGap);
        a.el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
        placed[i] = { id: a.id, el: a.el, y, h: hs[i] };
    }
    if (animate && resized) {
        for (let i = 0; i < resized.length; i++) {
            const r = resized[i];
            r.el.style.removeProperty('width');
            if (r.sq) r.sq.style.removeProperty('width');
            for (const [node] of (r.text || [])) {
                node.style.removeProperty('font-size');
                node.style.removeProperty('margin-top');
            }
        }
    }
    _gridPlaced = placed;
    _gridInner.style.height = Math.max(0, Math.max(0, ...colH) - _gridRowGap) + 'px';
}

let _gridPositionPending = false;
function _scheduleGridPosition() {
    if (_gridPositionPending || !_gridBuilt) return;
    _gridPositionPending = true;
    requestAnimationFrame(() => {
        _gridPositionPending = false;
        _gridPosition(false);
    });
}

function _scheduleGridLayout() {
    if (_gridLayoutPending || !_gridBuilt) return;
    _gridLayoutPending = true;
    requestAnimationFrame(() => _gridLayout(false));
}

/** Placed cards overlapping the scroll window widened by `margin` viewport heights either side. From the stored placement, so no layout is read. */
function _gridCardsNear(margin) {
    const out = [];
    if (!gridView || !_gridInner) return out;
    const viewH = gridView.clientHeight;
    const top = gridView.scrollTop - _gridInner.offsetTop - margin * viewH;
    const bottom = top + viewH * (1 + 2 * margin);
    for (let i = 0; i < _gridPlaced.length; i++) {
        const p = _gridPlaced[i];
        if (p.y + p.h >= top && p.y <= bottom) out.push(p);
    }
    return out;
}

/** Ids of the cards currently in the viewport, for the tag cloud. */
function _gridVisibleIds() {
    return _gridCardsNear(0).map(p => p.id);
}

/** Swap the image file in for one card: preloaded and decoded off-screen first, so the small image stays up until the sharp one can replace it in a single frame. Dropped if the card has left the viewport's neighbourhood by then. */
function _gridLoadLarge(el) {
    if (el._gridLarge || el._gridLoading || el.classList.contains('placeholder-img')) return;
    const img = el.querySelector('img.grid-thumb');
    const id = el.getAttribute('data-id');
    if (!img || !id) return;
    el._gridLoading = true;
    const pre = new Image();
    pre.decoding = 'async';
    pre.src = _imgUrl(id);
    const ready = pre.decode ? pre.decode() : new Promise((res, rej) => { pre.onload = res; pre.onerror = rej; });
    ready.then(() => {
        el._gridLoading = false;
        // Never wider than the loaded file's own pixels: a file narrower than the space keeps its native width rather
        // than being stretched. Mostly a selected card's concern, since a column is rarely wider than a file.
        const _applyNatural = () => {
            const nat = pre.naturalWidth || 0;
            const natH = pre.naturalHeight || 0;
            if (nat > 0 && natH > 0) {
                const shown = img.getBoundingClientRect();
                img.style.maxWidth = nat + 'px';
                // The file's own proportions, in case items.json's differ: an img held to a stated aspect-ratio stretches a bitmap of another. Restack if either correction changes the height on screen.
                img.style.aspectRatio = nat + ' / ' + natH;
                const w = Math.min(shown.width, nat);
                if (Math.abs(w * natH / nat - shown.height) > 0.5) _scheduleGridPosition();
            }
            if (!el._gridWanted) return;
            img.src = pre.src;
            el._gridLarge = true;
        };
        // Not while anything is moving. Selecting a card runs this pass for the card that is at that moment growing: the
        // rect read returns an interpolated width, the maxWidth and aspect-ratio writes resize the image under the
        // running transition, and the restack that follows calls _gridStopMoving, which cancels the move mid-flight and
        // leaves everything to snap from wherever it had got to.
        if (_gridBusy()) {
            clearTimeout(el._gridNatTimer);
            el._gridNatTimer = setTimeout(() => {
                el._gridNatTimer = null;
                if (_gridBusy()) {
                    el._gridNatTimer = setTimeout(() => { el._gridNatTimer = null; _applyNatural(); }, 200);
                    return;
                }
                _applyNatural();
            }, _gridDur().move + 60);
        } else {
            _applyNatural();
        }
    }, () => { el._gridLoading = false; });
}

/** Back to the inlined small image for a card far from the viewport, which frees the decoded file. */
function _gridDropLarge(el) {
    if (!el._gridLarge) return;
    const img = el.querySelector('img.grid-thumb');
    const id = el.getAttribute('data-id');
    if (img && id) img.src = _smallSrcFor(id);
    el._gridLarge = false;
}

/** The viewport's cards (and a selected card) get their image files; cards beyond a viewport's height either side go back to the small image. Runs when scrolling pauses and after every layout; idle=true waits for the pause. */
/** True while something is animating the grid or the view it sits in: the rect bridge that carries a switch, a
 *  mode cross-fade, a map transition, or the grid's own selection move. Image work waits for all of them. */
function _gridBusy() {
    return _stubBridgeActive || _modeBridgeInFlight || _viewTransitionActive()
        || !!(_gridInner && _gridInner.classList.contains('grid-moving'));
}

function _gridRefreshImages(idle) {
    if (idle) {
        _after('grid.images', () => _gridRefreshImages(false), GRID_IMG_IDLE_MS);
        return;
    }
    if (viewMode !== 'grid' || !_gridBuilt) return;
    if (_gridBusy()) {
        _after('grid.images', () => _gridRefreshImages(false), 120);
        return;
    }
    const inView = _gridCardsNear(0);
    const keep = new Set(_gridCardsNear(1).map(p => p.el));
    if (gridSelectedId && _gridCardById[gridSelectedId]) keep.add(_gridCardById[gridSelectedId]);
    const els = _gridInner.children;
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        el._gridWanted = keep.has(el);
        if (!el._gridWanted) _gridDropLarge(el);
    }
    for (let i = 0; i < inView.length; i++) _gridLoadLarge(inView[i].el);
    if (gridSelectedId && _gridCardById[gridSelectedId]) _gridLoadLarge(_gridCardById[gridSelectedId]);
}

/** Scroll the grid so a card sits in the middle of the viewport (or near the top, if taller); smooth eases there instead of jumping. */
function _gridScrollToCard(id, smooth = false) {
    const p = _gridPlaced.find(q => q.id === id);
    if (!p || !gridView) return false;
    const y = _gridInner.offsetTop + p.y;
    const viewH = gridView.clientHeight;
    const band = isMobile ? _mobileSelectionTopPx() : viewH * 0.1;
    // A card too tall to centre is aligned to the band instead; on a phone an open card always is, which is what puts its image just under the corner buttons.
    const top = Math.max(0, (p.h < viewH * 0.9) ? (y + p.h / 2 - viewH / 2) : (y - band));
    if (smooth) gridView.scrollTo({ top, behavior: SCROLL_BEHAVIOR });
    else gridView.scrollTop = top;
    return true;
}

/** After an expansion: bring the card's top into view if it sits above the viewport, or its bottom if the new detail runs below it (never so far that the top leaves). */
function _gridEnsureCardVisible(id) {
    const p = _gridPlaced.find(q => q.id === id);
    if (!p || !gridView) return;
    const y = _gridInner.offsetTop + p.y;
    const viewH = gridView.clientHeight;
    const band = isMobile ? _mobileSelectionTopPx() : viewH * 0.1;
    const cur = gridView.scrollTop;
    let target = cur;
    if (y < cur + band) target = y - band;
    else if (y + p.h > cur + viewH - band) target = Math.min(y - band, y + p.h - viewH + band);
    if (Math.abs(target - cur) > 2) gridView.scrollTo({ top: Math.max(0, target), behavior: SCROLL_BEHAVIOR });
}

function _gridScrollToTop() {
    if (_panelRestoreY !== null) return;
    if (gridView) gridView.scrollTop = 0;
}

/** Space, Shift+Space, the arrows, PageUp/PageDown, Home and End for the list and the grid. Both scroll through the body-scroll proxy, so neither gets these natively. Text fields keep their keys. */
function _panelScrollKey(e) {
    const el = (viewMode === 'grid') ? gridView : listView;
    if (!el) return;
    const ae = document.activeElement;
    const tag = ae ? ae.tagName : '';
    if (ae && (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable)) return;
    e.preventDefault();
    const page = Math.max(120, Math.floor(el.clientHeight * 0.9));
    const step = Math.max(80, Math.floor(el.clientHeight * 0.2));
    let top = el.scrollTop;
    switch (e.key) {
        case ' ': top += e.shiftKey ? -page : page; break;
        case 'PageDown': top += page; break;
        case 'PageUp': top -= page; break;
        case 'ArrowDown': top += step; break;
        case 'ArrowUp': top -= step; break;
        case 'Home': top = 0; break;
        case 'End': top = el.scrollHeight; break;
        default: return;
    }
    el.scrollTo({ top: Math.max(0, top), behavior: SCROLL_BEHAVIOR });
    if (viewMode === 'list') _scheduleTagCloudUpdate(false);
}

/** Open or close the detail of one card, with no layout, hash or scroll work (see _gridSelect). */
function _gridSetSelected(id) {
    if (gridSelectedId && _gridCardById && _gridCardById[gridSelectedId]) {
        const _prev = _gridCardById[gridSelectedId];
        // The fold starts from the detail's real height rather than a fixed ceiling, so the card shrinks from its first frame.
        const _extra = _prev.querySelector('.grid-extra');
        if (_extra) _prev.style.setProperty('--gridExtraH', _extra.offsetHeight + 'px');
        _prev.classList.remove('selected');
        /* .grid-extra is display: none when a card is not selected, so removing the class took the description, tags and
           links out in one frame; the fold the list does on its way out had no counterpart here, and what the card
           showed instead was the text simply blanking. .grid-closing keeps the box displayed and runs the reverse of the
           open animation. */
        _prev.classList.add('grid-closing');
        _cancel('grid.closing.' + gridSelectedId);
        const _closingId = gridSelectedId;
        _after('grid.closing.' + _closingId, () => {
            const c = _gridCardById && _gridCardById[_closingId];
            if (c && !c.classList.contains('selected')) {
                c.classList.remove('grid-closing');
                c.style.removeProperty('--gridExtraH');
            }
        }, _cssMs('--listTrans') + 60);
    }
    gridSelectedId = id || null;
    // Here rather than at the call sites: the × is a pure function of this id (and the tag and query), so it belongs where the id changes.
    _updateCancelButton();
    if (!gridSelectedId || !_gridCardById) return;
    const el = _gridCardById[gridSelectedId];
    if (!el) { gridSelectedId = null; return; }
    let extra = el.querySelector('.grid-extra');
    if (!extra) {
        const it = _getTagItemById()[gridSelectedId];
        extra = document.createElement('div');
        extra.className = 'grid-extra';
        extra.innerHTML = it ? _gridExtraHtml(it) : '';
        el.appendChild(extra);
    }
    el.classList.add('selected');
    // A card reselected while still folding away has no business doing both.
    el.classList.remove('grid-closing');
}

/** Select a card (or, with the selected id or null, close it): the detail opens below the title, the cards under it in its column ease down, and the hash, title, cancel button and tag cloud follow. */
function _gridSelect(id, opts) {
    // As in setListSelection: a phone opens the shared detail rather than expanding the card.
    if (isMobile && id && id !== gridSelectedId) { _openMobileItemDetail(id, 'grid'); return; }
    opts = opts || {};
    const next = (id && id !== gridSelectedId) ? id : null;
    if (next === gridSelectedId) return;
    const animate = opts.animate !== false && !isMobile;
    // The closing and the opening card change width (one column to two and back) and text size; note where they start so both ease with the move.
    const resized = animate ? _gridCaptureResized([gridSelectedId, next]) : [];
    _gridSetSelected(next);
    _gridPosition(animate, resized);
    if (next) {
        if (opts.scroll === 'center') _gridScrollToCard(next);
        else if (opts.scroll !== false) _gridEnsureCardVisible(next);
    }
    _gridRefreshImages(false);
    if (opts.updateHash !== false) _setHashForCurrentState(opts.push !== false);
    _updateGridTitle();
    _updateCancelButton();
    // After the cards have finished moving, for the same reason a tag click waits: the cloud describes what is in view, the recount reads live rects, and doing it here put a burst of forced layout in the middle of the opening.
    tagVis.updateAfterTransition();
}

/** Where the cards about to change their selected state start: width, text sizes and margins, and the image's width, read as they are on screen now (mid-animation included). _gridPosition pins them there for one flush so each eases to its new value. */
function _gridCaptureResized(ids) {
    const resized = [];
    if (!_gridCardById) return resized;
    for (const cid of ids) {
        const el = cid ? _gridCardById[cid] : null;
        if (!el || resized.some(r => r.el === el)) continue;
        const text = [];
        // The size is pinned only where it is declared (title, subtitle, meta); the source's own margin changes, but its size is inherited and must stay so (see .grid-inner.grid-moving .grid-source).
        el.querySelectorAll('.grid-text, .grid-title, .grid-subtitle, .grid-meta, .grid-source').forEach((node) => {
            const cs = getComputedStyle(node);
            const ownSize = !node.classList.contains('grid-text') && !node.classList.contains('grid-source');
            text.push([node, ownSize ? cs.fontSize : '', cs.marginTop]);
        });
        // The image (or an image-less card's square) changes width with the selection too.
        const sq = el.querySelector('.grid-thumb');
        resized.push({ el, fromW: el.offsetWidth, text, sq, sqW: sq ? getComputedStyle(sq).width : '' });
    }
    return resized;
}

/** End any eased move in flight, so the heights read next are final ones. */
function _gridStopMoving() {
    if (!_gridInner || !_gridInner.classList.contains('grid-moving')) return;
    _cancel('grid.moving');
    _gridInner.classList.remove('grid-moving');
}

function _updateGridTitle() {
    _updateDocTitle();
}

/** Enter the grid from any view. A monad centre or a list selection is carried: it becomes the grid's selection, centred. */
function switchToGridView(updateHash = true, push = true, carry = true) {
    // See switchToListView.
    if (_infoOverlayRef && _infoOverlayRef.classList.contains('visible')) hideInfo(false);
    if (viewMode === 'grid') return;
    if (lightboxOpen) closeLightbox(true);
    if (infoOverlay.classList.contains('visible')) hideInfo(false);
    _cancel('monad.relatedReveal');
    document.body.classList.remove('monad-related-hidden');

    // Same rule as switchToListView: the switcher carries a selection across, the hash never does. _gridSelect has the same mobile bounce into _openMobileItemDetail that made the detail reopen on close.
    const carryId = !carry ? null
        : (viewMode === 'monad' && selectedMonadId) ? selectedMonadId
        : (viewMode === 'list' && listSelectedId) ? listSelectedId
        : null;
    const fromList = (viewMode === 'list');

    // Leave the monad or search canvas state underneath, keeping the search input as it is. forPanel on a phone, as in switchToListView.
    if (viewMode === 'monad' || viewMode === 'search') {
        switchToMapView(false, true, false, isMobile);
    }
    _cancel('monad.staggerReveal', 'monad.staggerRevealFrame');

    // Same camera hygiene as switchToListView: no snapshot to come back to, and an unfiltered map resets.
    _savedMapCamera = null;
    if (!activeTag && !(searchQuery || '').trim()) {
        zoom = 0;
        panX = 0;
        panY = 0;
    }

    _setViewMode('grid');
    document.body.classList.add('grid-view');
    // Synchronously, so the layout the render below measures is already the body-scroll one; the observer would only catch up a microtask later.
    if (gridView._applyBodyScroller) gridView._applyBodyScroller();

    if (fromList) {
        // The list is the body scroller. Drop it once the grid covers it, so its flip back to a fixed overlay is never seen.
        listSelectedId = null;
        _after('grid.leaveList', () => {
            if (viewMode === 'grid') document.body.classList.remove('list-view');
        }, GRID_FADE_MS);
    }

    let q = searchInput.value.trim();
    const isTagText = q.startsWith('#');   // mobile shows a tag filter as "#tag" in the box
    document.body.classList.toggle('search-has-query', q.length > 0);
    searchQuery = isTagText ? '' : q;
    searchScores = (!isTagText && q.length >= 2) ? computeSearchScores(q) : {};
    // A carried selection keeps the filter it sits in (as from a filtered list); only a filter that would hide it is lifted.
    if (carryId) {
        const _ci = _getTagItemById()[carryId];
        if (!(_ci && _listItemPassesFilters(_ci))) {
            _clearSearchState();
            if (activeTag) _clearTagFilterState();
            q = '';
        }
    }

    _gridSetSelected(null);
    renderGrid();
    if (carryId && _gridCardById && _gridCardById[carryId] && !_gridCardById[carryId].classList.contains('grid-out')) {
        _gridSelect(carryId, { animate: false, scroll: 'center', updateHash: false });
    } else {
        _gridScrollToTop();
    }
    _gridRefreshImages(false);

    if (updateHash) _setHashForCurrentState(push);
    _updateGridTitle();
    _updateCancelButton();
    if (q.length > 0) searchBox.classList.add('open');
    purgeHighResImages();
    _stubMapBehindPanel();
    // After the bridge has landed: this call sits inside the switch, which the bridge runs at its midpoint, so recounting here put a measuring pass over every visible card into the travel leg.
    tagVis.updateAfterTransition();
}

/** Leave the grid. Only the class goes: the caller is always one of the switchTo* functions, which then set their own state over the plain map underneath. */
function _exitGridView() {
    _cancel('grid.leaveList', 'grid.images');
    document.body.classList.remove('grid-view');
}

/** Filter change while in the grid: any selection closes, the layout starts from the top, then the usual hash, title and cloud updates. */
function _gridFilterChanged(push) {
    _gridSetSelected(null);
    _gridScrollToTop();
    renderGrid(true);
    _commitFilterChange(push);
}

/** Select a card from a click or Enter. Any tag filter or search stays: the selection opens inside the filtered set, the hash carries both, and the grid scrolls only as far as needed to bring the opened card into view. */
function _gridSelectFromClick(id) {
    if (isMobile) { _openMobileItemDetail(id, 'grid'); return; }
    _gridSelect(id);
}

/** Clear the grid's selection and any tag or search together (Escape, a click on the background). One layout pass and one history entry for both; a lone selection or a lone filter clears as it does on its own. */
function _gridClearSelectionAndFilter(push) {
    if (viewMode !== 'grid') return false;
    const hadSel = !!gridSelectedId;
    const hadSearch = !!(searchQuery || '').trim() || !!(searchInput && searchInput.value.trim());
    const hadTag = !!(activeTag || '').trim();
    if (hadSel && (hadSearch || hadTag)) {
        const resized = isMobile ? [] : _gridCaptureResized([gridSelectedId]);
        if (hadSearch) { _clearSearchState(); if (searchInput) searchInput.blur(); }
        if (hadTag) _clearTagFilterState();
        _gridSetSelected(null);
        renderGrid(true, resized);
        _commitFilterChange(push);
    } else if (hadSel) {
        _gridSelect(null, { push });
    } else if (hadSearch) {
        closeSearch();
    } else if (hadTag) {
        _clearTagFilterKeepView(push);
    } else {
        return false;
    }
    return true;
}

/** Move the selection one card along the list's order (dir = 1 next, -1 previous), among the cards the filters show; stops at either end. */
function _gridStepSelection(dir) {
    if (viewMode !== 'grid' || !gridSelectedId || !_gridAssign.length) return;
    const idx = _gridAssign.findIndex(a => a.id === gridSelectedId);
    if (idx === -1) return;
    const next = _gridAssign[idx + dir];
    if (!next) return;
    _gridSelect(next.id, { push: false });
}


if (_gridInner) {
    gridView.addEventListener('click', (e) => {
        if (viewMode !== 'grid') return;
        const card = e.target.closest('.grid-card');
        if (!card) {
            // Background: clear the selection and the filter it sits in, as Escape does. Also mid-transition: nothing here waits for a move to finish (a new layout ends any move in flight, _gridStopMoving).
            _gridClearSelectionAndFilter(true);
            return;
        }
        const id = card.getAttribute('data-id');
        if (!id) return;

        // Tag chip (only present without the tag pane): toggle the tag filter.
        const tagEl = e.target.closest('.list-tags a');
        if (tagEl) {
            e.preventDefault();
            _toggleTagFilter((tagEl.getAttribute('data-tag') || '').trim(), true);
            return;
        }
        // Linked item: select it here, where it is. If the filter hides it, the filter is lifted first (one layout pass, as in the router) so it can open.
        const seeEl = e.target.closest('.grid-seealso a');
        if (seeEl) {
            e.preventDefault();
            const to = seeEl.getAttribute('data-id');
            if (!to || !_gridCardById[to]) return;
            if (!_gridCardById[to].classList.contains('grid-out')) {
                _gridSelect(to, { scroll: 'center' });
            } else {
                const resized = isMobile ? [] : _gridCaptureResized([gridSelectedId, to]);
                _clearSearchState();
                _clearTagFilterState();
                _gridSetSelected(to);
                renderGrid(true, resized);
                _gridRefreshImages(false);
                _gridScrollToCard(to);
                _setHashForCurrentState(true);
                _updateGridTitle();
                _updateCancelButton();
            }
            return;
        }
        // The title's link behaves normally.
        if (e.target.closest('.title-link')) return;

        if (card.classList.contains('selected')) {
            // The selected card's image opens the lightbox, as in the list; anything else on it closes the detail.
            if (e.target.closest('.grid-thumb') && !card.classList.contains('placeholder-img')) {
                openLightboxUnified(card.querySelector('img.grid-thumb'), id);
                return;
            }
            // The subtitle is plain text here too, as in the list: it reads as part of the title and no longer closes the card.
            if (!e.target.closest('.grid-extra, .grid-subtitle')) _gridSelect(null);
            return;
        }
        _gridSelectFromClick(id);
    });
    // Keyboard: Enter or Space on a focused card toggles it.
    gridView.addEventListener('keydown', (e) => {
        const card = e.target.closest && e.target.closest('.grid-card');
        if (!card || e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation();
        _gridSelectFromClick(card.getAttribute('data-id'));
    });
    // A click on a card must not focus it: focusing scrolls a partly hidden card into view, which read as the grid jumping on selection. Keyboard focus (Tab) is unaffected, and text in the detail stays selectable.
    gridView.addEventListener('mousedown', (e) => {
        const card = e.target.closest('.grid-card');
        if (card && !e.target.closest('.grid-extra, a')) e.preventDefault();
    });
    const _onGridScroll = () => {
        _scheduleTagCloudUpdate(false);
        _gridRefreshImages(true);
    };
    gridView.addEventListener('scroll', _onGridScroll, { passive: true });
    // While the grid is the active view the DOCUMENT scrolls, not #grid-view (see _installBodyScrollProxy), and scroll events don't bubble up to it from the document, so the listener above went silent and the higher image tiers stopped being requested on scroll.
    document.addEventListener('scroll', () => {
        if (document.body.classList.contains('grid-view')) _onGridScroll();
    }, { passive: true });
    // Width changes come from the window and from the tag pane appearing or going; both re-run the layout.
    if (typeof ResizeObserver === 'function') {
        let _gridLastW = 0;
        new ResizeObserver(() => {
            const w = _gridInner.clientWidth;
            if (w === _gridLastW) return;
            _gridLastW = w;
            _scheduleGridLayout();
        }).observe(_gridInner);
    }
    // The column count follows the window width; resize can cross a step even where the inner width happens to settle equal.
    window.addEventListener('resize', _scheduleGridLayout);
    // Late web fonts re-wrap the titles.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(_scheduleGridLayout).catch(() => {});
}
