'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const STARTING_CARROTS = 1000;
const ENTRY_CARROTS = 100;
const TOKEN_LIFETIME = 30 * 86400 * 1000;
const digest = (token) => createHash('sha256').update(token).digest('hex');
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
      CREATE TABLE IF NOT EXISTS movements (
        account_id TEXT NOT NULL REFERENCES accounts(id), ref TEXT NOT NULL,
        amount INTEGER NOT NULL, reason TEXT NOT NULL, time INTEGER NOT NULL,
        PRIMARY KEY (account_id, ref)
      );
    `);
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
    return this.db.prepare('SELECT id, name, carrots FROM accounts WHERE id = ?').get(id);
  }

  isAdmin(id) {
    return id !== null && !!this.db.prepare('SELECT 1 FROM admins WHERE account_id = ?').get(id);
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
      if (!target) return fail('Oyuncu bulunamadı.');
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
    return this.db.prepare(
      'SELECT account_id FROM sessions WHERE hash = ? AND expires > ?'
    ).get(digest(token), Date.now())?.account_id ?? null;
  }

  session(id) {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), id, Date.now() + TOKEN_LIFETIME);
    return { ok: true, token, profile: { ...this.profile(id), isAdmin: this.isAdmin(id) } };
  }

  register({ email, password, name }) {
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    name = typeof name === 'string' ? name.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Geçerli bir e-posta gir.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return fail('Şifre 8–128 karakter olmalı.');
    if (!name || name.length > 14 || /[\u0000-\u001f\u007f]/.test(name)) return fail('Oyuncu adı 1–14 karakter olmalı.');
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

  account(token) {
    const id = this.authenticate(token);
    if (!id) return fail('Oturum açman gerekiyor.');
    return { ok: true, profile: { ...this.profile(id), isAdmin: this.isAdmin(id) }, movements: this.db.prepare(
      'SELECT amount, reason, time FROM movements WHERE account_id = ? ORDER BY time DESC, rowid DESC LIMIT 20'
    ).all(id) };
  }

  hold(matchId, ids) {
    if (ids.length !== 4 || ids.some((id) => !id) || new Set(ids).size !== 4) {
      return fail('Havuçlu maç için dört farklı hesap gerekli.');
    }
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return fail('Maç zaten başlatıldı.');
      if (ids.some((id) => (this.profile(id)?.carrots ?? 0) < ENTRY_CARROTS)) {
        return fail('Tüm oyuncuların en az 100 havucu olmalı.');
      }
      this.db.prepare("INSERT INTO matches VALUES (?, ?, 'held')").run(matchId, JSON.stringify(ids));
      for (const id of ids) this.credit(id, `entry:${matchId}`, -ENTRY_CARROTS, 'Masa giriş ücreti');
      return { ok: true };
    });
  }

  settle(matchId, winners = []) {
    return this.transaction(() => {
      const match = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
      if (match?.status !== 'held') return false;
      const ids = JSON.parse(match.account_ids);
      const recipients = ids.filter((id, seat) => winners.includes(seat));
      if (!recipients.length) {
        for (const id of ids) this.credit(id, `refund:${matchId}`, ENTRY_CARROTS, 'İptal edilen maçın iadesi');
      } else {
        const pot = ids.length * ENTRY_CARROTS;
        const share = Math.floor(pot / recipients.length);
        recipients.forEach((id, i) => this.credit(id, `win:${matchId}`,
          share + (i < pot % recipients.length ? 1 : 0), 'Maç ödülü'));
      }
      this.db.prepare('UPDATE matches SET status = ? WHERE id = ?')
        .run(recipients.length ? 'paid' : 'refunded', matchId);
      return true;
    });
  }
}

module.exports = { Wallet, ENTRY_CARROTS };
