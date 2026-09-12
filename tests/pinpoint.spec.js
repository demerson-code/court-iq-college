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
    const { pointsFor, haversineMi, barFor, avgNeedFor, difficultyFor, milesForPoints, MAX_PTS, PINS_PER_ROUND } = window.PP;
    return {
      inside: pointsFor(900, true),
      nearCapital: pointsFor(20, false),
      half: pointsFor(1250, false),
      far: pointsFor(2600, false),
      nyToLondon: Math.round(haversineMi(40.71, -74.01, 51.51, -0.13)),
      pins: PINS_PER_ROUND,
      avg1: avgNeedFor(1), avg4: avgNeedFor(4), avg30: avgNeedFor(30),
      bar1: barFor(1), bar2: barFor(2),
      d1: difficultyFor(1), d5: difficultyFor(5), d9: difficultyFor(9),
      miAtAvg1: milesForPoints(avgNeedFor(1)),
      max: MAX_PTS,
    };
  });
  expect(r.inside).toBe(5000);
  expect(r.nearCapital).toBe(5000);
  expect(r.half).toBe(2500);
  expect(r.far).toBe(0);
  expect(r.nyToLondon).toBeGreaterThan(3440);
  expect(r.nyToLondon).toBeLessThan(3480);
  expect(r.pins).toBe(7);
  expect(r.avg1).toBe(1500);
  expect(r.avg4).toBe(3000);
  expect(r.avg30).toBe(4600);
  expect(r.bar1).toBe(10500);
  expect(r.bar2).toBe(14000);
  expect(r.d1).toBe(1);
  expect(r.d5).toBe(5);
  expect(r.d9).toBe(5);
  expect(r.miAtAvg1).toBe(1750);
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

test('round flow: seven pins make a round, the total decides, a missed bar ends the game', async ({ page }) => {
  await page.evaluate(() => window.PP.setPrefs({ mode: 'countries', region: 'world', timer: false }));
  await page.click('#startBtn');
  await expect(page.locator('#intro')).toBeVisible();
  await expect(page.locator('#introRound')).toHaveText('Round 1');
  await expect(page.locator('#introNeed')).toContainText('You need 10,500 points across 7 pins to reach round 2');
  await page.click('#introBtn');
  await expect(page.locator('#prompt')).toBeVisible();
  await expect(page.locator('#promptSub')).toContainText('Round 1 · Pin 1 of 7');

  // Round 1: seven bullseyes, all on household-name countries.
  const seen = [];
  for (let i = 1; i <= 7; i++) {
    const s = await page.evaluate(() => {
      const G = window.PP.state();
      const t = G.target;
      window.PP.guessLatLon(t.lat, t.lon);
      return { round: G.round, pin: G.pin, pts: G.guess.pts, phase: G.phase, tier: t.tier, name: t.name };
    });
    seen.push(s);
    expect(s.round).toBe(1);
    expect(s.pin).toBe(i);
    expect(s.pts).toBe(5000);
    expect(s.tier).toBe(1);
    if (i < 7) {
      expect(s.phase).toBe('result');
      await expect(page.locator('#resBtn')).toHaveText('Next pin');
    } else {
      expect(s.phase).toBe('roundEnd');
      await expect(page.locator('#resBtn')).toHaveText('Continue');
      await expect(page.locator('#resNeed')).toContainText('Round 1 cleared: 35,000 of 10,500');
    }
    await page.waitForTimeout(550); await page.click('#resBtn');
  }
  // Round 2 announcement: previous round result + the new bar.
  await expect(page.locator('#intro')).toBeVisible();
  await expect(page.locator('#introPrev')).toHaveText('Round 1 cleared with 35,000 points.');
  await expect(page.locator('#introNeed')).toContainText('You need 14,000 points');
  await page.click('#introBtn');
  expect(new Set(seen.map((s) => s.name)).size).toBe(7); // no repeats within a run

  // Round 2 draws from difficulty 2, and one bad pin does not end the round.
  let s = await page.evaluate(() => {
    const G = window.PP.state();
    const lon = G.target.lon > 0 ? G.target.lon - 180 : G.target.lon + 180;
    window.PP.guessLatLon(-G.target.lat, lon);
    return { round: G.round, pin: G.pin, pts: G.guess.pts, phase: G.phase, tier: G.target.tier, score: G.score };
  });
  expect(s.round).toBe(2);
  expect(s.pin).toBe(1);
  expect(s.pts).toBe(0);
  expect(s.tier).toBe(2);
  expect(s.phase).toBe('result');
  expect(s.score).toBe(35000);

  // Six more misses: round total 0 < 14,000 -> game over after the seventh pin.
  for (let i = 2; i <= 7; i++) {
    await page.waitForTimeout(550); await page.click('#resBtn');
    s = await page.evaluate(() => {
      const G = window.PP.state();
      const lon = G.target.lon > 0 ? G.target.lon - 180 : G.target.lon + 180;
      window.PP.guessLatLon(-G.target.lat, lon);
      return { pin: G.pin, phase: G.phase };
    });
    expect(s.pin).toBe(i);
    expect(s.phase).toBe(i < 7 ? 'result' : 'over');
  }
  await expect(page.locator('#resBtn')).toHaveText('See final score');
  await page.waitForTimeout(550); await page.click('#resBtn');
  await expect(page.locator('#over')).toBeVisible();
  await expect(page.locator('#overScore')).toHaveText('35,000');
  await expect(page.locator('#overRounds')).toContainText('1 round cleared');

  // Best score persisted.
  const best = await page.evaluate(() => JSON.parse(localStorage.getItem('pinpoint_best_v1')));
  expect(best).toEqual({ score: 35000, rounds: 1 });

  // Recap: two round headers, 14 pin rows, round 2 marked missed.
  await expect(page.locator('#overRecap .recap-head')).toHaveCount(2);
  await expect(page.locator('#overRecap .recap-row')).toHaveCount(14);
  await expect(page.locator('#overRecap .recap-head.miss')).toHaveCount(1);

  // Local leaderboard (no artifact db in a plain browser): save and read back.
  await page.fill('#boardName', 'Dan');
  await page.click('#boardSave');
  await expect(page.locator('#boardStatus')).toHaveText('Saved.');
  await expect(page.locator('#boardList .board-row')).toHaveCount(1);
  await expect(page.locator('#boardList .board-row .pts')).toHaveText('35,000');
});

test('difficulty climbs by round: 1 to 5 then stays', async ({ page }) => {
  const r = await page.evaluate(() => {
    window.PP.setPrefs({ mode: 'countries', region: 'world', timer: false });
    const out = [];
    window.PP.startGame();
    for (let round = 1; round <= 7; round++) {
      window.PP.beginRound();
      const tiers = [];
      for (let pin = 1; pin <= 7; pin++) {
        const G = window.PP.state();
        tiers.push(G.target.tier);
        window.PP.guessLatLon(G.target.lat, G.target.lon);
        G.revealedAt = null;
        window.PP.advance();
      }
      out.push(tiers);
    }
    return out;
  });
  r.forEach((tiers, i) => {
    const want = Math.min(5, i + 1);
    for (const t of tiers) expect(t).toBe(want);
  });
});

test('capitals mode: inside the country is not a bullseye, only the city is', async ({ page }) => {
  await page.evaluate(() => window.PP.setPrefs({ mode: 'capitals', region: 'world', timer: false }));
  await page.click('#startBtn'); await page.click('#introBtn');
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
      window.PP.startGame(); window.PP.beginRound();
      names.add(window.PP.state().target.mapName);
    }
    const regionOf = new Map(window.COUNTRIES.map((c) => [c[0], c[6]]));
    return { n, offRegion: [...names].filter((m) => regionOf.get(m) !== 'EU') };
  });
  expect(r.n).toBeGreaterThan(40);
  expect(r.offRegion).toEqual([]);
});

test('timer: a timed-out pin scores 0 and the round continues; a fast on-pace pin earns a bonus', async ({ page }) => {
  await page.evaluate(() => window.PP.setPrefs({ mode: 'countries', region: 'world', timer: true }));
  await page.click('#startBtn'); await page.click('#introBtn');
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
  await page.waitForTimeout(550); await page.click('#resBtn');
  s = await page.evaluate(() => {
    window.PP.timeOut();
    const G = window.PP.state();
    return { phase: G.phase, pin: G.pin, pts: G.guess.pts, timedOut: G.guess.timedOut, roundPts: G.roundPts };
  });
  expect(s.pin).toBe(2);
  expect(s.phase).toBe('result');
  expect(s.pts).toBe(0);
  expect(s.timedOut).toBe(true);
  expect(s.roundPts).toBe(5000);
  await expect(page.locator('#resTitle')).toContainText("Time's up");
});

test('a real mouse click on the canvas places the pin', async ({ page }) => {
  await page.click('#startBtn'); await page.click('#introBtn');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const s = await page.evaluate(() => { const G = window.PP.state(); return { hasGuess: !!G.guess, phase: G.phase }; });
  expect(s.hasGuess).toBe(true);
  expect(['result', 'over']).toContain(s.phase);
});
