'use strict';
const crypto = require('crypto');
const R = require('./rules');
const folding = require('./folding');
const scoring = require('./scoring');

const ok = (message = '') => ({ ok: true, message });
const fail = (message) => ({ ok: false, message });

const OPEN_BONUS_MS = 20000; // ilk açılışta eklenen süre

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Sunucu tarafı oyun motoru. Tüm kurallar burada doğrulanır, istemciye güvenilmez.
 * Koltuk numarası 0..3, sıra 0 -> 1 -> 2 -> 3 yönünde ilerler.
 */
class Game {
    /** seats: [{name, isBot}] x4. opts.shuffle testlerde sabit dağıtım için. */
    constructor(settings, seats, opts = {}) {
        this.settings = settings;
        this.shuffleFn = opts.shuffle || shuffle;
        this.players = seats.map((s, i) => ({
            seat: i,
            name: s.name,
            isBot: !!s.isBot,
            hand: [],
            opened: false,
            openType: null, // 'series' | 'pairs'
            openPoints: 0,
            pairCount: 0,
            processedCount: 0,
            score: 0,
        }));
        this.deck = [];
        this.indicator = null;
        this.pendingIndicator = null;
        this.okey = null;
        this.discards = [[], [], [], []];
        this.melds = [];
        this.penalties = [];
        this.outbox = []; // sistem mesajları, oda tarafından sohbete aktarılır
        this.current = 0;
        this.step = 'draw'; // 'draw' | 'play'
        this.phase = 'indicator'; // 'indicator' | 'playing' | 'finished'
        this.round = 0;
        this.starter = 0;
        this.turnNo = 0;
        this.maxSeriesOpen = 0;
        this.maxPairOpen = 0;
        this.lastDrawn = null; // {seat, id}
        this.lastResult = null;
        this.penaltyThisTurn = false;
        this.returnedSide = false;
        this.sideTaken = null;
        this.turnAdjustMs = 0; // açma bonusu (+20 sn)
        this.meldSeq = 0;
    }

    say(text) {
        this.outbox.push(text);
    }

    totalRounds() {
        return this.settings.totalRounds || 8;
    }

    matchOver() {
        return this.phase === 'finished' && this.round >= this.totalRounds();
    }

    requiredSeries() {
        return folding.required({
            type: 'series',
            folding: this.settings.folding,
            basePairs: this.settings.pairThreshold,
            maxSeriesOpen: this.maxSeriesOpen,
            maxPairOpen: this.maxPairOpen,
        });
    }

    requiredPairs() {
        return folding.required({
            type: 'pairs',
            folding: this.settings.folding,
            basePairs: this.settings.pairThreshold,
            maxSeriesOpen: this.maxSeriesOpen,
            maxPairOpen: this.maxPairOpen,
        });
    }

    guard(p, need) {
        if (this.phase !== 'playing') return fail('Oyun şu anda aktif değil.');
        if (p !== this.current) return fail('Sıra sende değil.');
        if (need && this.step !== need) {
            return fail(need === 'draw' ? 'Bu turda zaten taş çektin.' : 'Önce taş çekmelisin.');
        }
        return null;
    }

    isWorkable(id) {
        return this.melds.some((m) => m.kind !== 'pair' && R.canExtend(m, id, this.okey) !== null);
    }

    /** Yandan aldığı taşla henüz açmamış oyuncu taşı geri bırakabilir. */
    canReturnSide(p) {
        return (
            this.phase === 'playing' &&
            p === this.current &&
            this.step === 'play' &&
            this.sideTaken !== null &&
            !this.players[p].opened
        );
    }

    resetTurnState() {
        this.penaltyThisTurn = false;
        this.returnedSide = false;
        this.sideTaken = null;
        this.turnAdjustMs = 0;
    }

    // ------------------------------------------------------------- el başlangıcı
    startRound() {
        this.round++;
        this.starter = (this.round - 1) % 4;
        for (const p of this.players) {
            p.hand = [];
            p.opened = false;
            p.openType = null;
            p.openPoints = 0;
            p.pairCount = 0;
            p.processedCount = 0;
        }
        this.discards = [[], [], [], []];
        this.melds = [];
        this.penalties = [];
        this.maxSeriesOpen = 0;
        this.maxPairOpen = 0;
        this.indicator = null;
        this.okey = null;
        this.lastResult = null;
        this.lastDrawn = null;
        this.resetTurnState();

        this.deck = this.shuffleFn(Array.from({ length: 106 }, (_, i) => i));
        for (let p = 0; p < 4; p++) {
            const count = p === this.starter ? 22 : 21;
            this.players[p].hand = this.deck.splice(0, count);
        }
        const idx = this.deck.findIndex((id) => !R.isFake(id));
        this.pendingIndicator = this.deck.splice(idx, 1)[0];
        this.phase = 'indicator';
        this.say(
            `El ${this.round}/${this.totalRounds()} başladı. ${this.players[this.starter].name} başlıyor.`
        );
        if (!this.settings.indicatorRule) this.confirmIndicator();
    }

    /** Gösterge aşaması bittiğinde (taş bırakıldı veya süre doldu). */
    confirmIndicator() {
        if (this.phase !== 'indicator' || this.pendingIndicator === null) return;
        this.indicator = this.pendingIndicator;
        this.pendingIndicator = null;
        this.okey = R.okeyFromIndicator(this.indicator);
        this.phase = 'playing';
        this.current = this.starter;
        this.step = 'play'; // başlayan oyuncu 22 taşla çekmeden atar
        this.turnNo++;
        this.resetTurnState();
        this.say(
            `Gösterge: ${R.tileName(this.indicator)}. Okey: ${R.COLOR_NAMES[this.okey.color]} ${this.okey.number}.`
        );
        this.say(`Sıra ${this.players[this.current].name} oyuncusunda.`);
    }

    // ---------------------------------------------------------------- hamleler
    draw(p) {
        const g = this.guard(p, 'draw');
        if (g) return g;
        if (this.deck.length === 0) {
            this.finish(null);
            return ok('Deste bitti, el sona erdi.');
        }
        const id = this.deck.pop();
        this.players[p].hand.push(id);
        this.step = 'play';
        this.lastDrawn = { seat: p, id };
        this.say(`${this.players[p].name} taş çekti.`);
        return ok('Taş çekildi.');
    }

    takeSide(p) {
        const g = this.guard(p, 'draw');
        if (g) return g;
        if (this.returnedSide) return fail('Taşı geri bıraktın, bu tur desteden çekmelisin.');
        const from = (p + 3) % 4;
        if (this.discards[from].length === 0) return fail('Yandan alınacak taş yok.');
        const id = this.discards[from].pop();
        this.players[p].hand.push(id);
        this.step = 'play';
        this.lastDrawn = { seat: p, id };
        if (!this.players[p].opened) this.sideTaken = id;
        this.say(`${this.players[p].name} yandan taş aldı.`);
        return ok('Yandan taş alındı.');
    }

    /** Yandan alınan taşı, açamıyorsan geri bırak. Sonra desteden çekersin. */
    returnSide(p) {
        const g = this.guard(p, 'play');
        if (g) return g;
        const pl = this.players[p];
        const id = this.sideTaken;
        if (id === null || pl.opened || !pl.hand.includes(id)) return fail('Geri bırakılacak taş yok.');
        pl.hand.splice(pl.hand.indexOf(id), 1);
        this.discards[(p + 3) % 4].push(id);
        this.sideTaken = null;
        this.returnedSide = true;
        this.step = 'draw';
        this.lastDrawn = null;
        this.say(`${pl.name} yandan aldığı taşı geri bıraktı.`);
        return ok('Taş geri bırakıldı, desteden çekmelisin.');
    }

    previewOpen(p, groups) {
        const g = this.guard(p, 'play');
        if (g) return g;
        const e = this.evaluateOpen(p, groups);
        return e.ok ? ok(`Açılış geçerli (${e.points}).`) : fail(e.message);
    }

    /** Seri/çift açma. Hatalıysa reddeder, taşlar elde kalır, ceza kuralı uygulanır. */
    openGroups(p, groups) {
        const g = this.guard(p, 'play');
        if (g) return g;
        const e = this.evaluateOpen(p, groups);
        if (!e.ok) {
            const extra = this.applyWrongOpenPenalty(p);
            return fail(extra ? `${e.message} ${extra}` : e.message);
        }
        const pl = this.players[p];
        const first = !pl.opened;
        for (const grp of groups) {
            for (const id of grp) pl.hand.splice(pl.hand.indexOf(id), 1);
        }
        for (const r of e.groups) {
            this.melds.push({
                id: this.meldSeq++,
                owner: p,
                kind: r.kind,
                tiles: [...r.tiles],
                slots: r.slots.map((s) => ({ color: s.color, number: s.number })),
                addedBy: r.tiles.map(() => -1),
            });
        }
        if (first) {
            pl.opened = true;
            if (e.pairs) {
                pl.openType = 'pairs';
                pl.pairCount = e.groups.length;
                this.maxPairOpen = Math.max(this.maxPairOpen, pl.pairCount);
                this.say(`${pl.name} ${pl.pairCount} çift açtı.`);
            } else {
                pl.openType = 'series';
                pl.openPoints = e.points;
                this.maxSeriesOpen = Math.max(this.maxSeriesOpen, e.points);
                this.say(`${pl.name} ${e.points} açtı.`);
            }
        } else {
            if (e.pairs) pl.pairCount += e.groups.length;
            this.say(`${pl.name} yeni grup açtı.`);
        }
        this.sideTaken = null; // açtığı için yandan alma sorunu kalmadı
        if (first) this.turnAdjustMs += OPEN_BONUS_MS;
        if (pl.hand.length === 0) this.finish(p);
        return ok('Açma başarılı.');
    }

    evaluateOpen(p, groups) {
        if (groups.length === 0) return fail('Açılacak taş seçilmedi.');
        const pl = this.players[p];
        const handSet = new Set(pl.hand);
        const seen = new Set();
        for (const g of groups) {
            for (const id of g) {
                if (!handSet.has(id)) return fail('Bu taş elinde değil.');
                if (seen.has(id)) return fail('Aynı taş iki işlemde kullanılamaz.');
                seen.add(id);
            }
        }
        const pairs = groups.every((g) => g.length === 2);
        const series = groups.every((g) => g.length >= 3);
        if (!pairs && !series) return fail('Seri ve çift aynı anda açılamaz.');
        const resolved = [];
        for (const g of groups) {
            const r = pairs ? R.analyzePair(g, this.okey) : R.analyzeGroup(g, this.okey);
            if (!r) {
                return fail(`Geçersiz ${pairs ? 'çift' : 'seri'}: ${g.map(R.tileName).join(', ')}.`);
            }
            resolved.push(r);
        }
        const total = resolved.reduce((a, r) => a + r.points, 0);
        if (pl.opened) {
            if (pl.openType === 'series' && !series) return fail('Seri ile açtın, çift açamazsın.');
            if (pl.openType === 'pairs' && !pairs) return fail('Çift ile açtın, seri açamazsın.');
        } else if (series) {
            const req = this.requiredSeries();
            if (total < req) return fail(`Seri toplamı ${total}, açmak için en az ${req} gerekli.`);
        } else {
            const req = this.requiredPairs();
            if (resolved.length < req) {
                return fail(`${resolved.length} çift var, açmak için en az ${req} çift gerekli.`);
            }
        }
        return { ok: true, message: '', groups: resolved, pairs, points: total };
    }

    /** Yanlış açılış: puan cezası yazılır (varsayılan 101). Turda bir kez. */
    applyWrongOpenPenalty(p) {
        if (this.penaltyThisTurn) return null;
        this.penaltyThisTurn = true;
        const pen = this.settings.wrongOpenPenalty;
        if (pen <= 0) return null;
        this.players[p].score += pen;
        this.penalties.push({ round: this.round, player: p, type: 'Hatalı açılış', points: pen });
        this.say(`${this.players[p].name} hatalı açılış yaptı: +${pen} ceza puanı.`);
        return `Ceza: +${pen} puan.`;
    }

    processTile(p, id, meldId) {
        const g = this.guard(p, 'play');
        if (g) return g;
        const pl = this.players[p];
        if (!pl.opened) return fail('Taş işlemek için önce açmalısın.');
        if (pl.openType !== 'series') return fail('Çift açan oyuncu taş işleyemez.');
        if (!pl.hand.includes(id)) return fail('Bu taş elinde değil.');
        const meld = this.melds.find((m) => m.id === meldId);
        if (!meld) return fail('Hedef grup bulunamadı.');
        const ext = R.canExtend(meld, id, this.okey);
        if (!ext) return fail('Bu taş bu gruba işlenemez.');
        R.extend(meld, id, p, ext);
        pl.hand.splice(pl.hand.indexOf(id), 1);
        pl.processedCount++;
        this.say(`${pl.name} taş işledi.`);
        if (pl.hand.length === 0) this.finish(p);
        return ok('Taş işlendi.');
    }

    discard(p, id) {
        const g = this.guard(p, 'play');
        if (g) return g;
        const pl = this.players[p];
        if (!pl.hand.includes(id)) return fail('Bu taş elinde değil.');
        let extra = '';

        // Yandan alıp açamayan oyuncu.
        if (this.sideTaken !== null && !pl.opened) {
            if (this.settings.sidePenalty) {
                const pen = this.settings.sideTakePenalty;
                pl.score += pen;
                this.penalties.push({ round: this.round, player: p, type: 'Yandan alma', points: pen });
                this.say(`${pl.name} yandan aldığı taşla açamadı: +${pen} ceza puanı.`);
                extra += ` Yandan alma cezası: +${pen}.`;
            } else {
                return fail('Yandan aldığın taşla elini açmalısın ya da taşı geri bırakmalısın.');
            }
        }

        // İşlek taş atma cezası (son taşla bitirirken uygulanmaz).
        const wp = this.settings.workablePenalty;
        if (wp > 0 && pl.hand.length > 1 && this.isWorkable(id)) {
            pl.score += wp;
            this.penalties.push({ round: this.round, player: p, type: 'İşlek taş', points: wp });
            this.say(`${pl.name} işlek taş attı: +${wp} ceza puanı.`);
            extra += ` İşlek taş cezası: +${wp}.`;
        }

        this.sideTaken = null;
        pl.hand.splice(pl.hand.indexOf(id), 1);
        this.discards[p].push(id);
        if (pl.hand.length === 0) {
            this.finish(p, R.isWild(this.okey, id));
            return ok('Oyun bitti.');
        }
        this.nextTurn();
        return ok(`Taş atıldı.${extra}`);
    }

    nextTurn() {
        this.current = (this.current + 1) % 4;
        this.step = 'draw';
        this.turnNo++;
        this.resetTurnState();
        this.lastDrawn = null;
    }

    finish(winner, okeyFinish = false) {
        const pairFinish = winner !== null && this.players[winner].openType === 'pairs';
        const result = scoring.compute({
            players: this.players,
            winner,
            okeyFinish,
            pairFinish,
            okey: this.okey,
            partners: this.settings.partners,
        });
        this.lastResult = result;
        this.players.forEach((p, i) => {
            p.score = result.totals[i];
        });
        this.phase = 'finished';
        this.say(
            winner === null
                ? `El bitti: ${result.finishType}.`
                : `${this.players[winner].name} oyunu bitirdi (${result.finishType}).`
        );
        if (this.matchOver()) this.say('Maç bitti.');
    }

    // ------------------------------------------------------------ gizlilik
    /**
     * Bir koltuğa gönderilecek durum. Yalnızca o koltuğun eli (myHand) içerir,
     * rakipler için sadece taş sayısı gider.
     */
    viewFor(seat) {
        return {
            phase: this.phase,
            step: this.step,
            current: this.current,
            round: this.round,
            totalRounds: this.totalRounds(),
            matchOver: this.matchOver(),
            starter: this.starter,
            indicator: this.indicator,
            pendingIndicator: this.phase === 'indicator' ? this.pendingIndicator : null,
            okey: this.okey ? { color: this.okey.color, number: this.okey.number } : null,
            deckCount: this.deck.length,
            discards: this.discards.map((d) => [...d]),
            melds: this.melds.map((m) => ({
                id: m.id,
                owner: m.owner,
                kind: m.kind,
                tiles: [...m.tiles],
                slots: m.slots.map((s) => ({ color: s.color, number: s.number })),
                addedBy: [...m.addedBy],
            })),
            players: this.players.map((p) => ({
                seat: p.seat,
                name: p.name,
                isBot: p.isBot,
                handCount: p.hand.length,
                opened: p.opened,
                openType: p.openType,
                openPoints: p.openPoints,
                pairCount: p.pairCount,
                processedCount: p.processedCount,
                score: p.score,
            })),
            requiredSeries: this.requiredSeries(),
            requiredPairs: this.requiredPairs(),
            canReturnSide: this.canReturnSide(seat),
            penalties: this.penalties.map((e) => ({ ...e })),
            result: this.lastResult,
            myHand: [...this.players[seat].hand],
            lastDrawn: this.lastDrawn && this.lastDrawn.seat === seat ? this.lastDrawn.id : null,
        };
    }
}

module.exports = { Game, shuffle };