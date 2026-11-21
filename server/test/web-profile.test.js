'use strict';
// Browser check of the profile: sign in with credentials.json on #/me, save a bio, upload a photo (cropped in the
// browser), approve it on the admin page, see both on the public page (skipped when Playwright is not installed).
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

test('website: my profile, a bio and an approved photo', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const env = await setup();
  const browser = await chromium.launch();
  try {
    const me = await env.register('Profiled');
    const creds = Buffer.from(JSON.stringify({ server: env.url, apiKey: me.apiKey, apiSecret: me.apiSecret, playerId: me.id, name: me.name }));
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());

    await page.goto(env.url + '/#/me');
    await page.waitForSelector('#credfile');
    await page.setInputFiles('#credfile', { name: 'credentials.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":1}') });
    await page.waitForSelector('#meout .error');
    await page.setInputFiles('#credfile', { name: 'credentials.json', mimeType: 'application/json', buffer: creds });
    await page.waitForSelector('#bioform');
    assert.match(await page.textContent('#view'), /Signed in as Profiled/);

    const bio = 'Mobius fan <b id="pwn">x</b>\nSecond line';
    await page.fill('#bio', bio);
    await page.click('#bioform button');
    await page.waitForFunction(() => /Bio saved/.test(document.getElementById('meout').textContent));
    assert.equal((await env.admin('GET', '/api/admin/players')).find((p) => p.id === me.id).bio, bio);

    // a 640x400 PNG made in the page: cropped to a 320 px square JPEG before it is sent
    const png = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 400;
      const g = c.getContext('2d'); g.fillStyle = '#3d74a3'; g.fillRect(0, 0, 640, 400); g.fillStyle = '#ea6175'; g.fillRect(200, 80, 240, 240);
      return c.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await page.setInputFiles('#photofile', { name: 'me.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => /waiting for an admin/.test(document.getElementById('view').textContent));
    const [waiting] = await env.admin('GET', '/api/admin/photos');
    assert.match(waiting.image, /^data:image\/jpeg;base64,/, 'sent as JPEG');

    // the admin approves it
    const admin = await browser.newPage();
    admin.on('pageerror', (e) => errors.push(e.message));
    admin.on('dialog', (d) => d.accept());
    await admin.goto(env.url + '/admin.html#photos');
    await admin.fill('#token', 'test-admin');
    await admin.click('#login button');
    await admin.waitForSelector(`[data-photo="${waiting.id}"] img`);
    assert.equal(await admin.$eval(`[data-photo="${waiting.id}"] img`, (i) => i.naturalWidth), 320, 'the admin sees the square image');
    await admin.click(`[data-photo="${waiting.id}"] button[data-review="1"]`);
    await admin.waitForFunction(() => document.getElementById('msg').textContent === 'Photo approved.');
    await admin.goto(env.url + '/admin.html#players');
    await admin.waitForSelector(`[data-player="${me.id}"] button[data-clear="photo"]`);
    assert.match(await admin.textContent(`[data-player="${me.id}"]`), /Mobius fan/);

    // the public page
    await page.goto(env.url + `/#/player/${me.id}`);
    await page.waitForSelector('.profile-head img.avatar');
    const shown = await page.$eval('.profile-head img.avatar', (i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src') }));
    assert.deepEqual([shown.w, shown.h], [320, 320]);
    assert.match(shown.src, new RegExp(`^/api/players/${me.id}/photo\\?v=\\d+$`));
    assert.equal(await page.textContent('.bio'), bio, 'the bio as text');
    assert.equal(await page.$('#pwn'), null, 'never as markup');

    // the admin takes the photo down; the pilot signs out
    await admin.click(`[data-player="${me.id}"] button[data-clear="photo"]`);
    await admin.waitForFunction(() => document.getElementById('msg').textContent === 'Photo removed.');
    await page.goto(env.url + '/#/me');
    await page.waitForSelector('#bioform');
    assert.equal(await page.$('#photodel'), null, 'nothing left to remove');
    await page.click('#meout-signout');
    await page.waitForSelector('#credfile');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('rvng.creds')), null);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await env.close(); }
});
