'use strict';
const { randomUUID, createHash } = require('node:crypto');
const VERSION = '2026-11-27.1';
const RULES = Object.freeze([
  'Hakaret, tehdit, nefret söylemi, taciz ve cinsel içerik paylaşma.',
  'Başkasının kişisel bilgilerini, şifre veya doğrulama kodlarını paylaşma; dolandırıcılık yapma.',
  'Uygunsuz mesajları veya oyuncuları bildir; istemediğin kişilerle iletişimi engelle.',
  'Bildirilen içerikler yöneticiler tarafından incelenir; ihlaller hesap kısıtlaması veya silinmesiyle sonuçlanabilir.',
]);
const fail = (message, code = 'community_error') => ({ ok: false, message, code });
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const clean = value => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() : '';
const banned = ['orospu', 'siktir', 'amk', 'pic', 'ibne', 'fuck', 'shit', 'bitch', 'nigger', 'faggot'];
const patterns = banned.map(word => new RegExp('(^|[^\\p{L}\\p{N}])' + [...word].join('[^\\p{L}\\p{N}]*') + '(?=$|[^\\p{L}\\p{N}])', 'u'));
function offensive(text) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i')
    .normalize('NFD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '')
    .replace(/[аαеεіιоοрρсϲуυкκтτхχѕ]/gu, char => ({
      а: 'a', α: 'a', е: 'e', ε: 'e', і: 'i', ι: 'i', о: 'o', ο: 'o', р: 'p', ρ: 'p',
      с: 'c', ϲ: 'c', у: 'y', υ: 'u', к: 'k', κ: 'k', т: 't', τ: 't', х: 'x', χ: 'x', ѕ: 's',
    })[char])
    .replace(/[013457]/g, char => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' })[char]);
  return patterns.some(pattern => pattern.test(normalized));
}
const get = (sql, ...args) => ({ kind: 'get', sql, args });
const run = (sql, ...args) => ({ kind: 'run', sql, args });

class CommunitySafety {
  constructor(wallet, manager, management) {
    this.wallet = wallet; this.manager = manager; this.management = management;
    this.db = manager.market.db;
    this.blocked = new Map();
    this.blockVersions = new Map();
    this.reporting = new Set();
    this.lastReport = new Map();
  }
  async initialize() { await this.db.exec(require('./community_schema')); }
  async rules(token) {
    const id = await this.wallet.authenticate(token);
    if (!id) return fail('Hesabına giriş yap.', 'unauthenticated');
    const consent = await this.db.get('SELECT version FROM community_consents WHERE account_id = ?', id);
    return { ok: true, version: VERSION, accepted: consent?.version === VERSION, rules: RULES };
  }
  async accept(token, version) {
    const id = await this.wallet.authenticate(token);
    if (!id) return fail('Hesabına giriş yap.', 'unauthenticated');
    if (version !== VERSION) return fail('Güncel topluluk kurallarını oku.');
    await this.db.run('INSERT INTO community_consents VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET version = excluded.version, accepted = excluded.accepted', id, VERSION, Date.now());
    return { ok: true, version: VERSION, accepted: true, rules: RULES };
  }
  async loadBlocks(id) {
    if (!id || this.blocked.has(id)) return;
    const rows = await this.db.all('SELECT target_id FROM player_blocks WHERE account_id = ?', id);
    if (!this.blocked.has(id)) this.blocked.set(id, new Set(rows.map(row => row.target_id)));
  }
  isBlocked(a, b) {
    return !!a && !!b && (this.blocked.get(a)?.has(b) || this.blocked.get(b)?.has(a)) || false;
  }
  prune() {
    const active = new Set([...this.manager.rooms.values()].flatMap(room => room.humans().map(member => member.accountId)));
    for (const id of this.blocked.keys()) if (!active.has(id)) { this.blocked.delete(id); this.blockVersions.delete(id); }
    for (const [id, time] of this.lastReport) if (time < Date.now() - 86400000) this.lastReport.delete(id);
  }
  async blocks(token) {
    const id = await this.wallet.authenticate(token);
    if (!id) return fail('Hesabına giriş yap.', 'unauthenticated');
    await this.loadBlocks(id);
    const blocked = await this.db.all(`SELECT b.target_id AS "accountId", a.name, p.code AS "playerCode"
      FROM player_blocks b JOIN accounts a ON a.id = b.target_id LEFT JOIN player_codes p ON p.account_id = a.id
      WHERE b.account_id = ? ORDER BY b.created DESC LIMIT 200`, id);
    return { ok: true, blocked };
  }
  async block(token, { targetAccountId, blocked } = {}) {
    const id = await this.wallet.authenticate(token);
    if (!id) return fail('Hesabına giriş yap.', 'unauthenticated');
    if (!uuid(targetAccountId) || targetAccountId === id || typeof blocked !== 'boolean') return fail('Geçersiz oyuncu.');
    const result = await this.manager.market.transaction(function* (lock) {
      yield get('SELECT id FROM accounts WHERE id = ?' + lock, id);
      const target = yield get("SELECT 1 FROM accounts a WHERE a.id = ? AND NOT EXISTS(SELECT 1 FROM account_controls c WHERE c.account_id = a.id AND c.status = 'deleted')", targetAccountId);
      if (!target) return fail('Oyuncu bulunamadı.');
      if (blocked) {
        const previous = yield get('SELECT 1 FROM player_blocks WHERE account_id = ? AND target_id = ?', id, targetAccountId);
        const count = yield get('SELECT COUNT(*) AS n FROM player_blocks WHERE account_id = ?', id);
        if (!previous && Number(count.n) >= 200) return fail('En fazla 200 oyuncu engelleyebilirsin.');
        yield run('INSERT INTO player_blocks VALUES (?, ?, ?) ON CONFLICT DO NOTHING', id, targetAccountId, Date.now());
      } else yield run('DELETE FROM player_blocks WHERE account_id = ? AND target_id = ?', id, targetAccountId);
      return { ok: true };
    });
    if (!result.ok) return result;
    const version = (this.blockVersions.get(id) ?? 0) + 1;
    this.blockVersions.set(id, version);
    const rows = await this.db.all('SELECT target_id FROM player_blocks WHERE account_id = ?', id);
    if (this.blockVersions.get(id) === version) this.blocked.set(id, new Set(rows.map(row => row.target_id)));
    for (const room of this.manager.rooms.values()) for (const member of room.humans()) {
      if ([id, targetAccountId].includes(member.accountId)) room.emitTo(member, 'chat_history', room.chat);
    }
    return this.blocks(token);
  }
  async chat(socket, data) {
    const current = this.manager.ctx(socket), id = current?.member.accountId;
    if (!id) return fail('Sohbet için hesabına giriş yap.', 'unauthenticated');
    const consent = await this.db.get(`SELECT 1 FROM community_consents s WHERE s.account_id = ? AND s.version = ?
      AND NOT EXISTS(SELECT 1 FROM account_controls c WHERE c.account_id = s.account_id AND c.status <> 'active')`, id, VERSION);
    if (!consent) return fail('Sohbetten önce topluluk kurallarını onayla.', 'community_rules_required');
    if (typeof data.text !== 'string' || offensive(data.text)) return fail('Bu mesaj uygun olmayan içerik barındırıyor.', 'content_rejected');
    if (this.manager.ctx(socket)?.member !== current.member) return fail('Masa durumu değişti.');
    return this.manager.postChat(socket, data);
  }
  async report(socket, data, kind) {
    const id = await this.wallet.authenticate(data.token), current = this.manager.ctx(socket);
    if (!id || current?.member.accountId !== id) return fail('Bildirmek için mevcut odanda olmalısın.', 'unauthenticated');
    const reason = clean(data.reason);
    if (reason.length < 3 || reason.length > 180 || typeof data.reason !== 'string' || data.reason.length > 300) return fail('3–180 karakterlik bir bildirim nedeni gir.');
    const room = current.room;
    let target, message, contextKey;
    if (kind === 'chat') {
      if (!uuid(data.messageId)) return fail('Geçersiz mesaj.');
      message = room.chat.find(entry => entry.id === data.messageId && entry.senderAccountId);
      if (!message) return fail('Mesaj bu odada bulunamadı.');
      target = message.senderAccountId; contextKey = 'chat:' + message.id;
    } else {
      if (!Number.isInteger(data.targetSeat) || data.targetSeat < 0 || data.targetSeat > 3) return fail('Geçersiz oyuncu.');
      target = room.members[data.targetSeat]?.accountId;
      contextKey = 'player:' + room.inviteKey + ':' + target;
    }
    if (!target || target === id) return fail('Geçersiz hedef.');
    const previous = await this.db.get('SELECT id FROM community_reports WHERE reporter = ? AND context_key = ?', id, contextKey);
    if (previous) return { ok: true, duplicate: true, reportId: previous.id };
    const now = Date.now();
    if (this.reporting.has(id) || now - (this.lastReport.get(id) ?? 0) < 3000) return fail('Yeni bildirim için biraz bekle.', 'report_rate_limit');
    this.reporting.add(id);
    try {
      const result = await this.manager.market.transaction(function* (lock) {
        yield get('SELECT id FROM accounts WHERE id = ?' + lock, id);
        const previous = yield get('SELECT id FROM community_reports WHERE reporter = ? AND context_key = ?', id, contextKey);
        if (previous) return { ok: true, duplicate: true, reportId: previous.id };
        const count = yield get('SELECT COUNT(*) AS n FROM community_reports WHERE reporter = ? AND created > ?', id, now - 86400000);
        if (Number(count.n) >= 10) return fail('Bugünkü bildirim sınırına ulaştın.', 'report_rate_limit');
        const reportId = randomUUID();
        yield run('INSERT INTO community_reports (id, reporter, target, kind, context_key, room_code, message_text, reason, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          reportId, id, target, kind, contextKey, room.code, message?.text ?? '', reason, now);
        return { ok: true, reportId };
      });
      if (result.ok) this.lastReport.set(id, now);
      return result;
    } finally { this.reporting.delete(id); }
  }
  async reports(token, status = 'pending') {
    if (!await this.management.actor(token)) return fail('Yönetici yetkisi gerekli.');
    if (!['pending', 'resolved'].includes(status)) return fail('Geçersiz durum.');
    const reports = await this.db.all(`SELECT r.id, r.kind, r.reason, r.created, r.status, r.disposition, r.note,
      r.room_code AS "roomCode", r.message_text AS "messageText", a.name AS "reporterName", b.name AS "targetName", p.code AS "targetPlayerCode"
      FROM community_reports r JOIN accounts a ON a.id = r.reporter JOIN accounts b ON b.id = r.target
      LEFT JOIN player_codes p ON p.account_id = r.target WHERE r.status = ? ORDER BY r.created DESC LIMIT 50`, status);
    return { ok: true, reports: reports.map(row => ({ ...row, created: Number(row.created) })) };
  }
  async resolve(token, { reportId, disposition, note = '' } = {}) {
    const actor = await this.management.actor(token);
    if (!actor) return fail('Yönetici yetkisi gerekli.');
    if (!uuid(reportId) || !['reviewed', 'dismissed'].includes(disposition) || typeof note !== 'string' || note.length > 180) return fail('Geçersiz inceleme.');
    return this.manager.market.transaction(function* (lock) {
      yield get('SELECT id FROM management_state WHERE id = 1' + lock);
      const authorized = yield get(`SELECT 1 FROM managers m JOIN sessions s ON s.account_id = m.account_id
        WHERE m.account_id = ? AND s.hash = ? AND s.expires > ?
        AND NOT EXISTS(SELECT 1 FROM account_controls c WHERE c.account_id = m.account_id AND c.status <> 'active')`,
      actor, createHash('sha256').update(token).digest('hex'), Date.now());
      if (!authorized) return fail('Yönetici yetkisi gerekli.');
      const updated = yield run("UPDATE community_reports SET status = 'resolved', reviewer = ?, disposition = ?, note = ?, resolved = ? WHERE id = ? AND status = 'pending'", actor, disposition, clean(note), Date.now(), reportId);
      return updated ? { ok: true } : fail('Bildirim bulunamadı veya incelenmiş.');
    });
  }
}
module.exports = { CommunitySafety, VERSION, RULES, offensive };
