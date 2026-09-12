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
  await expect(page.locator('#overRounds')).toHaveText('1 round cleared');

  // Best score persisted.
  const best = await page.evaluate(() => JSON.parse(localStorage.getItem('pinpoint_best_v1')));
  expect(best).toEqual({ score: 5000, rounds: 1 });
});

test('a real mouse click on the canvas places the pin', async ({ page }) => {
  await page.click('#startBtn');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const s = await page.evaluate(() => { const G = window.PP.state(); return { hasGuess: !!G.guess, phase: G.phase }; });
  expect(s.hasGuess).toBe(true);
  expect(['result', 'over']).toContain(s.phase);
});
