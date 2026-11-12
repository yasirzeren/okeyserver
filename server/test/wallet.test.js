'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Wallet } = require('../src/wallet');
const { RoomManager } = require('../src/rooms');

const credentials = (n) => ({
  email: `test${n}@example.test`,
  password: 'fixture-secret-23',
  name: `Oyuncu ${n}`,
});

test('account balance survives restart and pending entries are refunded once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bunny-wallet-'));
  const path = join(dir, 'wallet.sqlite');
  let wallet = new Wallet(path);
  try {
    const accounts = [0, 1, 2, 3].map((i) => wallet.register(credentials(i)));
    const ids = accounts.map((a) => a.profile.id);
    assert.equal(wallet.register(credentials(0)).ok, false);
    assert.equal(wallet.login({ ...credentials(0), password: 'incorrect' }).ok, false);
    assert.equal(wallet.login(credentials(0)).profile.carrots, 1000);
    assert.equal(wallet.hold('m1', ids).ok, true);
    assert.equal(wallet.hold('m1', ids).ok, false);
    assert.equal(wallet.profile(ids[0]).carrots, 900);
    assert.equal(wallet.settle('m1', [0]), true);
    assert.equal(wallet.settle('m1', [0]), false);
    assert.equal(wallet.profile(ids[0]).carrots, 1300);
    assert.equal(wallet.hold('m2', ids).ok, true);
    wallet.db.close();
    wallet = new Wallet(path);
    assert.equal(wallet.account(accounts[0].token).profile.carrots, 1300);
    assert.equal(wallet.account(accounts[1].token).profile.carrots, 900);
    assert.equal(wallet.settle('m2'), false);
    wallet.logout(accounts[0].token);
    assert.equal(wallet.authenticate(accounts[0].token), null);
  } finally {
    wallet.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paid rooms require four accounts, debit once, and split team winnings', async () => {
  const wallet = new Wallet(':memory:');
  const manager = new RoomManager({ to: () => ({ emit() {} }) }, wallet);
  try {
    const sockets = [0, 1, 2, 3].map((i) => ({ id: String(i), data: {} }));
    const users = sockets.map((_, i) => wallet.register(credentials(i)));
    const settings = { partners: true, indicatorRule: false, totalRounds: 1 };
    assert.equal((await manager.createRoom(sockets[0], { password: 'test-pass', carrotEntry: true })).ok, false);
    const created = await manager.createRoom(sockets[0], { password: 'test-pass',
      carrotEntry: true, accountToken: users[0].token, settings,
    });
    const room = manager.rooms.get(created.code);
    assert.equal((await manager.startGame(sockets[0])).ok, false);
    assert.equal((await manager.joinRoom(sockets[1], { password: 'test-pass', code: created.code, accountToken: users[0].token })).ok, false);
    for (let i = 1; i < 4; i++) {
      assert.equal((await manager.joinRoom(sockets[i], { password: 'test-pass', code: created.code, accountToken: users[i].token })).ok, true);
      manager.setReady(sockets[i], { ready: true });
    }
    const balances = () => users.map((u) => wallet.profile(u.profile.id).carrots);
    assert.deepEqual(balances(), [1000, 1000, 1000, 1000]);
    assert.equal((await manager.startGame(sockets[0])).ok, true);
    assert.equal((await manager.startGame(sockets[0])).ok, false);
    assert.deepEqual(balances(), [900, 900, 900, 900]);
    room.game.phase = 'finished';
    [10, 50, 10, 50].forEach((score, seat) => { room.game.players[seat].score = score; });
    room.afterChange();
    room.afterChange();
    manager.closeRoom(room, 'Test completed.');
    assert.deepEqual(balances(), [1100, 900, 1100, 900]);
  } finally {
    for (const room of manager.rooms.values()) manager.closeRoom(room, 'Test completed.');
    clearInterval(manager.sweeper);
    wallet.db.close();
  }
});

test('admin adjustment requires a role, records the actor, and is applied once', async () => {
  const wallet = new Wallet(':memory:');
  try {
    const admin = wallet.register(credentials(0));
    const player = wallet.register(credentials(1));
    const change = { accountId: player.profile.id, amount: 500,
      reason: 'Turnuva hediyesi', requestId: 'a'.repeat(32) };
    assert.equal(wallet.adminLookup(player.token, credentials(0).email).ok, false);
    assert.equal(wallet.adminAdjust(admin.token, change).ok, false);
    assert.equal(wallet.setAdmin(admin.profile.id, true), true);
    assert.equal(wallet.account(admin.token).profile.isAdmin, true);
    assert.equal(wallet.adminLookup(admin.token, credentials(1).email).target.id, player.profile.id);
    assert.equal(wallet.adminAdjust(admin.token, change).target.carrots, 1500);
    assert.equal(wallet.adminAdjust(admin.token, change).target.carrots, 1500);
    assert.equal(wallet.adminAdjust(admin.token, { ...change, amount: 900 }).ok, false);
    assert.equal(wallet.adminAdjust(admin.token, { ...change, requestId: 'b'.repeat(32), amount: -2000 }).ok, false);
    assert.equal(wallet.adminAdjust(admin.token, { ...change, requestId: 'c'.repeat(32), amount: -100 }).target.carrots, 1400);
    const audit = wallet.db.prepare('SELECT admin_id, amount, reason FROM admin_adjustments ORDER BY rowid').all();
    assert.deepEqual(audit.map((row) => row.amount), [500, -100]);
    assert.equal(audit[0].admin_id, admin.profile.id);
    assert.equal(audit[0].reason, change.reason);
    assert.equal(wallet.account(player.token).movements[0].amount, -100);
    wallet.setAdmin(admin.profile.id, false);
    assert.equal(wallet.adminAdjust(admin.token, change).ok, false);
  } finally {
    wallet.db.close();
  }
});