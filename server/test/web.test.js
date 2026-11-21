'use strict';
// Browser checks for the website (skipped when Playwright is not installed).
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

test('website: own routes only, robust rendering, byes, keyboard links, one-time credentials, no stale pages',
  { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
    const env = await setup();
    const browser = await chromium.launch();
    try {
      // Data: a legacy blank-named ranked pilot, and a 3-pilot event in a 4 bracket (one bye).
      const ps = [];
      for (const n of ['Alpha', 'Bravo', 'Charlie']) ps.push(await env.register(n));
      env.db.prepare("UPDATE players SET name = '', wins = 1 WHERE id = ?").run(ps[2].id);
      env.db.prepare('UPDATE players SET wins = 1 WHERE id = ?').run(ps[0].id);
      const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Bye Cup', size: 4, bestOf: 1, finalBestOf: 1 });
      for (const p of ps) await p.call('POST', `/api/tournaments/${t.id}/register`);
      await env.admin('POST', `/api/admin/tournaments/${t.id}/start`);

      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const go = async (hash) => { await page.goto(`${env.url}/${hash}`); await page.waitForSelector('#view main, #view section'); };

      await go('#/constructor/%3Ch1%20id%3Dinjected%3Ex%3C%2Fh1%3E');
      assert.equal(await page.$('#injected'), null, 'prototype route must not render the payload');

      await go('#/leaderboard');
      assert.equal(await page.locator('#view h1').first().textContent(), 'Leaderboard');
      assert.equal(await page.locator('.list .row').count(), 2);

      await go(`#/tournament/${t.id}`);
      assert.ok((await page.locator('.bracket .tbd').allTextContents()).includes('BYE'));

      // Enter on the name link follows the link instead of toggling the row.
      await go('#/leaderboard');
      await page.locator('.list .row .name a').first().focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash.startsWith('#/player/'));

      // Double submit keeps the credentials.
      await go('#/register');
      await page.fill('input[name=name]', 'Delta');
      await page.locator('#reg button').dblclick();
      await page.waitForSelector('#regout pre.secret');
      // The download button saves the same credentials as credentials.json, without submitting the form again.
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#regsave')]);
      assert.equal(dl.suggestedFilename(), 'credentials.json');
      const saved = JSON.parse(require('node:fs').readFileSync(await dl.path(), 'utf8'));
      assert.equal(saved.name, 'Delta');
      assert.equal(saved.server, env.url);
      assert.ok(saved.apiKey && saved.apiSecret && saved.playerId);
      assert.deepEqual(saved, JSON.parse(await page.textContent('#regout pre.secret')));
      await page.locator('#reg').evaluate((f) => f.requestSubmit());
      await page.waitForTimeout(200);
      assert.ok(await page.$('#regout pre.secret'), 'credentials still shown');
      assert.ok(!(await page.locator('#regout').textContent()).includes('already registered'));

      // A slow page that resolves after the user navigated on must not replace the newer page.
      await page.route('**/api/leaderboard?limit=200', async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue(); });
      await page.evaluate(() => { location.hash = '#/leaderboard'; });
      await page.waitForTimeout(50);
      await page.evaluate(() => { location.hash = '#/integrity'; });
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('#view h1').first().textContent(), 'Fair Play');

      assert.deepEqual(errors, []);
    } finally { await browser.close(); await env.close(); }
  });
