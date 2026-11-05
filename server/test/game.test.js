'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/rules');
const folding = require('../src/folding');
const scoring = require('../src/scoring');
const bot = require('../src/bot');
const { Game } = require('../src/game');

// renk: 0 kırmızı, 1 mavi, 2 siyah, 3 sarı. copy: 0 veya 1
const t = (c, n, copy = 0) => c * 26 + copy * 13 + (n - 1);
const okey = { color: 2, number: 9 }; // siyah 9

const baseSettings = {
    folding: false,
    assisted: true,
    partners: false,
    sidePenalty: false,
    indicatorRule: false,
    pairThreshold: 5,
    wrongOpenPenalty: 101,
    sideTakePenalty: 101,
    workablePenalty: 0,
    totalRounds: 2,
};

const seats = [
    { name: 'A' },
    { name: 'B', isBot: true },
    { name: 'C', isBot: true },
    { name: 'D', isBot: true },
];

function newGame(over = {}) {
    const g = new Game({ ...baseSettings, ...over }, seats);
    g.startRound();
    g.okey = { ...okey };
    return g;
}

test('doğru seri', () => {
    const r = R.analyzeGroup([t(0, 3), t(0, 4), t(0, 5)], okey);
    assert.ok(r);
    assert.strictEqual(r.points, 12);
});

test('yanlış seri', () => {
    assert.strictEqual(R.analyzeGroup([t(0, 3), t(0, 4), t(0, 6)], okey), null);
    assert.strictEqual(R.analyzeGroup([t(0, 3), t(1, 4), t(0, 5)], okey), null);
});

test('aynı sayı farklı renk grubu', () => {
    assert.ok(R.analyzeGroup([t(0, 7), t(1, 7), t(3, 7)], okey));
    assert.strictEqual(R.analyzeGroup([t(0, 7), t(0, 7, 1), t(1, 7)], okey), null);
});

test('12-13-1 ve 13-1-2 GEÇERSİZ, 11-12-13 ve 1-2-3 geçerli', () => {
    assert.strictEqual(R.analyzeGroup([t(0, 12), t(0, 13), t(0, 1)], okey), null);
    assert.strictEqual(R.analyzeGroup([t(0, 13), t(0, 1), t(0, 2)], okey), null);
    assert.ok(R.analyzeGroup([t(0, 11), t(0, 12), t(0, 13)], okey));
    assert.ok(R.analyzeGroup([t(0, 1), t(0, 2), t(0, 3)], okey));
});

test('okey seri içinde joker, sahte okey okeyin değerini taşır', () => {
    const a = R.analyzeGroup([t(0, 3), t(0, 5), t(2, 9)], okey);
    assert.ok(a);
    assert.strictEqual(a.points, 12);
    const b = R.analyzeGroup([t(2, 8), 104, t(2, 10)], okey);
    assert.ok(b);
    assert.strictEqual(b.points, 27);
    assert.strictEqual(R.isWild(okey, 104), false);
});

test('gösterge ve okey hesabı', () => {
    assert.strictEqual(R.okeyFromIndicator(t(0, 5)).number, 6);
    assert.strictEqual(R.okeyFromIndicator(t(0, 13)).number, 1);
    assert.strictEqual(R.okeyFromIndicator(t(1, 13)).color, 1);
});

test('çift doğrulama', () => {
    assert.ok(R.analyzePair([t(0, 5), t(0, 5, 1)], okey));
    assert.strictEqual(R.analyzePair([t(0, 5), t(1, 5)], okey), null);
    assert.ok(R.analyzePair([t(0, 5), t(2, 9)], okey));
});

test('katlama eşiği', () => {
    const req = (f, m) =>
        folding.required({ type: 'series', folding: f, basePairs: 5, maxSeriesOpen: m, maxPairOpen: 0 });
    assert.strictEqual(req(false, 130), 101);
    assert.strictEqual(req(true, 130), 131);
    assert.strictEqual(req(true, 0), 101);
});

test('dağıtım: 22/21/21/21 ve 106 benzersiz taş', () => {
    const g = newGame();
    assert.strictEqual(g.players[0].hand.length, 22);
    assert.strictEqual(g.players[1].hand.length, 21);
    const all = new Set([...g.players.flatMap((p) => p.hand), ...g.deck, g.indicator]);
    assert.strictEqual(all.size, 106);
});

test('sıra kontrolü, çekme ve atma', () => {
    const g = newGame();
    assert.strictEqual(g.draw(1).ok, false);
    assert.strictEqual(g.discard(1, g.players[1].hand[0]).ok, false);
    assert.strictEqual(g.discard(0, g.players[0].hand[0]).ok, true);
    assert.strictEqual(g.current, 1);
    assert.strictEqual(g.draw(1).ok, true);
    assert.strictEqual(g.draw(1).ok, false);
    assert.strictEqual(g.players[1].hand.length, 22);
});

test('elde olmayan taş atılamaz', () => {
    const g = newGame();
    g.players[0].hand = [t(0, 1)];
    assert.strictEqual(g.discard(0, t(1, 2)).ok, false);
});

test('yanlış açılış: 101 ceza bir kez, süre değişmez', () => {
    const g = newGame();
    g.players[0].hand = [t(0, 3), t(0, 4), t(0, 5), t(3, 1)];
    const r = g.openGroups(0, [[t(0, 3), t(0, 4), t(0, 5)]]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(g.players[0].opened, false);
    assert.strictEqual(g.players[0].hand.length, 4);
    assert.strictEqual(g.players[0].score, 101);
    assert.strictEqual(g.turnAdjustMs, 0);
    assert.strictEqual(g.penalties.at(-1).type, 'Hatalı açılış');
    g.openGroups(0, [[t(0, 3), t(0, 4), t(0, 5)]]);
    assert.strictEqual(g.players[0].score, 101);
});

function openHand() {
    return [
        t(0, 10), t(0, 11), t(0, 12), t(0, 13),
        t(1, 10), t(1, 11), t(1, 12), t(1, 13),
        t(3, 9), t(3, 10), t(3, 11),
        t(0, 9), t(0, 3), t(3, 5),
    ];
}
const openGroups = () => [
    [t(0, 10), t(0, 11), t(0, 12), t(0, 13)],
    [t(1, 10), t(1, 11), t(1, 12), t(1, 13)],
    [t(3, 9), t(3, 10), t(3, 11)],
];

test('101 üstü açılış (+20 sn), geçerli ve geçersiz taş işleme', () => {
    const g = newGame();
    g.players[0].hand = openHand();
    const r = g.openGroups(0, openGroups());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(g.players[0].openPoints, 122);
    assert.strictEqual(g.turnAdjustMs, 20000);
    assert.strictEqual(g.melds.length, 3);
    const red = g.melds.find((m) => m.slots[0].color === 0);
    assert.strictEqual(g.processTile(0, t(0, 9), red.id).ok, true);
    assert.strictEqual(g.players[0].processedCount, 1);
    assert.strictEqual(g.processTile(0, t(0, 3), red.id).ok, false);
});

test('katlamalı modda önceki açılışın altı reddedilir, katlamasızda kabul edilir', () => {
    const a = newGame({ folding: true });
    a.maxSeriesOpen = 130;
    a.players[0].hand = openHand();
    assert.strictEqual(a.openGroups(0, openGroups()).ok, false);

    const b = newGame({ folding: false });
    b.maxSeriesOpen = 130;
    b.players[0].hand = openHand();
    assert.strictEqual(b.openGroups(0, openGroups()).ok, true);
});

test('beş çift açar, dört çift açamaz', () => {
    const pairs = (n) => Array.from({ length: n }, (_, i) => [t(0, i + 1), t(0, i + 1, 1)]);
    const a = newGame();
    a.players[0].hand = [...pairs(5).flat(), t(3, 2)];
    assert.strictEqual(a.openGroups(0, pairs(5)).ok, true);
    assert.strictEqual(a.players[0].openType, 'pairs');

    const b = newGame({ wrongOpenPenalty: 0 });
    b.players[0].hand = [...pairs(4).flat(), t(3, 2)];
    assert.strictEqual(b.openGroups(0, pairs(4)).ok, false);
});

test('çift açarken eşsiz taş okeyle birleşince kabul edilir', () => {
    const pairs = (n) => Array.from({ length: n }, (_, i) => [t(0, i + 1), t(0, i + 1, 1)]);
    const g = newGame();
    g.players[0].hand = [...pairs(4).flat(), t(3, 2), t(2, 9), t(1, 1)];
    const r = g.openGroups(0, [...pairs(4), [t(3, 2), t(2, 9)]]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(g.players[0].pairCount, 5);
});

test('aynı taş iki gruba konamaz', () => {
    const g = newGame({ wrongOpenPenalty: 0 });
    g.players[0].hand = [t(0, 3), t(0, 4), t(0, 5), t(0, 6), t(3, 1)];
    const r = g.openGroups(0, [
        [t(0, 3), t(0, 4), t(0, 5)],
        [t(0, 5), t(0, 6), t(0, 7)],
    ]);
    assert.strictEqual(r.ok, false);
});

test('çift açan oyuncu taş işleyemez', () => {
    const g = newGame();
    const pairs = Array.from({ length: 5 }, (_, i) => [t(0, i + 1), t(0, i + 1, 1)]);
    g.players[0].hand = [...pairs.flat(), t(3, 2)];
    g.openGroups(0, pairs);
    assert.strictEqual(g.processTile(0, t(3, 2), g.melds[0].id).ok, false);
});

test('işlek taş atana ceza yazılır', () => {
    const g = newGame({ workablePenalty: 101 });
    g.players[0].hand = openHand();
    assert.strictEqual(g.openGroups(0, openGroups()).ok, true);
    const r = g.discard(0, t(0, 9)); // kırmızı 10-13 serisine işler
    assert.strictEqual(r.ok, true);
    assert.strictEqual(g.players[0].score, 101);
    assert.strictEqual(g.penalties.at(-1).type, 'İşlek taş');
});

test('yandan alıp açamayan atamaz, geri bırakır, tekrar yandan alamaz', () => {
    const g = newGame();
    assert.strictEqual(g.discard(0, g.players[0].hand[0]).ok, true);
    assert.strictEqual(g.takeSide(1).ok, true);
    assert.strictEqual(g.players[1].hand.length, 22);
    assert.strictEqual(g.canReturnSide(1), true);
    assert.strictEqual(g.discard(1, g.players[1].hand[0]).ok, false);
    assert.strictEqual(g.returnSide(1).ok, true);
    assert.strictEqual(g.players[1].hand.length, 21);
    assert.strictEqual(g.discards[0].length, 1);
    assert.strictEqual(g.takeSide(1).ok, false);
    assert.strictEqual(g.draw(1).ok, true);
});

test('yandan alma cezalı modda açamayan atabilir ama ceza alır', () => {
    const g = newGame({ sidePenalty: true });
    g.discard(0, g.players[0].hand[0]);
    g.takeSide(1);
    assert.strictEqual(g.discard(1, g.players[1].hand[0]).ok, true);
    assert.strictEqual(g.players[1].score, 101);
    assert.strictEqual(g.penalties.length, 1);
});

test('okeyle bitiş çarpanı', () => {
    const g = newGame();
    const o = t(2, 9);
    g.players[0].hand = [o];
    g.players[0].opened = true;
    g.players[0].openType = 'series';
    assert.strictEqual(g.discard(0, o).ok, true);
    assert.strictEqual(g.phase, 'finished');
    assert.match(g.lastResult.finishType, /Okeyle/);
    assert.strictEqual(g.lastResult.deltas[0], -202);
});

test('maç sonu: son el bitince matchOver', () => {
    const g = newGame({ totalRounds: 1 });
    const o = t(2, 9);
    g.players[0].hand = [o];
    g.players[0].opened = true;
    g.players[0].openType = 'series';
    g.discard(0, o);
    assert.strictEqual(g.matchOver(), true);
    const h = newGame({ totalRounds: 2 });
    h.players[0].hand = [o];
    h.players[0].opened = true;
    h.players[0].openType = 'series';
    h.discard(0, o);
    assert.strictEqual(h.matchOver(), false);
});

test('eşli puanlama: takım arkadaşı 0, takım toplamı', () => {
    const g = newGame({ partners: true });
    g.players[0].hand = [t(0, 1)];
    g.players[0].opened = true;
    const res = scoring.compute({
        players: g.players, winner: 0, okeyFinish: false, pairFinish: false, okey, partners: true,
    });
    assert.strictEqual(res.deltas[2], 0);
    assert.strictEqual(res.deltas[0], -101);
    assert.strictEqual(res.teamTotals[0], res.totals[0] + res.totals[2]);
});

test('tekli puanlama: açmayan 202 alır', () => {
    const g = newGame();
    g.players[0].hand = [t(0, 1)];
    g.players[0].opened = true;
    const res = scoring.compute({
        players: g.players, winner: 0, okeyFinish: false, pairFinish: false, okey, partners: false,
    });
    assert.strictEqual(res.deltas[1], 202);
});

test('süre dolunca atılan taş: perdesiz, okey olmayan en düşük taş', () => {
    const g = newGame();
    g.players[0].hand = [t(0, 3), t(0, 4), t(0, 5), t(1, 7), t(3, 2), t(2, 9)];
    assert.strictEqual(bot.autoDiscard(g, 0), t(3, 2));
});

test('gizlilik: görünümde yalnızca kendi el var', () => {
    const g = newGame();
    const v = g.viewFor(1);
    assert.strictEqual(v.myHand.length, 21);
    assert.strictEqual(v.players[0].hand, undefined);
    assert.strictEqual(v.players[0].handCount, 22);
    assert.strictEqual(JSON.stringify(v).includes('"hand"'), false);
    assert.strictEqual(v.totalRounds, 2);
});

test('gösterge kuralı açıkken aşama beklenir ve onaylanınca oyun başlar', () => {
    const g = new Game({ ...baseSettings, indicatorRule: true }, seats);
    g.startRound();
    assert.strictEqual(g.phase, 'indicator');
    assert.strictEqual(g.draw(0).ok, false);
    g.confirmIndicator();
    assert.strictEqual(g.phase, 'playing');
    assert.ok(g.okey);
});

test('gösterge taşı olan oyuncu taşı tüketmeden gösterebilir', () => {
    const g = new Game({ ...baseSettings, indicatorRule: true }, seats);
    g.startRound();
    const indicator = t(1, 7);
    const heldTile = t(1, 7, 1);
    g.pendingIndicator = indicator;
    g.players[2].hand = [heldTile];

    assert.strictEqual(g.showIndicator(2, heldTile).ok, true);
    assert.strictEqual(g.indicatorShownBy, 2);
    assert.deepStrictEqual(g.players[2].hand, [heldTile]);
    assert.strictEqual(g.phase, 'indicator');
    assert.strictEqual(g.showIndicator(2, heldTile).ok, false);
    assert.strictEqual(g.showIndicator(1, heldTile).ok, false);
    assert.strictEqual(g.showIndicator(2, 104).ok, false);

    const view = g.viewFor(2);
    assert.strictEqual(view.indicatorShownBy, 2);
    assert.strictEqual(view.players[0].hand, undefined);
});