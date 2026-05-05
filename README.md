# Court IQ College — Volleyball Lineup Tool

A college-level volleyball lineup tool. **Forked from [Court IQ](https://github.com/demerson-code/court-iq)** (youth-rec edition) as a starting point — the user-facing scaffolding (roster UI, share link, drag-drop, animations, tab structure, theme) is reusable; the algorithm and domain model need significant rework for college play.

**Live**: https://demerson-code.github.io/court-iq-college/

## Status

🚧 **Forked baseline — not yet college-ready.** This repo currently runs the youth-rec algorithm verbatim. Major rework is in progress to model real college volleyball.

## What's already working (inherited from Court IQ)

- Roster UI with collapsible cards and number-grid skill ratings
- Auto-save to localStorage and URL-hash share links (with timestamp)
- Native share via `navigator.share()` with clipboard fallback
- Animated court with manual rotation cycling
- Drag-and-drop swaps (court ↔ court, bench ↔ court, court ↔ bench)
- Sort dropdowns on roster and bench (AVG / Name, asc/desc)
- Help system ("?" icons) with definition popovers
- Strict / Loose lineup mode toggle
- Responsive across phone / tablet / desktop

## What needs to change for college level

### Rotation systems
- **5-1**: one fixed setter, all 6 rotations
- **6-2**: two setters from back row only
- Tool should let coach pick the system per team

### Specialized positions
Players are tagged with primary position(s). Algorithm must respect them:
- **OH1 / OH2** — outside hitters (left front)
- **MB1 / MB2** — middle blockers
- **S** — setter (in 5-1) or setters (in 6-2)
- **OPP** — opposite hitter (right front)
- **L** — libero (back row only)
- **DS** — defensive specialist

### Libero rules
- Back-row only, doesn't count in normal rotation
- Replaces a back-row player and swaps out when they rotate to front
- May or may not serve depending on league

### Substitution model
- NCAA cap: 15 subs per set
- Re-entry must be in the same rotation slot
- Designated DS pairings (player A only swaps for player B)

### Smarter skills
Split / add:
- Passing → **serve-receive** (with a serve coming at you) vs free-ball pass
- **Blocking** (separate from defense)
- **Hitting efficiency** (kills − errors / total attempts)
- **Tempo** for setters (1-ball, slide, back set range)
- **Off-hand hitting** ability

### Algorithm rewrite
The current "balance the 6-cycle to maximize min rotation" approach is wrong here. New model:
- Position-locked assignment problem (Hungarian algorithm or constraint solver)
- "Best setter at S, best libero at L, best OH at OH1, etc." with hard position constraints
- Within-set substitution planning

### Match-day features
- Multiple situational lineups (vs strong server, vs big block, etc.)
- Opponent scouting fields (their ace server, hitting tendencies)
- Live sub tracking with cap enforcement

## Stack

- One HTML / one CSS / one JS file
- Zero dependencies, zero build step
- Deploys to GitHub Pages from `main` branch root

## Local Development

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Sharing

URL hash encodes full team state. Single-coach edit model — whoever shares the latest link is source of truth. Timestamp in the URL helps coaches see which version is fresher.
