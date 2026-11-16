'use strict';
const $view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const get = async (url) => { const r = await fetch(url); const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status); return d; };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
const md = (t) => { const d = new Date(t); return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
const delta = (d) => (d == null ? '—' : `<span class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '+' : ''}${Math.round(d)}</span>`);
const stateLabel = { awaiting_reports: 'awaiting', registration: 'open' };
const badge = (cls, text) => `<span class="badge ${esc(cls)}">${esc(text ?? stateLabel[cls] ?? cls)}</span>`;

// ---------- generated HUD artwork (no third-party game art) ----------
const SVG = {
  reticle: '<svg class="reticle" viewBox="0 0 100 100" fill="none" stroke="#9fe6ff" stroke-width=".6"><circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="1.6"/><path d="M50 6v16M50 78v16M6 50h16M78 50h16M27 27l6 6M73 27l-6 6M27 73l6-6M73 73l-6-6"/></svg>',
  bracket: '<svg class="reticle" viewBox="0 0 100 100" fill="none" stroke="#9fe6ff" stroke-width=".7"><path d="M8 18h18v14H8M8 46h18V32M8 54h18v14H8M8 82h18V68M26 25h18v32H26M26 75h18V57M44 41h20v16H44M64 49h28"/><circle cx="92" cy="49" r="2.4"/></svg>',
  shield: '<svg class="reticle" viewBox="0 0 100 100" fill="none" stroke="#9fe6ff" stroke-width=".7"><path d="M50 10l30 11v24c0 21-13 36-30 45C33 81 20 66 20 45V21z"/><path d="M36 50l10 10 20-22"/></svg>',
  ladder: '<svg class="reticle" viewBox="0 0 100 100" fill="none" stroke="#9fe6ff" stroke-width=".7"><path d="M14 84h72M22 84V60h12v24M44 84V34h12v50M66 84V48h12v36"/><path d="M50 14l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>',
  file: '<svg class="reticle" viewBox="0 0 100 100" fill="none" stroke="#9fe6ff" stroke-width=".7"><path d="M28 12h30l16 16v60H28z"/><path d="M58 12v16h16M36 46h28M36 56h28M36 66h18"/></svg>',
  jet: '<svg class="reticle" viewBox="0 0 100 100" fill="none" stroke="#9fe6ff" stroke-width=".7"><path d="M50 8l5 22 30 22v6l-30-8-2 22 10 8v4l-13-3-13 3v-4l10-8-2-22-30 8v-6l30-22z"/></svg>',
  log: '<svg class="reticle" viewBox="0 0 100 100" fill="none" stroke="#9fe6ff" stroke-width=".7"><path d="M10 70l18-18 14 10 22-30 26 16"/><path d="M10 86h80M10 14v72"/></svg>',
};
const tile = ({ art = 'reticle', big = '', names = '', cls = '' } = {}) =>
  `<div class="tile ${cls}">${SVG[art] || ''}${big ? `<span class="big hud">${big}</span>` : ''}${names ? `<span class="names">${names}</span>` : ''}</div>`;

const title = (text, note = '', tag = 'h1') => `<div class="ttl"><${tag}>${text}</${tag}>${note ? `<div class="note">${note}</div>` : ''}</div>`;
const sheet = (html) => `<main class="sheet fade">${html}</main>`;
const cat = (base, active, items) => `<div class="cat"><div class="lbl">Category</div><div class="tabs">${items
  .map(([key, label]) => `<a href="#/${base}${key ? '/' + key : ''}" class="${key === active ? 'on' : ''}">${label}</a>`).join('')}</div></div>`;

// ---------- reusable blocks ----------
function pilotRow(p, i) {
  return `<div class="row" role="button" tabindex="0" aria-expanded="false" data-drawer="d${i}">
      <div class="thumb">${tile({ art: '', big: esc((p.name || '?').charAt(0).toUpperCase()), cls: 'sq' })}</div>
      <div class="yr">${p.rank}</div>
      <div class="name"><a href="#/player/${p.id}">${esc(p.name)}</a> ${badge(p.tier, p.tier)}</div>
      <div class="stats"><span><b>${p.rating}</b>Rating</span><span><b>${record(p)}</b>Record</span>
        <span class="opt"><b>${Math.round((100 * p.wins) / Math.max(1, p.wins + p.losses))}%</b>Win rate</span><span class="opt"><b>${p.kd}</b>K/D</span></div>
      <span class="plus" aria-hidden="true"></span>
    </div>
    <div class="drawer" id="d${i}">
      <div class="figures">${fig('Peak rating', p.peakRating)}${fig('Kills', p.kills)}${fig('Deaths', p.deaths)}${fig('K/D', p.kd)}</div>
      <a class="btn-line" href="#/player/${p.id}">Pilot profile</a>
    </div>`;
}
const record = (p) => `${p.wins}–${p.losses}${p.draws ? `–${p.draws}` : ''}`;
const fig = (label, value) => `<div><span class="box">${esc(label)}</span><div class="when">${esc(value)}</div></div>`;
const leaderList = (rows) => (rows.length
  ? `<div class="toolbar"><button type="button" data-allopen>All open <svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="#555"><path d="M1 1l8 5 8-5M1 6l8 5 8-5"/></svg></button></div><div class="list">${rows.map(pilotRow).join('')}</div>`
  : '<div class="empty">No ranked matches yet.</div>');

function matchCard(m) {
  const score = m.score ? `${m.score.host} – ${m.score.guest}` : 'VS';
  // Decide by id: two pilots' names can look alike, ids cannot.
  const hostWon = m.winner != null && m.winner === m.host.id;
  const guestWon = m.winner != null && m.winner === m.guest.id;
  const [winner, loser] = hostWon ? [m.host.name, m.guest.name] : [m.guest.name, m.host.name];
  const txt = m.state === 'verified'
    ? (hostWon || guestWon ? `${esc(winner)} defeats ${esc(loser)}` : `${esc(m.host.name)} and ${esc(m.guest.name)} draw`)
    : `${esc(m.host.name)} vs ${esc(m.guest.name)}`;
  return `<a class="card" href="#/match/${encodeURIComponent(m.id)}">
      ${tile({ big: score, names: `${esc(m.host.name)} · ${esc(m.guest.name)}`, cls: m.seriesId ? 'final' : '' })}
      <div class="meta"><span class="date">${ymd(m.createdAt)}</span>${m.seriesId ? badge('event', 'event') : badge(m.state)}</div>
      <div class="txt">${txt}</div></a>`;
}
const matchGrid = (rows, cls = '') => (rows.length ? `<div class="grid ${cls}">${rows.map(matchCard).join('')}</div>` : '<div class="empty">No matches yet.</div>');

function eventRow(t, i) {
  return `<div class="row" role="button" tabindex="0" aria-expanded="false" data-drawer="e${i}">
      <div class="thumb">${tile({ art: '', big: String(t.size), cls: `sq ${t.state === 'complete' ? 'final' : ''}` })}</div>
      <div class="yr">${md(t.created_at)}</div>
      <div class="name"><a href="#/tournament/${t.id}">${esc(t.name)}</a></div>
      <div class="stats ev">${badge(t.state)}<span class="opt"><b>${t.entrants}/${t.size}</b>Pilots</span></div>
      <span class="plus" aria-hidden="true"></span>
    </div>
    <div class="drawer" id="e${i}">
      <p>${t.champion != null ? `Champion: <b>${esc(t.champion_name)}</b>` : t.state === 'registration' ? `Registration is open. Join with <code>rvng join-event --id ${esc(t.id)}</code> in the companion app.` : 'Bracket in progress.'}</p>
      <a class="btn-line" href="#/tournament/${t.id}">View bracket</a>
    </div>`;
}
const eventList = (rows) => (rows.length ? `<div class="list">${rows.map(eventRow).join('')}</div>` : '<div class="empty">No events scheduled.</div>');

// ---------- pages ----------
const routes = {
  async ''() {
    const [s, lb, ms, ts] = await Promise.all([get('/api/stats'), get('/api/leaderboard?limit=10'), get('/api/matches?state=verified&limit=8'), get('/api/tournaments')]);
    return `<section class="hero">
        <h1>PROJECT RVNG</h1>
        <p class="sub">ACE COMBAT 8 · Competitive 1v1</p>
        <span class="season hud">SEASON 01</span>
        <div class="readout hud"><span>PILOTS<b>${s.players}</b></span><span>MATCHES<b>${s.matches}</b></span><span>IN QUEUE<b>${s.inQueue}</b></span><span>LIVE<b>${s.live}</b></span></div>
        <div class="feature">
          <a href="#/leaderboard">${tile({ art: 'ladder' })}<div class="cap">Ranked 1v1 Ladder<small>Every verified duel moves your rating</small></div></a>
          <a href="#/tournaments">${tile({ art: 'bracket', cls: 'final' })}<div class="cap">Knockout Events<small>Two pilots left standing fight for the title</small></div></a>
          <a href="#/integrity">${tile({ art: 'shield' })}<div class="cap">Fair Play<small>File, mod and flight-stat checks before every sortie</small></div></a>
        </div>
      </section>
      ${sheet(`
        <section>${title('Leaderboard', 'Top pilots of the current season.', 'h2')}${leaderList(lb)}<a class="more" href="#/leaderboard">View more</a></section>
        <section>${title('Latest Matches', '', 'h2')}${matchGrid(ms.slice(0, 8), 'four')}<a class="more" href="#/matches">View more</a></section>
        <section>${title('Events', '', 'h2')}${eventList(ts.slice(0, 5))}<a class="more" href="#/tournaments">View more</a></section>`)}`;
  },

  async leaderboard() {
    const rows = await get('/api/leaderboard?limit=200');
    return sheet(`${title('Leaderboard', 'Ranked 1v1. Only matches where both pilots\' logs agree and pass the integrity checks are counted.')}${leaderList(rows)}`);
  },

  async player(id) {
    const p = await get(`/api/players/${encodeURIComponent(id)}`);
    const integ = p.integrity
      ? `<div class="chron"><div class="when">${ymd(p.integrity.at)}</div><p>Last scan ${badge(p.integrity.verdict)}</p>
         ${p.integrity.mods.length ? `<p>${p.integrity.mods.map((m) => `<span class="box">${esc(m.name)}${m.approved ? '' : ' · unapproved'}</span>`).join(' ')}${p.integrity.modsTotal > p.integrity.mods.length ? ` <span class="box">+${esc(p.integrity.modsTotal - p.integrity.mods.length)} more</span>` : ''}</p>` : '<p>No mods besides the competitive client.</p>'}</div>`
      : '<div class="chron"><p>No integrity scan submitted yet.</p></div>';
    return sheet(`${title(esc(p.name), `${badge(p.tier, p.tier)} ${p.status !== 'active' ? badge(p.status) : ''}`)}
      <div class="figures">${fig('Rating', p.rating)}${fig('Peak', p.peakRating)}${fig('Wins', p.wins)}${fig('Losses', p.losses)}${p.draws ? fig('Draws', p.draws) : ''}${fig('K/D', p.kd)}</div>
      <div class="bar">Integrity <span class="i">i</span></div>${integ}
      <section>${title('Recent Matches', '', 'h2')}${matchGrid(p.matches.slice(0, 12))}</section>`);
  },

  async matches(state = '') {
    const rows = await get(`/api/matches?limit=60${state ? `&state=${encodeURIComponent(state)}` : ''}`);
    return sheet(`${title('Matches', 'Every duel is logged by both pilots and cross-checked before it counts.')}
      ${cat('matches', state, [['', 'All'], ['verified', 'Verified'], ['live', 'Live'], ['awaiting_reports', 'Awaiting'], ['disputed', 'Disputed']])}
      ${matchGrid(rows, 'four')}`);
  },

  async match(id) {
    const m = await get(`/api/matches/${encodeURIComponent(id)}/public`);
    // Only a verified result shows a winner and rating changes (a voided one has been undone).
    const ok = m.state === 'verified';
    const won = (p) => ok && m.winner === p.id;
    const row = (p, role, score, d) => `<tr><td><a href="#/player/${p.id}"><b>${esc(p.name)}</b></a>${won(p) ? ' ' + badge('verified', 'win') : ''}</td>
      <td class="opt">${role}</td><td class="r">${score ?? '—'}</td><td class="r">${delta(d)}</td></tr>`;
    const r = m.rules || {};
    return sheet(`${title('Match', `${ymd(m.createdAt)} ${badge(m.state)}`)}
      <div class="champion">${tile({ big: m.score ? `${m.score.host} – ${m.score.guest}` : 'VS', names: `${esc(m.host.name)} · ${esc(m.guest.name)}`, cls: m.seriesId ? 'final' : '' })}
        <div class="who"><span class="box">${m.seriesId ? 'Knockout event' : 'Ranked'}</span><b>${esc(m.host.name)}</b><span class="when">vs</span><b>${esc(m.guest.name)}</b></div></div>
      <div class="bar">Result <span class="i">i</span></div>
      <table class="tbl"><thead><tr><th>Pilot</th><th class="opt">Role</th><th class="r">Kills</th><th class="r">Rating</th></tr></thead><tbody>
        ${row(m.host, 'Host', m.score?.host, ok ? m.ratingDelta?.host : null)}${row(m.guest, 'Guest', m.score?.guest, ok ? m.ratingDelta?.guest : null)}</tbody></table>
      <div class="bar gap">Rules <span class="i">i</span></div>
      <div class="chron"><p>${r.killTarget ? `First to <b>${r.killTarget}</b> kills` : 'No kill target'} · ${r.timeLimitSec ? `${Math.round(r.timeLimitSec / 60)} min limit` : 'No time limit'} ·
        Special weapons ${r.specialWeapons === false ? 'off' : 'on'}${r.aircraftBans?.length ? ` · Banned: ${r.aircraftBans.map(esc).join(', ')}` : ''}</p></div>
      ${m.flags.length ? `<div class="bar">Review flags <span class="i">!</span></div><div class="chron">${m.flags.map((f) => `<p><span class="box">${esc(f.code.replace(/_/g, ' '))}</span></p>`).join('')}</div>` : ''}`);
  },

  async tournaments(state = '') {
    const all = await get('/api/tournaments');
    const rows = state ? all.filter((t) => t.state === state) : all;
    return sheet(`${title('Events', 'Single-elimination brackets seeded by rating. The last two pilots meet in the championship final.')}
      ${cat('tournaments', state, [['', 'All'], ['registration', 'Open'], ['running', 'Running'], ['complete', 'Complete']])}${eventList(rows)}`);
  },

  async tournament(id) {
    const t = await get(`/api/tournaments/${encodeURIComponent(id)}`);
    const roundName = (r) => (r === t.rounds ? 'Championship Final' : r === t.rounds - 1 ? 'Semi-finals' : r === t.rounds - 2 ? 'Quarter-finals' : `Round ${r}`);
    let body;
    if (t.state === 'registration') {
      body = `<div class="bar">Registered pilots · ${t.entrants.length}/${t.size} <span class="i">i</span></div>
        <div class="chron">${t.entrants.length ? t.entrants.map((e) => `<p><a href="#/player/${e.id}"><b>${esc(e.name)}</b></a> <span class="box">${Math.round(e.rating)}</span></p>`).join('') : '<p>No pilots yet.</p>'}</div>`;
    } else {
      const byRound = {};
      for (const s of t.series) (byRound[s.round] ||= []).push(s);
      body = `<div class="bracket">${Object.keys(byRound).map((r) => `<div class="round"><div class="bar">${roundName(Number(r))}</div><div class="slots">
        ${byRound[r].map((s) => {
          // Round-1 slots are fixed at the start, and a decided series is never filled: an empty slot there is a bye.
          const bye = (Number(r) === 1 || s.winner != null) && !(s.player_a && s.player_b);
          const p = (pid, name, w) => `<div class="p ${s.winner != null && s.winner === pid ? 'w' : ''}"><span>${pid ? `<a href="#/player/${pid}">${esc(name)}</a>` : `<span class="tbd">${bye ? 'BYE' : 'TBD'}</span>`}</span><span class="s">${pid && !bye ? w : ''}</span></div>`;
          return `<div class="series ${Number(r) === t.rounds ? 'final' : ''}">${p(s.player_a, s.a_name, s.wins_a)}${p(s.player_b, s.b_name, s.wins_b)}<div class="meta">${bye ? 'Bye' : `Best of ${s.best_of}`}</div></div>`;
        }).join('')}</div></div>`).join('')}</div>`;
    }
    return sheet(`<div class="kv">${SVG.bracket}<div class="kv-name">${esc(t.name)}</div><div class="kv-sub hud">${t.size}-PILOT KNOCKOUT · FINAL BEST OF ${t.final_best_of}</div></div>
      <nav class="subnav"><a href="#/tournaments">All events</a><a href="#/leaderboard">Leaderboard</a><a href="#/integrity">Rules &amp; fair play</a></nav>
      ${title('Bracket', `${badge(t.state)}<br>Rounds best of ${t.best_of} · final best of ${t.final_best_of}`, 'h2')}
      ${t.champion != null ? `<div class="champion">${tile({ art: 'bracket', big: 'CHAMPION', cls: 'final' })}<div class="who"><span class="box">Champion</span><b>${esc(t.champion_name)}</b></div></div>` : ''}
      ${body}`);
  },

  async integrity() {
    const checks = [
      ['file', 'File manifest', 'Every game file is checked by <b>size and SHA-256 hash</b> against a clean install of the same game version. Changed, missing or extra files are reported.'],
      ['shield', 'Mod detection', 'Extra <code>.pak</code>/<code>.ucas</code>/<code>.utoc</code> files, <code>~mods</code> and <code>LogicMods</code> folders, script mods and proxy DLLs are listed by name and size. Only approved mods, pinned by hash, are allowed.'],
      ['jet', 'Live aircraft stats', 'The mod reads each aircraft\'s flight parameters (top speed, turn rate, HP) from the running game. A change over 0.5% blocks the account from queueing.'],
      ['log', 'Cross-checked logs', 'Both pilots submit a match log. Scores, aircraft and duration must agree, and each pilot\'s top speed is checked using the <i>opponent\'s</i> log.'],
    ];
    return sheet(`${title('Fair Play', 'Before every queue session the companion app and in-game mod submit an integrity report. Only a clean result can queue.')}
      <div class="frames">${checks.map(([art, cap, txt]) => `<div class="framed"><div class="fr">${tile({ art, cls: 'sq' })}</div><div class="cap">${cap}</div><p>${txt}</p></div>`).join('')}</div>
      <section><div class="bar">When a check fails <span class="i">i</span></div>
      <div class="chron"><p>The match is marked ${badge('disputed')} and reviewed by an admin. It does not change anyone's rating, and an event series waits for the ruling. Tampered aircraft data or injected code in a pilot's own scan or log puts that account under review.</p></div></section>`);
  },

  async register() {
    return sheet(`${title('Sign up', 'Create a pilot account, then run the companion app next to the game.')}
      <form class="form" id="reg"><label>Callsign<input name="name" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_\\-][A-Za-z0-9_\\- ]*[A-Za-z0-9_\\-]" autocomplete="nickname"
        title="3-24 characters: letters, digits, space, _ or -, not starting or ending with a space"></label>
      <button>Register</button><div id="regout"></div></form>`);
  },
};

// ---------- interactions ----------
function toggle(row, open) {
  const d = document.getElementById(row.dataset.drawer);
  const next = open ?? row.getAttribute('aria-expanded') !== 'true';
  row.setAttribute('aria-expanded', String(next));
  d.classList.toggle('open', next);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const all = e.target.closest('[data-allopen]');
  if (all) {
    const rows = [...all.parentElement.nextElementSibling.querySelectorAll('.row[data-drawer]')];
    const open = rows.some((r) => r.getAttribute('aria-expanded') !== 'true');
    rows.forEach((r) => toggle(r, open));
    return;
  }
  const row = e.target.closest('.row[data-drawer]');
  if (row) toggle(row);
});
document.addEventListener('keydown', (e) => {
  // Only when the row itself has focus: Enter on a link inside the row must follow the link.
  const row = e.target.closest?.('.row[data-drawer]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(row); }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id !== 'reg') return;
  e.preventDefault();
  // The credentials are shown once: a second submit (double click, Enter) must not replace them.
  if (form.dataset.busy || form.dataset.done) return;
  const out = document.getElementById('regout');
  const body = Object.fromEntries(new FormData(form)); // read before the controls are disabled
  const controls = [...form.querySelectorAll('input, button')];
  form.dataset.busy = '1';
  controls.forEach((x) => { x.disabled = true; });
  try {
    const r = await fetch('/api/players/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    form.dataset.done = '1';
    const creds = { server: location.origin, apiKey: d.apiKey, apiSecret: d.apiSecret, playerId: d.id, name: d.name };
    out.innerHTML = `<p><b>Welcome, ${esc(d.name)}.</b> Save this as <code>credentials.json</code> next to the companion app. It is shown only once.</p>
      <pre class="secret">${esc(JSON.stringify(creds, null, 2))}</pre>`;
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    controls.forEach((x) => { x.disabled = false; });
  } finally { delete form.dataset.busy; }
});

const totop = document.querySelector('.totop');
totop.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
addEventListener('scroll', () => totop.classList.toggle('show', scrollY > 400), { passive: true });

let renderSeq = 0;
async function render() {
  const my = ++renderSeq;
  const [, page = '', arg] = location.hash.replace(/^#/, '').split('/');
  const section = { player: 'leaderboard', match: 'matches', tournament: 'tournaments' }[page] ?? page;
  document.querySelectorAll('.gnav nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  // Own routes only: a hash such as #/constructor/... must not reach Object.prototype.
  const fn = Object.hasOwn(routes, page) ? routes[page] : routes[''];
  let html;
  try { html = await fn(arg ? decodeURIComponent(arg) : arg); } catch (e) { html = sheet(`${title('Error')}<p class="error">${esc(e.message)}</p>`); }
  if (my !== renderSeq) return; // the user navigated on while this page was loading
  $view.innerHTML = html;
  scrollTo({ top: 0, behavior: 'instant' });
}
addEventListener('hashchange', render);
render();
