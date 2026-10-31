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
    const mgr = new RoomManager(io);
    return { io, mgr };
}

function startedRoom(mgr, settings = { indicatorRule: false }) {
    const a = sock('a');
    const b = sock('b');
    const r = mgr.createRoom(a, { playerName: 'Ali', roomName: 'O', settings });
    const j = mgr.joinRoom(b, { playerName: 'Veli', code: r.code });
    mgr.setReady(b, { ready: true });
    mgr.startGame(a);
    return { a, b, r, j, room: mgr.rooms.get(r.code) };
}

test('oda kurma ve kodla katılma', () => {
    const { mgr } = setup();
    const a = sock('a');
    const r = mgr.createRoom(a, { playerName: 'Ali', roomName: 'Deneme', settings: {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code.length, 5);
    const j = mgr.joinRoom(sock('b'), { playerName: 'Veli', code: r.code.toLowerCase() });
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.seat, 1);
    assert.strictEqual(mgr.joinRoom(sock('c'), { playerName: 'X', code: 'YOKYO' }).ok, false);
    clearInterval(mgr.sweeper);
});

test('kuralları yalnızca oda sahibi değiştirir', () => {
    const { mgr } = setup();
    const a = sock('a');
    const b = sock('b');
    const r = mgr.createRoom(a, { playerName: 'Ali', roomName: 'O', settings: {} });
    mgr.joinRoom(b, { playerName: 'Veli', code: r.code });
    assert.strictEqual(mgr.updateSettings(b, { settings: { folding: true } }).ok, false);
    assert.strictEqual(mgr.updateSettings(a, { settings: { folding: true, totalRounds: 4 } }).ok, true);
    const s = mgr.rooms.get(r.code).settings;
    assert.strictEqual(s.folding, true);
    assert.strictEqual(s.totalRounds, 4);
    clearInterval(mgr.sweeper);
});

test('oyunu yalnızca oda sahibi ve herkes hazırken başlatır, sonra kural değişmez', () => {
    const { mgr } = setup();
    const a = sock('a');
    const b = sock('b');
    const r = mgr.createRoom(a, { playerName: 'Ali', roomName: 'O', settings: { indicatorRule: false } });
    mgr.joinRoom(b, { playerName: 'Veli', code: r.code });
    assert.strictEqual(mgr.startGame(b).ok, false);
    assert.strictEqual(mgr.startGame(a).ok, false);
    mgr.setReady(b, { ready: true });
    assert.strictEqual(mgr.startGame(a).ok, true);
    const room = mgr.rooms.get(r.code);
    assert.strictEqual(room.members.every(Boolean), true);
    assert.strictEqual(room.members.filter((m) => m.isBot).length, 2);
    assert.strictEqual(mgr.updateSettings(a, { settings: { folding: true } }).ok, false);
    assert.strictEqual(mgr.joinRoom(sock('c'), { playerName: 'Z', code: r.code }).ok, false);
    room.clearTimer();
    clearInterval(mgr.sweeper);
});

test('durum senkronu: her oyuncu yalnızca kendi elini alır, süre bilgisi gelir', () => {
    const { io, mgr } = setup();
    const { room } = startedRoom(mgr);
    const states = io.sent.filter((e) => e.ev === 'state');
    const sa = states.filter((e) => e.id === 'a').pop().data;
    const sb = states.filter((e) => e.id === 'b').pop().data;
    assert.strictEqual(sa.mySeat, 0);
    assert.strictEqual(sb.mySeat, 1);
    assert.deepStrictEqual(sa.myHand, room.game.players[0].hand);
    assert.deepStrictEqual(sb.myHand, room.game.players[1].hand);
    assert.notDeepStrictEqual(sa.myHand, sb.myHand);
    assert.strictEqual(sa.players.every((p) => p.hand === undefined), true);
    assert.ok(sa.turnDeadline > sa.serverTime); // sırası gelen oyuncunun süresi var
    room.clearTimer();
    clearInterval(mgr.sweeper);
});

test('sırası gelmeyen oyuncunun hamlesi sunucuda reddedilir', () => {
    const { mgr } = setup();
    const { a, b, room } = startedRoom(mgr);
    assert.strictEqual(room.game.current, 0);
    assert.strictEqual(mgr.draw(b).ok, false);
    const tile = room.game.players[1].hand[0];
    assert.strictEqual(mgr.discard(b, { tile }).ok, false);
    assert.strictEqual(mgr.discard(a, { tile: 999 }).ok, false);
    assert.strictEqual(mgr.returnSide(b).ok, false);
    room.clearTimer();
    clearInterval(mgr.sweeper);
});

test('süre dolunca otomatik atış yapılır ve sıra ilerler', () => {
    const { mgr } = setup();
    const { room } = startedRoom(mgr);
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

test('bağlantı kopması ve yeniden bağlanma aynı koltuğa döner', () => {
    const { mgr } = setup();
    const { b, j, room } = startedRoom(mgr);
    mgr.onDisconnect(b);
    assert.strictEqual(room.members[1].connected, false);
    assert.strictEqual(mgr.draw(b).ok, false);
    const res = mgr.resume(sock('b2'), { token: j.token });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.seat, 1);
    assert.strictEqual(room.members[1].connected, true);
    assert.strictEqual(mgr.resume(sock('x'), { token: 'sahte' }).ok, false);
    room.clearTimer();
    clearInterval(mgr.sweeper);
});

test('oyun sırasında ayrılan oyuncunun yerine bot geçer', () => {
    const { mgr } = setup();
    const { b, room } = startedRoom(mgr);
    mgr.leaveRoom(b);
    assert.strictEqual(room.members[1].isBot, true);
    assert.strictEqual(room.game.players[1].isBot, true);
    room.clearTimer();
    clearInterval(mgr.sweeper);
});

test('sohbet: boş, uzun ve hızlı mesajlar reddedilir', () => {
    const { io, mgr } = setup();
    const a = sock('a');
    mgr.createRoom(a, { playerName: 'Ali', roomName: 'O', settings: {} });
    assert.strictEqual(mgr.chat(a, { text: '   ' }).ok, false);
    assert.strictEqual(mgr.chat(a, { text: 'x'.repeat(121) }).ok, false);
    assert.strictEqual(mgr.chat(a, { text: 'merhaba' }).ok, true);
    assert.strictEqual(mgr.chat(a, { text: 'tekrar' }).ok, false);
    const msg = io.sent.filter((e) => e.ev === 'chat').pop().data;
    assert.strictEqual(msg.author, 'Ali');
    assert.strictEqual(msg.text, 'merhaba');
    clearInterval(mgr.sweeper);
});

test('ayarlar doğrulanır, geçersiz değerler varsayılana döner', () => {
    const s = normalizeSettings({
        pairThreshold: 99, wrongOpenPenalty: 'x', folding: 'evet', totalRounds: 7,
    });
    assert.strictEqual(s.pairThreshold, 5);
    assert.strictEqual(s.wrongOpenPenalty, 101);
    assert.strictEqual(s.folding, false);
    assert.strictEqual(s.assisted, true);
    assert.strictEqual(s.totalRounds, 8);
    assert.strictEqual(s.workablePenalty, 101);
    assert.strictEqual(normalizeSettings({ totalRounds: 20 }).totalRounds, 20);
});