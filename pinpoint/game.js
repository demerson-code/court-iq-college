// Pinpoint — click the map, find the country.
//
// Rules (see index.html for the player-facing wording):
//   * Each round names a country. Click where you think it is.
//   * Click anywhere inside the country, or within BULLSEYE_MI of its
//     capital, for the full MAX_PTS. Otherwise points fall off linearly with
//     the distance (in miles) from your pin to the capital, hitting 0 at
//     ZERO_AT_MI.
//   * Every round has a score bar you must reach to advance. The bar rises
//     each round, and later rounds draw from more obscure countries.
//   * Miss the bar and the game is over. Score = total points banked.
//
// No build step, no framework. `window.PP` exposes the pure pieces for tests.

(function () {
  'use strict';

  // ---- tunables ---------------------------------------------------------
  const MAX_PTS = 5000;
  const ZERO_AT_MI = 2500;     // 0 points at this distance or more
  const BULLSEYE_MI = 25;      // within this of the capital = full points
  const BAR_START = 500;       // points needed in round 1
  const BAR_STEP = 250;        // added each round
  const BAR_CAP = 4750;        // never asks for more than this (125 mi)
  const EARTH_MI = 3958.8;
  const BEST_KEY = 'pinpoint_best_v1';

  // ---- map geometry -----------------------------------------------------
  // Natural Earth projection (Šavrič et al., the d3-geo polynomial), cropped
  // to the inhabited band. "Map units" are pixels at zoom 1 of a reference
  // canvas 3600 units wide.
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const LAT_MAX = 84, LAT_MIN = -58;
  function neRaw(lam, phi) {
    const p2 = phi * phi, p4 = p2 * p2;
    return [lam * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
            phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)))];
  }
  function neInvert(x, y) {
    let phi = y, i = 25, d;
    do {
      const p2 = phi * phi, p4 = p2 * p2;
      d = (phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))) - y) /
          (1.007226 + p2 * (0.015085 * 3 + p4 * (-0.044475 * 7 + 0.028874 * 9 * p2 - 0.005916 * 11 * p4)));
      phi -= d;
    } while (Math.abs(d) > 1e-7 && --i > 0);
    const p2 = phi * phi, p4 = p2 * p2;
    return [x / (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))), phi];
  }
  const XMAX = neRaw(Math.PI, 0)[0];
  const YTOP = neRaw(0, LAT_MAX * D2R)[1], YBOT = neRaw(0, LAT_MIN * D2R)[1];
  const K = 3600 / (2 * XMAX);
  const MW = 2 * XMAX * K, MH = (YTOP - YBOT) * K;
  // lon/lat degrees -> map units
  function proj(lon, lat) {
    const [x, y] = neRaw(lon * D2R, lat * D2R);
    return [(x + XMAX) * K, (YTOP - y) * K];
  }
  // map units -> [lon, lat] degrees, or null when outside the drawn globe
  function unproj(x, y) {
    const [lam, phi] = neInvert(x / K - XMAX, YTOP - y / K);
    const lon = lam * R2D, lat = phi * R2D;
    if (!(lon >= -180 && lon <= 180 && lat >= LAT_MIN && lat <= LAT_MAX)) return null;
    return [lon, lat];
  }
  // ---- pure helpers (exposed on window.PP) ------------------------------
  function haversineMi(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function pointsFor(distMi, inside) {
    if (inside || distMi <= BULLSEYE_MI) return MAX_PTS;
    const frac = Math.max(0, 1 - distMi / ZERO_AT_MI);
    return Math.round(frac * MAX_PTS / 10) * 10;
  }

  function barFor(round) {
    return Math.min(BAR_CAP, BAR_START + BAR_STEP * (round - 1));
  }

  // Distance that scores exactly `pts` — shown so players know the margin.
  function milesForPoints(pts) {
    return Math.round((1 - pts / MAX_PTS) * ZERO_AT_MI);
  }

  function tiersFor(round) {
    if (round <= 5) return [1];
    if (round <= 12) return [1, 2];
    return [1, 2, 3];
  }

  // Even-odd ray cast over every ring of every polygon in the country.
  function pointInRings(lon, lat, polys) {
    let inside = false;
    for (const poly of polys) for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) &&
            lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  // Split a ring wherever it jumps across the 180° meridian, closing each
  // piece along the map edge. Without this, Russia's far east and Fiji draw
  // a stroke straight across the map.
  function splitAntimeridian(ring) {
    const out = [];
    let cur = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (i > 0) {
        const q = ring[i - 1];
        if (Math.abs(p[0] - q[0]) > 180) {
          const edge = q[0] > 0 ? 180 : -180;
          const f = Math.abs(edge - q[0]) / Math.max(1e-9, Math.abs(edge - q[0]) + Math.abs(-edge - p[0]));
          const lat = q[1] + (p[1] - q[1]) * f;
          cur.push([edge, lat]);
          out.push(cur);
          cur = [[-edge, lat]];
        }
      }
      cur.push(p);
    }
    if (!out.length) return [ring];
    out[0] = cur.concat(out[0]);
    return out;
  }

  // Minimal TopoJSON decoder — only what world-atlas needs.
  function decodeTopo(topo) {
    const { scale, translate } = topo.transform;
    const arcs = topo.arcs.map((arc) => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => {
        x += dx; y += dy;
        return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
      });
    });
    const ring = (idxs) => {
      const pts = [];
      for (const i of idxs) {
        let a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
        if (pts.length) a = a.slice(1);
        for (const p of a) pts.push(p);
      }
      return pts;
    };
    return topo.objects.countries.geometries.map((g) => {
      const raw = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
      const polys = raw.map((p) => p.flatMap((idxs) => splitAntimeridian(ring(idxs))));
      return { name: g.properties.name, polys };
    });
  }

  window.PP = { haversineMi, pointsFor, barFor, milesForPoints, tiersFor, pointInRings, decodeTopo,
    MAX_PTS, ZERO_AT_MI, BULLSEYE_MI };

  // ---- DOM --------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const ui = {
    round: $('hudRound'), score: $('hudScore'), best: $('hudBest'),
    barNeed: $('hudBarNeed'), barMiles: $('hudBarMiles'),
    prompt: $('prompt'), promptName: $('promptName'), promptSub: $('promptSub'),
    result: $('result'), resTitle: $('resTitle'), resDetail: $('resDetail'),
    resPts: $('resPts'), resFill: $('resFill'), resNeed: $('resNeed'), resBtn: $('resBtn'),
    start: $('start'), startBtn: $('startBtn'), startBest: $('startBest'),
    over: $('over'), overScore: $('overScore'), overRounds: $('overRounds'),
    overWhy: $('overWhy'), overBest: $('overBest'), overBtn: $('overBtn'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'),
  };

  // ---- data -------------------------------------------------------------
  const countries = decodeTopo(window.WORLD_TOPO);
  const byName = new Map(countries.map((c) => [c.name, c]));
  for (const c of countries) {
    c.path = new Path2D();
    for (const poly of c.polys) for (const ring of poly) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = proj(lon, lat);
        if (i === 0) c.path.moveTo(x, y); else c.path.lineTo(x, y);
      });
      c.path.closePath();
    }
    // bounding box in map units, used to frame the country after a guess
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of c.polys) for (const ring of poly) for (const [lon, lat] of ring) {
      const [x, y] = proj(lon, lat);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    c.bbox = [[x0, y0], [x1, y1]];
  }
  // Outline of the drawn globe: top edge, right meridian, bottom edge, left meridian.
  const seaPath = new Path2D();
  (function () {
    const pt = (lon, lat, first) => { const [x, y] = proj(lon, lat); first ? seaPath.moveTo(x, y) : seaPath.lineTo(x, y); };
    for (let lon = -180; lon <= 180; lon += 2) pt(lon, LAT_MAX, lon === -180);
    for (let lat = LAT_MAX; lat >= LAT_MIN; lat -= 1) pt(180, lat);
    for (let lon = 180; lon >= -180; lon -= 2) pt(lon, LAT_MIN);
    for (let lat = LAT_MIN; lat <= LAT_MAX; lat += 1) pt(-180, lat);
    seaPath.closePath();
  })();
  const gratPath = new Path2D();
  (function () {
    for (let lon = -150; lon <= 150; lon += 30) for (let lat = LAT_MIN; lat <= LAT_MAX; lat += 2) {
      const [x, y] = proj(lon, lat); lat === LAT_MIN ? gratPath.moveTo(x, y) : gratPath.lineTo(x, y);
    }
    for (let lat = -30; lat <= 60; lat += 30) for (let lon = -180; lon <= 180; lon += 2) {
      const [x, y] = proj(lon, lat); lon === -180 ? gratPath.moveTo(x, y) : gratPath.lineTo(x, y);
    }
  })();

  const ROSTER = window.COUNTRIES.map(([mapName, name, capital, lat, lon, tier]) => {
    const geo = byName.get(mapName);
    if (!geo) console.warn('Pinpoint: no map shape for', mapName);
    return { mapName, name, capital, lat, lon, tier, geo };
  }).filter((c) => c.geo);

  // ---- state ------------------------------------------------------------
  const G = {
    phase: 'start',      // start | guess | result | over
    round: 0, score: 0, used: new Set(), target: null,
    guess: null,         // {lat, lon, mi, pts, inside}
    best: loadBest(),
  };

  function loadBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY)) || { score: 0, rounds: 0 }; }
    catch { return { score: 0, rounds: 0 }; }
  }
  function saveBest() {
    try { localStorage.setItem(BEST_KEY, JSON.stringify(G.best)); } catch { /* private mode */ }
  }

  // ---- view (zoom / pan) ------------------------------------------------
  const V = { s: 1, ox: 0, oy: 0, sMin: 1, sMax: 16, w: 0, h: 0, dpr: 1 };

  function resize() {
    const r = canvas.getBoundingClientRect();
    V.w = r.width; V.h = r.height;
    V.dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(V.w * V.dpr);
    canvas.height = Math.round(V.h * V.dpr);
    const prevMin = V.sMin;
    V.sMin = Math.min(V.w / MW, V.h / MH);
    V.sMax = V.sMin * 24;
    if (V.s === prevMin || V.s < V.sMin) fitAll(); else clampView();
    draw();
  }

  function fitAll() {
    V.s = V.sMin;
    V.ox = (V.w - MW * V.s) / 2;
    V.oy = (V.h - MH * V.s) / 2;
  }

  function clampView() {
    V.s = Math.min(V.sMax, Math.max(V.sMin, V.s));
    const mw = MW * V.s, mh = MH * V.s;
    V.ox = mw <= V.w ? (V.w - mw) / 2 : Math.min(0, Math.max(V.w - mw, V.ox));
    V.oy = mh <= V.h ? (V.h - mh) / 2 : Math.min(0, Math.max(V.h - mh, V.oy));
  }

  function zoomAt(px, py, factor) {
    const ns = Math.min(V.sMax, Math.max(V.sMin, V.s * factor));
    const k = ns / V.s;
    V.ox = px - (px - V.ox) * k;
    V.oy = py - (py - V.oy) * k;
    V.s = ns;
    clampView();
    draw();
  }

  // Frame a set of map-unit points with padding (used after a guess).
  function fitPoints(pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const bw = Math.max(60, x1 - x0), bh = Math.max(60, y1 - y0);
    const pad = 0.28;
    V.s = Math.min(V.sMax, Math.max(V.sMin,
      Math.min(V.w / (bw * (1 + 2 * pad)), (V.h * 0.72) / (bh * (1 + 2 * pad)))));
    V.ox = V.w / 2 - ((x0 + x1) / 2) * V.s;
    V.oy = V.h * 0.42 - ((y0 + y1) / 2) * V.s;
    clampView();
  }

  const toMap = (px, py) => [(px - V.ox) / V.s, (py - V.oy) / V.s];
  const toScreen = (x, y) => [x * V.s + V.ox, y * V.s + V.oy];

  // ---- drawing ----------------------------------------------------------
  const C = {
    page: '#DCE8EE', sea: '#A9D3DF', land: '#3E8E5B', border: '#E4F2E8',
    grat: 'rgba(0,60,90,0.09)', hit: 'rgba(245,196,81,0.85)', hitStroke: '#8A5A00',
    guess: '#E0452F', capital: '#1B2A3A', line: 'rgba(27,42,58,0.7)',
  };

  function draw() {
    const { dpr, s, ox, oy, w, h } = V;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.page;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    ctx.fillStyle = C.sea;
    ctx.fill(seaPath);
    ctx.clip(seaPath);

    ctx.strokeStyle = C.grat;
    ctx.lineWidth = 1 / s;
    ctx.stroke(gratPath);

    ctx.fillStyle = C.land;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = Math.max(0.7 / s, 0.02);
    ctx.lineJoin = 'round';
    for (const c of countries) { ctx.fill(c.path); ctx.stroke(c.path); }

    if (G.phase === 'result' || G.phase === 'over') {
      const t = G.target.geo;
      ctx.fillStyle = C.hit;
      ctx.fill(t.path);
      ctx.strokeStyle = C.hitStroke;
      ctx.lineWidth = 1.5 / s;
      ctx.stroke(t.path);
    }
    ctx.restore();

    if ((G.phase === 'result' || G.phase === 'over') && G.guess) drawMarkers();
  }

  function drawMarkers() {
    const { dpr } = V;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [gx, gy] = toScreen(...proj(G.guess.lon, G.guess.lat));
    const [cx, cy] = toScreen(...proj(G.target.lon, G.target.lat));

    if (!G.guess.inside) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // capital: navy ring + dot with a white halo so it reads on gold or green
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = C.capital; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.capital;
    ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();

    drawPin(gx, gy, C.guess);
  }

  function drawPin(x, y, color) {
    // teardrop pin whose tip sits exactly on (x, y)
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(0, 1, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-3, -8, -11, -10, -11, -18);
    ctx.arc(0, -18, 11, Math.PI, 0);
    ctx.bezierCurveTo(11, -10, 3, -8, 0, 0);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(0, -18, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---- game flow --------------------------------------------------------
  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  function pickTarget() {
    const tiers = tiersFor(G.round);
    const unused = (ts) => ROSTER.filter((c) => ts.includes(c.tier) && !G.used.has(c.mapName));
    // From round 13 on, lean hard on the obscure tier.
    let pool = [];
    if (G.round >= 13 && Math.random() < 0.7) pool = unused([3]);
    if (!pool.length) pool = unused(tiers);
    if (!pool.length) pool = ROSTER.filter((c) => !G.used.has(c.mapName));
    if (!pool.length) { G.used.clear(); pool = ROSTER.slice(); }
    const t = pool[Math.floor(Math.random() * pool.length)];
    G.used.add(t.mapName);
    return t;
  }

  function startGame() {
    G.round = 0; G.score = 0; G.used = new Set(); G.guess = null;
    nextRound();
  }

  function nextRound() {
    G.round += 1;
    G.target = pickTarget();
    G.guess = null;
    G.phase = 'guess';
    fitAll();
    renderHud();
    show(ui.prompt); hide(ui.result); hide(ui.start); hide(ui.over);
    ui.promptName.textContent = G.target.name;
    ui.promptSub.textContent = `Round ${G.round} · need ${fmt(barFor(G.round))} pts`;
    draw();
    snapshot();
  }

  function handleGuess(px, py) {
    const [x, y] = toMap(px, py);
    const ll = unproj(x, y);
    if (!ll) return; // clicked the page margin, not the globe
    const [lon, lat] = ll;
    const t = G.target;
    const inside = pointInRings(lon, lat, t.geo.polys);
    const mi = haversineMi(lat, lon, t.lat, t.lon);
    const pts = pointsFor(mi, inside);
    const need = barFor(G.round);
    G.guess = { lat, lon, mi, pts, inside };
    G.score += pts;
    G.phase = pts >= need ? 'result' : 'over';

    fitPoints([proj(lon, lat), proj(t.lon, t.lat), ...t.geo.bbox]);
    draw();
    hide(ui.prompt);
    showResult(pts, need, mi, inside);
    renderHud();
    snapshot();
  }

  function showResult(pts, need, mi, inside) {
    const t = G.target;
    const passed = pts >= need;
    ui.result.classList.toggle('fail', !passed);
    ui.result.classList.toggle('bullseye', pts === MAX_PTS);
    ui.resTitle.textContent = pts === MAX_PTS
      ? (inside ? `Bullseye. That's ${t.name}.` : `Bullseye. Right on ${t.capital}.`)
      : passed ? `${t.name} — cleared.` : `${t.name} — missed the bar.`;
    ui.resDetail.textContent = inside
      ? `Your pin landed inside ${t.name}, ${fmt(mi)} mi from ${t.capital}.`
      : `Your pin was ${fmt(mi)} mi from ${t.capital}, the capital.`;
    ui.resPts.textContent = `+${fmt(pts)}`;
    ui.resNeed.textContent = `needed ${fmt(need)}`;
    ui.resFill.style.width = `${Math.min(100, (pts / MAX_PTS) * 100)}%`;
    ui.result.style.setProperty('--need', `${(need / MAX_PTS) * 100}%`);
    ui.resBtn.textContent = passed ? 'Next round' : 'See final score';
    show(ui.result);
    ui.resBtn.focus({ preventScroll: true });
  }

  function advance() {
    if (G.phase === 'result') nextRound();
    else if (G.phase === 'over') showOver();
  }

  function showOver() {
    const rounds = G.round - 1;
    const t = G.target, g = G.guess;
    const isBest = G.score > G.best.score;
    if (isBest) { G.best = { score: G.score, rounds }; saveBest(); }
    ui.overScore.textContent = fmt(G.score);
    ui.overRounds.textContent = `${rounds} round${rounds === 1 ? '' : 's'} cleared`;
    ui.overWhy.textContent =
      `${t.name} ended it: your pin was ${fmt(g.mi)} mi from ${t.capital}, ` +
      `worth ${fmt(g.pts)} points when the bar was ${fmt(barFor(G.round))}.`;
    ui.overBest.textContent = isBest
      ? 'New personal best.'
      : `Personal best: ${fmt(G.best.score)} (${G.best.rounds} rounds).`;
    hide(ui.result);
    show(ui.over);
    ui.overBtn.focus({ preventScroll: true });
    renderHud();
    snapshot();
  }

  function renderHud() {
    const need = barFor(Math.max(1, G.round));
    ui.round.textContent = G.round ? String(G.round) : '–';
    ui.score.textContent = fmt(G.score);
    ui.best.textContent = fmt(Math.max(G.best.score, G.score));
    ui.barNeed.textContent = fmt(need);
    ui.barMiles.textContent = `within ${fmt(milesForPoints(need))} mi`;
  }

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

  // ---- hot reload (artifact republish keeps the game in progress) --------
  function snapshot() {
    if (!window.claude?.hot?.snapshot) return;
    window.claude.hot.snapshot({
      phase: G.phase, round: G.round, score: G.score,
      used: [...G.used], target: G.target?.mapName, guess: G.guess,
    });
  }
  function restore(d) {
    if (!d || !d.target || !['guess', 'result', 'over'].includes(d.phase)) return false;
    const t = ROSTER.find((c) => c.mapName === d.target);
    if (!t) return false;
    G.round = d.round; G.score = d.score; G.used = new Set(d.used); G.target = t;
    G.guess = d.guess; G.phase = d.phase;
    hide(ui.start); hide(ui.over); hide(ui.result); hide(ui.prompt);
    renderHud();
    if (d.phase === 'guess') {
      fitAll();
      show(ui.prompt);
      ui.promptName.textContent = t.name;
      ui.promptSub.textContent = `Round ${G.round} · need ${fmt(barFor(G.round))} pts`;
    } else {
      fitPoints([proj(G.guess.lon, G.guess.lat), proj(t.lon, t.lat), ...t.geo.bbox]);
      showResult(G.guess.pts, barFor(G.round), G.guess.mi, G.guess.inside);
    }
    draw();
    return true;
  }

  // ---- input ------------------------------------------------------------
  const pointers = new Map();
  let drag = null;   // {x, y, ox, oy, moved}
  let pinch = null;  // {d, s, mx, my}

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, ox: V.ox, oy: V.oy, moved: false, id: e.pointerId };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: V.s };
      if (drag) drag.moved = true;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = canvas.getBoundingClientRect();
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2 - rect.left, midY = (a.y + b.y) / 2 - rect.top;
      const target = Math.min(V.sMax, Math.max(V.sMin, pinch.s * (d / pinch.d)));
      zoomAt(midX, midY, target / V.s);
      return;
    }
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
      if (drag.moved) {
        V.ox = drag.ox + dx; V.oy = drag.oy + dy;
        clampView(); draw();
      }
    }
  });

  function endPointer(e) {
    const wasTap = drag && e.pointerId === drag.id && !drag.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      if (wasTap && G.phase === 'guess' && e.type === 'pointerup') {
        const rect = canvas.getBoundingClientRect();
        handleGuess(e.clientX - rect.left, e.clientY - rect.top);
      }
      drag = null;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  }, { passive: false });

  ui.zoomIn.addEventListener('click', () => zoomAt(V.w / 2, V.h / 2, 1.6));
  ui.zoomOut.addEventListener('click', () => zoomAt(V.w / 2, V.h / 2, 1 / 1.6));
  ui.zoomFit.addEventListener('click', () => { fitAll(); draw(); });

  ui.startBtn.addEventListener('click', startGame);
  ui.resBtn.addEventListener('click', advance);
  ui.overBtn.addEventListener('click', startGame);

  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'BUTTON') return; // the focused button handles Enter/Space itself
    if (e.key === 'Enter' || e.key === ' ') {
      if (G.phase === 'result' || (G.phase === 'over' && ui.over.hidden)) { e.preventDefault(); advance(); }
      else if (G.phase === 'start') { e.preventDefault(); startGame(); }
    }
    if (e.key === '+' || e.key === '=') zoomAt(V.w / 2, V.h / 2, 1.4);
    if (e.key === '-' || e.key === '_') zoomAt(V.w / 2, V.h / 2, 1 / 1.4);
    if (e.key === '0') { fitAll(); draw(); }
  });

  window.addEventListener('resize', resize);

  // ---- boot -------------------------------------------------------------
  function boot(saved) {
    ui.startBest.textContent = G.best.score
      ? `Personal best: ${fmt(G.best.score)} points over ${G.best.rounds} rounds.`
      : `${ROSTER.length} countries. No timer. One miss ends the run.`;
    resize();
    if (!restore(saved)) { renderHud(); show(ui.start); }
  }
  if (window.claude?.hot?.ready) window.claude.hot.ready(boot);
  else boot(window.claude?.hot?.data);

  // test hooks
  window.PP.state = () => G;
  window.PP.startGame = startGame;
  window.PP.guessLatLon = (lat, lon) => {
    const [px, py] = toScreen(...proj(lon, lat));
    handleGuess(px, py);
  };
  window.PP.advance = advance;
})();
