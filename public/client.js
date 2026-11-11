'use strict';

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const SIZE = 10;
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const LETTERS = ['А','Б','В','Г','Д','Е','Є','Ж','З','И'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = n => Math.floor(Math.random() * n);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= audio (WebAudio synth, no assets) ================= */
const AudioEngine = (() => {
  let ctx = null, master = null;
  let muted = localStorage.getItem('sb_mute') === '1';
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }
  function tone(f0, f1, dur, type = 'sine', vol = 0.3, delay = 0) {
    if (!ensure()) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, fc0, fc1, vol = 0.4, delay = 0, type = 'lowpass') {
    if (!ensure()) return;
    const t = ctx.currentTime + delay;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(fc0, t);
    if (fc1) f.frequency.exponentialRampToValueAtTime(Math.max(20, fc1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
  }
  const api = {
    unlock() { ensure(); },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      localStorage.setItem('sb_mute', muted ? '1' : '0');
      if (master) master.gain.value = muted ? 0 : 0.5;
      return muted;
    },
    click() { tone(700, 500, 0.05, 'square', 0.08); },
    fire() { noise(0.12, 4000, 800, 0.25, 0, 'highpass'); tone(300, 70, 0.15, 'sawtooth', 0.15); },
    miss() { noise(0.35, 900, 150, 0.3); tone(220, 90, 0.2, 'sine', 0.1, 0.03); },
    hit() { noise(0.4, 3500, 120, 0.5); tone(130, 35, 0.45, 'sine', 0.5); tone(90, 40, 0.3, 'square', 0.15, 0.02); },
    sunk() { api.hit(); noise(0.6, 2000, 60, 0.5, 0.12); tone(70, 28, 0.7, 'sine', 0.55, 0.1); },
    tick() { tone(1250, 1250, 0.04, 'square', 0.06); },
    notify() { tone(660, 660, 0.07, 'sine', 0.12); tone(880, 880, 0.09, 'sine', 0.12, 0.08); },
    win() { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, f, 0.22, 'triangle', 0.25, i * 0.12)); },
    lose() { [392, 311, 262, 196].forEach((f, i) => tone(f, f * 0.94, 0.3, 'sawtooth', 0.12, i * 0.16)); }
  };
  return api;
})();
document.addEventListener('pointerdown', () => AudioEngine.unlock(), { once: true });

/* ================= ambient sea background ================= */
(() => {
  const cv = $('#sea'), cx = cv.getContext('2d');
  let w, h, t = 0, parts = [];
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function initParts() {
    parts = Array.from({ length: 46 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 1 + Math.random() * 2.5, s: 6 + Math.random() * 14,
      ph: Math.random() * 6.28, a: 0.05 + Math.random() * 0.15
    }));
  }
  function draw(dt) {
    t += dt;
    cx.clearRect(0, 0, w, h);
    const layers = [
      { y: h * 0.82, a: 14, f: 0.008, sp: 0.5, c: 'rgba(25,227,194,0.05)' },
      { y: h * 0.88, a: 18, f: 0.006, sp: -0.35, c: 'rgba(46,168,255,0.06)' },
      { y: h * 0.94, a: 12, f: 0.010, sp: 0.8, c: 'rgba(25,227,194,0.07)' }
    ];
    for (const L of layers) {
      cx.beginPath(); cx.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) {
        cx.lineTo(x, L.y + Math.sin(x * L.f + t * L.sp) * L.a + Math.sin(x * L.f * 2.7 + t * L.sp * 1.6) * L.a * 0.4);
      }
      cx.lineTo(w, h); cx.closePath();
      cx.fillStyle = L.c; cx.fill();
    }
    for (const p of parts) {
      p.y -= p.s * dt; p.x += Math.sin(t + p.ph) * 0.15;
      if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, 6.283);
      cx.fillStyle = `rgba(140,220,255,${p.a})`; cx.fill();
    }
  }
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now; draw(dt);
    requestAnimationFrame(loop);
  }
  addEventListener('resize', () => { resize(); initParts(); if (reducedMotion) draw(0); });
  resize(); initParts();
  if (reducedMotion) draw(0); else requestAnimationFrame(loop);
})();

/* ================= FX: explosions / splashes / confetti ================= */
const FX = (() => {
  const cv = $('#fx'), cx = cv.getContext('2d');
  let w, h, parts = [], running = false, last = 0;
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize); resize();
  function start() {
    if (running || reducedMotion) return;
    running = true; last = performance.now();
    requestAnimationFrame(loop);
  }
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    cx.clearRect(0, 0, w, h);
    parts = parts.filter(p => p.life > 0);
    for (const p of parts) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; p.vx *= 0.99;
      const k = clamp(p.life / p.max, 0, 1);
      if (p.type === 'ring') {
        cx.beginPath(); cx.arc(p.x, p.y, p.r0 + (1 - k) * p.r1, 0, 6.283);
        cx.strokeStyle = p.c.replace('$', k.toFixed(2)); cx.lineWidth = 2.5 * k + 0.5; cx.stroke();
      } else if (p.type === 'confetti') {
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot += p.vr * dt);
        cx.fillStyle = p.c.replace('$', k.toFixed(2));
        cx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); cx.restore();
      } else {
        cx.beginPath(); cx.arc(p.x, p.y, p.s * k + 0.4, 0, 6.283);
        cx.fillStyle = p.c.replace('$', k.toFixed(2)); cx.fill();
      }
    }
    if (parts.length) requestAnimationFrame(loop);
    else { running = false; cx.clearRect(0, 0, w, h); }
  }
  function explode(x, y, big) {
    if (reducedMotion) return;
    parts.push({ type: 'ring', x, y, vx: 0, vy: 0, g: 0, r0: 4, r1: big ? 70 : 44, life: 0.5, max: 0.5, c: 'rgba(255,176,32,$)' });
    const n = big ? 42 : 24;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, sp = 40 + Math.random() * (big ? 220 : 150);
      parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, g: 260,
        s: 2 + Math.random() * 3.5, life: 0.5 + Math.random() * 0.5, max: 1,
        c: ['rgba(255,99,72,$)', 'rgba(255,176,32,$)', 'rgba(255,220,120,$)'][rand(3)]
      });
    }
    for (let i = 0; i < 8; i++) {
      parts.push({
        x: x + (Math.random() - 0.5) * 20, y: y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 30, vy: -30 - Math.random() * 40, g: -20,
        s: 5 + Math.random() * 7, life: 0.8, max: 0.8, c: 'rgba(120,140,160,$)'
      });
    }
    start();
  }
  function splash(x, y) {
    if (reducedMotion) return;
    parts.push({ type: 'ring', x, y, vx: 0, vy: 0, g: 0, r0: 3, r1: 34, life: 0.55, max: 0.55, c: 'rgba(25,227,194,$)' });
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6, sp = 50 + Math.random() * 90;
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 300, s: 1.5 + Math.random() * 2, life: 0.5, max: 0.5, c: 'rgba(120,220,255,$)' });
    }
    start();
  }
  function confetti() {
    if (reducedMotion) return;
    const cols = ['rgba(25,227,194,$)', 'rgba(46,168,255,$)', 'rgba(255,176,32,$)', 'rgba(255,77,94,$)', 'rgba(232,246,255,$)'];
    for (let i = 0; i < 140; i++) {
      parts.push({
        type: 'confetti', x: Math.random() * w, y: -20 - Math.random() * h * 0.3,
        vx: (Math.random() - 0.5) * 60, vy: 60 + Math.random() * 120, g: 40,
        s: 6 + Math.random() * 8, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 8,
        life: 2.5 + Math.random() * 2, max: 4, c: cols[rand(cols.length)]
      });
    }
    start();
  }
  return { explode, splash, confetti };
})();

/* ================= state / socket ================= */
const socket = io({ transports: ['websocket', 'polling'] });
let S = null, myIdx = null, prevPhase = null;
let session = null;
try { session = JSON.parse(sessionStorage.getItem('sb_session') || 'null'); } catch { session = null; }
let pendingFire = false, localTurnEnd = 0, timerPaused = false, lastTickSec = 0, dcUntil = 0;
let chatOpen = false, unread = 0, chatSig = '';
const urlJoin = (new URLSearchParams(location.search).get('join') || '').replace(/\D/g, '').slice(0, 4);
if (urlJoin.length === 4) $('#join-input').value = urlJoin;

function setConn(ok) {
  $('#conn').classList.toggle('off', !ok);
  $('#conn-text').textContent = ok ? 'онлайн' : 'офлайн';
}
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  $('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}
function shakeScreen() {
  const a = $('#app');
  a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake');
  setTimeout(() => a.classList.remove('shake'), 400);
}
function cellAt(el, x, y) { return el.querySelector(`[data-x="${x}"][data-y="${y}"]`); }
function cellCenter(el, x, y) {
  const c = cellAt(el, x, y);
  if (!c) return { x: innerWidth / 2, y: innerHeight / 2 };
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

socket.on('connect', () => {
  setConn(true);
  if (session) {
    socket.emit('rejoin', session, res => {
      if (!res || !res.ok) {
        toast(res && res.error ? res.error : 'Сесію втрачено');
        clearSession(); resetToLobby();
      }
    });
  } else if (urlJoin.length === 4) {
    joinWith(urlJoin);
  }
});
socket.on('disconnect', () => {
  setConn(false);
  if (session) $('#overlay-conn').classList.remove('hidden');
});
socket.on('connect_error', () => setConn(false));
socket.on('state', st => {
  $('#overlay-conn').classList.add('hidden');
  S = st; myIdx = st.you; pendingFire = false; lastTickSec = 0;
  timerPaused = st.turnMsLeft == null;
  if (!timerPaused) localTurnEnd = Date.now() + st.turnMsLeft;
  dcUntil = st.oppDisconnectMsLeft != null ? Date.now() + st.oppDisconnectMsLeft : 0;
  applyState();
});
socket.on('shot', onShot);
socket.on('chat', msg => {
  appendChat(msg);
  if (!chatOpen && !msg.system && msg.idx !== myIdx) { unread++; updateBadge(); }
  if (!msg.system && msg.idx !== myIdx) AudioEngine.notify();
});
socket.on('notice', n => toast(n.text));
socket.on('roomClosed', () => {
  toast('Кімнату закрито за неактивністю.');
  clearSession(); resetToLobby();
});

/* ================= screens ================= */
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  document.body.dataset.screen = name;
  if (name !== 'battle') { chatOpen = false; $('#chat').classList.remove('open'); }
}
function applyState() {
  const st = S;
  if (!st) return;
  $('#room-chip').classList.toggle('hidden', !st.code);
  $('#room-code').textContent = st.code || '----';
  if (st.phase === 'waiting') {
    showScreen('lobby');
    renderCodeDigits(st.code);
    $('#created').classList.remove('hidden');
    $('#btn-create').classList.add('hidden');
  } else if (st.phase === 'placing') {
    if (prevPhase && prevPhase !== 'placing') Placement.reset();
    showScreen('placement');
    Placement.sync(st);
  } else {
    showScreen('battle');
    renderBattle(st);
  }
  if (st.phase === 'finished' && prevPhase && prevPhase !== 'finished') {
    if (st.winner === myIdx) { AudioEngine.win(); FX.confetti(); }
    else AudioEngine.lose();
  }
  if (st.phase !== 'finished') $('#overlay-gameover').classList.add('hidden');
  prevPhase = st.phase;
}
function resetToLobby() {
  S = null; prevPhase = null; chatSig = ''; unread = 0; updateBadge();
  $('#overlay-gameover').classList.add('hidden');
  $('#overlay-conn').classList.add('hidden');
  $('#created').classList.add('hidden');
  $('#btn-create').classList.remove('hidden');
  $('#room-chip').classList.add('hidden');
  $('#join-input').value = '';
  Placement.reset();
  showScreen('lobby');
}
function clearSession() {
  sessionStorage.removeItem('sb_session');
  session = null;
}

/* ================= boards ================= */
function buildBoard(el, { onClick, onHover, onLeave, interactive = true } = {}) {
  el.innerHTML = '';
  const corner = document.createElement('div');
  corner.className = 'lbl corner';
  el.appendChild(corner);
  for (let x = 0; x < SIZE; x++) {
    const l = document.createElement('div');
    l.className = 'lbl'; l.textContent = LETTERS[x];
    el.appendChild(l);
  }
  for (let y = 0; y < SIZE; y++) {
    if (true) {
      const l = document.createElement('div');
      l.className = 'lbl'; l.textContent = y + 1;
      el.appendChild(l);
    }
    for (let x = 0; x < SIZE; x++) {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'cell';
      c.dataset.x = x; c.dataset.y = y;
      c.setAttribute('aria-label', `${LETTERS[x]}${y + 1}`);
      c.disabled = !interactive;
      if (onClick) c.addEventListener('click', () => onClick(x, y, c));
      if (onHover) c.addEventListener('pointerenter', () => onHover(x, y));
      el.appendChild(c);
    }
  }
  if (onLeave) el.addEventListener('pointerleave', onLeave);
}
function shapeClasses(b, x, y, id) {
  const same = (xx, yy) => xx >= 0 && xx < SIZE && yy >= 0 && yy < SIZE && b[yy][xx] === id;
  const h = same(x - 1, y) || same(x + 1, y);
  const v = same(x, y - 1) || same(x, y + 1);
  const cls = [];
  if (h) { cls.push('h'); if (!same(x - 1, y)) cls.push('start'); if (!same(x + 1, y)) cls.push('end'); }
  else if (v) { cls.push('v'); if (!same(x, y - 1)) cls.push('start'); if (!same(x, y + 1)) cls.push('end'); }
  else cls.push('solo');
  return cls;
}
function renderOwnBoard(el, board, received) {
  for (const c of el.querySelectorAll('.cell')) {
    const x = +c.dataset.x, y = +c.dataset.y, id = board[y][x];
    c.className = 'cell';
    if (id > 0) { c.classList.add('ship'); for (const cl of shapeClasses(board, x, y, id)) c.classList.add(cl); }
    if (received && received[y][x] === 1) c.classList.add(id > 0 ? 'hit' : 'miss');
  }
}
function renderEnemyBoard(el, view) {
  for (const c of el.querySelectorAll('.cell')) {
    const x = +c.dataset.x, y = +c.dataset.y, v = view[y][x];
    c.className = 'cell';
    c.disabled = v !== 0;
    if (v === 1) c.classList.add('miss');
    else if (v === 2) c.classList.add('hit');
    else if (v === 3) { c.classList.add('ship', 'sunk'); for (const cl of shapeClasses(view, x, y, 3)) c.classList.add(cl); }
  }
}

/* ================= placement ================= */
const Placement = (() => {
  const boardEl = $('#place-board');
  let placed = {}, sel = 0, dir = 'h', locked = false;
  const cellsOf = s => {
    const out = [];
    for (let k = 0; k < s.len; k++) out.push([s.dir === 'h' ? s.x + k : s.x, s.dir === 'v' ? s.y + k : s.y]);
    return out;
  };
  function grid() {
    const g = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    for (const k in placed) { const i = +k; cellsOf(placed[k]).forEach(([x, y]) => g[y][x] = i + 1); }
    return g;
  }
  function canPlace(s) {
    const g = grid();
    for (const [x, y] of cellsOf(s)) {
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return false;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && g[ny][nx] !== 0) return false;
      }
    }
    return true;
  }
  function firstFree() { for (let i = 0; i < FLEET.length; i++) if (!placed[i]) return i; return -1; }
  function renderDock() {
    const d = $('#dock');
    d.innerHTML = '';
    FLEET.forEach((len, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dock-ship' + (placed[i] ? ' placed' : '') + (sel === i ? ' sel' : '');
      item.disabled = locked;
      item.title = `${len}-палубний`;
      for (let k = 0; k < len; k++) {
        const c = document.createElement('span');
        c.className = 'dock-cell';
        item.appendChild(c);
      }
      item.addEventListener('click', () => {
        if (locked) return;
        AudioEngine.click();
        if (placed[i]) delete placed[i];
        sel = i;
        renderAll();
      });
      d.appendChild(item);
    });
  }
  function renderAll() {
    renderOwnBoard(boardEl, grid(), null);
    renderDock();
    const n = Object.keys(placed).length;
    $('#btn-ready').disabled = locked || n < FLEET.length;
    $('#btn-rotate').disabled = locked;
    $('#btn-auto').disabled = locked;
    $('#btn-clear').disabled = locked;
    $('#place-status').textContent = locked
      ? '✅ Флот готовий. Чекаємо на суперника…'
      : `${n}/10 кораблів розставлено · клікни по полю, щоб поставити обраний корабель`;
    $('#btn-rotate').textContent = dir === 'h' ? '↻ Горизонтально (R)' : '↻ Вертикально (R)';
  }
  function onCell(x, y) {
    if (locked) return;
    const id = grid()[y][x];
    if (id > 0) {
      const i = id - 1;
      delete placed[i]; sel = i;
      AudioEngine.click(); renderAll();
      return;
    }
    if (sel < 0 || placed[sel]) sel = firstFree();
    if (sel < 0) return;
    const s = { x, y, len: FLEET[sel], dir };
    if (canPlace(s)) {
      placed[sel] = s;
      AudioEngine.click();
      sel = firstFree();
      renderAll();
    } else {
      toast('Тут корабель поставити не можна — потрібен зазор у 1 клітинку');
      boardEl.classList.remove('shake-board'); void boardEl.offsetWidth; boardEl.classList.add('shake-board');
    }
  }
  function hover(x, y) {
    clearPreview();
    if (locked || sel < 0 || placed[sel]) return;
    const s = { x, y, len: FLEET[sel], dir };
    const ok = canPlace(s);
    for (const [cx, cy] of cellsOf(s)) {
      if (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE) cellAt(boardEl, cx, cy).classList.add(ok ? 'preview-ok' : 'preview-bad');
    }
  }
  function clearPreview() {
    boardEl.querySelectorAll('.preview-ok,.preview-bad').forEach(c => c.classList.remove('preview-ok', 'preview-bad'));
  }
  function rotate() { if (locked) return; dir = dir === 'h' ? 'v' : 'h'; AudioEngine.click(); renderAll(); }
  function auto() {
    if (locked) return;
    let success = false;
    for (let a = 0; a < 100 && !success; a++) {
      placed = {}; success = true;
      for (let i = 0; i < FLEET.length; i++) {
        const len = FLEET[i]; let ok = false;
        for (let t = 0; t < 300; t++) {
          const d = Math.random() < 0.5 ? 'h' : 'v';
          const s = { x: rand(d === 'h' ? SIZE - len + 1 : SIZE), y: rand(d === 'v' ? SIZE - len + 1 : SIZE), len, dir: d };
          if (canPlace(s)) { placed[i] = s; ok = true; break; }
        }
        if (!ok) { success = false; break; }
      }
    }
    sel = firstFree();
    AudioEngine.click();
    renderAll();
  }
  function clear() { if (locked) return; placed = {}; sel = 0; AudioEngine.click(); renderAll(); }
  function reset() { placed = {}; sel = 0; dir = 'h'; locked = false; renderAll(); }
  function sync(st) {
    locked = !!st.ready;
    $('#opp-place-status').innerHTML = st.oppPresent
      ? (st.oppReady ? '<span class="ok">✅ Суперник готовий</span>' : '<span class="wait">⏳ Суперник розставляє флот…</span>')
      : '';
    renderAll();
  }
  function submit() {
    const ships = Object.values(placed);
    if (ships.length !== FLEET.length) return;
    socket.emit('placeFleet', { ships }, res => { if (res && res.error) toast(res.error); });
  }
  return { onCell, hover, clearPreview, rotate, auto, clear, reset, sync, submit };
})();

/* ================= battle ================= */
function onEnemyClick(x, y) {
  if (!S || S.phase !== 'playing') return;
  if (S.turn !== myIdx) { toast('Зараз хід суперника'); return; }
  if (S.view[y][x] !== 0) return;
  if (pendingFire) return;
  pendingFire = true;
  socket.emit('fire', { x, y }, res => {
    if (res && res.error) { pendingFire = false; toast(res.error); }
  });
}
function onShot({ by, x, y, result }) {
  pendingFire = false;
  const mine = by === myIdx;
  const boardEl = mine ? $('#enemy-board') : $('#own-board');
  const { x: cx, y: cy } = cellCenter(boardEl, x, y);
  AudioEngine.fire();
  setTimeout(() => {
    if (result === 'miss') { FX.splash(cx, cy); AudioEngine.miss(); }
    else {
      FX.explode(cx, cy, result === 'sunk');
      AudioEngine[result]();
      if (!mine) shakeScreen();
    }
  }, 120);
}
function renderFleet(el, list) {
  el.innerHTML = '';
  const src = list.length ? list : FLEET.map(len => ({ len, sunk: false }));
  for (const s of src) {
    const d = document.createElement('span');
    d.className = 'fleet-ship' + (s.sunk ? ' sunk' : '');
    d.style.width = (s.len * 9) + 'px';
    d.title = `${s.len}-палубний${s.sunk ? ' · потоплений' : ''}`;
    el.appendChild(d);
  }
}
function renderBattle(st) {
  renderOwnBoard($('#own-board'), st.board, st.received);
  renderEnemyBoard($('#enemy-board'), st.view);
  const myTurn = st.phase === 'playing' && st.turn === myIdx;
  $('#enemy-board').classList.toggle('locked', !myTurn);
  const tb = $('#turn-banner');
  if (st.phase === 'finished') {
    tb.textContent = st.winner === myIdx ? '🏆 Перемога!' : '💥 Поразка';
    tb.className = 'turn-banner ' + (st.winner === myIdx ? 'win' : 'lose');
  } else if (myTurn) {
    tb.innerHTML = '🎯 ВАШ ХІД <span class="tb-sub">обери клітинку у ворожих водах</span>';
    tb.className = 'turn-banner mine';
  } else {
    tb.innerHTML = '⏳ ХІД СУПЕРНИКА <span class="dots"><i>.</i><i>.</i><i>.</i></span>';
    tb.className = 'turn-banner theirs';
  }
  renderFleet($('#enemy-fleet'), st.fleetOpp);
  renderFleet($('#own-fleet'), st.fleetYou);
  syncChat(st.chat);
  $('#opp-dc-banner').classList.toggle('hidden', !dcUntil);
  if (st.phase === 'finished') showGameOver(st);
}
function showGameOver(st) {
  const win = st.winner === myIdx;
  $('#go-emoji').textContent = win ? '🏆' : '💥';
  $('#go-title').textContent = win ? 'ПЕРЕМОГА!' : 'ПОРАЗКА';
  $('#go-title').className = win ? 'win' : 'lose';
  const reasons = {
    sunk: win ? 'Ворожий флот повністю знищено. Чиста робота, капітане!' : 'Ваш флот пішов на дно. Реванш усе виправить.',
    disconnect: win ? 'Суперник не відновив з’єднання вчасно — технічна перемога.' : 'Ви не відновили з’єднання вчасно — технічна поразка.',
    left: win ? 'Суперник покинув бій — перемога ваша.' : 'Ви покинули бій.'
  };
  $('#go-reason').textContent = reasons[st.reason] || '';
  const me = st.stats[myIdx];
  const acc = me.shots ? Math.round(me.hits / me.shots * 100) : 0;
  const shipsLeft = st.fleetYou.length ? st.fleetYou.filter(s => !s.sunk).length : '—';
  $('#go-stats').innerHTML =
    `<div><b>${me.shots}</b><span>пострілів</span></div>` +
    `<div><b>${acc}%</b><span>точність</span></div>` +
    `<div><b>${shipsLeft}/10</b><span>кораблів вціліло</span></div>`;
  const rm = $('#rematch-status');
  if (st.rematch[myIdx] && !st.rematch[1 - myIdx]) rm.textContent = '🔁 Реванш запропоновано. Чекаємо на суперника… (1/2)';
  else if (!st.rematch[myIdx] && st.rematch[1 - myIdx]) rm.textContent = 'Суперник хоче реванш! Прийміть виклик. (1/2)';
  else rm.textContent = '';
  $('#btn-rematch').disabled = !!st.rematch[myIdx];
  $('#overlay-gameover').classList.remove('hidden');
}

/* ================= chat ================= */
function chatNode(m) {
  const d = document.createElement('div');
  if (m.system) { d.className = 'msg sys'; d.textContent = m.text; return d; }
  d.className = 'msg ' + (m.idx === myIdx ? 'me' : 'opp');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = m.idx === myIdx ? 'Ви' : 'Гравець ' + (m.idx + 1);
  const t = document.createElement('span');
  t.className = 'txt';
  t.textContent = m.text;
  d.append(who, t);
  return d;
}
function syncChat(list) {
  const sig = list.length + ':' + (list.length ? list[list.length - 1].ts : 0);
  if (sig === chatSig) return;
  chatSig = sig;
  const log = $('#chat-log');
  log.innerHTML = '';
  list.forEach(m => log.appendChild(chatNode(m)));
  log.scrollTop = log.scrollHeight;
}
function appendChat(m) {
  const log = $('#chat-log');
  log.appendChild(chatNode(m));
  log.scrollTop = log.scrollHeight;
  chatSig = '';
}
function updateBadge() {
  const b = $('#chat-badge');
  b.textContent = unread;
  b.classList.toggle('hidden', unread === 0);
}
function toggleChat(force) {
  chatOpen = force !== undefined ? force : !chatOpen;
  $('#chat').classList.toggle('open', chatOpen);
  if (chatOpen) {
    unread = 0; updateBadge();
    const log = $('#chat-log');
    log.scrollTop = log.scrollHeight;
    $('#chat-input').focus();
  }
}

/* ================= timer & disconnect countdown ================= */
const RING = 119.4;
function setRing(frac) {
  $('#t-ring').style.strokeDashoffset = (RING * (1 - clamp(frac, 0, 1))).toFixed(1);
}
setInterval(() => {
  const timer = $('#timer');
  if (!S || S.phase !== 'playing' || timerPaused) {
    $('#t-num').textContent = '—';
    setRing(0);
    timer.classList.remove('warn', 'crit');
  } else {
    const left = Math.max(0, localTurnEnd - Date.now());
    const sec = Math.ceil(left / 1000);
    $('#t-num').textContent = sec;
    setRing(left / 30000);
    timer.classList.toggle('warn', sec <= 10 && sec > 5);
    timer.classList.toggle('crit', sec <= 5);
    if (sec <= 5 && sec > 0 && S.turn === myIdx && sec !== lastTickSec) {
      lastTickSec = sec;
      AudioEngine.tick();
    }
  }
  if (dcUntil) {
    const s = Math.max(0, Math.ceil((dcUntil - Date.now()) / 1000));
    $('#opp-dc-banner').textContent = `📡 Суперник втратив з'єднання. Якщо не повернеться за ${s} с — перемога ваша.`;
    if (s <= 0) dcUntil = 0;
  }
}, 100);

/* ================= lobby actions ================= */
function renderCodeDigits(code) {
  const el = $('#code-digits');
  el.innerHTML = '';
  String(code).split('').forEach(ch => {
    const s = document.createElement('span');
    s.className = 'code-digit';
    s.textContent = ch;
    el.appendChild(s);
  });
}
function saveSession(res) {
  session = { code: res.code, token: res.token };
  sessionStorage.setItem('sb_session', JSON.stringify(session));
  history.replaceState(null, '', location.pathname);
}
function joinWith(code) {
  if (session) return;
  socket.emit('joinRoom', { code }, res => {
    if (!res || res.error) { toast(res && res.error ? res.error : 'Не вдалося приєднатися'); return; }
    saveSession(res);
  });
}
$('#btn-create').addEventListener('click', () => {
  AudioEngine.click();
  $('#btn-create').disabled = true;
  socket.emit('createRoom', res => {
    $('#btn-create').disabled = false;
    if (!res || res.error) { toast(res && res.error ? res.error : 'Помилка'); return; }
    saveSession(res);
    renderCodeDigits(res.code);
    $('#created').classList.remove('hidden');
    $('#btn-create').classList.add('hidden');
  });
});
$('#btn-join').addEventListener('click', () => {
  const code = $('#join-input').value.trim();
  if (!/^\d{4}$/.test(code)) { toast('Введи 4 цифри коду'); return; }
  joinWith(code);
});
$('#join-input').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  if (e.target.value.length === 4) joinWith(e.target.value);
});
$('#btn-cancel').addEventListener('click', () => {
  socket.emit('leaveRoom');
  clearSession(); resetToLobby();
});
async function copyText(text, msg) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast(text); }
}
$('#btn-copy').addEventListener('click', () => copyText((session && session.code) || (S && S.code), 'Код скопійовано ⚓'));
$('#btn-copy-link').addEventListener('click', () => copyText(`${location.origin}/?join=${(session && session.code) || (S && S.code)}`, 'Посилання скопійовано 🔗'));
$('#copy-code').addEventListener('click', () => copyText((S && S.code) || (session && session.code), 'Код скопійовано ⚓'));

/* ================= controls ================= */
function renderSound() {
  const m = AudioEngine.muted;
  $('#sound-btn').textContent = m ? '🔇' : '🔊';
  $('#sound-btn').setAttribute('aria-pressed', String(!m));
  $('#sound-btn').classList.toggle('muted', m);
}
$('#sound-btn').addEventListener('click', () => {
  AudioEngine.toggle();
  renderSound();
  if (!AudioEngine.muted) AudioEngine.click();
});
$('#btn-rotate').addEventListener('click', () => Placement.rotate());
$('#btn-auto').addEventListener('click', () => Placement.auto());
$('#btn-clear').addEventListener('click', () => Placement.clear());
$('#btn-ready').addEventListener('click', () => Placement.submit());
$('#chat-toggle').addEventListener('click', () => { AudioEngine.click(); toggleChat(); });
$('#chat-close').addEventListener('click', () => toggleChat(false));
$('#chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('#chat-input');
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('chat', { text });
  inp.value = '';
});
$('#btn-rematch').addEventListener('click', () => {
  AudioEngine.click();
  socket.emit('rematch');
  $('#btn-rematch').disabled = true;
});
$('#btn-exit').addEventListener('click', () => {
  socket.emit('leaveRoom');
  clearSession(); resetToLobby();
});
$('#btn-surrender').addEventListener('click', () => {
  if (confirm('Здатися та вийти в лобі? Суперник отримає перемогу.')) {
    socket.emit('leaveRoom');
    clearSession(); resetToLobby();
  }
});
$('#brand').addEventListener('click', () => {
  if (S && (S.phase === 'playing' || S.phase === 'placing')) {
    if (confirm('Покинути поточний бій?')) {
      socket.emit('leaveRoom');
      clearSession(); resetToLobby();
    }
  }
});
document.addEventListener('keydown', e => {
  if (e.code === 'KeyR' && document.body.dataset.screen === 'placement' && document.activeElement.tagName !== 'INPUT') Placement.rotate();
  if (e.key === 'Escape' && chatOpen) toggleChat(false);
});
addEventListener('beforeunload', e => {
  if (S && (S.phase === 'playing' || S.phase === 'placing')) { e.preventDefault(); e.returnValue = ''; }
});

/* ================= init ================= */
buildBoard($('#place-board'), { onClick: Placement.onCell, onHover: Placement.hover, onLeave: Placement.clearPreview });
buildBoard($('#enemy-board'), { onClick: onEnemyClick });
buildBoard($('#own-board'), { interactive: false });
Placement.reset();
renderSound();
showScreen('lobby');
setConn(socket.connected);
