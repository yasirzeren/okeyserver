'use strict';
const crypto = require('crypto');
const { Game } = require('./game');
const bot = require('./bot');

const INDICATOR_MS = 5000;
const TURN_MS = 30000; // her oyuncunun sıra süresi
const DISCONNECTED_MS = 4000; // bağlantısı kopan oyuncunun sırası
const NEXT_MS = 45000; // sonraki ele otomatik geçiş
const BOT_MS = 900;
const LOBBY_GRACE_MS = 30000; // lobide bağlantı kopunca bekleme
const IDLE_CLOSE_MS = 10 * 60 * 1000; // bağlı kimse yoksa oda kapanır
const MAX_ROOMS = 500;
const CHAT_MAX = 120;
const CHAT_GAP_MS = 700;
const BOT_NAMES = ['Zeynep', 'Mehmet', 'Ayşe', 'Ece', 'Kaan'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROUND_OPTIONS = [1, 2, 4, 8, 10, 12, 16, 18, 20];

const ok = (message = '', extra = {}) => ({ ok: true, message, ...extra });
const fail = (message) => ({ ok: false, message });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(s, max, fallback) {
  const t = cleanText(s).slice(0, max).trim();
  return t || fallback;
}

/** Kullanıcıdan gelen kuralları doğrular, geçersiz değerleri varsayılana çeker. */
function normalizeSettings(s) {
  const x = s && typeof s === 'object' ? s : {};
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  return {
    folding: x.folding === true,
    partnerFolding: x.partnerFolding !== false,
    assisted: x.assisted !== false,
    partners: x.partners === true,
    sidePenalty: x.sidePenalty === true,
    indicatorRule: x.indicatorRule !== false,
    pairThreshold: 5,
    wrongOpenPenalty: 101,
    sideTakePenalty: 101,
    workablePenalty: 101,
    totalRounds: pick(x.totalRounds, ROUND_OPTIONS, 8),
  };
}

const parseTile = (x) => (Number.isInteger(x) && x >= 0 && x < 106 ? x : null);

function parseGroups(x) {
  if (!Array.isArray(x) || x.length === 0 || x.length > 30) return null;
  const out = [];
  for (const g of x) {
    if (!Array.isArray(g) || g.length < 2 || g.length > 14) return null;
    const ids = g.map(parseTile);
    if (ids.some((id) => id === null)) return null;
    out.push(ids);
  }
  return out;
}

class Room {
  constructor(manager, code, name, settings) {
    this.manager = manager;
    this.io = manager.io;
    this.code = code;
    this.name = name;
    this.settings = settings;
    this.members = [null, null, null, null];
    this.hostSeat = 0;
    this.game = null;
    this.started = false;
    this.chat = [];
    this.v = 0;
    this.timer = null;
    this.scheduleKey = '';
    this.botBusy = false;
    this.closed = false;
    this.indicatorDeadline = null;
    this.turnDeadline = null;
    this.turnKey = '';
    this.turnStart = 0;
    this.turnBase = TURN_MS;
    this.nextReady = new Set();
    this.lastActive = Date.now();
  }

  touch() {
    this.lastActive = Date.now();
  }
  humans() {
    return this.members.filter((m) => m && !m.isBot);
  }
  connectedHumans() {
    return this.humans().filter((m) => m.connected);
  }
  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  emitTo(m, ev, data) {
    if (m && !m.isBot && m.connected && m.socketId) this.io.to(m.socketId).emit(ev, data);
  }

  roomInfo(m) {
    return {
      code: this.code,
      name: this.name,
      hostSeat: this.hostSeat,
      mySeat: m.seat,
      settings: this.settings,
      started: this.started,
      members: this.members
        .filter(Boolean)
        .map((x) => ({
          seat: x.seat,
          name: x.name,
          isBot: x.isBot,
          ready: x.ready,
          connected: x.isBot ? true : x.connected,
        })),
    };
  }

  broadcastRoom() {
    for (const m of this.humans()) this.emitTo(m, 'room', this.roomInfo(m));
  }

  pushChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > 100) this.chat.shift();
    for (const m of this.humans()) this.emitTo(m, 'chat', entry);
  }

  sys(text) {
    this.pushChat({ author: null, text, time: Date.now() });
  }

  flushGame() {
    if (!this.game) return;
    for (const t of this.game.outbox.splice(0)) this.sys(t);
  }

  /** Bir oyuncuya özel durum: yalnızca kendi eli ve herkese açık bilgi. */
  stateFor(m) {
    const g = this.game;
    const view = g.viewFor(m.seat);
    view.v = this.v;
    view.serverTime = Date.now();
    view.mySeat = m.seat;
    view.indicatorDeadline = g.phase === 'indicator' ? this.indicatorDeadline : null;
    view.turnDeadline =
      g.phase === 'playing' && !this.members[g.current].isBot ? this.turnDeadline : null;
    for (const p of view.players) {
      const mm = this.members[p.seat];
      p.connected = mm.isBot ? true : mm.connected;
    }
    return view;
  }

  broadcastState() {
    if (!this.game) return;
    this.v++;
    for (const m of this.humans()) this.emitTo(m, 'state', this.stateFor(m));
  }

  afterChange() {
    if (this.closed) return;
    this.flushGame();
    this.schedule(); // önce süre güncellensin, sonra istemcilere gitsin
    this.broadcastState();
  }

  // ------------------------------------------------------------------ lobi
  uniqueName(name) {
    const taken = new Set(this.members.filter(Boolean).map((m) => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 10; i++) {
      const n = `${name.slice(0, 11)} ${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return name;
  }

  addHuman(token, name, socketId) {
    const seat = this.members.findIndex((m) => m === null);
    if (seat < 0) return null;
    const m = {
      seat,
      token,
      name: this.uniqueName(name),
      isBot: false,
      ready: false,
      connected: true,
      socketId,
      lastChat: 0,
      graceTimer: null,
    };
    this.members[seat] = m;
    return m;
  }

  startGame(member) {
    if (this.started) return fail('Oyun zaten başladı.');
    if (member.seat !== this.hostSeat) return fail('Oyunu yalnızca oda sahibi başlatabilir.');
    const waiting = this.humans().filter((m) => m.seat !== this.hostSeat && !m.ready);
    if (waiting.length) return fail('Tüm oyuncular hazır olmalı.');
    const used = new Set(this.members.filter(Boolean).map((m) => m.name.toLowerCase()));
    const names = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
    let extra = 1;
    for (let seat = 0; seat < 4; seat++) {
      if (this.members[seat]) continue;
      this.members[seat] = {
        seat,
        token: null,
        name: names.shift() || `Bot ${extra++}`,
        isBot: true,
        ready: true,
        connected: true,
        socketId: null,
        lastChat: 0,
        graceTimer: null,
      };
    }
    this.started = true;
    this.game = new Game(
      this.settings,
      this.members.map((m) => ({ name: m.name, isBot: m.isBot }))
    );
    this.game.startRound();
    this.onRoundStarted();
    this.broadcastRoom();
    this.afterChange();
    return ok('Oyun başladı.');
  }

  onRoundStarted() {
    this.indicatorDeadline =
      this.game.phase === 'indicator' ? Date.now() + INDICATOR_MS : null;
    this.nextReady.clear();
    this.scheduleKey = '';
    this.turnKey = '';
  }

  startNextRound() {
    if (this.closed || !this.game || this.game.phase !== 'finished') return;
    if (this.game.matchOver()) return;
    this.game.startRound();
    this.onRoundStarted();
    this.afterChange();
  }

  readyNext(member) {
    const g = this.game;
    if (!g || g.phase !== 'finished') return fail('El henüz bitmedi.');
    if (g.matchOver()) return fail('Maç bitti.');
    this.nextReady.add(member.seat);
    const waiting = this.connectedHumans().filter((m) => !this.nextReady.has(m.seat));
    if (waiting.length === 0) this.startNextRound();
    return ok();
  }

  // --------------------------------------------------------- zamanlayıcılar
  schedule() {
    if (this.closed || !this.game) return;
    const g = this.game;
    if (this.connectedHumans().length === 0) {
      this.clearTimer();
      this.scheduleKey = 'paused';
      this.turnKey = '';
      return;
    }
    if (this.botBusy) return;

    let key;
    let delay = 0;
    let action;

    if (g.phase === 'indicator') {
      key = `i:${g.round}`;
      if (key === this.scheduleKey && this.timer) return;
      if (!this.indicatorDeadline) this.indicatorDeadline = Date.now() + INDICATOR_MS;
      delay = Math.max(0, this.indicatorDeadline - Date.now());
      action = () => {
        if (g.phase !== 'indicator') return;
        g.confirmIndicator(); // süre doldu: gösterge otomatik yerleşir
        this.afterChange();
      };
    } else if (g.phase === 'playing') {
      const seat = g.current;
      const m = this.members[seat];
      if (m.isBot) {
        key = `b:${g.round}:${g.turnNo}`;
        if (key === this.scheduleKey && this.timer) return;
        action = () => this.runBot(seat);
      } else {
        const tk = `${g.round}:${g.turnNo}:${seat}:${m.connected}`;
        if (tk !== this.turnKey) {
          this.turnKey = tk;
          this.turnStart = Date.now();
          this.turnBase = m.connected ? TURN_MS : DISCONNECTED_MS;
        }
        this.turnDeadline = this.turnStart + this.turnBase + g.turnAdjustMs;
        key = `p:${tk}:${g.turnAdjustMs}`;
        if (key === this.scheduleKey && this.timer) return;
        delay = Math.max(0, this.turnDeadline - Date.now());
        action = () => this.autoPlay(seat);
      }
    } else {
      key = `f:${g.round}`;
      if (g.matchOver()) {
        this.clearTimer();
        this.scheduleKey = key;
        return;
      }
      if (key === this.scheduleKey && this.timer) return;
      delay = NEXT_MS;
      action = () => this.startNextRound();
    }

    this.clearTimer();
    this.scheduleKey = key;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleKey = '';
      action();
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Süresi dolan veya bağlantısı kopan oyuncu için: gerekirse taşı geri bırak,
   * taş çek, perdesiz en düşük taşı at.
   */
  autoPlay(seat) {
    const g = this.game;
    if (this.closed || !g || g.phase !== 'playing' || g.current !== seat) return;
    const name = g.players[seat].name;
    if (g.canReturnSide(seat)) g.returnSide(seat);
    if (g.step === 'draw') g.draw(seat);
    if (g.phase === 'playing' && g.current === seat && g.step === 'play') {
      g.say(`${name} için süre doldu, taş otomatik atıldı.`);
      let r = g.discard(seat, bot.autoDiscard(g, seat));
      if (!r.ok) {
        // beklenmedik durum: oyun kilitlenmesin, elindeki başka bir taşı dene
        for (const id of [...g.players[seat].hand]) {
          r = g.discard(seat, id);
          if (r.ok) break;
        }
      }
    }
    this.afterChange();
  }

  async runBot(seat) {
    if (this.botBusy) return;
    this.botBusy = true;
    const g = this.game;
    const can = () =>
      !this.closed &&
      this.game === g &&
      g.phase === 'playing' &&
      g.current === seat &&
      this.connectedHumans().length > 0;
    try {
      await sleep(BOT_MS);
      if (!can()) return;
      if (g.step === 'draw') {
        if (bot.shouldTakeSide(g, seat)) g.takeSide(seat);
        else g.draw(seat);
        this.afterChange();
        if (!can()) return;
        await sleep(700);
        if (!can()) return;
      }
      const plan = bot.planOpen(g, seat);
      if (plan) {
        const r = g.openGroups(seat, plan);
        this.afterChange();
        if (r.ok) await sleep(BOT_MS);
        if (!can()) return;
      }
      while (can()) {
        const mv = bot.nextProcess(g, seat);
        if (!mv) break;
        const r = g.processTile(seat, mv.tile, mv.meldId);
        this.afterChange();
        if (!r.ok) break;
        await sleep(500);
      }
      if (!can()) return;
      if (g.canReturnSide(seat)) {
        // Kullanmadı: yandan aldığı taşı geri bırakıp desteden çeker.
        g.returnSide(seat);
        this.afterChange();
        if (!can()) return;
        await sleep(700);
        if (!can()) return;
        g.draw(seat);
        this.afterChange();
        if (!can()) return;
      }
      g.discard(seat, bot.chooseDiscard(g, seat));
      this.afterChange();
    } catch (e) {
      console.error('bot hatası', e);
    } finally {
      this.botBusy = false;
      this.scheduleKey = '';
      if (!this.closed) this.schedule();
    }
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.sessions = new Map(); // token -> {code, seat}
    this.sweeper = setInterval(() => this.sweep(), 60000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  newToken() {
    return crypto.randomBytes(18).toString('hex');
  }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  /** Soketin oda üyeliğini doğrular. Yalnızca aktif soket işlem yapabilir. */
  ctx(socket) {
    const token = socket.data && socket.data.token;
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const room = this.rooms.get(s.code);
    if (!room) return null;
    const member = room.members[s.seat];
    if (!member || member.token !== token || member.socketId !== socket.id) return null;
    return { room, member };
  }

  // ------------------------------------------------------------------ lobi
  createRoom(socket, d) {
    if (this.ctx(socket)) return fail('Zaten bir odadasın.');
    if (this.rooms.size >= MAX_ROOMS) return fail('Sunucu dolu, daha sonra tekrar dene.');
    const name = cleanName(d.playerName, 14, 'Oyuncu');
    const roomName = cleanName(d.roomName, 24, 'Oda');
    const room = new Room(this, this.newCode(), roomName, normalizeSettings(d.settings));
    const token = this.newToken();
    const m = room.addHuman(token, name, socket.id);
    room.hostSeat = m.seat;
    this.rooms.set(room.code, room);
    this.sessions.set(token, { code: room.code, seat: m.seat });
    socket.data.token = token;
    room.broadcastRoom();
    return ok('Oda kuruldu.', { token, code: room.code, seat: m.seat });
  }

  joinRoom(socket, d) {
    if (this.ctx(socket)) return fail('Zaten bir odadasın.');
    const code = cleanText(d.code).toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return fail('Oda bulunamadı.');
    if (room.started) return fail('Oyun başlamış, odaya katılamazsın.');
    const token = this.newToken();
    const m = room.addHuman(token, cleanName(d.playerName, 14, 'Oyuncu'), socket.id);
    if (!m) return fail('Oda dolu.');
    this.sessions.set(token, { code: room.code, seat: m.seat });
    socket.data.token = token;
    room.touch();
    room.emitTo(m, 'chat_history', room.chat);
    room.broadcastRoom();
    return ok('Odaya girildi.', { token, code: room.code, seat: m.seat });
  }

  resume(socket, d) {
    const token = typeof d.token === 'string' ? d.token : '';
    const current = this.ctx(socket);
    if (current) {
      if (current.member.token !== token) return fail('Zaten bir odadas\u0131n.');
      return ok('Odaya d\u00f6n\u00fcld\u00fc.', { code: current.room.code, seat: current.member.seat });
    }
    const s = this.sessions.get(token);
    const room = s && this.rooms.get(s.code);
    const m = room && room.members[s.seat];
    if (!s || !room || !m || m.token !== token) {
      return fail('Oturum bulunamadı (oda kapanmış veya sunucu yeniden başlamış olabilir).');
    }
    if (m.graceTimer) {
      clearTimeout(m.graceTimer);
      m.graceTimer = null;
    }
    m.connected = true;
    m.socketId = socket.id;
    socket.data.token = token;
    room.touch();
    room.emitTo(m, 'room', room.roomInfo(m));
    room.emitTo(m, 'chat_history', room.chat);
    if (room.game) room.emitTo(m, 'state', room.stateFor(m));
    room.broadcastRoom();
    if (room.game) room.afterChange();
    return ok('Odaya dönüldü.', { code: room.code, seat: m.seat });
  }

  setReady(socket, d) {
    const c = this.ctx(socket);
    if (!c) return fail('Bir odada değilsin.');
    if (c.room.started) return fail('Oyun başladı.');
    c.member.ready = d.ready === true;
    c.room.touch();
    c.room.broadcastRoom();
    return ok();
  }

  updateSettings(socket, d) {
    const c = this.ctx(socket);
    if (!c) return fail('Bir odada değilsin.');
    if (c.member.seat !== c.room.hostSeat) {
      return fail('Kuralları yalnızca oda sahibi değiştirebilir.');
    }
    if (c.room.started) return fail('Oyun başladıktan sonra kurallar değiştirilemez.');
    c.room.settings = normalizeSettings(d.settings);
    c.room.touch();
    c.room.broadcastRoom();
    return ok();
  }

  startGame(socket) {
    const c = this.ctx(socket);
    if (!c) return fail('Bir odada değilsin.');
    c.room.touch();
    return c.room.startGame(c.member);
  }

  leaveRoom(socket) {
    const c = this.ctx(socket);
    if (!c) return ok();
    const { room, member } = c;
    this.sessions.delete(member.token);
    socket.data.token = null;
    if (!room.started) {
      this.removeMember(room, member);
      return ok();
    }
    // Oyun sırasında ayrılırsa yerine bot geçer.
    if (member.graceTimer) clearTimeout(member.graceTimer);
    const name = member.name;
    member.isBot = true;
    member.token = null;
    member.connected = true;
    member.socketId = null;
    room.game.players[member.seat].isBot = true;
    room.game.say(`${name} masadan ayrıldı, yerine bot geçti.`);
    if (room.humans().length === 0) {
      this.closeRoom(room, 'Tüm oyuncular ayrıldı.');
      return ok();
    }
    if (room.hostSeat === member.seat) room.hostSeat = room.humans()[0].seat;
    room.broadcastRoom();
    room.afterChange();
    return ok();
  }

  removeMember(room, member) {
    if (room.started) return;
    if (member.graceTimer) clearTimeout(member.graceTimer);
    room.members[member.seat] = null;
    if (member.token) this.sessions.delete(member.token);
    if (room.humans().length === 0) {
      this.closeRoom(room, 'Oda boşaldı.');
      return;
    }
    if (room.hostSeat === member.seat) room.hostSeat = room.humans()[0].seat;
    room.broadcastRoom();
  }

  onDisconnect(socket) {
    const c = this.ctx(socket);
    if (!c) return;
    const { room, member } = c;
    member.connected = false;
    member.socketId = null;
    room.touch();
    if (!room.started) {
      member.graceTimer = setTimeout(() => {
        if (room.members[member.seat] === member && !member.connected) {
          this.removeMember(room, member);
        }
      }, LOBBY_GRACE_MS);
      if (member.graceTimer.unref) member.graceTimer.unref();
      room.broadcastRoom();
    } else {
      room.afterChange(); // diğer oyuncular bağlantı durumunu görür, sıra zamanlayıcısı güncellenir
    }
  }

  closeRoom(room, reason) {
    if (room.closed) return;
    room.closed = true;
    room.clearTimer();
    for (const m of room.humans()) {
      room.emitTo(m, 'closed', { reason });
      if (m.graceTimer) clearTimeout(m.graceTimer);
      if (m.token) this.sessions.delete(m.token);
    }
    this.rooms.delete(room.code);
  }

  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (room.connectedHumans().length === 0 && now - room.lastActive > IDLE_CLOSE_MS) {
        this.closeRoom(room, 'Oda uzun süre boş kaldığı için kapatıldı.');
      }
    }
  }

  // ------------------------------------------------------------------ sohbet
  chat(socket, d) {
    const c = this.ctx(socket);
    if (!c) return fail('Bir odada değilsin.');
    const text = cleanText(d.text);
    if (!text) return fail('Boş mesaj gönderilemez.');
    if (text.length > CHAT_MAX) return fail(`Mesaj en fazla ${CHAT_MAX} karakter olabilir.`);
    const now = Date.now();
    if (now - c.member.lastChat < CHAT_GAP_MS) return fail('Çok hızlı mesaj gönderiyorsun.');
    c.member.lastChat = now;
    c.room.touch();
    c.room.pushChat({ author: c.member.name, text, time: now });
    return ok('Gönderildi.');
  }

  // ----------------------------------------------------------------- hamleler
  act(socket, fn, broadcast = true) {
    const c = this.ctx(socket);
    if (!c) return fail('Bir odada değilsin.');
    const { room, member } = c;
    if (!room.game) return fail('Oyun henüz başlamadı.');
    room.touch();
    const res = fn(room.game, member.seat, room, member);
    if (broadcast) room.afterChange(); // ceza gibi durum değişiklikleri reddedilen hamlede de olabilir
    return res;
  }

  draw(socket) {
    return this.act(socket, (g, s) => g.draw(s));
  }

  takeSide(socket) {
    return this.act(socket, (g, s) => g.takeSide(s));
  }

  returnSide(socket) {
    return this.act(socket, (g, s) => g.returnSide(s));
  }

  previewOpen(socket, d) {
    const groups = parseGroups(d.groups);
    if (!groups) return fail('Geçersiz istek.');
    return this.act(socket, (g, s) => g.previewOpen(s, groups), false);
  }

  openGroups(socket, d) {
    const groups = parseGroups(d.groups);
    if (!groups) return fail('Geçersiz istek.');
    return this.act(socket, (g, s) => g.openGroups(s, groups));
  }

  processTile(socket, d) {
    const tile = parseTile(d.tile);
    if (tile === null || !Number.isInteger(d.meldId)) return fail('Geçersiz istek.');
    return this.act(socket, (g, s) => g.processTile(s, tile, d.meldId));
  }

  autoProcess(socket) {
    return this.act(socket, (g, s) => g.autoProcess(s));
  }

  processPair(socket, d) {
    if (!Array.isArray(d.tiles) || d.tiles.length !== 2 || !Number.isInteger(d.target)) {
      return fail('Geçersiz istek.');
    }
    const a = parseTile(d.tiles[0]);
    const b = parseTile(d.tiles[1]);
    if (a === null || b === null) return fail('Geçersiz istek.');
    return this.act(socket, (g, s) => g.processPair(s, a, b, d.target));
  }

  swapOkey(socket, d) {
    const tile = parseTile(d.tile);
    if (tile === null || !Number.isInteger(d.meldId) || !Number.isInteger(d.index)) {
      return fail('Geçersiz istek.');
    }
    return this.act(socket, (g, s) => g.swapOkey(s, tile, d.meldId, d.index));
  }

  gatherOpen(socket) {
    return this.act(socket, (g, s) => g.gatherOpen(s));
  }

  gatherTiles(socket) {
    return this.act(socket, (g, s) => g.gatherTiles(s));
  }

  discard(socket, d) {
    const tile = parseTile(d.tile);
    if (tile === null) return fail('Geçersiz istek.');
    return this.act(socket, (g, s) => g.discard(s, tile));
  }

  showIndicator(socket, d) {
    const tile = parseTile(d.tile);
    if (tile === null) return fail('Geçersiz istek.');
    return this.act(socket, (g, s) => g.showIndicator(s, tile));
  }

  placeIndicator(socket) {
    return this.act(socket, (g, s) => {
      if (g.phase !== 'indicator') return fail('Gösterge aşaması bitti.');
      if (g.starter !== s) return fail('Göstergeyi yalnızca başlayan oyuncu yerleştirebilir.');
      g.confirmIndicator();
      return ok('Gösterge yerleştirildi.');
    });
  }

  readyNext(socket) {
    return this.act(socket, (g, s, room, member) => room.readyNext(member), false);
  }
}

module.exports = { RoomManager, normalizeSettings };