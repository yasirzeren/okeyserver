'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { dirname, join } = require('node:path');
const { Server } = require('socket.io');
// Socket.IO ships its official browser client. Native WebSocket is available
// on our Node >=22.13 runtime, so the integration tests need no extra packages.
const { io: connect } = require(join(dirname(require.resolve('socket.io')), '../client-dist/socket.io.js'));
const { PGlite } = require('@electric-sql/pglite');
const { Wallet } = require('../src/wallet');
const { PostgresWallet } = require('../src/postgres_wallet');
const { RoomManager } = require('../src/rooms');

const request = (client, event, data = {}) => new Promise((resolve, reject) => {
  client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result));
});
const waitFor = async predicate => {
  for (let n = 0; n < 400; n++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for local server state');
};

async function fixture(pg, t) {
  let wallet, database;
  if (!pg) wallet = new Wallet(':memory:');
  else {
    database = new PGlite();
    let tail = Promise.resolve();
    wallet = new PostgresWallet({
      query: (sql, args) => database.query(sql, args),
      connect: async () => {
        const previous = tail; let release;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        return { query: (sql, args) => database.query(sql, args), release };
      }, end: () => database.close(),
    });
    wallet.db.exec = sql => database.exec(sql);
    await wallet.initialize();
  }
  const server = http.createServer();
  const io = new Server(server, { maxHttpBufferSize: 1e5 });
  const manager = new RoomManager(io, wallet);
  const clients = [], accounts = [], sessions = [], states = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const current of manager.rooms.values()) { current.walletMatch = null; current.closed = true; current.clearTimer(); }
    for (const client of clients) client.disconnect();
    clearInterval(manager.sweeper);
    await new Promise(resolve => io.close(resolve));
    await (database ? database.close() : wallet.db.close());
  };
  t.after(close);
  const routes = { create_room: 'createRoom', join_room: 'joinRoom', set_ready: 'setReady',
    start_game: 'startGame', resume: 'resume', leave_room: 'leaveRoom', return_lobby: 'returnLobby',
    open_groups: 'openGroups', discard: 'discard', draw: 'draw', select_seat: 'selectSeat' };
  io.on('connection', socket => {
    for (const [event, method] of Object.entries(routes)) socket.on(event, async (data, ack) => {
      try { ack(await manager[method](socket, data)); }
      catch (error) { ack({ ok: false, message: error.message }); }
    });
    socket.on('disconnect', () => manager.onDisconnect(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const newClient = async seat => {
    const client = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
    client.on('state', state => { states[seat] = state; });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    clients.push(client); return client;
  };
  for (let seat = 0; seat < 4; seat++) {
    accounts.push(await wallet.register({ email: `transport-${seat}@example.test`, name: `Player ${seat}`, password: 'fixture-secret-23' }));
    await newClient(seat);
  }
  const created = await request(clients[0], 'create_room', { accountToken: accounts[0].token,
    password: 'local-test-pass', stake: 100, settings: { totalRounds: 1, indicatorRule: false, turnSeconds: 0 } });
  assert.equal(created.ok, true); sessions[0] = created.token;
  for (let seat = 1; seat < 4; seat++) {
    const joined = await request(clients[seat], 'join_room', { accountToken: accounts[seat].token,
      code: created.code, password: 'local-test-pass' });
    assert.equal(joined.ok, true); sessions[seat] = joined.token;
    assert.equal((await request(clients[seat], 'set_ready', { ready: true })).ok, true);
  }
  const room = manager.rooms.get(created.code);
  const balances = () => Promise.all(accounts.map(async account => (await wallet.profile(account.profile.id)).carrots));
  const db = pg ? wallet.db : {
    get: (sql, ...args) => wallet.db.prepare(sql).get(...args),
    run: (sql, ...args) => wallet.db.prepare(sql).run(...args),
  };
  return { wallet, db, manager, room, clients, accounts, sessions, states, newClient, balances,
    start: () => request(clients[0], 'start_game'),
    close };
}

for (const pg of [false, true]) {
  const label = pg ? 'PostgreSQL' : 'SQLite';
  test(`${label} four real clients: atomic start, private state, reconnect and one winner payout`, { timeout: 15000 }, async t => {
    const f = await fixture(pg, t);
    try {
      const starts = await Promise.all(Array.from({ length: 8 }, () => f.start()));
      assert.equal(starts.filter(result => result.ok).length, 1);
      assert.deepEqual(await f.balances(), [895, 895, 895, 895]);
      await waitFor(() => f.states.filter(Boolean).length === 4);
      for (let seat = 0; seat < 4; seat++) {
        assert.deepEqual(f.states[seat].myHand, f.room.game.players[seat].hand);
        assert.equal(f.states[seat].mySeat, seat);
        assert.equal(f.states[seat].players.every(player => !Object.hasOwn(player, 'hand')), true);
      }
      assert.equal((await request(f.clients[1], 'discard', { tile: f.states[0].myHand[0] })).ok, false);
      const oldHand = [...f.states[1].myHand];
      f.clients[1].disconnect();
      await waitFor(() => f.room.members[1].connected === false);
      const resumed = await f.newClient(1);
      assert.equal((await request(resumed, 'resume', { token: f.sessions[1], accountToken: f.accounts[2].token })).ok, false);
      assert.equal((await request(resumed, 'resume', { token: f.sessions[1], accountToken: f.accounts[1].token })).ok, true);
      await waitFor(() => f.states[1].players[1].connected);
      assert.deepEqual(f.states[1].myHand, oldHand);
      assert.deepEqual(await f.balances(), [895, 895, 895, 895]);

      // A deterministic local fixture supplies a winning hand. Every actual
      // opening/discard and settlement still crosses the real WebSocket path.
      const tile = (color, number) => color * 26 + number - 1;
      const groups = [[10, 11, 12, 13].map(n => tile(0, n)), [10, 11, 12, 13].map(n => tile(1, n)), [9, 10, 11].map(n => tile(3, n))];
      Object.assign(f.room.game, { okey: { color: 2, number: 9 }, current: 0, step: 'play', lastDrawn: null });
      f.room.game.players[0].hand = [...groups.flat(), tile(3, 2)];
      assert.equal((await request(f.clients[0], 'open_groups', { groups })).ok, true);
      assert.equal((await request(f.clients[0], 'discard', { tile: tile(3, 2) })).ok, true);
      await waitFor(() => f.manager.walletSettlements.size === 0);
      assert.deepEqual(await f.balances(), [1295, 895, 895, 895]);
      assert.equal(f.room.game.matchOver(), true);
      const match = await f.db.get("SELECT id FROM matches WHERE status = 'paid'");
      assert.equal(await f.wallet.settle(match.id, [0]), false);
      f.room.afterChange(); f.room.afterChange();
      assert.deepEqual(await f.balances(), [1295, 895, 895, 895]);
      assert.equal(Number((await f.db.get("SELECT COUNT(*) AS n FROM movements WHERE ref = ?", 'win:' + match.id)).n), 1);
    } finally { await f.close(); }
  });

  test(`${label} four real clients: insufficient start is atomic and abandoning match refunds once`, { timeout: 15000 }, async t => {
    const f = await fixture(pg, t);
    try {
      await f.db.run('UPDATE accounts SET carrots = 104 WHERE id = ?', f.accounts[1].profile.id);
      assert.equal((await f.start()).ok, false);
      assert.deepEqual(await f.balances(), [1000, 104, 1000, 1000]);
      assert.equal(Number((await f.db.get("SELECT COUNT(*) AS n FROM movements WHERE ref LIKE 'entry:%'")).n), 0);
      assert.equal(f.room.members[1], null);
      await f.db.run('UPDATE accounts SET carrots = 1000 WHERE id = ?', f.accounts[1].profile.id);
      assert.equal((await request(f.clients[1], 'join_room', { accountToken: f.accounts[1].token,
        code: f.room.code, password: 'local-test-pass' })).ok, true);
      await request(f.clients[1], 'set_ready', { ready: true });
      assert.equal((await f.start()).ok, true);
      const matchId = f.room.walletMatch;
      for (const client of f.clients) assert.equal((await request(client, 'leave_room')).ok, true);
      await waitFor(() => f.manager.walletSettlements.size === 0);
      assert.deepEqual(await f.balances(), [1000, 1000, 1000, 1000]);
      assert.equal(await f.wallet.settle(matchId), false);
      f.manager.closeRoom(f.room, 'Repeated close');
      assert.equal(Number((await f.db.get("SELECT COUNT(*) AS n FROM movements WHERE ref = ?", 'refund:' + matchId)).n), 4);
    } finally { await f.close(); }
  });
}
