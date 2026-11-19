const test = require('node:test');
const assert = require('node:assert/strict');
const {Game} = require('../src/game');
test('score history separates penalties, survives next hand and only sends public scores', () => {
  const g = new Game({indicatorRule:false,totalRounds:8}, [{name:'A'},{name:'B'},{name:'C'},{name:'D'}]);
  g.startRound(); g.okey = {color:2,number:9};
  for (const p of g.players) { p.hand=[4]; p.opened=true; p.openType='series'; }
  g.players[2].opened=false;
  g.players[1].score=101; g.penalties.push({round:1,player:1,type:'İşlek taş',points:101});
  g.finish(null);
  assert.deepEqual(g.roundScores[0].remaining,[5,5,0,5]);
  assert.deepEqual(g.roundScores[0].penalties,[0,101,202,0]);
  assert.deepEqual(g.roundScores[0].deltas,[5,106,202,5]);
  assert.deepEqual(g.roundScores[0].totals,[5,106,202,5]);
  g.startRound();
  for (let seat=0;seat<4;seat++) {
    const view=g.viewFor(seat);
    assert.deepEqual(view.roundScores[0].penalties,[0,101,202,0]);
    assert.equal(JSON.stringify(view.roundScores).includes('hand'), false);
    view.roundScores[0].totals[0]=999;
    assert.equal(g.roundScores[0].totals[0],5);
  }
});
test('voided hands never create a score-history entry', () => {
  const g = new Game({indicatorRule:false,totalRounds:8}, [{name:'A'},{name:'B'},{name:'C'},{name:'D'}]);
  g.startRound(); g.finish(null,false,false,true);
  assert.equal(g.roundScores.length,0);
});
