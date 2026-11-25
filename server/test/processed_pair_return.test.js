'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/game');
const R = require('../src/rules');
const tile = (c, n, copy = 0) => c * 26 + copy * 13 + n - 1;
function fixture(assisted) {
  const settings = { assisted, folding: false, partnerFolding: true, partners: false, sidePenalty: false,
    indicatorRule: false, pairThreshold: 5, wrongOpenPenalty: 101, sideTakePenalty: 101, workablePenalty: 0, totalRounds: 2 };
  const g = new Game(settings, Array.from({length: 4}, (_, i) => ({name: `Player ${i}`})));
  g.startRound();
  g.okey = { color: 2, number: 9 };
  Object.assign(g.players[0], { opened: true, openType: 'series', hand: [tile(0,5), tile(0,5,1), tile(3,2), tile(1,7)] });
  Object.assign(g.players[1], { opened: true, openType: 'pairs' });
  const tiles = [tile(1,2), tile(1,2,1)];
  g.melds.push({id: 77, owner: 1, kind: 'pair', tiles, slots: R.analyzePair(tiles, g.okey).slots, addedBy: [-1, -1]});
  return g;
}
for (const assisted of [true, false]) {
  test(`either processed pair tile returns the whole pair, assisted=${assisted}`, () => {
    for (const selected of [tile(0,5), tile(0,5,1)]) {
      const g = fixture(assisted);
      assert.equal(g.processPair(0, tile(0,5), tile(0,5,1), 1).ok, true);
      assert.deepEqual(g.processedTilesFor(0), [tile(0,5), tile(0,5,1)]);
      assert.deepEqual(g.processedTilesFor(1), []);
      assert.equal(g.returnProcessedTile(1, selected).ok, false);
      assert.equal(g.returnProcessedTile(0, selected).ok, true);
      assert.deepEqual(g.players[0].hand.sort((a,b)=>a-b), [tile(0,5), tile(0,5,1), tile(3,2), tile(1,7)].sort((a,b)=>a-b));
      assert.equal(g.players[0].processedCount, 0);
      assert.equal(g.melds.length, 1);
      assert.equal(g.melds[0].id, 77);
      assert.deepEqual(g.melds[0].tiles, [tile(1,2), tile(1,2,1)]);
      assert.deepEqual(g.processedTilesFor(0), []);
      assert.equal(g.returnProcessedTile(0, selected).ok, false);
      assert.equal(g.gatherTiles(0).ok, false);
    }
  });
  test(`processed pair cannot be reclaimed after discarding, assisted=${assisted}`, () => {
    const g = fixture(assisted);
    assert.equal(g.processPair(0, tile(0,5), tile(0,5,1), 1).ok, true);
    assert.equal(g.discard(0, tile(3,2)).ok, true);
    assert.deepEqual(g.processedTilesFor(0), []);
    assert.equal(g.returnProcessedTile(0, tile(0,5)).ok, false);
    g.current = 0; g.step = 'play';
    assert.equal(g.returnProcessedTile(0, tile(0,5)).ok, false);
    assert.equal(g.melds.length, 2);
  });
  test(`pair return restores unused side-tile state, assisted=${assisted}`, () => {
    const g = fixture(assisted);
    g.players[0].hand.splice(g.players[0].hand.indexOf(tile(0,5)), 1);
    g.discards[3].push(tile(0,5)); g.step = 'draw';
    assert.equal(g.takeSide(0).ok, true);
    assert.equal(g.processPair(0, tile(0,5), tile(0,5,1), 1).ok, true);
    assert.equal(g.canReturnSide(0), false);
    assert.equal(g.returnProcessedTile(0, tile(0,5,1)).ok, true);
    assert.equal(g.canReturnSide(0), true);
    assert.equal(g.discard(0, tile(3,2)).ok, false);
    assert.equal(g.returnSide(0).ok, true);
    assert.equal(g.discards[3].at(-1), tile(0,5));
    assert.equal(g.players[0].processedCount, 0);
  });
}
