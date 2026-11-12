'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { RoomManager, normalizeSettings } = require('../src/rooms');

// Sahte Socket.IO: gönderilen olayları kaydeder.
function fakeIo() {
  const sent = [];
  return {
    sent,
    to(id) {
      return { emit: (ev, data) => sent.push({ id, ev, data }) };
    },
  };
}
const sock = (id) => ({ id, data: {} });

function setup() {
  const io = fakeIo();
  const mgr = new RoomManager(io, {
    authenticate: async (token) => token || null,
    holdRoom: async (_, payer) => payer === 'poor' ? { ok: false } : { ok: true },
    setRoomPlayers: async () => true,
    settle: async () => true,
    profile: async (id) => ({ id, name: id === 'a' ? 'Ali' : id === 'b' ? 'Veli' : id, carrots: 100 }),
  });
  return { io, mgr };
}

async function startedRoom(mgr, settings = { indicatorRule: false }) {
  const a = sock('a');
  const b = sock('b');
  const r = await mgr.createRoom(a, { accountToken: 'a', password: 'test-pass', playerName: 'Ali', roomName: 'O', settings });
  const j = await mgr.joinRoom(b, { accountToken: 'b', password: 'test-pass', playerName: 'Veli', code: r.code });
  mgr.setReady(b, { ready: true });
  await mgr.startGame(a);
  return { a, b, r, j, room: mgr.rooms.get(r.code) };
}

test('oda kurma ve kodla katılma', async () => {
  const { mgr } = setup();
  const a = sock('a');
  const r = await mgr.createRoom(a, { accountToken: 'a', password: 'test-pass', playerName: 'Ali', roomName: 'Deneme', settings: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code.length, 5);
  const j = await mgr.joinRoom(sock('b'), { accountToken: 'b', password: 'test-pass', playerName: 'Veli', code: r.code.toLowerCase() });
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.seat, 1);
  assert.strictEqual((await mgr.joinRoom(sock('c'), { accountToken: 'c', password: 'test-pass', playerName: 'X', code: 'YOKYO' })).ok, false);
  clearInterval(mgr.sweeper);
});

test('kuralları yalnızca oda sahibi değiştirir', async () => {
  const { mgr } = setup();
  const a = sock('a');
  const b = sock('b');
  const r = await mgr.createRoom(a, { accountToken: 'a', password: 'test-pass', playerName: 'Ali', roomName: 'O', settings: {} });
  await mgr.joinRoom(b, { accountToken: 'b', password: 'test-pass', playerName: 'Veli', code: r.code });
  assert.strictEqual(mgr.updateSettings(b, { settings: { folding: true } }).ok, false);
  assert.strictEqual(
    mgr.updateSettings(a, { settings: { folding: true, totalRounds: 4, partnerFolding: false } }).ok,
    true
  );
  const s = mgr.rooms.get(r.code).settings;
  assert.strictEqual(s.folding, true);
  assert.strictEqual(s.totalRounds, 4);
  assert.strictEqual(s.partnerFolding, false);
  clearInterval(mgr.sweeper);
});

test('oyunu yalnızca oda sahibi ve herkes hazırken başlatır, sonra kural değişmez', async () => {
  const { mgr } = setup();
  const a = sock('a');
  const b = sock('b');
  const r = await mgr.createRoom(a, { accountToken: 'a', password: 'test-pass', playerName: 'Ali', roomName: 'O', settings: { indicatorRule: false } });
  await mgr.joinRoom(b, { accountToken: 'b', password: 'test-pass', playerName: 'Veli', code: r.code });
  assert.strictEqual((await mgr.startGame(b)).ok, false);
  assert.strictEqual((await mgr.startGame(a)).ok, false);
  mgr.setReady(b, { ready: true });
  assert.strictEqual((await mgr.startGame(a)).ok, true);
  const room = mgr.rooms.get(r.code);
  assert.strictEqual(room.members.every(Boolean), true);
  assert.strictEqual(room.members.filter((m) => m.isBot).length, 2);
  assert.strictEqual(mgr.updateSettings(a, { settings: { folding: true } }).ok, false);
  assert.strictEqual((await mgr.joinRoom(sock('c'), { accountToken: 'c', password: 'test-pass', playerName: 'Z', code: r.code })).ok, false);
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('durum senkronu: her oyuncu yalnızca kendi elini alır, süre bilgisi gelir', async () => {
  const { io, mgr } = setup();
  const { room } = await startedRoom(mgr);
  const states = io.sent.filter((e) => e.ev === 'state');
  const sa = states.filter((e) => e.id === 'a').pop().data;
  const sb = states.filter((e) => e.id === 'b').pop().data;
  assert.strictEqual(sa.mySeat, 0);
  assert.strictEqual(sb.mySeat, 1);
  assert.deepStrictEqual(sa.myHand, room.game.players[0].hand);
  assert.deepStrictEqual(sb.myHand, room.game.players[1].hand);
  assert.notDeepStrictEqual(sa.myHand, sb.myHand);
  assert.strictEqual(sa.players.every((p) => p.hand === undefined), true);
  assert.ok(sa.turnDeadline > sa.serverTime);
  assert.strictEqual(room.turnBase, 30000);
  assert.strictEqual(sa.canGatherOpen, false);
  assert.strictEqual(sa.canGatherTiles, false);
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('gösterge sunumu sahibinden doğrulanır ve odadaki oyunculara bildirilir', async () => {
  const { io, mgr } = setup();
  const { a, b, room } = await startedRoom(mgr, { indicatorRule: true });
  const g = room.game;
  const indicator = 5;
  const heldTile = 18;
  g.pendingIndicator = indicator;
  g.players[0].hand = [heldTile];
  g.players[1].hand = [];

  assert.strictEqual(mgr.showIndicator(b, { tile: heldTile }).ok, false);
  assert.strictEqual(mgr.showIndicator(a, { tile: 106 }).ok, false);
  assert.strictEqual(mgr.showIndicator(a, { tile: heldTile }).ok, true);
  assert.strictEqual(g.indicatorShownBy, 0);
  assert.deepStrictEqual(g.players[0].hand, [heldTile]);
  assert.strictEqual(g.phase, 'indicator');

  const states = io.sent.filter((e) => e.ev === 'state');
  const stateA = states.filter((e) => e.id === 'a').pop().data;
  const stateB = states.filter((e) => e.id === 'b').pop().data;
  assert.strictEqual(stateA.indicatorShownBy, 0);
  assert.strictEqual(stateB.indicatorShownBy, 0);
  assert.strictEqual(stateB.players[0].hand, undefined);
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('sırası gelmeyen oyuncunun hamlesi sunucuda reddedilir', async () => {
  const { mgr } = setup();
  const { a, b, room } = await startedRoom(mgr);
  assert.strictEqual(room.game.current, 0);
  assert.strictEqual(mgr.draw(b).ok, false);
  const tile = room.game.players[1].hand[0];
  assert.strictEqual(mgr.discard(b, { tile }).ok, false);
  assert.strictEqual(mgr.discard(a, { tile: 999 }).ok, false);
  assert.strictEqual(mgr.returnSide(b).ok, false);
  assert.strictEqual(mgr.gatherOpen(b).ok, false);
  assert.strictEqual(mgr.gatherTiles(b).ok, false);
  assert.strictEqual(mgr.autoProcess(b).ok, false);
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('geçersiz istekler reddedilir (çift işleme, okey alma)', async () => {
  const { mgr } = setup();
  const { a, room } = await startedRoom(mgr);
  assert.strictEqual(mgr.processPair(a, { tiles: [1], target: 1 }).ok, false);
  assert.strictEqual(mgr.processPair(a, { tiles: [1, 999], target: 1 }).ok, false);
  assert.strictEqual(mgr.swapOkey(a, { tile: 'x', meldId: 1, index: 0 }).ok, false);
  assert.strictEqual(mgr.processPair(a, { tiles: [1, 2], target: 1 }).ok, false); // açmamış
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('süre dolunca otomatik atış yapılır ve sıra ilerler', async () => {
  const { mgr } = setup();
  const { room } = await startedRoom(mgr);
  const g = room.game;
  assert.strictEqual(g.current, 0);
  const before = g.players[0].hand.length;
  room.autoPlay(0);
  assert.strictEqual(g.players[0].hand.length, before - 1);
  assert.strictEqual(g.discards[0].length, 1);
  assert.notStrictEqual(g.current, 0);
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('bağlantı kopması ve yeniden bağlanma aynı koltuğa döner', async () => {
  const { mgr } = setup();
  const { b, j, room } = await startedRoom(mgr);
  mgr.onDisconnect(b);
  assert.strictEqual(room.members[1].connected, false);
  assert.strictEqual(mgr.draw(b).ok, false);
  const res = await mgr.resume(sock('b2'), { token: j.token, accountToken: 'b' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.seat, 1);
  assert.strictEqual(room.members[1].connected, true);
  assert.strictEqual((await mgr.resume(sock('x'), { token: 'sahte' })).ok, false);
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('resume cannot switch an active socket to another room', async () => {
  const { mgr } = setup();
  const a = sock('a');
  const b = sock('b');
  const first = await mgr.createRoom(a, { accountToken: 'a', password: 'test-pass', playerName: 'Ali', roomName: 'Bir', settings: {} });
  const second = await mgr.createRoom(b, { accountToken: 'b', password: 'test-pass', playerName: 'Veli', roomName: 'Iki', settings: {} });

  const res = await mgr.resume(a, { token: second.token });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(mgr.ctx(a).room.code, first.code);
  assert.strictEqual(mgr.ctx(b).room.code, second.code);
  clearInterval(mgr.sweeper);
});

test('oyun sırasında ayrılan oyuncunun yerine bot geçer', async () => {
  const { mgr } = setup();
  const { b, room } = await startedRoom(mgr);
  mgr.leaveRoom(b);
  assert.strictEqual(room.members[1].isBot, true);
  assert.strictEqual(room.game.players[1].isBot, true);
  room.clearTimer();
  clearInterval(mgr.sweeper);
});

test('sohbet: boş, uzun ve hızlı mesajlar reddedilir', async () => {
  const { io, mgr } = setup();
  const a = sock('a');
  await mgr.createRoom(a, { accountToken: 'a', password: 'test-pass', playerName: 'Ali', roomName: 'O', settings: {} });
  assert.strictEqual(mgr.chat(a, { text: '   ' }).ok, false);
  assert.strictEqual(mgr.chat(a, { text: 'x'.repeat(121) }).ok, false);
  assert.strictEqual(mgr.chat(a, { text: 'merhaba' }).ok, true);
  assert.strictEqual(mgr.chat(a, { text: 'tekrar' }).ok, false);
  const msg = io.sent.filter((e) => e.ev === 'chat').pop().data;
  assert.strictEqual(msg.author, 'Ali');
  assert.strictEqual(msg.text, 'merhaba');
  clearInterval(mgr.sweeper);
});

test('ayarlar sabit ceza ve çift kurallarını korur', async () => {
  const s = normalizeSettings({
    pairThreshold: 6,
    wrongOpenPenalty: 0,
    sideTakePenalty: 202,
    workablePenalty: 0,
    folding: 'evet',
    totalRounds: 7,
  });
  assert.strictEqual(s.pairThreshold, 5);
  assert.strictEqual(s.wrongOpenPenalty, 101);
  assert.strictEqual(s.sideTakePenalty, 101);
  assert.strictEqual(s.folding, false);
  assert.strictEqual(s.assisted, true);
  assert.strictEqual(s.partnerFolding, true);
  assert.strictEqual(s.totalRounds, 8);
  assert.strictEqual(s.sideTakePenalty, 101);
  assert.strictEqual(s.workablePenalty, 101);
  assert.strictEqual(normalizeSettings({ totalRounds: 20 }).totalRounds, 20);
  assert.strictEqual(normalizeSettings({ partnerFolding: false }).partnerFolding, false);
  assert.strictEqual(normalizeSettings({
    pairThreshold: 4,
    wrongOpenPenalty: 202,
    sideTakePenalty: 202,
    workablePenalty: 202,
  }).workablePenalty, 101);
});
test('public directory exposes waiting room metadata without private state', async () => {
  const { mgr } = setup();
  const a = sock('directory-a');
  const created = await mgr.createRoom(a, { accountToken: 'a', password: 'test-pass', playerName: 'Ali', roomName: 'Public', settings: {} });
  const listed = mgr.listRooms();
  assert.strictEqual(listed.ok, true);
  assert.strictEqual(listed.rooms.length, 1);
  assert.deepStrictEqual(Object.keys(listed.rooms[0]).sort(), ['assisted', 'carrotEntry', 'code', 'count', 'folding', 'locked', 'name', 'totalRounds']);
  assert.strictEqual(listed.rooms[0].code, created.code);
  assert.strictEqual(listed.rooms[0].count, 1);
  await mgr.startGame(a);
  assert.strictEqual(mgr.listRooms().rooms.length, 0);
  mgr.closeRoom(mgr.rooms.get(created.code), 'test');
  clearInterval(mgr.sweeper);
});

test('bot süresi ve bot sonrası oyuncunun süresi ilk durum paketinde görünür', async () => {
  const { io, mgr } = setup();
  const { room } = await startedRoom(mgr);
  try {
    room.game.current = 2;
    room.game.turnNo++;
    room.afterChange();
    const botView = io.sent.filter((e) => e.id === 'a' && e.ev === 'state').pop().data;
    assert.ok(botView.turnDeadline - botView.serverTime >= 29000);
    room.botBusy = true;
    room.turnStart -= 20000;
    room.turnDeadline -= 20000;
    room.game.current = 0;
    room.game.turnNo++;
    room.afterChange();
    const humanView = io.sent.filter((e) => e.id === 'a' && e.ev === 'state').pop().data;
    assert.strictEqual(humanView.current, 0);
    assert.ok(humanView.turnDeadline - humanView.serverTime >= 29000);
  } finally {
    room.clearTimer();
    clearInterval(mgr.sweeper);
  }
});
test('manual rooms require a password and never disclose it', async (t) => {
  const { mgr, io } = setup();
  t.after(() => clearInterval(mgr.sweeper));
  const host = sock('host');
  assert.equal((await mgr.createRoom(host, {})).ok, false);
  const created = await mgr.createRoom(host, { accountToken: 'host', password: 'secret-room' });
  assert.equal(created.ok, true);
  assert.equal((await mgr.joinRoom(sock('wrong'), { accountToken: 'wrong',
    code: created.code, password: 'incorrect',
  })).ok, false);
  assert.equal((await mgr.joinRoom(sock('missing'), { code: created.code })).ok, false);
  assert.equal((await mgr.joinRoom(sock('right'), { accountToken: 'right',
    code: created.code, password: 'secret-room',
  })).ok, true);
  assert.ok(!JSON.stringify(io.sent).includes('secret-room'));
});

test('quick play checks balance and atomically assigns available seats', async (t) => {
  const { mgr } = setup();
  t.after(() => clearInterval(mgr.sweeper));
  mgr.accountFor = async (token) => token && ({
    id: token, name: token, carrots: token === 'poor' ? 99 : 100,
  });
  const manual = await mgr.createRoom(sock('manual'), {
    password: 'secret-room', carrotEntry: true, accountToken: 'manual',
  });
  assert.equal((await mgr.quickPlay(sock('guest'), {})).ok, false);
  assert.equal((await mgr.quickPlay(sock('poor'), { accountToken: 'poor' })).ok, false);
  const matches = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) =>
    mgr.quickPlay(sock(id), { accountToken: id })));
  assert.ok(matches.every((result) => result.ok));
  assert.ok(matches.slice(0, 4).every((result) => result.code === matches[0].code));
  assert.equal(new Set(matches.slice(0, 4).map((result) => result.seat)).size, 4);
  assert.notEqual(matches[0].code, manual.code);
  assert.notEqual(matches[4].code, matches[0].code);
  assert.equal((await mgr.quickPlay(sock('e-other'), { accountToken: 'e' })).ok, false);
  assert.equal((await mgr.joinRoom(sock('direct'), { code: matches[0].code })).ok, false);
  assert.deepEqual(mgr.listRooms().rooms.map((room) => room.code), [manual.code]);
});

test('players return to the same lobby without dismissing others’ results', async (t) => {
  const { mgr } = setup();
  const { a, b, room } = await startedRoom(mgr, { indicatorRule: false, totalRounds: 1 });
  t.after(() => { room.clearTimer(); clearInterval(mgr.sweeper); });
  assert.equal(mgr.returnLobby(a).ok, false);
  room.game.phase = 'finished';
  assert.equal(mgr.returnLobby(a).ok, true);
  assert.equal(room.roomInfo(room.members[0]).waitingForLobby, true);
  assert.equal(room.roomInfo(room.members[1]).started, true);
  assert.equal(mgr.returnLobby(b).ok, true);
  assert.equal(room.started, false);
  assert.equal(room.game, null);
  assert.equal(room.humans().length, 2);
  assert.ok(room.humans().every((member) => !member.ready && !member.inLobby));
  assert.equal(mgr.setReady(b, { ready: true }).ok, true);
  assert.equal((await mgr.startGame(a)).ok, true);
});

test('online odada hesap zorunludur ve dönüş aynı hesabı gerektirir', async (t) => {
  const { mgr } = setup();
  t.after(() => clearInterval(mgr.sweeper));
  const host = sock('host');
  const guest = sock('guest');
  const password = 'test-pass';
  assert.match((await mgr.createRoom(host, { password })).message, /hesabına giriş/);
  const created = await mgr.createRoom(host, { password, accountToken: 'host' });
  assert.equal(created.ok, true);
  const join = { code: created.code, password };
  assert.match((await mgr.joinRoom(guest, join)).message, /hesabına giriş/);
  const entered = await mgr.joinRoom(guest, { ...join, accountToken: 'guest' });
  assert.equal(entered.ok, true);
  assert.equal((await mgr.resume(sock('wrong'), {
    token: entered.token, accountToken: 'other-account',
  })).ok, false);
  assert.equal((await mgr.resume(sock('new-connection'), {
    token: entered.token, accountToken: 'guest',
  })).ok, true);
});
