'use strict';
const { randomBytes } = require('node:crypto');
const { DAY_MS, latestRewardTime } = require('./carrot_policy');
const { EMOJIS, emojiById, RENTAL_MS, EMOJI_PRICE, EMOJI_PERMANENT_PRICE, EMOJI_AD_VIEWS, AD_REWARDS } = require('./emoji_catalog');
const { readAdmobUnits, validAdmobUnits } = require('./admob_config');
const fail = (message, code = 'market_error') => ({ ok: false, message, code });
const query = (kind, sql, ...args) => ({ kind, sql, args });
const get = (sql, ...args) => query('get', sql, ...args);
const run = (sql, ...args) => query('run', sql, ...args);

function sqliteAdapter(db) {
  return {
    lock: '', exec: (sql) => db.exec(sql),
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args).changes,
  };
}

// A generator lets SQLite execute the whole transaction synchronously without
// yielding its connection to other requests; PostgreSQL awaits the same steps.
function drainSync(iterator, db) {
  let step = iterator.next();
  while (!step.done) {
    const q = step.value;
    step = iterator.next(db[q.kind](q.sql, ...q.args));
  }
  return step.value;
}
async function drainAsync(iterator, db) {
  let step = iterator.next();
  while (!step.done) {
    const q = step.value;
    step = iterator.next(await db[q.kind](q.sql, ...q.args));
  }
  return step.value;
}

class Market {
  constructor(wallet, { units, now = Date.now } = {}) {
    this.wallet = wallet;
    this.sqlite = typeof wallet.db.prepare === 'function';
    this.db = this.sqlite ? sqliteAdapter(wallet.db) : wallet.db;
    this.now = now;
    this.units = units == null ? readAdmobUnits() : validAdmobUnits(units);
  }
  async initialize() {
    await this.db.exec(require('./market_schema'));
    // CREATE IF NOT EXISTS leaves existing rental-only tables unchanged.
    // Keep their expiry values and purchase keys while adding ownership mode.
    const additions = [
      ['market_inventory', 'permanent', 'INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0, 1))'],
      ['market_purchases', 'duration', "TEXT NOT NULL DEFAULT 'rental' CHECK(duration IN ('rental', 'permanent'))"],
    ];
    if (this.sqlite) {
      this.wallet.transaction(() => {
        for (const [table, column, definition] of additions) {
          if (!this.db.all(`PRAGMA table_info(${table})`).some(row => row.name === column)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          }
        }
      });
    } else {
      for (const [table, column, definition] of additions) {
        await this.db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      }
    }
  }
  get configured() { return Object.keys(this.units).length > 0; }
  transaction(factory) {
    return this.sqlite
      ? this.wallet.transaction(() => drainSync(factory(''), this.db))
      : this.wallet.db.transaction((db) => drainAsync(factory(db.lock), db));
  }
  async identity(token) { return this.wallet.authenticate(token); }
  async snapshot(id, message = '') {
    const now = this.now(), cutoff = latestRewardTime(now);
    const [account, inventory, daily, progress, completed] = await Promise.all([
      this.db.get('SELECT carrots FROM accounts WHERE id = ?', id),
      this.db.all('SELECT emoji_id, expires, permanent FROM market_inventory WHERE account_id = ? AND (permanent = 1 OR expires > ?) ORDER BY emoji_id', id, now),
      this.db.get('SELECT used FROM market_ad_daily WHERE account_id = ? AND cutoff = ?', id, cutoff),
      this.db.all("SELECT emoji_id, COUNT(*) AS n FROM market_ad_offers WHERE account_id = ? AND cutoff = ? AND purpose = 'emoji' AND status = 'completed' GROUP BY emoji_id", id, cutoff),
      this.db.all("SELECT slot, purpose, emoji_id, result_amount FROM market_ad_offers WHERE account_id = ? AND cutoff = ? AND status = 'completed' ORDER BY slot", id, cutoff),
    ]);
    if (!account) return fail('Hesabına giriş yap.', 'unauthenticated');
    const used = Number(daily?.used ?? 0);
    return { ok: true, message, serverTime: now, catalog: EMOJIS,
      inventory: inventory.map((row) => ({ emojiId: row.emoji_id,
        permanent: Number(row.permanent) === 1,
        expiresAt: Number(row.permanent) === 1 ? null : Number(row.expires) })),
      balance: Number(account.carrots),
      ads: { configured: this.configured, platforms: Object.keys(this.units), used,
        limit: AD_REWARDS.length, rewards: AD_REWARDS, nextReward: AD_REWARDS[used] ?? 0, resetsAt: cutoff + DAY_MS,
        earnedCarrots: completed.reduce((sum, row) => sum + Number(row.result_amount), 0),
        completedSlots: completed.map(row => ({ slot: Number(row.slot), purpose: row.purpose, rewardCarrots: Number(row.result_amount), ...(row.emoji_id ? { emojiId: row.emoji_id } : {}) })) },
      emojiAdProgress: Object.fromEntries(progress.map((row) => [row.emoji_id, Math.min(EMOJI_AD_VIEWS, Number(row.n))])),
    };
  }
  async catalog(token) {
    const id = await this.identity(token);
    return id ? this.snapshot(id) : fail('Market için hesabına giriş yap.', 'unauthenticated');
  }
  async inventory(token) { return this.catalog(token); }
  async buy(token, { emojiId, requestId, duration = 'rental' } = {}) {
    const id = await this.identity(token), emoji = emojiById(emojiId);
    if (!id) return fail('Market için hesabına giriş yap.', 'unauthenticated');
    if (!emoji || !['rental', 'permanent'].includes(duration) || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) return fail('Geçersiz satın alma isteği.');
    const now = this.now(), permanent = duration === 'permanent';
    const price = permanent ? EMOJI_PERMANENT_PRICE : EMOJI_PRICE;
    const result = await this.transaction(function* (lock) {
      const account = yield get('SELECT carrots FROM accounts WHERE id = ?' + lock, id);
      if (!account || (yield get("SELECT 1 FROM account_controls WHERE account_id = ? AND status <> 'active'", id))) return fail('Hesap kullanılamıyor.', 'unauthenticated');
      const previous = yield get('SELECT emoji_id, duration FROM market_purchases WHERE account_id = ? AND request_id = ?', id, requestId);
      if (previous) return previous.emoji_id === emojiId && previous.duration === duration ? { ok: true, duplicate: true } : fail('Bu işlem numarası daha önce kullanıldı.');
      const owned = yield get('SELECT expires, permanent FROM market_inventory WHERE account_id = ? AND emoji_id = ?', id, emojiId);
      if (Number(owned?.permanent) === 1) return fail('Bu emoji sınırsız olarak zaten sende.', 'already_owned');
      if (!permanent && Number(owned?.expires ?? 0) > now) return fail('Bu emoji zaten sende. Süresi bittiğinde yeniden alabilirsin.', 'already_owned');
      if (Number(account.carrots) < price) return fail(`Bu emoji için ${price} havuç gerekiyor.`, 'insufficient_balance');
      // Permanent inventory has an explicit flag; zero is never an expiry date
      // exposed to clients. Preserve the legacy NOT NULL column for upgrades.
      const expires = permanent ? 0 : now + RENTAL_MS;
      yield run('INSERT INTO market_purchases (account_id, request_id, emoji_id, expires, created, duration) VALUES (?, ?, ?, ?, ?, ?)', id, requestId, emojiId, expires, now, duration);
      yield run('INSERT INTO movements (account_id, ref, amount, reason, time) VALUES (?, ?, ?, ?, ?)', id, 'emoji:' + requestId, -price, emoji.name + (permanent ? ' · sınırsız emoji' : ' · 3 günlük emoji'), now);
      yield run('UPDATE accounts SET carrots = carrots - ? WHERE id = ?', price, id);
      yield run('INSERT INTO market_inventory (account_id, emoji_id, expires, permanent) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, emoji_id) DO UPDATE SET expires = excluded.expires, permanent = excluded.permanent', id, emojiId, expires, permanent ? 1 : 0);
      return { ok: true };
    });
    return result.ok ? { ...await this.snapshot(id, result.duplicate ? '' : permanent ? 'Emoji sınırsız olarak senin.' : 'Emoji 3 gün boyunca senin.'), duplicate: !!result.duplicate } : result;
  }
  async offer(token, { purpose, emojiId, platform } = {}) {
    const id = await this.identity(token);
    if (!id) return fail('Hesabına giriş yap.', 'unauthenticated');
    const adUnitId = this.units[platform];
    if (!adUnitId) return fail('Ödüllü reklamlar henüz etkin değil.', 'ads_not_configured');
    if (!['carrots', 'emoji'].includes(purpose) || (purpose === 'emoji' && !emojiById(emojiId))) return fail('Geçersiz reklam ödülü.');
    const now = this.now(), cutoff = latestRewardTime(now), offerId = randomBytes(24).toString('hex');
    const result = await this.transaction(function* (lock) {
      const account = yield get('SELECT id FROM accounts WHERE id = ?' + lock, id);
      if (!account || (yield get("SELECT 1 FROM account_controls WHERE account_id = ? AND status <> 'active'", id))) return fail('Hesap kullanılamıyor.', 'unauthenticated');
      if (purpose === 'emoji') {
        const owned = yield get('SELECT expires, permanent FROM market_inventory WHERE account_id = ? AND emoji_id = ?', id, emojiId);
        if (Number(owned?.permanent) === 1 || Number(owned?.expires ?? 0) > now) return fail('Bu emoji zaten sende.', 'already_owned');
      }
      yield run("UPDATE market_ad_offers SET status = 'expired' WHERE account_id = ? AND status = 'pending' AND expires <= ?", id, now);
      const pending = yield get("SELECT * FROM market_ad_offers WHERE account_id = ? AND cutoff = ? AND status = 'pending' AND expires > ?", id, cutoff, now);
      if (pending) return pending.purpose === purpose && pending.platform === platform && (pending.emoji_id ?? null) === (purpose === 'emoji' ? emojiId : null)
        ? { ok: true, row: pending } : fail('Önce devam eden reklam işlemini tamamla.', 'ad_pending');
      yield run('INSERT INTO market_ad_daily VALUES (?, ?, 0) ON CONFLICT DO NOTHING', id, cutoff);
      const daily = yield get('SELECT used FROM market_ad_daily WHERE account_id = ? AND cutoff = ?', id, cutoff);
      const used = Number(daily.used);
      if (used >= AD_REWARDS.length) return fail('Bugünkü 5 reklam hakkını kullandın.', 'ad_daily_limit');
      if (purpose === 'emoji') {
        const views = yield get("SELECT COUNT(*) AS n FROM market_ad_offers WHERE account_id = ? AND cutoff = ? AND emoji_id = ? AND purpose = 'emoji' AND status = 'completed'", id, cutoff, emojiId);
        const remaining = EMOJI_AD_VIEWS - Number(views.n);
        if (AD_REWARDS.length - used < remaining) return fail('Bu emoji için bugün yeterli reklam hakkın kalmadı.', 'ad_daily_limit');
      }
      const expires = Math.min(now + 10 * 60000, cutoff + DAY_MS);
      yield run('INSERT INTO market_ad_offers (id, account_id, cutoff, purpose, emoji_id, platform, ad_unit, created, expires, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        offerId, id, cutoff, purpose, purpose === 'emoji' ? emojiId : null, platform, adUnitId, now, expires, used + 1);
      return { ok: true, row: { id: offerId, purpose, emoji_id: purpose === 'emoji' ? emojiId : null, expires, ad_unit: adUnitId } };
    });
    return result.ok ? { ok: true, offerId: result.row.id, customData: result.row.id,
      adUnitId: result.row.ad_unit, expiresAt: Number(result.row.expires), purpose: result.row.purpose,
      ...(result.row.emoji_id ? { emojiId: result.row.emoji_id } : {}) } : result;
  }
  async status(token, offerId) {
    const id = await this.identity(token);
    if (!id || typeof offerId !== 'string') return fail('Geçersiz reklam işlemi.');
    const offer = await this.db.get('SELECT * FROM market_ad_offers WHERE id = ? AND account_id = ?', offerId, id);
    if (!offer) return fail('Reklam işlemi bulunamadı.');
    const status = ['completed', 'cancelled'].includes(offer.status) ? offer.status : Number(offer.expires) <= this.now() ? 'expired' : offer.status;
    return { ...await this.snapshot(id), status, rewardCarrots: Number(offer.result_amount), emojiExpiresAt: Number(offer.result_expires) };
  }
  async cancel(token, offerId) {
    const id = await this.identity(token);
    if (!id || typeof offerId !== 'string') return fail('Geçersiz reklam işlemi.');
    const result = await this.transaction(function* (lock) {
      yield get('SELECT id FROM accounts WHERE id = ?' + lock, id);
      const offer = yield get('SELECT status FROM market_ad_offers WHERE id = ? AND account_id = ?', offerId, id);
      if (!offer) return fail('Reklam işlemi bulunamadı.');
      if (offer.status === 'pending') yield run("UPDATE market_ad_offers SET status = 'cancelled' WHERE id = ?", offerId);
      return { ok: true };
    });
    return result.ok ? this.status(token, offerId) : result;
  }
  async canUse(id, emojiId) {
    if (!id || !emojiById(emojiId)) return false;
    return !!await this.db.get("SELECT 1 FROM market_inventory i WHERE i.account_id = ? AND i.emoji_id = ? AND (i.permanent = 1 OR i.expires > ?) AND NOT EXISTS(SELECT 1 FROM account_controls c WHERE c.account_id = i.account_id AND c.status <> 'active')", id, emojiId, this.now());
  }
  // Invoked only after the HTTP layer cryptographically verifies Google's SSV.
  async applyVerified({ offerId, transactionId, adUnit, timestamp }) {
    const now = this.now();
    if (typeof offerId !== 'string' || !/^[a-f0-9]{48}$/.test(offerId) ||
        typeof transactionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(transactionId) ||
        !Number.isSafeInteger(timestamp) || timestamp > now + 5 * 60000 || timestamp < now - DAY_MS) return fail('Geçersiz reklam doğrulaması.');
    const initial = await this.db.get('SELECT account_id FROM market_ad_offers WHERE id = ?', offerId);
    if (!initial) return fail('Reklam işlemi bulunamadı.');
    const id = initial.account_id;
    const result = await this.transaction(function* (lock) {
      const account = yield get('SELECT id FROM accounts WHERE id = ?' + lock, id);
      if (!account || (yield get("SELECT 1 FROM account_controls WHERE account_id = ? AND status <> 'active'", id))) return fail('Hesap kullanılamıyor.');
      const offer = yield get('SELECT * FROM market_ad_offers WHERE id = ?', offerId);
      if (!offer) return fail('Reklam işlemi bulunamadı.');
      const previous = yield get('SELECT offer_id FROM market_ad_transactions WHERE id = ?', transactionId);
      if (previous) return previous.offer_id === offerId ? { ok: true, duplicate: true } : fail('Reklam işlemi daha önce kullanılmış.');
      if (offer.status === 'completed') return { ok: true, duplicate: true };
      if (offer.status !== 'pending' || now > Number(offer.expires) || latestRewardTime(now) !== Number(offer.cutoff) ||
          ![offer.ad_unit, offer.ad_unit.split('/').at(-1)].includes(adUnit) ||
          timestamp < Number(offer.created) - 5000 || timestamp > Number(offer.expires) ||
          latestRewardTime(timestamp) !== Number(offer.cutoff)) return fail('Reklam doğrulaması işlemle eşleşmiyor.');
      const daily = yield get('SELECT used FROM market_ad_daily WHERE account_id = ? AND cutoff = ?', id, offer.cutoff);
      const used = Number(daily?.used ?? 0);
      if (used >= AD_REWARDS.length || Number(offer.slot) !== used + 1) return fail('Günlük reklam hakkı geçerli değil.');
      const inserted = yield run('INSERT INTO market_ad_transactions VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', transactionId, offerId, id, now);
      if (!inserted) {
        const existing = yield get('SELECT offer_id FROM market_ad_transactions WHERE id = ?', transactionId);
        return existing?.offer_id === offerId ? { ok: true, duplicate: true } : fail('Reklam işlemi daha önce kullanılmış.');
      }
      let amount = 0, expires = 0;
      if (offer.purpose === 'carrots') {
        amount = AD_REWARDS[used];
        yield run('INSERT INTO movements (account_id, ref, amount, reason, time) VALUES (?, ?, ?, ?, ?)', id, 'rewarded-ad:' + transactionId, amount, 'Reklam havuç ödülü', now);
        yield run('UPDATE accounts SET carrots = carrots + ? WHERE id = ?', amount, id);
      } else {
        const views = yield get("SELECT COUNT(*) AS n FROM market_ad_offers WHERE account_id = ? AND cutoff = ? AND emoji_id = ? AND purpose = 'emoji' AND status = 'completed'", id, offer.cutoff, offer.emoji_id);
        if (Number(views.n) + 1 >= EMOJI_AD_VIEWS) {
          expires = now + RENTAL_MS;
          const owned = yield get('SELECT expires, permanent FROM market_inventory WHERE account_id = ? AND emoji_id = ?', id, offer.emoji_id);
          if (Number(owned?.permanent) === 1) expires = 0;
          else if (Number(owned?.expires ?? 0) > now) expires = Number(owned.expires);
          else yield run('INSERT INTO market_inventory (account_id, emoji_id, expires) VALUES (?, ?, ?) ON CONFLICT(account_id, emoji_id) DO UPDATE SET expires = excluded.expires', id, offer.emoji_id, expires);
        }
      }
      yield run('UPDATE market_ad_daily SET used = used + 1 WHERE account_id = ? AND cutoff = ?', id, offer.cutoff);
      yield run("UPDATE market_ad_offers SET status = 'completed', result_amount = ?, result_expires = ? WHERE id = ?", amount, expires, offerId);
      return { ok: true };
    });
    return result.ok ? { ...await this.snapshot(id), duplicate: !!result.duplicate } : result;
  }
}

module.exports = { Market };
