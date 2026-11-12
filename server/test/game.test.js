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
  partnerFolding: true,
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

/** Masaya doğrudan bir per koyar (test düzeneği). */
function meldOf(g, id, owner, tiles) {
  const r = R.analyzeGroup(tiles, g.okey);
  const m = {
    id,
    owner,
    kind: r.kind,
    tiles: [...r.tiles],
    slots: r.slots.map((s) => ({ color: s.color, number: s.number })),
    addedBy: r.tiles.map(() => -1),
  };
  g.melds.push(m);
  return m;
}

const pairs = (n) => Array.from({ length: n }, (_, i) => [t(0, i + 1), t(0, i + 1, 1)]);

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

test('göstergeyi göstermeyen oyuncu çiftte joker kullanamaz', () => {
  const g = newGame();
  g.indicator = t(3, 5);
  const indicatorPair = [t(0, 8), g.indicator];

  g.players[0].hand = [...pairs(4).flat(), ...indicatorPair, t(3, 2)];
  const result = g.openGroups(0, [...pairs(4), indicatorPair]);
  assert.strictEqual(result.ok, false);

  g.indicatorShownBy = 0;
  const shownResult = g.openGroups(0, [...pairs(4), indicatorPair]);
  assert.strictEqual(shownResult.ok, true, shownResult.message);
  assert.strictEqual(g.players[0].pairCount, 5);

  const other = newGame();
  other.indicator = t(3, 5);
  other.indicatorShownBy = 0;
  other.players[1].hand = [...pairs(4).flat(), ...indicatorPair, t(3, 2)];
  const otherResult = other.openGroups(1, [...pairs(4), indicatorPair]);
  assert.strictEqual(otherResult.ok, false);
});

test('göstergeyi göstermeyen oyuncu çift işleyemez', () => {
  const g = newGame();
  g.indicator = t(3, 5);
  g.current = 0;
  g.step = 'play';
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(0, 8), g.indicator, t(3, 2)];
  g.players[1].opened = true;
  g.players[1].openType = 'pairs';

  assert.strictEqual(g.processPair(0, t(0, 8), g.indicator, 1).ok, false);
  g.indicatorShownBy = 0;
  assert.strictEqual(g.processPair(0, t(0, 8), g.indicator, 1).ok, true);
});

test('katlama eşiği', () => {
  const req = (f, m) =>
    folding.required({ type: 'series', folding: f, basePairs: 5, maxSeriesOpen: m, maxPairOpen: 0 });
  assert.strictEqual(req(false, 130), 101);
  assert.strictEqual(req(true, 130), 131);
  assert.strictEqual(req(true, 0), 101);
});

test('eşe katlama: kapalıyken eşin açılışı eşiği yükseltmez', () => {
  const a = newGame({ partners: true, folding: true, partnerFolding: false });
  a.seriesOpenBy = [0, 0, 130, 0];
  a.maxSeriesOpen = 130;
  assert.strictEqual(a.requiredSeriesFor(0), 101); // 2 numara eşi
  assert.strictEqual(a.requiredSeriesFor(1), 131); // 2 numara rakibi
  const b = newGame({ partners: true, folding: true, partnerFolding: true });
  b.seriesOpenBy = [0, 0, 130, 0];
  b.maxSeriesOpen = 130;
  assert.strictEqual(b.requiredSeriesFor(0), 131);
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

test('yanlış açılış düzeltildikten sonra ceza uygulanmaz', () => {
  const g = newGame();
  g.players[0].hand = [t(0, 3), t(0, 4), t(0, 5), t(3, 1)];
  const r = g.openGroups(0, [[t(0, 3), t(0, 4), t(0, 5)]]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(g.players[0].opened, false);
  assert.strictEqual(g.players[0].hand.length, 4);
  assert.strictEqual(g.players[0].score, 0);
  assert.strictEqual(g.turnAdjustMs, 0);
  assert.strictEqual(g.penalties.length, 0);
  g.players[0].hand = openHand();
  assert.strictEqual(g.openGroups(0, openGroups()).ok, true);
  assert.strictEqual(g.discard(0, t(3, 5)).ok, true);
  assert.strictEqual(g.players[0].score, 0);
  assert.strictEqual(g.penalties.length, 0);
});

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

test('bitiş için son taş per olarak işlenmeden atılmalıdır', () => {
  const g = newGame();
  const meld = meldOf(g, 50, 1, [t(0, 10), t(0, 11), t(0, 12)]);
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(0, 9)];

  assert.strictEqual(g.processTile(0, t(0, 9), meld.id).ok, false);
  assert.deepStrictEqual(g.players[0].hand, [t(0, 9)]);
  assert.strictEqual(g.phase, 'playing');

  g.players[0].hand.push(t(3, 2));
  assert.strictEqual(g.processTile(0, t(0, 9), meld.id).ok, true);
  assert.deepStrictEqual(g.players[0].hand, [t(3, 2)]);
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.discard(0, t(3, 2)).ok, true);
  assert.strictEqual(g.phase, 'finished');
});

test('otomatik işleme bitiş taşını elde bırakır', () => {
  const g = newGame();
  const meld = meldOf(g, 50, 1, [t(0, 10), t(0, 11), t(0, 12), t(0, 13)]);
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(0, 9), t(0, 8), t(3, 2)];

  assert.strictEqual(g.autoProcess(0).ok, true);
  assert.deepStrictEqual(g.players[0].hand, [t(3, 2)]);
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.discard(0, t(3, 2)).ok, true);
  assert.strictEqual(g.phase, 'finished');
});

test('çift işleme son taşı bırakır, ardından atışla bitilir', () => {
  const g = newGame();
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(0, 5), t(0, 5, 1)];
  g.players[1].opened = true;
  g.players[1].openType = 'pairs';

  assert.strictEqual(g.processPair(0, t(0, 5), t(0, 5, 1), 1).ok, false);
  g.players[0].hand.push(t(3, 2));
  assert.strictEqual(g.processPair(0, t(0, 5), t(0, 5, 1), 1).ok, true);
  assert.deepStrictEqual(g.players[0].hand, [t(3, 2)]);
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.discard(0, t(3, 2)).ok, true);
  assert.strictEqual(g.phase, 'finished');
});

test('bütün perler açılınca bir taş atmak için elde bırakılmalıdır', () => {
  const g = newGame();
  g.players[0].hand = openGroups().flat();

  assert.strictEqual(g.openGroups(0, openGroups()).ok, false);
  assert.strictEqual(g.players[0].hand.length, 11);
  assert.strictEqual(g.phase, 'playing');

  g.players[0].hand.push(t(3, 2));
  assert.strictEqual(g.openGroups(0, openGroups()).ok, true);
  assert.deepStrictEqual(g.players[0].hand, [t(3, 2)]);
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.discard(0, t(3, 2)).ok, true);
  assert.strictEqual(g.phase, 'finished');
});

test('Eli Topla sonrası yeniden açarsa ceza almaz, vazgeçip taş atarsa ceza alır', () => {
  const g = newGame();
  g.players[0].hand = openHand();
  assert.strictEqual(g.openGroups(0, openGroups()).ok, true);
  assert.strictEqual(g.hasPendingOpen(0), true);
  assert.strictEqual(g.gatherOpen(0).ok, true);
  assert.strictEqual(g.players[0].hand.length, 14);
  assert.strictEqual(g.players[0].opened, false);
  assert.strictEqual(g.melds.length, 0);
  assert.strictEqual(g.maxSeriesOpen, 0);
  assert.strictEqual(g.players[0].score, 0);
  assert.strictEqual(g.openGroups(0, openGroups()).ok, true);
  assert.strictEqual(g.discard(0, t(3, 5)).ok, true);
  assert.strictEqual(g.players[0].score, 0);
  assert.strictEqual(g.penalties.length, 0);
});

test('Eli Topla sonrası açmaktan vazgeçip taş atınca ceza yazar', () => {
  const g = newGame();
  g.players[0].hand = openHand();
  assert.strictEqual(g.openGroups(0, openGroups()).ok, true);
  assert.strictEqual(g.gatherOpen(0).ok, true);
  assert.strictEqual(g.players[0].score, 0);
  assert.strictEqual(g.discard(0, t(3, 5)).ok, true);
  assert.strictEqual(g.players[0].score, 101);
  assert.strictEqual(g.penalties.at(-1).type, 'Hatalı açılış');
});

test('taş atınca açılış kesinleşir', () => {
  const g = newGame();
  g.players[0].hand = openHand();
  g.openGroups(0, openGroups());
  assert.strictEqual(g.discard(0, t(3, 5)).ok, true);
  assert.strictEqual(g.players[0].opened, true);
  assert.strictEqual(g.melds.length, 3);
  assert.strictEqual(g.current, 1);
});

test('Taşları Topla: işlenen taş geri gelir, açılış kalır', () => {
  const g = newGame();
  g.players[0].hand = openHand();
  g.openGroups(0, openGroups());
  const red = g.melds.find((m) => m.slots[0].color === 0);
  assert.strictEqual(g.processTile(0, t(0, 9), red.id).ok, true);
  assert.strictEqual(red.tiles.length, 5);
  assert.strictEqual(g.canGatherTiles(0), true);
  assert.strictEqual(g.gatherTiles(0).ok, true);
  assert.strictEqual(red.tiles.length, 4);
  assert.ok(g.players[0].hand.includes(t(0, 9)));
  assert.strictEqual(g.players[0].processedCount, 0);
  assert.strictEqual(g.players[0].opened, true);
});

test('çift açan oyuncu seri perine taş işleyebilir', () => {
  const g = newGame();
  const m = meldOf(g, 50, 1, [t(0, 10), t(0, 11), t(0, 12), t(0, 13)]);
  g.players[0].opened = true;
  g.players[0].openType = 'pairs';
  g.players[0].hand = [t(0, 9), t(3, 2)];
  assert.strictEqual(g.processTile(0, t(0, 9), m.id).ok, true);
  assert.strictEqual(m.tiles.length, 5);
});

test('seri açan, çift açana çift işler ve geri alabilir', () => {
  const g = newGame();
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(0, 5), t(0, 5, 1), t(3, 2), t(1, 7)];
  g.players[1].opened = true;
  g.players[1].openType = 'pairs';
  assert.strictEqual(g.processPair(0, t(3, 2), t(1, 7), 1).ok, false); // çift değil
  assert.strictEqual(g.processPair(0, t(0, 5), t(0, 5, 1), 2).ok, false); // hedef çift açmamış
  assert.strictEqual(g.processPair(0, t(0, 5), t(0, 5, 1), 1).ok, true);
  assert.strictEqual(g.players[0].hand.length, 2);
  assert.strictEqual(g.players[0].processedCount, 2);
  assert.strictEqual(g.gatherTiles(0).ok, true);
  assert.strictEqual(g.players[0].hand.length, 4);
});

test('çift açan çift işleyemez', () => {
  const g = newGame();
  g.players[0].opened = true;
  g.players[0].openType = 'pairs';
  g.players[0].hand = [t(0, 5), t(0, 5, 1), t(3, 2)];
  g.players[1].opened = true;
  g.players[1].openType = 'pairs';
  assert.strictEqual(g.processPair(0, t(0, 5), t(0, 5, 1), 1).ok, false);
});

test('okey alma: uyan taş okeyi alır, uymayan reddedilir, geri alınır', () => {
  const g = newGame();
  const m = meldOf(g, 51, 1, [t(0, 10), t(2, 9), t(0, 12)]);
  assert.strictEqual(m.tiles[1], t(2, 9));
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(0, 11), t(3, 2)];
  assert.strictEqual(g.swapOkey(0, t(3, 2), m.id, 1).ok, false);
  assert.strictEqual(g.swapOkey(0, t(0, 11), m.id, 0).ok, false); // orada okey yok
  assert.strictEqual(g.swapOkey(0, t(0, 11), m.id, 1).ok, true);
  assert.strictEqual(m.tiles[1], t(0, 11));
  assert.ok(g.players[0].hand.includes(t(2, 9)));
  assert.strictEqual(g.gatherTiles(0).ok, true);
  assert.strictEqual(m.tiles[1], t(2, 9));
  assert.ok(g.players[0].hand.includes(t(0, 11)));
});

test('set perindeki okey, dördüncü taş eklenmeden alınamaz', () => {
  const g = newGame();
  const m = meldOf(g, 53, 1, [t(0, 12), t(1, 12), t(2, 9)]);
  g.current = 0;
  g.step = 'play';
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(3, 12), t(2, 12), t(3, 5)];

  assert.strictEqual(g.swapOkey(0, t(2, 12), m.id, 2).ok, false);
  assert.strictEqual(g.processTile(0, t(3, 12), m.id).ok, true);
  assert.strictEqual(g.swapOkey(0, t(2, 12), m.id, 2).ok, true);
  assert.ok(m.tiles.includes(t(3, 12)));
  assert.ok(g.players[0].hand.includes(t(2, 9)));
});

test('13 grubunda joker rengi mavi 13 işlenince değişir ve geri alınır', () => {
  const g = newGame();
  const joker = t(2, 9);
  const blue = t(1, 13);
  const redCopy = t(0, 13, 1);
  const m = meldOf(g, 54, 1, [t(2, 13), t(0, 13), joker]);
  g.current = 0;
  g.step = 'play';
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [blue, redCopy, t(3, 13), t(3, 5)];
  assert.strictEqual(g.processTile(0, redCopy, m.id).ok, false);
  assert.strictEqual(g.processTile(0, blue, m.id).ok, true);
  assert.strictEqual(m.slots[m.tiles.indexOf(joker)].color, 3);
  assert.ok(m.tiles.includes(blue));
  assert.strictEqual(g.gatherTiles(0).ok, true);
  assert.strictEqual(m.slots[m.tiles.indexOf(joker)].color, 1);
  assert.ok(g.players[0].hand.includes(blue));
  assert.strictEqual(g.processTile(0, blue, m.id).ok, true);
  assert.strictEqual(g.swapOkey(0, t(3, 13), m.id, m.tiles.indexOf(joker)).ok, true);
});

test('Taşları İşle (otomatik) işlenebilenleri işler, okeyi tutar', () => {
  const g = newGame();
  meldOf(g, 52, 1, [t(0, 10), t(0, 11), t(0, 12), t(0, 13)]);
  g.players[0].opened = true;
  g.players[0].openType = 'series';
  g.players[0].hand = [t(0, 9), t(0, 8), t(2, 9), t(3, 2)];
  assert.strictEqual(g.autoProcess(0).ok, true);
  assert.strictEqual(g.players[0].hand.length, 2);
  assert.ok(g.players[0].hand.includes(t(2, 9)));
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
  const a = newGame();
  a.players[0].hand = [...pairs(5).flat(), t(3, 2)];
  assert.strictEqual(a.openGroups(0, pairs(5)).ok, true);
  assert.strictEqual(a.players[0].openType, 'pairs');

  const b = newGame({ wrongOpenPenalty: 0 });
  b.players[0].hand = [...pairs(4).flat(), t(3, 2)];
  assert.strictEqual(b.openGroups(0, pairs(4)).ok, false);
});

test('çift açarken eşsiz taş okeyle birleşince kabul edilir', () => {
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

test('işlek taş atana ceza yazılır', () => {
  const g = newGame({ workablePenalty: 101 });
  g.players[0].hand = openHand();
  assert.strictEqual(g.openGroups(0, openGroups()).ok, true);
  const r = g.discard(0, t(0, 9)); // kırmızı 10-13 serisine işler
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.players[0].score, 101);
  assert.strictEqual(g.penalties.at(-1).type, 'İşlek taş');
});

test('serideki okeyin yerine geçebilen taşı atana ceza yazılır', () => {
  const g = newGame({ workablePenalty: 101 });
  g.current = 0;
  g.step = 'play';
  g.players[0].hand = [t(0, 5), t(3, 8)];
  meldOf(g, 0, 1, [t(0, 4), t(2, 9), t(0, 6)]);

  assert.strictEqual(g.discard(0, t(0, 5)).ok, true);
  assert.strictEqual(g.players[0].score, 101);
  assert.strictEqual(g.penalties.at(-1).type, 'İşlek taş');
});

test('çiftteki okeyin yerine geçebilen taşı atana ceza yazılır', () => {
  const g = newGame({ workablePenalty: 101 });
  g.current = 0;
  g.step = 'play';
  g.players[0].hand = [t(0, 7, 1), t(3, 8)];
  const resolved = R.analyzePair([t(0, 7), t(2, 9)], g.okey);
  g.melds.push({
    id: 0,
    owner: 1,
    kind: 'pair',
    tiles: [...resolved.tiles],
    slots: resolved.slots.map((s) => ({ color: s.color, number: s.number })),
    addedBy: [-1, -1],
  });

  assert.strictEqual(g.discard(0, t(0, 7, 1)).ok, true);
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

test('yandan alınan taşı kullanmayan geri bırakıp ortadan çekmelidir', () => {
  const g = newGame({ sidePenalty: true });
  g.discard(0, g.players[0].hand[0]);
  g.takeSide(1);
  assert.strictEqual(g.discard(1, g.players[1].hand[0]).ok, false);
  assert.strictEqual(g.returnSide(1).ok, true);
  assert.strictEqual(g.draw(1).ok, true);
  assert.strictEqual(g.players[1].score, 0);
  assert.strictEqual(g.penalties.length, 0);
});

test('açmış oyuncu da kullanmadığı yandan taşı geri bırakmalıdır', () => {
  const g = newGame();
  const side = t(1, 7);
  const spare = t(3, 9);
  g.current = 1;
  g.step = 'draw';
  g.players[1].opened = true;
  g.players[1].openType = 'series';
  g.players[1].hand = [spare];
  g.discards[0] = [side];

  assert.strictEqual(g.takeSide(1).ok, true);
  assert.strictEqual(g.canReturnSide(1), true);
  assert.strictEqual(g.discard(1, spare).ok, false);
  assert.strictEqual(g.returnSide(1).ok, true);
  assert.strictEqual(g.draw(1).ok, true);
});

test('açmış oyuncu yandan aldığı taşı işlerse atış yapabilir', () => {
  const g = newGame();
  const side = t(0, 4);
  const spare = t(3, 8);
  g.current = 1;
  g.step = 'draw';
  g.players[1].opened = true;
  g.players[1].openType = 'series';
  g.players[1].hand = [spare];
  g.discards[0] = [side];
  const meld = meldOf(g, 0, 2, [t(0, 5), t(0, 6), t(0, 7)]);

  assert.strictEqual(g.takeSide(1).ok, true);
  assert.strictEqual(g.processTile(1, side, meld.id).ok, true);
  assert.strictEqual(g.canReturnSide(1), false);
  assert.strictEqual(g.discard(1, spare).ok, true);
});

test('yandan alınan taş açılışta kullanılmıyorsa açılış reddedilir', () => {
  const g = newGame();
  g.discards[0] = [t(1, 7)];
  g.current = 1;
  g.step = 'draw';
  assert.strictEqual(g.takeSide(1).ok, true);
  const pairGroups = [...pairs(5), [t(1, 7), t(1, 7, 1)]];
  g.players[1].hand = [...pairGroups.flat(), t(3, 2), t(0, 6)];

  assert.strictEqual(g.openGroups(1, pairs(5)).ok, false);
  assert.strictEqual(g.canReturnSide(1), true);
  assert.strictEqual(g.returnSide(1).ok, true);
  assert.strictEqual(g.draw(1).ok, true);
});

test('yandan alınan taşla çift açılırsa taşı atana 20 kat ceza, taş atınca yazılır', () => {
  const g = newGame({ sidePenalty: true });
  g.discards[0] = [t(1, 7)];
  g.current = 1;
  g.step = 'draw';
  assert.strictEqual(g.takeSide(1).ok, true);
  const pairGroups = [...pairs(4), [t(1, 7), t(1, 7, 1)]];
  g.players[1].hand = [...pairGroups.flat(), t(3, 2), t(0, 6)];
  assert.strictEqual(g.openGroups(1, pairGroups).ok, true);
  assert.strictEqual(g.players[0].score, 0); // henüz kesinleşmedi
  assert.strictEqual(g.discard(1, t(3, 2)).ok, true);
  assert.strictEqual(g.players[0].score, 140);
  assert.strictEqual(g.penalties.at(-1).type, 'Yandan alınan taşla çift açıldı');
});

test('yandan alınan taşla seri açılırsa taşı atana 10 kat ceza yazılır', () => {
  const g = newGame({ sidePenalty: true });
  g.discards[0] = [t(0, 13)];
  g.current = 1;
  g.step = 'draw';
  assert.strictEqual(g.takeSide(1).ok, true);
  g.players[1].hand = openHand();
  assert.strictEqual(g.openGroups(1, openGroups()).ok, true);
  assert.strictEqual(g.players[0].score, 0); // henüz kesinleşmedi
  assert.strictEqual(g.discard(1, t(3, 5)).ok, true);
  assert.strictEqual(g.players[0].score, 130);
  assert.strictEqual(g.penalties.at(-1).type, 'Yandan alınan taşla seri açıldı');
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

test('çift açan eli kaybederse eldeki taşların 2 katı yazılır', () => {
  const g = newGame();
  g.players[0].hand = [t(0, 1)];
  g.players[0].opened = true;
  g.players[1].hand = [t(0, 3), t(0, 4)];
  g.players[1].opened = true;
  g.players[1].openType = 'pairs';
  const res = scoring.compute({
    players: g.players, winner: 0, okeyFinish: false, pairFinish: false, okey, partners: false,
  });
  assert.strictEqual(res.deltas[1], 14); // (3 + 4) x 2
});

test('kafa bitişinde açılmış rakip x1, açmamış rakip x2 yazar', () => {
  const g = newGame();
  g.players[0].opened = true;
  g.players[1].opened = true;
  g.players[1].hand = [t(0, 3), t(0, 4)];
  const res = scoring.compute({
    players: g.players,
    winner: 0,
    okeyFinish: false,
    pairFinish: false,
    kafaFinish: true,
    okey,
    partners: false,
  });
  assert.deepStrictEqual(res.deltas, [-202, 7, 404, 404]);
  assert.strictEqual(res.finishType, 'Kafa bitişi (x2)');
});

test('okey kafa: bitiren -404, açmış rakip x2, açmamış rakip 808', () => {
  const g = newGame();
  g.players[0].opened = true;
  g.players[1].opened = true;
  g.players[1].hand = [t(0, 3), t(0, 4)];
  const res = scoring.compute({
    players: g.players,
    winner: 0,
    okeyFinish: true,
    pairFinish: false,
    kafaFinish: true,
    okey,
    partners: false,
  });
  assert.deepStrictEqual(res.deltas, [-404, 14, 808, 808]);
});

test('eşli kafa bitişinde açan rakip olunca açmayanın cezası yarıya iner', () => {
  const g = newGame({ partners: true });
  g.players[0].opened = true;
  g.players[1].opened = true;
  g.players[1].hand = [];
  const res = scoring.compute({
    players: g.players,
    winner: 0,
    okeyFinish: true,
    pairFinish: false,
    kafaFinish: true,
    okey,
    partners: true,
  });
  assert.deepStrictEqual(res.deltas, [-404, 0, 0, 404]);
});

test('çift açanın 100 üstü eli için +101, bitiş çarpanından sonra eklenir', () => {
  const g = newGame();
  g.players[0].opened = true;
  g.players[1].opened = true;
  g.players[1].openType = 'pairs';
  g.players[1].hand = Array.from({ length: 4 }, (_, c) => [t(c, 13), t(c, 13, 1)]).flat();
  const res = scoring.compute({
    players: g.players,
    winner: 0,
    okeyFinish: true,
    pairFinish: false,
    okey,
    partners: false,
  });
  assert.strictEqual(res.deltas[1], 517); // 104 x 2 x 2 + 101
});

test('dört oyuncu çift açınca el cezasız iptal olur ve tur sayılmaz', () => {
  const g = newGame({ totalRounds: 1 });
  for (const p of g.players.slice(0, 3)) {
    p.opened = true;
    p.openType = 'pairs';
    p.pairCount = 5;
  }
  g.players[0].score = 101;
  g.penalties.push({ round: g.round, player: 0, type: 'İşlek taş', points: 101 });
  const groups = pairs(5);
  g.players[3].hand = [...groups.flat(), t(3, 2)];
  g.current = 3;
  g.step = 'play';

  assert.strictEqual(g.openGroups(3, groups).ok, true);
  assert.strictEqual(g.lastResult.voided, true);
  assert.deepStrictEqual(g.lastResult.deltas, [0, 0, 0, 0]);
  assert.strictEqual(g.players[0].score, 0);
  assert.deepStrictEqual(g.penalties, []);
  assert.strictEqual(g.matchOver(), false);
  g.startRound();
  assert.strictEqual(g.round, 1);
});

test('son çektiği taşı doğrudan atmak kafa bitişidir', () => {
  const g = newGame();
  g.players[0].hand = [];
  g.players[0].opened = true;
  g.current = 0;
  g.step = 'draw';
  g.deck = [t(0, 5)];
  assert.strictEqual(g.draw(0).ok, true);
  assert.strictEqual(g.discard(0, t(0, 5)).ok, true);
  assert.strictEqual(g.lastResult.kafaFinish, true);
  assert.strictEqual(g.lastResult.deltas[0], -202);
  assert.strictEqual(g.lastResult.deltas[2], 404);
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
test('bot, gösterdiği taşı çift açarken joker olarak kullanır', () => {
  const g = newGame();
  g.indicator = t(2, 8);
  g.players[1].hand = [t(0, 1), t(0, 1, 1), t(1, 3), t(1, 3, 1),
    t(2, 5), t(2, 5, 1), t(3, 7), t(3, 7, 1), t(2, 8, 1), t(0, 10), t(1, 12)];
  assert.strictEqual(bot.planOpen(g, 1), null);
  g.indicatorShownBy = 1;
  const plan = bot.planOpen(g, 1);
  assert.strictEqual(plan.length, 5);
  assert.ok(plan.some((pair) => pair.includes(t(2, 8, 1))));
});
test('son deste taşı çekilince ilk geçerli atış eli bitirir', () => {
  const g = newGame();
  const drawn = t(0, 5);
  const discarded = t(0, 6);
  g.players[0].hand = [discarded];
  g.current = 0;
  g.step = 'draw';
  g.deck = [drawn];
  assert.equal(g.draw(0).ok, true);
  assert.equal(g.phase, 'playing');
  assert.equal(g.discard(0, discarded).ok, true);
  assert.equal(g.phase, 'finished');
  assert.equal(g.lastResult.winner, null);
  assert.deepEqual(g.discards[0], [discarded]);
  assert.equal(g.takeSide(1).ok, false);
});
