'use strict';
// The admin page (public/admin.html) in a browser: sign-in with the token, a native match whose link was lost shown with
// both logs and settled from the page, a pending pilot let in, a player report closed, the build tab, and a wrong
// token refused. Skipped when Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert');
const { setup, queuePair, config } = require('./helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

const nativeLog = (k, d, s, os, end = 'disconnect') => ({
  format: 'native_dm', gameVersion: '1.0.0', runtimeVersion: '0.4.4', durationSec: 120, endReason: end,
  self: { aircraftId: '21010', kills: k, deaths: d, score: s }, opponent: { aircraftId: '10034010', kills: d, deaths: k, score: os },
  events: [...Array(k)].map((_, i) => ({ t: 10 + i, type: 'kill', actor: 'self' })),
});
const mirrorOf = (k, d, s, os) => ({ ...nativeLog(d, k, os, s),
  self: { aircraftId: '10034010', kills: d, deaths: k, score: os }, opponent: { aircraftId: '21010', kills: k, deaths: d, score: s } });

test('admin page: sign in, settle a lost-link match from both logs, let a pilot in, close a report',
  { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
    const env = await setup();
    const browser = await chromium.launch();
    const savedInvite = config.access.inviteOnly;
    try {
      const a = await env.register('AdminA'); const b = await env.register('AdminB');
      const m = await queuePair(env, a, b);
      await m.host.call('POST', `/api/matches/${m.id}/report`, nativeLog(2, 1, 3000, 2000));
      const r = await m.guest.call('POST', `/api/matches/${m.id}/report`, mirrorOf(2, 1, 3000, 2000));
      assert.equal(r.state, 'disputed');
      await a.call('POST', '/api/reports', { playerId: b.id, matchId: m.id, reason: 'griefing', details: 'left on purpose' });
      config.access.inviteOnly = true;
      const late = await env.register('LateJoiner');
      config.access.inviteOnly = savedInvite;

      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => d.accept());
      await page.goto(env.url + '/admin.html');
      await page.fill('#token', 'wrong');
      await page.click('#login button');
      await page.waitForSelector('#msg.bad');
      assert.match(await page.textContent('#msg'), /Wrong token/);

      await page.fill('#token', 'test-admin');
      await page.click('#login button');
      const card = page.locator(`[data-match="${m.id}"]`);
      await card.waitFor();
      assert.equal(await page.isVisible('#login'), false, 'the sign-in form is gone once signed in');
      const text = await card.textContent();
      assert.match(text, /link_lost/);
      assert.match(text, /native_dm/);
      assert.match(text, /score 3000/);
      assert.match(text, /score 2000/);
      await card.locator('select[name=winner]').selectOption(m.host === a ? 'host' : 'guest');
      await card.locator('button[type=submit]').click();
      await page.waitForFunction(() => document.getElementById('msg').textContent === 'Settled.');
      const settled = await env.admin('GET', `/api/admin/matches/${m.id}`);
      assert.equal(settled.state, 'verified');
      assert.equal(settled.winner, a.id);

      await page.goto(env.url + '/admin.html#players/pending');
      const row = page.locator(`[data-player="${late.id}"]`);
      await row.waitFor();
      await row.locator('button[data-status=active]').click();
      await page.waitForFunction(() => document.getElementById('msg').textContent === 'Status changed.');
      const players = await env.admin('GET', '/api/admin/players?status=active');
      assert.ok(players.some((p) => p.id === late.id));

      await page.goto(env.url + '/admin.html#reports');
      await page.locator('[data-report] button[value=dismissed]').click();
      await page.waitForFunction(() => document.getElementById('msg').textContent === 'Report closed.');
      assert.equal((await env.admin('GET', '/api/admin/reports?state=open')).length, 0);

      await page.goto(env.url + '/admin.html#build');
      await page.waitForSelector('[data-upload=baseline]');
      assert.match(await page.textContent('#panel'), /Project RVNG/);
      await page.goto(env.url + '/admin.html#scans');
      await page.waitForSelector('.admin-table');
      assert.deepEqual(errors, []);
    } finally { config.access.inviteOnly = savedInvite; await browser.close(); await env.close(); }
  });
