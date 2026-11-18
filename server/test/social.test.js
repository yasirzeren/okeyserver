'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../src/wallet');
const { Social } = require('../src/social');
const { RoomManager } = require('../src/rooms');

test('friend requests need recipient approval and invitations enforce room and account rules', async () => {
  const wallet = new Wallet(':memory:');
  const social = new Social(wallet);
  await social.initialize();
  await social.initialize();
  const users = [];
  for (let i = 0; i < 5; i++) {
    users.push(wallet.register({ email: `friend${i}@example.test`, name: `Friend ${i}`, password: 'fixture-1234' }));
  }
  const [a, b, c, d, e] = users;
  const manager = new RoomManager({ to: () => ({ emit() {} }) }, wallet);
  manager.social = social;
  const socket = (id) => ({ id, data: {}, connected: true });
  const host = socket('host');
  try {
    assert.equal((await social.list('invalid')).ok, false);
    assert.equal((await social.request(a.token, a.profile.id)).ok, false);
    assert.equal((await social.request(a.token, b.profile.playerCode)).ok, true);
    assert.equal((await social.request(a.token, b.profile.playerCode)).ok, false);
    assert.equal((await social.respond(a.token, b.profile.id, true)).ok, false);
    assert.equal((await social.respond(c.token, a.profile.id, true)).ok, false);
    assert.equal((await social.list(b.token)).incoming.length, 1);
    assert.equal((await social.respond(b.token, a.profile.id, true)).ok, true);
    const list = await social.list(a.token);
    assert.equal(list.playerId, a.profile.playerCode);
    assert.deepEqual(list.friends, [{ id: b.profile.id, name: b.profile.name }]);
    assert.equal(JSON.stringify(list).includes('@example.test'), false);

    const created = await manager.createRoom(host, {
      accountToken: a.token, password: 'private-room', roomName: 'Friends', settings: {},
    });
    assert.equal(created.ok, true);
    const room = manager.rooms.get(created.code);
    assert.equal((await manager.inviteFriend({ token: c.token, code: room.code, target: b.profile.id })).ok, false);
    assert.equal((await manager.inviteFriend({ token: a.token, code: room.code, target: c.profile.id })).ok, false);
    assert.equal((await manager.inviteFriend({ token: a.token, code: room.code, target: b.profile.id })).ok, true);
    const invite = (await social.list(b.token)).invites[0];
    assert.equal((await manager.joinInvite(socket('thief'), { accountToken: c.token, id: invite.id })).ok, false);

    wallet.db.prepare('UPDATE accounts SET carrots = 104 WHERE id = ?').run(b.profile.id);
    assert.equal((await manager.joinInvite(socket('poor'), { accountToken: b.token, id: invite.id })).ok, false);
    wallet.db.prepare('UPDATE accounts SET carrots = 1000 WHERE id = ?').run(b.profile.id);
    const guest = socket('guest');
    assert.equal((await manager.joinInvite(guest, { accountToken: b.token, id: invite.id })).ok, true);
    assert.equal((await manager.joinInvite(socket('duplicate'), { accountToken: b.token, id: invite.id })).ok, false);
    assert.equal(wallet.profile(b.profile.id).carrots, 1000);
    for (const [user, id] of [[c, 'c'], [d, 'd']]) {
      assert.equal((await manager.joinRoom(socket(id), {
        accountToken: user.token, code: room.code, password: 'private-room',
      })).ok, true);
    }
    await social.request(a.token, e.profile.id);
    await social.respond(e.token, a.profile.id, true);
    assert.equal((await manager.inviteFriend({ token: a.token, code: room.code, target: e.profile.id })).ok, false);
    // A valid stored invitation also cannot force its way into a full room.
    await social.invite(a.profile.id, e.profile.id, room);
    const extra = (await social.list(e.token)).invites[0];
    assert.equal((await manager.joinInvite(socket('full'), { accountToken: e.token, id: extra.id })).ok, false);
    room.started = true;
    assert.equal((await manager.joinInvite(socket('started'), { accountToken: e.token, id: extra.id })).ok, false);
    room.started = false;
    room.inviteKey = 'recreated-room';
    assert.equal((await manager.joinInvite(socket('stale'), { accountToken: e.token, id: extra.id })).ok, false);
    await social.dismiss(e.token, extra.id);
    assert.equal((await social.list(e.token)).invites.length, 0);
    await social.db.run('UPDATE friend_invites SET expires = 0');
    assert.equal((await social.list(b.token)).invites.length, 0);
  } finally {
    clearInterval(manager.sweeper);
    for (const room of manager.rooms.values()) room.clearTimer();
    wallet.db.close();
  }
});

test('friend persistence uses PostgreSQL and survives service reconstruction', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const { PostgresWallet } = require('../src/postgres_wallet');
  const database = new PGlite();
  const wallet = new PostgresWallet({
    query: (sql, args) => database.query(sql, args),
    connect: async () => ({ query: (sql, args) => database.query(sql, args), release() {} }),
    end: () => database.close(),
  });
  wallet.db.exec = (sql) => database.exec(sql);
  try {
    await wallet.initialize();
    const social = new Social(wallet);
    await social.initialize();
    const a = await wallet.register({email:'social-a@example.test', name:'A', password:'fixture-1234'});
    const b = await wallet.register({email:'social-b@example.test', name:'B', password:'fixture-1234'});
    assert.equal((await social.request(a.token, b.profile.playerCode)).ok, true);
    assert.equal((await social.respond(b.token, a.profile.id, true)).ok, true);
    const restored = new Social(wallet);
    await restored.initialize();
    assert.equal((await restored.list(b.token)).friends[0].id, a.profile.id);
    assert.equal((await wallet.profile(b.profile.id)).playerCode, b.profile.playerCode);
    assert.equal((await restored.invite(a.profile.id, b.profile.id, {code:'ABCDE', inviteKey:'one'})).ok, true);
    assert.equal((await restored.list(b.token)).invites.length, 1);
  } finally {
    await database.close();
  }
});
