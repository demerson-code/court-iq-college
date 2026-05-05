/* =============================================================
   Court IQ College — Volleyball Lineup Tool
   Single-file app logic: state, persistence, UI, algorithm

   ⚠️  This is a fresh fork of the youth-rec Court IQ tool
   (https://github.com/demerson-code/court-iq). The college version
   needs significant rework before this is suitable for a college
   team. Major TODOs:
     - Rotation systems: support 5-1 (one fixed setter) and 6-2
       (two setters from back row). Add a setter-system selector.
     - Specialized positions: tag each player with primary position
       (OH1 / OH2 / MB1 / MB2 / S / OPP / L / DS) and respect those
       constraints in the optimizer.
     - Libero rules: back-row only, doesn't count in rotation, may
       or may not serve depending on league.
     - NCAA substitution model: 15 subs/set cap, re-entry rules.
     - Algorithm: position-locked assignment problem (Hungarian /
       constraint solver), not "best 6 + balance variance."
     - Skills: split passing into serve-receive vs free-ball pass,
       add blocking, add hitting efficiency, add tempo for setters.
     - Match-day mode: situational lineups, opponent scouting,
       live sub tracking.
   ============================================================= */

/* ===== Constants ===== */
const ROLES = ['OH', 'MB', 'S', 'OPP', 'L', 'DS'];
const ROLE_LABELS = {
  OH: 'Outside Hitter',
  MB: 'Middle Blocker',
  S: 'Setter',
  OPP: 'Opposite',
  L: 'Libero',
  DS: 'Defensive Specialist'
};

const SKILLS = ['serving', 'serveReceive', 'defense', 'hitting', 'blocking', 'setting'];
const SKILL_LABELS = {
  serving: 'Serving',
  serveReceive: 'Serve Receive',
  defense: 'Defense',
  hitting: 'Hitting',
  blocking: 'Blocking',
  setting: 'Setting'
};
const SKILL_LABELS_SHORT = {
  serving: 'Serve',
  serveReceive: 'Recv',
  defense: 'Def',
  hitting: 'Hit',
  blocking: 'Block',
  setting: 'Set'
};
const SETTER_TEMPO_KEY = 'setterTempo'; // toggleable 7th skill, S-only

const RULESETS = {
  rec:  { label: 'Rec League',     subsPerSet: 12, liberoMayServe: false, reentry: 'sameSlot', timeoutsPerSet: 2 },
  ncaa: { label: "NCAA Women's",   subsPerSet: 15, liberoMayServe: true,  reentry: 'sameSlot', timeoutsPerSet: 2 }
};

// Per-role skill weights (higher = more important for that role).
// Used by Block 2's algorithm; declared here so the data model and
// algorithm share a single source of truth.
const ROLE_SKILL_WEIGHTS = {
  OH:  { serving: 1.5, serveReceive: 2.5, defense: 1.5, hitting: 3.0, blocking: 1.0, setting: 0.5 },
  MB:  { serving: 1.0, serveReceive: 0.5, defense: 1.0, hitting: 2.5, blocking: 4.0, setting: 0.5, bonusBackRow: 'serveReceive' },
  S:   { serving: 1.5, serveReceive: 0.5, defense: 2.0, hitting: 0.5, blocking: 0.5, setting: 5.0 },
  OPP: { serving: 2.0, serveReceive: 0.5, defense: 1.5, hitting: 3.5, blocking: 2.0, setting: 0.5 },
  L:   { serving: 1.0, serveReceive: 5.0, defense: 4.0, hitting: 0.0, blocking: 0.0, setting: 0.0 },
  DS:  { serving: 1.5, serveReceive: 4.5, defense: 4.0, hitting: 0.0, blocking: 0.0, setting: 0.0 }
};
// Setter tempo is added at full weight (5.0) for S-role lineup scoring when settings.showSetterTempo is on.

const POSITION_NAMES = {
  1: 'Server',
  2: 'Setter',
  3: 'Mid Front',
  4: 'Outside',
  5: 'Left Back',
  6: 'Mid Back'
};

// safeStorage: localStorage with try/catch + in-memory fallback for mobile Safari private mode.
const safeStorage = (() => {
  let inMemory = {};
  const test = () => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return true; } catch { return false; } };
  const ok = test();
  return {
    get: (k) => ok ? localStorage.getItem(k) : (inMemory[k] ?? null),
    set: (k, v) => { if (ok) try { localStorage.setItem(k, v); } catch { inMemory[k] = v; } else inMemory[k] = v; },
    remove: (k) => { if (ok) try { localStorage.removeItem(k); } catch {} delete inMemory[k]; }
  };
})();

const STORAGE_KEY = 'court_iq_college_v1';
const LEGACY_KEY = 'court_iq_v1'; // youth-rec collision; one-time migrate

/* ===== State ===== */
const TEAM_NAME = 'College';   // TODO: replace with friend's actual college team name

function defaultSettings() {
  return { ruleset: 'rec', system: '5-1', showJersey: false, showSetterTempo: false };
}

function defaultWeights() {
  // Equal-weight default; coach can tune in the Weights tab.
  // Block 2's optimizer multiplies these by ROLE_SKILL_WEIGHTS — coach weights
  // act as a global "this skill matters more on our team" knob.
  const w = {};
  SKILLS.forEach(s => w[s] = 5);
  return w;
}

let S = {
  teamName: TEAM_NAME,
  players: [],
  weights: defaultWeights(),
  settings: defaultSettings(),
  mode: 'strict',
  result: null,
  currentRotation: 0,
  swapMode: null,
  lastEdited: null,
  rosterSort: 'avg-desc',   // 'avg-desc' | 'avg-asc' | 'name-asc' | 'name-desc'
  benchSort: 'avg-desc'
};

const SORT_MODES = new Set(['avg-desc', 'avg-asc', 'name-asc', 'name-desc']);

/* ===== Helpers ===== */
function genId() {
  return Math.random().toString(36).slice(2, 9);
}

function defaultSkills() {
  const o = {};
  SKILLS.forEach(s => o[s] = 5);
  return o;
}

function createPlayer(name = '', positions = ['OH', null]) {
  return {
    id: genId(),
    name,
    jersey: '',                 // string; blank when toggle is off
    height: '',                 // freeform e.g. "6-1" or "185cm"
    hand: 'R',                  // 'R' | 'L'
    positions,                  // [primary, secondary|null], values from ROLES
    skills: defaultSkills(),
    setterTempo: 5,             // only surfaced when settings.showSetterTempo and primary === 'S'
    available: true
  };
}

// One-time migration of pre-college (youth-rec) player records.
// Old shape: skills.passing, skills.spiking, skills.attitude, skills.communication; no positions.
// New shape: skills.serveReceive + skills.defense + skills.hitting + skills.blocking; positions[].
function migratePlayer(p) {
  if (!p || typeof p !== 'object') return p;
  const isLegacy = p.skills && (
    'passing' in p.skills || 'spiking' in p.skills ||
    'attitude' in p.skills || 'communication' in p.skills
  ) && !Array.isArray(p.positions);
  if (!isLegacy) return p;

  const old = p.skills || {};
  const passing = (old.passing | 0) || 5;
  const newSkills = {
    serving:      (old.serving | 0) || 5,
    serveReceive: passing,                     // best-guess split: passing -> both
    defense:      (old.defense | 0) || passing,
    hitting:      (old.spiking | 0) || 5,
    blocking:     5,                           // no analog in old data
    setting:      (old.setting | 0) || 5
  };
  // attitude / communication: no analog, drop.
  return {
    ...p,
    skills: newSkills,
    jersey: p.jersey || '',
    height: p.height || '',
    hand: p.hand || 'R',
    positions: Array.isArray(p.positions) ? p.positions : ['OH', null],
    setterTempo: typeof p.setterTempo === 'number' ? p.setterTempo : 5
  };
}

function el(tag, opts = {}, children = []) {
  const e = document.createElement(tag);
  if (opts.cls) e.className = opts.cls;
  if (opts.text != null) e.textContent = opts.text;
  if (opts.attrs) {
    for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
  }
  if (opts.dataset) {
    for (const k in opts.dataset) e.dataset[k] = opts.dataset[k];
  }
  if (opts.on) {
    for (const k in opts.on) e.addEventListener(k, opts.on[k]);
  }
  if (opts.title) e.title = opts.title;
  children.forEach(c => {
    if (c == null) return;
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  });
  return e;
}

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

/* ===== Persistence ===== */
let urlUpdateTimer = null;
let lastEditedDisplayTimer = null;

function save(opts = {}) {
  // Bump timestamp for real edits (not for hash-load mirroring)
  if (!opts.silent) S.lastEdited = Date.now();

  const payload = {
    teamName: S.teamName,
    players: S.players.map(p => ({
      id: p.id,
      name: p.name,
      jersey: p.jersey || '',
      height: p.height || '',
      hand: p.hand || 'R',
      positions: p.positions || ['OH', null],
      skills: p.skills,
      setterTempo: typeof p.setterTempo === 'number' ? p.setterTempo : 5,
      available: p.available
    })),
    weights: S.weights,
    settings: S.settings,
    mode: S.mode,
    lastEdited: S.lastEdited,
    rosterSort: S.rosterSort,
    benchSort: S.benchSort
  };
  safeStorage.set(STORAGE_KEY, JSON.stringify(payload));

  // Auto-sync the URL hash so the address bar always reflects current state.
  // Debounced so rapid edits don't thrash history.replaceState.
  clearTimeout(urlUpdateTimer);
  urlUpdateTimer = setTimeout(() => {
    if (!hasMeaningfulState()) return;
    history.replaceState(null, '', '#d=' + encodeStateForUrl());
    updateLastEditedDisplay();
  }, 400);

  // Update display sooner so the user sees feedback
  updateLastEditedDisplay();
}

function hasMeaningfulState() {
  return S.players.length > 0 || (S.teamName && S.teamName.trim().length);
}

function load() {
  const urlState = readStateFromUrl();
  if (urlState) {
    applyLoadedState(urlState);
    // Mirror to localStorage but keep the loaded timestamp (don't bump it)
    save({ silent: true });
    return { fromUrl: true };
  }
  try {
    let raw = safeStorage.get(STORAGE_KEY);
    if (!raw) {
      const legacy = safeStorage.get(LEGACY_KEY);
      // Silent migration: copy youth-rec record into the college-scoped key.
      // Don't delete the legacy key — youth tool still owns it.
      if (legacy) { safeStorage.set(STORAGE_KEY, legacy); raw = legacy; }
    }
    if (raw) applyLoadedState(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return { fromUrl: false };
}

function applyLoadedState(data) {
  if (!data) return;
  // Team name is fixed for this season — keep TEAM_NAME regardless of incoming data
  S.teamName = TEAM_NAME;
  if (Array.isArray(data.players)) {
    S.players = data.players.map(raw => {
      // First migrate any youth-rec / v1 records to the college shape, then
      // normalize against the new shape's defaults.
      const migrated = migratePlayer(raw);
      return {
        id: migrated.id || genId(),
        name: migrated.name || '',
        jersey: migrated.jersey || '',
        height: migrated.height || '',
        hand: migrated.hand === 'L' ? 'L' : 'R',
        positions: Array.isArray(migrated.positions) && migrated.positions.length
          ? [migrated.positions[0] || 'OH', migrated.positions[1] || null]
          : ['OH', null],
        skills: { ...defaultSkills(), ...(migrated.skills || {}) },
        setterTempo: typeof migrated.setterTempo === 'number' ? migrated.setterTempo : 5,
        available: migrated.available !== false
      };
    });
  }
  if (data.weights) {
    // Discard stale skill keys (passing/spiking/attitude/communication) — keep only current SKILLS.
    const w = defaultWeights();
    SKILLS.forEach(k => { if (typeof data.weights[k] === 'number') w[k] = data.weights[k]; });
    S.weights = w;
  }
  if (data.settings && typeof data.settings === 'object') {
    S.settings = {
      ...defaultSettings(),
      ...data.settings,
      ruleset: RULESETS[data.settings.ruleset] ? data.settings.ruleset : 'rec',
      system: (data.settings.system === '6-2' ? '6-2' : '5-1')
    };
  }
  if (data.mode === 'loose' || data.mode === 'strict') {
    S.mode = data.mode;
  }
  if (typeof data.lastEdited === 'number') S.lastEdited = data.lastEdited;
  if (SORT_MODES.has(data.rosterSort)) S.rosterSort = data.rosterSort;
  if (SORT_MODES.has(data.benchSort)) S.benchSort = data.benchSort;
}

/* ===== Sorting ===== */
function sortByMode(items, mode, getName, getAvg) {
  const arr = items.slice();
  switch (mode) {
    case 'avg-asc':
      return arr.sort((a, b) => getAvg(a) - getAvg(b));
    case 'name-asc':
      return arr.sort((a, b) => (getName(a) || '').toLocaleLowerCase().localeCompare((getName(b) || '').toLocaleLowerCase()));
    case 'name-desc':
      return arr.sort((a, b) => (getName(b) || '').toLocaleLowerCase().localeCompare((getName(a) || '').toLocaleLowerCase()));
    case 'avg-desc':
    default:
      return arr.sort((a, b) => getAvg(b) - getAvg(a));
  }
}

/* ===== URL encoding (compact base64url JSON) =====
   Block 4 will replace this with a versioned (v:2) format. For Block 1 we
   extend the existing payload with optional fields so refresh-via-URL
   round-trips the new player shape without data loss. */
function encodeStateForUrl() {
  const compact = {
    t: S.teamName || undefined,
    p: S.players.map(p => ({
      n: p.name || '',
      s: SKILLS.map(k => p.skills[k] | 0),
      a: p.available ? 1 : 0,
      pos: p.positions || ['OH', null],
      h: p.hand === 'L' ? 'L' : 'R',
      ht: p.height || '',
      j: p.jersey || '',
      st: typeof p.setterTempo === 'number' ? p.setterTempo : 5
    })),
    w: SKILLS.map(k => S.weights[k] | 0),
    cfg: S.settings,
    m: S.mode === 'loose' ? 0 : 1,
    e: S.lastEdited || undefined
  };
  return b64urlEncode(JSON.stringify(compact));
}

function readStateFromUrl() {
  const m = window.location.hash.match(/^#d=(.+)$/);
  if (!m) return null;
  try {
    const c = JSON.parse(b64urlDecode(m[1]));
    return {
      teamName: c.t || '',
      players: (c.p || []).map(p => {
        const skills = {};
        SKILLS.forEach((k, i) => skills[k] = (p.s && p.s[i]) || 5);
        return {
          id: genId(),
          name: p.n || '',
          jersey: p.j || '',
          height: p.ht || '',
          hand: p.h === 'L' ? 'L' : 'R',
          positions: Array.isArray(p.pos) && p.pos.length
            ? [p.pos[0] || 'OH', p.pos[1] || null]
            : ['OH', null],
          skills,
          setterTempo: typeof p.st === 'number' ? p.st : 5,
          available: p.a !== 0
        };
      }),
      weights: (() => {
        const w = defaultWeights();
        SKILLS.forEach((k, i) => { if (c.w && typeof c.w[i] === 'number') w[k] = c.w[i]; });
        return w;
      })(),
      settings: (c.cfg && typeof c.cfg === 'object') ? c.cfg : null,
      mode: c.m === 0 ? 'loose' : 'strict',
      lastEdited: typeof c.e === 'number' ? c.e : null
    };
  } catch (e) { return null; }
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function buildShareUrl() {
  const url = new URL(window.location.href);
  url.hash = 'd=' + encodeStateForUrl();
  return url.toString();
}

/* ===== Help system =====
   Help content stored as structured data. Each entry defines title +
   an array of body items rendered as DOM (no innerHTML on dynamic
   strings). Items: {p}=paragraph, {h}=subheading, {dl}=def list,
   {callout}=highlighted note. */
const HELP = {
  'skills-key': {
    title: 'Skills explained',
    body: [
      { p: 'Each player has 6 skills, rated 1–10. Use these definitions to keep ratings consistent across your roster:' },
      { dl: [
        ['Serving', 'Power, accuracy, and consistency of their serve.'],
        ['Serve Receive', 'Passing a live serve cleanly to the setter.'],
        ['Defense', 'Digging hard-driven balls, reading the opponent’s attack.'],
        ['Hitting', 'Attacking strength at the net — kill efficiency and shot selection.'],
        ['Blocking', 'Reading the setter, timing, and getting hands over the net.'],
        ['Setting', 'Running offense as the setter — placing the second touch for a hitter.']
      ] },
      { callout: 'Setters can also be rated on tempo (toggle in the topbar) — how well they run quick / slide / back sets.' },
      { callout: 'Tip: rate honestly relative to your team. A 7 means "above average for our group," not "above average in the league."' }
    ]
  },
  'lineup-mode': {
    title: 'Strict vs. Loose mode',
    body: [
      { h: 'Strict — Real volleyball rotation' },
      { p: 'The same 6 players cycle through all 6 court positions over the set, in legal volleyball rotation order. The optimizer picks an arrangement that:' },
      { dl: [
        ['Avoids weak rotations', 'Spreads strong players across the cycle so no rotation is mostly weak players.'],
        ['Honors position 2 setter', 'Whoever rotates into position 2 is the setter for that rotation, so setting skill is weighted there.'],
        ['Optimizes serving order', 'The strongest server starts at position 1.']
      ] },
      { callout: 'Use this for actual games where rotation rules apply.' },
      { h: 'Loose — Best player at each spot' },
      { p: 'Each player is pinned to the position they’re best suited for, ignoring rotation. The setter stays at setter, the strongest hitter stays front-row, etc.' },
      { callout: 'Use this for practice, scrimmage, or to see where each player’s strengths lie when freed from rotation rules.' }
    ]
  },
  'rotation-strength': {
    title: 'Rotation strength bars',
    body: [
      { p: 'Each bar represents one of the 6 rotations during the set. The height is the total skill on the court for that rotation — taller bars are stronger rotations.' },
      { dl: [
        ['Green bars', 'Strong rotations.'],
        ['Yellow bars', 'Weakest rotations — your team is most vulnerable here. Keep an eye on these in the game.'],
        ['Active bar', 'The rotation currently shown on the court (filled darker).']
      ] },
      { callout: 'Tap any bar to jump to that rotation on the court.' }
    ]
  },
  'court-legend': {
    title: 'Court legend',
    body: [
      { p: 'A few visual cues on the court diagram:' },
      { dl: [
        ['Yellow ring', 'The server for this rotation (position 1).'],
        ['Green-tint background', 'The setter for this rotation (position 2). Whoever rotates here sets.'],
        ['Position numbers', '4-3-2 is the front row (left to right). 5-6-1 is the back row.']
      ] },
      { p: 'Tap any player to see their fit at every position. Drag a player onto another to swap them. Drag onto the bench drop zone to sub them off.' }
    ]
  }
};

function openHelp(key) {
  const entry = HELP[key];
  if (!entry) return;
  $('#helpTitle').textContent = entry.title;
  const bodyEl = $('#helpBody');
  bodyEl.replaceChildren();
  for (const item of entry.body) {
    if (item.p) bodyEl.appendChild(el('p', { text: item.p }));
    else if (item.h) bodyEl.appendChild(el('h4', { text: item.h, attrs: { style: 'font-size:14px;margin:14px 0 6px;color:var(--green-dark);' } }));
    else if (item.dl) {
      const dl = document.createElement('dl');
      for (const [t, d] of item.dl) {
        dl.appendChild(el('dt', { text: t }));
        dl.appendChild(el('dd', { text: d }));
      }
      bodyEl.appendChild(dl);
    } else if (item.callout) {
      bodyEl.appendChild(el('div', { cls: 'help-callout', text: item.callout }));
    }
  }
  $('#helpModal').hidden = false;
}

function closeHelp() {
  $('#helpModal').hidden = true;
}

function makeHelpButton(key, label = 'What is this?') {
  return el('button', {
    cls: 'help-btn',
    text: '?',
    attrs: { 'aria-label': label, type: 'button' },
    on: {
      click: e => {
        e.preventDefault();
        e.stopPropagation();
        openHelp(key);
      }
    }
  });
}

/* ===== Last-edited display ===== */
function formatRelativeTime(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 0 || sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    return `${m} min${m === 1 ? '' : 's'} ago`;
  }
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    return `${h} hr${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(sec / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function updateLastEditedDisplay() {
  const bar = document.getElementById('statusBar');
  const text = document.getElementById('lastEditedText');
  if (!bar || !text) return;
  if (S.lastEdited) {
    bar.hidden = false;
    text.textContent = `${S.teamName ? S.teamName + ' • ' : ''}edited ${formatRelativeTime(S.lastEdited)}`;
  } else {
    bar.hidden = true;
  }
  // Re-tick every minute so the relative time stays accurate
  clearTimeout(lastEditedDisplayTimer);
  lastEditedDisplayTimer = setTimeout(updateLastEditedDisplay, 60_000);
}

/* ===== Share modal ===== */
async function openShareModal() {
  const url = buildShareUrl();
  const teamName = S.teamName?.trim() || 'Untitled team';
  const playerCount = S.players.filter(p => (p.name || '').trim()).length;
  const editedTxt = S.lastEdited ? `edited ${formatRelativeTime(S.lastEdited)}` : 'never edited';

  document.getElementById('shareModalInfo').textContent =
    `${teamName} · ${playerCount} player${playerCount === 1 ? '' : 's'} · ${editedTxt}`;

  const input = document.getElementById('shareUrlInput');
  input.value = url;

  const nativeBtn = document.getElementById('shareNativeBtn');
  // Show native share if supported on this device
  const shareData = { title: `${teamName} — Court IQ`, text: `Court IQ team: ${teamName}`, url };
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    nativeBtn.hidden = false;
  } else {
    nativeBtn.hidden = true;
  }

  document.getElementById('shareModal').hidden = false;
  // Make sure the URL hash is up to date right now (don't wait for debounce)
  history.replaceState(null, '', '#d=' + encodeStateForUrl());
}

function closeShareModal() {
  document.getElementById('shareModal').hidden = true;
}

async function shareNativeOrCopy() {
  const url = buildShareUrl();
  const teamName = S.teamName?.trim() || 'Court IQ team';
  const shareData = {
    title: `${teamName} — Court IQ`,
    text: `${teamName} on Court IQ:`,
    url
  };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      closeShareModal();
      return;
    } catch (e) {
      if (e?.name !== 'AbortError') {
        // Fall through to clipboard
      } else {
        return;
      }
    }
  }
  await copyShareUrl();
}

async function copyShareUrl() {
  const url = buildShareUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — paste it in iMessage or email.');
  } catch (e) {
    // Last resort
    const input = document.getElementById('shareUrlInput');
    input.select();
    document.execCommand?.('copy');
    toast('Link copied.');
  }
}

/* ===== Algorithm =====
   NOTE: this entire block (down through optimizeLooseArrangement) is the
   inherited youth-rec optimizer and is scheduled for full deletion in
   Block 2. The new SKILLS keys don't match the old POS_MULT table, so
   the optimizer here produces a degenerate (avg-skill * coach-weight)
   lineup until Block 2 lands. */
function playerScoreAtPosition(player, pos) {
  let score = 0;
  for (const s of SKILLS) {
    score += (player.skills[s] || 0) * (S.weights[s] || 0);
  }
  return score;
}

function playerAvgValue(player) {
  let sum = 0;
  for (let p = 1; p <= 6; p++) sum += playerScoreAtPosition(player, p);
  return sum / 6;
}

function playerSkillRaw(player) {
  let s = 0;
  for (const k of SKILLS) s += (player.skills[k] || 0);
  return s / SKILLS.length;
}

function pickBestSix(availablePlayers) {
  return [...availablePlayers]
    .map(p => ({ p, v: playerAvgValue(p) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 6)
    .map(x => x.p);
}

function permute(arr, cb) {
  // Heap's algorithm — generates all permutations of arr.
  const n = arr.length;
  const a = arr.slice();
  const c = new Array(n).fill(0);
  cb(a);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const swap = i % 2 === 0 ? 0 : c[i];
      const tmp = a[swap]; a[swap] = a[i]; a[i] = tmp;
      cb(a);
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

/* Strict: 6 players cycle through 6 positions. Sum of rotation scores is
   a constant for any given 6 players (each player visits each position
   exactly once). We optimize for:
     1. max(min rotation score) — no weak rotations
     2. low variance — balanced rotations
     3. strong server in pos 1 at rotation 0 — tiebreaker
*/
function optimizeStrictArrangement(six) {
  let best = null;
  permute(six, perm => {
    const rotScores = [];
    for (let r = 0; r < 6; r++) {
      let total = 0;
      for (let startPos = 1; startPos <= 6; startPos++) {
        const player = perm[startPos - 1];
        const currentPos = ((startPos - 1 - r + 6) % 6) + 1;
        total += playerScoreAtPosition(player, currentPos);
      }
      rotScores.push(total);
    }
    const minRot = Math.min(...rotScores);
    const meanRot = rotScores.reduce((a, b) => a + b, 0) / 6;
    const variance = rotScores.reduce((a, b) => a + (b - meanRot) ** 2, 0) / 6;
    const serverSkill = perm[0].skills.serving || 0;
    const score = minRot * 1000 - variance * 0.5 + serverSkill * 0.1;
    if (!best || score > best.score) {
      best = { perm: perm.slice(), score, rotScores };
    }
  });
  return best;
}

/* Loose: pure 6-position assignment problem — best player in each spot. */
function optimizeLooseArrangement(six) {
  let best = null;
  permute(six, perm => {
    let total = 0;
    for (let pos = 1; pos <= 6; pos++) {
      total += playerScoreAtPosition(perm[pos - 1], pos);
    }
    if (!best || total > best.score) {
      best = { perm: perm.slice(), score: total };
    }
  });
  return best;
}

function generateLineup() {
  const available = S.players.filter(p => p.available && (p.name || '').trim());
  if (available.length < 6) {
    return { error: `Need at least 6 available players (you have ${available.length}).` };
  }
  const six = pickBestSix(available);

  let result;
  if (S.mode === 'loose') {
    const out = optimizeLooseArrangement(six);
    const rotation = {};
    for (let i = 0; i < 6; i++) rotation[i + 1] = out.perm[i];
    result = {
      mode: 'loose',
      starting6: out.perm,
      rotations: [rotation],
      rotationScores: [out.score]
    };
  } else {
    const out = optimizeStrictArrangement(six);
    const rotations = [];
    for (let r = 0; r < 6; r++) {
      const rot = {};
      for (let startPos = 1; startPos <= 6; startPos++) {
        const player = out.perm[startPos - 1];
        const currentPos = ((startPos - 1 - r + 6) % 6) + 1;
        rot[currentPos] = player;
      }
      rotations.push(rot);
    }
    result = {
      mode: 'strict',
      starting6: out.perm,
      rotations,
      rotationScores: out.rotScores
    };
  }

  // Snapshot the algorithm's pick so user can reset back to it after manual edits
  result.algorithmStarting6 = result.starting6.slice();
  result.benchPool = available.slice();   // all available players, used to manage swaps
  result.modified = false;

  rebuildDerivedFields(result);
  return result;
}

/* Re-derives rotations, rotationScores, bench, and servingOrder from
   result.starting6 + result.benchPool. Called after any manual swap. */
function rebuildDerivedFields(result) {
  if (result.mode === 'strict') {
    const rotations = [];
    const rotScores = [];
    for (let r = 0; r < 6; r++) {
      const rot = {};
      let total = 0;
      for (let startPos = 1; startPos <= 6; startPos++) {
        const player = result.starting6[startPos - 1];
        const currentPos = ((startPos - 1 - r + 6) % 6) + 1;
        rot[currentPos] = player;
        total += playerScoreAtPosition(player, currentPos);
      }
      rotations.push(rot);
      rotScores.push(total);
    }
    result.rotations = rotations;
    result.rotationScores = rotScores;
    const order = [];
    for (let r = 0; r < 6; r++) order.push(result.rotations[r][1]);
    result.servingOrder = order;
  } else {
    const rotation = {};
    let total = 0;
    for (let i = 0; i < 6; i++) {
      rotation[i + 1] = result.starting6[i];
      total += playerScoreAtPosition(result.starting6[i], i + 1);
    }
    result.rotations = [rotation];
    result.rotationScores = [total];
    result.servingOrder = [...result.starting6].sort(
      (a, b) => (b.skills.serving || 0) - (a.skills.serving || 0)
    );
  }

  const startingIds = new Set(result.starting6.map(p => p.id));
  result.bench = result.benchPool
    .filter(p => !startingIds.has(p.id))
    .map(p => ({ player: p, value: playerAvgValue(p), skill: playerSkillRaw(p) }))
    .sort((a, b) => b.value - a.value);
}

/* ===== Swap / Sub-In Logic ===== */
function arraysSamePlayers(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

function markModifiedIfChanged() {
  if (!S.result) return;
  S.result.modified = !arraysSamePlayers(S.result.starting6, S.result.algorithmStarting6);
}

function swapTwoOnCourt(idxA, idxB) {
  const r = S.result;
  if (idxA === idxB) return;
  const tmp = r.starting6[idxA];
  r.starting6[idxA] = r.starting6[idxB];
  r.starting6[idxB] = tmp;
  rebuildDerivedFields(r);
  markModifiedIfChanged();
}

function subInBenchPlayer(benchPlayerId, courtIdx) {
  const r = S.result;
  const benchPlayer = r.benchPool.find(p => p.id === benchPlayerId);
  if (!benchPlayer) return;
  // benchPlayer is already in benchPool; just swap references in starting6.
  // (benchPool stays the same; rebuildDerivedFields recomputes who's bench.)
  r.starting6[courtIdx] = benchPlayer;
  rebuildDerivedFields(r);
  markModifiedIfChanged();
}

function startingIdxOfPlayer(playerId) {
  return S.result.starting6.findIndex(p => p.id === playerId);
}

function startingIdxAtPosition(pos, rotIdx) {
  // Find which starting6 index corresponds to a player currently at `pos` in rotation `rotIdx`.
  // Rotation cycle: a player at starting position S is at currentPos((S-1 - r + 6) % 6) + 1.
  // So given a current position P, starting position S = ((P - 1 + r) % 6) + 1.
  const startPos = ((pos - 1 + rotIdx) % 6) + 1;
  return startPos - 1;
}

/* ===== Swap mode ===== */
function enterSwapMode(kind, idx) {
  S.swapMode = { kind, idx };
  document.body.classList.add('swap-mode');
  // Mark the source player on court
  const sourcePlayer = kind === 'court'
    ? S.result.starting6[idx]
    : S.result.benchPool.find(p => p.id === idx);
  $$('.player-circle').forEach(c => c.classList.remove('swap-source'));
  if (kind === 'court' && sourcePlayer) {
    const circle = document.querySelector(`.player-circle[data-player-id="${sourcePlayer.id}"]`);
    if (circle) circle.classList.add('swap-source');
  }
  const banner = $('#swapBanner');
  const text = $('#swapBannerText');
  text.textContent = kind === 'court'
    ? `Tap a different player to swap with ${sourcePlayer?.name?.split(' ')[0] || 'them'}`
    : `Tap a court player to sub in ${sourcePlayer?.name?.split(' ')[0] || 'them'}`;
  banner.hidden = false;
}

function exitSwapMode() {
  S.swapMode = null;
  document.body.classList.remove('swap-mode');
  $$('.player-circle').forEach(c => c.classList.remove('swap-source'));
  $('#swapBanner').hidden = true;
}

function handleCourtPlayerTap(playerId) {
  if (!S.result) return;
  if (S.swapMode) {
    const courtIdx = startingIdxOfPlayer(playerId);
    if (S.swapMode.kind === 'court') {
      if (S.swapMode.idx === courtIdx) {
        // Tapped the source again — cancel
        exitSwapMode();
        return;
      }
      swapTwoOnCourt(S.swapMode.idx, courtIdx);
      exitSwapMode();
      renderLineup();
      toast('Swapped.');
    } else if (S.swapMode.kind === 'bench') {
      subInBenchPlayer(S.swapMode.idx, courtIdx);  // idx is benchPlayerId for bench mode
      exitSwapMode();
      renderLineup();
      toast('Subbed in.');
    }
    return;
  }
  // No swap mode — open breakdown
  openBreakdown(playerId);
}

/* ===== Breakdown popup ===== */
function openBreakdown(playerId) {
  if (!S.result) return;
  const courtIdx = startingIdxOfPlayer(playerId);
  if (courtIdx < 0) return;
  const player = S.result.starting6[courtIdx];
  const rotIdx = S.result.mode === 'strict' ? S.currentRotation : 0;
  const currentPos = ((courtIdx - rotIdx + 6) % 6) + 1;

  // Compute score at all 6 positions
  const scores = [];
  for (let p = 1; p <= 6; p++) {
    scores.push({ pos: p, score: playerScoreAtPosition(player, p) });
  }
  const max = Math.max(...scores.map(s => s.score));
  const bestPos = scores.find(s => s.score === max).pos;

  // Avatar = first letter
  const avatar = $('#breakdownAvatar');
  avatar.textContent = (player.name || '?').trim().charAt(0).toUpperCase();
  $('#breakdownName').textContent = player.name || '?';
  $('#breakdownPosition').textContent = `Currently at ${POSITION_NAMES[currentPos]} (pos ${currentPos})`;

  // Bars
  const bars = $('#breakdownBars');
  bars.replaceChildren();
  for (let p = 1; p <= 6; p++) {
    const s = scores.find(x => x.pos === p);
    const cls = ['bd-bar-row'];
    if (p === currentPos) cls.push('is-current');
    if (p === bestPos) cls.push('is-best');
    const widthPct = (s.score / max) * 100;
    const label = el('span', { cls: 'bd-bar-label', text: `${POSITION_NAMES[p]} (${p})` });
    const fill = el('div', { cls: 'bd-bar-fill' });
    fill.style.width = widthPct.toFixed(1) + '%';
    const track = el('div', { cls: 'bd-bar-track' }, [fill]);
    const value = el('span', { cls: 'bd-bar-value', text: s.score.toFixed(0) });
    bars.appendChild(el('div', { cls: cls.join(' ') }, [label, track, value]));
  }

  // Stash player id on the modal so action buttons know who
  $('#breakdownModal').dataset.playerId = playerId;
  $('#breakdownModal').hidden = false;
}

function closeBreakdown() {
  $('#breakdownModal').hidden = true;
}

function breakdownStartSwap() {
  const playerId = $('#breakdownModal').dataset.playerId;
  const courtIdx = startingIdxOfPlayer(playerId);
  if (courtIdx < 0) return;
  closeBreakdown();
  enterSwapMode('court', courtIdx);
}

function breakdownSubOff() {
  // Remove this player; bring in the highest-ranked bench player.
  const playerId = $('#breakdownModal').dataset.playerId;
  const courtIdx = startingIdxOfPlayer(playerId);
  if (courtIdx < 0) return;
  if (!S.result.bench.length) {
    toast('No bench players available.');
    return;
  }
  const incoming = S.result.bench[0].player;
  S.result.starting6[courtIdx] = incoming;
  rebuildDerivedFields(S.result);
  markModifiedIfChanged();
  closeBreakdown();
  renderLineup();
  toast(`${incoming.name?.split(' ')[0] || 'Sub'} subbed in.`);
}

function resetToOptimal() {
  if (!S.result) return;
  S.result.starting6 = S.result.algorithmStarting6.slice();
  rebuildDerivedFields(S.result);
  S.result.modified = false;
  renderLineup();
  toast('Reset to optimal lineup.');
}

/* ===== Drag & Drop ===== */
let dragState = null;

function onDragStart(opts, e) {
  // opts: { kind: 'court'|'bench', playerId, courtIdx? }
  if (S.swapMode) return;            // swap mode pre-empts drag
  if (e.button != null && e.button !== 0) return;  // left click only

  // Don't start a drag if user pressed on a button inside the source
  if (e.target.closest('button')) return;

  dragState = {
    ...opts,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    didMove: false,
    ghost: null,
    sourceEl: e.currentTarget
  };
  // Capture so move/up arrive even if pointer leaves the source
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
}

function onDragMove(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (!dragState.didMove && dist > 8) {
    dragState.didMove = true;
    document.body.classList.add('dragging');
    if (dragState.kind === 'court') document.body.classList.add('dragging-court');
    dragState.sourceEl?.classList.add('drag-source');
    dragState.ghost = makeGhost(dragState);
    document.body.appendChild(dragState.ghost);
  }
  if (dragState.didMove) {
    moveGhost(dragState.ghost, e.clientX, e.clientY);
    updateDropHighlight(e.clientX, e.clientY, dragState);
    e.preventDefault?.();
  }
}

function onDragEnd(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const ds = dragState;
  dragState = null;
  if (ds.didMove) {
    // Find target BEFORE removing dragging classes — otherwise the bench
    // drop zone (display:none unless body.dragging-court) would vanish first.
    let target = null;
    if (e.type !== 'pointercancel') {
      target = findDropTarget(e.clientX, e.clientY);
    }
    document.body.classList.remove('dragging');
    document.body.classList.remove('dragging-court');
    ds.sourceEl?.classList.remove('drag-source');
    if (ds.ghost) ds.ghost.remove();
    clearDropHighlight();
    if (target) performDrop(ds, target);
  }
}

function makeGhost(state) {
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  let player;
  if (state.kind === 'court') {
    player = S.result.starting6.find(p => p.id === state.playerId);
  } else {
    player = S.result.benchPool.find(p => p.id === state.playerId);
  }
  if (!player) return ghost;
  const firstName = (player.name || '?').split(' ')[0];
  ghost.appendChild(el('span', { cls: 'pname', text: firstName }));
  return ghost;
}

function moveGhost(ghost, x, y) {
  if (!ghost) return;
  ghost.style.left = x + 'px';
  ghost.style.top = y + 'px';
}

function findDropTarget(x, y) {
  // Returns: { kind: 'court', courtIdx } | { kind: 'bench' } | null
  const els = document.elementsFromPoint(x, y);
  for (const e of els) {
    if (e.classList?.contains('player-circle')) {
      const playerId = e.dataset.playerId;
      const idx = startingIdxOfPlayer(playerId);
      if (idx >= 0) return { kind: 'court', courtIdx: idx, el: e };
    }
    if (e.id === 'benchDropZone' || e.id === 'benchCard' || e.id === 'benchList' || e.classList?.contains('bench-list')) {
      return { kind: 'bench', el: document.getElementById('benchDropZone') };
    }
    if (e.tagName === 'LI' && e.parentElement?.id === 'benchList') {
      return { kind: 'bench', el: document.getElementById('benchDropZone') };
    }
  }
  return null;
}

let lastHighlight = null;
function updateDropHighlight(x, y, ds) {
  const target = findDropTarget(x, y);
  if (lastHighlight && lastHighlight !== target?.el) {
    lastHighlight.classList.remove('drop-target-active');
  }
  if (target?.el) {
    // Don't highlight if dropping there is a no-op
    if (ds.kind === 'court' && target.kind === 'court' && target.courtIdx === ds.courtIdx) {
      lastHighlight = null;
      return;
    }
    if (ds.kind === 'bench' && target.kind === 'bench') {
      lastHighlight = null;
      return;
    }
    target.el.classList.add('drop-target-active');
    lastHighlight = target.el;
  } else {
    lastHighlight = null;
  }
}
function clearDropHighlight() {
  document.querySelectorAll('.drop-target-active').forEach(e => e.classList.remove('drop-target-active'));
  lastHighlight = null;
}

function performDrop(source, target) {
  if (!S.result) return;

  // court → court: swap
  if (source.kind === 'court' && target.kind === 'court') {
    if (source.courtIdx === target.courtIdx) return;
    swapTwoOnCourt(source.courtIdx, target.courtIdx);
    renderLineup();
    toast('Swapped.');
    return;
  }
  // bench → court: sub in
  if (source.kind === 'bench' && target.kind === 'court') {
    subInBenchPlayer(source.playerId, target.courtIdx);
    renderLineup();
    toast('Subbed in.');
    return;
  }
  // court → bench: send to bench, best bench auto-replaces
  if (source.kind === 'court' && target.kind === 'bench') {
    if (!S.result.bench.length) {
      toast('No bench player available.');
      return;
    }
    const incoming = S.result.bench[0].player;
    S.result.starting6[source.courtIdx] = incoming;
    rebuildDerivedFields(S.result);
    markModifiedIfChanged();
    renderLineup();
    toast(`${incoming.name?.split(' ')[0] || 'Sub'} subbed in.`);
    return;
  }
  // bench → bench: no-op
}

/* ===== Roster Render ===== */
function renderRoster() {
  const list = $('#playerList');
  list.replaceChildren();
  const sorted = sortByMode(
    S.players,
    S.rosterSort,
    p => p.name,
    p => playerSkillRaw(p)
  );
  sorted.forEach(p => list.appendChild(buildPlayerCard(p)));
  $('#rosterEmpty').hidden = S.players.length > 0;
  updateCounts();
}

function buildPlayerCard(p) {
  const card = el('div', {
    cls: 'player-card' +
      (p.available ? '' : ' unavailable') +
      (p._expanded ? ' expanded' : ''),
    dataset: { id: p.id }
  });

  // Avail toggle
  const togInput = el('input', { attrs: { type: 'checkbox' } });
  togInput.checked = !!p.available;
  togInput.addEventListener('change', e => {
    e.stopPropagation();
    p.available = e.target.checked;
    card.classList.toggle('unavailable', !p.available);
    updateCounts();
    save();
  });
  const togSpan = el('span', { cls: 'avail-slider' });
  const tog = el('label', { cls: 'avail-toggle', title: 'Available for game' }, [togInput, togSpan]);
  tog.addEventListener('click', e => e.stopPropagation());

  // Name input
  const nameInput = el('input', {
    cls: 'player-name-input',
    attrs: { type: 'text', placeholder: 'Player name', maxlength: '20', autocomplete: 'off' }
  });
  nameInput.value = p.name || '';
  nameInput.addEventListener('input', e => {
    p.name = e.target.value;
    save();
  });
  nameInput.addEventListener('click', e => e.stopPropagation());

  // Overall AVG
  const overallNum = el('span', { cls: 'num', text: avgSkillDisplay(p) });
  const overallLbl = el('span', { cls: 'lbl', text: 'AVG' });
  const overall = el('div', { cls: 'player-overall' }, [overallNum, overallLbl]);

  const arrow = el('span', { cls: 'player-expand-arrow', text: '›' });

  const head = el('div', { cls: 'player-card-head' }, [tog, nameInput, overall, arrow]);
  head.addEventListener('click', () => {
    p._expanded = !p._expanded;
    card.classList.toggle('expanded', p._expanded);
  });

  // Roster fields (jersey, height, positions, hand) + skills + actions
  const skillBox = el('div', { cls: 'player-skills' });
  skillBox.appendChild(buildRosterFields(p));
  skillBox.appendChild(buildSkillGrid(p.skills, () => {
    overallNum.textContent = avgSkillDisplay(p);
    save();
  }));
  // Setter tempo: only when settings.showSetterTempo and primary === 'S'
  const tempoRow = buildSetterTempoRow(p);
  if (tempoRow) skillBox.appendChild(tempoRow);
  const delBtn = el('button', {
    cls: 'btn-delete-player',
    text: '🗑 Delete player',
    on: { click: () => confirmDelete(p) }
  });
  skillBox.appendChild(el('div', { cls: 'player-actions' }, [delBtn]));

  card.appendChild(head);
  card.appendChild(skillBox);
  return card;
}

function buildRosterFields(p) {
  const wrap = el('div', { cls: 'roster-fields' });

  // Jersey #
  const jerseyRow = el('div', { cls: 'roster-field roster-field-jersey' });
  jerseyRow.appendChild(el('label', { text: 'Jersey #' }));
  const jerseyInput = el('input', {
    attrs: { type: 'text', maxlength: '3', inputmode: 'numeric', pattern: '[0-9]*', placeholder: '#' }
  });
  jerseyInput.value = p.jersey || '';
  jerseyInput.addEventListener('input', e => { p.jersey = e.target.value.replace(/[^0-9]/g, '').slice(0, 3); e.target.value = p.jersey; save(); });
  jerseyInput.addEventListener('click', e => e.stopPropagation());
  jerseyRow.appendChild(jerseyInput);
  if (!S.settings?.showJersey) jerseyRow.hidden = true;
  wrap.appendChild(jerseyRow);

  // Height
  const heightRow = el('div', { cls: 'roster-field' });
  heightRow.appendChild(el('label', { text: 'Height' }));
  const heightInput = el('input', {
    attrs: { type: 'text', maxlength: '8', placeholder: 'e.g. 6-1' }
  });
  heightInput.value = p.height || '';
  heightInput.addEventListener('input', e => { p.height = e.target.value; save(); });
  heightInput.addEventListener('click', e => e.stopPropagation());
  heightRow.appendChild(heightInput);
  wrap.appendChild(heightRow);

  // Primary position
  const priRow = el('div', { cls: 'roster-field' });
  priRow.appendChild(el('label', { text: 'Primary' }));
  const priSel = el('select');
  ROLES.forEach(r => {
    const o = document.createElement('option');
    o.value = r; o.textContent = `${r} — ${ROLE_LABELS[r]}`;
    priSel.appendChild(o);
  });
  priSel.value = p.positions?.[0] || 'OH';
  priSel.addEventListener('change', e => {
    p.positions = [e.target.value, p.positions?.[1] || null];
    save();
    // Re-render the card so the setter-tempo row appears/disappears.
    renderRoster();
  });
  priSel.addEventListener('click', e => e.stopPropagation());
  priRow.appendChild(priSel);
  wrap.appendChild(priRow);

  // Secondary position
  const secRow = el('div', { cls: 'roster-field' });
  secRow.appendChild(el('label', { text: 'Secondary' }));
  const secSel = el('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = ''; noneOpt.textContent = '— none —';
  secSel.appendChild(noneOpt);
  ROLES.forEach(r => {
    const o = document.createElement('option');
    o.value = r; o.textContent = `${r} — ${ROLE_LABELS[r]}`;
    secSel.appendChild(o);
  });
  secSel.value = p.positions?.[1] || '';
  secSel.addEventListener('change', e => {
    p.positions = [p.positions?.[0] || 'OH', e.target.value || null];
    save();
  });
  secSel.addEventListener('click', e => e.stopPropagation());
  secRow.appendChild(secSel);
  wrap.appendChild(secRow);

  // Dominant hand
  const handRow = el('div', { cls: 'roster-field' });
  handRow.appendChild(el('label', { text: 'Hand' }));
  const handSel = el('select');
  [['R', 'Right'], ['L', 'Left']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    handSel.appendChild(o);
  });
  handSel.value = p.hand === 'L' ? 'L' : 'R';
  handSel.addEventListener('change', e => { p.hand = e.target.value === 'L' ? 'L' : 'R'; save(); });
  handSel.addEventListener('click', e => e.stopPropagation());
  handRow.appendChild(handSel);
  wrap.appendChild(handRow);

  return wrap;
}

function buildSetterTempoRow(p) {
  if (!S.settings?.showSetterTempo) return null;
  if ((p.positions?.[0] || 'OH') !== 'S') return null;
  const row = el('div', { cls: 'roster-field roster-field-tempo' });
  row.appendChild(el('label', { text: 'Setter tempo' }));
  const input = el('input', {
    attrs: { type: 'number', min: '1', max: '10', step: '1', inputmode: 'numeric' }
  });
  input.value = String(p.setterTempo ?? 5);
  input.addEventListener('input', e => {
    let v = parseInt(e.target.value, 10);
    if (!isNaN(v)) { v = Math.max(1, Math.min(10, v)); p.setterTempo = v; save(); }
  });
  input.addEventListener('blur', e => {
    let v = parseInt(e.target.value, 10);
    if (isNaN(v)) v = p.setterTempo ?? 5;
    v = Math.max(1, Math.min(10, v));
    p.setterTempo = v;
    e.target.value = String(v);
    save();
  });
  input.addEventListener('focus', e => e.target.select());
  input.addEventListener('click', e => e.stopPropagation());
  row.appendChild(input);
  return row;
}

function avgSkillDisplay(p) {
  const sum = SKILLS.reduce((a, k) => a + (p.skills[k] || 0), 0);
  return (sum / SKILLS.length).toFixed(1);
}

function buildSkillGrid(skillsObj, onChange) {
  const grid = el('div', { cls: 'skill-grid' });
  SKILLS.forEach(skill => {
    grid.appendChild(buildSkillCell(skillsObj, skill, onChange));
  });
  return grid;
}

function buildSkillCell(skillsObj, skill, onChange) {
  const label = el('span', { cls: 'skill-cell-label', text: SKILL_LABELS_SHORT[skill] });
  const input = el('input', {
    cls: 'skill-cell-input',
    attrs: {
      type: 'number',
      min: '1',
      max: '10',
      step: '1',
      inputmode: 'numeric',
      pattern: '[0-9]*'
    }
  });
  input.value = String(skillsObj[skill] || 5);

  function commit(rawValue, finalize) {
    let v = parseInt(rawValue, 10);
    if (isNaN(v)) {
      // While typing, allow empty input briefly. Only clamp on blur.
      if (finalize) {
        v = skillsObj[skill] || 5;
        input.value = String(v);
      }
      return;
    }
    v = Math.max(1, Math.min(10, v));
    if (finalize) input.value = String(v);
    skillsObj[skill] = v;
    if (onChange) onChange(v);
  }
  input.addEventListener('input', e => commit(e.target.value, false));
  input.addEventListener('blur', e => commit(e.target.value, true));
  // Select-all on focus so coaches can quickly retype
  input.addEventListener('focus', e => e.target.select());
  // Up/down arrow keys nudge by 1, clamped
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.target.blur(); }
  });
  // Stop card click handler from collapsing when tapping the input
  input.addEventListener('click', e => e.stopPropagation());

  return el('div', { cls: 'skill-cell' }, [label, input]);
}

/* ===== Weights ===== */
function renderWeights() {
  const list = $('#weightList');
  list.replaceChildren();
  list.appendChild(buildSkillGrid(S.weights, () => save()));
}

function updateCounts() {
  const total = S.players.length;
  const avail = S.players.filter(p => p.available && (p.name || '').trim()).length;
  $('#availCount').textContent = avail;
  $('#totalCount').textContent = total;

  const runBtn = $('#runBtn');
  if (runBtn) runBtn.disabled = avail < 6;
  const hint = $('#runHint');
  if (hint) {
    if (avail < 6) {
      hint.textContent = `Need ${6 - avail} more available player${6 - avail === 1 ? '' : 's'} (named, marked available).`;
    } else {
      hint.textContent = `${avail} players available — ready to generate.`;
    }
  }
}

/* ===== Lineup Render ===== */
function renderLineup() {
  const r = S.result;
  const wrap = $('#lineupResult');
  if (!r || r.error) {
    wrap.hidden = true;
    if (r && r.error) toast(r.error);
    return;
  }
  wrap.hidden = false;

  $('.rotation-controls').style.display = r.mode === 'strict' ? 'flex' : 'none';

  // Modified badge / reset row visibility
  $('#modifiedBadge').hidden = !r.modified;
  $('#resetRow').hidden = !r.modified;

  renderCourt();
  renderStrengthBars();
  renderServingOrder();
  renderBench();
}

function renderCourt() {
  const layer = $('#playerLayer');
  layer.replaceChildren();
  const r = S.result;
  if (!r) return;
  const rotIdx = r.mode === 'strict' ? S.currentRotation : 0;
  const rotation = r.rotations[rotIdx];
  $('#rotNum').textContent = String(rotIdx + 1);

  for (let pos = 1; pos <= 6; pos++) {
    const player = rotation[pos];
    if (!player) continue;
    const firstName = (player.name || '?').split(' ')[0];
    const pname = el('span', { cls: 'pname', text: firstName });
    const ppos = el('span', { cls: 'ppos', text: POSITION_NAMES[pos] });
    const cls = ['player-circle'];
    if (pos === 1) cls.push('is-server');
    if (pos === 2) cls.push('is-setter');
    if (S.swapMode?.kind === 'court' && S.result.starting6[S.swapMode.idx]?.id === player.id) {
      cls.push('swap-source');
    }
    const courtIdx = startingIdxOfPlayer(player.id);
    const circle = el('div', {
      cls: cls.join(' '),
      dataset: { pos: String(pos), playerId: player.id },
      on: {
        pointerdown: e => {
          onDragStart({ kind: 'court', playerId: player.id, courtIdx }, e);
        },
        click: e => {
          // Click won't fire if a drag occurred (browser suppresses)
          e.stopPropagation();
          handleCourtPlayerTap(player.id);
        }
      }
    }, [pname, ppos]);
    layer.appendChild(circle);
  }
}

function renderStrengthBars() {
  const r = S.result;
  const wrap = $('#strengthBars');
  wrap.replaceChildren();
  if (!r || r.mode !== 'strict') {
    $('.rotation-strength').style.display = 'none';
    return;
  }
  $('.rotation-strength').style.display = 'block';

  const max = Math.max(...r.rotationScores);
  const min = Math.min(...r.rotationScores);
  const range = Math.max(max - min, 1);
  const weakThreshold = min + range * 0.2;

  r.rotationScores.forEach((score, i) => {
    const cls = ['strength-bar'];
    if (i === S.currentRotation) cls.push('active');
    if (score <= weakThreshold && score < max) cls.push('weak');
    const heightPct = ((score - min) / range) * 70 + 30;
    const label = el('span', { cls: 'strength-bar-label', text: String(i + 1) });
    const bar = el('div', {
      cls: cls.join(' '),
      title: `Rotation ${i + 1}: strength ${score.toFixed(0)}`,
      on: {
        click: () => {
          S.currentRotation = i;
          renderCourt();
          renderStrengthBars();
        }
      }
    }, [label]);
    bar.style.height = heightPct + '%';
    wrap.appendChild(bar);
  });
  wrap.parentElement.classList.add('strength-bars-wrapper');
}

function renderServingOrder() {
  const r = S.result;
  const ol = $('#servingOrder');
  ol.replaceChildren();
  r.servingOrder.forEach(player => {
    const stars = '★'.repeat(Math.round((player.skills.serving || 0) / 2));
    const star = el('span', { cls: 'star', text: stars });
    const skill = el('span', { cls: 'serve-skill' }, [
      'Serving ', star, ' ' + (player.skills.serving || 0)
    ]);
    const name = el('span', { cls: 'serve-name', text: player.name || '?' });
    const li = el('li', {}, [name, skill]);
    ol.appendChild(li);
  });
}

function renderBench() {
  const ul = $('#benchList');
  ul.replaceChildren();
  const r = S.result;
  if (!r.bench.length) {
    ul.appendChild(el('li', { cls: 'bench-empty', text: 'No bench — all available players are starting.' }));
    return;
  }
  const sorted = sortByMode(
    r.bench,
    S.benchSort,
    item => item.player.name,
    item => item.skill
  );
  sorted.forEach(({ player, skill }) => {
    const name = el('span', { cls: 'bench-name', text: player.name || '?' });
    const pill = el('span', { cls: 'bench-stat-pill', text: skill.toFixed(1) });
    const subBtn = el('button', {
      cls: 'btn-sub-in',
      text: 'Sub In →',
      on: {
        click: e => {
          e.stopPropagation();
          enterSwapMode('bench', player.id);
        }
      }
    });
    const stats = el('span', { cls: 'bench-stats' }, [pill, subBtn]);
    const li = el('li', {
      attrs: { title: 'Drag onto a court player to sub in' },
      on: {
        pointerdown: e => onDragStart({ kind: 'bench', playerId: player.id }, e)
      }
    }, [name, stats]);
    ul.appendChild(li);
  });
}

/* ===== Tabs / Toast / Modal ===== */
function setTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === name + 'Tab'));
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.hidden = true, ms);
}

function confirmDialog(title, msg) {
  return new Promise(resolve => {
    const m = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
    m.hidden = false;
    const ok = $('#confirmOk');
    const cancel = $('#confirmCancel');
    function cleanup(v) {
      m.hidden = true;
      ok.removeEventListener('click', okH);
      cancel.removeEventListener('click', cancelH);
      resolve(v);
    }
    function okH() { cleanup(true); }
    function cancelH() { cleanup(false); }
    ok.addEventListener('click', okH);
    cancel.addEventListener('click', cancelH);
  });
}

async function confirmDelete(player) {
  const ok = await confirmDialog(
    'Delete player?',
    `Remove ${player.name || 'this player'} from the roster? This can't be undone.`
  );
  if (!ok) return;
  S.players = S.players.filter(p => p.id !== player.id);
  save();
  renderRoster();
}

/* ===== Init / wiring ===== */
function init() {
  const loadResult = load();

  // Team name is fixed (Panthers); no input wiring needed

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });

  $('#addPlayerBtn').addEventListener('click', () => {
    const np = createPlayer('');
    // Stay collapsed — keeps the Add Player button close for rapid roster entry.
    // User can tap the card later to expand and edit skills.
    S.players.push(np);
    save();
    renderRoster();
    requestAnimationFrame(() => {
      const card = document.querySelector(`.player-card[data-id="${np.id}"]`);
      if (!card) return;
      const input = card.querySelector('.player-name-input');
      if (input) input.focus();
      // Scroll so the new card AND the Add Player button below it are visible
      const btn = $('#addPlayerBtn');
      btn?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  $$('input[name="mode"]').forEach(r => {
    r.checked = (r.value === S.mode);
    r.addEventListener('change', e => {
      if (e.target.checked) {
        S.mode = e.target.value;
        save();
      }
    });
  });

  // Topbar settings: ruleset / system / jersey toggle / setter-tempo toggle
  const rulesetSel = $('#rulesetSelect');
  const systemSel = $('#systemSelect');
  const jerseyTog = $('#jerseyToggle');
  const tempoTog = $('#setterTempoToggle');
  if (rulesetSel) {
    rulesetSel.value = S.settings.ruleset;
    rulesetSel.addEventListener('change', e => {
      S.settings.ruleset = RULESETS[e.target.value] ? e.target.value : 'rec';
      save();
    });
  }
  if (systemSel) {
    systemSel.value = S.settings.system;
    systemSel.addEventListener('change', e => {
      S.settings.system = e.target.value === '6-2' ? '6-2' : '5-1';
      save();
    });
  }
  if (jerseyTog) {
    jerseyTog.checked = !!S.settings.showJersey;
    jerseyTog.addEventListener('change', e => {
      S.settings.showJersey = !!e.target.checked;
      save();
      renderRoster();
    });
  }
  if (tempoTog) {
    tempoTog.checked = !!S.settings.showSetterTempo;
    tempoTog.addEventListener('change', e => {
      S.settings.showSetterTempo = !!e.target.checked;
      save();
      renderRoster();
    });
  }

  $('#resetWeightsBtn').addEventListener('click', async () => {
    const ok = await confirmDialog('Reset weights?', 'Restore all skill weights to defaults?');
    if (!ok) return;
    S.weights = defaultWeights();
    save();
    renderWeights();
    toast('Weights reset.');
  });

  $('#runBtn').addEventListener('click', () => {
    const result = generateLineup();
    if (result.error) {
      toast(result.error);
      return;
    }
    S.result = result;
    S.currentRotation = 0;
    renderLineup();
    setTab('lineup');
    toast(result.mode === 'strict' ? 'Lineup ready — 6 rotations generated.' : 'Lineup ready.');
  });

  $('#nextRotBtn').addEventListener('click', () => {
    if (!S.result || S.result.mode !== 'strict') return;
    S.currentRotation = (S.currentRotation + 1) % 6;
    renderCourt();
    renderStrengthBars();
  });
  $('#prevRotBtn').addEventListener('click', () => {
    if (!S.result || S.result.mode !== 'strict') return;
    S.currentRotation = (S.currentRotation - 1 + 6) % 6;
    renderCourt();
    renderStrengthBars();
  });

  $('#shareBtn').addEventListener('click', openShareModal);

  // Help button delegation: any element with [data-help="key"] opens that help entry
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-help]');
    if (btn && document.body.contains(btn)) {
      e.preventDefault();
      e.stopPropagation();
      openHelp(btn.getAttribute('data-help'));
    }
  });
  $('#helpClose').addEventListener('click', closeHelp);
  $('#helpDoneBtn').addEventListener('click', closeHelp);
  $('#helpModal').addEventListener('click', e => {
    if (e.target.id === 'helpModal') closeHelp();
  });

  // Share modal wiring
  $('#shareModalClose').addEventListener('click', closeShareModal);
  $('#shareCloseBtn').addEventListener('click', closeShareModal);
  $('#shareCopyBtn').addEventListener('click', copyShareUrl);
  $('#shareNativeBtn').addEventListener('click', shareNativeOrCopy);
  $('#shareModal').addEventListener('click', e => {
    if (e.target.id === 'shareModal') closeShareModal();
  });
  // Tap-and-select the URL input contents for easy manual copy
  $('#shareUrlInput').addEventListener('focus', e => e.target.select());

  // Breakdown popup
  $('#breakdownClose').addEventListener('click', closeBreakdown);
  $('#breakdownSwap').addEventListener('click', breakdownStartSwap);
  $('#breakdownSubOff').addEventListener('click', breakdownSubOff);
  $('#breakdownModal').addEventListener('click', e => {
    if (e.target.id === 'breakdownModal') closeBreakdown();
  });

  // Swap banner cancel
  $('#swapBannerCancel').addEventListener('click', exitSwapMode);

  // Reset to optimal
  $('#resetOptimalBtn').addEventListener('click', resetToOptimal);

  // ESC cancels swap mode or popup
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (S.swapMode) exitSwapMode();
      if (!$('#breakdownModal').hidden) closeBreakdown();
      if (!$('#shareModal').hidden) closeShareModal();
      if (!$('#helpModal').hidden) closeHelp();
    }
  });

  // Swipe on court → change rotation (strict mode only)
  attachCourtSwipeHandlers();

  // Drag & drop window-level handlers
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);

  // Sort dropdowns
  const rosterSortEl = $('#rosterSort');
  rosterSortEl.value = S.rosterSort;
  rosterSortEl.addEventListener('change', e => {
    if (SORT_MODES.has(e.target.value)) {
      S.rosterSort = e.target.value;
      save();
      renderRoster();
    }
  });
  const benchSortEl = $('#benchSort');
  benchSortEl.value = S.benchSort;
  benchSortEl.addEventListener('change', e => {
    if (SORT_MODES.has(e.target.value)) {
      S.benchSort = e.target.value;
      save();
      if (S.result) renderBench();
    }
  });

  renderRoster();
  renderWeights();
  updateCounts();
  updateLastEditedDisplay();

  // First-time welcome when opening someone else's shared link
  if (loadResult?.fromUrl) {
    setTimeout(() => {
      toast('Loaded shared team. Your edits sync to the URL — tap 🔗 to share back.', 4500);
    }, 300);
  }
}

function attachCourtSwipeHandlers() {
  const court = $('#court');
  if (!court) return;
  let startX = null, startY = null, startT = 0;
  court.addEventListener('touchstart', e => {
    if (e.target.closest('.player-circle')) return;
    if (S.swapMode) return;
    if (!S.result || S.result.mode !== 'strict') return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startT = Date.now();
  }, { passive: true });
  court.addEventListener('touchend', e => {
    if (startX === null) return;
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - startX;
    const dy = endY - startY;
    const dt = Date.now() - startT;
    startX = null;
    if (dt > 600) return;
    if (Math.abs(dx) < 50) return;
    if (Math.abs(dy) > 60) return;
    if (dx < 0) $('#nextRotBtn').click();
    else $('#prevRotBtn').click();
  }, { passive: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
