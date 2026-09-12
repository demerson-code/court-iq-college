// Pinpoint — click the map, find the country.
//
// Rules (see index.html for the player-facing wording):
//   * Each round names a country (or, in Capitals mode, its capital city).
//     Click where you think it is.
//   * Countries mode: click anywhere inside the country, or within
//     BULLSEYE_MI of its capital, for the full MAX_PTS. Capitals mode: only
//     the BULLSEYE_MI circle counts. Otherwise points fall off linearly with
//     the distance (in miles) from your pin to the capital, hitting 0 at
//     ZERO_AT_MI.
//   * A round is PINS_PER_ROUND pins. The round's total must reach the round
//     bar to advance; the bar rises each round (AVG_START + AVG_STEP per pin,
//     capped) and the countries move from household names to deep cuts.
//   * Optional timer: ROUND_SECS per pin. Time out and that pin scores 0.
//     Clear a pin at pace with time to spare and a speed bonus (up to
//     SPEED_BONUS) is added to your total; the bonus never counts toward the bar.
//   * Miss the round bar and the game is over. Score = total points banked.
//
// No build step, no framework. `window.PP` exposes the pure pieces for tests.

(function () {
  'use strict';

  // ---- tunables ---------------------------------------------------------
  const MAX_PTS = 5000;
  const ZERO_AT_MI = 2500;     // 0 points at this distance or more
  const BULLSEYE_MI = 25;      // within this of the capital = full points
  const PINS_PER_ROUND = 7;
  const AVG_START = 1500;      // round 1: average points per pin needed (within 1,750 mi)
  const AVG_STEP = 500;        // added to the per-pin pace each round
  const AVG_CAP = 4600;        // never asks for more than this per pin (200 mi)
  const MAX_DIFFICULTY = 5;    // countries.js ranks 1 (household names) .. 5 (deep cuts)
  const ROUND_SECS = 12;       // timer mode: seconds per pin
  const SPEED_BONUS = 1000;    // timer mode: max bonus for an instant answer
  const EARTH_MI = 3958.8;
  const BEST_KEY = 'pinpoint_best_v1';
  const PREFS_KEY = 'pinpoint_prefs_v1';
  const NAME_KEY = 'pinpoint_name_v1';
  const BOARD_KEY = 'pinpoint_board_v1';

  const REGIONS = { world: 'World', EU: 'Europe', AM: 'Americas', AF: 'Africa', AP: 'Asia & Pacific' };
  const DIFF_LABELS = { 1: 'Household names', 2: 'Well known', 3: 'Getting harder', 4: 'Obscure', 5: 'Deep cuts' };

  // ---- map geometry -----------------------------------------------------
  // Web Mercator (the Google Maps projection), cropped to the inhabited band.
  // "Map units" are pixels at zoom 1 of a reference canvas 3600 units wide.
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const LAT_MAX = 84, LAT_MIN = -58;
  function mercRaw(lam, phi) {
    return [lam, Math.log(Math.tan(Math.PI / 4 + phi / 2))];
  }
  function mercInvert(x, y) {
    return [x, 2 * Math.atan(Math.exp(y)) - Math.PI / 2];
  }
  const XMAX = Math.PI;
  const YTOP = mercRaw(0, LAT_MAX * D2R)[1], YBOT = mercRaw(0, LAT_MIN * D2R)[1];
  const K = 3600 / (2 * XMAX);
  const MW = 2 * XMAX * K, MH = (YTOP - YBOT) * K;
  // lon/lat degrees -> map units
  function proj(lon, lat) {
    const [x, y] = mercRaw(lon * D2R, Math.max(LAT_MIN, Math.min(LAT_MAX, lat)) * D2R);
    return [(x + XMAX) * K, (YTOP - y) * K];
  }
  // map units -> [lon, lat] degrees, or null when outside the drawn globe
  function unproj(x, y) {
    const [lam, phi] = mercInvert(x / K - XMAX, YTOP - y / K);
    const lon = lam * R2D, lat = phi * R2D;
    if (!(lon >= -180 && lon <= 180 && lat >= LAT_MIN && lat <= LAT_MAX)) return null;
    return [lon, lat];
  }
  // radius in map units of a circle of `mi` miles around a point at `lat`
  // (Mercator is conformal, so a circle stays a circle, scaled by sec(lat))
  function milesToMapUnits(mi, lat) {
    return (mi / EARTH_MI) * K / Math.cos(lat * D2R);
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

  // Per-pin pace the round is judged at, and the round total it implies.
  function avgNeedFor(round) {
    return Math.min(AVG_CAP, AVG_START + AVG_STEP * (round - 1));
  }
  function barFor(round) {
    return avgNeedFor(round) * PINS_PER_ROUND;
  }

  // Distance that scores exactly `pts` — shown so players know the margin.
  function milesForPoints(pts) {
    return Math.round((1 - pts / MAX_PTS) * ZERO_AT_MI);
  }

  function difficultyFor(round) {
    return Math.min(MAX_DIFFICULTY, round);
  }

  // Timer mode: bonus for seconds left, only on a pin that kept pace.
  function speedBonus(secsLeft) {
    return Math.round(Math.max(0, Math.min(1, secsLeft / ROUND_SECS)) * SPEED_BONUS / 10) * 10;
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

  window.PP = { haversineMi, pointsFor, barFor, avgNeedFor, difficultyFor, milesForPoints, speedBonus, pointInRings, decodeTopo,
    MAX_PTS, ZERO_AT_MI, BULLSEYE_MI, ROUND_SECS, PINS_PER_ROUND, REGIONS };

  // ---- DOM --------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const ui = {
    round: $('hudRound'), score: $('hudScore'), best: $('hudBest'),
    barNeed: $('hudBarNeed'), barMiles: $('hudBarMiles'), hudMode: $('hudMode'),
    prompt: $('prompt'), promptEyebrow: $('promptEyebrow'), promptName: $('promptName'),
    promptSub: $('promptSub'), promptTimer: $('promptTimer'), promptTimerFill: $('promptTimerFill'),
    promptTimerNum: $('promptTimerNum'),
    result: $('result'), resTitle: $('resTitle'), resDetail: $('resDetail'),
    resPts: $('resPts'), resBonus: $('resBonus'), resFill: $('resFill'), resNeed: $('resNeed'), resBtn: $('resBtn'),
    start: $('start'), startBtn: $('startBtn'), startBest: $('startBest'), options: $('options'),
    intro: $('intro'), introPrev: $('introPrev'), introRound: $('introRound'), introDiff: $('introDiff'),
    introNeed: $('introNeed'), introPace: $('introPace'), introBtn: $('introBtn'), scorePop: $('scorePop'),
    over: $('over'), overScore: $('overScore'), overRounds: $('overRounds'),
    overWhy: $('overWhy'), overBest: $('overBest'), overBtn: $('overBtn'), overRecap: $('overRecap'),
    boardTitle: $('boardTitle'), boardList: $('boardList'), boardName: $('boardName'),
    boardSave: $('boardSave'), boardStatus: $('boardStatus'), boardForm: $('boardForm'),
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

  const ROSTER = window.COUNTRIES.map(([mapName, name, capital, lat, lon, tier, region]) => {
    const geo = byName.get(mapName);
    if (!geo) console.warn('Pinpoint: no map shape for', mapName);
    return { mapName, name, capital, lat, lon, tier, region: region || 'AP', geo };
  }).filter((c) => c.geo);

  // ---- state ------------------------------------------------------------
  const P = loadPrefs();   // { mode: 'countries'|'capitals', region, timer }
  const G = {
    phase: 'start',      // start | intro | guess | result | roundEnd | over
    round: 0, pin: 0, roundPts: 0, lastRoundPts: null, score: 0, used: new Set(), target: null,
    guess: null,         // {lat, lon, mi, pts, inside, bonus, timedOut}
    history: [],         // one entry per finished pin
    best: loadBest(),
    timer: null,         // {t0, id} while a timed round is live
  };

  function loadJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch { return fallback; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
  }
  function loadBest() { return loadJSON(BEST_KEY, { score: 0, rounds: 0 }); }
  function saveBest() { saveJSON(BEST_KEY, G.best); }
  function loadPrefs() {
    const p = loadJSON(PREFS_KEY, {});
    return {
      mode: p.mode === 'capitals' ? 'capitals' : 'countries',
      region: REGIONS[p.region] ? p.region : 'world',
      timer: !!p.timer,
    };
  }
  function savePrefs() { saveJSON(PREFS_KEY, P); }

  const roster = () => ROSTER.filter((c) => P.region === 'world' || c.region === P.region);

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

  // Every view change goes through animateTo(), which eases from the current
  // view to a target over a few hundred ms. Drag and pinch set V directly.
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let anim = null;   // {from, to, t0, ms}
  let goal = null;   // where the view is heading (wheel notches stack on this)
  let raf = 0;

  function clamped(v) {
    const s = Math.min(V.sMax, Math.max(V.sMin, v.s));
    const mw = MW * s, mh = MH * s;
    return {
      s,
      ox: mw <= V.w ? (V.w - mw) / 2 : Math.min(0, Math.max(V.w - mw, v.ox)),
      oy: mh <= V.h ? (V.h - mh) / 2 : Math.min(0, Math.max(V.h - mh, v.oy)),
    };
  }
  function clampView() { Object.assign(V, clamped(V)); }
  function stopAnim() { anim = null; goal = null; }

  // Ease to a target view. The map point under `anchor` (a screen point,
  // default the centre) moves in a straight line from where it is now to
  // where it ends up, while the scale eases geometrically. Interpolating
  // scale and offsets separately made the view drift through the wrong spot
  // mid-flight before landing, which read as "zoom to one place, then jump".
  function animateTo(to, ms, anchor) {
    to = clamped(to);
    if (reduceMotion || !ms) { stopAnim(); Object.assign(V, to); draw(); return; }
    const [ax, ay] = anchor || [V.w / 2, V.h / 2];
    anim = {
      s0: V.s, s1: to.s, ax, ay,
      m0: [(ax - V.ox) / V.s, (ay - V.oy) / V.s],   // map point under the anchor now
      m1: [(ax - to.ox) / to.s, (ay - to.oy) / to.s], // map point under the anchor at the end
      t0: performance.now(), ms,
    };
    goal = to;
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    raf = 0;
    if (!anim) return;
    const p = Math.min(1, (now - anim.t0) / anim.ms);
    const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const { s0, s1, ax, ay, m0, m1 } = anim;
    const s = s0 * Math.pow(s1 / s0, e);
    const mx = m0[0] + (m1[0] - m0[0]) * e, my = m0[1] + (m1[1] - m0[1]) * e;
    V.s = s; V.ox = ax - mx * s; V.oy = ay - my * s;
    clampView();
    draw();
    if (p < 1) raf = requestAnimationFrame(tick); else stopAnim();
  }

  function fitTarget() {
    const s = V.sMin;
    return { s, ox: (V.w - MW * s) / 2, oy: (V.h - MH * s) / 2 };
  }
  function fitAll() { Object.assign(V, fitTarget()); stopAnim(); }

  // Zoom about a screen point. Stacks on the pending goal so fast wheel
  // notches accumulate instead of fighting the animation.
  function zoomAt(px, py, factor, ms = 220) {
    const base = goal || V;
    const ns = Math.min(V.sMax, Math.max(V.sMin, base.s * factor));
    const k = ns / base.s;
    animateTo({ s: ns, ox: px - (px - base.ox) * k, oy: py - (py - base.oy) * k }, ms, [px, py]);
  }

  // Frame a set of map-unit points with padding (used after a guess).
  function fitPointsTarget(pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const bw = Math.max(60, x1 - x0), bh = Math.max(60, y1 - y0);
    const pad = 0.28;
    const s = Math.min(V.sMax, Math.max(V.sMin,
      Math.min(V.w / (bw * (1 + 2 * pad)), (V.h * 0.72) / (bh * (1 + 2 * pad)))));
    return { s, ox: V.w / 2 - ((x0 + x1) / 2) * s, oy: V.h * 0.42 - ((y0 + y1) / 2) * s };
  }
  // What to frame after a guess: pin, capital and (in Countries mode) the country.
  function revealTarget(g, t) {
    const pts = [proj(t.lon, t.lat)];
    if (!g.timedOut) pts.push(proj(g.lon, g.lat));
    if (P.mode === 'countries') pts.push(...t.geo.bbox);
    return fitPointsTarget(pts);
  }

  const toMap = (px, py) => [(px - V.ox) / V.s, (py - V.oy) / V.s];
  const toScreen = (x, y) => [x * V.s + V.ox, y * V.s + V.oy];

  // ---- drawing ----------------------------------------------------------
  const C = {
    page: '#DCE8EE', sea: '#A9D3DF', land: '#3E8E5B', border: '#E4F2E8',
    grat: 'rgba(0,60,90,0.09)', hit: 'rgba(245,196,81,0.85)', hitStroke: '#8A5A00',
    guess: '#E0452F', capital: '#1B2A3A', line: 'rgba(27,42,58,0.7)',
    ringPass: '#2E8B57', ringFail: '#E0452F',
  };

  function draw() {
    const { dpr, s, ox, oy, w, h } = V;
    const revealed = G.phase === 'result' || G.phase === 'roundEnd' || G.phase === 'over';
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

    if (revealed && P.mode === 'countries') {
      const t = G.target.geo;
      ctx.fillStyle = C.hit;
      ctx.fill(t.path);
      ctx.strokeStyle = C.hitStroke;
      ctx.lineWidth = 1.5 / s;
      ctx.stroke(t.path);
    }
    ctx.restore();

    if (revealed && G.guess) drawMarkers();
  }

  function drawMarkers() {
    const { dpr, s, ox, oy } = V;
    const t = G.target, g = G.guess;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [cx, cy] = toScreen(...proj(t.lon, t.lat));

    // The pace ring: how close a pin has to land to keep this round on pace.
    // Built under the map transform so it scales with zoom, stroked in screen
    // space so the dash stays crisp.
    const need = avgNeedFor(G.round);
    const ringMi = milesForPoints(need);
    if (ringMi > 0) {
      ctx.save();
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      ctx.beginPath();
      const [tx, ty] = proj(t.lon, t.lat);
      ctx.arc(tx, ty, milesToMapUnits(ringMi, t.lat), 0, Math.PI * 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.setLineDash([7, 6]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = g.pts >= need ? C.ringPass : C.ringFail;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (g.timedOut) { drawCapital(cx, cy); return; }

    const [gx, gy] = toScreen(...proj(g.lon, g.lat));
    if (!g.inside) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawCapital(cx, cy);
    drawPin(gx, gy, C.guess);
  }

  function drawCapital(cx, cy) {
    // navy ring + dot with a white halo so it reads on gold or green
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = C.capital; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.capital;
    ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
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
    const all = roster();
    const want = difficultyFor(G.round);
    const unused = (d) => all.filter((c) => c.tier === d && !G.used.has(c.mapName));
    let pool = unused(want);
    // Empty pool (small region pack, or a long run through the deep cuts):
    // widen one difficulty step at a time, easier and harder alike.
    for (let k = 1; !pool.length && k < MAX_DIFFICULTY; k++) {
      pool = pool.concat(unused(want - k), unused(want + k));
    }
    if (!pool.length) pool = all.filter((c) => !G.used.has(c.mapName));
    if (!pool.length) { G.used.clear(); pool = all.slice(); }
    const t = pool[Math.floor(Math.random() * pool.length)];
    G.used.add(t.mapName);
    return t;
  }

  function startGame() {
    stopTimer();
    G.round = 0; G.pin = 0; G.roundPts = 0; G.score = 0; G.used = new Set(); G.guess = null; G.history = [];
    nextRound();
  }

  function nextRound() {
    G.lastRoundPts = G.round ? G.roundPts : null;
    G.round += 1;
    G.pin = 0;
    G.roundPts = 0;
    G.guess = null;
    G.phase = 'intro';
    hide(ui.prompt); hide(ui.result); hide(ui.start); hide(ui.over);
    animateTo(fitTarget(), 450);
    renderHud();
    showIntro();
    draw();
    snapshot();
  }

  // The round announcement: what this round asks for, in plain words.
  function showIntro() {
    const r = G.round, need = barFor(r), pace = avgNeedFor(r);
    ui.introPrev.hidden = G.lastRoundPts == null;
    if (G.lastRoundPts != null) {
      ui.introPrev.textContent = `Round ${r - 1} cleared with ${fmt(G.lastRoundPts)} points.`;
    }
    ui.introRound.textContent = `Round ${r}`;
    ui.introDiff.textContent = `${DIFF_LABELS[difficultyFor(r)]} · ${P.mode === 'capitals' ? 'capitals' : 'countries'} · ${REGIONS[P.region]}`;
    ui.introNeed.textContent = `You need ${fmt(need)} points across ${PINS_PER_ROUND} pins to reach round ${r + 1}.`;
    ui.introPace.textContent = `That's ${fmt(pace)} a pin on average, about ${fmt(milesForPoints(pace))} miles from each capital. ` +
      `A pin inside the country${P.mode === 'capitals' ? '' : ' or'} within 25 miles of the capital is worth the full ${fmt(MAX_PTS)}.`;
    ui.introBtn.textContent = r === 1 ? 'Drop the first pin' : `Play round ${r}`;
    show(ui.intro);
    ui.introBtn.focus({ preventScroll: true });
  }

  function beginRound() {
    if (G.phase !== 'intro') return;
    hide(ui.intro);
    nextPin();
  }

  function nextPin() {
    G.pin += 1;
    G.target = pickTarget();
    G.guess = null;
    G.phase = 'guess';
    animateTo(fitTarget(), 450);
    renderHud();
    renderPrompt();
    show(ui.prompt); hide(ui.result); hide(ui.start); hide(ui.over);
    draw();
    if (P.timer) startTimer();
    snapshot();
  }

  function renderPrompt() {
    const t = G.target;
    const capitals = P.mode === 'capitals';
    ui.promptEyebrow.textContent = capitals ? 'Find the capital' : 'Find';
    ui.promptName.textContent = capitals ? t.capital : t.name;
    ui.promptSub.textContent = (capitals ? `${t.name} · ` : '') +
      `Round ${G.round} · Pin ${G.pin} of ${PINS_PER_ROUND}`;
    ui.promptTimer.hidden = !P.timer;
    if (P.timer) { ui.promptTimerFill.style.width = '100%'; ui.promptTimerNum.textContent = ROUND_SECS.toFixed(1); }
  }

  // ---- timer --------------------------------------------------------------
  function startTimer() {
    stopTimer();
    const t0 = performance.now();
    const id = setInterval(() => {
      const left = ROUND_SECS - (performance.now() - t0) / 1000;
      if (left <= 0) { stopTimer(); timeOut(); return; }
      ui.promptTimerFill.style.width = `${(left / ROUND_SECS) * 100}%`;
      ui.promptTimerNum.textContent = left.toFixed(1);
      ui.promptTimer.classList.toggle('low', left < 3);
    }, 100);
    G.timer = { t0, id };
  }
  function secsLeft() {
    return G.timer ? Math.max(0, ROUND_SECS - (performance.now() - G.timer.t0) / 1000) : 0;
  }
  function stopTimer() {
    if (G.timer) clearInterval(G.timer.id);
    G.timer = null;
    ui.promptTimer.classList.remove('low');
  }

  function timeOut() {
    if (G.phase !== 'guess') return;
    const t = G.target;
    settlePin({ lat: t.lat, lon: t.lon, mi: null, pts: 0, inside: false, bonus: 0, timedOut: true });
  }

  function handleGuess(px, py) {
    if (G.phase !== 'guess') return;
    const [x, y] = toMap(px, py);
    const ll = unproj(x, y);
    if (!ll) return; // clicked the page margin, not the globe
    const left = secsLeft();
    stopTimer();
    const [lon, lat] = ll;
    const t = G.target;
    const inside = P.mode === 'countries' && pointInRings(lon, lat, t.geo.polys);
    const mi = haversineMi(lat, lon, t.lat, t.lon);
    const pts = pointsFor(mi, inside);
    const bonus = P.timer && pts >= avgNeedFor(G.round) ? speedBonus(left) : 0;
    settlePin({ lat, lon, mi, pts, inside, bonus, timedOut: false });
  }

  // Bank a pin (guessed or timed out), then decide: next pin, round cleared,
  // or game over.
  function settlePin(g) {
    const t = G.target;
    G.guess = g;
    G.history.push({ round: G.round, pin: G.pin, name: t.name, capital: t.capital,
      mi: g.mi, pts: g.pts, bonus: g.bonus, inside: g.inside, timedOut: g.timedOut });
    G.roundPts += g.pts;
    G.score += g.pts + g.bonus;
    if (G.pin < PINS_PER_ROUND) G.phase = 'result';
    else G.phase = G.roundPts >= barFor(G.round) ? 'roundEnd' : 'over';
    G.revealedAt = performance.now();

    animateTo(revealTarget(g, t), 600);
    hide(ui.prompt);
    showResult();
    renderHud();
    popScore(g.pts + g.bonus);
    snapshot();
  }

  // "+4,660" floats up from the score in the top bar.
  function popScore(n) {
    if (!n) return;
    const pop = ui.scorePop;
    pop.textContent = `+${fmt(n)}`;
    pop.classList.remove('go');
    void pop.offsetWidth; // restart the animation
    pop.classList.add('go');
  }

  function showResult() {
    const t = G.target, g = G.guess;
    const need = barFor(G.round), pace = avgNeedFor(G.round);
    const capitals = P.mode === 'capitals';
    const shown = capitals ? t.capital : t.name;
    const onPace = g.pts >= pace;
    const left = PINS_PER_ROUND - G.pin;
    ui.result.classList.toggle('fail', G.phase === 'over' || (G.phase === 'result' && !onPace));
    ui.result.classList.toggle('bullseye', g.pts === MAX_PTS);
    if (g.timedOut) {
      ui.resTitle.textContent = `Time's up. That was ${shown}.`;
      ui.resDetail.textContent = `No pin, no points. ${t.capital} is marked on the map.`;
    } else {
      ui.resTitle.textContent = g.pts === MAX_PTS
        ? (g.inside ? `Bullseye. That's ${t.name}.` : `Bullseye. Right on ${t.capital}.`)
        : onPace ? `${shown} — on pace.` : `${shown} — under pace.`;
      ui.resDetail.textContent = g.inside
        ? `Your pin landed inside ${t.name}, ${fmt(g.mi)} mi from ${t.capital}.`
        : `Your pin was ${fmt(g.mi)} mi from ${t.capital}${capitals ? '' : ', the capital'}.`;
    }
    ui.resPts.textContent = `+${fmt(g.pts)}`;
    ui.resBonus.textContent = g.bonus ? `+${fmt(g.bonus)} speed bonus` : '';
    ui.resBonus.hidden = !g.bonus;
    // the track shows the round so far against the round bar
    ui.resFill.style.width = `${Math.min(100, (G.roundPts / (MAX_PTS * PINS_PER_ROUND)) * 100)}%`;
    ui.result.style.setProperty('--need', `${(need / (MAX_PTS * PINS_PER_ROUND)) * 100}%`);
    if (G.phase === 'result') {
      ui.resNeed.textContent = `Round ${G.round}: ${fmt(G.roundPts)} of ${fmt(need)} · ${left} pin${left === 1 ? '' : 's'} left`;
      ui.resBtn.textContent = 'Next pin';
    } else if (G.phase === 'roundEnd') {
      ui.resNeed.textContent = `Round ${G.round} cleared: ${fmt(G.roundPts)} of ${fmt(need)} needed`;
      ui.resBtn.textContent = 'Continue';
    } else {
      ui.resNeed.textContent = `Round ${G.round} missed: ${fmt(G.roundPts)} of ${fmt(need)} needed`;
      ui.resBtn.textContent = 'See final score';
    }
    show(ui.result);
    ui.resBtn.focus({ preventScroll: true });
  }

  function advance() {
    // On touch screens the tap that dropped the pin also fires a click a beat
    // later, and by then the result button sits under the finger. Ignore the
    // button until the card has been on screen for a moment.
    if (G.revealedAt && performance.now() - G.revealedAt < 500) return;
    if (G.phase === 'result') nextPin();
    else if (G.phase === 'roundEnd') nextRound();
    else if (G.phase === 'over') showOver();
  }

  function showOver() {
    const rounds = G.round - 1;
    const isBest = G.score > G.best.score;
    if (isBest) { G.best = { score: G.score, rounds }; saveBest(); }
    ui.overScore.textContent = fmt(G.score);
    ui.overRounds.textContent = `${rounds} round${rounds === 1 ? '' : 's'} cleared · ${modeLabel()}`;
    ui.overWhy.textContent =
      `Round ${G.round} ended it: ${fmt(G.roundPts)} points against a bar of ${fmt(barFor(G.round))}. ` +
      `That round asked for an average of ${fmt(avgNeedFor(G.round))} a pin, about ${fmt(milesForPoints(avgNeedFor(G.round)))} mi from each capital.`;
    ui.overBest.textContent = isBest
      ? 'New personal best.'
      : `Personal best: ${fmt(G.best.score)} (${G.best.rounds} rounds).`;
    renderRecap();
    hide(ui.result);
    show(ui.over);
    ui.overBtn.focus({ preventScroll: true });
    renderHud();
    board.open();
    snapshot();
  }

  function modeLabel() {
    return `${P.mode === 'capitals' ? 'Capitals' : 'Countries'} · ${REGIONS[P.region]}${P.timer ? ' · Timed' : ''}`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderRecap() {
    ui.overRecap.replaceChildren();
    let round = 0;
    G.history.forEach((h) => {
      if (h.round !== round) {
        round = h.round;
        const pts = G.history.filter((x) => x.round === round).reduce((a, x) => a + x.pts, 0);
        const need = barFor(round), done = G.history.filter((x) => x.round === round).length === PINS_PER_ROUND;
        const cleared = done && pts >= need;
        const head = el('li', 'recap-head' + (done ? (cleared ? ' ok' : ' miss') : ''));
        head.append(el('span', 'name', `Round ${round}`));
        head.append(el('span', 'pts', `${fmt(pts)} / ${fmt(need)}${done ? (cleared ? ' · cleared' : ' · missed') : ''}`));
        ui.overRecap.append(head);
      }
      const pace = avgNeedFor(h.round);
      const row = el('li', 'recap-row' + (h.pts >= pace ? '' : ' low') + (h.pts === MAX_PTS ? ' bull' : ''));
      row.append(el('span', 'n', String(h.pin)));
      row.append(el('span', 'name', P.mode === 'capitals' ? `${h.capital}, ${h.name}` : h.name));
      row.append(el('span', 'mi', h.timedOut ? 'time out' : h.inside ? 'inside' : `${fmt(h.mi)} mi`));
      row.append(el('span', 'pts', `${fmt(h.pts)}${h.bonus ? ` +${fmt(h.bonus)}` : ''}`));
      ui.overRecap.append(row);
    });
  }

  function renderHud() {
    const r = Math.max(1, G.round);
    ui.round.textContent = G.round ? String(G.round) : '–';
    ui.score.textContent = fmt(G.score);
    ui.best.textContent = fmt(Math.max(G.best.score, G.score));
    ui.barNeed.textContent = fmt(barFor(r));
    ui.barMiles.textContent = G.round
      ? `${fmt(G.roundPts)} so far · pin ${G.pin}/${PINS_PER_ROUND}`
      : `${PINS_PER_ROUND} pins · ${fmt(avgNeedFor(1))} a pin`;
    ui.hudMode.textContent = modeLabel();
  }

  function show(e) { e.hidden = false; }
  function hide(e) { e.hidden = true; }

  // ---- start-screen options ------------------------------------------------
  function renderOptions() {
    ui.options.querySelectorAll('button[data-k]').forEach((b) => {
      const on = String(P[b.dataset.k]) === b.dataset.v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const n = roster().length;
    ui.startBest.textContent = G.best.score
      ? `Personal best: ${fmt(G.best.score)} points over ${G.best.rounds} rounds.`
      : `${n} ${P.mode === 'capitals' ? 'capitals' : 'countries'} in play, ${PINS_PER_ROUND} a round.`;
  }
  ui.options.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k, v = b.dataset.v;
    P[k] = k === 'timer' ? v === 'true' : v;
    savePrefs();
    renderOptions();
    renderHud();
  });

  // ---- leaderboard -----------------------------------------------------------
  // Shared across viewers through the artifact's database when the page runs
  // inside claude.ai; otherwise a local top-10 in this browser. One entry per
  // player name per mode + region, keeping their best.
  const board = (function () {
    let db = null, ready = false;
    const key = () => `${P.mode}__${P.region}`;
    const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'player';

    async function init() {
      if (ready) return;
      try { if (window.claude && typeof window.claude.use === 'function') db = await window.claude.use('db'); }
      catch { db = null; }
      ready = true;
    }

    async function top() {
      if (db) {
        const snap = await db.collection('scores')
          .where('mode', '==', P.mode).where('region', '==', P.region)
          .orderBy('score', 'desc').limit(10).get();
        return snap.docs.map((d) => d.data());
      }
      const all = loadJSON(BOARD_KEY, []);
      return all.filter((r) => r.mode === P.mode && r.region === P.region)
        .sort((a, b) => b.score - a.score).slice(0, 10);
    }

    async function submit(name) {
      const entry = { name, score: G.score, rounds: G.round - 1, mode: P.mode, region: P.region, timer: P.timer, ts: Date.now() };
      if (db) {
        const ref = db.collection('scores').doc(`${slug(name)}__${key()}`);
        const cur = await ref.get();
        if (cur.exists && (cur.data().score || 0) >= entry.score) return { kept: false, best: cur.data().score };
        await ref.set(entry);
        return { kept: true };
      }
      const all = loadJSON(BOARD_KEY, []);
      const i = all.findIndex((r) => slug(r.name) === slug(name) && r.mode === P.mode && r.region === P.region);
      if (i >= 0 && all[i].score >= entry.score) return { kept: false, best: all[i].score };
      if (i >= 0) all[i] = entry; else all.push(entry);
      saveJSON(BOARD_KEY, all.slice(-200));
      return { kept: true };
    }

    function renderList(rows, highlight) {
      ui.boardList.replaceChildren();
      if (!rows.length) { ui.boardList.append(el('li', 'board-empty', 'No scores yet. Yours could be first.')); return; }
      rows.forEach((r, i) => {
        const li = el('li', 'board-row' + (highlight && slug(r.name) === slug(highlight) ? ' me' : ''));
        li.append(el('span', 'n', String(i + 1)));
        li.append(el('span', 'name', String(r.name) + (r.timer ? ' ⏱' : '')));
        li.append(el('span', 'rounds', `${r.rounds} rd`));
        li.append(el('span', 'pts', fmt(r.score)));
        ui.boardList.append(li);
      });
    }

    async function open() {
      await init();
      ui.boardTitle.textContent = `Top scores · ${modeLabel()}${db ? '' : ' · this device'}`;
      ui.boardName.value = loadJSON(NAME_KEY, '');
      ui.boardStatus.textContent = '';
      ui.boardForm.hidden = false;
      ui.boardSave.disabled = false;
      try { renderList(await top(), null); }
      catch { ui.boardList.replaceChildren(el('li', 'board-empty', 'Leaderboard unavailable right now.')); }
    }

    async function save(e) {
      e.preventDefault();
      const name = ui.boardName.value.trim().slice(0, 24);
      if (!name) { ui.boardName.focus(); return; }
      saveJSON(NAME_KEY, name);
      ui.boardSave.disabled = true;
      ui.boardStatus.textContent = 'Saving…';
      try {
        const r = await submit(name);
        ui.boardStatus.textContent = r.kept ? 'Saved.' : `Kept your earlier ${fmt(r.best)}.`;
        renderList(await top(), name);
        ui.boardForm.hidden = true;
      } catch {
        ui.boardStatus.textContent = 'Could not save. Try again.';
        ui.boardSave.disabled = false;
      }
    }

    ui.boardForm.addEventListener('submit', save);
    return { open, init };
  })();

  // ---- hot reload (artifact republish keeps the game in progress) --------
  function snapshot() {
    if (!window.claude?.hot?.snapshot) return;
    window.claude.hot.snapshot({
      phase: G.phase, round: G.round, pin: G.pin, roundPts: G.roundPts, lastRoundPts: G.lastRoundPts, score: G.score,
      used: [...G.used], target: G.target?.mapName, guess: G.guess, history: G.history,
    });
  }
  function restore(d) {
    if (!d || !d.target || !['intro', 'guess', 'result', 'roundEnd', 'over'].includes(d.phase)) return false;
    const t = ROSTER.find((c) => c.mapName === d.target);
    if (!t) return false;
    G.round = d.round; G.pin = d.pin || 1; G.roundPts = d.roundPts || 0; G.score = d.score; G.used = new Set(d.used); G.target = t;
    G.guess = d.guess; G.phase = d.phase; G.history = d.history || [];
    hide(ui.start); hide(ui.over); hide(ui.result); hide(ui.prompt); hide(ui.intro);
    renderHud();
    if (d.phase === 'intro') {
      G.lastRoundPts = d.lastRoundPts == null ? null : d.lastRoundPts;
      fitAll();
      showIntro();
    } else if (d.phase === 'guess') {
      fitAll();
      renderPrompt();
      show(ui.prompt);
      if (P.timer) startTimer();
    } else {
      Object.assign(V, clamped(revealTarget(G.guess, t)));
      showResult();
    }
    draw();
    return true;
  }

  // ---- input ------------------------------------------------------------
  const pointers = new Map();
  let drag = null;   // {x, y, ox, oy, moved}
  let pinch = null;  // {d, s}

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      stopAnim();
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
      stopAnim();
      const ns = Math.min(V.sMax, Math.max(V.sMin, pinch.s * (d / pinch.d)));
      const k = ns / V.s;
      V.ox = midX - (midX - V.ox) * k; V.oy = midY - (midY - V.oy) * k; V.s = ns;
      clampView(); draw();
      return;
    }
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
      if (drag.moved) {
        stopAnim();
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
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor, 200);
  }, { passive: false });

  ui.zoomIn.addEventListener('click', () => zoomAt(V.w / 2, V.h / 2, 1.6, 280));
  ui.zoomOut.addEventListener('click', () => zoomAt(V.w / 2, V.h / 2, 1 / 1.6, 280));
  ui.zoomFit.addEventListener('click', () => animateTo(fitTarget(), 400));

  ui.startBtn.addEventListener('click', startGame);
  ui.introBtn.addEventListener('click', beginRound);
  ui.resBtn.addEventListener('click', advance);
  ui.overBtn.addEventListener('click', () => {
    // back to the start screen so mode / region / timer can change between runs
    hide(ui.over); hide(ui.intro); show(ui.start); G.phase = 'start'; G.guess = null; G.round = 0; G.pin = 0; G.roundPts = 0; G.lastRoundPts = null;
    renderOptions(); animateTo(fitTarget(), 400);
    ui.startBtn.focus({ preventScroll: true });
  });

  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT') return; // the focused control handles Enter/Space itself
    if (e.key === 'Enter' || e.key === ' ') {
      if (G.phase === 'result' || G.phase === 'roundEnd' || (G.phase === 'over' && ui.over.hidden)) { e.preventDefault(); advance(); }
      else if (G.phase === 'intro') { e.preventDefault(); beginRound(); }
      else if (G.phase === 'start') { e.preventDefault(); startGame(); }
    }
    if (e.key === '+' || e.key === '=') zoomAt(V.w / 2, V.h / 2, 1.4, 240);
    if (e.key === '-' || e.key === '_') zoomAt(V.w / 2, V.h / 2, 1 / 1.4, 240);
    if (e.key === '0') animateTo(fitTarget(), 400);
  });

  window.addEventListener('resize', resize);

  // ---- boot -------------------------------------------------------------
  function boot(saved) {
    renderOptions();
    resize();
    if (!restore(saved)) { renderHud(); show(ui.start); }
    board.init();
  }
  if (window.claude?.hot?.ready) window.claude.hot.ready(boot);
  else boot(window.claude?.hot?.data);

  // test hooks
  window.PP.state = () => G;
  window.PP.prefs = () => P;
  window.PP.setPrefs = (p) => { Object.assign(P, p); savePrefs(); renderOptions(); renderHud(); };
  window.PP.roster = () => roster();
  window.PP.startGame = startGame;
  window.PP.guessLatLon = (lat, lon) => {
    const [px, py] = toScreen(...proj(lon, lat));
    handleGuess(px, py);
  };
  window.PP.timeOut = () => { stopTimer(); timeOut(); };
  window.PP.nextPin = nextPin;
  window.PP.beginRound = beginRound;
  window.PP.advance = advance;
  window.PP._viewCenter = () => toMap(V.w / 2, V.h / 2);
  window.PP._unproj = (px, py) => unproj(...toMap(px, py));
})();
