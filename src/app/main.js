/* ══ MAIN ══════════════════════════════════════════════════════════════════════
   Loaded last: fetches items.json, prepares the collection and shows the first view. Everything it calls is
   defined in the files before it. */

fetch('items.json')
    .then(r => r.json())
    .then(async data => {
        items = hydrate(data);
        // The small tier travels inside items.json, so aspect ratios, no-image
        // verdicts and stub colours are known synchronously here. There is no
        // second request to race, and the first paint already has all three.
        _ingestItemImages(items);
        _applyImageBundle(items);

        await _yieldToBrowser();

        // ---- Map positions ----
        // Computed by prepare.js and carried in items.json as umap_x / umap_y; all that is
        // left is to seed the display positions the breathing layout works from.
        for (let i = 0; i < items.length; i++) {
            items[i]._dx = items[i].umap_x;
            items[i]._dy = items[i].umap_y;
        }
        await _yieldToBrowser();

        // Compute attraction matrix for monad view
        attractionMatrix = computeAttraction(items);


        // Precompute ALL pairwise cos/sin for monad view (N² values, <2ms for 100 items)
        // This avoids per-frame trig when switching monads
        _pairCos = {};
        _pairSin = {};
        for (const a of items) {
            _pairCos[a.id] = {};
            _pairSin[a.id] = {};
            for (const b of items) {
                if (a.id === b.id) continue;
                const angle = getRelativeAngle(b, a);
                _pairCos[a.id][b.id] = Math.cos(angle);
                _pairSin[a.id][b.id] = Math.sin(angle);
            }
        }

        // Precompute the full monad class state per (centre, peripheral) pair, so setupMonadClasses() is a pure write loop: item._mc[centerId] = { cls, att, imgScale, isLow }, plus per-centre linked id arrays reused by updateMonadView.
        {
            const _itemById = _getTagItemById();
            // Pre-build normalised linked-id arrays and sets per center item (once)
            _preLinkedIds = {};
            _preLinkedSet = {};
            for (const it of items) {
                const ids = (it.links || [])
                    .map(x => (x || '').toString().trim())
                    .filter(id => id && id !== it.id && _itemById[id]);
                _preLinkedIds[it.id] = [...new Set(ids)];
                _preLinkedSet[it.id] = new Set(_preLinkedIds[it.id]);
            }
            for (const a of items) {
                a._mc = {};
            }
            // For each possible center, compute peripheral state
            for (const center of items) {
                const attRow = attractionMatrix[center.id];
                const linkedSet = _preLinkedSet[center.id];

                const ring = _monadRingMembers(center.id);
                for (const p of items) {
                    if (p.id === center.id) continue;
                    const att = (attRow && attRow[p.id]) || 0;
                    const isLinked = linkedSet.has(p.id);
                    const isLow = !ring.has(p.id);
                    let cls = '';
                    if (isLinked) cls = ' monad-linked monad-show-label';
                    if (isLow) cls += ' monad-low';
                    const baseScale = 0.022 + att * 0.063;   // attraction-based monad scale, static during zoom
                    const imgScale = isLow ? 0 : (isLinked ? Math.max(baseScale, 0.04) : baseScale);
                    p._mc[center.id] = { cls, att, imgScale, isLow };
                }
            }
        }
        await _yieldToBrowser();

        // Per-(centre, peripheral) radial t, normalised per centre so the visible peripherals spread across the full
        // inner-to-outer ring even when similarities cluster in a narrow band.
        _pairRadialT = {};
        for (const center of items) {
            const attRow = attractionMatrix[center.id];
            const row = {};
            // Pass 1: find simMin / simMax across visible peripherals
            let simMin = Infinity;
            let simMax = -Infinity;
            for (const p of items) {
                if (p.id === center.id) continue;
                const mc = p._mc[center.id];
                if (!mc || mc.isLow) continue;
                const sim = (attRow && attRow[p.id]) || 0;
                if (sim < simMin) simMin = sim;
                if (sim > simMax) simMax = sim;
            }
            const range = simMax - simMin;
            // Pass 2: assign t. Visible items use per-center normalization; hidden items use global fallback.
            for (const p of items) {
                if (p.id === center.id) continue;
                const mc = p._mc[center.id];
                const sim = (attRow && attRow[p.id]) || 0;
                let t;
                if (mc && !mc.isLow) {
                    if (range > 1e-6) {
                        t = (simMax - sim) / range;
                    } else {
                        // Degenerate case: all visible items have identical similarity. Place them mid-ring.
                        t = 0.5;
                    }
                } else {
                    t = 1 - _clamp01(sim);
                }
                row[p.id] = t;
            }
            _pairRadialT[center.id] = row;
        }
        await _yieldToBrowser();

        // Monad angular breathing. The natural angles are UMAP directions from the centre to each peripheral, and since
        // the peripherals ARE the centre's UMAP neighbourhood they arrive as a clump or two rather than a ring, which is
        // what crowds the zoom-0 overview.
        {
            const TWO_PI = 2 * Math.PI;

            for (const center of items) {
                // Visible peripherals only (linked + above-threshold + within cap); hidden ones keep
                // their natural angle, since they render at scale 0.
                const vis = [];
                for (const p of items) {
                    if (p.id === center.id) continue;
                    const mc = p._mc[center.id];
                    if (!mc || mc.isLow) continue;
                    const natAngle = Math.atan2(_pairSin[center.id][p.id], _pairCos[center.id][p.id]);
                    vis.push({ id: p.id, natAngle });
                }
                if (vis.length < 2) continue;

                // Sort by natural angle to fix the rank order. Ties broken by id for determinism.
                vis.sort((a, b) => (a.natAngle - b.natAngle) || (a.id < b.id ? -1 : 1));
                const N = vis.length;
                const step = TWO_PI / N;

                // Rotation of the even ring: the circular mean of each item's offset from its slot,
                // i.e. the orientation that moves the set as little as possible.
                let sx = 0, sy = 0;
                for (let i = 0; i < N; i++) {
                    const off = vis[i].natAngle - i * step;
                    sx += Math.cos(off);
                    sy += Math.sin(off);
                }
                const theta0 = Math.atan2(sy, sx);

                for (let i = 0; i < N; i++) {
                    let d = (theta0 + i * step) - vis[i].natAngle;
                    if (d > Math.PI) d -= TWO_PI;
                    else if (d < -Math.PI) d += TWO_PI;
                    const angle = vis[i].natAngle + MONAD_ANGULAR_SPREAD * d;
                    _pairCos[center.id][vis[i].id] = Math.cos(angle);
                    _pairSin[center.id][vis[i].id] = Math.sin(angle);
                }
            }
        }
        await _yieldToBrowser();

        // Suppress article and image transitions during the first paint, or items slide in from the CSS default
        // origin instead of appearing in place. (_applyImageBundle has already set item._isPlaceholderImg, so the
        // views built below get the placeholder-img class from the start.)
        document.body.classList.add('notransition');

        // Check for hash on load
        handleHashChange(true);

        // Force an initial layout so the map isn't empty until first interaction
        if (!_isPanelView()) update();

        // Web fonts arriving after first layout change the measured title height that monad centring derives from, so reconcile once fonts settle if the page loaded straight into a monad.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                if (viewMode === 'monad' && selectedMonadId) _monadReconcileLayout(selectedMonadId);
            }).catch(() => {});
        }

        // Listen for hash changes (browser back/forward): always animated
        window.addEventListener('hashchange', () => handleHashChange(false));

        // Transitions come back, and the loading overlay goes, once layout and paint have committed: two rAFs, or
        // five when a phone boots into a filtered list, so the overlay also hides the list's sizing pause and snap.
        const _a = _parseAddress();
        const _isMobileListHashLoad = isMobile && viewMode === 'list' && !!(_a.i || _a.t || _a.q || _a.y);
        const _waitFrames = (n, cb) => {
            if (n <= 0) return cb();
            requestAnimationFrame(() => _waitFrames(n - 1, cb));
        };
        _waitFrames(_isMobileListHashLoad ? 5 : 2, () => {
            // Also clears any stray `animated` class so the next frame doesn't animate from (0,0).
            document.body.classList.remove('notransition');
            document.body.classList.remove('animated', 'stagger-reveal');
            _setLoading(false);
            // The greeting, on a first sight of the atlas and nothing else (see _maybeShowWelcome). After the
            // loading overlay, so it lands on the atlas rather than on top of the spinner.
            _maybeShowWelcome();
            // Defensive post-boot sweep: booting into a parameterised view (#q:, #tag, #id) puts items into hidden states that can strip src on mobile, and a later return to the unfiltered map can miss some. No-op when healthy.
            _scheduleImageHealthSweep(600);
        });
    })
    .catch(err => { console.error(err); _setLoading(false); });

// First paint of the (still empty) map while items.json loads. update() also writes the initial --zoom.
update();
_netRequestDraw(0);
