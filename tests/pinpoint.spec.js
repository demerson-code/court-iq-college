// Pinpoint (pinpoint/) — scoring and round-flow tests.
// Drives the live page through window.PP (pure helpers + test hooks).

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  // Fonts are cosmetic; don't let a slow or blocked CDN stall the test.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto('/pinpoint/');
  await page.waitForFunction(() => window.PP && window.PP.state);
});

test('scoring: bullseye inside country, linear falloff, zero far away', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { pointsFor, haversineMi, barFor, milesForPoints, MAX_PTS } = window.PP;
    return {
      inside: pointsFor(900, true),
      nearCapital: pointsFor(20, false),
      half: pointsFor(1250, false),
      far: pointsFor(2600, false),
      nyToLondon: Math.round(haversineMi(40.71, -74.01, 51.51, -0.13)),
      bar1: barFor(1), bar10: barFor(10), bar30: barFor(30),
      miAt4750: milesForPoints(4750),
      max: MAX_PTS,
    };
  });
  expect(r.inside).toBe(5000);
  expect(r.nearCapital).toBe(5000);
  expect(r.half).toBe(2500);
  expect(r.far).toBe(0);
  expect(r.nyToLondon).toBeGreaterThan(3440);
  expect(r.nyToLondon).toBeLessThan(3480);
  expect(r.bar1).toBe(500);
  expect(r.bar10).toBe(2750);
  expect(r.bar30).toBe(4750);
  expect(r.miAt4750).toBe(125);
});

test('every listed country has a map shape and its capital sits inside it', async ({ page }) => {
  const bad = await page.evaluate(() => {
    const geo = window.PP.decodeTopo(window.WORLD_TOPO);
    const byName = new Map(geo.map((c) => [c.name, c]));
    const out = [];
    for (const [mapName, name, capital, lat, lon] of window.COUNTRIES) {
      const g = byName.get(mapName);
      if (!g) { out.push(`${name}: no shape`); continue; }
      // Coastal capitals can fall just outside the coarse 110m coastline, and a
      // few sit on small islands the 110m data drops entirely (Nassau, Port
      // Vila, Malabo — Bioko and Efate are ~100 mi from the drawn islands).
      // Accept a capital within 150 mi of any vertex of the shape; the 25 mi
      // bullseye rule still covers those in play.
      if (window.PP.pointInRings(lon, lat, g.polys)) continue;
      let near = false;
      for (const poly of g.polys) for (const ring of poly) for (const [x, y] of ring) {
        if (window.PP.haversineMi(lat, lon, y, x) < 150) { near = true; break; }
      }
      if (!near) out.push(`${name}: ${capital} (${lat}, ${lon}) is not inside the shape`);
    }
    return out;
  });
  expect(bad).toEqual([]);
});

test('round flow: a hit advances, a miss ends the game', async ({ page }) => {
  await page.evaluate(() => window.PP.setPrefs({ mode: 'countries', region: 'world', timer: false }));
  await page.click('#startBtn');
  await expect(page.locator('#prompt')).toBeVisible();

  // Round 1: click on the capital itself → 5,000, cleared.
  let s = await page.evaluate(() => {
    const G = window.PP.state();
    window.PP.guessLatLon(G.target.lat, G.target.lon);
    return { phase: G.phase, pts: G.guess.pts, inside: G.guess.inside, score: G.score, round: G.round };
  });
  expect(s.round).toBe(1);
  expect(s.pts).toBe(5000);
  expect(s.phase).toBe('result');
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#resBtn')).toHaveText('Next round');

  await page.click('#resBtn');
  s = await page.evaluate(() => { const G = window.PP.state(); return { round: G.round, phase: G.phase }; });
  expect(s.round).toBe(2);
  expect(s.phase).toBe('guess');

  // Round 2: click on the far side of the world → 0 points, game over.
  s = await page.evaluate(() => {
    const G = window.PP.state();
    const lon = G.target.lon > 0 ? G.target.lon - 180 : G.target.lon + 180;
    window.PP.guessLatLon(-G.target.lat, lon);
    return { phase: G.phase, pts: G.guess.pts, score: G.score };
  });
  expect(s.pts).toBe(0);
  expect(s.phase).toBe('over');
  expect(s.score).toBe(5000);
  await expect(page.locator('#resBtn')).toHaveText('See final score');
  await page.click('#resBtn');
  await expect(page.locator('#over')).toBeVisible();
  await expect(page.locator('#overScore')).toHaveText('5,000');
  await expect(page.locator('#overRounds')).toContainText('1 round cleared');

  // Best score persisted.
  const best = await page.evaluate(() => JSON.parse(localStorage.getItem('pinpoint_best_v1')));
  expect(best).toEqual({ score: 5000, rounds: 1 });

  // Recap lists both rounds, the last one marked as the miss.
  await expect(page.locator('#overRecap .recap-row')).toHaveCount(2);
  await expect(page.locator('#overRecap .recap-row.miss')).toHaveCount(1);

  // Local leaderboard (no artifact db in a plain browser): save and read back.
  await page.fill('#boardName', 'Dan');
  await page.click('#boardSave');
  await expect(page.locator('#boardStatus')).toHaveText('Saved.');
  await expect(page.locator('#boardList .board-row')).toHaveCount(1);
  await expect(page.locator('#boardList .board-row .pts')).toHaveText('5,000');
});

test('capitals mode: inside the country is not a bullseye, only the city is', async ({ page }) => {
  await page.evaluate(() => window.PP.setPrefs({ mode: 'capitals', region: 'world', timer: false }));
  await page.click('#startBtn');
  await expect(page.locator('#promptEyebrow')).toHaveText('Find the capital');
  const s = await page.evaluate(() => {
    const G = window.PP.state();
    const t = G.target;
    // 300 mi north of the capital: inside most countries, well outside the 25 mi circle
    window.PP.guessLatLon(t.lat + 300 / 69, t.lon);
    return { pts: G.guess.pts, inside: G.guess.inside, capital: t.capital, shown: document.getElementById('promptName').textContent };
  });
  expect(s.inside).toBe(false);
  expect(s.pts).toBeLessThan(5000);
  expect(s.pts).toBeGreaterThan(3000);
  expect(s.shown).toBe(s.capital);
});

test('region packs only draw from that region', async ({ page }) => {
  const r = await page.evaluate(() => {
    window.PP.setPrefs({ mode: 'countries', region: 'EU', timer: false });
    const n = window.PP.roster().length;
    const names = new Set();
    for (let i = 0; i < 30; i++) {
      window.PP.startGame();
      names.add(window.PP.state().target.mapName);
    }
    const regionOf = new Map(window.COUNTRIES.map((c) => [c[0], c[6]]));
    return { n, offRegion: [...names].filter((m) => regionOf.get(m) !== 'EU') };
  });
  expect(r.n).toBeGreaterThan(40);
  expect(r.offRegion).toEqual([]);
});

test('timer: running out ends the game with 0 points; a fast clear earns a bonus', async ({ page }) => {
  await page.evaluate(() => window.PP.setPrefs({ mode: 'countries', region: 'world', timer: true }));
  await page.click('#startBtn');
  await expect(page.locator('#promptTimer')).toBeVisible();
  let s = await page.evaluate(() => {
    const G = window.PP.state();
    window.PP.guessLatLon(G.target.lat, G.target.lon);
    return { pts: G.guess.pts, bonus: G.guess.bonus, score: G.score, bonusMax: window.PP.speedBonus(window.PP.ROUND_SECS) };
  });
  expect(s.pts).toBe(5000);
  expect(s.bonus).toBeGreaterThan(800);
  expect(s.bonus).toBeLessThanOrEqual(s.bonusMax);
  expect(s.score).toBe(5000 + s.bonus);
  await page.click('#resBtn');
  s = await page.evaluate(() => {
    window.PP.timeOut();
    const G = window.PP.state();
    return { phase: G.phase, pts: G.guess.pts, timedOut: G.guess.timedOut };
  });
  expect(s.phase).toBe('over');
  expect(s.pts).toBe(0);
  expect(s.timedOut).toBe(true);
  await expect(page.locator('#resTitle')).toContainText("Time's up");
});

test('a real mouse click on the canvas places the pin', async ({ page }) => {
  await page.click('#startBtn');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const s = await page.evaluate(() => { const G = window.PP.state(); return { hasGuess: !!G.guess, phase: G.phase }; });
  expect(s.hasGuess).toBe(true);
  expect(['result', 'over']).toContain(s.phase);
});
