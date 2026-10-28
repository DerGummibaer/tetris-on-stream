/* Chat Plays Tetris – player page */
(function () {
  'use strict';
  const T = window.Tetris;
  const qs = new URLSearchParams(location.search);
  const LOCAL = qs.has('local');
  const $ = id => document.getElementById(id);
  const SCREENS = ['join', 'status', 'lobby', 'wait', 'results'];
  function show(name) { for (const s of SCREENS) $('s-' + s).classList.toggle('hidden', s !== name); }

  let cid;
  try { cid = sessionStorage.getItem('cpt-cid'); if (!cid) { cid = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('cpt-cid', cid); } }
  catch (e) { cid = Math.random().toString(36).slice(2, 12); }

  let net = null, room = '', myName = '', welcomed = false, helloTimer = null;
  let mode = 'join';          // join | status | lobby | game | wait | results
  let myReady = false;
  let game = null, startAt = 0, endAt = 0, gameActive = false, rankInfo = null;
  let lastSnap = '', lastSnapAt = 0, sentScore = -1, sentAlive = true, pendingEv = null;
  const floaters = [];

  // ---------- join ----------
  $('room').value = Net.cleanRoom(qs.get('room') || '');
  try { $('name').value = localStorage.getItem('cpt-name') || ''; } catch (e) { }
  ($('room').value ? $('name') : $('room')).focus();

  const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);

  $('joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const r = Net.cleanRoom($('room').value), n = cleanName($('name').value);
    if (!r || !n) return;
    room = r; myName = n;
    try { localStorage.setItem('cpt-name', n); } catch (e) { }
    const u = new URL(location.href); u.searchParams.set('room', r); history.replaceState(null, '', u);
    document.activeElement && document.activeElement.blur();
    connect();
  });

  function setStatus(t) {
    $('statusText').textContent = t;
    if (mode !== 'game') { mode = 'status'; show('status'); }
  }

  function connect() {
    setStatus('Connecting to room "' + room + '"…');
    try {
      net = Net.createClient(room, LOCAL, {
        onOpen() { sayHello(); },
        onMessage: handle,
        onClose() { welcomed = false; netWarn(true); if (mode !== 'game') setStatus('Lost connection to the stream overlay. Reconnecting…'); },
        onStatus(t) { if (!welcomed) setStatus(t); },
      });
    } catch (err) { setStatus(err.message); return; }
    setInterval(() => { if (net) net.send({ t: 'ping' }); }, 2000);
  }

  function sayHello() {
    net.send({ t: 'hello', name: myName, cid, g: !!(game && gameActive) });
    clearTimeout(helloTimer);
    helloTimer = setTimeout(() => { if (!welcomed) sayHello(); }, 4000);
  }

  function netWarn(on) { $('netWarn').classList.toggle('hidden', !on || mode !== 'game'); }

  // ---------- messages from the overlay ----------
  function handle(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome':
        welcomed = true; netWarn(false);
        myName = m.name; $('lbName').textContent = m.name; $('lbRoom').textContent = room;
        if (mode === 'status') { mode = 'wait'; show('wait'); $('waitText').textContent = 'Connected! Waiting for the overlay…'; }
        break;
      case 'who': welcomed = false; sayHello(); break;
      case 'lobby': onLobby(m); break;
      case 'start': onStart(m); break;
      case 'tick': onTick(m); break;
      case 'end': onEnd(m); break;
      case 'reject': setStatus(m.reason || 'The room rejected you.'); break;
    }
  }

  const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function onLobby(m) {
    game = null; gameActive = false;
    if (mode !== 'lobby') { mode = 'lobby'; show('lobby'); }
    myReady = !!m.youReady;
    const btn = $('readyBtn');
    btn.classList.toggle('on', myReady);
    btn.textContent = myReady ? 'READY ✓' : "I'M READY";
    const info = m.remaining > 0
      ? `Ready check in <b>${fmt(m.remaining)}</b>. The match starts when more than ${m.pct}% of players are ready — <b>${m.ready}/${m.total}</b> so far (need ${m.need}).`
      : `Waiting for more than ${m.pct}% to be ready: <b>${m.ready}/${m.total}</b> (need ${m.need}).`;
    $('lbInfo').innerHTML = info;
    $('lbBar').style.width = (m.total ? (m.ready / m.total) * 100 : 0) + '%';
    $('lbNeed').style.left = m.pct + '%';
    const ul = $('lbPlayers'); ul.textContent = '';
    for (const p of m.players || []) {
      const li = document.createElement('li');
      li.textContent = (p.r ? '✓ ' : '') + p.n;
      if (p.r) li.classList.add('r');
      if (p.n === myName) li.classList.add('me');
      ul.appendChild(li);
    }
    if (m.more) { const li = document.createElement('li'); li.textContent = '+' + m.more + ' more'; ul.appendChild(li); }
  }

  function toggleReady() { if (mode !== 'lobby' || !net) return; myReady = !myReady; net.send({ t: 'ready', v: myReady }); const b = $('readyBtn'); b.classList.toggle('on', myReady); b.textContent = myReady ? 'READY ✓' : "I'M READY"; }
  $('readyBtn').addEventListener('click', e => { toggleReady(); e.currentTarget.blur(); });

  function onStart(m) {
    game = new T.Game(m.seed >>> 0);
    const now = performance.now();
    startAt = now + (m.countdown || 0);
    endAt = startAt + (m.duration || 180000);
    gameActive = true; rankInfo = null; floaters.length = 0;
    lastSnap = ''; sentScore = -1; sentAlive = true; pendingEv = null;
    mode = 'game'; show(null);
    sendSnap(true);
  }

  function onTick(m) {
    if (m.spectating || !game) {
      if (mode !== 'game' || !game) {
        if (mode !== 'wait') { mode = 'wait'; show('wait'); }
        $('waitText').textContent = `${m.alive} still alive · ${fmt(m.remaining)} left`;
      }
      return;
    }
    rankInfo = { rank: m.rank, total: m.total };
    if (m.phase === 'playing') endAt = performance.now() + m.remaining;
  }

  function onEnd(m) {
    if (game && game.active) { game.finished = true; sendSnap(true); }
    gameActive = false; game && game.releaseAll();
    mode = 'results'; show('results'); netWarn(false);
    const ol = $('resList'); ol.textContent = '';
    (m.top || []).forEach((r, i) => {
      const li = document.createElement('li');
      li.textContent = r.n; const sp = document.createElement('span'); sp.textContent = r.s.toLocaleString(); li.appendChild(sp);
      if (m.rank === i + 1) li.classList.add('me');
      ol.appendChild(li);
    });
    $('resYou').textContent = m.rank
      ? (m.rank === 1 ? '🏆 You won! ' : `You placed #${m.rank} of ${m.total}. `) + `Score: ${(m.score || 0).toLocaleString()}`
      : 'You watched this one — you\'re in next round.';
  }

  // ---------- input ----------
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'down', KeyS: 'down', ArrowUp: 'rotcw', KeyW: 'rotcw', KeyX: 'rotcw',
    KeyZ: 'rotccw', KeyQ: 'rotccw', Space: 'hard', KeyC: 'hold', Enter: 'hold', NumpadEnter: 'hold',
  };
  const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };

  addEventListener('keydown', e => {
    if (typing()) return;
    if (mode === 'lobby' && e.code === 'KeyR' && !e.repeat) { toggleReady(); return; }
    const a = KEYMAP[e.code];
    if (!a) return;
    if (mode === 'game' || mode === 'lobby') e.preventDefault();
    if (e.repeat || mode !== 'game' || !game || !gameActive || performance.now() < startAt) return;
    game.press(a);
  });
  addEventListener('keyup', e => {
    const a = KEYMAP[e.code];
    if (a && game) game.release(a);
  });
  addEventListener('blur', () => { if (game) game.releaseAll(); });

  // ---------- networking of the field ----------
  function sendSnap(force) {
    if (!game || !net) return;
    const b = game.snapshot(), alive = !game.over;
    if (!force && b === lastSnap && game.score === sentScore && alive === sentAlive && !pendingEv) return;
    net.send({ t: 'snap', b, s: game.score, l: game.lines, lv: game.level, a: alive, ev: pendingEv });
    lastSnap = b; sentScore = game.score; sentAlive = alive; pendingEv = null;
  }

  // ---------- main loop ----------
  const cv = $('cv'), ctx = cv.getContext('2d');
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(100, now - last); last = now;
    if (game && gameActive && now >= startAt && game.active) {
      game.update(dt);
      if (now >= endAt) { game.finished = true; game.releaseAll(); }
    }
    if (game && game.events.length) {
      for (const ev of game.events) { floaters.push({ text: ev.text, t: now, pts: ev.pts }); if (ev.big) pendingEv = ev.text; }
      game.events.length = 0;
    }
    if (game && gameActive && now - lastSnapAt >= 100) { lastSnapAt = now; sendSnap(false); }
    render(now);
    requestAnimationFrame(frame);
  }

  function font(px, w = 400) { return `${w} ${Math.round(px)}px 'Russo One', Inter, sans-serif`; }

  function render(now) {
    const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b0e1d'); g.addColorStop(1, '#05060c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    if (!game) { drawIdle(now, W, H); return; }

    const cell = Math.max(8, Math.floor(Math.min((H - 70) / 21, (W - 32) / 23)));
    const bw = cell * 10, bh = cell * 20;
    const ox = Math.round((W - cell * 23) / 2), oy = Math.round((H - bh) / 2 + cell * 0.4);
    const bx = ox + cell * 6.5, nx = bx + bw + cell * 1.5;

    // board frame
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx - 4, oy - 4, bw + 8, bh + 8);
    ctx.strokeStyle = 'rgba(180,76,255,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(bx - 4, oy - 4, bw + 8, bh + 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 1; x < 10; x++) { ctx.moveTo(bx + x * cell + .5, oy); ctx.lineTo(bx + x * cell + .5, oy + bh); }
    for (let y = 1; y < 20; y++) { ctx.moveTo(bx, oy + y * cell + .5); ctx.lineTo(bx + bw, oy + y * cell + .5); }
    ctx.stroke();

    const dim = game.over ? 0.35 : 1;
    for (let r = 0; r < 20; r++) for (let c = 0; c < 10; c++) {
      const v = game.board[(T.TOP + r) * T.COLS + c];
      if (v) T.drawCell(ctx, bx + c * cell, oy + r * cell, cell, v, dim);
    }
    if (game.piece && !game.over) {
      const code = T.TYPES.indexOf(game.piece.type) + 1;
      const gd = game.ghostDistance();
      if (!game.finished) for (const [x, y] of game.pieceCells(game.piece, gd)) if (y >= T.TOP) T.drawGhostCell(ctx, bx + x * cell, oy + (y - T.TOP) * cell, cell, code);
      for (const [x, y] of game.pieceCells()) if (y >= T.TOP) T.drawCell(ctx, bx + x * cell, oy + (y - T.TOP) * cell, cell, code, game.finished ? 0.5 : 1);
    }

    // hold
    label('HOLD', ox, oy - cell * 0.3, cell);
    box(ox, oy, cell * 5, cell * 3.4);
    T.drawPreview(ctx, game.hold, ox + cell * 2.5, oy + cell * 1.7, cell * 0.85, game.holdUsed ? 0.35 : 1);
    // next
    label('NEXT', nx, oy - cell * 0.3, cell);
    box(nx, oy, cell * 5, cell * 13.2);
    game.refill();
    for (let i = 0; i < 5; i++) T.drawPreview(ctx, game.queue[i], nx + cell * 2.5, oy + cell * (1.6 + i * 2.5), cell * (i === 0 ? 0.9 : 0.72));

    // stats
    const left = Math.max(0, endAt - now);
    stat('SCORE', game.score.toLocaleString(), ox, oy + cell * 5, cell, '#fff', 1.25);
    stat('LEVEL', game.level, ox, oy + cell * 8, cell);
    stat('LINES', game.lines, ox, oy + cell * 10.6, cell);
    stat('TIME', fmt(now < startAt ? endAt - startAt : left), nx, oy + cell * 14.6, cell, left < 15000 && now >= startAt ? '#ff6b7a' : '#fff');
    if (rankInfo) stat('RANK', '#' + rankInfo.rank + ' / ' + rankInfo.total, nx, oy + cell * 17.2, cell, rankInfo.rank === 1 ? '#ffd820' : '#fff');

    ctx.textAlign = 'center'; ctx.fillStyle = '#9aa3c7'; ctx.font = font(cell * 0.6);
    ctx.fillText(myName, bx + bw / 2, oy - cell * 0.35);

    // floaters
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i], age = (now - f.t) / 1400;
      if (age > 1) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - age * age;
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      const parts = f.text.split(' · ');
      parts.forEach((p, k) => { ctx.font = font(cell * (k === 0 ? 0.85 : 0.6)); ctx.fillText(p, bx + bw / 2, oy + bh * 0.38 - age * cell * 2 + k * cell * 0.85); });
      if (f.pts) { ctx.font = font(cell * 0.6); ctx.fillStyle = '#ffd820'; ctx.fillText('+' + f.pts.toLocaleString(), bx + bw / 2, oy + bh * 0.38 - age * cell * 2 + parts.length * cell * 0.85); }
      ctx.globalAlpha = 1;
    }

    // overlays
    if (now < startAt) {
      const s = Math.ceil((startAt - now) / 1000);
      banner(String(s), 'Get ready!', bx, oy, bw, bh, cell);
    } else if (now - startAt < 700 && game.active) {
      banner('GO!', '', bx, oy, bw, bh, cell);
    } else if (game.over) {
      banner('TOPPED OUT', 'Final score ' + game.score.toLocaleString(), bx, oy, bw, bh, cell, 0.6);
    } else if (game.finished) {
      banner('TIME!', 'Final score ' + game.score.toLocaleString(), bx, oy, bw, bh, cell, 0.75);
    }
  }

  function label(t, x, y, cell) { ctx.fillStyle = '#9aa3c7'; ctx.font = font(cell * 0.55); ctx.textAlign = 'left'; ctx.fillText(t, x, y); }
  function box(x, y, w, h) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1); }
  function stat(name, val, x, y, cell, color = '#fff', scale = 1) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#9aa3c7'; ctx.font = font(cell * 0.5); ctx.fillText(name, x, y);
    ctx.fillStyle = color; ctx.font = font(cell * 0.85 * scale); ctx.fillText(String(val), x, y + cell * 1.05 * scale);
  }
  function banner(big, small, bx, by, bw, bh, cell, scale = 1) {
    ctx.fillStyle = 'rgba(5,6,12,0.55)'; ctx.fillRect(bx, by + bh * 0.36, bw, cell * 3.6);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.font = font(cell * 1.8 * scale); ctx.fillText(big, bx + bw / 2, by + bh * 0.36 + cell * 2.1);
    if (small) { ctx.font = font(cell * 0.55); ctx.fillStyle = '#c9cff0'; ctx.fillText(small, bx + bw / 2, by + bh * 0.36 + cell * 3.1); }
  }

  // falling-pieces backdrop for menus
  const drops = Array.from({ length: 18 }, (_, i) => ({ x: Math.random(), y: Math.random(), v: 0.02 + Math.random() * 0.04, t: T.TYPES[i % 7], s: 14 + Math.random() * 18 }));
  function drawIdle(now, W, H) {
    for (const d of drops) {
      d.y += d.v / 60; if (d.y > 1.1) { d.y = -0.1; d.x = Math.random(); }
      T.drawPreview(ctx, d.t, d.x * W, d.y * H, d.s, 0.18);
    }
  }

  requestAnimationFrame(frame);
})();
