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
const BOT_IDX = 1;

const BOTS = {
  easy: {
    key: 'easy', name: 'Юнга Біл', emoji: '🐚', title: 'Новачок',
    delay: [900, 1700],
    start: ['Ой, я ще вчуся… але стрілятиму!', 'Готовий! Тільки не сварися за промахи.', 'Мій перший справжній бій. Поїхали!']
  },
  normal: {
    key: 'normal', name: 'Штурман Норд', emoji: '🧭', title: 'Досвідчений',
    delay: [700, 1300],
    start: ['Курс на твої води. Починаємо.', 'Компас налаштовано. Виходжу в море.', 'Подивимось, хто влучніший, капітане.']
  },
  hard: {
    key: 'hard', name: 'Адмірал Грім', emoji: '⚔️', title: 'Ветеран',
    delay: [450, 950],
    start: ['Я рахую кожну клітинку. Готуйся.', 'Твій флот уже на моїй карті.', 'Поблажок не буде. Вогонь на ураження.']
  }
};

const BOT_LINES = {
  botSunk: ['Твій корабель пішов на дно.', 'Мінус один. Влучно.', 'Це було боляче — для тебе.', 'Ще одна ціль знищена.'],
  humanSunk: ['Влучно. Визнаю.', 'Добрий постріл, капітане.', 'Ти знайшов мою слабину.', 'Приймаю втрату. Продовжуємо.'],
  botWin: ['Море за мною. Реванш?', 'Флот знищено. Тренуйся ще.', 'Цього разу перемога моя.'],
  botLose: ['Ти сильніший. Реванш?', 'Чиста перемога. Вітаю.', 'Здаю цей бій — але не війну.']
};

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
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/* ================= storage ================= */

function emptyStore() { return { accounts: {}, matches: [] }; }

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyStore();
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
      matches: Array.isArray(data.matches) ? data.matches : []
    };
  } catch { return emptyStore(); }
}

let store = loadStore();
let saveTimer = null;

function saveStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('Збереження не вдалося:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveStore(); }, 250);
}

process.on('SIGTERM', () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveStore();
  process.exit(0);
});

/* ================= accounts ================= */

const cleanNick = v => String(v || '').replace(/\s+/g, ' ').trim();
const normNick = v => cleanNick(v).toLowerCase();

function validNick(v) {
  const n = cleanNick(v);
  return n.length >= 2 && n.length <= 18 && /^[\p{L}\p{N} _.\-]+$/u.test(n);
}

function publicAccount(a) {
  return a ? { id: a.id, nickname: a.nickname, createdAt: a.createdAt } : null;
}

function loginAccount(nickname) {
  const nick = cleanNick(nickname);
  if (!validNick(nick)) return { error: 'Нікнейм: 2–18 символів (літери, цифри, пробіл, _ . -)' };
  const id = normNick(nick);
  let acc = store.accounts[id];
  if (!acc) {
    acc = { id, nickname: nick, createdAt: now(), lastSeen: now() };
    store.accounts[id] = acc;
  } else {
    acc.nickname = nick;
    acc.lastSeen = now();
  }
  scheduleSave();
  return { account: publicAccount(acc) };
}

function botSeriesFor(accountId, difficulty) {
  let wins = 0, losses = 0;
  for (const m of store.matches) {
    if (!m.vsBot || m.botDifficulty !== difficulty) continue;
    if (!m.players.some(p => p.accountId === accountId)) continue;
    if (m.winnerId === accountId) wins++; else losses++;
  }
  return { wins, losses, total: wins + losses };
}

function accountStats(accountId) {
  const acc = store.accounts[accountId];
  if (!acc) return null;

  const list = store.matches.filter(m => m.players.some(p => p.accountId === accountId));
  let wins = 0, losses = 0;
  const rivals = new Map();
  const bot = { easy: { wins: 0, losses: 0 }, normal: { wins: 0, losses: 0 }, hard: { wins: 0, losses: 0 } };

  for (const m of list) {
    const won = m.winnerId === accountId;
    if (won) wins++; else losses++;

    if (m.vsBot) {
      const d = bot[m.botDifficulty] ? m.botDifficulty : 'normal';
      if (won) bot[d].wins++; else bot[d].losses++;
      continue;
    }

    const opp = m.players.find(p => p.accountId && p.accountId !== accountId);
    if (!opp) continue;
    const r = rivals.get(opp.accountId) || { accountId: opp.accountId, nickname: opp.nickname, wins: 0, losses: 0, lastPlayedAt: 0 };
    if (won) r.wins++; else r.losses++;
    r.nickname = opp.nickname;
    r.lastPlayedAt = Math.max(r.lastPlayedAt, m.finishedAt);
    rivals.set(opp.accountId, r);
  }

  const total = wins + losses;
  return {
    account: publicAccount(acc),
    wins, losses, total,
    winrate: total ? Math.round((wins / total) * 100) : 0,
    bot,
    rivals: [...rivals.values()].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 8),
    matches: list.slice().sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 14)
  };
}

function seriesBetween(a, b) {
  let you = 0, opp = 0;
  for (const m of store.matches) {
    if (m.vsBot) continue;
    const ids = m.players.map(p => p.accountId);
    if (!ids.includes(a) || !ids.includes(b)) continue;
    if (m.winnerId === a) you++; else if (m.winnerId === b) opp++;
  }
  return { you, opp, total: you + opp };
}

function recordMatch(room, winnerIdx, reason) {
  if (room.matchSaved || !room.startedAt) return;
  const p0 = room.players[0], p1 = room.players[1];
  if (!p0 || !p1 || !p0.accountId) return;
  if (!room.vsBot && (!p1.accountId || p0.accountId === p1.accountId)) return;

  const match = {
    id: makeToken(),
    code: room.code,
    reason,
    vsBot: !!room.vsBot,
    botDifficulty: room.vsBot ? room.botDifficulty : null,
    startedAt: room.startedAt,
    finishedAt: now(),
    durationMs: now() - room.startedAt,
    winnerIdx,
    winnerId: room.vsBot ? (winnerIdx === 0 ? p0.accountId : 'bot') : room.players[winnerIdx].accountId,
    players: room.players.map((p, i) => ({
      accountId: p.accountId,
      nickname: p.nickname || `Гравець ${i + 1}`,
      isBot: !!p.isBot,
      shots: room.stats[i].shots,
      hits: room.stats[i].hits,
      shipsLeft: p.ships.filter(s => s.hits < s.len).length
    }))
  };

  store.matches.push(match);
  if (store.matches.length > MATCH_HISTORY) store.matches.splice(0, store.matches.length - MATCH_HISTORY);
  room.matchSaved = true;
  room.lastMatchId = match.id;
  scheduleSave();
}

/* ================= fleet helpers ================= */

function autoFleet() {
  for (let attempt = 0; attempt < 400; attempt++) {
    const board = grid(0);
    const ships = [];
    let ok = true;

    for (let i = 0; i < FLEET.length; i++) {
      const len = FLEET[i];
      let placed = false;

      for (let t = 0; t < 400; t++) {
        const dir = Math.random() < 0.5 ? 'h' : 'v';
        const x = Math.floor(Math.random() * (dir === 'h' ? SIZE - len + 1 : SIZE));
        const y = Math.floor(Math.random() * (dir === 'v' ? SIZE - len + 1 : SIZE));
        const cells = [];
        for (let k = 0; k < len; k++) cells.push([dir === 'h' ? x + k : x, dir === 'v' ? y + k : y]);

        let free = true;
        for (const [cx, cy] of cells) {
          for (let dx = -1; dx <= 1 && free; dx++) {
            for (let dy = -1; dy <= 1 && free; dy++) {
              const nx = cx + dx, ny = cy + dy;
              if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[ny][nx] !== 0) free = false;
            }
          }
        }

        if (free) {
          const id = i + 1;
          for (const [cx, cy] of cells) board[cy][cx] = id;
          ships.push({ cells, len, hits: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return { board, ships };
  }
  return null;
}

function validateFleet(input) {
  if (!Array.isArray(input) || input.length !== FLEET.length) return { error: 'Невірний склад флоту' };
  const lens = input.map(s => s && s.len).sort((a, b) => b - a);
  if (JSON.stringify(lens) !== JSON.stringify(FLEET)) return { error: 'Невірний склад флоту' };

  const board = grid(0);
  const ships = [];

  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    if (!s || !Number.isInteger(s.x) || !Number.isInteger(s.y) || !Number.isInteger(s.len) || !['h', 'v'].includes(s.dir)) {
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
          const nx = x + dx, ny = y + dy;
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

/* ================= bot brain ================= */

function sunkLengthsFromView(view) {
  const seen = grid(false);
  const lengths = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (view[y][x] !== 3 || seen[y][x]) continue;
      const stack = [[x, y]];
      seen[y][x] = true;
      let n = 0;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        n++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && view[ny][nx] === 3 && !seen[ny][nx]) {
            seen[ny][nx] = true;
            stack.push([nx, ny]);
          }
        }
      }
      lengths.push(n);
    }
  }
  return lengths;
}

function remainingLengths(view) {
  const rem = FLEET.slice();
  for (const L of sunkLengthsFromView(view)) {
    const i = rem.indexOf(L);
    if (i >= 0) rem.splice(i, 1);
  }
  return rem.length ? rem : [1];
}

function huntTargets(view) {
  const key = (x, y) => x + ',' + y;
  const hits = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (view[y][x] === 2) hits.push([x, y]);
  if (!hits.length) return [];

  const hitSet = new Set(hits.map(([x, y]) => key(x, y)));
  const out = new Map();
  const add = (x, y, w) => {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE || view[y][x] !== 0) return;
    const k = key(x, y);
    const cur = out.get(k) || { x, y, w: 0 };
    cur.w += w;
    out.set(k, cur);
  };

  const seen = new Set();
  const groups = [];
  for (const [x, y] of hits) {
    if (seen.has(key(x, y))) continue;
    const stack = [[x, y]];
    seen.add(key(x, y));
    const g = [];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      g.push([cx, cy]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (hitSet.has(key(nx, ny)) && !seen.has(key(nx, ny))) {
          seen.add(key(nx, ny));
          stack.push([nx, ny]);
        }
      }
    }
    groups.push(g);
  }

  for (const g of groups) {
    if (g.length >= 2) {
      const sameRow = g.every(([, y]) => y === g[0][1]);
      const sameCol = g.every(([x]) => x === g[0][0]);
      if (sameRow) {
        const xs = g.map(([x]) => x).sort((a, b) => a - b);
        const y = g[0][1];
        add(xs[0] - 1, y, 12);
        add(xs[xs.length - 1] + 1, y, 12);
      } else if (sameCol) {
        const ys = g.map(([, y]) => y).sort((a, b) => a - b);
        const x = g[0][0];
        add(x, ys[0] - 1, 12);
        add(x, ys[ys.length - 1] + 1, 12);
      } else {
        for (const [x, y] of g) { add(x + 1, y, 5); add(x - 1, y, 5); add(x, y + 1, 5); add(x, y - 1, 5); }
      }
    } else {
      const [x, y] = g[0];
      add(x + 1, y, 5); add(x - 1, y, 5); add(x, y + 1, 5); add(x, y - 1, 5);
    }
  }
  return [...out.values()];
}

function densityMap(view) {
  const rem = remainingLengths(view);
  const score = grid(0);
  let hasHits = false;
  for (let y = 0; y < SIZE && !hasHits; y++) for (let x = 0; x < SIZE && !hasHits; x++) if (view[y][x] === 2) hasHits = true;

  for (const len of rem) {
    for (const dir of ['h', 'v']) {
      const maxX = dir === 'h' ? SIZE - len : SIZE - 1;
      const maxY = dir === 'v' ? SIZE - len : SIZE - 1;
      for (let y = 0; y <= maxY; y++) {
        for (let x = 0; x <= maxX; x++) {
          let ok = true, hits = 0;
          const cells = [];
          for (let k = 0; k < len; k++) {
            const cx = dir === 'h' ? x + k : x;
            const cy = dir === 'v' ? y + k : y;
            const v = view[cy][cx];
            if (v === 1 || v === 3) { ok = false; break; }
            if (v === 2) hits++;
            cells.push([cx, cy]);
          }
          if (!ok) continue;
          const w = hasHits ? (hits ? 1 + hits * hits * 20 : 0.05) : 1;
          for (const [cx, cy] of cells) if (view[cy][cx] === 0) score[cy][cx] += w;
        }
      }
    }
  }
  return score;
}

function bestBy(list, valueFn) {
  let best = [], bs = -Infinity;
  for (const c of list) {
    const s = valueFn(c);
    if (s > bs + 1e-9) { bs = s; best = [c]; }
    else if (Math.abs(s - bs) < 1e-9) best.push(c);
  }
  return best.length ? pick(best) : null;
}

function chooseBotMove(room) {
  const view = room.players[BOT_IDX].view;
  const unknown = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (view[y][x] === 0) unknown.push({ x, y });
  if (!unknown.length) return null;

  const targets = huntTargets(view);
  const diff = room.botDifficulty;

  if (diff === 'easy') {
    if (targets.length && Math.random() < 0.25) return pick(targets);
    return pick(unknown);
  }

  if (diff === 'normal') {
    if (targets.length) return bestBy(targets, c => c.w);
    const minLen = Math.min.apply(null, remainingLengths(view));
    const parity = unknown.filter(c => (c.x + c.y) % minLen === 0);
    return pick(parity.length ? parity : unknown);
  }

  const score = densityMap(view);
  if (targets.length) {
    const t = bestBy(targets, c => score[c.y][c.x] + c.w * 3);
    if (t) return t;
  }
  return bestBy(unknown, c => score[c.y][c.x]) || pick(unknown);
}

/* ================= room core ================= */

function newPlayer(socketId, account) {
  return {
    token: makeToken(), socketId, connected: true, ready: false, isBot: false,
    accountId: account ? account.id : null,
    nickname: account ? account.nickname : null,
    board: grid(0), ships: [], view: grid(0), received: grid(0),
    disconnectAt: null, forfeitTimer: null, lastChatAt: 0
  };
}

function newRoom(code, socketId, account) {
  return {
    code, phase: 'waiting', players: [newPlayer(socketId, account), null],
    turn: 0, turnEndsAt: 0, turnTimer: null, botTimer: null,
    winner: null, reason: null, rematch: [false, false], chat: [],
    stats: [{ shots: 0, hits: 0 }, { shots: 0, hits: 0 }],
    createdAt: now(), startedAt: null, lastActivity: now(),
    matchSaved: false, lastMatchId: null,
    vsBot: false, botDifficulty: null, useTimer: true
  };
}

function genCode() {
  for (let i = 0; i < 60; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  for (let c = 1000; c <= 9999; c++) if (!rooms.has(String(c))) return String(c);
  return null;
}

function findPlayer(socketId) {
  for (const room of rooms.values()) {
    for (let i = 0; i < 2; i++) {
      const p = room.players[i];
      if (p && p.socketId && p.socketId === socketId) return { room, idx: i };
    }
  }
  return null;
}

const touch = room => { room.lastActivity = now(); };
const playerName = (room, idx) => {
  const p = room.players[idx];
  return p && p.nickname ? p.nickname : `Гравець ${idx + 1}`;
};

function clearBotTimer(room) {
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
}

function clearTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  clearBotTimer(room);
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

function botSay(room, text) {
  if (!room.vsBot) return;
  const msg = { idx: BOT_IDX, name: playerName(room, BOT_IDX), bot: true, text, ts: now() };
  room.chat.push(msg);
  trimChat(room);
  io.to(room.code).emit('chat', msg);
}

function scheduleBotMove(room) {
  clearBotTimer(room);
  if (!room.vsBot || room.phase !== 'playing' || room.turn !== BOT_IDX) return;
  const cfg = BOTS[room.botDifficulty] || BOTS.normal;
  const delay = cfg.delay[0] + Math.random() * (cfg.delay[1] - cfg.delay[0]);

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.phase !== 'playing' || room.turn !== BOT_IDX) return;
    const mv = chooseBotMove(room);
    if (!mv) { room.turn = 0; armTurnTimer(room); emitState(room); return; }
    const err = fire(room, BOT_IDX, mv.x, mv.y);
    if (err) { room.turn = 0; armTurnTimer(room); emitState(room); }
  }, delay);
}

function armTurnTimer(room) {
  clearTimers(room);
  if (room.phase !== 'playing') return;

  if (room.vsBot && room.turn === BOT_IDX) { room.turnEndsAt = 0; scheduleBotMove(room); return; }
  if (room.vsBot && !room.useTimer) { room.turnEndsAt = 0; return; }

  room.turnEndsAt = now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.phase !== 'playing') return;
    room.turn = 1 - room.turn;
    notice(room, `⏱️ Час вийшов. Хід переходить до ${playerName(room, room.turn)}.`);
    armTurnTimer(room);
    emitState(room);
  }, TURN_MS);
}

function stateFor(room, idx) {
  const me = room.players[idx];
  const opp = room.players[1 - idx];

  let series = null;
  if (!room.vsBot && room.phase === 'finished' && me.accountId && opp && opp.accountId && me.accountId !== opp.accountId) {
    series = seriesBetween(me.accountId, opp.accountId);
  }

  const botProfile = room.vsBot ? (BOTS[room.botDifficulty] || BOTS.normal) : null;

  return {
    code: room.code, phase: room.phase, you: idx,
    board: me.board, received: me.received, view: me.view, ready: me.ready,
    youAccount: me.accountId ? { id: me.accountId, nickname: me.nickname } : null,
    oppAccount: opp && opp.accountId ? { id: opp.accountId, nickname: opp.nickname } : null,
    oppName: opp ? (opp.nickname || `Гравець ${2 - idx}`) : null,
    oppPresent: !!opp, oppReady: !!(opp && opp.ready), oppConnected: !!(opp && opp.connected),
    oppDisconnectMsLeft: opp && !opp.isBot && !opp.connected && opp.disconnectAt
      ? Math.max(0, GRACE_MS - (now() - opp.disconnectAt)) : null,
    turn: room.turn,
    turnTimerActive: !!room.turnTimer,
    turnMsLeft: room.turnTimer ? Math.max(0, room.turnEndsAt - now()) : null,
    winner: room.winner, reason: room.reason, rematch: room.rematch, stats: room.stats,
    series, matchId: room.lastMatchId,
    vsBot: !!room.vsBot,
    botDifficulty: room.botDifficulty,
    botProfile: botProfile ? { key: botProfile.key, name: botProfile.name, emoji: botProfile.emoji, title: botProfile.title } : null,
    botSeries: room.vsBot && me.accountId ? botSeriesFor(me.accountId, room.botDifficulty) : null,
    fleetYou: me.ships.map(s => ({ len: s.len, sunk: s.hits === s.len })),
    fleetOpp: opp ? opp.ships.map(s => ({ len: s.len, sunk: s.hits === s.len })) : [],
    oppBoard: room.phase === 'finished' && opp ? opp.board : null,
    chat: room.chat
  };
}

function emitState(room) {
  room.players.forEach((p, i) => {
    if (p && p.connected && p.socketId) io.to(p.socketId).emit('state', stateFor(room, i));
  });
}

function tryStart(room) {
  if (room.phase !== 'placing') return;
  if (!(room.players[0].ready && room.players[1] && room.players[1].ready)) return;

  room.phase = 'playing';
  room.startedAt = now();
  room.turn = Math.random() < 0.5 ? 0 : 1;
  armTurnTimer(room);
  notice(room, `⚔️ Бій почався! Перший хід — ${playerName(room, room.turn)}.`);
  if (room.vsBot) {
    const cfg = BOTS[room.botDifficulty] || BOTS.normal;
    setTimeout(() => { if (rooms.has(room.code)) botSay(room, pick(cfg.start)); }, 500);
  }
}

function endGame(room, winner, reason) {
  if (room.phase === 'finished') return;
  clearTimers(room);
  room.players.forEach(p => {
    if (p && p.forfeitTimer) { clearTimeout(p.forfeitTimer); p.forfeitTimer = null; }
  });
  room.phase = 'finished';
  room.winner = winner;
  room.reason = reason;
  room.rematch = [false, false];
  recordMatch(room, winner, reason);
  emitState(room);
  if (room.vsBot) {
    setTimeout(() => {
      if (rooms.has(room.code)) botSay(room, pick(winner === BOT_IDX ? BOT_LINES.botWin : BOT_LINES.botLose));
    }, 700);
  }
}

function resetForRematch(room) {
  clearTimers(room);
  room.phase = 'placing';
  room.winner = null;
  room.reason = null;
  room.rematch = [false, false];
  room.stats = [{ shots: 0, hits: 0 }, { shots: 0, hits: 0 }];
  room.startedAt = null;
  room.matchSaved = false;
  room.lastMatchId = null;

  room.players.forEach(p => {
    p.ready = false; p.board = grid(0); p.ships = []; p.view = grid(0); p.received = grid(0);
    if (p.isBot) {
      const f = autoFleet();
      p.board = f.board; p.ships = f.ships; p.ready = true;
    }
  });

  notice(room, room.vsBot ? '🔁 Новий бій! Розставте кораблі.' : '🔁 Реванш! Розставте кораблі для нового бою.');
}

function fire(room, idx, x, y) {
  if (room.phase !== 'playing') return 'Бій ще не триває';
  if (room.turn !== idx) return 'Зараз не ваш хід';
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) return 'Невірна клітинка';

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
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && me.view[ny][nx] === 0) me.view[ny][nx] = 1;
          }
        }
      }
    }
  } else {
    me.view[y][x] = 1;
  }

  io.to(room.code).emit('shot', { by: idx, x, y, result, ship: shipCells });

  if (room.vsBot && result === 'sunk') {
    botSay(room, pick(idx === BOT_IDX ? BOT_LINES.botSunk : BOT_LINES.humanSunk));
  }

  if (opp.ships.every(s => s.hits === s.len)) { endGame(room, idx, 'sunk'); return null; }
  if (result === 'miss') room.turn = 1 - idx;
  armTurnTimer(room);
  emitState(room);
  return null;
}

function destroyRoom(room) {
  clearTimers(room);
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

  if (room.vsBot) {
    if (room.phase === 'playing' || room.phase === 'placing') endGame(room, BOT_IDX, 'left');
    destroyRoom(room);
    return;
  }
  if (room.phase === 'waiting') { destroyRoom(room); return; }
  if (room.phase === 'finished') { emitState(room); return; }

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
    clearTimers(room);
    p.forfeitTimer = setTimeout(() => {
      p.forfeitTimer = null;
      if (!p.connected && (room.phase === 'playing' || room.phase === 'placing')) {
        endGame(room, 1 - idx, 'disconnect');
        if (room.vsBot) destroyRoom(room);
      }
    }, GRACE_MS);
    if (!room.vsBot) notice(room, `📡 ${playerName(room, idx)} втратив з'єднання. 60 секунд на відновлення…`);
  }
  emitState(room);
}

function attachAccount(socket) {
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
    const r = loginAccount(data && data.nickname);
    if (r.error) return cb && cb({ error: r.error });
    socket.data.account = r.account;
    attachAccount(socket);
    cb && cb({ ok: true, account: r.account, stats: accountStats(r.account.id) });
  });

  socket.on('account:logout', cb => {
    socket.data.account = null;
    attachAccount(socket);
    cb && cb({ ok: true });
  });

  socket.on('account:stats', cb => {
    const acc = socket.data.account;
    if (!acc) return cb && cb({ error: 'Ви не в акаунті' });
    cb && cb({ ok: true, stats: accountStats(acc.id) });
  });

  socket.on('bot:start', (data, cb) => {
    const difficulty = BOTS[data && data.difficulty] ? data.difficulty : 'normal';
    const useTimer = !!(data && data.timer);

    leaveRoom(socket);
    const code = genCode();
    if (!code) return cb && cb({ error: 'Сервер переповнений, спробуйте пізніше' });

    const fleet = autoFleet();
    if (!fleet) return cb && cb({ error: 'Не вдалося розставити флот бота' });

    const room = newRoom(code, socket.id, socket.data.account);
    room.vsBot = true;
    room.botDifficulty = difficulty;
    room.useTimer = useTimer;
    room.phase = 'placing';

    const bot = newPlayer(null, null);
    bot.isBot = true;
    bot.nickname = BOTS[difficulty].name;
    bot.board = fleet.board;
    bot.ships = fleet.ships;
    bot.ready = true;
    room.players[1] = bot;

    rooms.set(code, room);
    socket.join(code);
    touch(room);

    cb && cb({ ok: true, code, token: room.players[0].token, idx: 0 });
    notice(room, `🤖 ${bot.nickname} вийшов у море. Розставте свій флот!`);
    emitState(room);
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
    if (room.vsBot) return cb && cb({ error: 'Це одиночна кімната з ботом' });
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

    const idx = room.players.findIndex(p => p && !p.isBot && p.token === tk);
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
    if (socket.data.account) { p.accountId = socket.data.account.id; p.nickname = socket.data.account.nickname; }

    socket.join(room.code);
    touch(room);
    if (room.phase === 'playing') armTurnTimer(room);

    cb && cb({ ok: true, code: room.code, idx, token: p.token });
    if (!room.vsBot) notice(room, `🔌 ${playerName(room, idx)} відновив з'єднання.`);
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
    if (!room.vsBot) notice(room, `${playerName(room, idx)} готовий до бою.`);
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
    if (!text || now() - p.lastChatAt < CHAT_COOLDOWN_MS) return;
    p.lastChatAt = now();
    touch(room);
    const msg = { idx, name: playerName(room, idx), text, ts: now() };
    room.chat.push(msg);
    trimChat(room);
    io.to(room.code).emit('chat', msg);
    if (room.vsBot && Math.random() < 0.45) {
      setTimeout(() => {
        if (rooms.has(room.code)) botSay(room, pick(['Прийнято, капітане.', 'Говори менше — стріляй влучніше.', 'Рахую клітинки, а не слова.', 'Зрозумів. Продовжуємо бій.']));
      }, 900);
    }
  });

  socket.on('rematch', () => {
    const f = findPlayer(socket.id);
    if (!f) return;
    const { room, idx } = f;
    if (room.phase !== 'finished') return;
    room.rematch[idx] = true;
    touch(room);
    if (room.vsBot) room.rematch[BOT_IDX] = true;
    if (room.rematch[0] && room.rematch[1]) resetForRematch(room);
    emitState(room);
  });

  socket.on('leaveRoom', () => leaveRoom(socket));
  socket.on('disconnect', () => onDisconnect(socket));
});

setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    const anyConnected = room.players.some(p => p && !p.isBot && p.connected);
    const idle = t - room.lastActivity;
    if ((!anyConnected && idle > ROOM_TTL_MS) || idle > 60 * 60000) destroyRoom(room);
  }
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚓ Морський бій запущено на порті ${PORT}`);
});
