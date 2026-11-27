'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/game');
const t = (c, n, copy = 0) => c * 26 + copy * 13 + n - 1;
const pairs = n => Array.from({length:n}, (_, i) => [t(0,i+1),t(0,i+1,1)]);
const series = () => [[t(0,10),t(0,11),t(0,12),t(0,13)],
  [t(1,10),t(1,11),t(1,12),t(1,13)],[t(3,9),t(3,10),t(3,11)]];
function game(folding = true) {
  const g = new Game({folding, partnerFolding:true, partners:false, assisted:true,
    sidePenalty:false, indicatorRule:false, pairThreshold:5, workablePenalty:0,
    wrongOpenPenalty:101, totalRounds:8}, Array.from({length:4},(_,i)=>({name:`P${i}`})));
  g.startRound(); g.okey = {color:2,number:9}; g.current=0; g.step='play';
  g.deck=Array.from({length:30},(_,i)=>40+i);
  return g;
}
function rotate(g) {
  for(let p=1;p<4;p++) {
    assert.equal(g.current,p); assert.equal(g.draw(p).ok,true);
    assert.equal(g.discard(p,g.players[p].hand.at(-1)).ok,true);
  }
  assert.equal(g.current,0); assert.equal(g.draw(0).ok,true);
}
function pairOpening() {
  const g=game(); g.players[0].hand=[...pairs(7).flat(),t(3,1),t(3,2)];
  assert.equal(g.openGroups(0,pairs(5)).ok,true);
  return g;
}
function seriesOpening() {
  const g=game();
  g.players[0].hand=[...series().flat(),t(3,1),t(3,2),t(2,1),t(2,2),t(2,3),t(0,9)];
  assert.equal(g.openGroups(0,series()).ok,true);
  return g;
}
test('later pair addition and gather preserve committed five-pair opening',()=>{
  const g=pairOpening(); assert.equal(g.discard(0,t(3,1)).ok,true); rotate(g);
  const extra=pairs(6).at(-1);
  assert.equal(g.openGroups(0,[extra]).ok,true);
  assert.equal(g.players[0].pairCount,5); assert.equal(g.maxPairOpen,5);
  assert.equal(g.pairOpenBy[0],5); assert.equal(g.requiredPairsFor(1),6);
  assert.equal(g.gatherTiles(0).ok,true);
  assert.equal(g.players[0].pairCount,5); assert.equal(g.melds.length,5);
  assert.ok(extra.every(id=>g.players[0].hand.includes(id)));
  assert.equal(g.openGroups(0,[extra]).ok,true);
  assert.equal(g.discard(0,t(3,2)).ok,true);
  assert.equal(g.players[0].pairCount,5); assert.equal(g.maxPairOpen,5);
});
test('initial pending five plus one commits six, preserving folding minimum',()=>{
  const g=pairOpening(); assert.equal(g.openGroups(0,[pairs(6).at(-1)]).ok,true);
  assert.equal(g.players[0].pairCount,6);
  assert.equal(g.discard(0,t(3,1)).ok,true);
  assert.equal(g.pairOpenBy[0],6); assert.equal(g.maxPairOpen,6);
  assert.equal(g.requiredPairsFor(1),7);
});
test('pending extra-pair gather returns to five, full opening gather returns to zero',()=>{
  const g=pairOpening(); assert.equal(g.openGroups(0,[pairs(6).at(-1)]).ok,true);
  assert.equal(g.gatherTiles(0).ok,true); assert.equal(g.players[0].pairCount,5);
  assert.equal(g.gatherOpen(0).ok,true); assert.equal(g.players[0].pairCount,0);
  assert.equal(g.maxPairOpen,0); assert.equal(g.pairOpenBy[0],0);
  assert.equal(g.players[0].opened,false);
});
test('later series opening and processing retain committed122 points through gather',()=>{
  const g=seriesOpening(); assert.equal(g.players[0].openPoints,122);
  assert.equal(g.discard(0,t(3,1)).ok,true); rotate(g);
  const extra=[t(2,1),t(2,2),t(2,3)];
  assert.equal(g.openGroups(0,[extra]).ok,true);
  assert.equal(g.players[0].openPoints,122); assert.equal(g.seriesOpenBy[0],122);
  assert.equal(g.maxSeriesOpen,122); assert.equal(g.requiredSeriesFor(1),123);
  const target=g.melds.find(m=>m.owner===0 && m.tiles.includes(t(0,10)));
  assert.equal(g.processTile(0,t(0,9),target.id).ok,true);
  assert.equal(g.players[0].openPoints,122);
  assert.equal(g.gatherTiles(0).ok,true);
  assert.equal(g.players[0].openPoints,122); assert.equal(g.melds.length,3);
});
test('initial pending series extras still commit their full opening points',()=>{
  const g=seriesOpening(); const extra=[t(2,1),t(2,2),t(2,3)];
  assert.equal(g.openGroups(0,[extra]).ok,true); assert.equal(g.players[0].openPoints,128);
  assert.equal(g.discard(0,t(3,1)).ok,true);
  assert.equal(g.maxSeriesOpen,128); assert.equal(g.seriesOpenBy[0],128);
  assert.equal(g.requiredSeriesFor(1),129);
});
