'use strict';
const R = require('./rules');
const Arranger = require('./arranger');

// Kurala dayalı basit bot kararları (Dart tarafındaki bot_brain.dart ile aynı mantık).
// Botlar hamlelerini yine Game üzerinden yapar, bu yüzden geçersiz hamle uygulanamaz.

function canProcess(g, id) {
  return g.melds.some((m) => m.kind !== 'pair' && R.canExtend(m, id, g.okey) !== null);
}

/** Açılmamış bot yalnızca hemen açabiliyorsa yandan alır. */
function shouldTakeSide(g, p) {
  const pile = g.discards[(p + 3) % 4];
  if (pile.length === 0) return false;
  const t = pile[pile.length - 1];
  const pl = g.players[p];
  const okey = g.okey;
  if (pl.opened) {
    if (R.isWild(okey, t)) return true;
    if (canProcess(g, t)) return true;
    if (pl.openType !== 'series') return false;
    const after = Arranger.bestSeries([...pl.hand, t], okey);
    return after.groups.some((gr) => gr.tiles.includes(t));
  }
  const after = Arranger.bestSeries([...pl.hand, t], okey);
  const usesTile = after.groups.some((gr) => gr.tiles.includes(t));
  return usesTile && after.points >= g.requiredSeriesFor(p);
}

/** Açılacak grupları (taş kimliği listeleri) döndürür. Açılamıyorsa null. */
function planOpen(g, p) {
  const pl = g.players[p];
  const okey = g.okey;
  if (pl.opened && pl.openType === 'pairs') {
    const a = Arranger.bestPairs(pl.hand, okey);
    return a.groups.length ? a.groups.map((x) => x.tiles) : null;
  }
  const a = Arranger.bestSeries(pl.hand, okey);
  if (pl.opened) return a.groups.length ? a.groups.map((x) => x.tiles) : null;
  if (a.groups.length && a.points >= g.requiredSeriesFor(p)) return a.groups.map((x) => x.tiles);
  const pr = Arranger.bestPairs(pl.hand, okey);
  if (pr.groups.length >= g.requiredPairsFor(p)) return pr.groups.map((x) => x.tiles);
  return null;
}

/** Açmış her bot (seri ya da çift) seri perlerine taş işleyebilir. */
function nextProcess(g, p) {
  const pl = g.players[p];
  if (!pl.opened) return null;
  for (const t of pl.hand) {
    if (R.isWild(g.okey, t) && pl.hand.length > 2) continue;
    for (const m of g.melds) {
      if (m.kind === 'pair') continue;
      if (R.canExtend(m, t, g.okey) !== null) return { tile: t, meldId: m.id };
    }
  }
  return null;
}

const valueOf = (t, okey) => {
  const s = R.slotOf(okey, t);
  return s ? R.slotValue(s) : 0;
};

/** Taşı elde tutmanın değeri (düşükse atılır). */
function keepScore(t, hand, okey) {
  const s = R.slotOf(okey, t);
  if (!s) return 100;
  let sc = 0;
  for (const o of hand) {
    if (o === t) continue;
    const os = R.slotOf(okey, o);
    if (!os) continue;
    if (os.color === s.color && os.number === s.number) sc += 3;
    else if (os.color === s.color) {
      const d = Math.abs(os.number - s.number);
      if (d === 1) sc += 2;
      else if (d === 2) sc += 1;
    } else if (os.number === s.number) sc += 2;
  }
  return sc;
}

function chooseDiscard(g, p) {
  const okey = g.okey;
  const hand = g.players[p].hand;
  const a = Arranger.bestSeries(hand, okey);
  let cands = a.leftover.filter((t) => !R.isWild(okey, t));
  if (cands.length === 0) cands = hand.filter((t) => !R.isWild(okey, t));
  if (cands.length === 0) cands = [...hand];
  const safe = cands.filter((t) => !canProcess(g, t));
  if (safe.length) cands = safe; // işlek taş atıp ceza almasın
  let best = cands[0];
  let bestScore = Infinity;
  for (const t of cands) {
    const s = keepScore(t, hand, okey);
    if (s < bestScore || (s === bestScore && valueOf(t, okey) > valueOf(best, okey))) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Süresi dolan oyuncu için otomatik atış:
 * perde olmayan, okey olmayan en düşük sayılı taş (mümkünse işlek olmayan).
 */
function autoDiscard(g, p) {
  const okey = g.okey;
  const hand = g.players[p].hand;
  const a = Arranger.bestSeries(hand, okey);
  let c = a.leftover.filter((t) => !R.isWild(okey, t));
  if (c.length === 0) c = hand.filter((t) => !R.isWild(okey, t));
  if (c.length === 0) c = [...hand];
  const safe = c.filter((t) => !canProcess(g, t));
  if (safe.length) c = safe;
  c.sort((x, y) => valueOf(x, okey) - valueOf(y, okey));
  return c[0];
}

module.exports = { shouldTakeSide, planOpen, nextProcess, chooseDiscard, autoDiscard };