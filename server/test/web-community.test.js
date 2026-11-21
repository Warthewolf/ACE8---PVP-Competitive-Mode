'use strict';
// Browser checks for role badges and notes, hidden ratings, casual matches and invite-only sign-up (skipped when
// Playwright is not installed).
const test = require('node:test');
const assert = require('node:assert');
const { setup, log, mirror, queuePair, config } = require('./helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

async function casualPair(env, a, b) {
  for (const p of [a, b]) {
    const s = await p.call('POST', '/api/integrity/report', env.cleanReport());
    await p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region: 'eu', mode: 'casual' });
  }
  const s = await a.call('GET', '/api/queue/status');
  assert.deepEqual([s.state, s.match.mode], ['matched', 'casual']);
  const host = s.match.role === 'host' ? a : b;
  await host.call('POST', `/api/matches/${s.match.id}/lobby`, { lobbyCode: 'ROOM1234' });
  return { id: s.match.id, host, guest: host === a ? b : a };
}
const play = async (m) => { await m.host.call('POST', `/api/matches/${m.id}/report`, log()); await m.guest.call('POST', `/api/matches/${m.id}/report`, mirror()); };

test('website: role badges and escaped notes on cards, the tier only for hidden ratings, casual matches, invite-only sign-up',
  { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
    const env = await setup();
    const browser = await chromium.launch();
    const savedInvite = config.access.inviteOnly;
    try {
      const [alpha, bravo, charlie, delta] = [await env.register('Alpha'), await env.register('Bravo'), await env.register('Charlie'), await env.register('Delta')];
      const ranked = await queuePair(env, alpha, bravo);
      await play(ranked);
      env.db.prepare('UPDATE players SET rating = ?, peak_rating = ? WHERE id = ?').run(1600, 1600, alpha.id);
      env.db.prepare('UPDATE players SET rating = ?, peak_rating = ? WHERE id = ?').run(1700, 1700, bravo.id);
      const note = 'Tester since day one <b id="pwn">x</b> & "friends"';
      await env.admin('POST', `/api/admin/players/${alpha.id}/role`, { role: 'tester', note });
      await env.admin('POST', `/api/admin/players/${charlie.id}/role`, { role: 'veteran' });
      await bravo.call('POST', '/api/me/settings', { hideRating: true });
      const casual = await casualPair(env, charlie, delta);
      await play(casual);
      const casualRatings = env.db.prepare('SELECT casual_rating FROM players WHERE casual_rating IS NOT NULL').all().map((r) => String(Math.round(r.casual_rating)));
      assert.equal(casualRatings.length, 2);

      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const go = async (hash) => { await page.goto(`${env.url}/${hash}`); await page.waitForSelector('#view main, #view section'); };
      const view = () => page.locator('#view').innerHTML();
      const noCasualNumbers = async (where) => { const html = await view(); for (const r of casualRatings) assert.ok(!html.includes(r), `${where} shows a casual rating`); };

      // Leaderboard: Bravo (hidden) stays first, with the tier instead of the number.
      await go('#/leaderboard');
      const rows = page.locator('.list .row');
      assert.equal(await rows.count(), 2);
      const first = await rows.nth(0).textContent();
      assert.ok(first.includes('Bravo') && first.includes('Wingman') && first.includes('Tier') && !first.includes('1700'), first);
      const second = await rows.nth(1).textContent();
      assert.ok(second.includes('Alpha') && second.includes('1600'), second);
      assert.equal(await rows.nth(1).locator('.badge.role-tester').textContent(), 'tester');
      assert.equal(await page.locator('.drawer .pnote').first().textContent(), note, 'the note is plain text');
      assert.equal(await page.$('#pwn'), null, 'markup in a note never renders');
      assert.ok(!(await page.locator('#d0').textContent()).includes('Peak'), 'no peak rating for a hidden rating');
      await noCasualNumbers('leaderboard');

      await go(`#/player/${alpha.id}`);
      assert.equal(await page.locator('#view .pnote').textContent(), note);
      assert.equal(await page.locator('#view .ttl .badge.role-tester').count(), 1);
      assert.equal(await page.$('#pwn'), null);

      await go(`#/player/${bravo.id}`);
      const figs = await page.locator('#view .figures').textContent();
      assert.ok(figs.includes('Tier') && figs.includes('Wingman') && !figs.includes('1700') && !figs.includes('Peak'), figs);

      await go(`#/player/${charlie.id}`);
      await noCasualNumbers('casual pilot profile');

      // Match list: the casual game carries a casual badge and the veteran badge.
      await go('#/matches');
      const card = page.locator(`a.card[href="#/match/${casual.id}"]`);
      assert.equal(await card.locator('.badge.casual').count(), 1);
      assert.equal(await card.locator('.badge.role-veteran').textContent(), 'veteran');
      assert.equal(await page.locator(`a.card[href="#/match/${ranked.id}"] .badge.casual`).count(), 0);
      await noCasualNumbers('match list');

      await go(`#/match/${casual.id}`);
      assert.equal(await page.locator('#view .who .box').textContent(), 'Casual');
      assert.deepEqual(await page.locator('#view .tbl tbody td:last-child').allTextContents(), ['—', '—'], 'no rating change for casual');
      await noCasualNumbers('casual match');

      await go(`#/match/${ranked.id}`);
      const cells = await page.locator('#view .tbl tbody tr').allTextContents();
      const bravoRow = cells.find((c) => c.includes('Bravo')); const alphaRow = cells.find((c) => c.includes('Alpha'));
      assert.ok(bravoRow.trim().endsWith('—'), `hidden pilot's rating change is not shown: ${bravoRow}`);
      assert.match(alphaRow.trim(), /[+-]\d+$/);
      assert.equal(await page.locator('#view .tbl .badge.role-tester').count(), 1);

      // Invite-only sign-up says the account waits for an admin.
      config.access.inviteOnly = true;
      await go('#/register');
      await page.fill('input[name=name]', 'Echo');
      await page.locator('#reg button').click();
      await page.waitForSelector('#regout pre.secret');
      assert.match(await page.locator('#regout .pending-note').textContent(), /waiting for an admin to let you in/);

      assert.deepEqual(errors, []);
    } finally { config.access.inviteOnly = savedInvite; await browser.close(); await env.close(); }
  });
