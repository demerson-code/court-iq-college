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
  const HINT_COST = 1500;      // points taken off the pin a hint is used on
  const HINTS_PER_ROUND = 3;   // one per pin, up to this many pins a round
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
    const e = 1e-6; // a click exactly on the map edge still counts
    if (!(lon >= -180 - e && lon <= 180 + e && lat >= LAT_MIN - e && lat <= LAT_MAX + e)) return null;
    return [Math.max(-180, Math.min(180, lon)), Math.max(LAT_MIN, Math.min(LAT_MAX, lat))];
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

  // Fanfare tiers by miles from the capital: 1 = within 500 mi ... 5 = within 5 mi.
  const CELEBRATE_MI = [500, 250, 100, 25, 5];
  function celebrationLevel(mi) {
    if (mi == null) return 0;
    let level = 0;
    CELEBRATE_MI.forEach((m, i) => { if (mi <= m) level = i + 1; });
    return level;
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
      const arcIds = new Set(raw.flat(2).map((i) => (i < 0 ? ~i : i)));
      return { name: g.properties.name, polys, arcIds };
    });
  }

  window.PP = { haversineMi, pointsFor, barFor, avgNeedFor, difficultyFor, celebrationLevel, milesForPoints, speedBonus, pointInRings, decodeTopo,
    MAX_PTS, ZERO_AT_MI, BULLSEYE_MI, ROUND_SECS, PINS_PER_ROUND, CELEBRATE_MI, HINT_COST, HINTS_PER_ROUND, REGIONS };

  // ---- DOM --------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const ui = {
    round: $('hudRound'), score: $('hudScore'), best: $('hudBest'),
    barNeed: $('hudBarNeed'), barMiles: $('hudBarMiles'), hudMode: $('hudMode'),
    prompt: $('prompt'), promptEyebrow: $('promptEyebrow'), promptName: $('promptName'),
    promptSub: $('promptSub'), promptTimer: $('promptTimer'), promptTimerFill: $('promptTimerFill'),
    promptTimerNum: $('promptTimerNum'), hintBtn: $('hintBtn'), hintCount: $('hintCount'), hintText: $('hintText'), resHint: $('resHint'),
    result: $('result'), resTitle: $('resTitleText'), resDetail: $('resDetail'),
    resPts: $('resPts'), resPtsNum: $('resPtsNum'), resBonus: $('resBonus'), resFill: $('resFill'), resNeed: $('resNeed'), resBtn: $('resBtn'),
    start: $('start'), startBtn: $('startBtn'), startBest: $('startBest'), options: $('options'),
    intro: $('intro'), introPrev: $('introPrev'), introRound: $('introRound'), introDiff: $('introDiff'),
    introNeed: $('introNeed'), introPace: $('introPace'), introBtn: $('introBtn'), scorePop: $('scorePop'),
    over: $('over'), overScore: $('overScore'), overRounds: $('overRounds'),
    overWhy: $('overWhy'), overBest: $('overBest'), overBtn: $('overBtn'), overRecap: $('overRecap'),
    boardTitle: $('boardTitle'), boardList: $('boardList'), boardName: $('boardName'),
    boardSave: $('boardSave'), boardStatus: $('boardStatus'), boardForm: $('boardForm'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'),
    fx: $('fx'), stamp: $('stamp'), stampT: $('stampT'), stampS: $('stampS'), flash: $('flash'),
    resChip: $('resChip'), stage: document.querySelector('.stage'),
    resLearn: $('resLearn'), resFlag: $('resFlag'), resHook: $('resHook'), resNear: $('resNear'),
    exploreTag: $('exploreTag'), exploreKicker: $('exploreKicker'), exploreName: $('exploreName'), exploreCap: $('exploreCap'), exploreHook: $('exploreHook'),
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
    // label point: centroid of the biggest ring (mainland), in map units
    let best = null, bestArea = -1;
    for (const poly of c.polys) for (const ring of poly) {
      let a = 0, cx = 0, cy = 0;
      const pts = ring.map(([lon, lat]) => proj(lon, lat));
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        a += f; cx += (pts[j][0] + pts[i][0]) * f; cy += (pts[j][1] + pts[i][1]) * f;
      }
      if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = a ? [cx / (3 * a), cy / (3 * a)] : pts[0]; }
    }
    c.label = best || [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  // Neighbours: two countries that share a border share a TopoJSON arc.
  (function () {
    const byArc = new Map();
    for (const c of countries) for (const a of c.arcIds) {
      if (!byArc.has(a)) byArc.set(a, []);
      byArc.get(a).push(c);
    }
    for (const c of countries) {
      const set = new Set();
      for (const a of c.arcIds) for (const o of byArc.get(a)) if (o !== c) set.add(o);
      c.neighbors = [...set];
    }
  })();
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
    const meta = (window.META || {})[mapName] || [null, ''];
    return { mapName, name, capital, lat, lon, tier, region: region || 'AP', geo, iso: meta[0], hook: meta[1] };
  }).filter((c) => c.geo);
  const rosterByMap = new Map(ROSTER.map((c) => [c.mapName, c]));
  // Display names for map shapes that are not in the playable table.
  const EXTRA_NAMES = { 'W. Sahara': 'Western Sahara', 'N. Cyprus': 'Northern Cyprus', 'Fr. S. Antarctic Lands': 'French Southern Lands',
    'Br. Indian Ocean Ter.': 'British Indian Ocean Territory', 'Falkland Is.': 'Falkland Islands', 'Faeroe Is.': 'Faroe Islands',
    'Cayman Is.': 'Cayman Islands', 'Turks and Caicos Is.': 'Turks and Caicos', 'U.S. Virgin Is.': 'U.S. Virgin Islands',
    'British Virgin Is.': 'British Virgin Islands', 'Cook Is.': 'Cook Islands', 'N. Mariana Is.': 'Northern Mariana Islands',
    'Fr. Polynesia': 'French Polynesia', 'St-Martin': 'Saint Martin', 'St-Barthélemy': 'Saint Barthélemy', 'Siachen Glacier': 'Siachen Glacier' };
  const displayName = (geo) => (rosterByMap.get(geo.name) || {}).name || EXTRA_NAMES[geo.name] || geo.name;
  // What to teach for a target: bordering countries, or the nearest capitals for an island.
  const NOT_A_COUNTRY = new Set(['Antarctica', 'Siachen Glacier', 'Somaliland', 'N. Cyprus']);
  function neighborsOf(t) {
    const n = t.geo.neighbors.filter((g) => !NOT_A_COUNTRY.has(g.name));
    if (n.length) return { kind: 'borders', list: n.slice(0, 8), more: Math.max(0, n.length - 8) };
    const near = ROSTER.filter((c) => c !== t)
      .map((c) => ({ c, d: haversineMi(t.lat, t.lon, c.lat, c.lon) }))
      .filter((x) => x.d < 1200).sort((a, b) => a.d - b.d).slice(0, 3);
    return { kind: 'nearest', list: near.map((x) => x.c.geo), more: 0 };
  }
  function neighborsOfGeo(geo) {
    const r = rosterByMap.get(geo.name);
    if (r) return neighborsOf(r);
    const n = geo.neighbors.filter((g) => !NOT_A_COUNTRY.has(g.name));
    if (n.length) return { kind: 'borders', list: n.slice(0, 8), more: Math.max(0, n.length - 8) };
    const [lon, lat] = unproj(...geo.label) || [0, 0];
    const near = ROSTER.map((c) => ({ c, d: haversineMi(lat, lon, c.lat, c.lon) }))
      .filter((x) => x.d < 1200 && x.c.geo !== geo).sort((a, b) => a.d - b.d).slice(0, 3);
    return { kind: 'nearest', list: near.map((x) => x.c.geo), more: 0 };
  }
  // Which country shape is under a map point, if any.
  function countryAt(x, y) {
    const ll = unproj(x, y);
    if (!ll) return null;
    const [lon, lat] = ll;
    for (const c of countries) {
      const [[x0, y0], [x1, y1]] = c.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (!NOT_A_COUNTRY.has(c.name) && pointInRings(lon, lat, c.polys)) return c;
    }
    return null;
  }
  function neighborSentence(n) {
    const names = n.list.map(displayName);
    if (!names.length) return '';
    const tail = n.more ? ` and ${n.more} more` : '';
    return n.kind === 'borders' ? `Borders ${names.join(', ')}${tail}.` : `Nearest: ${names.join(', ')}.`;
  }

  // ---- state ------------------------------------------------------------
  const P = loadPrefs();   // { mode: 'countries'|'capitals', region, timer, teach }
  const G = {
    phase: 'start',      // start | intro | guess | result | roundEnd | over
    round: 0, pin: 0, roundPts: 0, lastRoundPts: null, score: 0, used: new Set(), target: null,
    explore: null,       // country tapped on the map while a result is showing
    hintsUsed: 0,        // hints spent this round
    hinted: false,       // hint used on the current pin
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
      teach: p.teach !== false,
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
    ui.fx.width = canvas.width; ui.fx.height = canvas.height;
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
    exploreFill: 'rgba(79,163,209,0.55)', exploreStroke: '#1F5F86',
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
    if (revealed && G.explore && G.explore !== G.target.geo) {
      ctx.fillStyle = C.exploreFill;
      ctx.fill(G.explore.path);
      ctx.strokeStyle = C.exploreStroke;
      ctx.lineWidth = 1.5 / s;
      ctx.stroke(G.explore.path);
    }
    ctx.restore();

    if (revealed && G.guess) drawMarkers();
    if (revealed && P.teach && G.target) drawTeachLabels();
    if (revealed && G.explore) { drawExploreLabels(); positionExploreTag(); }
  }

  // Name the country and the countries around it, so a miss becomes a lesson.
  function mapLabel(geo, size, weight, color, dy) {
    const [x, y] = toScreen(...geo.label);
    if (x < -60 || x > V.w + 60 || y < -20 || y > V.h + 20) return;
    ctx.font = `${weight} ${size}px ${size >= 15 ? "'Bricolage Grotesque', 'Helvetica Neue', Arial, sans-serif" : "'IBM Plex Sans', 'Segoe UI', Helvetica, Arial, sans-serif"}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size / 4); ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeText(displayName(geo), x, y + dy);
    ctx.fillStyle = color; ctx.fillText(displayName(geo), x, y + dy);
  }
  // Each shape gets one label: the target biggest, the tapped country next,
  // neighbours small. A neighbour of both is drawn once.
  function drawTeachLabels() {
    const t = G.target, e = G.explore && G.explore !== t.geo ? G.explore : null;
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    const done = new Set([t.geo]);
    if (e) done.add(e);
    for (const g of neighborsOf(t).list) if (!done.has(g)) { done.add(g); mapLabel(g, 12.5, '600', '#1F2F45', 0); }
    if (e) for (const g of neighborsOfGeo(e).list) if (!done.has(g)) { done.add(g); mapLabel(g, 12.5, '600', '#1F5F86', 0); }
    if (e) mapLabel(e, 16, '800', '#0F3D5C', -12);
    mapLabel(t.geo, 18, '800', '#7A4A00', -14);
  }
  function drawExploreLabels() {
    if (P.teach) return; // drawTeachLabels already covered it
    const t = G.target, e = G.explore;
    if (!e || e === t.geo) return;
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    for (const g of neighborsOfGeo(e).list) if (g !== t.geo) mapLabel(g, 12.5, '600', '#1F5F86', 0);
    mapLabel(e, 16, '800', '#0F3D5C', -12);
  }

  // ---- explore: tap any country while a result is up ---------------------------
  function exploreAt(px, py) {
    const [x, y] = toMap(px, py);
    const geo = countryAt(x, y);
    if (!geo) return; // sea: leave whatever is showing
    setExplore(geo, [x, y], 'Tapped');
  }
  // After a wrong pin, show what country the pin actually landed in.
  function autoExplore(g, t) {
    if (!P.teach || g.timedOut || g.inside) return;
    const anchor = proj(g.lon, g.lat);
    const geo = countryAt(...anchor);
    if (!geo || geo === t.geo) return;
    setExplore(geo, anchor, 'Your pin landed in');
  }
  function setExplore(geo, anchor, kicker) {
    G.explore = geo;
    G.exploreAnchor = anchor;
    const r = rosterByMap.get(geo.name);
    ui.exploreKicker.textContent = kicker;
    ui.exploreName.textContent = displayName(geo);
    ui.exploreCap.textContent = r ? `Capital: ${r.capital}` : '';
    ui.exploreHook.textContent = r ? (r.hook || '') : '';
    ui.exploreCap.hidden = !r;
    ui.exploreHook.hidden = !(r && r.hook);
    ui.exploreTag.hidden = false;
    draw();
  }
  function clearExplore() {
    G.explore = null;
    ui.exploreTag.hidden = true;
  }
  function positionExploreTag() {
    if (!G.explore || ui.exploreTag.hidden) return;
    const [sx, sy] = toScreen(...G.exploreAnchor);
    const w = ui.exploreTag.offsetWidth, h = ui.exploreTag.offsetHeight;
    let x = sx - w / 2, y = sy - h - 14;
    x = Math.max(8, Math.min(V.w - w - 8, x));
    if (y < 8) y = sy + 14;
    ui.exploreTag.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
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
  const fmtMi = (mi) => mi < 10 ? mi.toFixed(1) : fmt(mi);

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
    G.hinted = false;
    G.hintsUsed = 0;
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
    stopCelebration();
    clearExplore();
    G.pin += 1;
    G.target = pickTarget();
    G.guess = null;
    G.hinted = false;
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
    renderHint();
  }

  // ---- hint: one per round, costs HINT_COST off the pin it is used on ----------
  function renderHint() {
    const used = G.hintsUsed, left = HINTS_PER_ROUND - used;
    ui.hintText.hidden = !G.hinted;
    ui.hintBtn.hidden = G.hinted;
    ui.hintBtn.disabled = left <= 0;
    ui.hintBtn.textContent = left <= 0 ? 'No hints left this round' : `Hint (−${fmt(HINT_COST)})`;
    ui.hintCount.textContent = used === 0 ? `${HINTS_PER_ROUND} this round`
      : left === 1 ? `Used ${used} of ${HINTS_PER_ROUND} · last one`
      : `Used ${used} of ${HINTS_PER_ROUND}`;
  }
  function useHint() {
    if (G.phase !== 'guess' || G.hinted || G.hintsUsed >= HINTS_PER_ROUND) return;
    const t = G.target;
    G.hintsUsed += 1;
    G.hinted = true;
    const where = neighborSentence(neighborsOf(t));
    ui.hintText.textContent = (t.hook || '') + (where ? ' ' + where : '');
    renderHint();
    snapshot();
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
    settlePin({ lat: t.lat, lon: t.lon, mi: null, pts: 0, inside: false, bonus: 0, timedOut: true, hinted: G.hinted });
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
    const raw = pointsFor(mi, inside);
    const pts = G.hinted ? Math.max(0, raw - HINT_COST) : raw;
    const bonus = P.timer && pts >= avgNeedFor(G.round) ? speedBonus(left) : 0;
    settlePin({ lat, lon, mi, pts, inside, bonus, timedOut: false, hinted: G.hinted });
  }

  // Bank a pin (guessed or timed out), then decide: next pin, round cleared,
  // or game over.
  function settlePin(g) {
    const t = G.target;
    G.guess = g;
    G.history.push({ round: G.round, pin: G.pin, name: t.name, capital: t.capital,
      mi: g.mi, pts: g.pts, bonus: g.bonus, inside: g.inside, timedOut: g.timedOut, hinted: !!g.hinted });
    G.roundPts += g.pts;
    G.score += g.pts + g.bonus;
    if (G.pin < PINS_PER_ROUND) G.phase = 'result';
    else G.phase = G.roundPts >= barFor(G.round) ? 'roundEnd' : 'over';
    G.revealedAt = performance.now();

    animateTo(revealTarget(g, t), 600);
    hide(ui.prompt);
    showResult();
    autoExplore(g, t);
    renderHud();
    popScore(g.pts + g.bonus);
    const level = g.timedOut ? 0 : celebrationLevel(g.mi);
    if (level) celebTimer = setTimeout(() => celebrate(level, g, t), 650);
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
        ? `Your pin landed inside ${t.name}, ${fmtMi(g.mi)} mi from ${t.capital}.`
        : `Your pin was ${fmtMi(g.mi)} mi from ${t.capital}${capitals ? '' : ', the capital'}.`;
    }
    renderLearn(t);
    const level = g.timedOut ? 0 : celebrationLevel(g.mi);
    ui.resChip.hidden = !level;
    ui.resChip.textContent = level ? CELEB[level].chip : '';
    ui.resChip.className = `chip lv${level}`;
    ui.resPtsNum.textContent = `+${fmt(g.pts)}`;
    ui.resBonus.textContent = g.bonus ? `+${fmt(g.bonus)} speed bonus` : '';
    ui.resBonus.hidden = !g.bonus;
    ui.resHint.textContent = g.hinted ? `after a −${fmt(HINT_COST)} hint` : '';
    ui.resHint.hidden = !g.hinted;
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

  function renderLearn(t) {
    ui.resLearn.hidden = !P.teach;
    if (!P.teach) return;
    ui.resHook.textContent = t.hook || '';
    ui.resNear.textContent = neighborSentence(neighborsOf(t));
    if (t.iso) {
      ui.resFlag.hidden = false;
      ui.resFlag.src = `https://flagcdn.com/w80/${t.iso.toLowerCase()}.png`;
      ui.resFlag.alt = `Flag of ${t.name}`;
    } else {
      ui.resFlag.hidden = true;
      ui.resFlag.removeAttribute('src');
    }
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
      row.append(el('span', 'mi', (h.timedOut ? 'time out' : h.inside ? 'inside' : `${fmt(h.mi)} mi`) + (h.hinted ? ' · hint' : '')));
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
    P[k] = (k === 'timer' || k === 'teach') ? v === 'true' : v;
    savePrefs();
    renderOptions();
    renderHud();
  });

  // ---- fanfare ---------------------------------------------------------------
  // Five tiers, each louder than the last. Particles live on the #fx canvas
  // over the map; text stamps and the screen flash are DOM elements.
  const CELEB = {
    1: { chip: 'Close', title: null },
    2: { chip: 'Sharp shooting', title: null },
    3: { chip: 'Dead on', title: 'Dead on' },
    4: { chip: 'Bullseye', title: 'Bullseye' },
    5: { chip: 'Pinpoint', title: 'PINPOINT!' },
  };
  const CONFETTI = ['#F5C451', '#E0452F', '#2E8B57', '#2F3F5C', '#FFFFFF', '#4FA3D1', '#F28C28'];
  const fctx = ui.fx.getContext('2d');
  let FX = [];        // live particles
  let fxRaf = 0, fxLast = 0;
  let celebTimer = null;
  const timers = [];

  function stopCelebration() {
    clearTimeout(celebTimer); celebTimer = null;
    while (timers.length) clearTimeout(timers.pop());
    FX = [];
    fctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    fctx.clearRect(0, 0, V.w, V.h);
    ui.stamp.className = 'stamp';
    ui.flash.className = 'flash';
    ui.stage.classList.remove('shake');
  }
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  function celebrate(level, g, t) {
    const anchor = proj(t.lon, t.lat);          // map units: rings track the capital while the view moves
    const [sx, sy] = toScreen(...anchor);       // screen point for one-shot bursts
    ui.result.classList.add('celebrate');
    later(700, () => ui.result.classList.remove('celebrate'));

    // 1 · Close: two soft pulse rings out of the capital.
    rings(anchor, 2, C.ringPass);
    if (level < 2) return;

    // 2 · Sharp shooting: a tighter, brighter triple pulse and the score bounces.
    rings(anchor, 3, C.capital, 1.4);
    if (level < 3) return;

    // 3 · Dead on: a gold spark burst and a stamp across the map.
    sparks(sx, sy, 28, C.capital);
    stamp(CELEB[3].title, `${fmtMi(g.mi)} miles from ${t.capital}`, 3);
    if (level < 4) return;

    // 4 · Bullseye: confetti cannon from the capital, gold screen flash.
    flash(4);
    confetti(sx, sy, 140, { spread: Math.PI * 2, speed: [220, 520] });
    stamp(CELEB[4].title, `${fmtMi(g.mi)} miles from ${t.capital}`, 4);
    if (level < 5) return;

    // 5 · Pinpoint: the works. Confetti from both bottom corners, three
    // fireworks in sequence, a screen shake and the big stamp.
    stamp(CELEB[5].title, `${fmtMi(g.mi)} miles from ${t.capital}`, 5);
    flash(5);
    ui.stage.classList.add('shake');
    later(600, () => ui.stage.classList.remove('shake'));
    confetti(0, V.h, 160, { spread: Math.PI / 3, dir: -Math.PI / 3, speed: [500, 900] });
    confetti(V.w, V.h, 160, { spread: Math.PI / 3, dir: -Math.PI * 2 / 3, speed: [500, 900] });
    [0, 450, 900].forEach((d, i) => later(d, () =>
      firework(V.w * (0.3 + 0.2 * i), V.h * 0.32 + (i === 1 ? -40 : 30), CONFETTI[(i * 2) % CONFETTI.length])));
    later(1500, () => confetti(V.w / 2, -10, 120, { spread: Math.PI / 2, dir: Math.PI / 2, speed: [60, 200], gravity: 320 }));
  }

  // -- emitters --
  function rings(anchor, n, color, width = 2) {
    for (let i = 0; i < n; i++) spawn({ kind: 'ring', anchor, color, width, delay: i * 180, dur: 900, r1: 70 + i * 10 });
  }
  function sparks(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2, sp = 260 + Math.random() * 220;
      spawn({ kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color, dur: 650 + Math.random() * 250, len: 10 });
    }
  }
  function confetti(x, y, n, o) {
    const dir = o.dir == null ? 0 : o.dir, spread = o.spread == null ? Math.PI * 2 : o.spread;
    for (let i = 0; i < n; i++) {
      const a = dir + (Math.random() - 0.5) * spread, sp = o.speed[0] + Math.random() * (o.speed[1] - o.speed[0]);
      spawn({ kind: 'confetti', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, gravity: o.gravity == null ? 900 : o.gravity,
        w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
        color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)], dur: 2400 + Math.random() * 900 });
    }
  }
  function firework(x, y, color) {
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 260;
      spawn({ kind: 'ember', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, gravity: 260,
        color: Math.random() < 0.3 ? '#FFFFFF' : color, dur: 900 + Math.random() * 500, r: 2 + Math.random() * 2 });
    }
    flash(3);
  }
  function stamp(title, sub, level) {
    ui.stampT.textContent = title;
    ui.stampS.textContent = sub;
    ui.stamp.className = 'stamp';
    void ui.stamp.offsetWidth;
    ui.stamp.className = `stamp lv${level} go`;
  }
  function flash(level) {
    ui.flash.className = 'flash';
    void ui.flash.offsetWidth;
    ui.flash.className = `flash lv${level} go`;
  }

  // -- particle loop --
  function spawn(p) {
    if (reduceMotion) return;
    p.t0 = performance.now() + (p.delay || 0);
    FX.push(p);
    if (!fxRaf) { fxLast = performance.now(); fxRaf = requestAnimationFrame(fxTick); }
  }
  function fxTick(now) {
    fxRaf = 0;
    const dt = Math.min(0.05, (now - fxLast) / 1000);
    fxLast = now;
    fctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    fctx.clearRect(0, 0, V.w, V.h);
    FX = FX.filter((p) => {
      if (now < p.t0) return true;
      const age = now - p.t0, k = age / p.dur;
      if (k >= 1) return false;
      if (p.kind === 'ring') {
        const [cx, cy] = toScreen(...p.anchor);
        fctx.globalAlpha = 1 - k;
        fctx.strokeStyle = p.color; fctx.lineWidth = p.width;
        fctx.beginPath(); fctx.arc(cx, cy, 10 + p.r1 * k, 0, Math.PI * 2); fctx.stroke();
        fctx.globalAlpha = 1;
        return true;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.gravity) p.vy += p.gravity * dt;
      if (p.kind === 'spark') {
        p.vx *= 0.96; p.vy *= 0.96;
        fctx.globalAlpha = 1 - k;
        fctx.strokeStyle = p.color; fctx.lineWidth = 2;
        const m = Math.hypot(p.vx, p.vy) || 1;
        fctx.beginPath(); fctx.moveTo(p.x, p.y); fctx.lineTo(p.x - p.vx / m * p.len, p.y - p.vy / m * p.len); fctx.stroke();
      } else if (p.kind === 'ember') {
        p.vx *= 0.985; p.vy *= 0.985;
        fctx.globalAlpha = 1 - k * k;
        fctx.fillStyle = p.color;
        fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); fctx.fill();
      } else if (p.kind === 'confetti') {
        p.vx *= 0.99; p.vy *= 0.995; p.rot += p.vr * dt;
        fctx.globalAlpha = k > 0.8 ? (1 - k) / 0.2 : 1;
        fctx.fillStyle = p.color;
        fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.rot);
        fctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.7)) + 1);
        fctx.restore();
      }
      fctx.globalAlpha = 1;
      return p.y < V.h + 40;
    });
    if (FX.length) fxRaf = requestAnimationFrame(fxTick);
  }

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
      hintsUsed: G.hintsUsed, hinted: G.hinted, hintText: ui.hintText.textContent,
      used: [...G.used], target: G.target?.mapName, guess: G.guess, history: G.history,
    });
  }
  function restore(d) {
    if (!d || !d.target || !['intro', 'guess', 'result', 'roundEnd', 'over'].includes(d.phase)) return false;
    const t = ROSTER.find((c) => c.mapName === d.target);
    if (!t) return false;
    G.round = d.round; G.pin = d.pin || 1; G.roundPts = d.roundPts || 0; G.score = d.score; G.used = new Set(d.used); G.target = t;
    G.guess = d.guess; G.phase = d.phase; G.history = d.history || [];
    G.hintsUsed = d.hintsUsed || 0; G.hinted = !!d.hinted; ui.hintText.textContent = d.hintText || '';
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
      if (wasTap && e.type === 'pointerup') {
        const rect = canvas.getBoundingClientRect();
        if (G.phase === 'guess') handleGuess(e.clientX - rect.left, e.clientY - rect.top);
        else if (G.phase === 'result' || G.phase === 'roundEnd' || (G.phase === 'over' && ui.over.hidden)) exploreAt(e.clientX - rect.left, e.clientY - rect.top);
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
  ui.hintBtn.addEventListener('click', useHint);
  ui.resFlag.addEventListener('error', () => { ui.resFlag.hidden = true; }); // no flag host reachable: just skip it
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
    if (e.key === 'h' || e.key === 'H') useHint();
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
  window.PP.neighborsOf = (mapName) => { const t = rosterByMap.get(mapName); const n = neighborsOf(t); return { kind: n.kind, names: n.list.map(displayName) }; };
  window.PP.startGame = startGame;
  window.PP.guessLatLon = (lat, lon) => {
    const [px, py] = toScreen(...proj(lon, lat));
    handleGuess(px, py);
  };
  window.PP.timeOut = () => { stopTimer(); timeOut(); };
  window.PP.nextPin = nextPin;
  window.PP.beginRound = beginRound;
  window.PP.useHint = useHint;
  window.PP.exploreLatLon = (lat, lon) => { const [px, py] = toScreen(...proj(lon, lat)); exploreAt(px, py); };
  window.PP.clearExplore = clearExplore;
  window.PP.celebrate = (level) => { const G2 = G; const t = G2.target; celebrate(level, { mi: [400, 200, 80, 20, 3][level - 1] }, t); };
  window.PP.advance = advance;
  window.PP._viewCenter = () => toMap(V.w / 2, V.h / 2);
  window.PP._unproj = (px, py) => unproj(...toMap(px, py));
})();
