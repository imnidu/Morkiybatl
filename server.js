'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SIZE = 10;
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const TURN_MS = 30000;
const GRACE_MS = 60000;
const ROOM_TTL_MS = 15 * 60000;
const CHAT_MAX_LEN = 200;
const CHAT_HISTORY = 60;
const CHAT_COOLDOWN_MS = 600;
const MATCH_HISTORY = 500;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

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

/* ================= storage ================= */

function emptyStore() {
  return { accounts: {}, matches: [] };
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyStore();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
      matches: Array.isArray(data.matches) ? data.matches : []
    };
  } catch {
    return emptyStore();
  }
}

let store = loadStore();
let saveTimer = null;

function saveStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('Помилка збереження даних:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStore();
  }, 250);
}

process.on('SIGTERM', () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveStore();
  process.exit(0);
});

/* ================= accounts ================= */

function cleanNickname(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeNickname(value) {
  return cleanNickname(value).toLowerCase();
}

function validNickname(value) {
  const nick = cleanNickname(value);
  return nick.length >= 2 && nick.length <= 18 && /^[\p{L}\p{N} _.\-]+$/u.test(nick);
}

function publicAccount(acc) {
  if (!acc) return null;
  return { id: acc.id, nickname: acc.nickname, createdAt: acc.createdAt };
}

function loginAccount(nickname) {
  const nick = cleanNickname(nickname);
  const id = normalizeNickname(nick);
  if (!validNickname(nick)) return { error: 'Нікнейм: 2–18 символів, літери, цифри, пробіл, _ . -' };

  let acc = store.accounts[id];
  if (!acc) {
    acc = {
      id,
      nickname: nick,
      createdAt: now(),
      lastSeen: now()
    };
    store.accounts[id] = acc;
  } else {
    acc.nickname = nick;
    acc.lastSeen = now();
  }

  scheduleSave();
  return { account: publicAccount(acc) };
}

function matchesForAccount(accountId) {
  return store.matches.filter(m => m.players.some(p => p.accountId === accountId));
}

function accountStats(accountId) {
  const acc = store.accounts[accountId];
  if (!acc) return null;

  const list = matchesForAccount(accountId);
  let wins = 0;
  let losses = 0;
  const rivals = new Map();

  for (const m of list) {
    const me = m.players.find(p => p.accountId === accountId);
    const opp = m.players.find(p => p.accountId !== accountId);
    if (!me || !opp) continue;

    if (m.winnerId === accountId) wins++;
    else losses++;

    const r = rivals.get(opp.accountId) || {
      accountId: opp.accountId,
      nickname: opp.nickname,
      wins: 0,
      losses: 0,
      lastPlayedAt: 0
    };

    if (m.winnerId === accountId) r.wins++;
    else r.losses++;

    r.nickname = opp.nickname;
    r.lastPlayedAt = Math.max(r.lastPlayedAt, m.finishedAt);
    rivals.set(opp.accountId, r);
  }

  const total = wins + losses;
  return {
    account: publicAccount(acc),
    wins,
    losses,
    total,
    winrate: total ? Math.round((wins / total) * 100) : 0,
    rivals: [...rivals.values()].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 8),
    matches: list.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 12)
  };
}

function seriesBetween(a, b) {
  let you = 0;
  let opp = 0;

  for (const m of store.matches) {
    const ids = m.players.map(p => p.accountId);
    if (!ids.includes(a) || !ids.includes(b)) continue;
    if (m.winnerId === a) you++;
    else if (m.winnerId === b) opp++;
  }

  return { you, opp, total: you + opp };
}

function recordMatch(room, winnerIdx, reason) {
  if (room.matchSaved) return;
  const p0 = room.players[0];
  const p1 = room.players[1];
  if (!p0 || !p1 || !p0.accountId || !p1.accountId) return;
  if (p0.accountId === p1.accountId) return;
  if (!room.startedAt) return;

  const winner = room.players[winnerIdx];
  const match = {
    id: makeToken(),
    code: room.code,
    reason,
    startedAt: room.startedAt,
    finishedAt: now(),
    durationMs: now() - room.startedAt,
    winnerId: winner.accountId,
    players: room.players.map((p, i) => ({
      accountId: p.accountId,
      nickname: p.nickname,
      shots: room.stats[i].shots,
      hits: room.stats[i].hits,
      shipsLeft: p.ships.filter(s => s.hits < s.len).length
    }))
  };

  store.matches.push(match);
  if (store.matches.length > MATCH_HISTORY) {
    store.matches.splice(0, store.matches.length - MATCH_HISTORY);
  }

  room.matchSaved = true;
  room.lastMatchId = match.id;
  scheduleSave();
}

/* ================= game ================= */

function newPlayer(socketId, account) {
  return {
    token: makeToken(),
    socketId,
    connected: true,
    ready: false,
    accountId: account ? account.id : null,
    nickname: account ? account.nickname : null,
    board: grid(0),
    ships: [],
    view: grid(0),
    received: grid(0),
    disconnectAt: null,
    forfeitTimer: null,
    lastChatAt: 0
  };
}

function newRoom(code, socketId, account) {
  return {
    code,
    phase: 'waiting',
    players: [newPlayer(socketId, account), null],
    turn: 0,
    turnEndsAt: 0,
    turnTimer: null,
    winner: null,
    reason: null,
    rematch: [false, false],
    chat: [],
    stats: [{ shots: 0, hits: 0 }, { shots: 0, hits: 0 }],
    createdAt: now(),
    startedAt: null,
    lastActivity: now(),
    matchSaved: false,
    lastMatchId: null
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

function touch(room) {
  room.lastActivity = now();
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
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
  if (room.chat.length > CHAT_HISTORY) {
    room.chat.splice(0, room.chat.length - CHAT_HISTORY);
  }
}

function playerName(room, idx) {
  const p = room.players[idx];
  return p && p.nickname ? p.nickname : `Гравець ${idx + 1}`;
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

  let series = null;
  if (room.phase === 'finished' && me.accountId && opp && opp.accountId && me.accountId !== opp.accountId) {
    series = seriesBetween(me.accountId, opp.accountId);
  }

  return {
    code: room.code,
    phase: room.phase,
    you: idx,
    board: me.board,
    received: me.received,
    view: me.view,
    ready: me.ready,
    youAccount: me.accountId ? { id: me.accountId, nickname: me.nickname } : null,
    oppAccount: opp && opp.accountId ? { id: opp.accountId, nickname: opp.nickname } : null,
    oppPresent: !!opp,
    oppReady: !!(opp && opp.ready),
    oppConnected: !!(opp && opp.connected),
    oppDisconnectMsLeft: opp && !opp.connected && opp.disconnectAt
      ? Math.max(0, GRACE_MS - (now() - opp.disconnectAt))
      : null,
    turn: room.turn,
    turnMsLeft: room.phase === 'playing' && room.turnTimer
      ? Math.max(0, room.turnEndsAt - now())
      : null,
    winner: room.winner,
    reason: room.reason,
    rematch: room.rematch,
    stats: room.stats,
    series,
    matchId: room.lastMatchId,
    fleetYou: me.ships.map(s => ({ len: s.len, sunk: s.hits === s.len })),
    fleetOpp: opp ? opp.ships.map(s => ({ len: s.len, sunk: s.hits === s.len })) : [],
    oppBoard: room.phase === 'finished' && opp ? opp.board : null,
    chat: room.chat
  };
}

function emitState(room) {
  room.players.forEach((p, i) => {
    if (p && p.connected && p.socketId) {
      io.to(p.socketId).emit('state', stateFor(room, i));
    }
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
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[ny][nx] !== 0) {
            return { error: 'Кораблі не можуть торкатися навіть кутами' };
          }
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
  room.startedAt = now();
  room.turn = Math.random() < 0.5 ? 0 : 1;
  armTurnTimer(room);
  notice(room, `⚔️ Бій почався! Перший хід — ${playerName(room, room.turn)}.`);
}

function endGame(room, winner, reason) {
  if (room.phase === 'finished') return;

  clearTurnTimer(room);
  room.players.forEach(p => {
    if (p && p.forfeitTimer) {
      clearTimeout(p.forfeitTimer);
      p.forfeitTimer = null;
    }
  });

  room.phase = 'finished';
  room.winner = winner;
  room.reason = reason;
  room.rematch = [false, false];

  recordMatch(room, winner, reason);
  emitState(room);
}

function resetForRematch(room) {
  clearTurnTimer(room);
  room.phase = 'placing';
  room.winner = null;
  room.reason = null;
  room.rematch = [false, false];
  room.stats = [{ shots: 0, hits: 0 }, { shots: 0, hits: 0 }];
  room.startedAt = null;
  room.matchSaved = false;
  room.lastMatchId = null;

  room.players.forEach(p => {
    p.ready = false;
    p.board = grid(0);
    p.ships = [];
    p.view = grid(0);
    p.received = grid(0);
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
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && me.view[ny][nx] === 0) {
              me.view[ny][nx] = 1;
            }
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
  room.players.forEach(p => {
    if (p && p.forfeitTimer) clearTimeout(p.forfeitTimer);
  });
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

  if (room.phase === 'waiting') {
    destroyRoom(room);
    return;
  }

  if (room.phase === 'finished') {
    emitState(room);
    return;
  }

  endGame(room, 1 - idx, 'left');
  notice(room, `${playerName(room, idx)} покинув гру.`);
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

    notice(room, `📡 ${playerName(room, idx)} втратив з'єднання. 60 секунд на відновлення…`);
  }

  emitState(room);
}

function attachAccountToPlayer(socket) {
  const f = findPlayer(socket.id);
  if (!f) return;
  const p = f.room.players[f.idx];
  const acc = socket.data.account || null;
  p.accountId = acc ? acc.id : null;
  p.nickname = acc ? acc.nickname : null;
  emitState(f.room);
}

/* ================= sockets ================= */

io.on('connection', socket => {
  socket.data.account = null;

  socket.on('account:login', (data, cb) => {
    const result = loginAccount(data && data.nickname);
    if (result.error) return cb && cb({ error: result.error });

    socket.data.account = result.account;
    attachAccountToPlayer(socket);
    cb && cb({ ok: true, account: result.account, stats: accountStats(result.account.id) });
  });

  socket.on('account:logout', cb => {
    socket.data.account = null;
    attachAccountToPlayer(socket);
    cb && cb({ ok: true });
  });

  socket.on('account:stats', cb => {
    const acc = socket.data.account;
    if (!acc) return cb && cb({ error: 'Ви не в акаунті' });
    cb && cb({ ok: true, stats: accountStats(acc.id) });
  });

  socket.on('createRoom', cb => {
    leaveRoom(socket);
    const code = genCode();
    if (!code) return cb && cb({ error: 'Сервер переповнений, спробуйте пізніше' });

    const room = newRoom(code, socket.id, socket.data.account);
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

    const acc = socket.data.account;
    if (acc && room.players[0].accountId === acc.id) {
      return cb && cb({ error: 'Не можна приєднатися до власної кімнати з того самого акаунта' });
    }

    leaveRoom(socket);
    room.players[1] = newPlayer(socket.id, acc);
    room.phase = 'placing';
    socket.join(code);
    touch(room);

    cb && cb({ ok: true, code, token: room.players[1].token, idx: 1 });
    notice(room, `🎯 ${playerName(room, 1)} приєднався. Розставте кораблі!`);
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
    if (p.forfeitTimer) {
      clearTimeout(p.forfeitTimer);
      p.forfeitTimer = null;
    }

    if (p.socketId && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) old.leave(room.code);
    }

    p.connected = true;
    p.socketId = socket.id;
    p.disconnectAt = null;

    if (socket.data.account) {
      p.accountId = socket.data.account.id;
      p.nickname = socket.data.account.nickname;
    }

    socket.join(room.code);
    touch(room);
    if (room.phase === 'playing') armTurnTimer(room);

    cb && cb({ ok: true, code: room.code, idx, token: p.token });
    notice(room, `🔌 ${playerName(room, idx)} відновив з'єднання.`);
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
    notice(room, `${playerName(room, idx)} готовий до бою.`);
    tryStart(room);
    emitState(room);
  });

  socket.on('fire', (data, cb) => {
    const f = findPlayer(socket.id);
    if (!f) return cb && cb({ error: 'Ви не в кімнаті' });

    const err = fire(f.room, f.idx, data && data.x, data && data.y);
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

    const msg = {
      idx,
      name: playerName(room, idx),
      text,
      ts: now()
    };

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
    if ((!anyConnected && idle > ROOM_TTL_MS) || idle > 60 * 60000) {
      destroyRoom(room);
    }
  }
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚓ Морський бій запущено на порті ${PORT}`);
});
