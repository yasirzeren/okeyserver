'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../src/rooms');
const { Wallet } = require('../src/wallet');
const { Market } = require('../src/market');

test('emoji reactions validate ownership, target and current socket, broadcast seats, and rate-limit races', async () => {
  const wallet = new Wallet(':memory:');
  const messages = [];
  const manager = new RoomManager({ to: socketId => ({ emit: (event, data) => messages.push({ socketId, event, data }) }) }, wallet);
  const market = manager.market = new Market(wallet);
  const socket = { id: 's0', data: {} }, other = { id: 's1', data: {} };
  try {
    const user = wallet.register({ email: 'sender@example.test', name: 'Sender', password: 'fixture-pass-2026' });
    const target = wallet.register({ email: 'target@example.test', name: 'Target', password: 'fixture-pass-2026' });
    const created = await manager.createRoom(socket, { password: 'room-pass', accountToken: user.token });
    assert.equal(created.ok, true);
    assert.equal((await manager.joinRoom(other, { code: created.code, password: 'room-pass', accountToken: target.token })).ok, true);
    const room = manager.rooms.get(created.code), member = manager.ctx(socket).member;
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 })).ok, false);
    assert.equal((await market.buy(user.token, { emojiId: 'bunny_face', requestId: 'reaction_purchase_01' })).ok, true);
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'arbitrary', targetSeat: 1 })).ok, false);
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 3 })).ok, false);
    assert.equal((await manager.sendEmoji({ id: 'forged', data: socket.data }, { emojiId: 'bunny_face', targetSeat: 1 })).ok, false);
    messages.length = 0;
    const raced = await Promise.all([manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 }), manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 })]);
    assert.equal(raced.filter(row => row.ok).length, 1);
    const reactions = messages.filter(row => row.event === 'emoji_reaction');
    assert.equal(reactions.length, 2);
    assert.equal(reactions[0].data.id, reactions[1].data.id);
    assert.equal(reactions[0].data.fromSeat, 0);
    assert.equal(reactions[0].data.targetSeat, 1);
    assert.equal(reactions[0].data.glyph, '🐰');
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 })).ok, false);
    member.lastEmoji = Date.now() - 3001;
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 })).ok, true);
    member.lastEmoji = 0;
    wallet.db.prepare('UPDATE market_inventory SET expires = 0 WHERE account_id = ?').run(user.profile.id);
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 })).ok, false);
    wallet.db.prepare('UPDATE market_inventory SET expires = ? WHERE account_id = ?').run(Date.now() + 60000, user.profile.id);
    wallet.db.prepare("INSERT INTO account_controls VALUES (?, 'banned', 'test', ?)").run(user.profile.id, Date.now());
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 })).ok, false);
    // A membership change while the asynchronous ownership check is in flight
    // must not send to a newly substituted player.
    manager.market = { canUse: async () => { room.members[1] = null; return true; } };
    assert.equal((await manager.sendEmoji(socket, { emojiId: 'bunny_face', targetSeat: 1 })).ok, false);
  } finally {
    for (const room of manager.rooms.values()) manager.closeRoom(room, 'test done');
    clearInterval(manager.sweeper);
    wallet.db.close();
  }
});
