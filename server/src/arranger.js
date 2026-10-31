'use strict';
const R = require('./rules');

const k = (c, n) => c * 20 + n;
let cache = null;

function buildCands() {
    const out = [];
    for (let c = 0; c < 4; c++) {
        for (let len = 3; len <= 5; len++) {
            for (let s = 1; s + len - 1 <= 13; s++) {
                const pos = [];
                for (let p = s; p < s + len; p++) pos.push(p);
                const pts = pos.reduce((a, p) => a + p, 0);
                out.push({ keys: pos.map((p) => k(c, p)), wilds: 0, points: pts });
                for (let j = 0; j < len; j++) {
                    out.push({
                        keys: pos.filter((_, i) => i !== j).map((p) => k(c, p)),
                        wilds: 1,
                        points: pts,
                    });
                }
            }
        }
    }
    for (let n = 1; n <= 13; n++) {
        for (let mask = 0; mask < 16; mask++) {
            const colors = [];
            for (let c = 0; c < 4; c++) if (mask & (1 << c)) colors.push(c);
            const keys = colors.map((c) => k(c, n));
            if (colors.length === 4) out.push({ keys, wilds: 0, points: n * 4 });
            if (colors.length === 3) {
                out.push({ keys, wilds: 0, points: n * 3 });
                out.push({ keys, wilds: 1, points: n * 4 });
            }
            if (colors.length === 2) out.push({ keys, wilds: 1, points: n * 3 });
        }
    }
    out.sort((a, b) => b.points - a.points);
    return out;
}

const cands = () => (cache = cache || buildCands());

/** Eldeki taşlardan toplam puanı en yüksek geçerli seri/grup dizilimi. */
function bestSeries(hand, okey) {
    const avail = new Map();
    const wilds = [];
    for (const t of hand) {
        if (R.isWild(okey, t)) wilds.push(t);
        else {
            const key = R.slotKey(R.slotOf(okey, t));
            if (!avail.has(key)) avail.set(key, []);
            avail.get(key).push(t);
        }
    }
    const counts = new Map([...avail].map(([key, v]) => [key, v.length]));
    const list = cands().filter(
        (c) => c.wilds <= wilds.length && c.keys.every((key) => (counts.get(key) || 0) >= 1)
    );

    let bestPts = 0;
    let bestWilds = 1 << 20;
    let bestSel = [];
    const sel = [];
    let wildLeft = wilds.length;
    let wildsUsed = 0;
    let nodes = 0;

    function dfs(from, pts) {
        if (++nodes > 60000) return;
        if (pts > bestPts || (pts === bestPts && pts > 0 && wildsUsed < bestWilds)) {
            bestPts = pts;
            bestWilds = wildsUsed;
            bestSel = [...sel];
        }
        for (let i = from; i < list.length; i++) {
            const c = list[i];
            if (c.wilds > wildLeft) continue;
            if (!c.keys.every((key) => (counts.get(key) || 0) >= 1)) continue;
            for (const key of c.keys) counts.set(key, counts.get(key) - 1);
            wildLeft -= c.wilds;
            wildsUsed += c.wilds;
            sel.push(i);
            dfs(i, pts + c.points);
            sel.pop();
            wildLeft += c.wilds;
            wildsUsed -= c.wilds;
            for (const key of c.keys) counts.set(key, counts.get(key) + 1);
        }
    }
    dfs(0, 0);

    const pool = new Map([...avail].map(([key, v]) => [key, [...v]]));
    const wpool = [...wilds];
    const groups = [];
    const used = new Set();
    for (const i of bestSel) {
        const c = list[i];
        const tiles = [];
        for (const key of c.keys) tiles.push(pool.get(key).pop());
        for (let w = 0; w < c.wilds; w++) tiles.push(wpool.pop());
        const r = R.analyzeGroup(tiles, okey);
        if (!r) continue;
        groups.push(r);
        tiles.forEach((t) => used.add(t));
    }
    const leftover = hand.filter((t) => !used.has(t));
    return { groups, leftover, points: groups.reduce((a, g) => a + g.points, 0) };
}

/** Eldeki taşlardan mümkün olan en çok çifti bulur (eşsiz taş okeyle eşleşir). */
function bestPairs(hand, okey) {
    const byKey = new Map();
    const wilds = [];
    for (const t of hand) {
        if (R.isWild(okey, t)) wilds.push(t);
        else {
            const key = R.slotKey(R.slotOf(okey, t));
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(t);
        }
    }
    const groups = [];
    const singles = [];
    for (const list of byKey.values()) {
        while (list.length >= 2) groups.push(R.analyzePair([list.pop(), list.pop()], okey));
        if (list.length) singles.push(list[0]);
    }
    while (wilds.length && singles.length) {
        groups.push(R.analyzePair([singles.pop(), wilds.pop()], okey));
    }
    while (wilds.length >= 2) groups.push(R.analyzePair([wilds.pop(), wilds.pop()], okey));
    return {
        groups,
        leftover: [...singles, ...wilds],
        points: groups.reduce((a, g) => a + g.points, 0),
    };
}

module.exports = { bestSeries, bestPairs };