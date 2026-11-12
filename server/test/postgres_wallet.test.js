'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { PostgresWallet } = require('../src/postgres_wallet');

test('PostgreSQL wallet settles a match and refunds expired entries exactly once', async () => {
  const database = new PGlite();
  const wallet = new PostgresWallet({
    query: (sql, args) => database.query(sql, args),
    connect: async () => ({
      query: (sql, args) => database.query(sql, args),
      release() {},
    }),
    end: () => database.close(),
  });
  try {
    // PGlite exposes exec for schema batches; pg exposes the same via query.
    wallet.db.exec = (sql) => database.exec(sql);
    await wallet.initialize();
    await wallet.initialize();
    const users = [];
    for (let seat = 0; seat < 4; seat++) {
      users.push(await wallet.register({ email: `p${seat}@example.test`, password: 'fixture-1234', name: `Oyuncu ${seat}` }));
    }
    const ids = users.map((user) => user.profile.id);
    const balances = () => Promise.all(ids.map(async (id) => (await wallet.profile(id)).carrots));
    assert.deepEqual(await balances(), [1000, 1000, 1000, 1000]);
    assert.equal((await wallet.login({ email: 'p0@example.test', password: 'fixture-1234' })).ok, true);
    assert.equal((await wallet.hold('m1', ids)).ok, true);
    assert.equal((await wallet.hold('m1', ids)).ok, false);
    assert.deepEqual(await balances(), [900, 900, 900, 900]);
    assert.equal(await wallet.settle('m1', [0]), true);
    assert.equal(await wallet.settle('m1', [0]), false);
    assert.deepEqual(await balances(), [1300, 900, 900, 900]);

    assert.equal((await wallet.hold('m2', ids)).ok, true);
    await wallet.maintain([]);
    assert.deepEqual(await balances(), [1200, 800, 800, 800]);
    await wallet.db.run("UPDATE matches SET expires = 0 WHERE id = ?", 'm2');
    await wallet.maintain(['m2']);
    assert.deepEqual(await balances(), [1200, 800, 800, 800]);
    await wallet.db.run("UPDATE matches SET expires = 0 WHERE id = ?", 'm2');
    await wallet.maintain([]);
    await wallet.maintain([]);
    assert.deepEqual(await balances(), [1300, 900, 900, 900]);

    const change = { accountId: ids[1], amount: 500, reason: 'Test', requestId: 'a'.repeat(32) };
    assert.equal((await wallet.adminAdjust(users[0].token, change)).ok, false);
    assert.equal(await wallet.setAdmin(ids[0], true), true);
    assert.equal((await wallet.adminLookup(users[0].token, 'p1@example.test')).target.id, ids[1]);
    assert.equal((await wallet.adminAdjust(users[0].token, change)).target.carrots, 1400);
    assert.equal((await wallet.adminAdjust(users[0].token, change)).target.carrots, 1400);
    assert.equal((await wallet.account(users[1].token)).movements[0].amount, 500);
    await wallet.logout(users[1].token);
    assert.equal(await wallet.authenticate(users[1].token), null);
    const email = 'p0@example.test';
    const secret = 'test-secret-with-at-least-32-characters';
    let code;
    let sends = 0;
    const delivery = { secret, send: async (_, sent) => { code = sent; sends++; } };
    assert.equal((await wallet.sendResetCode({ email }, delivery)).ok, true);
    assert.equal((await wallet.sendResetCode({ email }, delivery)).ok, true);
    assert.equal((await wallet.sendResetCode({ email: 'unknown@example.test' }, delivery)).ok, true);
    assert.equal(sends, 1);
    assert.match(code, /^\d{6}$/);
    const password = 'replacement-1234';
    assert.equal((await wallet.resetPassword({ email, password, code: code === '000000' ? '000001' : '000000' }, secret)).ok, false);
    assert.equal((await wallet.resetPassword({ email, password, code }, secret)).ok, true);
    assert.equal((await wallet.resetPassword({ email, password, code }, secret)).ok, false);
    assert.equal(await wallet.authenticate(users[0].token), null);
    assert.equal((await wallet.login({ email, password: 'fixture-1234' })).ok, false);
    const recovered = await wallet.login({ email, password });
    assert.equal(recovered.profile.id, ids[0]);
    assert.equal(recovered.profile.isAdmin, true);
    assert.equal(recovered.profile.carrots, 1300);
  } finally {
    await wallet.db.close();
  }
});
