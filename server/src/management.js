'use strict';
const { createHash, randomBytes } = require('node:crypto');
const fail = (message) => ({ok:false, message});
const ok = (message='', data={}) => ({ok:true, message, ...data});

class ManagementError extends Error {}

class Management {
  constructor(wallet, manager, io, db) {
    this.wallet = wallet;
    this.manager = manager;
    this.io = io;
    this.db = db;
    this.sqlite = typeof wallet.db.prepare === 'function';
  }

  async actor(token) {
    const id = await this.wallet.authenticate(token);
    return id && await this.wallet.isManager(id) ? id : null;
  }

  async stats(token) {
    if (!await this.actor(token)) return fail('Yönetici yetkisi gerekli.');
    const accounts = await this.db.get(`
      SELECT COUNT(*) AS total FROM accounts a WHERE NOT EXISTS(
        SELECT 1 FROM account_controls c WHERE c.account_id = a.id AND c.status = 'deleted')`);
    const banned = await this.db.get("SELECT COUNT(*) AS total FROM account_controls WHERE status = 'banned'");
    const online = new Set();
    for (const socket of this.io.of('/').sockets.values()) {
      if (socket.data.accountId) online.add(socket.data.accountId);
    }
    const playing = new Set();
    const waiting = new Set();
    let activeTables = 0;
    for (const room of this.manager.rooms.values()) {
      if (room.closed) continue;
      const active = room.started && room.game && !room.game.matchOver();
      if (active) activeTables++;
      for (const member of room.connectedHumans()) {
        if (!member.accountId) continue;
        online.add(member.accountId);
        (active && !member.inLobby ? playing : waiting).add(member.accountId);
      }
    }
    const slots = await this.db.all(`
      SELECT m.slot, a.name, p.code AS "playerCode" FROM managers m
      JOIN accounts a ON a.id = m.account_id
      LEFT JOIN player_codes p ON p.account_id = a.id ORDER BY m.slot`);
    return ok('', {
      online:online.size, playing:playing.size, waiting:waiting.size,
      activeTables, totalAccounts:Number(accounts.total), banned:Number(banned.total),
      managerSlots:slots,
    });
  }

  async lookup(token, query) {
    if (!await this.actor(token)) return fail('Yönetici yetkisi gerekli.');
    if (typeof query !== 'string' || !query.trim() || query.length > 254) return fail('E-posta veya oyuncu kimliği gir.');
    const target = await this.db.get(`
      SELECT a.id, a.name, a.email, a.carrots, p.code AS "playerCode",
        COALESCE(c.status, 'active') AS status, COALESCE(c.reason, '') AS reason,
        CASE WHEN m.account_id IS NULL THEN 0 ELSE 1 END AS "isManager",
        CASE WHEN t.account_id IS NULL THEN 0 ELSE 1 END AS "isAdmin"
      FROM accounts a LEFT JOIN player_codes p ON p.account_id = a.id
      LEFT JOIN account_controls c ON c.account_id = a.id
      LEFT JOIN managers m ON m.account_id = a.id
      LEFT JOIN admins t ON t.account_id = a.id
      WHERE a.email = ? OR p.code = ?`, query.trim().toLowerCase(), query.trim());
    if (!target) return fail('Oyuncu bulunamadı.');
    target.playerCode = (await this.wallet.profile(target.id)).playerCode;
    return ok('', {target:{...target, carrots:Number(target.carrots),
      isManager:!!target.isManager, isAdmin:!!target.isAdmin || !!target.isManager}});
  }

  async action(token, data) {
    const actor = await this.actor(token);
    if (!actor) return fail('Yönetici yetkisi gerekli.');
    const {target, action, requestId} = data;
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    if (!['manager_grant','admin_grant','admin_revoke','ban','unban','delete'].includes(action) ||
        typeof target !== 'string' || !/^[0-9a-f-]{36}$/.test(target) ||
        typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId) ||
        reason.length > 180 || (['ban','delete'].includes(action) && !reason)) {
      return fail('Geçerli işlem ve gerekçe gir.');
    }
    if (target === actor && ['ban','delete','admin_revoke'].includes(action)) {
      return fail('Kendi hesabına bu işlemi uygulayamazsın.');
    }
    const hash = createHash('sha256').update(token).digest('hex');
    const authSql = `SELECT m.account_id FROM managers m JOIN sessions s ON s.account_id = m.account_id
      WHERE m.account_id = ? AND s.hash = ? AND s.expires > ?
      AND NOT EXISTS(SELECT 1 FROM account_controls c WHERE c.account_id = m.account_id AND c.status <> 'active')`;
    const statements = [];
    const now = Date.now();
    if (action === 'manager_grant') {
      statements.push({one:true, sql:`INSERT INTO managers(slot, account_id)
        SELECT seats.slot, ? FROM (SELECT 1 AS slot UNION ALL SELECT 2 AS slot) seats
        WHERE NOT EXISTS(SELECT 1 FROM managers WHERE slot = seats.slot)
          AND NOT EXISTS(SELECT 1 FROM managers WHERE account_id = ?)
        ORDER BY seats.slot LIMIT 1 ON CONFLICT DO NOTHING`, args:[target,target]});
    } else if (action === 'admin_grant') {
      statements.push({sql:'INSERT INTO admins VALUES (?) ON CONFLICT DO NOTHING',args:[target]});
    } else if (action === 'admin_revoke') {
      statements.push({sql:'DELETE FROM admins WHERE account_id = ?',args:[target]});
    } else {
      const status = action === 'delete' ? 'deleted' : action === 'ban' ? 'banned' : 'active';
      statements.push({sql:`INSERT INTO account_controls VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated = excluded.updated`,
      args:[target,status,reason,now]});
      if (status !== 'active') statements.push({sql:'DELETE FROM sessions WHERE account_id = ?',args:[target]});
      if (action === 'delete') {
        statements.push(
          {sql:'DELETE FROM admins WHERE account_id = ?',args:[target]},
          {sql:'DELETE FROM managers WHERE account_id = ?',args:[target]},
          {sql:'DELETE FROM password_resets WHERE account_id = ?',args:[target]},
          {sql:'DELETE FROM friendships WHERE a = ? OR b = ?',args:[target,target]},
          {sql:'DELETE FROM friend_invites WHERE sender = ? OR receiver = ?',args:[target,target]},
          {sql:"UPDATE accounts SET name = 'Silinen Oyuncu', email = ?, password = ?, salt = ? WHERE id = ?",
            args:['deleted+'+target+'@invalid.local',randomBytes(64).toString('hex'),randomBytes(16).toString('hex'),target]},
        );
      }
    }
    const auditSql = 'INSERT INTO management_audit VALUES (?, ?, ?, ?, ?, ?)';
    const auditArgs = [requestId,actor,target,action,reason,now];
    const check = (account, previous, targetManager) => {
      if (previous) {
        if (previous.actor !== actor || previous.target !== target ||
            previous.action !== action || previous.reason !== reason) throw new ManagementError('İşlem kimliği başka bir işlemde kullanılmış.');
        return true;
      }
      if (!account || account.status === 'deleted') throw new ManagementError('Hesap bulunamadı veya silinmiş.');
      if (['manager_grant','admin_grant'].includes(action) && account.status === 'banned') throw new ManagementError('Önce hesap engelini kaldır.');
      if (['ban','delete'].includes(action) && targetManager) throw new ManagementError('Yönetici hesapları engellenemez veya silinemez.');
      if (action === 'admin_revoke' && targetManager) throw new ManagementError('Yönetici hesabının havuç yetkisi kaldırılamaz.');
      return false;
    };
    const targetSql = `SELECT a.id, COALESCE(c.status, 'active') AS status FROM accounts a
      LEFT JOIN account_controls c ON c.account_id = a.id WHERE a.id = ?`;
    try {
      if (this.sqlite) {
        this.wallet.transaction(() => {
          const db = this.wallet.db;
          if (!db.prepare(authSql).get(actor,hash,now)) throw new ManagementError('Yönetici oturumu geçersiz.');
          const previous = db.prepare('SELECT * FROM management_audit WHERE request_id = ?').get(requestId);
          if (check(db.prepare(targetSql).get(target), previous,
              db.prepare('SELECT 1 FROM managers WHERE account_id = ?').get(target))) return;
          for (const statement of statements) {
            const changed = db.prepare(statement.sql).run(...statement.args).changes;
            if (statement.one && !changed) throw new ManagementError('Yönetici zaten atanmış veya iki yönetici yeri dolu.');
          }
          db.prepare(auditSql).run(...auditArgs);
        });
      } else {
        await this.wallet.db.transaction(async (db) => {
          await db.get('SELECT id FROM management_state WHERE id = 1 FOR UPDATE');
          if (!await db.get(authSql,actor,hash,now)) throw new ManagementError('Yönetici oturumu geçersiz.');
          const previous = await db.get('SELECT * FROM management_audit WHERE request_id = ?',requestId);
          await db.get('SELECT id FROM accounts WHERE id = ? FOR UPDATE',target);
          if (check(await db.get(targetSql,target), previous,
              await db.get('SELECT 1 FROM managers WHERE account_id = ?',target))) return;
          for (const statement of statements) {
            const changed = await db.run(statement.sql,...statement.args);
            if (statement.one && !changed) throw new ManagementError('Yönetici zaten atanmış veya iki yönetici yeri dolu.');
          }
          await db.run(auditSql,...auditArgs);
        });
      }
      if (['ban','delete'].includes(action)) this.kick(target,action,reason);
      if (action === 'unban') this.manager.blockedAccounts?.delete(target);
      return ok('İşlem tamamlandı.');
    } catch (error) {
      if (error instanceof ManagementError) return fail(error.message);
      throw error;
    }
  }

  kick(id, action, reason) {
    this.manager.blockedAccounts ??= new Set();
    this.manager.blockedAccounts.add(id);
    const message = action === 'delete' ? 'Hesabın silindi.' : 'Hesabın engellendi: '+reason;
    for (const socket of [...this.io.of('/').sockets.values()]) {
      if (socket.data.accountId !== id && this.manager.ctx(socket)?.member.accountId !== id) continue;
      socket.emit('account_disabled',{message});
      socket.emit('closed',{reason:message});
      const context = this.manager.ctx(socket);
      if (action === 'delete' && context) {
        context.member.name = 'Silinen Oyuncu';
        if (context.room.game) context.room.game.players[context.member.seat].name = 'Silinen Oyuncu';
      }
      this.manager.leaveRoom(socket);
      socket.disconnect(true);
    }
  }
}

module.exports = { Management };
