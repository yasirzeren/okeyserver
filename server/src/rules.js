'use strict';

// Dart tarafındaki lib/engine/rules.dart ile birebir aynı kurallar.
// Taş kimliği: 0..103 gerçek, 104-105 sahte okey. renk = id / 26, sayı = id % 13 + 1.
// Seriler 1'den 13'e kadardır, 12-13-1 gibi dönen seri YOKTUR.

const COLOR_NAMES = ['Kırmızı', 'Mavi', 'Siyah', 'Sarı'];
const OKEY_HAND_VALUE = 101;

const isFake = (id) => id >= 104;
const colorOf = (id) => (isFake(id) ? -1 : Math.floor(id / 26));
const numberOf = (id) => (isFake(id) ? 0 : (id % 13) + 1);
const tileName = (id) =>
    isFake(id) ? 'Sahte okey' : `${COLOR_NAMES[colorOf(id)]} ${numberOf(id)}`;

const slot = (color, number) => ({ color, number });
const slotKey = (s) => s.color * 20 + s.number;
const slotValue = (s) => s.number;

/** Gösterge taşının bir sonraki sayısı (13 -> 1) aynı renkte okeydir. */
function okeyFromIndicator(indicatorId) {
    const n = numberOf(indicatorId);
    return { color: colorOf(indicatorId), number: n === 13 ? 1 : n + 1 };
}

const isWild = (okey, id) =>
    !isFake(id) && colorOf(id) === okey.color && numberOf(id) === okey.number;

/** Joker için null. Sahte okey, okeyin değerini taşır. */
function slotOf(okey, id) {
    if (isWild(okey, id)) return null;
    if (isFake(id)) return slot(okey.color, okey.number);
    return slot(colorOf(id), numberOf(id));
}

function pointsOf(kind, slots) {
    if (kind === 'run') return slots.reduce((a, s) => a + slotValue(s), 0);
    if (kind === 'set') return slots[0].number * slots.length;
    return slotValue(slots[0]) * 2; // pair
}

function resolved(kind, tiles, slots) {
    return { kind, tiles, slots, points: pointsOf(kind, slots) };
}

function tryRun(fixed, slots, wilds) {
    const n = fixed.length + wilds.length;
    if (n > 13) return null;
    const c = slots[0].color;
    if (slots.some((s) => s.color !== c)) return null;
    const nums = slots.map((s) => s.number);
    if (new Set(nums).size !== nums.length) return null;

    let best = null;
    for (let s = 1; s + n - 1 <= 13; s++) {
        const posToTile = new Map();
        let ok = true;
        for (let i = 0; i < fixed.length; i++) {
            const number = nums[i];
            if (number < s || number > s + n - 1) {
                ok = false;
                break;
            }
            posToTile.set(number, fixed[i]);
        }
        if (!ok) continue;
        const tiles = [];
        const outSlots = [];
        let wi = 0;
        for (let p = s; p <= s + n - 1; p++) {
            tiles.push(posToTile.has(p) ? posToTile.get(p) : wilds[wi++]);
            outSlots.push(slot(c, p));
        }
        const r = resolved('run', tiles, outSlots);
        if (best === null || r.points > best.points) best = r;
    }
    return best;
}

function trySet(fixed, slots, wilds) {
    const n = fixed.length + wilds.length;
    if (n < 3 || n > 4) return null;
    const number = slots[0].number;
    if (slots.some((s) => s.number !== number)) return null;
    const colors = new Set(slots.map((s) => s.color));
    if (colors.size !== slots.length) return null;
    const outTiles = [...fixed];
    const outSlots = [...slots];
    let wi = 0;
    for (let c = 0; c < 4 && wi < wilds.length; c++) {
        if (!colors.has(c)) {
            outTiles.push(wilds[wi++]);
            outSlots.push(slot(c, number));
        }
    }
    if (wi !== wilds.length) return null;
    return resolved('set', outTiles, outSlots);
}

/** En az 3 taşlık seri (aynı renk ardışık) veya grup (aynı sayı, farklı renk). */
function analyzeGroup(tiles, okey) {
    if (tiles.length < 3) return null;
    const fixed = [];
    const wilds = [];
    for (const t of tiles) (isWild(okey, t) ? wilds : fixed).push(t);
    if (fixed.length === 0) return null;
    const slots = fixed.map((t) => slotOf(okey, t));
    const run = tryRun(fixed, slots, wilds);
    const set = trySet(fixed, slots, wilds);
    if (!run) return set;
    if (!set) return run;
    return run.points >= set.points ? run : set;
}

/** Çift: birbirinin aynısı iki taş. Okey bir taşın yerine geçebilir. */
function analyzePair(tiles, okey) {
    if (tiles.length !== 2) return null;
    const s0 = slotOf(okey, tiles[0]);
    const s1 = slotOf(okey, tiles[1]);
    let sl;
    if (s0 === null && s1 === null) sl = slot(okey.color, okey.number);
    else if (s0 === null) sl = s1;
    else if (s1 === null) sl = s0;
    else if (s0.color === s1.color && s0.number === s1.number) sl = s0;
    else return null;
    return resolved('pair', [...tiles], [sl, sl]);
}

/** Taşın bir seriye/gruba işlenip işlenemeyeceği. {atEnd, slot} veya null. */
function canExtend(meld, id, okey) {
    if (meld.kind === 'pair') return null;
    const wild = isWild(okey, id);
    if (meld.kind === 'run') {
        if (meld.tiles.length >= 13) return null;
        const c = meld.slots[0].color;
        const first = meld.slots[0].number;
        const last = meld.slots[meld.slots.length - 1].number;
        if (wild) {
            if (last < 13) return { atEnd: true, slot: slot(c, last + 1) };
            if (first > 1) return { atEnd: false, slot: slot(c, first - 1) };
            return null;
        }
        const s = slotOf(okey, id);
        if (s.color !== c) return null;
        if (last < 13 && s.number === last + 1) return { atEnd: true, slot: slot(c, last + 1) };
        if (first > 1 && s.number === first - 1) return { atEnd: false, slot: slot(c, first - 1) };
        return null;
    }
    // grup (set)
    if (meld.tiles.length >= 4) return null;
    const used = new Set(meld.slots.map((s) => s.color));
    const number = meld.slots[0].number;
    if (wild) {
        for (let c = 0; c < 4; c++) if (!used.has(c)) return { atEnd: true, slot: slot(c, number) };
        return null;
    }
    const s = slotOf(okey, id);
    if (s.number === number && !used.has(s.color)) return { atEnd: true, slot: s };
    return null;
}

function extend(meld, id, by, ext) {
    if (ext.atEnd) {
        meld.tiles.push(id);
        meld.slots.push(ext.slot);
        meld.addedBy.push(by);
    } else {
        meld.tiles.unshift(id);
        meld.slots.unshift(ext.slot);
        meld.addedBy.unshift(by);
    }
}

/** Elde kalan taşların ceza puanı (okey = 101). */
function handPenalty(hand, okey) {
    return hand.reduce(
        (a, t) => a + (isWild(okey, t) ? OKEY_HAND_VALUE : slotValue(slotOf(okey, t))),
        0
    );
}

module.exports = {
    COLOR_NAMES,
    isFake,
    colorOf,
    numberOf,
    tileName,
    slot,
    slotKey,
    slotValue,
    okeyFromIndicator,
    isWild,
    slotOf,
    pointsOf,
    analyzeGroup,
    analyzePair,
    canExtend,
    extend,
    handPenalty,
};