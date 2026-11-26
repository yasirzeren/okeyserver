'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../src/wallet');
const { PostgresWallet } = require('../src/postgres_wallet');
const { PGlite } = require('@electric-sql/pglite');
const { Market } = require('../src/market');
const { EMOJIS, RENTAL_MS, EMOJI_PERMANENT_PRICE, AD_REWARDS } = require('../src/emoji_catalog');
const { latestRewardTime, DAY_MS } = require('../src/carrot_policy');
const { Social } = require('../src/social');
const { Management } = require('../src/management');
const { AccountLifecycle } = require('../src/account_lifecycle');
const UNIT = 'ca-app-pub-1234567890123456/1234567890';

async function setup(pg) {
  let wallet, database;
  if (!pg) wallet = new Wallet(':memory:');
  else {
    database = new PGlite();
    // PGlite has a single connection. Serialize transaction clients like a pool
    // of size one, while still allowing the callers to compete concurrently.
    let tail = Promise.resolve();
    wallet = new PostgresWallet({
      query: (sql, args) => database.query(sql, args),
      connect: async () => {
        const previous = tail;
        let release;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        return { query: (sql, args) => database.query(sql, args), release };
      },
      end: () => database.close(),
    });
    wallet.db.exec = sql => database.exec(sql);
    await wallet.initialize();
  }
  const account = await wallet.register({ email: 'market@example.test', name: 'Market', password: 'market-pass-2026' });
  let now = latestRewardTime(Date.now()) + 3600000;
  const market = new Market(wallet, { units: { android: UNIT }, now: () => now });
  await market.initialize();
  const db = market.db;
  return { wallet, account, market, db, setNow: time => { now = time; }, now: () => now,
    close: () => database ? database.close() : wallet.db.close() };
}

for (const pg of [false, true]) test(`${pg ? 'PostgreSQL' : 'SQLite'} market: rentals, ads, idempotency, shared limits and deletion`, async () => {
  const f = await setup(pg), { market, wallet, account, db } = f;
  const { token, profile: { id } } = account;
  let serial = 0;
  const buy = (emojiId, requestId = String(++serial).padStart(20, 'p')) => market.buy(token, { emojiId, requestId });
  const offer = (purpose = 'carrots', emojiId) => market.offer(token, { purpose, emojiId, platform: 'android' });
  const verified = (ad, transactionId = 'reward_' + ++serial, extra = {}) => market.applyVerified({ offerId: ad.offerId, transactionId, adUnit: UNIT.split('/')[1], timestamp: f.now(), ...extra });
  try {
    const initial = await market.catalog(token);
    assert.equal(initial.balance, 1000);
    assert.equal(initial.catalog.length, 20);
    assert.equal(initial.catalog.every(emoji => emoji.priceCarrots === 1000 && emoji.permanentPriceCarrots === 50000), true);
    assert.deepEqual(['rabbit', 'love', 'fun'].map(cat => EMOJIS.filter(e => e.category === cat).length), [6, 6, 8]);
    assert.equal(initial.ads.used, 0);
    assert.deepEqual(initial.ads.rewards, [200, 250, 300, 350, 400]);
    assert.equal(initial.ads.resetsAt, latestRewardTime(f.now()) + DAY_MS);
    assert.equal((await market.catalog('bad')).ok, false);
    const disabled = new Market(wallet, { units: {} });
    assert.equal((await disabled.offer(token, { purpose: 'carrots', platform: 'android' })).code, 'ads_not_configured');
    assert.equal(new Market(wallet, { units: { android: 'ca-app-pub-3940256099942544/5224354917' } }).configured, false);

    const purchase = { emojiId: 'bunny_face', requestId: 'same_purchase_request_01' };
    const purchases = await Promise.all([market.buy(token, purchase), market.buy(token, purchase)]);
    assert.equal(purchases.every(row => row.ok), true);
    assert.equal(purchases.filter(row => row.duplicate).length, 1);
    assert.equal((await market.catalog(token)).balance, 0);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM movements WHERE account_id = ? AND ref LIKE 'emoji:%'", id)).n), 1);
    assert.equal((await market.catalog(token)).inventory[0].expiresAt, f.now() + RENTAL_MS);
    assert.equal((await buy('bunny_face')).code, 'already_owned');
    assert.equal((await buy('love_heart')).code, 'insufficient_balance');
    assert.equal((await market.buy(token, { ...purchase, emojiId: 'love_heart' })).ok, false);
    assert.equal(await market.canUse(id, 'bunny_face'), true);
    const racer = await wallet.register({ email: 'race@example.test', name: 'Race', password: 'market-pass-2026' });
    const raced = await Promise.all(['fun_fire', 'fun_luck'].map((emojiId, index) => market.buy(racer.token, { emojiId, requestId: 'concurrent_purchase_' + index })));
    assert.equal(raced.filter(row => row.ok).length, 1);
    assert.equal((await market.catalog(racer.token)).balance, 0);

    // Five shared daily slots issue exactly 1500, even when callbacks race/retry.
    for (const [slot, amount] of AD_REWARDS.entries()) {
      const ad = await offer();
      assert.equal(ad.ok, true);
      assert.equal((await offer()).offerId, ad.offerId);
      assert.equal((await market.offer(token, { purpose: 'emoji', emojiId: 'love_heart', platform: 'android' })).code, 'ad_pending');
      assert.equal((await verified(ad, 'wrong_unit_' + slot, { adUnit: '0000000000' })).ok, false);
      const transactionId = 'transaction_' + slot;
      const responses = await Promise.all([verified(ad, transactionId), verified(ad, transactionId)]);
      assert.equal(responses.every(row => row.ok), true);
      const status = await market.status(token, ad.offerId);
      assert.equal(status.status, 'completed');
      assert.equal(status.rewardCarrots, amount);
      assert.equal(status.ads.used, slot + 1);
      assert.equal((await verified(ad, 'different_callback_' + slot)).duplicate, true);
    }
    const afterAds = await market.catalog(token);
    assert.equal(afterAds.balance, 1500);
    assert.equal(afterAds.ads.earnedCarrots, 1500);
    assert.deepEqual(afterAds.ads.completedSlots.map(row => row.rewardCarrots), AD_REWARDS);
    assert.equal((await offer()).code, 'ad_daily_limit');

    // The next Turkey-noon cycle begins independently of the daily gift.
    f.setNow(initial.ads.resetsAt);
    assert.equal((await market.catalog(token)).ads.used, 0);
    const first = await offer('emoji', 'love_heart');
    assert.equal((await verified(first, 'transaction_0')).ok, false); // cross-offer replay
    assert.equal((await verified(first)).inventory.some(row => row.emojiId === 'love_heart'), false);
    assert.equal((await market.catalog(token)).emojiAdProgress.love_heart, 1);
    assert.equal((await market.catalog(token)).balance, 1500);
    const second = await offer('emoji', 'love_heart');
    assert.equal((await verified(second)).ok, true);
    const granted = await market.catalog(token);
    assert.equal(granted.ads.used, 2);
    assert.equal(granted.ads.earnedCarrots, 0);
    assert.equal(granted.inventory.find(row => row.emojiId === 'love_heart').expiresAt, f.now() + RENTAL_MS);
    assert.equal(granted.ads.completedSlots.every(row => row.purpose === 'emoji' && row.rewardCarrots === 0), true);
    assert.equal((await offer('emoji', 'love_heart')).code, 'already_owned');
    const mixed = await offer();
    assert.equal((await verified(mixed)).ads.earnedCarrots, 300); // slots 1/2 used by emoji

    // Cancelled/expired ads don't consume a slot and cannot grant later.
    const cancelled = await offer();
    assert.equal((await market.cancel(token, cancelled.offerId)).status, 'cancelled');
    assert.equal((await market.cancel(token, cancelled.offerId)).status, 'cancelled');
    assert.equal((await verified(cancelled)).ok, false);
    const expiring = await offer();
    f.setNow(f.now() + 10 * 60000 + 1);
    assert.equal((await market.status(token, expiring.offerId)).status, 'expired');
    assert.equal((await verified(expiring)).ok, false);
    const fresh = await offer();
    assert.notEqual(fresh.offerId, expiring.offerId);
    assert.equal((await verified(fresh)).ads.used, 4);
    assert.equal((await offer('emoji', 'fun_laugh')).code, 'ad_daily_limit');
    const final = await offer();
    assert.equal((await verified(final)).ads.used, 5);

    f.setNow(f.now() + 4 * DAY_MS);
    assert.equal(await market.canUse(id, 'bunny_face'), false);
    assert.equal((await market.catalog(token)).inventory.length, 0);
    assert.equal((await buy('bunny_face')).ok, true); // expired rental repurchase
    await db.run("INSERT INTO account_controls VALUES (?, 'banned', 'test', ?) ON CONFLICT(account_id) DO UPDATE SET status = excluded.status", id, f.now());
    assert.equal((await market.catalog(token)).ok, false);
    assert.equal(await market.canUse(id, 'bunny_face'), false);
    await db.run("UPDATE account_controls SET status = 'active' WHERE account_id = ?", id);
    const social = new Social(wallet); await social.initialize();
    const management = new Management(wallet, { rooms: new Map(), ctx: () => null, leaveRoom() {} }, { of: () => ({ sockets: new Map() }) }, social.db);
    const lifecycle = new AccountLifecycle(wallet, management);
    assert.equal((await lifecycle.remove(token, 'market-pass-2026', 'SİL')).ok, true);
    for (const table of ['market_inventory', 'market_purchases', 'market_ad_daily', 'market_ad_offers', 'market_ad_transactions']) {
      assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, id)).n), 0);
    }
  } finally { await f.close(); }
});

for (const pg of [false, true]) test(`${pg ? 'PostgreSQL' : 'SQLite'} market: permanent ownership, upgrades and atomic purchases`, async () => {
  const f = await setup(pg), { market, account, db, wallet } = f;
  const { token, profile: { id } } = account;
  const emojiId = 'bunny_face';
  const originalTime = f.now();
  const permanent = { emojiId, requestId: 'permanent_purchase_0001', duration: 'permanent' };
  try {
    await db.run('UPDATE accounts SET carrots = ? WHERE id = ?', EMOJI_PERMANENT_PRICE - 1, id);
    assert.equal((await market.buy(token, permanent)).code, 'insufficient_balance');
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM market_purchases WHERE account_id = ?', id)).n), 0);
    assert.equal((await market.catalog(token)).balance, EMOJI_PERMANENT_PRICE - 1);

    // Old callers omit duration and still buy a three-day rental.
    await db.run('UPDATE accounts SET carrots = 1000 WHERE id = ?', id);
    const rental = await market.buy(token, { emojiId, requestId: 'rental_purchase_000001' });
    assert.deepEqual(rental.inventory, [{ emojiId, permanent: false, expiresAt: originalTime + RENTAL_MS }]);
    assert.equal((await market.buy(token, { emojiId, requestId: 'rental_purchase_again' })).code, 'already_owned');

    // Upgrades cost the full permanent price once, even for racing retries.
    await db.run('UPDATE accounts SET carrots = ? WHERE id = ?', EMOJI_PERMANENT_PRICE, id);
    const responses = await Promise.all([market.buy(token, permanent), market.buy(token, permanent)]);
    assert.equal(responses.every(row => row.ok), true);
    assert.equal(responses.filter(row => row.duplicate).length, 1);
    assert.equal((await market.catalog(token)).balance, 0);
    assert.deepEqual((await market.catalog(token)).inventory, [{ emojiId, permanent: true, expiresAt: null }]);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM movements WHERE account_id = ? AND ref = ?', id, 'emoji:' + permanent.requestId)).n), 1);
    assert.equal((await market.buy(token, { ...permanent, duration: 'rental' })).ok, false);
    assert.equal((await market.buy(token, { ...permanent, requestId: 'new_permanent_attempt' })).code, 'already_owned');
    assert.equal((await market.buy(token, { ...permanent, requestId: 'new_rental_attempt_01', duration: 'rental' })).code, 'already_owned');
    assert.equal((await market.buy(token, { ...permanent, duration: 'invalid' })).ok, false);
    assert.equal((await market.buy(token, { ...permanent, duration: null })).ok, false);
    f.setNow(originalTime + 3650 * DAY_MS);
    assert.equal(await market.canUse(id, emojiId), true);
    assert.equal((await market.catalog(token)).inventory[0].permanent, true);
    f.setNow(originalTime);

    await db.run('UPDATE accounts SET carrots = ? WHERE id = ?', 2 * EMOJI_PERMANENT_PRICE, id);
    const competing = await Promise.all(['first', 'second'].map(suffix => market.buy(token,
      { emojiId: 'fun_fire', duration: 'permanent', requestId: 'competing_permanent_' + suffix })));
    assert.equal(competing.filter(row => row.ok).length, 1);
    assert.equal(competing.filter(row => row.code === 'already_owned').length, 1);
    assert.equal((await market.catalog(token)).balance, EMOJI_PERMANENT_PRICE);

    // A pending second ad may arrive after an upgrade. It cannot downgrade or
    // assign an expiry to a permanent emoji, even when the callback is retried.
    const offer = () => market.offer(token, { purpose: 'emoji', emojiId: 'love_heart', platform: 'android' });
    const verified = (ad, transactionId) => market.applyVerified({ offerId: ad.offerId,
      transactionId, adUnit: UNIT.split('/')[1], timestamp: f.now() });
    const first = await offer();
    assert.equal((await verified(first, 'permanent_race_ad_first')).ok, true);
    const second = await offer();
    assert.equal((await market.buy(token, { emojiId: 'love_heart', duration: 'permanent', requestId: 'upgrade_during_ad_001' })).ok, true);
    assert.equal((await verified(second, 'permanent_race_ad_second')).ok, true);
    assert.equal((await verified(second, 'permanent_race_ad_second')).duplicate, true);
    assert.deepEqual((await market.catalog(token)).inventory.find(row => row.emojiId === 'love_heart'),
      { emojiId: 'love_heart', permanent: true, expiresAt: null });
    assert.equal((await offer()).code, 'already_owned');

    // A failing ledger insert rolls the purchase record back as well as money.
    await db.run('UPDATE accounts SET carrots = ? WHERE id = ?', EMOJI_PERMANENT_PRICE, id);
    const blockedId = 'failed_permanent_txn_01';
    await db.run('INSERT INTO movements (account_id, ref, amount, reason, time) VALUES (?, ?, ?, ?, ?)', id, 'emoji:' + blockedId, 0, 'test conflict', f.now());
    await assert.rejects(market.buy(token, { emojiId: 'fun_luck', duration: 'permanent', requestId: blockedId }));
    assert.equal((await market.catalog(token)).balance, EMOJI_PERMANENT_PRICE);
    assert.equal(await db.get('SELECT 1 FROM market_purchases WHERE account_id = ? AND request_id = ?', id, blockedId), undefined);
    assert.equal(await market.canUse(id, 'fun_luck'), false);

    const social = new Social(wallet); await social.initialize();
    const management = new Management(wallet, { rooms: new Map(), ctx: () => null, leaveRoom() {} }, { of: () => ({ sockets: new Map() }) }, social.db);
    assert.equal((await new AccountLifecycle(wallet, management).remove(token, 'market-pass-2026', 'SİL')).ok, true);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM market_inventory WHERE account_id = ?', id)).n), 0);
  } finally { await f.close(); }
});

for (const pg of [false, true]) test(`${pg ? 'PostgreSQL' : 'SQLite'} market: existing rental database migrates without losing purchases`, async () => {
  const f = await setup(pg), { market, account, db } = f;
  const { token, profile: { id } } = account;
  const requestId = 'legacy_purchase_request';
  const expires = f.now() + RENTAL_MS;
  try {
    // Recreate the exact old columns, with existing ownership and replay keys.
    await db.exec('ALTER TABLE market_inventory DROP COLUMN permanent; ALTER TABLE market_purchases DROP COLUMN duration;');
    await db.run('INSERT INTO market_inventory (account_id, emoji_id, expires) VALUES (?, ?, ?)', id, 'bunny_hop', expires);
    await db.run('INSERT INTO market_purchases (account_id, request_id, emoji_id, expires, created) VALUES (?, ?, ?, ?, ?)', id, requestId, 'bunny_hop', expires, f.now());
    await market.initialize();
    await market.initialize();
    assert.deepEqual((await market.catalog(token)).inventory, [{ emojiId: 'bunny_hop', permanent: false, expiresAt: expires }]);
    assert.equal((await market.buy(token, { emojiId: 'bunny_hop', requestId })).duplicate, true);
    assert.equal((await market.buy(token, { emojiId: 'bunny_hop', requestId, duration: 'permanent' })).ok, false);
    assert.equal((await market.catalog(token)).balance, 1000);
    f.setNow(expires + 1);
    assert.equal(await market.canUse(id, 'bunny_hop'), false);
    assert.equal((await market.catalog(token)).inventory.length, 0);
  } finally { await f.close(); }
});
