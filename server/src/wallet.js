'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID, randomInt, createHash, scryptSync, timingSafeEqual } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { offensive } = require('./community_safety');

const STARTING_CARROTS = 1000;
const ENTRY_CARROTS = 100;
const TOKEN_LIFETIME = 30 * 86400 * 1000;
const digest = (token) => createHash('sha256').update(token).digest('hex');
const { ROOM_COST, DAILY_CARROTS, DAY_MS, latestRewardTime } = require('./carrot_policy');
const fail = (message) => ({ ok: false, message });

class Wallet {
  constructor(path, { recoverPending = true } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        salt TEXT NOT NULL, password TEXT NOT NULL,
        carrots INTEGER NOT NULL DEFAULT 0 CHECK(carrots >= 0)
      );
      CREATE TABLE IF NOT EXISTS player_codes (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id),
        code TEXT NOT NULL UNIQUE CHECK(length(code) = 8)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, account_ids TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admins (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id)
      );
      CREATE TABLE IF NOT EXISTS admin_adjustments (
        admin_id TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), amount INTEGER NOT NULL,
        reason TEXT NOT NULL, time INTEGER NOT NULL,
        PRIMARY KEY (admin_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS daily_reward_state (
        id INTEGER PRIMARY KEY, last_cutoff INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS movements (
        account_id TEXT NOT NULL REFERENCES accounts(id), ref TEXT NOT NULL,
        amount INTEGER NOT NULL, reason TEXT NOT NULL, time INTEGER NOT NULL,
        PRIMARY KEY (account_id, ref)
      );
    `);
    this.db.function('bunny_manager_email_hash', {deterministic:true}, (email) => createHash('sha256').update(email).digest('hex'));
    this.db.exec(require('./management_schema'));
    this.db.exec(require('./market_schema'));
    this.db.exec(require('./community_schema'));
    // The game state lives in memory. After a restart its unfinished matches
    // cannot resume, so release their entries from the persistent wallet.
    if (recoverPending) {
      for (const { id } of this.db.prepare("SELECT id FROM matches WHERE status = 'held'").all()) {
        this.settle(id);
      }
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  credit(id, ref, amount, reason) {
    const changed = this.db.prepare(
      'INSERT OR IGNORE INTO movements VALUES (?, ?, ?, ?, ?)'
    ).run(id, ref, amount, reason, Date.now()).changes;
    if (changed) this.db.prepare('UPDATE accounts SET carrots = carrots + ? WHERE id = ?').run(amount, id);
  }

  profile(id) {
    const profile = this.db.prepare('SELECT id, name, carrots FROM accounts WHERE id = ?').get(id);
    if (!profile) return profile;
    let code = this.db.prepare('SELECT code FROM player_codes WHERE account_id = ?').get(id);
    for (let attempt = 0; !code && attempt < 20; attempt++) {
      this.db.prepare('INSERT INTO player_codes VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(id, String(randomInt(10000000, 100000000)));
      code = this.db.prepare('SELECT code FROM player_codes WHERE account_id = ?').get(id);
    }
    if (!code) throw new Error('Could not assign player code');
    return { ...profile, playerCode: code.code };
  }

  isManager(id) {
    return id != null && !!this.db.prepare('SELECT 1 FROM managers WHERE account_id = ?').get(id);
  }

  isAdmin(id) {
    return this.isManager(id) || (id != null && !!this.db.prepare('SELECT 1 FROM admins WHERE account_id = ?').get(id));
  }

  setAdmin(id, enabled) {
    if (!this.profile(id)) return false;
    if (enabled) this.db.prepare('INSERT OR IGNORE INTO admins VALUES (?)').run(id);
    else this.db.prepare('DELETE FROM admins WHERE account_id = ?').run(id);
    return true;
  }

  adminLookup(token, email) {
    if (!this.isAdmin(this.authenticate(token))) return fail('Yönetici yetkisi gerekli.');
    if (typeof email !== 'string' || email.length > 254) return fail('Geçerli bir e-posta gir.');
    const target = this.db.prepare('SELECT id, name, carrots FROM accounts WHERE email = ?')
      .get(email.trim().toLowerCase());
    return target ? { ok: true, target } : fail('Oyuncu bulunamadı.');
  }

  adminAdjust(token, { accountId, amount, reason, requestId }) {
    const admin = this.authenticate(token);
    if (!this.isAdmin(admin)) return fail('Yönetici yetkisi gerekli.');
    if (typeof accountId !== 'string' || accountId.length !== 36 ||
        !Number.isSafeInteger(amount) || amount === 0 ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 180 ||
        typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId)) {
      return fail('Geçerli bir miktar ve gerekçe gir.');
    }
    reason = reason.trim();
    return this.transaction(() => {
      const target = this.profile(accountId);
      if (!target || this.db.prepare("SELECT 1 FROM account_controls WHERE account_id = ? AND status = 'deleted'").get(accountId)) return fail('Oyuncu bulunamadı.');
      if (!this.isAdmin(this.authenticate(token))) return fail('Admin yetkisi gerekli.');
      const previous = this.db.prepare(
        'SELECT account_id, amount, reason FROM admin_adjustments WHERE admin_id = ? AND request_id = ?'
      ).get(admin, requestId);
      if (previous) {
        if (previous.account_id !== accountId || previous.amount !== amount || previous.reason !== reason) {
          return fail('Bu işlem kimliği daha önce kullanıldı.');
        }
        return { ok: true, target };
      }
      if (target.carrots + amount < 0 || !Number.isSafeInteger(target.carrots + amount)) {
        return fail('Bu değişiklik geçerli bir bakiye bırakmıyor.');
      }
      this.db.prepare('INSERT INTO admin_adjustments VALUES (?, ?, ?, ?, ?, ?)')
        .run(admin, requestId, accountId, amount, reason, Date.now());
      this.credit(accountId, `admin:${admin}:${requestId}`, amount, `Yönetici: ${reason}`);
      return { ok: true, target: this.profile(accountId) };
    });
  }

  authenticate(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const now = Date.now();
    const hash = digest(token);
    const session = this.db.prepare(
      `SELECT account_id, expires FROM sessions s WHERE hash = ? AND expires > ? AND NOT EXISTS(SELECT 1 FROM account_controls c WHERE c.account_id = s.account_id AND c.status <> 'active')`
    ).get(hash, now);
    if (session && session.expires < now + 7 * DAY_MS) {
      this.db.prepare('UPDATE sessions SET expires = ? WHERE hash = ? AND expires > ?')
        .run(now + TOKEN_LIFETIME, hash, now);
    }
    return session?.account_id ?? null;
  }

  session(id) {
    if (this.db.prepare("SELECT 1 FROM account_controls WHERE account_id = ? AND status <> 'active'").get(id)) return fail('Hesap kullanılamıyor.');
    const token = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), id, Date.now() + TOKEN_LIFETIME);
    return { ok: true, token, profile: { ...this.profile(id), isAdmin: this.isAdmin(id), isManager: this.isManager(id) } };
  }

  register({ email, password, name }) {
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    name = typeof name === 'string' ? name.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Geçerli bir e-posta gir.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return fail('Şifre 8–128 karakter olmalı.');
    if (!name || name.length > 14 || /[\u0000-\u001f\u007f]/.test(name)) return fail('Oyuncu adı 1–14 karakter olmalı.');
    if (offensive(name)) return fail('Uygun bir oyuncu adı seç.');
    const id = randomUUID();
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return this.transaction(() => {
      const inserted = this.db.prepare(
        'INSERT OR IGNORE INTO accounts (id, email, name, salt, password) VALUES (?, ?, ?, ?, ?)'
      ).run(id, email, name, salt, hash).changes;
      if (!inserted) return fail('Bu e-posta ile hesap oluşturulamadı.');
      this.credit(id, 'welcome', STARTING_CARROTS, 'Başlangıç hediyesi');
      return this.session(id);
    });
  }

  login({ email, password }) {
    if (typeof email !== 'string' || email.length > 254 ||
        typeof password !== 'string' || password.length > 128) return fail('E-posta veya şifre hatalı.');
    const row = this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email.trim().toLowerCase());
    const hash = scryptSync(password, row?.salt ?? '00000000000000000000000000000000', 64);
    if (!row || !timingSafeEqual(hash, Buffer.from(row.password, 'hex'))) return fail('E-posta veya şifre hatalı.');
    return this.session(row.id);
  }

  logout(token) {
    if (this.authenticate(token)) this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(digest(token));
    return { ok: true };
  }

  account(token, now = Date.now()) {
    const id = this.authenticate(token);
    if (!id) return fail('Oturum açman gerekiyor.');
    this.grantDaily(now);
    const cutoff = latestRewardTime(now);
    const pendingDaily = this.db.prepare(
      'SELECT COUNT(*) AS count FROM movements WHERE account_id = ? AND ref = ? AND amount = 0'
    ).get(id, 'daily:' + cutoff).count;
    const contact = this.db.prepare('SELECT email FROM accounts WHERE id = ?').get(id);
    return { ok: true, profile: { ...this.profile(id), email: contact.email, isAdmin: this.isAdmin(id), isManager: this.isManager(id) },
      pendingDaily, dailyCutoff: cutoff };
  }
  activity(token) {
    const id = this.authenticate(token);
    if (!id) return fail('Oturum açman gerekiyor.');
    return this.transaction(() => ({
      ok: true, balance: this.profile(id).carrots,
      movements: this.db.prepare(
        'SELECT amount,reason,time FROM movements WHERE account_id = ? AND amount <> 0 ORDER BY time DESC,rowid DESC LIMIT 5'
      ).all(id),
    }));
  }
  claimDaily(token, now = Date.now()) {
    const id = this.authenticate(token);
    if (!id) return fail('Oturum açman gerekiyor.');
    this.grantDaily(now);
    this.transaction(() => {
      const count = this.db.prepare(
        'UPDATE movements SET amount = ?, time = ? WHERE account_id = ? AND ref = ? AND amount = 0'
      ).run(DAILY_CARROTS, now, id, 'daily:' + latestRewardTime(now)).changes;
      if (count) this.db.prepare('UPDATE accounts SET carrots = carrots + ? WHERE id = ?').run(DAILY_CARROTS, id);
    });
    return this.account(token, now);
  }

  grantDaily(now = Date.now()) {
    const latest = latestRewardTime(now);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT last_cutoff FROM daily_reward_state WHERE id = 1').get()?.last_cutoff;
      if (previous != null && previous >= latest) return;
      this.db.prepare("DELETE FROM movements WHERE ref LIKE 'daily:%' AND amount = 0 AND time < ?").run(latest);
      const accounts = this.db.prepare("SELECT account_id FROM movements WHERE ref = 'welcome' AND time <= ? ORDER BY account_id").all(latest);
      for (const { account_id: id } of accounts) {
        this.db.prepare('INSERT OR IGNORE INTO movements VALUES (?, ?, 0, ?, ?)')
          .run(id, 'daily:' + latest, 'Günlük havuç hediyesi', latest);
      }
      this.db.prepare('INSERT INTO daily_reward_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_cutoff = excluded.last_cutoff').run(latest);
    });
  }
  hold(matchId, ids, stake = null) {
    if (ids.length !== 4 || ids.some((id) => !id) || new Set(ids).size !== 4) {
      return fail('Havuçlu maç için dört farklı hesap gerekli.');
    }
    return this.transaction(() => {
      const cost = stake === null ? ENTRY_CARROTS : stake + stake / 20;
      if (this.db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return fail('Maç zaten başlatıldı.');
      const insufficient = ids.map((id) => ({ id, balance: this.profile(id)?.carrots ?? 0 }))
        .filter((player) => player.balance < cost);
      if (insufficient.length) return { ...fail('Bazı oyuncuların havucu yetersiz.'), insufficient };
      this.db.prepare("INSERT INTO matches VALUES (?, ?, 'held')").run(matchId, JSON.stringify(stake === null ? ids : { stake, players: ids }));
      for (const id of ids) this.credit(id, `entry:${matchId}`, -cost, 'Masa giriş ücreti');
      return { ok: true };
    });
  }

  settle(matchId, winners = []) {
    return this.transaction(() => {
      const match = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
      if (match?.status !== 'held') return false;
      const entry = JSON.parse(match.account_ids);
      const wager = !Array.isArray(entry) && Number.isInteger(entry.stake);
      const sponsored = !Array.isArray(entry) && !wager;
      const ids = sponsored || wager ? entry.players : entry;
      const payers = sponsored ? [entry.payer] : ids;
      const cost = sponsored ? ROOM_COST : wager ? entry.stake + entry.stake / 20 : ENTRY_CARROTS;
      const recipients = ids.filter((id, seat) => id && winners.includes(seat));
      const refund = !recipients.length && (!sponsored || !winners.length);
      if (refund) {
        for (const id of payers) this.credit(id, `refund:${matchId}`, cost, 'İptal edilen maçın iadesi');
      } else if (recipients.length) {
        const pot = payers.length * (wager ? entry.stake : cost);
        const share = Math.floor(pot / recipients.length);
        recipients.forEach((id, i) => this.credit(id, `win:${matchId}`,
          share + (i < pot % recipients.length ? 1 : 0), 'Maç ödülü'));
      }
      this.db.prepare('UPDATE matches SET status = ? WHERE id = ?')
        .run(refund ? 'refunded' : 'paid', matchId);
      return true;
    });
  }
}

module.exports = { Wallet, ENTRY_CARROTS };
