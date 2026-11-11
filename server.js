'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SIZE = 10;
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const TURN_MS = 30000;            // час на один хід
const GRACE_MS = 60000;           // час на перепідключення
const ROOM_TTL_MS = 15 * 60000;   // життя покинутої кімнати
const CHAT_MAX_LEN = 200;
const CHAT_HISTORY = 60;
const CHAT_COOLDOWN_MS = 600;

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

const now = () => Date.now();
const grid = v => Array.from({ length: SIZE }, () => Array(SIZE).fill(v));
const makeToken = () => crypto.randomBytes(16).toString('hex');

function newPlayer(socketId) {
  return {
    token: makeToken(), socketId, connected: true, ready: false,
    board: grid(0), ships: [], view: grid(0), received: grid(0),
    disconnectAt: null, forfeitTimer: null, lastChatAt: 0
  };
}

function newRoom(code, socketId) {
  return {
    code, phase: 'waiting', players: [newPlayer(socketId), null],
    turn: 0, turnEndsAt: 0, turnTimer: null, winner: null, reason: null,
    rematch: [false, false], chat: [],
    stats: [{ shots: 0, hits: 0 }, { shots: 0, hits: 0 }],
    createdAt: now(), lastActivity: now()
  };
}

function genCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  for (let c = 1000; c <= 9999; c++) {
    const s = String(c);
    if (!rooms.has(s)) return s;
  }
  return null;
}

function findPlayer(socketId) {
  for (const room of rooms.values()) {
    for (let i = 0; i < 2; i++) {
      const p = room.players[i];
      if (p && p.socketId === socketId) return { room, idx: i };
    }
  }
  return null;
}

function touch(room) { room.lastActivity = now(); }

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function armTurnTimer(room) {
  clearTurnTimer(room);
  room.turnEndsAt = now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.phase !== 'playing') return;
    room.turn = 1 - room.turn;
    notice(room, `⏱️ Час на хід вийшов. Хід переходить до Гравця ${room.turn + 1}.`);
    armTurnTimer(room);
    emitState(room);
  }, TURN_MS);
}

function trimChat(room) {
  if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
}

function notice(room, text) {
  const msg = { system: true, text, ts: now() };
  room.chat.push(msg);
  trimChat(room);
  io.to(room.code).emit('chat', msg);
  io.to(room.code).emit('notice', { text });
}

function stateFor(room, idx) {
  const me = room.players[idx];
  const opp = room.players[1 - idx];
  return {
    code: room.code, phase: room.phase, you: idx,
    board: me.board, received: me.received, view: me.view, ready: me.ready,
    oppPresent: !!opp, oppReady: !!(opp && opp.ready), oppConnected: !!(opp && opp.connected),
    oppDisconnectMsLeft: opp && !opp.connected && opp.disconnectAt
      ? Math.max(0, GRACE_MS - (now() - opp.disconnectAt)) : null,
    turn: room.turn,
    turnMsLeft: room.phase === 'playing' && room.turnTimer
      ? Math.max(0, room.turnEndsAt - now()) : null,
    winner: room.winner, reason: room.reason, rematch: room.rematch,
    stats: room.stats,
    fleetYou: me.ships.map(s => ({ len: s.len, sunk: s.hits === s.len })),
    fleetOpp: opp ? opp.ships.map(s => ({ len: s.len, sunk: s.hits === s.len })) : [],
    chat: room.chat
  };
}

function emitState(room) {
  room.players.forEach((p, i) => {
    if (p && p.connected && p.socketId) io.to(p.socketId).emit('state', stateFor(room, i));
  });
}

function validateFleet(input) {
  if (!Array.isArray(input) || input.length !== FLEET.length) return { error: 'Невірний склад флоту' };
  const lens = input.map(s => s && s.len).sort((a, b) => b - a);
  if (JSON.stringify(lens) !== JSON.stringify(FLEET)) return { error: 'Невірний склад флоту' };
  const board = grid(0);
  const ships = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    if (!s || !Number.isInteger(s.x) || !Number.isInteger(s.y) ||
        !Number.isInteger(s.len) || !['h', 'v'].includes(s.dir)) {
      return { error: 'Невірні дані корабля' };
    }
    const cells = [];
    for (let k = 0; k < s.len; k++) {
      const x = s.dir === 'h' ? s.x + k : s.x;
      const y = s.dir === 'v' ? s.y + k : s.y;
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return { error: 'Корабель за межами поля' };
      cells.push([x, y]);
    }
    for (const [x, y] of cells) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[ny][nx] !== 0) {
          return { error: 'Кораблі не можуть торкатися навіть кутами' };
        }
      }
    }
    const id = i + 1;
    for (const [x, y] of cells) board[y][x] = id;
    ships.push({ cells, len: s.len, hits: 0 });
  }
  return { board, ships };
}

function tryStart(room) {
  if (room.phase !== 'placing') return;
  if (!(room.players[0].ready && room.players[1] && room.players[1].ready)) return;
  room.phase = 'playing';
  room.turn = Math.random() < 0.5 ? 0 : 1;
  armTurnTimer(room);
  notice(room, `⚔️ Бій почався! Перший хід — Гравець ${room.turn + 1}.`);
}

function endGame(room, winner, reason) {
  clearTurnTimer(room);
  room.players.forEach(p => {
    if (p && p.forfeitTimer) { clearTimeout(p.forfeitTimer); p.forfeitTimer = null; }
  });
  room.phase = 'finished';
  room.winner = winner;
  room.reason = reason;
  room.rematch = [false, false];
  emitState(room);
}

function resetForRematch(room) {
  clearTurnTimer(room);
  room.phase = 'placing';
  room.winner = null;
  room.reason = null;
  room.rematch = [false, false];
  room.stats = [{ shots: 0, hits: 0 }, { shots: 0, hits: 0 }];
  room.players.forEach(p => {
    p.ready = false; p.board = grid(0); p.ships = []; p.view = grid(0); p.received = grid(0);
  });
  notice(room, '🔁 Реванш! Розставте кораблі для нового бою.');
}

function fire(room, idx, x, y) {
  if (room.phase !== 'playing') return 'Бій ще не триває';
  if (room.turn !== idx) return 'Зараз не ваш хід';
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= SIZE || y < 0 || y >= SIZE) return 'Невірна клітинка';
  const me = room.players[idx];
  const opp = room.players[1 - idx];
  if (me.view[y][x] !== 0) return 'Сюди вже стріляли';
  touch(room);
  room.stats[idx].shots++;
  opp.received[y][x] = 1;
  const shipId = opp.board[y][x];
  let result = 'miss';
  let shipCells = null;
  if (shipId > 0) {
    const ship = opp.ships[shipId - 1];
    ship.hits++;
    room.stats[idx].hits++;
    me.view[y][x] = 2;
    result = 'hit';
    if (ship.hits === ship.len) {
      result = 'sunk';
      shipCells = ship.cells;
      for (const [cx, cy] of ship.cells) me.view[cy][cx] = 3;
      for (const [cx, cy] of ship.cells) {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && me.view[ny][nx] === 0) {
            me.view[ny][nx] = 1;
          }
        }
      }
    }
  } else {
    me.view[y][x] = 1;
  }
  io.to(room.code).emit('shot', { by: idx, x, y, result, ship: shipCells });
  if (opp.ships.every(s => s.hits === s.len)) {
    endGame(room, idx, 'sunk');
    return null;
  }
  if (result === 'miss') room.turn = 1 - idx;
  armTurnTimer(room);
  emitState(room);
  return null;
}

function destroyRoom(room) {
  clearTurnTimer(room);
  room.players.forEach(p => { if (p && p.forfeitTimer) clearTimeout(p.forfeitTimer); });
  io.to(room.code).emit('roomClosed', { reason: 'expired' });
  rooms.delete(room.code);
}

function leaveRoom(socket) {
  const f = findPlayer(socket.id);
  if (!f) return;
  const { room, idx } = f;
  const p = room.players[idx];
  socket.leave(room.code);
  p.connected = false;
  p.socketId = null;
  if (room.phase === 'waiting') { destroyRoom(room); return; }
  if (room.phase === 'finished') { emitState(room); return; }
  endGame(room, 1 - idx, 'left');
  notice(room, `Гравець ${idx + 1} покинув гру.`);
}

function onDisconnect(socket) {
  const f = findPlayer(socket.id);
  if (!f) return;
  const { room, idx } = f;
  const p = room.players[idx];
  p.connected = false;
  p.socketId = null;
  p.disconnectAt = now();
  touch(room);
  if (room.phase === 'playing' || room.phase === 'placing') {
    clearTurnTimer(room);
    p.forfeitTimer = setTimeout(() => {
      p.forfeitTimer = null;
      if (!p.connected && (room.phase === 'playing' || room.phase === 'placing')) {
        endGame(room, 1 - idx, 'disconnect');
      }
    }, GRACE_MS);
    notice(room, `📡 Гравець ${idx + 1} втратив з'єднання. 60 секунд на відновлення…`);
  }
  emitState(room);
}

io.on('connection', socket => {
  socket.on('createRoom', cb => {
    leaveRoom(socket);
    const code = genCode();
    if (!code) return cb && cb({ error: 'Сервер переповнений, спробуйте пізніше' });
    const room = newRoom(code, socket.id);
    rooms.set(code, room);
    socket.join(code);
    cb && cb({ ok: true, code, token: room.players[0].token, idx: 0 });
    emitState(room);
  });

  socket.on('joinRoom', (data, cb) => {
    const code = String((data && data.code) || '').trim();
    if (!/^\d{4}$/.test(code)) return cb && cb({ error: 'Код має складатися з 4 цифр' });
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: 'Кімнату з таким кодом не знайдено' });
    if (room.players[1]) return cb && cb({ error: 'У цій кімнаті вже двоє гравців' });
    leaveRoom(socket);
    room.players[1] = newPlayer(socket.id);
    room.phase = 'placing';
    socket.join(code);
    touch(room);
    cb && cb({ ok: true, code, token: room.players[1].token, idx: 1 });
    notice(room, '🎯 Гравець 2 приєднався. Розставте кораблі!');
    emitState(room);
  });

  socket.on('rejoin', (data, cb) => {
    const code = String((data && data.code) || '');
    const tk = data && data.token;
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: 'Кімнату не знайдено (можливо, сервер перезапустився)' });
    const idx = room.players.findIndex(p => p && p.token === tk);
    if (idx < 0 || !tk) return cb && cb({ error: 'Сесію не знайдено' });
    const p = room.players[idx];
    if (p.forfeitTimer) { clearTimeout(p.forfeitTimer); p.forfeitTimer = null; }
    if (p.socketId && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) old.leave(room.code);
    }
    p.connected = true;
    p.socketId = socket.id;
    p.disconnectAt = null;
    socket.join(room.code);
    touch(room);
    if (room.phase === 'playing') armTurnTimer(room);
    cb && cb({ ok: true, code: room.code, idx, token: p.token });
    notice(room, `🔌 Гравець ${idx + 1} відновив з'єднання.`);
    emitState(room);
  });

  socket.on('placeFleet', (data, cb) => {
    const f = findPlayer(socket.id);
    if (!f) return cb && cb({ error: 'Ви не в кімнаті' });
    const { room, idx } = f;
    if (room.phase !== 'placing') return cb && cb({ error: 'Зараз не етап розстановки' });
    const p = room.players[idx];
    if (p.ready) return cb && cb({ error: 'Флот уже готовий' });
    const v = validateFleet(data && data.ships);
    if (v.error) return cb && cb({ error: v.error });
    p.board = v.board;
    p.ships = v.ships;
    p.ready = true;
    touch(room);
    cb && cb({ ok: true });
    notice(room, `Гравець ${idx + 1} готовий до бою.`);
    tryStart(room);
    emitState(room);
  });

  socket.on('fire', (data, cb) => {
    const f = findPlayer(socket.id);
    if (!f) return cb && cb({ error: 'Ви не в кімнаті' });
    const err = fire(room0(f), f.idx, data && data.x, data && data.y);
    function room0(ff) { return ff.room; }
    if (err) return cb && cb({ error: err });
    cb && cb({ ok: true });
  });

  socket.on('chat', data => {
    const f = findPlayer(socket.id);
    if (!f) return;
    const { room, idx } = f;
    const p = room.players[idx];
    const text = String((data && data.text) || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;
    if (now() - p.lastChatAt < CHAT_COOLDOWN_MS) return;
    p.lastChatAt = now();
    touch(room);
    const msg = { idx, text, ts: now() };
    room.chat.push(msg);
    trimChat(room);
    io.to(room.code).emit('chat', msg);
  });

  socket.on('rematch', () => {
    const f = findPlayer(socket.id);
    if (!f) return;
    const { room, idx } = f;
    if (room.phase !== 'finished') return;
    room.rematch[idx] = true;
    touch(room);
    if (room.rematch[0] && room.rematch[1]) resetForRematch(room);
    emitState(room);
  });

  socket.on('leaveRoom', () => leaveRoom(socket));
  socket.on('disconnect', () => onDisconnect(socket));
});

setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    const anyConnected = room.players.some(p => p && p.connected);
    const idle = t - room.lastActivity;
    if ((!anyConnected && idle > ROOM_TTL_MS) || idle > 60 * 60000) destroyRoom(room);
  }
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚓ Морський бій запущено на порті ${PORT}`);
});
