'use strict';
// The admin page (/admin.html): the server's admin API on the website (the user, 2026-11-21: "everything gets ran on
// the website"). Disputes (both logs side by side, settle or void), players (let in, flag, ban, role, note), player
// reports, recent scans, and the game build's file list and the approved mods (JSON files, as the README's curl
// commands send them). The token stays in this tab's sessionStorage and goes only to this server, as a Bearer header.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => (t ? new Date(t).toLocaleString() : '');
const KEY = 'rvng-admin-token';
let token = '';
try { token = sessionStorage.getItem(KEY) || ''; } catch { /* storage blocked: sign in each time */ }

async function call(method, path, body) {
  const r = await fetch(path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null;
  try { d = await r.json(); } catch { /* not JSON */ }
  if (r.status === 403 || r.status === 503) { signOut(d && d.error === 'ADMIN_TOKEN not configured' ? 'The server has no ADMIN_TOKEN set.' : 'Wrong token.'); throw new Error('signed out'); }
  if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
  return d;
}
function say(text, bad) { const m = $('msg'); m.textContent = text || ''; m.className = 'admin-msg' + (bad ? ' bad' : ''); }
async function act(fn, done) {
  try { const out = await fn(); if (done) say(done); await show(); return out; } catch (e) { if (e.message !== 'signed out') say(e.message, true); return null; }
}

function signOut(why) {
  token = '';
  try { sessionStorage.removeItem(KEY); } catch { /* */ }
  $('login').hidden = false; $('signout').hidden = true; $('panel').innerHTML = '';
  say(why || '', Boolean(why));
}
$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  try { sessionStorage.setItem(KEY, token); } catch { /* */ }
  $('token').value = '';
  say('');
  await show();
});
$('signout').addEventListener('click', () => signOut());
window.addEventListener('hashchange', () => show());

const tab = () => (location.hash.slice(1) || 'disputes').split('/')[0];
async function show() {
  if (!token) return signOut();
  $('login').hidden = true; $('signout').hidden = false;
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab()));
  const views = { disputes, players, reports, scans, build };
  try { $('panel').innerHTML = await (views[tab()] || disputes)(); } catch (e) { if (e.message !== 'signed out') say(e.message, true); }
}

// ---- disputes: the matches an admin decides (a lost link, logs that disagree, a missing log)
const sideName = (m, side) => esc(m[side].name);
function logSummary(rep) {
  if (!rep) return '<em>none</em>';
  const r = rep.report || {};
  const s = r.self || {}; const o = r.opponent || {};
  return `<dl class="admin-log">
    <dt>Format</dt><dd>${esc(r.format || 'old design')}</dd>
    <dt>Length</dt><dd>${esc(r.durationSec)} s, ${esc(r.endReason || r.end || '')}</dd>
    <dt>Self</dt><dd>plane ${esc(s.aircraftId)}, score ${esc(s.score ?? '')}, ${esc(s.kills)} kills, ${esc(s.deaths)} deaths</dd>
    <dt>Opponent</dt><dd>plane ${esc(o.aircraftId)}, score ${esc(o.score ?? '')}, ${esc(o.kills)} kills, ${esc(o.deaths)} deaths</dd>
    <dt>Sent</dt><dd>${when(rep.receivedAt)}</dd></dl>`;
}
async function disputes() {
  const open = [...await call('GET', '/api/matches?state=disputed&limit=100'), ...await call('GET', '/api/matches?state=awaiting_reports&limit=100')];
  if (!open.length) return '<div class="ttl"><h1>Disputes</h1></div><div class="empty">Nothing to decide.</div>';
  const full = await Promise.all(open.map((m) => call('GET', `/api/admin/matches/${encodeURIComponent(m.id)}`)));
  return '<div class="ttl"><h1>Disputes</h1><div class="note">A lost link, logs that disagree, or a log that never came. Settling credits the match as you score it; voiding leaves everyone as they were.</div></div>'
    + full.map((m) => {
      const host = m.reports.find((r) => r.side === 'host'); const guest = m.reports.find((r) => r.side === 'guest');
      const suggest = (rep, side) => { const s = rep && rep.report && rep.report.self; return s && s.score != null ? Math.round(s.score) : s ? s.kills : ''; };
      return `<section class="admin-card" data-match="${esc(m.id)}">
        <h2>${sideName(m, 'host')} vs ${sideName(m, 'guest')} <span class="badge ${esc(m.state)}">${esc(m.state)}</span> <span class="badge casual">${esc(m.mode)}</span></h2>
        <p class="admin-flags">${(m.flags || []).map((f) => `<code>${esc(f.code)}</code>`).join(' ') || 'no flags yet (waiting for the other log)'} · ${when(m.createdAt)} · <code>${esc(m.id)}</code></p>
        <div class="admin-two"><div><h3>${sideName(m, 'host')} (host)</h3>${logSummary(host)}</div><div><h3>${sideName(m, 'guest')} (guest)</h3>${logSummary(guest)}</div></div>
        <form class="admin-settle" data-settle="${esc(m.id)}">
          <label>Winner <select name="winner"><option value="host">${sideName(m, 'host')}</option><option value="guest">${sideName(m, 'guest')}</option><option value="draw">Draw</option></select></label>
          <label>${sideName(m, 'host')} score <input name="scoreHost" type="number" min="0" step="1" value="${esc(suggest(host))}" required></label>
          <label>${sideName(m, 'guest')} score <input name="scoreGuest" type="number" min="0" step="1" value="${esc(suggest(guest))}" required></label>
          <button class="btn-line" type="submit">Settle</button>
          <button class="btn-line" type="button" data-void="${esc(m.id)}">Void</button>
        </form></section>`;
    }).join('');
}

// ---- players
const STATUSES = ['active', 'pending', 'flagged', 'banned'];
async function players() {
  const filter = location.hash.split('/')[1] || '';
  const rows = await call('GET', `/api/admin/players?limit=500${filter ? `&status=${encodeURIComponent(filter)}` : ''}`);
  const tabs = ['', ...STATUSES].map((s) => `<a href="#players${s ? '/' + s : ''}" class="${s === filter ? 'on' : ''}">${s || 'all'}</a>`).join('');
  return `<div class="ttl"><h1>Players</h1><div class="note">Pending: waiting to be let in (invite-only). Flagged: under review. Banned: refused everywhere.</div></div>
    <div class="cat"><div class="tabs">${tabs}</div></div>
    ${rows.length ? `<table class="admin-table"><thead><tr><th>Pilot</th><th>Status</th><th>Rating</th><th>Record</th><th>Lapses</th><th>Reports</th><th>Joined</th><th></th></tr></thead><tbody>
    ${rows.map((p) => `<tr data-player="${p.id}">
      <td><a href="/#/player/${p.id}">${esc(p.name)}</a><br><small>${esc(p.role)}${p.note ? ': ' + esc(p.note) : ''}</small></td>
      <td><span class="badge ${esc(p.status)}">${esc(p.status)}</span></td><td>${esc(p.rating)}</td><td>${p.wins}-${p.losses}${p.draws ? '-' + p.draws : ''}</td>
      <td>${p.lapses}</td><td>${p.open_reports}</td><td>${when(p.created_at)}</td>
      <td class="admin-actions">${STATUSES.filter((s) => s !== p.status).map((s) => `<button type="button" data-status="${s}">${s === 'active' ? 'let in' : s}</button>`).join('')}
        <button type="button" data-card>role / note</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No players.</div>'}`;
}

// ---- player reports
async function reports() {
  const rows = await call('GET', '/api/admin/reports?state=open');
  return `<div class="ttl"><h1>Reports</h1><div class="note">Reports from pilots. Closing one changes nothing else: act on the pilot under Players, or on the match under Disputes.</div></div>
    ${rows.length ? rows.map((r) => `<section class="admin-card" data-report="${r.id}">
      <h2>${esc(r.reporter && r.reporter.name)} reported ${esc(r.reported && r.reported.name)} <span class="badge disputed">${esc(r.reason)}</span></h2>
      <p>${esc(r.details)}</p><p class="admin-flags">${when(r.createdAt)}${r.matchId ? ` · match <code>${esc(r.matchId)}</code>` : ''}</p>
      <form class="admin-settle" data-close="${r.id}"><label>Note <input name="note" maxlength="500"></label>
        <button class="btn-line" type="submit" name="state" value="resolved">Resolved</button>
        <button class="btn-line" type="submit" name="state" value="dismissed">Dismiss</button></form></section>`).join('')
    : '<div class="empty">No open reports.</div>'}`;
}

// ---- scans
async function scans() {
  const rows = await call('GET', '/api/admin/integrity?limit=100');
  return `<div class="ttl"><h1>Scans</h1><div class="note">The companion's mod scans, newest first.</div></div>
    ${rows.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Pilot</th><th>Build</th><th>Verdict</th><th>Findings</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${when(r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.game_version)}</td><td><span class="badge ${esc(r.verdict)}">${esc(r.verdict)}</span></td>
      <td>${(r.findings || []).slice(0, 6).map((f) => `<code>${esc(f.code)}</code> ${esc(f.path || f.detail || '')}`).join('<br>')}${(r.findings || []).length > 6 ? `<br>+${r.findings.length - 6} more` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No scans yet.</div>'}`;
}

// ---- the game build's file list and the approved mods
async function build() {
  const mods = await call('GET', '/api/admin/mods');
  const list = Array.isArray(mods) ? mods : mods.mods || [];
  const byMod = {};
  for (const m of list) (byMod[`${m.name} ${m.version || ''}`.trim()] ||= []).push(m);
  return `<div class="ttl"><h1>Build &amp; mods</h1><div class="note">The clean game's file list (one per game build) and the mod files pilots may have installed.</div></div>
    <section class="admin-card"><h2>Game build</h2>
      <p>A JSON file as the README's baseline upload sends it: <code>{ "gameVersion", "manifest": { "files": [...] }, "aircraft": {...} }</code>.</p>
      <form class="admin-settle" data-upload="baseline"><input type="file" name="file" accept=".json,application/json" required><button class="btn-line" type="submit">Upload build</button></form></section>
    <section class="admin-card"><h2>Approved mods</h2>
      <p>A JSON file with <code>{ "name", "version", "mods": [{ "path", "size", "sha256", "category" }] }</code> (category: required or cosmetic).</p>
      <form class="admin-settle" data-upload="mods"><input type="file" name="file" accept=".json,application/json" required><button class="btn-line" type="submit">Add mods</button></form>
      ${Object.keys(byMod).length ? `<table class="admin-table"><thead><tr><th>Mod</th><th>Files</th><th>Categories</th><th></th></tr></thead><tbody>
      ${Object.entries(byMod).map(([k, files]) => `<tr><td>${esc(k)}</td><td>${files.length}</td><td>${esc([...new Set(files.map((f) => f.category))].join(', '))}</td>
        <td class="admin-actions"><button type="button" data-retire="${esc(JSON.stringify(files.filter((f) => f.category !== 'retired').map((f) => f.id)))}">retire</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No approved mods yet.</div>'}</section>`;
}

// ---- actions
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.dataset.settle) {
    e.preventDefault();
    const d = new FormData(f);
    await act(() => call('POST', `/api/admin/matches/${encodeURIComponent(f.dataset.settle)}/resolve`,
      { winner: d.get('winner'), scoreHost: Number(d.get('scoreHost')), scoreGuest: Number(d.get('scoreGuest')) }), 'Settled.');
  } else if (f.dataset.close) {
    e.preventDefault();
    await act(() => call('POST', `/api/admin/reports/${f.dataset.close}/close`, { state: e.submitter ? e.submitter.value : 'resolved', note: new FormData(f).get('note') || '' }), 'Report closed.');
  } else if (f.dataset.upload) {
    e.preventDefault();
    const file = f.elements.file.files[0];
    if (!file) return;
    let body;
    try { body = JSON.parse(await file.text()); } catch { return say(`${file.name} isn't valid JSON.`, true); }
    if (f.dataset.upload === 'baseline') await act(() => call('PUT', '/api/admin/baselines', body), `Build ${body.gameVersion || ''} uploaded.`);
    else await act(() => call('POST', '/api/admin/mods', body), 'Mods added.');
  }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.void && confirm('Void this match? Nobody is credited, and ratings stay as they were.')) {
    await act(() => call('POST', `/api/admin/matches/${encodeURIComponent(b.dataset.void)}/resolve`, { void: true }), 'Voided.');
  } else if (b.dataset.status) {
    const id = b.closest('[data-player]').dataset.player;
    await act(() => call('POST', `/api/admin/players/${id}/status`, { status: b.dataset.status }), 'Status changed.');
  } else if (b.hasAttribute('data-card')) {
    const id = b.closest('[data-player]').dataset.player;
    const role = prompt('Role (player, tester or veteran); leave empty to keep it:');
    if (role === null) return;
    const note = prompt('Note on the pilot\'s card (empty clears it):');
    if (note === null) return;
    await act(() => call('POST', `/api/admin/players/${id}/role`, { ...(role.trim() ? { role: role.trim() } : {}), note }), 'Card updated.');
  } else if (b.dataset.retire) {
    const ids = JSON.parse(b.dataset.retire);
    if (ids.length && confirm('Retire these files? A scan that still finds them is no longer clean.')) await act(() => call('POST', '/api/admin/mods/retire', { ids }), 'Retired.');
  }
});

show();
