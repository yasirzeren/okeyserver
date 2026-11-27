'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules');
const bot = require('../src/bot');
const { Game } = require('../src/game');
const { normalizeSettings } = require('../src/rooms');

const tile = (color, number, copy = 0) => color * 26 + copy * 13 + number - 1;
const wildcard = tile(2, 9);

function fixture(kind) {
  const game = new Game({ ...normalizeSettings({ indicatorRule: false }), workablePenalty: 101 },
    Array.from({ length: 4 }, (_, index) => ({ name: 'Player ' + index })));
  game.startRound();
  Object.assign(game, { okey: { color: 2, number: 9 }, phase: 'playing', step: 'play', current: 0 });
  const tiles = kind === 'pair' ? [tile(0, 7), wildcard]
    : kind === 'set' ? [tile(0, 12), tile(1, 12), tile(2, 12), wildcard]
      : [tile(0, 10), wildcard, tile(0, 12)];
  const resolved = kind === 'pair' ? R.analyzePair(tiles, game.okey) : R.analyzeGroup(tiles, game.okey);
  const meld = { id: 99, owner: 1, kind: resolved.kind, tiles: [...resolved.tiles],
    slots: resolved.slots.map(slot => ({ ...slot })), addedBy: resolved.tiles.map(() => -1) };
  const natural = kind === 'pair' ? tile(0, 7, 1) : kind === 'set' ? tile(3, 12) : tile(0, 11);
  game.melds = [meld];
  Object.assign(game.players[0], { opened: true, openType: 'series', hand: [natural, tile(3, 1)] });
  return { game, meld, natural, index: meld.tiles.indexOf(wildcard) };
}

for (const kind of ['run', 'set', 'pair']) {
  test(`retrievable ${kind} wildcard replacement counts as workable and incurs discard penalty`, () => {
    const { game, meld, natural, index } = fixture(kind);
    assert.equal(R.canExtend(meld, natural, game.okey), null);
    assert.equal(R.canReplaceOkey(meld, natural, game.okey, index), true);
    assert.equal(game.isWorkable(natural), true);
    assert.equal(game.discard(0, natural).ok, true);
    assert.equal(game.players[0].score, 101);
    assert.deepEqual(game.penalties, [{ round: game.round, player: 0, type: 'İşlek taş', points: 101 }]);
  });

  test(`bots retain workable ${kind} wildcard replacements without adding an unsupported side-take action`, () => {
    const { game, natural } = fixture(kind);
    const lowSafe = tile(1, 1), highSafe = tile(1, 13);
    game.players[0].hand = [natural, lowSafe];
    assert.equal(bot.chooseDiscard(game, 0), lowSafe);
    game.players[0].hand = [natural, highSafe];
    assert.equal(bot.autoDiscard(game, 0), highSafe);
    game.players[0].openType = 'pairs';
    game.discards[3] = [natural];
    assert.equal(bot.shouldTakeSide(game, 0), false);
  });
}

test('replacement compatibility preserves real/fake joker values and never mutates a meld', () => {
  const { game, meld, natural, index } = fixture('run');
  const before = JSON.stringify(meld);
  for (const badIndex of [-1, 0, 3, 1.5, '1']) assert.equal(R.canReplaceOkey(meld, natural, game.okey, badIndex), false);
  assert.equal(R.canReplaceOkey(meld, wildcard, game.okey, index), false);
  assert.equal(R.canReplaceOkey(meld, tile(1, 11), game.okey, index), false);
  assert.equal(R.canReplaceOkey(meld, natural, game.okey, index), true);
  assert.equal(JSON.stringify(meld), before);

  const pair = { kind: 'pair', tiles: [wildcard, tile(2, 9, 1)], slots: [{ color: 2, number: 9 }, { color: 2, number: 9 }] };
  assert.equal(R.canReplaceOkey(pair, 104, game.okey, 0), true); // Existing fixed-value fake replacement stays legal.
  pair.tiles[0] = 104;
  assert.equal(R.canReplaceOkey(pair, 105, game.okey, 0), false); // An exposed fake is never retrievable.
});

test('a three-tile set must be extended before its real joker can be retrieved', () => {
  const { game, meld, natural } = fixture('set');
  meld.tiles.splice(2, 1); meld.slots.splice(2, 1); meld.addedBy.splice(2, 1);
  const index = meld.tiles.indexOf(wildcard);
  assert.equal(R.canReplaceOkey(meld, natural, game.okey, index), false);
  assert.equal(game.swapOkey(0, natural, meld.id, index).ok, false);
  // The same tile can still be worked in by assigning the joker the fourth colour.
  assert.notEqual(R.canExtend(meld, natural, game.okey), null);
  assert.equal(game.isWorkable(natural), true);
});

test('workable classification does not bypass turn, opening or folding guards', () => {
  for (const block of [
    f => { f.game.current = 1; },
    f => { f.game.step = 'draw'; },
    f => { f.game.players[0].opened = false; },
    f => { f.game.pendingOpen = true; f.game.openingSeriesTarget = 120; f.game.players[0].openPoints = 119; },
  ]) {
    const f = fixture('run'); block(f);
    assert.equal(f.game.isWorkable(f.natural), true);
    const before = JSON.stringify({ hand: f.game.players[0].hand, meld: f.meld, penalties: f.game.penalties });
    assert.equal(f.game.swapOkey(0, f.natural, f.meld.id, f.index).ok, false);
    assert.equal(JSON.stringify({ hand: f.game.players[0].hand, meld: f.meld, penalties: f.game.penalties }), before);
  }
});

test('finishing with the last tile still skips the workable discard charge', () => {
  const { game, natural } = fixture('pair');
  game.players[0].hand = [natural];
  assert.equal(game.discard(0, natural).ok, true);
  assert.equal(game.phase, 'finished');
  assert.equal(game.penalties.some(record => record.type === 'İşlek taş'), false);
});
