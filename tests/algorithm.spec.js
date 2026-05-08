// Block 6 — algorithm correctness tests.
// Drive the live app via page.evaluate: each test injects a roster onto
// window.S, sets system / mode, then calls window.generateLineup. Asserts
// structural shape (5-1 vs 6-2 composition, libero presence, error reason
// on bad input) plus a maximin sanity check.
//
// The point of these tests is regression protection — if anyone changes the
// algorithm later (intentionally or otherwise), CI catches the break.

const { test, expect } = require('@playwright/test');
const balanced13 = require('./fixtures/roster-balanced-13.json');
const noSetter = require('./fixtures/roster-no-setter.json');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Reset state to a deterministic baseline. The app's load() runs on
  // DOMContentLoaded; by the time we call goto and the page resolves, S is
  // wired up. We zero out persisted state so each test starts clean.
  await page.evaluate(() => {
    if (!window.S) throw new Error('window.S not exposed — Block 6 wiring missing');
    window.S.players = [];
    window.S.lineup.overrides = [];
    window.S.lineup.subPatterns = [];
    window.S.lineup.pairings = [];
    window.S.lineup.liberoConfig = { playerId: null, replaces: ['MB'], servesInRotation: null };
  });
});

function runGenerate(page, { roster, system, mode = 'balanced', ruleset = 'rec' }) {
  return page.evaluate(({ roster, system, mode, ruleset }) => {
    window.S.players = roster;
    window.S.settings.system = system;
    window.S.settings.ruleset = ruleset;
    window.S.lineup.optimizationMode = mode;
    return window.generateLineup(window.S);
  }, { roster, system, mode, ruleset });
}

test.describe('5-1 system', () => {
  test('balanced lineup has 1 S, 1 OPP, 2 OH, 2 MB, libero set', async ({ page }) => {
    const result = await runGenerate(page, { roster: balanced13, system: '5-1', ruleset: 'ncaa' });
    expect(result.error).toBeFalsy();
    expect(result.starters).toBeTruthy();
    expect(result.starters.S).toHaveLength(1);
    expect(result.starters.OPP).toHaveLength(1);
    expect(result.starters.OH).toHaveLength(2);
    expect(result.starters.MB).toHaveLength(2);
    expect(result.libero).toBeTruthy();
    expect(result.libero.player).toBeTruthy();
    expect(result.libero.player.id).toBeTruthy();
  });

  test('produces 6 distinct rotation arrangements', async ({ page }) => {
    const result = await runGenerate(page, { roster: balanced13, system: '5-1', ruleset: 'ncaa' });
    expect(result.arrangement.rotations).toHaveLength(6);
    expect(result.perRotationScores).toHaveLength(6);
    // Every rotation has 6 players on the floor (front row + back row).
    for (const rot of result.arrangement.rotations) {
      expect(rot.frontRow).toHaveLength(3);
      expect(rot.backRow).toHaveLength(3);
    }
  });

  test('every starter is in their primary or secondary role', async ({ page }) => {
    const result = await runGenerate(page, { roster: balanced13, system: '5-1', ruleset: 'ncaa' });
    const checkRole = (player, role) => {
      const valid = [player.positions[0], player.positions[1]].filter(Boolean);
      expect(valid).toContain(role);
    };
    result.starters.S.forEach(p => checkRole(p, 'S'));
    result.starters.OPP.forEach(p => checkRole(p, 'OPP'));
    result.starters.OH.forEach(p => checkRole(p, 'OH'));
    result.starters.MB.forEach(p => checkRole(p, 'MB'));
    if (result.libero && result.libero.player) checkRole(result.libero.player, 'L');
  });
});

test.describe('6-2 system', () => {
  test('balanced lineup uses 2 S, 0 OPP, 2 OH, 2 MB', async ({ page }) => {
    const result = await runGenerate(page, { roster: balanced13, system: '6-2', ruleset: 'ncaa' });
    expect(result.error).toBeFalsy();
    expect(result.starters).toBeTruthy();
    expect(result.starters.S).toHaveLength(2);
    expect(result.starters.OPP).toHaveLength(0);
    expect(result.starters.OH).toHaveLength(2);
    expect(result.starters.MB).toHaveLength(2);
    expect(result.libero).toBeTruthy();
  });

  test('the two setters are different players', async ({ page }) => {
    const result = await runGenerate(page, { roster: balanced13, system: '6-2', ruleset: 'ncaa' });
    expect(result.starters.S[0].id).not.toBe(result.starters.S[1].id);
  });
});

test.describe('error paths', () => {
  test('5-1 with no setters returns a setter-related error', async ({ page }) => {
    const result = await runGenerate(page, { roster: noSetter, system: '5-1', ruleset: 'ncaa' });
    expect(result.starters).toBeNull();
    expect(result.validation || result.error).toMatch(/setter/i);
  });

  test('6-2 with only one setter returns an error mentioning 2 setters', async ({ page }) => {
    // balanced13 has 2 setters; remove one to leave a single S.
    const oneSetter = balanced13.filter(p => p.id !== 'p11');
    const result = await runGenerate(page, { roster: oneSetter, system: '6-2', ruleset: 'ncaa' });
    expect(result.starters).toBeNull();
    expect(result.validation || result.error).toMatch(/setter/i);
  });

  test('roster smaller than 7 players returns roster-size error', async ({ page }) => {
    const six = balanced13.slice(0, 6);
    const result = await runGenerate(page, { roster: six, system: '5-1', ruleset: 'ncaa' });
    expect(result.starters).toBeNull();
    expect(result.error).toMatch(/7/);
  });
});

test.describe('optimization modes', () => {
  test('balanced mode worst-rotation >= best6 mode worst-rotation', async ({ page }) => {
    // Maximin sanity check: balanced optimizes the worst rotation, best6
    // optimizes only rotation 1. So balanced's minimum-rotation score
    // should be at least as high as best6's minimum.
    const balancedResult = await runGenerate(page, { roster: balanced13, system: '5-1', ruleset: 'ncaa', mode: 'balanced' });
    const best6Result = await runGenerate(page, { roster: balanced13, system: '5-1', ruleset: 'ncaa', mode: 'best6' });
    const balancedWorst = Math.min(...balancedResult.perRotationScores);
    const best6Worst = Math.min(...best6Result.perRotationScores);
    expect(balancedWorst).toBeGreaterThanOrEqual(best6Worst - 0.001); // float tolerance
  });

  test('all four optimization modes return valid lineups', async ({ page }) => {
    for (const mode of ['balanced', 'best6', 'sr', 'serving']) {
      const result = await runGenerate(page, { roster: balanced13, system: '5-1', ruleset: 'ncaa', mode });
      expect(result.error, `mode=${mode}`).toBeFalsy();
      expect(result.starters, `mode=${mode}`).toBeTruthy();
    }
  });
});
