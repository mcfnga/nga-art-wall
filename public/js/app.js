/* Art Wall: scrolling columns of NGA paintings with a detail view.
 *
 * URL options:
 *   ?speed=28   auto-scroll speed in pixels per second (default 28)
 *   ?cols=6     force a number of columns (default: based on screen width)
 *   ?idle=120   seconds without touch before the detail view closes (0 = never)
 *   ?kiosk=1    show the NGA.gov address as text instead of a link, so visitors
 *               cannot navigate away from the wall
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const num = (key, fallback) => {
    const v = parseFloat(params.get(key));
    return Number.isFinite(v) ? v : fallback;
  };
  const SPEED = num('speed', 28);
  const FORCE_COLS = num('cols', 0);
  const IDLE_SECONDS = num('idle', 120);
  const KIOSK = params.get('kiosk') === '1';
  const GAP = 10;            // keep in sync with --gap in style.css
  const TILE_PX = 400;       // IIIF size requested for wall tiles and similar works
  const FOCUS_PX = 1200;     // IIIF size requested for the enlarged painting
  const DRAG_THRESHOLD = 8;  // pixels of movement before a touch counts as a drag

  const wall = document.getElementById('wall');
  const hint = document.getElementById('hint');
  const statusEl = document.getElementById('status');
  const modal = document.getElementById('modal');
  const ring = document.getElementById('ring');
  const el = (id) => document.getElementById(id);

  let data = null;
  let items = [];
  let deck = [];
  const broken = new Set(); // item indexes whose image failed to load
  let columns = [];
  let paused = false;

  /* ---------- data ---------- */

  const imageUrl = (item, px) => `${data.iiifBase}${item.u}/full/!${px},${px}/0/default.jpg`;
  const pageUrl = (item) => data.pageUrl.replace('{id}', item.id);
  const altText = (item) => (item.a ? `${item.t}, ${item.a}` : item.t);

  function nextIndex() {
    for (let guard = 0; guard < items.length * 2; guard++) {
      if (!deck.length) {
        deck = items.map((_, i) => i);
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [deck[i], deck[j]] = [deck[j], deck[i]];
        }
      }
      const idx = deck.pop();
      if (!broken.has(idx)) return idx;
    }
    return 0;
  }

  /* ---------- wall ---------- */

  function columnCount() {
    if (FORCE_COLS >= 1) return Math.round(FORCE_COLS);
    return Math.max(2, Math.min(12, Math.round(window.innerWidth / 250)));
  }

  function buildWall() {
    wall.textContent = '';
    const n = columnCount();
    columns = [];
    for (let i = 0; i < n; i++) {
      const colEl = document.createElement('div');
      colEl.className = 'col';
      const track = document.createElement('div');
      track.className = 'track';
      colEl.appendChild(track);
      wall.appendChild(colEl);
      const col = {
        el: colEl,
        track,
        tiles: [],             // top to bottom; each { el, idx, top, h }
        offset: 0,             // translateY of the track
        dir: i % 2 === 0 ? -1 : 1, // even columns move up, odd columns move down
        speed: SPEED * (0.85 + 0.3 * Math.random()),
        v: 0,
        drag: null,
      };
      col.v = col.dir * col.speed;
      columns.push(col);
      attachDrag(col);
    }
    for (const col of columns) fill(col);
  }

  function makeTile(col, idx) {
    const item = items[idx];
    const width = col.el.clientWidth || 200;
    const aspect = Math.max(0.55, Math.min(1.9, item.h / item.w));
    const tile = document.createElement('div');
    tile.className = 'tile';
    const h = Math.round(width * aspect);
    tile.style.height = h + 'px';
    const img = new Image();
    img.alt = altText(item);
    img.decoding = 'async';
    img.draggable = false;
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => { broken.add(idx); swapTile(col, t); };
    img.src = imageUrl(item, TILE_PX);
    tile.appendChild(img);
    const t = { el: tile, idx, top: 0, h };
    return t;
  }

  // A tile whose image failed gets a different artwork of the same size.
  function swapTile(col, t) {
    if (!col.tiles.includes(t) || broken.size >= items.length) return;
    const idx = nextIndex();
    const item = items[idx];
    const img = t.el.querySelector('img');
    t.idx = idx;
    img.alt = altText(item);
    img.onerror = () => { broken.add(idx); setTimeout(() => swapTile(col, t), 400); };
    img.src = imageUrl(item, TILE_PX);
  }

  // Keep the column covered from one screen-margin above to one below.
  function fill(col) {
    const H = window.innerHeight;
    const margin = Math.max(300, H * 0.35);
    const tiles = col.tiles;

    if (!tiles.length) {
      const t = makeTile(col, nextIndex());
      t.top = -margin * Math.random();
      place(col, t, true);
    }
    // add below
    while (tiles[tiles.length - 1].top + tiles[tiles.length - 1].h + col.offset < H + margin) {
      const last = tiles[tiles.length - 1];
      const t = makeTile(col, nextIndex());
      t.top = last.top + last.h + GAP;
      place(col, t, true);
    }
    // add above
    while (tiles[0].top + col.offset > -margin) {
      const first = tiles[0];
      const t = makeTile(col, nextIndex());
      t.top = first.top - GAP - t.h;
      place(col, t, false);
    }
    // remove far above / far below
    while (tiles.length > 1 && tiles[0].top + tiles[0].h + col.offset < -margin * 1.5) {
      tiles.shift().el.remove();
    }
    while (tiles.length > 1 && tiles[tiles.length - 1].top + col.offset > H + margin * 1.5) {
      tiles.pop().el.remove();
    }
    // keep numbers small on screens that run for days
    if (Math.abs(col.offset) > 50000) {
      for (const t of tiles) { t.top += col.offset; t.el.style.top = t.top + 'px'; }
      col.offset = 0;
    }
  }

  function place(col, t, atEnd) {
    t.el.style.top = t.top + 'px';
    t.el._tile = t;
    if (atEnd) { col.tiles.push(t); col.track.appendChild(t.el); }
    else { col.tiles.unshift(t); col.track.prepend(t.el); }
  }

  let lastFrame = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0);
    lastFrame = now;
    if (paused || !columns.length) return;
    for (const col of columns) {
      if (!col.drag) {
        // ease back to the cruising speed after a flick
        const target = col.dir * col.speed;
        col.v += (target - col.v) * (1 - Math.exp(-dt * 1.6));
        col.offset += col.v * dt;
      }
      fill(col);
      col.track.style.transform = `translate3d(0,${col.offset.toFixed(2)}px,0)`;
    }
  }

  /* ---------- touch: drag a column, or tap a painting ---------- */

  function attachDrag(col) {
    const c = col.el;
    c.addEventListener('pointerdown', (e) => {
      if (col.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
      col.drag = {
        id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp,
        moved: false, v: 0, target: e.target.closest('.tile'),
      };
      try { c.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      hideHint();
    });
    c.addEventListener('pointermove', (e) => {
      const d = col.drag;
      if (!d || d.id !== e.pointerId) return;
      if (!d.moved && Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD) {
        d.moved = true;
        c.classList.add('dragging');
      }
      if (d.moved) {
        const dy = e.clientY - d.lastY;
        const dtp = Math.max(1, e.timeStamp - d.lastT) / 1000;
        col.offset += dy;
        d.v = 0.7 * (dy / dtp) + 0.3 * d.v;
      }
      d.lastY = e.clientY;
      d.lastT = e.timeStamp;
    });
    const end = (e, cancelled) => {
      const d = col.drag;
      if (!d || d.id !== e.pointerId) return;
      col.drag = null;
      c.classList.remove('dragging');
      if (d.moved) {
        const stale = e.timeStamp - d.lastT > 80; // finger rested before lifting
        col.v = stale ? 0 : Math.max(-4000, Math.min(4000, d.v));
      } else if (!cancelled && d.target && d.target._tile) {
        openModal(d.target._tile.idx);
      }
    };
    c.addEventListener('pointerup', (e) => end(e, false));
    c.addEventListener('pointercancel', (e) => end(e, true));
  }

  function hideHint() { hint.classList.add('off'); }

  /* ---------- detail view ---------- */

  // Border cells of the 4 x 4 grid, clockwise from the top-left corner: [row, column]
  const RING_CELLS = [
    [1, 1], [1, 2], [1, 3], [1, 4], [2, 4], [3, 4],
    [4, 4], [4, 3], [4, 2], [4, 1], [3, 1], [2, 1],
  ];
  const simButtons = RING_CELLS.map(([r, c]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sim';
    b.style.gridArea = `${r} / ${c}`;
    b.hidden = true;
    b.appendChild(new Image());
    b.addEventListener('click', () => {
      if (b._idx != null) { history.push(current); showArtwork(b._idx); }
    });
    ring.appendChild(b);
    return b;
  });

  let current = null;
  let history = [];
  let idleTimer = 0;
  let showToken = 0;

  function openModal(idx) {
    history = [];
    paused = true;
    modal.hidden = false;
    void modal.offsetWidth; // let the fade-in transition run
    modal.classList.add('open');
    showArtwork(idx);
    el('m-close').focus({ preventScroll: true });
  }

  function closeModal() {
    if (modal.hidden) return;
    clearTimeout(idleTimer);
    modal.classList.remove('open');
    paused = false;
    current = null;
    setTimeout(() => { if (!modal.classList.contains('open')) modal.hidden = true; }, 300);
  }

  function showArtwork(idx) {
    const item = items[idx];
    const token = ++showToken;
    current = idx;
    resetIdle();

    el('m-artist').textContent = item.a || 'Artist unknown';
    el('m-title').textContent = item.t;
    el('m-date').textContent = item.d || 'Not recorded';
    el('m-credit').textContent = item.c || 'Not recorded';
    const urlCell = el('m-url');
    urlCell.textContent = '';
    const url = pageUrl(item);
    const shown = url.replace(/^https?:\/\/(www\.)?/, '');
    if (KIOSK) {
      urlCell.textContent = shown;
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = shown;
      urlCell.appendChild(a);
    }
    el('m-back').hidden = history.length === 0;

    // painting: show the small version straight away, then sharpen
    const img = el('m-img');
    img.classList.add('swap');
    img.alt = altText(item);
    const small = imageUrl(item, TILE_PX);
    const large = imageUrl(item, FOCUS_PX);
    const reveal = () => { if (token === showToken) img.classList.remove('swap'); };
    img.onload = reveal;
    img.onerror = reveal;
    img.src = small;
    const hi = new Image();
    hi.onload = () => { if (token === showToken) { img.onload = null; img.src = large; reveal(); } };
    hi.src = large;

    // up to 12 visually similar works around it
    const similar = (item.s || []).filter((i) => items[i] && !broken.has(i)).slice(0, simButtons.length);
    simButtons.forEach((b, n) => {
      const simIdx = similar[n];
      b.classList.remove('in');
      if (simIdx == null) { b.hidden = true; b._idx = null; return; }
      const sim = items[simIdx];
      const im = b.firstChild;
      b.hidden = false;
      b._idx = simIdx;
      b.setAttribute('aria-label', `Similar painting: ${altText(sim)}`);
      im.alt = '';
      im.onload = () => { if (token === showToken) setTimeout(() => b.classList.add('in'), 40 * n); };
      im.onerror = () => { if (token === showToken) { b.hidden = true; b._idx = null; } };
      im.src = imageUrl(sim, TILE_PX);
    });
    el('m-simnote').textContent = similar.length
      ? 'Surrounding paintings share similar colors and composition. Touch one to explore.'
      : '';
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (IDLE_SECONDS > 0 && !modal.hidden) idleTimer = setTimeout(closeModal, IDLE_SECONDS * 1000);
  }

  el('m-close').addEventListener('click', closeModal);
  el('m-back').addEventListener('click', () => {
    if (history.length) showArtwork(history.pop());
  });
  modal.addEventListener('pointerdown', resetIdle);
  // touching the dark background (not the painting, details or a similar work) closes the view
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target === ring) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  /* ---------- housekeeping ---------- */

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS pinch zoom
  document.addEventListener('visibilitychange', () => { lastFrame = performance.now(); });

  let resizeTimer = 0;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!items.length || window.innerWidth === lastWidth) return; // height-only changes need no rebuild
      lastWidth = window.innerWidth;
      buildWall();
    }, 250);
  });

  async function start() {
    statusEl.textContent = 'Loading paintings…';
    try {
      const res = await fetch('data/artworks.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      items = (data.items || []).filter((it) => it && it.u && it.w && it.h);
      if (!items.length) throw new Error('no artworks in data file');
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'The artwork list could not be loaded. Check the connection and reload.';
      return;
    }
    statusEl.textContent = '';
    buildWall();
    requestAnimationFrame(frame);
    setTimeout(hideHint, 12000);
  }

  start();
})();
