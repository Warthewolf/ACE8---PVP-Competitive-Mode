'use strict';
// The pilot's profile: a bio (shown right away) and a photo (shown once an admin approves it).
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');
const svc = require('../src/service');

// The smallest real images of each kind (the server reads only their first bytes)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20, 3)]);
const status = (code) => (e) => { assert.equal(e.status, code, e.message); return true; };

test('profile: photo types come from the bytes', () => {
  assert.equal(svc.photoMime(JPEG), 'image/jpeg');
  assert.equal(svc.photoMime(PNG), 'image/png');
  assert.equal(svc.photoMime(WEBP), 'image/webp');
  assert.equal(svc.photoMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'no SVG');
  assert.equal(svc.photoMime(Buffer.from('GIF89a......')), null, 'no GIF');
});

test('profile: the bio', async () => {
  const env = await setup();
  try {
    const a = await env.register('BioPilot');
    const me = await a.call('POST', '/api/me/profile', { bio: '  Mobius fan.\r\nFlies the F-22.  \n\n\n\nSee you up there.  ' });
    assert.equal(me.bio, 'Mobius fan.\nFlies the F-22.\n\nSee you up there.', 'trimmed, CRLF made LF, blank runs folded');
    assert.equal((await (await fetch(`${env.url}/api/players/${a.id}`)).json()).bio, me.bio, 'shown right away');
    await assert.rejects(a.call('POST', '/api/me/profile', { bio: 'x'.repeat(301) }), /at most 300 characters/);
    assert.equal((await a.call('POST', '/api/me/profile', { bio: '✈'.repeat(300) })).bio.length, 300, '300 characters, not bytes');
    await assert.rejects(a.call('POST', '/api/me/profile', { bio: '1\n2\n3\n4\n5\n6\n7' }), /at most 6 lines/);
    await assert.rejects(a.call('POST', '/api/me/profile', { bio: 'tab\there' }), /control characters/);
    await assert.rejects(a.call('POST', '/api/me/profile', { bio: 'evil‮reversed' }), /control characters/);
    await assert.rejects(a.call('POST', '/api/me/profile', { bio: 5 }), status(400));
    assert.equal((await a.call('POST', '/api/me/profile', { bio: '' })).bio, '', 'an empty bio clears it');

    await a.call('POST', '/api/me/profile', { bio: 'rude words' });
    const cleared = await env.admin('POST', `/api/admin/players/${a.id}/profile`, { bio: true });
    assert.equal(cleared.bio, '');
    await assert.rejects(env.admin('POST', `/api/admin/players/${a.id}/profile`, {}), status(400));
    await assert.rejects(env.admin('POST', '/api/admin/players/99999/profile', { bio: true }), status(404));

    await env.admin('POST', `/api/admin/players/${a.id}/status`, { status: 'banned' });
    await assert.rejects(a.call('POST', '/api/me/profile', { bio: 'back' }), /banned/);
  } finally { await env.close(); }
});

test('profile: a photo waits for an admin, then shows', async () => {
  const env = await setup();
  try {
    const a = await env.register('PhotoPilot');
    const pub = async () => (await fetch(`${env.url}/api/players/${a.id}`)).json();
    const photoUrl = `${env.url}/api/players/${a.id}/photo`;

    const up = await a.call('PUT', '/api/me/photo', { image: JPEG.toString('base64') });
    assert.equal(up.photo, null, 'not shown yet');
    assert.equal(up.photoReview.state, 'pending', 'the pilot sees it waiting');
    assert.equal((await pub()).photo, null);
    assert.equal((await pub()).photoReview, undefined, 'the review state is only in the pilot\'s own view');
    assert.equal((await fetch(photoUrl)).status, 404, 'nothing served before approval');

    const queue = await env.admin('GET', '/api/admin/photos');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].name, 'PhotoPilot');
    assert.equal(queue[0].image, `data:image/jpeg;base64,${JPEG.toString('base64')}`, 'the admin sees the image');
    await assert.rejects(a.call('GET', '/api/admin/photos'), status(403), 'admin only');

    await env.admin('POST', `/api/admin/photos/${queue[0].id}/review`, { approve: true });
    const shown = await pub();
    assert.match(shown.photo, new RegExp(`^/api/players/${a.id}/photo\\?v=\\d+$`));
    const r = await fetch(env.url + shown.photo);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(JPEG), 'the same bytes');
    assert.equal((await env.admin('GET', '/api/admin/photos')).length, 0);
    await assert.rejects(env.admin('POST', `/api/admin/photos/${queue[0].id}/review`, { approve: true }), status(404), 'reviewed once');

    // a new photo waits while the approved one stays; turned down, the approved one still stays
    const png = await a.call('PUT', '/api/me/photo', { image: `data:image/png;base64,${PNG.toString('base64')}` });
    assert.equal(png.photo, shown.photo, 'the approved photo stays while the new one waits');
    const [next] = await env.admin('GET', '/api/admin/photos');
    assert.equal(next.replaces, true);
    await env.admin('POST', `/api/admin/photos/${next.id}/review`, { approve: false });
    const me = await a.call('GET', '/api/me');
    assert.equal(me.photoReview.state, 'rejected', 'the pilot is told');
    assert.equal(me.photo, shown.photo);
    assert.equal(env.db.prepare("SELECT data FROM player_photos WHERE state = 'rejected'").get().data, '', 'a turned-down image is not kept');

    // approving a newer one replaces the shown photo, under a new address
    await a.call('PUT', '/api/me/photo', { image: WEBP.toString('base64') });
    assert.equal(env.db.prepare("SELECT COUNT(*) n FROM player_photos WHERE state = 'rejected'").get().n, 0, 'a new upload forgets the turned-down one');
    const [third] = await env.admin('GET', '/api/admin/photos');
    await env.admin('POST', `/api/admin/photos/${third.id}/review`, { approve: true });
    const now = await pub();
    assert.notEqual(now.photo, shown.photo);
    assert.equal((await fetch(env.url + now.photo)).headers.get('content-type'), 'image/webp');
    assert.equal(env.db.prepare('SELECT COUNT(*) n FROM player_photos WHERE player_id = ?').get(a.id).n, 1, 'only the shown photo is kept');

    // the pilot takes it down; the admin can too
    assert.equal((await a.call('DELETE', '/api/me/photo')).photo, null);
    assert.equal((await fetch(env.url + now.photo)).status, 404);
    await a.call('PUT', '/api/me/photo', { image: JPEG.toString('base64') });
    const [fourth] = await env.admin('GET', '/api/admin/photos');
    await env.admin('POST', `/api/admin/photos/${fourth.id}/review`, { approve: true });
    await a.call('PUT', '/api/me/photo', { image: PNG.toString('base64') });
    await env.admin('POST', `/api/admin/players/${a.id}/profile`, { photo: true });
    assert.equal((await pub()).photo, null);
    assert.equal((await env.admin('GET', '/api/admin/photos')).length, 0, 'and any upload waiting goes too');
    const listed = (await env.admin('GET', '/api/admin/players')).find((p) => p.id === a.id);
    assert.equal(listed.photo_id, null);
  } finally { await env.close(); }
});

test('admin: delete an account that never played', async () => {
  const env = await setup();
  try {
    const { queuePair, log, mirror } = require('./helpers');
    const lost = await env.register('LostCreds');
    await lost.call('POST', '/api/integrity/report', env.cleanReport());
    await lost.call('PUT', '/api/me/photo', { image: JPEG.toString('base64') });
    const other = await env.register('Reporter');
    await other.call('POST', '/api/reports', { playerId: lost.id, reason: 'other', details: 'test' });
    assert.deepEqual(await env.admin('DELETE', `/api/admin/players/${lost.id}`), { deleted: lost.id, name: 'LostCreds' });
    assert.equal((await fetch(`${env.url}/api/players/${lost.id}`)).status, 404);
    await assert.rejects(lost.call('GET', '/api/me'), status(401), 'its credentials stop working');
    for (const t of ['integrity_reports', 'player_photos', 'nonces']) assert.equal(env.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE player_id = ?`).get(lost.id).n, 0, t);
    assert.equal(env.db.prepare('SELECT COUNT(*) n FROM player_reports WHERE reported_id = ?').get(lost.id).n, 0);
    assert.ok((await env.register('LostCreds')).id, 'the name is free again');
    await assert.rejects(env.admin('DELETE', '/api/admin/players/99999'), status(404));

    const [a, b] = [await env.register('PlayedA'), await env.register('PlayedB')];
    const m = await queuePair(env, a, b);
    await m.host.call('POST', `/api/matches/${m.id}/report`, log());
    await m.guest.call('POST', `/api/matches/${m.id}/report`, mirror());
    await assert.rejects(env.admin('DELETE', `/api/admin/players/${a.id}`), /ban the account instead/);
    assert.equal((await fetch(`${env.url}/api/players/${a.id}`)).status, 200);
  } finally { await env.close(); }
});

test('profile: what an upload may be', async () => {
  const env = await setup();
  try {
    const a = await env.register('BadUploads');
    await assert.rejects(a.call('PUT', '/api/me/photo', { image: Buffer.from('<svg onload=alert(1)>').toString('base64') }), /only JPEG, PNG or WebP/);
    await assert.rejects(a.call('PUT', '/api/me/photo', { image: 'not base64!' }), /not base64/);
    await assert.rejects(a.call('PUT', '/api/me/photo', { image: '' }), /not base64/);
    await assert.rejects(a.call('PUT', '/api/me/photo', {}), status(400));
    const big = Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(svc.PHOTO_MAX_BYTES)]);
    await assert.rejects(a.call('PUT', '/api/me/photo', { image: big.toString('base64') }), status(413));
    assert.equal((await env.admin('GET', '/api/admin/photos')).length, 0);
    // two uploads before a review: only the newer waits
    await a.call('PUT', '/api/me/photo', { image: JPEG.toString('base64') });
    await a.call('PUT', '/api/me/photo', { image: PNG.toString('base64') });
    const q = await env.admin('GET', '/api/admin/photos');
    assert.equal(q.length, 1);
    assert.match(q[0].image, /^data:image\/png;/);
    await assert.rejects(env.admin('POST', `/api/admin/photos/${q[0].id}/review`, { approve: 'yes' }), status(400));
    assert.equal((await fetch(`${env.url}/api/players/999999/photo`)).status, 404);
  } finally { await env.close(); }
});
