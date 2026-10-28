/* Chat Plays Tetris – OBS overlay + match host.
 * URL options:  ?room=yourchannel  &time=180  &lobby=60  &ready=55  &results=15  &max=100  &join=custom.link  &local
 * Keys (OBS: right-click source → Interact):  F = force start · E = end match now · R = back to lobby */
(function () {
  'use strict';
  const T = window.Tetris;
  const qs = new URLSearchParams(location.search);
  const LOCAL = qs.has('local');
  const num = (k, d) => { const v = parseFloat(qs.get(k)); return isFinite(v) && v > 0 ? v : d; };
  const LOBBY_MS = num('lobby', 60) * 1000;
  const MATCH_MS = num('time', 180) * 1000;
  const PCT = Math.min(99, num('ready', 55));
  const RESULTS_MS = num('results', 15) * 1000;
  const MAX_PLAYERS = num('max', 100);
  const COUNTDOWN_MS = 3000;
  const EMPTY = '0'.repeat(200);

  let room = Net.cleanRoom(qs.get('room'));
  if (!room) {
    try { room = localStorage.getItem('cpt-room') || ''; } catch (e) { }
    if (!room) room = Array.from({ length: 5 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
    try { localStorage.setItem('cpt-room', room); } catch (e) { }
  }
  const joinText = qs.get('join') || new URL('./', location.href).href.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // ---------------- state ----------------
  const conns = new Map();   // connection id -> player
  let players = [];          // join order
  let phase = 'lobby';       // lobby | countdown | playing | results
  let lobbyStart = null, countdownEnd = 0, matchEnd = 0, resultsEnd = 0, results = [];
  let lastBroadcast = 0, netStatus = 'connecting';
  const now = () => performance.now();

  const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  function uniqueName(base, self) {
    base = base.slice(0, 13);
    let n = base, i = 1;
    while (players.some(q => q !== self && q.connected && q.name.toLowerCase() === n.toLowerCase())) n = base + ' ' + (++i);
    return n;
  }

  const net = Net.createHost(room, LOCAL, {
    onStatus(s) { netStatus = s; },
    onOpen() { },
    onMessage(id, m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') { hello(id, m); return; }
      const p = conns.get(id);
      if (!p) { net.send(id, { t: 'who' }); return; }
      p.lastSeen = now(); p.connected = true;
      if (m.t === 'ready') {
        if (phase === 'lobby') { p.ready = !!m.v; sendLobbyAll(); }
      } else if (m.t === 'snap') {
        if (p.inMatch && (phase === 'playing' || phase === 'countdown')) applySnap(p, m);
      } else if (m.t === 'bye') gone(p);
    },
    onClose(id) { const p = conns.get(id); if (p) gone(p); },
  });

  function hello(id, m) {
    const cid = String(m.cid || id).slice(0, 40);
    let p = players.find(q => q.cid === cid);
    if (p) {
      if (p.conn && p.conn !== id) { conns.delete(p.conn); net.drop(p.conn); }
      if (p.inMatch && (phase === 'playing' || phase === 'countdown') && !m.g) p.alive = false; // reloaded page: their game is gone
    } else {
      if (players.filter(q => q.connected).length >= MAX_PLAYERS) { net.send(id, { t: 'reject', reason: 'This room is full right now. Try again next round!' }); return; }
      p = { cid, name: '', ready: false, inMatch: false, alive: false, connected: true, board: EMPTY, score: 0, lines: 0, level: 1, ev: null, evAt: 0 };
      players.push(p);
    }
    p.name = uniqueName(cleanName(m.name) || 'Player', p);
    p.conn = id; p.connected = true; p.lastSeen = now(); p.lostAt = 0;
    conns.set(id, p);
    net.send(id, { t: 'welcome', name: p.name });
    if (phase === 'lobby') { if (lobbyStart == null) lobbyStart = now(); sendLobbyAll(); }
    else if (phase === 'results') net.send(id, endMsg(p));
    else sendTick(p);
  }

  function gone(p) {
    if (p.conn) { conns.delete(p.conn); net.drop(p.conn); }
    p.conn = null; p.connected = false; p.lostAt = now(); p.ready = false;
    if (phase === 'lobby' || !p.inMatch) { players = players.filter(q => q !== p); if (phase === 'lobby') sendLobbyAll(); }
  }

  function applySnap(p, m) {
    if (typeof m.b === 'string' && m.b.length === 200 && /^[0-7]+$/.test(m.b)) p.board = m.b;
    const s = Math.floor(+m.s); if (isFinite(s) && s >= 0 && s < 1e9) p.score = s;
    const l = Math.floor(+m.l); if (isFinite(l) && l >= 0) p.lines = l;
    const lv = Math.floor(+m.lv); if (isFinite(lv) && lv >= 1) p.level = lv;
    p.alive = m.a !== false;
    if (m.ev) { p.ev = String(m.ev).slice(0, 40); p.evAt = now(); }
  }

  // ---------------- match flow ----------------
  const lobbyPlayers = () => players.filter(p => p.connected);
  const matchPlayers = () => players.filter(p => p.inMatch);
  const needFor = total => Math.floor(total * PCT / 100 + 1e-9) + 1;   // "more than PCT %"
  const ranked = list => list.slice().sort((a, b) => b.score - a.score || b.lines - a.lines);

  function startMatch() {
    const seed = (Math.random() * 4294967296) >>> 0;
    players = players.filter(p => p.connected);
    if (!players.length) return;
    for (const p of players) Object.assign(p, { inMatch: true, alive: true, ready: false, board: EMPTY, score: 0, lines: 0, level: 1, ev: null });
    phase = 'countdown';
    countdownEnd = now() + COUNTDOWN_MS;
    matchEnd = countdownEnd + MATCH_MS;
    for (const p of players) net.send(p.conn, { t: 'start', seed, countdown: COUNTDOWN_MS, duration: MATCH_MS });
  }

  function endMatch() {
    if (phase !== 'playing' && phase !== 'countdown') return;
    phase = 'results';
    resultsEnd = now() + RESULTS_MS;
    results = ranked(matchPlayers());
    for (const p of players) if (p.connected) net.send(p.conn, endMsg(p));
  }

  function endMsg(p) {
    const i = results.indexOf(p);
    return { t: 'end', top: results.slice(0, 10).map(q => ({ n: q.name, s: q.score, l: q.lines })), rank: i + 1, total: results.length, score: p.score };
  }

  function toLobby() {
    players = players.filter(p => p.connected);
    for (const p of players) Object.assign(p, { inMatch: false, ready: false, alive: false, board: EMPTY, score: 0, lines: 0, level: 1, ev: null });
    phase = 'lobby'; results = [];
    lobbyStart = players.length ? now() : null;
    sendLobbyAll();
  }

  function sendLobbyAll() {
    const act = lobbyPlayers();
    const ready = act.filter(p => p.ready).length, total = act.length;
    const list = act.slice(0, 60).map(p => ({ n: p.name, r: p.ready }));
    const remaining = lobbyStart == null ? LOBBY_MS : Math.max(0, LOBBY_MS - (now() - lobbyStart));
    for (const p of act) net.send(p.conn, { t: 'lobby', players: list, more: Math.max(0, total - 60), ready, total, need: needFor(total), pct: PCT, remaining, youReady: p.ready });
  }

  function sendTick(p) {
    const r = ranked(matchPlayers());
    net.send(p.conn, {
      t: 'tick', phase, spectating: !p.inMatch,
      remaining: Math.max(0, matchEnd - now()) - (phase === 'countdown' ? COUNTDOWN_MS : 0),
      rank: r.indexOf(p) + 1, total: r.length, alive: r.filter(q => q.alive).length,
    });
  }

  function tick() {
    const t = now();
    for (const p of players.slice()) {
      if (p.connected && t - p.lastSeen > 10000) gone(p);
      else if (!p.connected && p.inMatch && p.alive && t - p.lostAt > 10000) p.alive = false;
    }
    if (phase === 'lobby') {
      const act = lobbyPlayers();
      if (!act.length) lobbyStart = null;
      else {
        if (lobbyStart == null) lobbyStart = t;
        const ready = act.filter(p => p.ready).length;
        if (t - lobbyStart >= LOBBY_MS && ready >= needFor(act.length)) startMatch();
      }
    }
    if (phase === 'countdown' && t >= countdownEnd) phase = 'playing';
    if (phase === 'playing' && (t >= matchEnd || matchPlayers().every(p => !p.alive))) endMatch();
    if (phase === 'results' && t >= resultsEnd) toLobby();
    if (t - lastBroadcast >= 1000) {
      lastBroadcast = t;
      if (phase === 'lobby') sendLobbyAll();
      else if (phase !== 'results') for (const p of players) if (p.connected) sendTick(p);
    }
  }
  setInterval(tick, 200);

  addEventListener('keydown', e => {
    if (e.code === 'KeyF' && phase === 'lobby' && lobbyPlayers().length) startMatch();
    else if (e.code === 'KeyE') endMatch();
    else if (e.code === 'KeyR') toLobby();
  });

  // ---------------- rendering ----------------
  const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const font = px => `${Math.round(px)}px 'Russo One', system-ui, sans-serif`;
  const GOLD = '#ffd820';

  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function fitText(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function render() {
    const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const U = Math.min(W / 1920, H / 1080);
    const t = now();

    const barH = Math.round(76 * U), m = Math.round(14 * U);
    drawTopBar(m, m, W - 2 * m, barH, U, t);

    const fields = phase === 'lobby' ? lobbyPlayers() : matchPlayers();
    const area = { x: m, y: m * 2 + barH, w: W - 2 * m, h: H - barH - m * 3 };
    if (!fields.length) { drawEmpty(area, U); return; }

    const rankOf = new Map();
    if (phase !== 'lobby') ranked(fields).forEach((p, i) => rankOf.set(p, i + 1));

    // choose the grid that gives the biggest cells
    const FW = 11.0, FH = 23.4;
    let best = { cols: 1, rows: 1, cell: 0 };
    for (let cols = 1; cols <= fields.length; cols++) {
      const rows = Math.ceil(fields.length / cols);
      const cell = Math.min(area.w / (cols * FW), area.h / (rows * FH));
      if (cell > best.cell) best = { cols, rows, cell };
    }
    const cell = Math.min(best.cell, 44 * U);
    const fw = cell * FW, fh = cell * FH;
    const gx = area.x + (area.w - best.cols * fw) / 2, gy = area.y + (area.h - best.rows * fh) / 2;
    fields.forEach((p, i) => {
      const row = Math.floor(i / best.cols);
      const inRow = row === best.rows - 1 ? fields.length - row * best.cols : best.cols; // centre the last row
      const rowX = gx + (best.cols - inRow) * fw / 2;
      drawField(p, rowX + (i % best.cols) * fw + cell * 0.25, gy + row * fh + cell * 0.25, cell, rankOf.get(p) || 0, t);
    });

    if (phase === 'countdown') {
      const s = Math.ceil((countdownEnd - t) / 1000);
      bigCenter(String(s), W, H, U);
    } else if (phase === 'playing' && t - countdownEnd < 800) bigCenter('GO!', W, H, U);
    else if (phase === 'results') drawResults(W, H, U, t);
  }

  function drawTopBar(x, y, w, h, U, t) {
    ctx.fillStyle = 'rgba(10,12,26,0.82)'; rr(x, y, w, h, 14 * U); ctx.fill();
    ctx.strokeStyle = 'rgba(180,76,255,0.55)'; ctx.lineWidth = 2 * U; ctx.stroke();
    const cy = y + h / 2;
    ctx.textBaseline = 'middle';
    // title
    ctx.textAlign = 'left'; ctx.font = font(30 * U);
    const g = ctx.createLinearGradient(x, 0, x + 380 * U, 0); g.addColorStop(0, '#1fd6f5'); g.addColorStop(1, '#b44cff');
    ctx.fillStyle = '#fff'; ctx.fillText('CHAT PLAYS', x + 22 * U, cy);
    const tw = ctx.measureText('CHAT PLAYS ').width;
    ctx.fillStyle = g; ctx.fillText('TETRIS', x + 22 * U + tw, cy);
    // join info
    ctx.textAlign = 'right'; ctx.font = font(26 * U);
    const codeW = ctx.measureText(room.toUpperCase()).width;
    ctx.fillStyle = GOLD; ctx.fillText(room.toUpperCase(), x + w - 22 * U, cy);
    ctx.fillStyle = '#9aa3c7'; ctx.font = font(20 * U);
    const roomLbl = 'ROOM ';
    ctx.fillText(roomLbl, x + w - 22 * U - codeW, cy);
    const rx = x + w - 22 * U - codeW - ctx.measureText(roomLbl).width - 26 * U;
    ctx.fillStyle = '#fff'; ctx.font = font(24 * U);
    ctx.fillText(joinText, rx, cy);
    const jw = ctx.measureText(joinText).width;
    ctx.fillStyle = '#9aa3c7'; ctx.font = font(20 * U);
    ctx.fillText('PLAY AT  ', rx - jw, cy);
    // status (centre)
    ctx.textAlign = 'center'; ctx.font = font(24 * U); ctx.fillStyle = '#fff';
    let s = '';
    const act = lobbyPlayers(), ready = act.filter(p => p.ready).length;
    if (phase === 'lobby') {
      if (!act.length) s = 'WAITING FOR PLAYERS';
      else {
        const rem = LOBBY_MS - (t - lobbyStart);
        s = rem > 0 ? `READY CHECK IN ${fmt(rem)}  ·  ${ready}/${act.length} READY`
          : `NEED ${needFor(act.length)} READY  ·  ${ready}/${act.length}`;
      }
    } else if (phase === 'countdown') s = 'GET READY…';
    else if (phase === 'playing') {
      const mp = matchPlayers(), waiting = act.filter(p => !p.inMatch).length;
      s = `${fmt(matchEnd - t)} LEFT  ·  ${mp.filter(p => p.alive).length}/${mp.length} ALIVE` + (waiting ? `  ·  ${waiting} WAITING` : '');
      if (matchEnd - t < 10000) ctx.fillStyle = '#ff6b7a';
    } else if (phase === 'results') s = `NEXT ROUND IN ${fmt(resultsEnd - t)}`;
    ctx.fillText(s, x + w * 0.42, cy);
    if (netStatus !== 'online') {
      ctx.font = font(15 * U); ctx.fillStyle = '#ff6b7a';
      const msg = netStatus === 'id-taken' ? 'room code in use by another open overlay – close other copies (retrying)' : 'connecting to network… (' + netStatus + ')';
      ctx.fillText(msg, x + w * 0.42, y + h + 14 * U);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawEmpty(a, U) {
    const w = 900 * U, h = 220 * U, x = a.x + (a.w - w) / 2, y = a.y + (a.h - h) / 2;
    ctx.fillStyle = 'rgba(10,12,26,0.8)'; rr(x, y, w, h, 20 * U); ctx.fill();
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = font(44 * U);
    ctx.fillText('JOIN THE GAME!', x + w / 2, y + 80 * U);
    ctx.font = font(28 * U); ctx.fillStyle = '#c9cff0';
    ctx.fillText(joinText, x + w / 2, y + 135 * U);
    ctx.fillStyle = GOLD; ctx.fillText('ROOM: ' + room.toUpperCase(), x + w / 2, y + 180 * U);
  }

  function drawField(p, x, y, cell, rank, t) {
    const bw = cell * 10, bh = cell * 20, hh = cell * 2.1, pad = cell * 0.25;
    const w = bw + pad * 2, h = hh + bh + pad;
    const leader = rank === 1 && p.score > 0;
    ctx.fillStyle = 'rgba(8,10,22,0.78)'; rr(x, y, w, h, cell * 0.45); ctx.fill();
    ctx.lineWidth = Math.max(1, cell * (leader ? 0.14 : 0.06));
    ctx.strokeStyle = leader ? GOLD : 'rgba(255,255,255,0.16)'; ctx.stroke();

    // header
    ctx.textBaseline = 'middle';
    const hy = y + hh * 0.36, hy2 = y + hh * 0.78;
    ctx.textAlign = 'left'; ctx.fillStyle = leader ? GOLD : '#fff'; ctx.font = font(cell * 0.78);
    const rk = rank ? '#' + rank + ' ' : '';
    ctx.fillText(fitText(rk + p.name, bw), x + pad, hy);
    if (phase !== 'lobby') {
      ctx.font = font(cell * 0.62); ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      ctx.fillText(p.score.toLocaleString(), x + pad, hy2);
      ctx.textAlign = 'right'; ctx.fillStyle = '#9aa3c7';
      ctx.fillText('L' + p.level + ' · ' + p.lines, x + pad + bw, hy2);
    }
    ctx.textBaseline = 'alphabetic';

    // board
    const bx = x + pad, by = y + hh;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx, by, bw, bh);
    if (cell >= 10) {
      ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 1; i < 10; i++) { ctx.moveTo(bx + i * cell, by); ctx.lineTo(bx + i * cell, by + bh); }
      for (let i = 1; i < 20; i++) { ctx.moveTo(bx, by + i * cell); ctx.lineTo(bx + bw, by + i * cell); }
      ctx.stroke();
    }
    const out = phase !== 'lobby' && !p.alive;
    const b = p.board;
    for (let i = 0; i < 200; i++) {
      const v = b.charCodeAt(i) - 48;
      if (v) T.drawCell(ctx, bx + (i % 10) * cell, by + Math.floor(i / 10) * cell, cell, v, out ? 0.3 : 1);
    }

    // status stamps
    let stamp = '', col = '#fff';
    if (phase === 'lobby') { stamp = p.ready ? 'READY' : 'NOT READY'; col = p.ready ? '#44e05c' : '#9aa3c7'; }
    else if (out) { stamp = p.connected ? 'OUT' : 'LEFT'; col = '#ff6b7a'; }
    if (stamp) {
      ctx.textAlign = 'center'; ctx.font = font(cell * (stamp.length > 5 ? 1.05 : 1.5));
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(bx, by + bh / 2 - cell * 1.1, bw, cell * 2.2);
      ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.fillText(stamp, bx + bw / 2, by + bh / 2); ctx.textBaseline = 'alphabetic';
    }

    // special-clear callouts
    if (p.ev && t - p.evAt < 1800) {
      const age = (t - p.evAt) / 1800;
      ctx.globalAlpha = 1 - age * age;
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      const parts = p.ev.split(' · ');
      parts.forEach((s, k) => {
        ctx.font = font(cell * (k ? 0.6 : 0.9));
        ctx.lineWidth = cell * 0.18; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        const ty = by + bh * 0.3 - age * cell * 1.5 + k * cell * 0.85;
        ctx.strokeText(fitText(s, bw), bx + bw / 2, ty); ctx.fillText(fitText(s, bw), bx + bw / 2, ty);
      });
      ctx.globalAlpha = 1;
    }
  }

  function bigCenter(text, W, H, U) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = font(220 * U);
    ctx.lineWidth = 16 * U; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(text, W / 2, H / 2);
    ctx.fillStyle = '#fff'; ctx.fillText(text, W / 2, H / 2); ctx.textBaseline = 'alphabetic';
  }

  function drawResults(W, H, U, t) {
    const top = results.slice(0, 8);
    const w = 760 * U, rowH = 50 * U, h = 230 * U + Math.max(0, top.length - 1) * rowH;
    const x = (W - w) / 2, y = (H - h) / 2;
    ctx.fillStyle = 'rgba(8,10,22,0.92)'; rr(x, y, w, h, 24 * U); ctx.fill();
    ctx.strokeStyle = GOLD; ctx.lineWidth = 3 * U; ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#9aa3c7'; ctx.font = font(26 * U);
    ctx.fillText('WINNER', W / 2, y + 52 * U);
    const win = top[0];
    ctx.fillStyle = GOLD; ctx.font = font(60 * U);
    ctx.fillText(win ? fitText(win.name, w - 60 * U) : '—', W / 2, y + 118 * U);
    ctx.fillStyle = '#fff'; ctx.font = font(30 * U);
    ctx.fillText(win ? win.score.toLocaleString() + ' pts' : '', W / 2, y + 160 * U);
    top.slice(1).forEach((p, i) => {
      const ry = y + 215 * U + i * rowH;
      ctx.textAlign = 'left'; ctx.fillStyle = '#9aa3c7'; ctx.font = font(26 * U);
      ctx.fillText('#' + (i + 2), x + 60 * U, ry);
      ctx.fillStyle = '#fff'; ctx.fillText(fitText(p.name, w - 380 * U), x + 140 * U, ry);
      ctx.textAlign = 'right'; ctx.fillText(p.score.toLocaleString(), x + w - 60 * U, ry);
    });
  }

  (function loop() { render(); requestAnimationFrame(loop); })();
  // expose for debugging in the browser console
  window.cpt = { get players() { return players; }, get phase() { return phase; }, startMatch, endMatch, toLobby };
})();
