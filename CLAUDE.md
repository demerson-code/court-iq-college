# Court IQ College — agent notes

A volleyball lineup tool for college / rec women's teams. Three-file static
site (`app.js`, `index.html`, `styles.css`), **no build step**, served from
the repo root via GitHub Pages.

- **Live**: https://demerson-code.github.io/court-iq-college/
- **Local preview**: `python -m http.server 3460` → http://localhost:3460/
- **Tests**: `npm test` (Playwright, 10 algorithm assertions, ~4s)
- **Deploy**: `git push origin main` (GitHub Pages auto-deploys, 30–90s)
- **Plan**: `PLAN.md` (untracked by intent — owns the per-block scope; don't
  duplicate it here)

## Skill set (do not change without asking)

The 6 skills are **serving, serveReceive, defense, hitting, blocking, setting**.
There is no "passing" skill — `serveReceive` is the formal coaching term for
passing the serve, and `defense` covers digging + free-ball. Adding a third
"passing" skill would double-count. Setters also get an optional 7th skill
`setterTempo` (gated by the topbar toggle).

## State and persistence rules

- `S` is the global state. Mutate it then call `save()` — never bypass.
- Storage key: `court_iq_college_v1` (legacy `court_iq_v1` migrates silently).
- Wrap localStorage via `safeStorage` (mobile Safari private-mode safety).
- **Tonight-only state stays local, never in the share link**: scrimmage
  attendance, scrimmage teams/spread, `currentTab`, sort prefs.
- **Team-forever state goes in the share link**: roster, weights, settings,
  lineup config (overrides, libero, sub patterns, pairings), team name.

## Share link (v:2 envelope)

Hash format: `#d=<base64url-JSON>`. Compact shape:
`{ v:2, t:teamName, p:[playerTuples], w:[weights], cfg:settings, ln:lineup, e:lastEdited }`.
Player tuples: `[id, name, [pri,sec], hand, height, jersey, [skills], setterTempo, available]`.

**Critical: player IDs must survive encode/decode.** Pairings, overrides,
libero, and sub-patterns all reference player IDs. The pre-v2 format
regenerated IDs on decode and silently dropped all of those.

Pre-v2 ("Block 1 ad-hoc") hashes — object-form players with `n/s/a/pos/h/ht/j/st`,
no `v` field — still decode via `decodeShareLegacy` and auto-upgrade to v2 on
the next save.

## Coding conventions

- **No `innerHTML`** — a pre-edit security hook blocks it. Use `el(tag, opts, children)`
  (defined near top of `app.js`) or `document.createTextNode` for user-supplied
  strings.
- **`generateLineup(state)` return shapes** (these have bitten me):
  - `result.arrangement` is `{rotations: [...6], startOrder: [...]}` — *not* the
    rotation array directly. Use `result.arrangement.rotations`.
  - `result.libero` is `{player, replaces, servesInRotation}` — *not* the bare
    player. Use `result.libero.player`.
- **Window-property recursion footgun**: `window.fn = () => fn()` infinite-loops
  if `fn` is also a function declaration in module scope. Use direct assignment
  (`window.fn = fn`) after the declaration.
- **Algorithm functions are exposed on `window`** for `page.evaluate` tests.
  `window.S` is exposed via a getter. Don't break this.

## Print

`#printSheet` is a hidden div (display:none on screen). Click handlers populate
it with a fresh DOM tree, add `body.printing`, call `window.print()`, then clean
up on `afterprint` (with a 4s `setTimeout` fallback for browsers that don't
fire it).

## What's deferred / rejected (don't reintroduce without asking)

- **JSON export/import buttons** — rejected; share link covers the use case.
- **Match-day mode (Block 5)** — deferred. Live scoring, sub modal, set tracking.
- **A separate "passing" skill** — rejected (see Skill set above).
- **GitHub Pages workflow file** — none; default Pages-from-`main` build is fine.

## Working with the user

**Two non-negotiable rules — read first:**

1. **For any non-trivial feature work — 3+ files, new state shape, a new
   tab, or anything spanning blocks — invoke the `grill-me` skill before
   writing code.** It walks the decision tree one question at a time,
   self-serves from the codebase to avoid asking what it can answer, and
   produces an Intent Summary for sign-off. Single-file fixes and obvious
   changes can skip it.
2. **When asking the user a question with a finite option set, use the
   `AskUserQuestion` tool, not plain text.** The user gets a clickable
   picker with an "Other" free-text escape hatch. Plain text is reserved
   for open-ended questions ("why", "describe X", error reports).

Beyond those:

- Prefer plain English over jargon. Coaching jargon is fine; software jargon
  ("envelope", "tuple", "ad-hoc") needs a one-line gloss.
- Recommend defaults with reasoning rather than open-ended menus when there's
  a clear lean. In the picker, mark the recommendation `(Recommended)` and
  put it first.
- The user reviews local preview before pushing. Don't push without explicit
  approval.

## Block status (as of last update)

- Done & live: 0, 1, 2, 3, 4, 6 (and an off-plan Scrimmage tab).
- Deferred: 5 (match-day mode).
