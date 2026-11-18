'use strict';
const { randomBytes } = require('node:crypto');
const fail = (message) => ({ ok: false, message });
const ok = (message, data = {}) => ({ ok: true, message, ...data });
const INVITE_MS = 10 * 60 * 1000;

class Social {
  constructor(wallet) {
    this.wallet = wallet;
    const db = wallet.db;
    this.db = typeof db.prepare === 'function' ? {
      exec: (sql) => db.exec(sql),
      get: (sql, ...args) => db.prepare(sql).get(...args),
      all: (sql, ...args) => db.prepare(sql).all(...args),
      run: (sql, ...args) => db.prepare(sql).run(...args).changes,
    } : db;
  }

  async initialize() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS friendships (
        a TEXT NOT NULL REFERENCES accounts(id),
        b TEXT NOT NULL REFERENCES accounts(id),
        sender TEXT NOT NULL REFERENCES accounts(id),
        accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
        PRIMARY KEY(a, b), CHECK (a < b), CHECK (sender = a OR sender = b)
      );
      CREATE INDEX IF NOT EXISTS friendships_receiver ON friendships(b);
      CREATE TABLE IF NOT EXISTS friend_invites (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL REFERENCES accounts(id),
        receiver TEXT NOT NULL REFERENCES accounts(id),
        room_code TEXT NOT NULL, room_key TEXT NOT NULL,
        expires BIGINT NOT NULL,
        UNIQUE(sender, receiver, room_key)
      );
      CREATE INDEX IF NOT EXISTS friend_invites_receiver ON friend_invites(receiver);
    `);
  }

  async friends(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) return false;
    const pair = [a, b].sort();
    return !!await this.db.get(
      'SELECT 1 FROM friendships WHERE a = ? AND b = ? AND accepted = 1', ...pair);
  }

  async list(token) {
    const id = await this.wallet.authenticate(token);
    if (!id) return fail('Arkadaşlar için hesabına giriş yap.');
    const rows = await this.db.all(`
      SELECT p.id, p.name, f.accepted, f.sender FROM friendships f
      JOIN accounts p ON p.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
      WHERE f.a = ? OR f.b = ? ORDER BY p.name, p.id`, id, id, id);
    await this.db.run('DELETE FROM friend_invites WHERE expires <= ?', Date.now());
    const invites = await this.db.all(`
      SELECT i.id, i.sender, p.name, i.room_code AS code, i.room_key AS roomKey, i.expires
      FROM friend_invites i JOIN accounts p ON p.id = i.sender
      WHERE i.receiver = ? ORDER BY i.expires DESC LIMIT 30`, id);
    return ok('', {
      playerId: (await this.wallet.profile(id)).playerCode,
      friends: rows.filter((r) => r.accepted === 1).map(({ id, name }) => ({ id, name })),
      incoming: rows.filter((r) => !r.accepted && r.sender !== id).map(({ id, name }) => ({ id, name })),
      outgoing: rows.filter((r) => !r.accepted && r.sender === id).map(({ id, name }) => ({ id, name })),
      invites,
    });
  }

  async request(token, target) {
    const id = await this.wallet.authenticate(token);
    if (!id) return fail('Hesabına giriş yap.');
    if (typeof target !== 'string' || !target.trim() || target.length > 254) {
      return fail('Arkadaşının e-postasını veya oyuncu kimliğini gir.');
    }
    const player = await this.db.get(
      'SELECT a.id FROM accounts a LEFT JOIN player_codes p ON p.account_id = a.id WHERE a.id = ? OR a.email = ? OR p.code = ?',
      target.trim(), target.trim().toLowerCase(), target.trim());
    if (!player) return fail('Oyuncu bulunamadı.');
    if (player.id === id) return fail('Kendine arkadaşlık isteği gönderemezsin.');
    const pair = [id, player.id].sort();
    const previous = await this.db.get('SELECT accepted FROM friendships WHERE a = ? AND b = ?', ...pair);
    if (previous) return fail(previous.accepted ? 'Zaten arkadaşsınız.' : 'Bekleyen bir arkadaşlık isteği var.');
    // Limit pending requests and keep retries idempotent.
    const added = await this.db.run(`
      INSERT INTO friendships (a, b, sender)
      SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM friendships WHERE sender = ? AND accepted = 0) < 30
      ON CONFLICT DO NOTHING`, ...pair, id, id);
    return added ? ok('Arkadaşlık isteği gönderildi.') : fail('İstek gönderilemedi. Bekleyen isteklerini kontrol et.');
  }

  async respond(token, target, accept) {
    const id = await this.wallet.authenticate(token);
    if (!id || typeof target !== 'string') return fail('Geçersiz istek.');
    const pair = [id, target].sort();
    const changed = accept === true
      ? await this.db.run('UPDATE friendships SET accepted = 1 WHERE a = ? AND b = ? AND sender = ? AND accepted = 0', ...pair, target)
      : await this.db.run('DELETE FROM friendships WHERE a = ? AND b = ? AND accepted = 0', ...pair);
    return changed ? ok(accept === true ? 'Arkadaşlık kabul edildi.' : 'İstek kaldırıldı.') : fail('İstek artık geçerli değil.');
  }

  async invite(sender, receiver, room) {
    if (!await this.friends(sender, receiver)) return fail('Yalnızca arkadaşlarını davet edebilirsin.');
    const id = randomBytes(24).toString('hex');
    await this.db.run(`
      INSERT INTO friend_invites (id, sender, receiver, room_code, room_key, expires)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sender, receiver, room_key)
      DO UPDATE SET id = excluded.id, expires = excluded.expires`,
    id, sender, receiver, room.code, room.inviteKey, Date.now() + INVITE_MS);
    return ok('Oda daveti gönderildi.');
  }

  async invitation(receiver, id) {
    if (typeof id !== 'string' || id.length !== 48) return null;
    return this.db.get('SELECT * FROM friend_invites WHERE id = ? AND receiver = ? AND expires > ?',
      id, receiver, Date.now());
  }

  async dismiss(token, id) {
    const receiver = await this.wallet.authenticate(token);
    if (!receiver || typeof id !== 'string') return fail('Geçersiz davet.');
    await this.db.run('DELETE FROM friend_invites WHERE id = ? AND receiver = ?', id, receiver);
    return ok('Davet kapatıldı.');
  }
}

module.exports = { Social };
