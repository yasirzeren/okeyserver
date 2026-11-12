'use strict';
const { randomBytes, randomInt, randomUUID, createHash, createHmac, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { PostgresDatabase } = require('./wallet_database');
const { ENTRY_CARROTS } = require('./wallet');

const derive = promisify(scrypt);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const validToken = (token) => typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
const { ROOM_COST, DAILY_CARROTS, DAY_MS, latestRewardTime } = require('./carrot_policy');
const fail = (message) => ({ ok: false, message });
const resetDigest = (secret, email, code) =>
  createHmac('sha256', secret).update(email + '\0' + code).digest('hex');
const TOKEN_LIFETIME = 30 * DAY_MS;
const MATCH_LEASE = 5 * 60 * 1000;

class PostgresWallet {
  constructor(pool) { this.db = new PostgresDatabase(pool); }

  async initialize() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        salt TEXT NOT NULL, password TEXT NOT NULL,
        carrots BIGINT NOT NULL DEFAULT 0 CHECK(carrots >= 0)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS password_resets (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), digest TEXT NOT NULL,
        issued BIGINT NOT NULL, expires BIGINT NOT NULL, attempts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, account_ids JSONB NOT NULL, status TEXT NOT NULL, expires BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admins (account_id TEXT PRIMARY KEY REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS admin_adjustments (
        admin_id TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), amount BIGINT NOT NULL,
        reason TEXT NOT NULL, time BIGINT NOT NULL, PRIMARY KEY(admin_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS daily_reward_state (
        id INTEGER PRIMARY KEY, last_cutoff BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS movements (
        account_id TEXT NOT NULL REFERENCES accounts(id), ref TEXT NOT NULL,
        amount BIGINT NOT NULL, reason TEXT NOT NULL, time BIGINT NOT NULL,
        sequence BIGSERIAL, PRIMARY KEY(account_id, ref)
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'accounts'
            AND column_name = 'carrots' AND data_type = 'integer'
        ) THEN
          ALTER TABLE accounts ALTER COLUMN carrots TYPE BIGINT;
          ALTER TABLE movements ALTER COLUMN amount TYPE BIGINT;
          ALTER TABLE admin_adjustments ALTER COLUMN amount TYPE BIGINT;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS movements_history ON movements(account_id, time DESC, sequence DESC);
      CREATE INDEX IF NOT EXISTS held_matches ON matches(expires) WHERE status = 'held';
    `);
  }

  async credit(db, id, ref, amount, reason) {
    const inserted = await db.run(
      'INSERT INTO movements (account_id, ref, amount, reason, time) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      id, ref, amount, reason, Date.now());
    if (inserted) await db.run('UPDATE accounts SET carrots = carrots + ? WHERE id = ?', amount, id);
  }

  async profile(id, db = this.db, lock = false) {
    const row = await db.get('SELECT id, name, carrots FROM accounts WHERE id = ?' + (lock ? db.lock : ''), id);
    return row && { ...row, carrots: Number(row.carrots) };
  }
  async isAdmin(id) {
    return id != null && !!(await this.db.get('SELECT 1 FROM admins WHERE account_id = ?', id));
  }
  async setAdmin(id, enabled) {
    if (!await this.profile(id)) return false;
    if (enabled) await this.db.run('INSERT INTO admins VALUES (?) ON CONFLICT DO NOTHING', id);
    else await this.db.run('DELETE FROM admins WHERE account_id = ?', id);
    return true;
  }

  async authenticate(token) {
    if (!validToken(token)) return null;
    const now = Date.now();
    const hash = hashToken(token);
    const session = await this.db.get(
      'SELECT account_id, expires FROM sessions WHERE hash = ? AND expires > ?', hash, now);
    if (session && Number(session.expires) < now + 7 * DAY_MS) {
      await this.db.run('UPDATE sessions SET expires = ? WHERE hash = ? AND expires > ?',
        now + TOKEN_LIFETIME, hash, now);
    }
    return session?.account_id ?? null;
  }

  async session(db, id) {
    const token = randomBytes(32).toString('hex');
    await db.run('DELETE FROM sessions WHERE expires <= ?', Date.now());
    await db.run('INSERT INTO sessions VALUES (?, ?, ?)', hashToken(token), id, Date.now() + TOKEN_LIFETIME);
    const profile = await this.profile(id, db);
    const isAdmin = !!(await db.get('SELECT 1 FROM admins WHERE account_id = ?', id));
    return { ok: true, token, profile: { ...profile, isAdmin } };
  }

  async register({ email, password, name }) {
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    name = typeof name === 'string' ? name.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Geçerli bir e-posta gir.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return fail('Şifre 8–128 karakter olmalı.');
    if (!name || name.length > 14 || /[\u0000-\u001f\u007f]/.test(name)) return fail('Oyuncu adı 1–14 karakter olmalı.');
    const id = randomUUID();
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 64)).toString('hex');
    return this.db.transaction(async (db) => {
      const inserted = await db.run(
        'INSERT INTO accounts (id,email,name,salt,password) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
        id, email, name, salt, hash);
      if (!inserted) return fail('Bu e-posta ile hesap oluşturulamadı.');
      await this.credit(db, id, 'welcome', 1000, 'Başlangıç hediyesi');
      return this.session(db, id);
    });
  }

  async login({ email, password }) {
    if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 128) {
      return fail('E-posta veya şifre hatalı.');
    }
    const row = await this.db.get('SELECT * FROM accounts WHERE email = ?', email.trim().toLowerCase());
    const hash = await derive(password, row?.salt ?? '00000000000000000000000000000000', 64);
    if (!row || !timingSafeEqual(hash, Buffer.from(row.password, 'hex'))) return fail('E-posta veya şifre hatalı.');
    return this.db.transaction(async (db) => {
      const current = await db.get('SELECT password, salt FROM accounts WHERE id = ?' + db.lock, row.id);
      if (current?.password !== row.password || current?.salt !== row.salt) {
        return fail('E-posta veya şifre hatalı.');
      }
      return this.session(db, row.id);
    });
  }

  async sendResetCode({ email }, { secret, send }) {
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail('Geçerli bir e-posta gir.');
    }
    const code = String(randomInt(1000000)).padStart(6, '0');
    const digest = resetDigest(secret, email, code);
    const now = Date.now();
    const accountId = await this.db.transaction(async (db) => {
      const account = await db.get('SELECT id FROM accounts WHERE email = ?' + db.lock, email);
      if (!account) return null;
      const current = await db.get('SELECT issued FROM password_resets WHERE account_id = ?', account.id);
      if (current && Number(current.issued) > now - 60000) return null;
      await db.run(`
        INSERT INTO password_resets (account_id, digest, issued, expires, attempts)
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT (account_id) DO UPDATE SET digest = EXCLUDED.digest,
          issued = EXCLUDED.issued, expires = EXCLUDED.expires, attempts = 0
      `, account.id, digest, now, now + 10 * 60000);
      return account.id;
    });
    if (accountId) {
      void Promise.resolve().then(() => send(email, code)).catch(() => {
        console.error('Password reset email delivery failed.');
      });
    }
    return { ok: true, message: 'Bu e-posta bir hesaba bağlıysa sıfırlama kodu gönderilir.' };
  }

  async resetPassword({ email, code, password }, secret) {
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const invalid = fail('Kod yanlış, kullanılmış veya süresi dolmuş.');
    if (email.length > 254 || typeof code !== 'string' || !/^\d{6}$/.test(code)) return invalid;
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return fail('Şifre 8–128 karakter olmalı.');
    }
    return this.db.transaction(async (db) => {
      const account = await db.get('SELECT id FROM accounts WHERE email = ?' + db.lock, email);
      if (!account) return invalid;
      const reset = await db.get('SELECT digest, expires, attempts FROM password_resets WHERE account_id = ?', account.id);
      if (!reset || reset.attempts >= 5 || Number(reset.expires) <= Date.now()) return invalid;
      const expected = resetDigest(secret, email, code);
      if (!timingSafeEqual(Buffer.from(reset.digest, 'hex'), Buffer.from(expected, 'hex'))) {
        await db.run('UPDATE password_resets SET attempts = attempts + 1 WHERE account_id = ?', account.id);
        return invalid;
      }
      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(password, salt, 64)).toString('hex');
      await db.run('UPDATE accounts SET salt = ?, password = ? WHERE id = ?', salt, hash, account.id);
      await db.run('UPDATE password_resets SET attempts = 5 WHERE account_id = ?', account.id);
      await db.run('DELETE FROM sessions WHERE account_id = ?', account.id);
      return { ok: true, message: 'Şifren değiştirildi. Yeni şifrenle giriş yap.' };
    });
  }

  async logout(token) {
    if (validToken(token)) await this.db.run('DELETE FROM sessions WHERE hash = ?', hashToken(token));
    return { ok: true };
  }

  async account(token) {
    const id = await this.authenticate(token);
    if (!id) return fail('Oturum açman gerekiyor.');
    const profile = await this.profile(id);
    const isAdmin = await this.isAdmin(id);
    const movements = await this.db.all(
      'SELECT amount,reason,time FROM movements WHERE account_id = ? ORDER BY time DESC,sequence DESC LIMIT 20', id);
    return { ok: true, profile: { ...profile, isAdmin }, movements: movements.map((m) => ({ ...m, amount: Number(m.amount), time: Number(m.time) })) };
  }

  async adminLookup(token, email) {
    if (!await this.isAdmin(await this.authenticate(token))) return fail('Yönetici yetkisi gerekli.');
    if (typeof email !== 'string' || email.length > 254) return fail('Geçerli bir e-posta gir.');
    const target = await this.db.get('SELECT id,name,carrots FROM accounts WHERE email = ?', email.trim().toLowerCase());
    return target ? { ok: true, target: { ...target, carrots: Number(target.carrots) } } : fail('Oyuncu bulunamadı.');
  }

  async adminAdjust(token, { accountId, amount, reason, requestId }) {
    const admin = await this.authenticate(token);
    if (!await this.isAdmin(admin)) return fail('Yönetici yetkisi gerekli.');
    if (typeof accountId !== 'string' || accountId.length !== 36 ||
        !Number.isSafeInteger(amount) || amount === 0 ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 180 ||
        typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId)) {
      return fail('Geçerli bir miktar ve gerekçe gir.');
    }
    reason = reason.trim();
    return this.db.transaction(async (db) => {
      const target = await this.profile(accountId, db, true);
      if (!target) return fail('Oyuncu bulunamadı.');
      const previous = await db.get(
        'SELECT account_id,amount,reason FROM admin_adjustments WHERE admin_id = ? AND request_id = ?', admin, requestId);
      if (previous) {
        return previous.account_id === accountId && Number(previous.amount) === amount && previous.reason === reason
          ? { ok: true, target } : fail('Bu işlem kimliği daha önce kullanıldı.');
      }
      if (target.carrots + amount < 0 || !Number.isSafeInteger(target.carrots + amount)) {
        return fail('Bu değişiklik geçerli bir bakiye bırakmıyor.');
      }
      await db.run('INSERT INTO admin_adjustments VALUES (?,?,?,?,?,?)', admin, requestId, accountId, amount, reason, Date.now());
      await this.credit(db, accountId, `admin:${admin}:${requestId}`, amount, `Yönetici: ${reason}`);
      return { ok: true, target: await this.profile(accountId, db) };
    });
  }

  async holdRoom(id, payer) {
    return this.db.transaction(async (db) => {
      if (((await this.profile(payer, db, true))?.carrots ?? 0) < ROOM_COST) {
        return fail('Oda açmak için 400 havucun olmalı.');
      }
      await db.run("INSERT INTO matches VALUES (?, ?, 'held', ?)",
        id, JSON.stringify({ payer, players: [] }), Date.now() + MATCH_LEASE);
      await this.credit(db, payer, `entry:${id}`, -ROOM_COST, 'Masa açılış ücreti');
      return { ok: true };
    });
  }

  async setRoomPlayers(id, players) {
    return this.db.transaction(async (db) => {
      const row = await db.get("SELECT account_ids FROM matches WHERE id = ? AND status = 'held'" + db.lock, id);
      if (!row) return false;
      await db.run('UPDATE matches SET account_ids = ? WHERE id = ?',
        JSON.stringify({ ...row.account_ids, players }), id);
      return true;
    });
  }

  async grantDaily(now = Date.now()) {
    const latest = latestRewardTime(now);
    return this.db.transaction(async (db) => {
      await db.run('INSERT INTO daily_reward_state VALUES (1, ?) ON CONFLICT DO NOTHING', latest - DAY_MS);
      const previous = Number((await db.get('SELECT last_cutoff FROM daily_reward_state WHERE id = 1' + db.lock)).last_cutoff);
      for (let cutoff = previous + DAY_MS; cutoff <= latest; cutoff += DAY_MS) {
        await db.run(`
          WITH eligible AS (
            SELECT a.id FROM accounts a JOIN movements m ON m.account_id = a.id
            WHERE m.ref = 'welcome' AND m.time <= ? ORDER BY a.id FOR UPDATE OF a
          ), awarded AS (
            INSERT INTO movements (account_id, ref, amount, reason, time)
            SELECT id, ?, ?, 'Günlük havuç hediyesi', ? FROM eligible
            ON CONFLICT DO NOTHING RETURNING account_id
          )
          UPDATE accounts SET carrots = carrots + ? FROM awarded WHERE id = awarded.account_id
        `, cutoff, `daily:${cutoff}`, DAILY_CARROTS, cutoff, DAILY_CARROTS);
      }
      if (previous < latest) {
        await db.run('UPDATE daily_reward_state SET last_cutoff = ? WHERE id = 1', latest);
      }
    });
  }

  async hold(matchId, ids) {
    if (ids.length !== 4 || ids.some((id) => !id) || new Set(ids).size !== 4) {
      return fail('Havuçlu maç için dört farklı hesap gerekli.');
    }
    return this.db.transaction(async (db) => {
      const sorted = [...ids].sort();
      for (const id of sorted) {
        if (((await this.profile(id, db, true))?.carrots ?? 0) < ENTRY_CARROTS) {
          return fail('Tüm oyuncuların en az 100 havucu olmalı.');
        }
      }
      const inserted = await db.run(
        "INSERT INTO matches VALUES (?, ?, 'held', ?) ON CONFLICT DO NOTHING",
        matchId, JSON.stringify(ids), Date.now() + MATCH_LEASE);
      if (!inserted) return fail('Maç zaten başlatıldı.');
      for (const id of sorted) await this.credit(db, id, `entry:${matchId}`, -ENTRY_CARROTS, 'Masa giriş ücreti');
      return { ok: true };
    });
  }

  async settle(matchId, winners = [], expiredOnly = false) {
    return this.db.transaction(async (db) => {
      const match = await db.get('SELECT * FROM matches WHERE id = ?' + db.lock, matchId);
      if (match?.status !== 'held' || (expiredOnly && Number(match.expires) > Date.now())) return false;
      const entry = match.account_ids;
      const sponsored = !Array.isArray(entry);
      const ids = sponsored ? entry.players : entry;
      const payers = sponsored ? [entry.payer] : ids;
      const cost = sponsored ? ROOM_COST : ENTRY_CARROTS;
      const recipients = ids.filter((id, seat) => id && winners.includes(seat)).sort();
      const refund = !recipients.length && (!sponsored || !winners.length);
      if (refund) {
        for (const id of [...payers].sort()) await this.credit(db, id, `refund:${matchId}`, cost, 'İptal edilen maçın iadesi');
      } else if (recipients.length) {
        const pot = payers.length * cost;
        const share = Math.floor(pot / recipients.length);
        for (const [i, id] of recipients.entries()) {
          await this.credit(db, id, `win:${matchId}`, share + (i < pot % recipients.length ? 1 : 0), 'Maç ödülü');
        }
      }
      await db.run('UPDATE matches SET status = ? WHERE id = ?', refund ? 'refunded' : 'paid', matchId);
      return true;
    });
  }

  async maintain(activeIds) {
    if (activeIds.length) {
      await this.db.run("UPDATE matches SET expires = ? WHERE status = 'held' AND id = ANY(?::text[])",
        Date.now() + MATCH_LEASE, activeIds);
    }
    const expired = await this.db.all("SELECT id FROM matches WHERE status = 'held' AND expires <= ?", Date.now());
    for (const { id } of expired) await this.settle(id, [], true);
  }
}

module.exports = { PostgresWallet };
