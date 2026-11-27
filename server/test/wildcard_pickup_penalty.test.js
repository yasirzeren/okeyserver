'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/game');
const R = require('../src/rules');
const { normalizeSettings } = require('../src/rooms');

const tile = (color, number, copy = 0) => color * 26 + copy * 13 + number - 1;
const wildcard = tile(2, 9);
const discard = tile(3, 3);

function fixture(kind = 'run', actor = 0, owner = 1, partners = false, openType = 'series') {
  const game = new Game({ ...normalizeSettings({ indicatorRule: false, partners }), workablePenalty: 0 },
    Array.from({ length: 4 }, (_, seat) => ({ name: 'Player ' + seat })));
  game.startRound();
  game.okey = { color: 2, number: 9 };
  game.phase = 'playing';
  game.step = 'play';
  game.current = actor;
  for (const player of game.players) {
    player.hand = [tile(3, 1)];
    player.opened = true;
    player.openType = 'series';
  }
  const tiles = kind === 'pair' ? [tile(0, 7), wildcard]
    : kind === 'set' ? [tile(0, 12), tile(1, 12), tile(2, 12), wildcard]
      : [tile(0, 10), wildcard, tile(0, 12)];
  const resolved = kind === 'pair' ? R.analyzePair(tiles, game.okey) : R.analyzeGroup(tiles, game.okey);
  const meld = { id: 99, owner, kind: resolved.kind, tiles: [...resolved.tiles],
    slots: resolved.slots.map(slot => ({ ...slot })), addedBy: resolved.tiles.map(() => -1) };
  game.melds.push(meld);
  const natural = kind === 'pair' ? tile(0, 7, 1) : kind === 'set' ? tile(3, 12) : tile(0, 11);
  game.players[actor].hand = [natural, discard];
  game.players[actor].openType = openType;
  return { game, meld, natural, index: meld.tiles.indexOf(wildcard), actor, owner };
}

for (const kind of ['run', 'set', 'pair']) {
  for (const partners of [false, true]) {
    for (const openType of ['series', 'pairs']) test(`wildcard pickup: ${kind}, partners=${partners}, actor opened ${openType}, all seats`, () => {
      for (let actor = 0; actor < 4; actor++) for (let owner = 0; owner < 4; owner++) {
        const { game, meld, natural, index } = fixture(kind, actor, owner, partners, openType);
        const charged = owner !== actor && !(partners && owner % 2 === actor % 2);
        assert.equal(game.swapOkey(actor, natural, meld.id, index).ok, true);
        assert.equal(meld.tiles[index], natural);
        assert.equal(game.players[actor].hand.includes(wildcard), true);
        assert.deepEqual(game.players.map(player => player.score),
          game.players.map((_, seat) => seat === owner && charged ? 101 : 0));
        assert.deepEqual(game.penalties, charged
          ? [{ round: game.round, player: owner, type: 'Okey aldırma', points: 101 }] : []);
        for (let viewer = 0; viewer < 4; viewer++) {
          assert.equal(game.viewFor(viewer).players[owner].score, charged ? 101 : 0);
          assert.equal(game.viewFor(viewer).penalties.length, charged ? 1 : 0);
        }
      }
    });
  }
}

test('invalid wildcard replacements leave scores, penalties, hand and meld unchanged', () => {
  const attempts = [
    f => f.game.swapOkey(f.actor, discard, f.meld.id, f.index),
    f => f.game.swapOkey(f.actor, f.natural, f.meld.id, 0),
    f => f.game.swapOkey(f.actor, f.natural, f.meld.id, -1),
    f => f.game.swapOkey(f.actor, f.natural, -1, f.index),
    f => { f.game.players[0].opened = false; return f.game.swapOkey(f.actor, f.natural, f.meld.id, f.index); },
    f => { f.game.current = 2; return f.game.swapOkey(f.actor, f.natural, f.meld.id, f.index); },
    f => { f.game.step = 'draw'; return f.game.swapOkey(f.actor, f.natural, f.meld.id, f.index); },
    f => f.game.swapOkey(f.actor, tile(0, 11, 1), f.meld.id, f.index),
  ];
  for (const attempt of attempts) {
    const f = fixture();
    const hand = [...f.game.players[0].hand], tiles = [...f.meld.tiles];
    assert.equal(attempt(f).ok, false);
    assert.deepEqual(f.game.players.map(player => player.score), [0, 0, 0, 0]);
    assert.deepEqual(f.game.penalties, []);
    assert.deepEqual(f.game.players[0].hand, hand);
    assert.deepEqual(f.meld.tiles, tiles);
  }
  const f = fixture('set');
  f.meld.tiles.splice(2, 1); f.meld.slots.splice(2, 1); f.meld.addedBy.splice(2, 1);
  assert.equal(f.game.swapOkey(0, f.natural, f.meld.id, f.meld.tiles.indexOf(wildcard)).ok, false);
  assert.deepEqual(f.game.penalties, []);
});

test('gathering a swap restores its charge without changing previous penalties', () => {
  const { game, meld, natural, index } = fixture();
  game.players[1].score = 202;
  const previous = { round: game.round, player: 1, type: 'İşlek taş', points: 101 };
  game.penalties.push(previous);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(game.swapOkey(0, natural, meld.id, index).ok, true);
    assert.equal(game.players[1].score, 303);
    assert.equal(game.gatherTiles(0).ok, true);
    assert.equal(game.players[1].score, 202);
    assert.deepEqual(game.penalties, [previous]);
    assert.equal(meld.tiles[index], wildcard);
    assert.equal(game.players[0].hand.includes(natural), true);
  }
});

test('gathering an uncommitted opening also cancels the wildcard owner charge', () => {
  const { game, meld, natural, index } = fixture();
  const groups = [
    [10, 11, 12, 13].map(number => tile(1, number)),
    [10, 11, 12, 13].map(number => tile(2, number)),
    [10, 11, 12].map(number => tile(3, number)),
  ];
  Object.assign(game.players[0], { opened: false, openType: null, hand: [...groups.flat(), natural, discard] });
  assert.equal(game.openGroups(0, groups).ok, true);
  assert.equal(game.swapOkey(0, natural, meld.id, index).ok, true);
  assert.equal(game.players[1].score, 101);
  assert.equal(game.gatherOpen(0).ok, true);
  assert.equal(game.players[1].score, 0);
  assert.deepEqual(game.penalties, []);
  assert.equal(game.players[0].opened, false);
  assert.equal(meld.tiles[index], wildcard);
});

test('discard commits the owner charge once and scoring exposes it as a penalty', () => {
  const { game, meld, natural, index } = fixture('pair');
  assert.equal(game.swapOkey(0, natural, meld.id, index).ok, true);
  assert.equal(game.swapOkey(0, natural, meld.id, index).ok, false);
  assert.equal(game.discard(0, discard).ok, true);
  assert.equal(game.players[1].score, 101);
  assert.equal(game.gatherTiles(0).ok, false);
  game.finish(null);
  const score = game.roundScores.at(-1);
  assert.equal(score.penalties[1], 101);
  assert.equal(score.deltas[1], score.remaining[1] + 101);
  assert.equal(score.totals[1], game.players[1].score);
});

test('extending a joker set without taking the joker does not charge its owner', () => {
  const { game, meld } = fixture('set');
  meld.tiles.splice(2, 1); meld.slots.splice(2, 1); meld.addedBy.splice(2, 1);
  const natural = tile(2, 12);
  game.players[0].hand = [natural, discard];
  assert.equal(game.processTile(0, natural, meld.id).ok, true);
  assert.deepEqual(game.penalties, []);
  assert.equal(game.players[1].score, 0);
  assert.equal(meld.tiles.includes(wildcard), true);
});
