'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../src/rooms');

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

async function lobby(t, { quick = false, hold } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const sent = [];
  let holds = 0;
  const mgr = new RoomManager({
    to: (id) => ({ emit: (event, data) => sent.push({ id, event, data }) }),
  }, {
    authenticate: async (token) => token,
    profile: async (id) => ({ id, name: id, carrots: 1000 }),
    hold: async (...args) => { holds++; return hold ? hold(...args) : { ok: true }; },
    settle: async () => true,
  });
  t.after(() => {
    for (const room of mgr.rooms.values()) mgr.closeRoom(room, 'test');
    clearInterval(mgr.sweeper);
  });
  const sockets = ['a', 'b', 'c', 'd'].map((id) => ({ id, data: {} }));
  const created = quick
    ? await mgr.quickPlay(sockets[0], { accountToken: 'a' })
    : await mgr.createRoom(sockets[0], {
      accountToken: 'a', password: 'test-pass',
      settings: { indicatorRule: false, turnSeconds: 0 },
    });
  const room = mgr.rooms.get(created.code);
  const join = async (index) => quick
    ? mgr.quickPlay(sockets[index], { accountToken: sockets[index].id })
    : mgr.joinRoom(sockets[index], {
      code: created.code, accountToken: sockets[index].id, password: 'test-pass',
    });
  return { mgr, room, sockets, join, sent, holds: () => holds };
}

for (const quick of [false, true]) {
  test(`${quick ? 'quick' : 'private'} room waits for four players, then starts after 20 seconds without ready votes`, async (t) => {
    const c = await lobby(t, { quick });
    await c.join(1);
    await c.join(2);
    assert.equal(c.room.lobbyStartDeadline, null);
    t.mock.timers.tick(25000);
    await flush();
    assert.equal(c.holds(), 0);
    await c.join(3);
    const info = c.room.roomInfo(c.room.members[0]);
    assert.equal(info.lobbyStartDeadline - info.serverTime, 20000);
    assert.equal(c.room.members.every((m) => !m.ready), true);
    t.mock.timers.tick(19999);
    await flush();
    assert.equal(c.room.started, false);
    assert.equal(c.holds(), 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(c.room.started, true);
    assert.equal(c.holds(), 1);
    assert.equal(c.room.lobbyStartDeadline, null);
  });
}

test('all four ready starts immediately; three votes including an unready host do not', async (t) => {
  const c = await lobby(t);
  for (const index of [1, 2, 3]) await c.join(index);
  for (const socket of c.sockets.slice(1)) c.mgr.setReady(socket, { ready: true });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(c.holds(), 0);
  c.mgr.setReady(c.sockets[0], { ready: true });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(c.room.started, true);
  assert.equal(c.holds(), 1);
});

test('withdrawing ready preserves the original deadline instead of extending the wait', async (t) => {
  const c = await lobby(t);
  for (const index of [1, 2, 3]) await c.join(index);
  const deadline = c.room.lobbyStartDeadline;
  t.mock.timers.tick(7000);
  for (const socket of c.sockets) c.mgr.setReady(socket, { ready: true });
  c.mgr.setReady(c.sockets[2], { ready: false });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(c.holds(), 0);
  assert.equal(c.room.lobbyStartDeadline, deadline);
  t.mock.timers.tick(13000);
  await flush();
  assert.equal(c.room.started, true);
  assert.equal(c.holds(), 1);
});

test('disconnect cancels countdown and reconnect begins a fresh full 20 seconds', async (t) => {
  const c = await lobby(t);
  let joined;
  for (const index of [1, 2, 3]) joined = await c.join(index);
  t.mock.timers.tick(7000);
  c.mgr.onDisconnect(c.sockets[3]);
  assert.equal(c.room.lobbyStartDeadline, null);
  t.mock.timers.tick(13000);
  await flush();
  assert.equal(c.holds(), 0);
  const socket = { id: 'd-resumed', data: {} };
  assert.equal((await c.mgr.resume(socket, { token: joined.token, accountToken: 'd' })).ok, true);
  assert.equal(c.room.lobbyStartDeadline, Date.now() + 20000);
  t.mock.timers.tick(19999);
  await flush();
  assert.equal(c.holds(), 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(c.room.started, true);
});

test('automatic and repeated manual starts cannot charge the same match twice', async (t) => {
  let finishHold;
  const c = await lobby(t, { hold: () => new Promise((resolve) => { finishHold = resolve; }) });
  for (const index of [1, 2, 3]) await c.join(index);
  for (const socket of c.sockets) c.mgr.setReady(socket, { ready: true });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(c.holds(), 1);
  assert.equal((await c.mgr.startGame(c.sockets[0])).ok, false);
  assert.equal(c.mgr.setReady(c.sockets[1], { ready: false }).ok, false);
  finishHold({ ok: true });
  await flush();
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(c.room.started, true);
  assert.equal(c.holds(), 1);
});

test('failed balance check removes the poor player and does not retry payments in a loop', async (t) => {
  const c = await lobby(t, {
    hold: async () => ({ ok: false, message: 'Yetersiz bakiye.', insufficient: [{ id: 'c', balance: 104 }] }),
  });
  for (const index of [1, 2, 3]) await c.join(index);
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(c.room.started, false);
  assert.equal(c.room.members[2], null);
  assert.equal(c.room.lobbyStartDeadline, null);
  assert.equal(c.holds(), 1);
  c.room.broadcastRoom();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(c.holds(), 1);
});

test('after match results the same room starts a new 20-second countdown only once everyone returns', async (t) => {
  const c = await lobby(t);
  for (const index of [1, 2, 3]) await c.join(index);
  c.room.settings.totalRounds = 1;
  for (const socket of c.sockets.slice(1)) c.mgr.setReady(socket, { ready: true });
  assert.equal((await c.mgr.startGame(c.sockets[0])).ok, true);
  c.room.game.phase = 'finished';
  c.room.afterChange();
  for (const socket of c.sockets.slice(0, 3)) assert.equal(c.mgr.returnLobby(socket).ok, true);
  assert.equal(c.room.lobbyStartDeadline, null);
  t.mock.timers.tick(25000);
  await flush();
  assert.equal(c.holds(), 1);
  assert.equal(c.mgr.returnLobby(c.sockets[3]).ok, true);
  assert.equal(c.room.lobbyStartDeadline, Date.now() + 20000);
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(c.room.started, true);
  assert.equal(c.holds(), 2);
  assert.equal(c.room.game.round, 1);
});

test('a failed payment with all four seats occupied waits for a new ready action before retrying', async (t) => {
  const c = await lobby(t, { hold: async () => ({ ok: false, message: 'Ödeme başarısız.' }) });
  for (const index of [1, 2, 3]) await c.join(index);
  for (const socket of c.sockets) c.mgr.setReady(socket, { ready: true });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(c.holds(), 1);
  assert.equal(c.room.started, false);
  assert.equal(c.room.lobbyStartMessage, 'Ödeme başarısız.');
  assert.equal(c.room.lobbyStartDeadline, null);
  c.room.broadcastRoom();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(c.holds(), 1);
  c.mgr.setReady(c.sockets[0], { ready: false });
  c.mgr.setReady(c.sockets[0], { ready: true });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(c.holds(), 2);
});

test('next hand waits 20 seconds at most and still starts immediately when everyone continues', async (t) => {
  const c = await lobby(t);
  for (const index of [1, 2, 3]) await c.join(index);
  for (const socket of c.sockets.slice(1)) c.mgr.setReady(socket, { ready: true });
  assert.equal((await c.mgr.startGame(c.sockets[0])).ok, true);
  c.room.game.phase = 'finished';
  c.room.afterChange();
  t.mock.timers.tick(19999);
  await flush();
  assert.equal(c.room.game.round, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(c.room.game.round, 2);
  c.room.game.phase = 'finished';
  c.room.afterChange();
  for (const socket of c.sockets) c.mgr.readyNext(socket);
  assert.equal(c.room.game.round, 3);
  assert.equal(c.holds(), 1);
});
