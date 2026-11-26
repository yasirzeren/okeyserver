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
    assert.equal(Number((await wallet.db.get('SELECT amount FROM movements WHERE account_id = ? ORDER BY time DESC, sequence DESC LIMIT 1', ids[1])).amount), 500);
    await wallet.logout(users[1].token);
    assert.equal(await wallet.authenticate(users[1].token), null);
    const largeGrant = { ...change, amount: 3000000000, requestId: 'b'.repeat(32) };
    assert.equal((await wallet.adminAdjust(users[1].token, largeGrant)).ok, false);
    assert.equal((await wallet.adminAdjust(users[0].token, largeGrant)).target.carrots, 3000001400);
    assert.equal((await wallet.adminAdjust(users[0].token, largeGrant)).target.carrots, 3000001400);
    assert.equal((await wallet.adminLookup(users[0].token, 'p1@example.test')).target.carrots, 3000001400);
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

    const noon = Date.UTC(2026, 10, 14, 9);
    const beforeReward = await balances();
    await wallet.db.run("UPDATE movements SET time = ? WHERE ref = 'welcome'", noon - 1);
    await wallet.grantDaily(noon - 1);
    assert.deepEqual(await balances(), beforeReward);
    await wallet.grantDaily(noon);
    await wallet.grantDaily(noon + 1000);
    assert.deepEqual(await balances(), beforeReward);
    assert.equal((await wallet.account(recovered.token, noon + 1000)).pendingDaily, 1);
    assert.equal((await wallet.claimDaily(recovered.token, noon + 1000)).profile.carrots, beforeReward[0] + 500);
    assert.equal((await wallet.claimDaily(recovered.token, noon + 1000)).profile.carrots, beforeReward[0] + 500);
    const tomorrow = noon + 86400000;
    const following = noon + 2 * 86400000;
    await wallet.grantDaily(tomorrow);
    const unclaimed = await wallet.account(recovered.token, tomorrow);
    assert.equal(unclaimed.pendingDaily, 1);
    assert.equal(unclaimed.profile.carrots, beforeReward[0] + 500);
    await wallet.grantDaily(following);
    assert.equal((await wallet.account(recovered.token, following)).pendingDaily, 1);
    assert.equal((await wallet.claimDaily(recovered.token, following)).profile.carrots,
      beforeReward[0] + 1000);
    assert.equal((await wallet.claimDaily(recovered.token, following)).profile.carrots,
      beforeReward[0] + 1000);
    assert.equal((await wallet.account(recovered.token, following)).movements, undefined);
    assert.equal((await wallet.account(recovered.token, following)).profile.email, 'p0@example.test');
    const activity = await wallet.activity(recovered.token);
    assert.equal(activity.balance, beforeReward[0] + 1000);
    assert.equal(activity.movements.length, 5);
    assert.equal(activity.movements.every(m => m.amount !== 0), true);
    assert.equal((await wallet.activity('invalid')).ok, false);
  } finally {
    await wallet.db.close();
  }
});

test('queued PostgreSQL carrot grants reject revoked roles, logged-out sessions and banned accounts', { timeout: 15000 }, async () => {
  const database = new PGlite();
  let gate;
  const wallet = new PostgresWallet({
    query: (sql, args) => database.query(sql, args),
    connect: async () => {
      if (gate) {
        const pending = gate;
        gate = null;
        pending.entered();
        await pending.release;
      }
      return { query: (sql, args) => database.query(sql, args), release() {} };
    },
    end: () => database.close(),
  });
  try {
    wallet.db.exec = sql => database.exec(sql);
    await wallet.initialize();
    const admin = await wallet.register({ email: 'queued-admin@example.test', name: 'Admin', password: 'fixture-1234' });
    const recipient = await wallet.register({ email: 'recipient@example.test', name: 'Recipient', password: 'fixture-1234' });
    for (const [index, revoke] of ['role', 'session', 'ban'].entries()) {
      await wallet.db.run("DELETE FROM account_controls WHERE account_id = ?", admin.profile.id);
      await wallet.setAdmin(admin.profile.id, true);
      const session = await wallet.login({ email: 'queued-admin@example.test', password: 'fixture-1234' });
      let entered, release;
      const ready = new Promise(resolve => { entered = resolve; });
      gate = { entered, release: new Promise(resolve => { release = resolve; }) };
      const requestId = String(index + 1).repeat(32);
      const adjustment = wallet.adminAdjust(session.token, { accountId: recipient.profile.id,
        amount: 5000, reason: 'Queued grant', requestId });
      // Revoke access while the request waits for its database connection.
      await ready;
      if (revoke === 'role') await wallet.setAdmin(admin.profile.id, false);
      else if (revoke === 'session') await wallet.logout(session.token);
      else await wallet.db.run("INSERT INTO account_controls VALUES (?, 'banned', 'test', ?)", admin.profile.id, Date.now());
      release();
      assert.equal((await adjustment).ok, false, revoke);
      assert.equal((await wallet.profile(recipient.profile.id)).carrots, 1000, revoke);
      assert.equal(await wallet.db.get('SELECT 1 FROM admin_adjustments WHERE request_id = ?', requestId), undefined);
    }
    await wallet.db.run('DELETE FROM account_controls WHERE account_id = ?', admin.profile.id);
    await wallet.setAdmin(admin.profile.id, false);
    await wallet.db.run('INSERT INTO managers VALUES (1, ?)', admin.profile.id);
    const manager = await wallet.login({ email: 'queued-admin@example.test', password: 'fixture-1234' });
    const granted = await wallet.adminAdjust(manager.token, { accountId: recipient.profile.id,
      amount: 5000, reason: 'Manager grant', requestId: 'f'.repeat(32) });
    assert.equal(granted.ok, true);
    assert.equal(granted.target.carrots, 6000);
  } finally { await wallet.db.close(); }
});
