'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { Wallet } = require('../src/wallet');
const { PostgresWallet } = require('../src/postgres_wallet');
const { RoomManager } = require('../src/rooms');
const { Social } = require('../src/social');
const { Market } = require('../src/market');
const { Management } = require('../src/management');
const { AccountLifecycle } = require('../src/account_lifecycle');
const { CommunitySafety, VERSION, offensive } = require('../src/community_safety');

async function fixture(pg) {
  let wallet, database;
  if (!pg) wallet = new Wallet(':memory:');
  else {
    database = new PGlite(); let tail = Promise.resolve();
    wallet = new PostgresWallet({ query: (sql, args) => database.query(sql, args), connect: async () => {
      const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
      return { query: (sql, args) => database.query(sql, args), release };
    }, end: () => database.close() });
    wallet.db.exec = sql => database.exec(sql); await wallet.initialize();
  }
  const sent = [], socketMap = new Map();
  const io = { to: id => ({ emit: (event, data) => sent.push({ id, event, data }) }), of: () => ({ sockets: socketMap }) };
  const manager = new RoomManager(io, wallet);
  manager.market = new Market(wallet, { units: {} }); await manager.market.initialize();
  const social = new Social(wallet); await social.initialize(); manager.social = social;
  const management = new Management(wallet, manager, io, social.db);
  const safety = new CommunitySafety(wallet, manager, management); await safety.initialize(); manager.safety = safety;
  const users = [], sockets = [];
  for (let seat = 0; seat < 3; seat++) {
    users.push(await wallet.register({ email: `safety${seat}@example.test`, name: `Player ${seat}`, password: 'fixture-secret-23' }));
    sockets.push({ id: 'socket-' + seat, data: {} }); socketMap.set(sockets[seat].id, sockets[seat]);
  }
  const created = await manager.createRoom(sockets[0], { accountToken: users[0].token, password: 'test-pass' });
  for (let seat = 1; seat < 3; seat++) assert.equal((await manager.joinRoom(sockets[seat], {
    accountToken: users[seat].token, code: created.code, password: 'test-pass' })).ok, true);
  const room = manager.rooms.get(created.code), db = manager.market.db;
  await db.run('INSERT INTO managers VALUES (1, ?)', users[0].profile.id);
  return { wallet, manager, safety, management, users, sockets, room, db, sent,
    close: async () => { socketMap.clear(); for (const current of manager.rooms.values()) manager.closeRoom(current, 'test'); clearInterval(manager.sweeper); await (database ? database.close() : wallet.db.close()); } };
}

test('basic content filter normalizes Turkish, Unicode, separators and common obfuscation', () => {
  for (const text of ['Merhaba, iyi oyunlar!', 'PİŞİK', 'çift açtım', '1000 havuç', 'association', 'Good luck, have fun!', 'tam kadro oynayalım', 'classical music']) assert.equal(offensive(text), false, text);
  for (const text of ['SİKTİR', 'pİç', 'a.m.k', 'F U C K', 'ＦＵＣＫ', 'b1tch', 'orоspu', 'sh\u200bit', 'fυck', 'ѕhіt']) {
    assert.equal(offensive(text), true, text);
  }
});

for (const pg of [false, true]) test(`${pg ? 'PostgreSQL' : 'SQLite'} community: consent, moderation, blocks, reports, manager roles and deletion`, async () => {
  const f = await fixture(pg), { safety, manager, users, sockets, room, db, wallet } = f;
  const token = users[1].token, reporter = users[2].token, id = users[1].profile.id;
  try {
    assert.equal((await safety.rules('invalid')).ok, false);
    assert.equal((await safety.rules(token)).accepted, false);
    assert.equal((await manager.chat(sockets[1], { text: 'Merhaba' })).code, 'community_rules_required');
    assert.equal((await safety.accept(token, 'old')).ok, false);
    assert.equal((await safety.accept(token, VERSION)).accepted, true);
    assert.equal((await new CommunitySafety(wallet, manager, f.management).rules(token)).accepted, true);
    assert.equal((await wallet.register({ email: 'offensive@example.test', name: 'a.m.k', password: 'fixture-secret-23' })).ok, false);
    assert.equal((await manager.chat(sockets[1], { text: 'a.m.k' })).code, 'content_rejected');
    assert.equal(room.chat.length, 0);
    assert.equal((await manager.chat(sockets[1], { text: 'Merhaba, iyi oyunlar.' })).ok, true);
    const message = room.chat.at(-1);
    assert.equal(message.senderAccountId, id); assert.equal(message.seat, 1);
    assert.match(message.id, /^[a-f0-9-]{36}$/);

    const report = { token: reporter, messageId: message.id, reason: 'Uygunsuz davranış bildirimi', messageText: 'forged client content' };
    assert.equal((await safety.report(sockets[2], { ...report, token }, 'chat')).ok, false);
    assert.equal((await safety.report(sockets[2], { ...report, messageId: randomUUID() }, 'chat')).ok, false);
    const outsider = await wallet.register({ email: 'outside@example.test', name: 'Outside', password: 'fixture-secret-23' });
    const outsideRoom = await manager.createRoom({ id: 'outside-socket', data: {} }, { accountToken: outsider.token, password: 'test-pass' });
    const outsideMessage = { id: randomUUID(), senderAccountId: outsider.profile.id, seat: 0, author: 'Outside', text: 'Other room message', time: Date.now() };
    manager.rooms.get(outsideRoom.code).pushChat(outsideMessage);
    assert.equal((await safety.report(sockets[2], { ...report, messageId: outsideMessage.id }, 'chat')).ok, false);
    const submitted = await safety.report(sockets[2], report, 'chat');
    assert.equal(submitted.ok, true);
    assert.equal((await safety.report(sockets[2], report, 'chat')).duplicate, true);
    assert.equal((await safety.report(sockets[2], { token: reporter, targetSeat: 0, reason: 'Diğer bildirim' }, 'player')).code, 'report_rate_limit');
    assert.equal((await safety.reports(reporter)).ok, false);
    await wallet.setAdmin(id, true);
    assert.equal((await safety.reports(token)).ok, false);
    assert.equal((await safety.resolve(token, { reportId: submitted.reportId, disposition: 'reviewed' })).ok, false);
    const queue = await safety.reports(users[0].token);
    assert.equal(queue.reports.length, 1);
    assert.equal(queue.reports[0].messageText, message.text);
    assert.equal(queue.reports[0].targetPlayerCode, users[1].profile.playerCode);
    assert.equal(Object.hasOwn(queue.reports[0], 'email'), false);
    assert.equal((await safety.resolve(users[0].token, { reportId: submitted.reportId, disposition: 'reviewed', note: 'İncelendi' })).ok, true);
    assert.equal((await safety.reports(users[0].token, 'resolved')).reports.length, 1);

    const blocked = await safety.block(reporter, { targetAccountId: id, blocked: true });
    assert.equal(blocked.blocked[0].accountId, id);
    assert.equal((await safety.blocks(reporter)).blocked.length, 1);
    const reconstructed = new CommunitySafety(wallet, manager, f.management);
    await reconstructed.loadBlocks(users[2].profile.id);
    assert.equal(reconstructed.isBlocked(users[2].profile.id, id), true);
    room.members[1].lastChat = 0; f.sent.length = 0;
    assert.equal((await manager.chat(sockets[1], { text: 'İyi oyunlar tekrar.' })).ok, true);
    assert.equal(f.sent.some(event => event.event === 'chat' && event.id === sockets[2].id), false);
    assert.equal(f.sent.some(event => event.event === 'chat' && event.id === sockets[0].id), true);
    room.emitTo(room.members[2], 'chat_history', room.chat);
    assert.equal(f.sent.at(-1).data.length, 0);
    room.emitTo(room.members[2], 'state', { mandatoryGameState: true });
    assert.equal(f.sent.at(-1).event, 'state');
    await db.run('INSERT INTO market_inventory (account_id, emoji_id, expires) VALUES (?, ?, ?)', id, 'bunny_face', Date.now() + 100000);
    assert.equal((await manager.sendEmoji(sockets[1], { emojiId: 'bunny_face', targetSeat: 2 })).ok, false);
    assert.equal((await manager.sendEmoji(sockets[1], { emojiId: 'bunny_face', targetSeat: 0 })).ok, true);
    assert.equal(f.sent.some(event => event.event === 'emoji_reaction' && event.id === sockets[2].id), false);
    assert.equal((await safety.block(reporter, { targetAccountId: id, blocked: false })).blocked.length, 0);
    room.members[1].lastChat = 0;
    assert.equal((await manager.chat(sockets[1], { text: 'Yeniden merhaba.' })).ok, true);
    assert.equal(f.sent.some(event => event.event === 'chat' && event.id === sockets[2].id), true);

    safety.lastReport.clear();
    assert.equal((await safety.report(sockets[2], { token: reporter, targetSeat: 1, reason: 'Oyuncuyu bildiriyorum' }, 'player')).ok, true);
    assert.equal((await safety.report(sockets[2], { token: reporter, targetSeat: 2, reason: 'Kendimi bildiremem' }, 'player')).ok, false);
    assert.equal((await safety.block(reporter, { targetAccountId: users[2].profile.id, blocked: true })).ok, false);
    assert.equal((await safety.block(reporter, { targetAccountId: randomUUID(), blocked: true })).ok, false);
    await safety.block(reporter, { targetAccountId: id, blocked: true });
    assert.equal((await new AccountLifecycle(wallet, f.management).remove(token, 'fixture-secret-23', 'SİL')).ok, true);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM community_consents WHERE account_id = ?', id)).n), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM player_blocks WHERE target_id = ?', id)).n), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM community_reports WHERE target = ?', id)).n), 0);
  } finally { await f.close(); }
});

for (const pg of [false, true]) test(`${pg ? 'PostgreSQL' : 'SQLite'} community: persistent daily report limit`, async () => {
  const f = await fixture(pg);
  try {
    const reporter = f.users[2].profile.id, target = f.users[1].profile.id;
    for (let n = 0; n < 10; n++) await f.db.run('INSERT INTO community_reports (id, reporter, target, kind, context_key, room_code, message_text, reason, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      randomUUID(), reporter, target, 'player', 'prior:' + n, f.room.code, '', 'Test nedeni', Date.now());
    const result = await f.safety.report(f.sockets[2], { token: f.users[2].token, targetSeat: 0, reason: 'Yeni bildirim' }, 'player');
    assert.equal(result.code, 'report_rate_limit');
    assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM community_reports')).n), 10);
  } finally { await f.close(); }
});

for (const pg of [false, true]) test(`${pg ? 'PostgreSQL' : 'SQLite'} community: racing block toggles keep delivery cache consistent with persistence`, async () => {
  const f = await fixture(pg);
  const id = f.users[2].profile.id, targetAccountId = f.users[1].profile.id;
  const originalAll = f.db.all;
  let entered, release, intercepted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  try {
    f.safety.blocked.delete(id);
    f.db.all = (sql, ...args) => {
      if (!intercepted && sql === 'SELECT target_id FROM player_blocks WHERE account_id = ?' && args[0] === id) {
        intercepted = true; entered(); return delayed;
      }
      return originalAll.call(f.db, sql, ...args);
    };
    const first = f.safety.block(f.users[2].token, { targetAccountId, blocked: true });
    await ready;
    assert.equal((await f.safety.block(f.users[2].token, { targetAccountId, blocked: false })).ok, true);
    release([{ target_id: targetAccountId }]);
    await first;
    assert.equal(await f.db.get('SELECT 1 FROM player_blocks WHERE account_id = ? AND target_id = ?', id, targetAccountId), undefined);
    assert.equal(f.safety.isBlocked(id, targetAccountId), false);
  } finally { release([]); f.db.all = originalAll; await f.close(); }
});
