'use strict';
const $view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const get = async (url) => { const r = await fetch(url); const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status); return d; };
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString(); };
const delta = (d) => (d == null ? '' : `<span class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '+' : ''}${Math.round(d)}</span>`);
const playerLink = (p) => `<a href="#/player/${p.id}">${esc(p.name)}</a>`;

async function stats() {
  try {
    const s = await get('/api/stats');
    document.getElementById('stats').innerHTML =
      `<span>Pilots <b>${s.players}</b></span><span>Verified matches <b>${s.matches}</b></span>` +
      `<span>In queue <b>${s.inQueue}</b></span><span>Live now <b>${s.live}</b></span>`;
  } catch { /* offline */ }
}

const routes = {
  async ''() {
    const rows = await get('/api/leaderboard?limit=100');
    return `<h1>Season leaderboard</h1><p class="muted">Ranked 1v1. Only matches where both pilots' logs agree and pass integrity checks count.</p>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Pilot</th><th>Tier</th><th class="num">Rating</th>
      <th class="num">W</th><th class="num">L</th><th class="num hide-sm">Win %</th><th class="num hide-sm">K/D</th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="${p.rank === 1 ? 'top1' : ''}"><td class="rank">${p.rank}</td><td>${playerLink(p)}</td>
        <td><span class="tier ${p.tier}">${p.tier}</span></td><td class="num"><b>${p.rating}</b></td><td class="num">${p.wins}</td>
        <td class="num">${p.losses}</td><td class="num hide-sm">${Math.round((100 * p.wins) / Math.max(1, p.wins + p.losses))}%</td>
        <td class="num hide-sm">${p.kd}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No ranked matches yet.</td></tr>'}
      </tbody></table></div>`;
  },

  async player(id) {
    const p = await get(`/api/players/${encodeURIComponent(id)}`);
    const integ = p.integrity
      ? `<span class="badge ${p.integrity.verdict}">${p.integrity.verdict}</span> <span class="muted">last scan ${ago(p.integrity.at)}</span>
         ${p.integrity.mods.length ? `<p class="muted">Mods: ${p.integrity.mods.map((m) => `${esc(m.name)}${m.approved ? '' : ' (unapproved)'}`).join(', ')}</p>` : ''}`
      : '<span class="muted">No scan submitted</span>';
    return `<h1>${esc(p.name)} <span class="tier ${p.tier}">${p.tier}</span> ${p.status !== 'active' ? `<span class="badge ${p.status}">${p.status}</span>` : ''}</h1>
      <div class="cards">
        <div class="card"><div class="k">Rating</div><div class="v">${p.rating}</div></div>
        <div class="card"><div class="k">Peak</div><div class="v">${p.peakRating}</div></div>
        <div class="card"><div class="k">Record</div><div class="v">${p.wins}–${p.losses}</div></div>
        <div class="card"><div class="k">K/D</div><div class="v">${p.kd}</div></div>
      </div>
      <h2>Integrity</h2><div class="panel">${integ}</div>
      <h2>Recent matches</h2>${matchTable(p.matches, p.id)}`;
  },

  async matches() {
    const rows = await get('/api/matches?limit=100');
    return `<h1>Matches</h1><p class="muted">Every match goes through the same pipeline: pending → live → both logs received → verified or disputed.</p>${matchTable(rows)}`;
  },

  async tournaments() {
    const rows = await get('/api/tournaments');
    return `<h1>Knockout events</h1><p class="muted">Single-elimination brackets seeded by rating. The last two pilots meet in the championship final.</p>
      <div class="table-wrap"><table><thead><tr><th>Event</th><th>Status</th><th class="num">Pilots</th><th>Champion</th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td><a href="#/tournament/${t.id}">${esc(t.name)}</a></td><td><span class="badge ${t.state}">${t.state}</span></td>
        <td class="num">${t.entrants}/${t.size}</td><td>${t.champion_name ? `🏆 ${esc(t.champion_name)}` : '—'}</td></tr>`).join('') ||
        '<tr><td colspan="4" class="empty">No events scheduled.</td></tr>'}</tbody></table></div>`;
  },

  async tournament(id) {
    const t = await get(`/api/tournaments/${encodeURIComponent(id)}`);
    const roundName = (r) => (r === t.rounds ? 'Championship final' : r === t.rounds - 1 ? 'Semi-finals' : r === t.rounds - 2 ? 'Quarter-finals' : `Round ${r}`);
    let body;
    if (t.state === 'registration') {
      body = `<div class="panel"><p>Registration open: <b>${t.entrants.length}/${t.size}</b> pilots.
        Register from the companion app or in-game menu.</p>
        ${t.entrants.length ? `<p class="muted">${t.entrants.map((e) => esc(e.name)).join(', ')}</p>` : ''}</div>`;
    } else {
      const byRound = {};
      for (const s of t.series) (byRound[s.round] ||= []).push(s);
      body = `<div class="bracket">${Object.keys(byRound).map((r) => `<div class="round"><h3>${roundName(Number(r))}</h3><div class="slots">
        ${byRound[r].map((s) => {
          const row = (pid, name, w) => `<div class="p ${s.winner && s.winner === pid ? 'w' : ''}"><span>${pid ? `<a href="#/player/${pid}">${esc(name)}</a>` : '<span class="muted">TBD</span>'}</span><span class="s">${pid ? w : ''}</span></div>`;
          return `<div class="series ${Number(r) === t.rounds ? 'final' : ''}">${row(s.player_a, s.a_name, s.wins_a)}${row(s.player_b, s.b_name, s.wins_b)}
            <div class="meta">Best of ${s.best_of}</div></div>`;
        }).join('')}</div></div>`).join('')}</div>`;
    }
    return `<h1>${esc(t.name)} <span class="badge ${t.state}">${t.state}</span></h1>
      ${t.champion_name ? `<div class="champion">Champion<br><b>🏆 ${esc(t.champion_name)}</b></div>` : ''}
      <p class="muted">${t.size}-pilot bracket · rounds best of ${t.best_of} · final best of ${t.final_best_of}</p>${body}`;
  },

  async integrity() {
    return `<h1>Fair play</h1>
      <div class="panel"><p>Before every queue session the companion app and in-game mod submit an integrity report. You cannot queue without a clean result.</p>
      <ol class="steps">
        <li><b>File manifest.</b> Every game file is checked by <b>size and SHA-256 hash</b> against a clean install of the same game version. Changed, missing or extra files are reported.</li>
        <li><b>Mod detection.</b> Extra <code>.pak/.ucas/.utoc</code> files, <code>~mods</code>/<code>LogicMods</code> folders, UE4SS script mods and proxy DLLs (<code>dxgi.dll</code>, <code>version.dll</code>, …) are listed by name and size. Only mods on the approved list, pinned by hash, are allowed.</li>
        <li><b>Live aircraft stats.</b> The mod reads each aircraft's flight parameters (top speed, turn rate, HP…) from game memory and the server compares them to the reference values. A change over 0.5% blocks the account.</li>
        <li><b>Cross-checked match logs.</b> Both pilots submit a log. Scores, deaths, aircraft and duration must match, and each pilot's observed top speed is checked against the aircraft's real limit <i>using the opponent's log</i>, which the suspect cannot edit.</li>
      </ol>
      <p class="muted">Matches that fail any check are marked <span class="badge disputed">disputed</span> and reviewed by an admin. They do not affect ratings.</p></div>`;
  },

  async register() {
    return `<h1>Create a pilot account</h1>
      <form class="panel" id="reg"><label>Callsign<input name="name" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_\\- ]+"></label>
      <label>Steam ID (optional)<input name="platformId" inputmode="numeric"></label><button>Register</button><p id="regout"></p></form>`;
  },
};

function matchTable(rows, viewer) {
  if (!rows.length) return '<div class="table-wrap"><div class="empty">No matches yet.</div></div>';
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Host</th><th class="num">Score</th><th>Guest</th><th>Status</th><th class="num">Rating</th></tr></thead><tbody>
    ${rows.map((m) => {
      const hw = m.winner === m.host.id; const gw = m.winner === m.guest.id;
      const rd = m.ratingDelta ? (viewer ? delta(viewer === m.host.id ? m.ratingDelta.host : m.ratingDelta.guest) : `${delta(m.ratingDelta.host)} / ${delta(m.ratingDelta.guest)}`) : '';
      return `<tr><td class="muted">${ago(m.createdAt)}</td><td>${hw ? '<b>' : ''}${playerLink(m.host)}${hw ? '</b>' : ''}</td>
        <td class="num">${m.score ? `${m.score.host} – ${m.score.guest}` : '—'}</td><td>${gw ? '<b>' : ''}${playerLink(m.guest)}${gw ? '</b>' : ''}</td>
        <td><span class="badge ${m.state}">${m.state}</span>${m.seriesId ? ' <span class="badge">event</span>' : ''}</td><td class="num">${rd}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'reg') return;
  e.preventDefault();
  const out = document.getElementById('regout');
  const body = Object.fromEntries(new FormData(e.target));
  if (!body.platformId) delete body.platformId;
  try {
    const r = await fetch('/api/players/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    const creds = { server: location.origin, apiKey: d.apiKey, apiSecret: d.apiSecret, playerId: d.id, name: d.name };
    out.innerHTML = `<b>Welcome, ${esc(d.name)}.</b> Save this as <code>credentials.json</code> next to the companion app. It is shown only once.
      <pre class="secret">${esc(JSON.stringify(creds, null, 2))}</pre>`;
  } catch (err) { out.innerHTML = `<span class="error">${esc(err.message)}</span>`; }
});

async function render() {
  const [, page = '', arg] = location.hash.replace(/^#/, '').split('/');
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page || 'leaderboard') || (page === 'tournament' && a.dataset.nav === 'tournaments')));
  const fn = routes[page] || routes[''];
  try { $view.innerHTML = await fn(arg); } catch (e) { $view.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
window.addEventListener('hashchange', render);
render(); stats(); setInterval(stats, 15000);
