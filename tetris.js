/* Chat Plays Tetris – game engine following the Tetris Guideline:
 * SRS rotation + wall kicks, 7-bag randomizer, hold (once per piece), ghost piece,
 * 5-piece preview, 0.5 s lock delay with 15 move resets, guideline gravity curve,
 * fixed-goal levelling (10 lines / level) and guideline scoring
 * (T-spins, mini T-spins, back-to-back x1.5, combos, perfect clears, soft/hard drop). */
(function (root) {
  'use strict';

  const COLS = 10, ROWS = 40, VISIBLE = 20, TOP = ROWS - VISIBLE;
  const TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
  // index = cell code (1..7 match TYPES order)
  const COLORS = [null, '#1fd6f5', '#3c6cff', '#ff9022', '#ffd820', '#44e05c', '#b44cff', '#ff3d50'];
  const DAS = 167, ARR = 33, LOCK_DELAY = 500, MAX_RESETS = 15, SOFT_DROP_FACTOR = 20;

  const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    O: [[1, 1], [1, 1]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  };
  const rotCW = m => m.map((row, i) => row.map((_, j) => m[m.length - 1 - j][i]));
  const CELLS = {}; // CELLS[type][rotation] = [[x, y], ...]
  for (const t of TYPES) {
    let m = SHAPES[t];
    CELLS[t] = [];
    for (let r = 0; r < 4; r++) {
      const c = [];
      m.forEach((row, y) => row.forEach((v, x) => { if (v) c.push([x, y]); }));
      CELLS[t].push(c);
      m = rotCW(m);
    }
  }

  // SRS kick tables, (x, y) with y pointing UP as in the guideline docs.
  const KICK_JLSTZ = {
    '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  };
  const KICK_I = {
    '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  };

  function gravityMs(level) {
    const l = Math.min(level, 20);
    return Math.pow(0.8 - (l - 1) * 0.007, l - 1) * 1000;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Game {
    constructor(seed) {
      this.rand = mulberry32(seed >>> 0);
      this.board = new Uint8Array(COLS * ROWS);
      this.bag = []; this.queue = [];
      this.score = 0; this.lines = 0; this.level = 1;
      this.combo = -1; this.b2b = false;
      this.hold = null; this.holdUsed = false;
      this.over = false; this.finished = false;
      this.held = { left: false, right: false, down: false };
      this.dasDir = 0; this.dasTimer = 0; this.arrAcc = 0;
      this.gravAcc = 0; this.lockTimer = 0; this.lockResets = 0; this.lowestY = 0;
      this.lastAction = null; this.lastKick = 0;
      this.events = []; // {text, big} for UI
      this.piece = null;
      this.spawn();
    }

    refill() {
      while (this.queue.length < 7) {
        if (!this.bag.length) {
          this.bag = TYPES.slice();
          for (let i = 6; i > 0; i--) {
            const j = Math.floor(this.rand() * (i + 1));
            const t = this.bag[i]; this.bag[i] = this.bag[j]; this.bag[j] = t;
          }
        }
        this.queue.push(this.bag.pop());
      }
    }

    get active() { return !this.over && !this.finished; }

    collides(type, x, y, r) {
      for (const [cx, cy] of CELLS[type][r]) {
        const X = x + cx, Y = y + cy;
        if (X < 0 || X >= COLS || Y >= ROWS) return true;
        if (Y >= 0 && this.board[Y * COLS + X]) return true;
      }
      return false;
    }

    pieceCells(p = this.piece, dy = 0) {
      return CELLS[p.type][p.r].map(([cx, cy]) => [p.x + cx, p.y + cy + dy]);
    }

    grounded() { const p = this.piece; return this.collides(p.type, p.x, p.y + 1, p.r); }

    ghostDistance() {
      const p = this.piece; let d = 0;
      while (!this.collides(p.type, p.x, p.y + d + 1, p.r)) d++;
      return d;
    }

    spawn(type) {
      if (!type) { this.refill(); type = this.queue.shift(); }
      this.refill();
      const p = { type, r: 0, x: type === 'O' ? 4 : 3, y: TOP - 2 };
      this.piece = p;
      this.lockTimer = 0; this.lockResets = 0; this.gravAcc = 0; this.lastAction = null; this.lastKick = 0;
      if (this.collides(type, p.x, p.y, p.r)) { this.gameOver(); return; } // block out
      if (!this.collides(type, p.x, p.y + 1, p.r)) p.y++;               // guideline: drop one row on spawn
      this.lowestY = p.y;
    }

    gameOver() { this.over = true; this.events.push({ text: 'TOP OUT', big: false }); }

    afterMove(kind) {
      const p = this.piece;
      this.lastAction = kind;
      if (p.y > this.lowestY) { this.lowestY = p.y; this.lockResets = 0; this.lockTimer = 0; }
      else if (kind !== 'drop' && (this.lockTimer > 0 || this.grounded()) && this.lockResets < MAX_RESETS) {
        this.lockTimer = 0; this.lockResets++;
      }
    }

    move(dx, dy = 0) {
      const p = this.piece;
      if (this.collides(p.type, p.x + dx, p.y + dy, p.r)) return false;
      p.x += dx; p.y += dy;
      this.afterMove(dy ? 'drop' : 'move');
      return true;
    }

    rotate(dir) { // 1 = clockwise, -1 = counter-clockwise
      const p = this.piece;
      if (p.type === 'O') return false;
      const to = (p.r + dir + 4) % 4;
      const table = (p.type === 'I' ? KICK_I : KICK_JLSTZ)['' + p.r + to];
      for (let i = 0; i < table.length; i++) {
        const nx = p.x + table[i][0], ny = p.y - table[i][1];
        if (!this.collides(p.type, nx, ny, to)) {
          p.x = nx; p.y = ny; p.r = to; this.lastKick = i;
          this.afterMove('rotate');
          return true;
        }
      }
      return false;
    }

    hardDrop() {
      const d = this.ghostDistance();
      this.piece.y += d;
      this.score += d * 2;
      if (d > 0) this.lastAction = 'drop';
      this.lock();
    }

    doHold() {
      if (this.holdUsed) return;
      const t = this.piece.type;
      if (this.hold) { const h = this.hold; this.hold = t; this.spawn(h); }
      else { this.hold = t; this.spawn(); }
      this.holdUsed = true;
    }

    tSpinKind() { // 0 none, 1 mini, 2 full (3-corner rule)
      const p = this.piece;
      const occ = (x, y) => {
        const X = p.x + x, Y = p.y + y;
        return X < 0 || X >= COLS || Y >= ROWS || (Y >= 0 && this.board[Y * COLS + X] !== 0);
      };
      const c = [occ(0, 0), occ(2, 0), occ(2, 2), occ(0, 2)]; // TL TR BR BL
      if (c.filter(Boolean).length < 3) return 0;
      const front = [[0, 1], [1, 2], [2, 3], [3, 0]][p.r];
      if ((c[front[0]] && c[front[1]]) || this.lastKick === 4) return 2;
      return 1;
    }

    lock() {
      const p = this.piece;
      const tspin = (p.type === 'T' && this.lastAction === 'rotate') ? this.tSpinKind() : 0;
      const code = TYPES.indexOf(p.type) + 1;
      let allAbove = true;
      for (const [x, y] of this.pieceCells()) {
        if (y >= 0) this.board[y * COLS + x] = code;
        if (y >= TOP) allAbove = false;
      }
      // clear full rows
      let cleared = 0;
      for (let y = ROWS - 1; y >= 0;) {
        let full = true;
        for (let x = 0; x < COLS; x++) if (!this.board[y * COLS + x]) { full = false; break; }
        if (full) {
          this.board.copyWithin(COLS, 0, y * COLS);
          this.board.fill(0, 0, COLS);
          cleared++;
        } else y--;
      }

      const L = this.level;
      const base = tspin === 2 ? [400, 800, 1200, 1600][cleared]
        : tspin === 1 ? [100, 200, 400, 400][cleared]
          : [0, 100, 300, 500, 800][cleared];
      let pts = base * L;
      const labels = [];
      if (tspin) labels.push((tspin === 1 ? 'MINI T-SPIN' : 'T-SPIN') + ['', ' SINGLE', ' DOUBLE', ' TRIPLE'][cleared]);
      else if (cleared) labels.push(['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'][cleared]);

      const wasB2B = this.b2b;
      if (cleared > 0) {
        const difficult = cleared === 4 || tspin > 0;
        if (difficult && wasB2B) { pts = Math.floor(pts * 1.5); labels.push('BACK-TO-BACK'); }
        this.b2b = difficult;
        this.combo++;
        if (this.combo > 0) { pts += 50 * this.combo * L; labels.push('COMBO ×' + this.combo); }
        let empty = true;
        for (let i = 0; i < this.board.length; i++) if (this.board[i]) { empty = false; break; }
        if (empty) {
          pts += ((cleared === 4 && wasB2B) ? 3200 : [0, 800, 1200, 1800, 2000][cleared]) * L;
          labels.push('PERFECT CLEAR');
        }
      } else {
        this.combo = -1;
      }
      this.score += pts;
      this.lines += cleared;
      const newLevel = Math.floor(this.lines / 10) + 1;
      if (newLevel > this.level) labels.push('LEVEL ' + newLevel);
      this.level = newLevel;

      if (labels.length) {
        const big = cleared >= 2 || tspin > 0 || this.combo >= 2 || labels.includes('PERFECT CLEAR');
        this.events.push({ text: labels.join(' · '), big, pts });
      }

      this.holdUsed = false;
      if (allAbove && cleared === 0) { this.gameOver(); return; } // lock out
      this.spawn();
    }

    // ---- input ----
    press(a) {
      if (!this.active) return;
      switch (a) {
        case 'left': this.held.left = true; this.dasDir = -1; this.dasTimer = 0; this.arrAcc = 0; this.move(-1); break;
        case 'right': this.held.right = true; this.dasDir = 1; this.dasTimer = 0; this.arrAcc = 0; this.move(1); break;
        case 'down': this.held.down = true; if (this.move(0, 1)) this.score += 1; this.gravAcc = 0; break;
        case 'rotcw': this.rotate(1); break;
        case 'rotccw': this.rotate(-1); break;
        case 'hard': this.hardDrop(); break;
        case 'hold': this.doHold(); break;
      }
    }

    release(a) {
      if (a === 'left') {
        this.held.left = false;
        if (this.dasDir === -1) { this.dasDir = this.held.right ? 1 : 0; this.dasTimer = 0; this.arrAcc = 0; }
      } else if (a === 'right') {
        this.held.right = false;
        if (this.dasDir === 1) { this.dasDir = this.held.left ? -1 : 0; this.dasTimer = 0; this.arrAcc = 0; }
      } else if (a === 'down') this.held.down = false;
    }

    releaseAll() { this.held = { left: false, right: false, down: false }; this.dasDir = 0; }

    update(dt) {
      if (!this.active) return;
      dt = Math.min(dt, 100);
      // auto-shift
      if (this.dasDir) {
        const before = this.dasTimer;
        this.dasTimer += dt;
        if (this.dasTimer >= DAS) {
          if (before < DAS) { this.arrAcc = this.dasTimer - DAS; this.move(this.dasDir); }
          else this.arrAcc += dt;
          while (this.arrAcc >= ARR) {
            this.arrAcc -= ARR;
            if (!this.move(this.dasDir)) { this.arrAcc = 0; break; }
          }
        }
      }
      // gravity / soft drop
      let rate = 1 / gravityMs(this.level);
      const soft = this.held.down;
      if (soft) rate *= SOFT_DROP_FACTOR;
      this.gravAcc += dt * rate;
      while (this.gravAcc >= 1) {
        this.gravAcc -= 1;
        if (this.move(0, 1)) { if (soft) this.score += 1; }
        else { this.gravAcc = 0; break; }
      }
      // lock delay
      if (this.grounded()) {
        this.lockTimer += dt;
        if (this.lockTimer >= LOCK_DELAY) this.lock();
      }
    }

    // 200-char string of the visible field (active piece merged) for the overlay
    snapshot() {
      const v = Array.from(this.board.subarray(TOP * COLS));
      if (this.piece && !this.over) {
        const code = TYPES.indexOf(this.piece.type) + 1;
        for (const [x, y] of this.pieceCells()) if (y >= TOP) v[(y - TOP) * COLS + x] = code;
      }
      return v.join('');
    }
  }

  // ---- drawing helpers shared by player page and overlay ----
  function drawCell(ctx, x, y, s, code, alpha = 1) {
    if (!code) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS[code];
    ctx.fillRect(x, y, s, s);
    if (s >= 6) {
      const b = Math.max(1, Math.round(s * 0.13));
      ctx.fillStyle = 'rgba(255,255,255,0.38)';
      ctx.fillRect(x, y, s, b); ctx.fillRect(x, y, b, s);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(x, y + s - b, s, b); ctx.fillRect(x + s - b, y, b, s);
    }
    ctx.globalAlpha = 1;
  }

  function drawGhostCell(ctx, x, y, s, code) {
    ctx.globalAlpha = 0.22; ctx.fillStyle = COLORS[code]; ctx.fillRect(x, y, s, s);
    ctx.globalAlpha = 0.7; ctx.strokeStyle = COLORS[code]; ctx.lineWidth = Math.max(1, s * 0.08);
    const o = ctx.lineWidth / 2; ctx.strokeRect(x + o, y + o, s - ctx.lineWidth, s - ctx.lineWidth);
    ctx.globalAlpha = 1;
  }

  // draws a piece centred at (cx, cy)
  function drawPreview(ctx, type, cx, cy, s, alpha = 1) {
    if (!type) return;
    const cells = CELLS[type][0];
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = (maxX - minX + 1) * s, h = (maxY - minY + 1) * s;
    const code = TYPES.indexOf(type) + 1;
    for (const [x, y] of cells) drawCell(ctx, cx - w / 2 + (x - minX) * s, cy - h / 2 + (y - minY) * s, s, code, alpha);
  }

  root.Tetris = { Game, COLS, ROWS, VISIBLE, TOP, TYPES, COLORS, CELLS, drawCell, drawGhostCell, drawPreview, gravityMs, mulberry32 };
})(typeof window !== 'undefined' ? window : globalThis);
