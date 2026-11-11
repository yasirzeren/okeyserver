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
    this.indicatorShownBy = null;
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
    this.seriesOpenBy = [0, 0, 0, 0];
    this.pairOpenBy = [0, 0, 0, 0];
    this.lastDrawn = null; // {seat, id}
    this.lastResult = null;
    this.roundStartScores = this.players.map((p) => p.score);
    this.penaltyThisTurn = false;
    this.abandonedOpen = false;
    this.returnedSide = false;
    this.sideTaken = null;
    this.sideTakenUsed = false;
    this.turnAdjustMs = 0; // açma bonusu (+20 sn)
    this.meldSeq = 0;
    // Bu turun geri alınabilir işlemleri ve henüz kesinleşmemiş açılış.
    this.undo = [];
    this.pendingOpen = false;
    this.pendPairs = false;
    this.bonusGiven = false;
    this.prev = { maxSeries: 0, maxPair: 0, seriesBy: 0, pairBy: 0 };
  }

  say(text) {
    this.outbox.push(text);
  }

  totalRounds() {
    return this.settings.totalRounds || 8;
  }

  matchOver() {
    return this.phase === 'finished' &&
      !this.lastResult?.voided &&
      this.round >= this.totalRounds();
  }

  /**
   * Katlamada bu oyuncunun aşması gereken en yüksek açılış.
   * Eşli oyunda "eşe katlama" kapalıysa eşin açılışı sayılmaz.
   */
  foldBase(pairs, p) {
    if (this.settings.partners && this.settings.partnerFolding === false) {
      const list = pairs ? this.pairOpenBy : this.seriesOpenBy;
      let m = 0;
      for (let i = 0; i < 4; i++) {
        if (i === p || i === (p + 2) % 4) continue;
        m = Math.max(m, list[i]);
      }
      return m;
    }
    return pairs ? this.maxPairOpen : this.maxSeriesOpen;
  }

  requiredSeriesFor(p) {
    return folding.required({
      type: 'series',
      folding: this.settings.folding,
      basePairs: this.settings.pairThreshold,
      maxSeriesOpen: this.foldBase(false, p),
      maxPairOpen: this.foldBase(true, p),
    });
  }

  requiredPairsFor(p) {
    return folding.required({
      type: 'pairs',
      folding: this.settings.folding,
      basePairs: this.settings.pairThreshold,
      maxSeriesOpen: this.foldBase(false, p),
      maxPairOpen: this.foldBase(true, p),
    });
  }

  requiredSeries() {
    return this.requiredSeriesFor(this.current);
  }

  requiredPairs() {
    return this.requiredPairsFor(this.current);
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
    const tileSlot = R.slotOf(this.okey, id);
    return this.melds.some((m) => {
      if (m.kind !== 'pair' && R.canExtend(m, id, this.okey) !== null) return true;
      if (tileSlot === null) return false;
      return m.tiles.some((tile, i) => {
        const meldSlot = m.slots[i];
        return R.isWild(this.okey, tile) &&
          tileSlot.color === meldSlot.color &&
          tileSlot.number === meldSlot.number;
      });
    });
  }

  /** Yandan aldığı taşı kullanmayan oyuncu geri bırakıp desteden çekebilir. */
  canReturnSide(p) {
    return (
      this.phase === 'playing' &&
      p === this.current &&
      this.step === 'play' &&
      this.sideTaken !== null &&
      !this.sideTakenUsed
    );
  }

  /** Bu turda yaptığı açılış henüz kesinleşmediyse "Eli topla" görünür. */
  hasPendingOpen(p) {
    return this.phase === 'playing' && p === this.current && this.pendingOpen;
  }

  /** Bu tur işlediği/aldığı taşlar varsa "Taşları topla" kullanılabilir. */
  canGatherTiles(p) {
    return (
      this.phase === 'playing' &&
      p === this.current &&
      this.step === 'play' &&
      this.undo.some((u) => u.kind !== 'open')
    );
  }

  resetTurnState() {
    this.penaltyThisTurn = false;
    this.abandonedOpen = false;
    this.returnedSide = false;
    this.sideTaken = null;
    this.sideTakenUsed = false;
    this.turnAdjustMs = 0;
    this.undo = [];
    this.pendingOpen = false;
    this.bonusGiven = false;
  }

  // ------------------------------------------------------------- el başlangıcı
  startRound() {
    if (this.lastResult?.voided) this.round--;
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
    this.seriesOpenBy = [0, 0, 0, 0];
    this.pairOpenBy = [0, 0, 0, 0];
    this.indicator = null;
    this.indicatorShownBy = null;
    this.okey = null;
    this.lastResult = null;
    this.lastDrawn = null;
    this.resetTurnState();
    this.roundStartScores = this.players.map((p) => p.score);

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

  /** Oyuncunun elindeki gösterge taşını açılış aşamasında göstermesi. */
  showIndicator(p, tile) {
    if (!Number.isInteger(p) || p < 0 || p >= this.players.length) {
      return fail('Geçersiz oyuncu.');
    }
    if (this.phase !== 'indicator' || this.pendingIndicator === null) {
      return fail('Gösterge aşaması sona erdi.');
    }
    if (this.indicatorShownBy !== null) {
      return fail('Gösterge zaten gösterildi.');
    }
    if (
      !this.players[p].hand.includes(tile) ||
      R.isFake(tile) ||
      R.colorOf(tile) !== R.colorOf(this.pendingIndicator) ||
      R.numberOf(tile) !== R.numberOf(this.pendingIndicator)
    ) {
      return fail('Elinde gösterge taşı yok.');
    }
    this.indicatorShownBy = p;
    this.say(`${this.players[p].name} göstergeyi gösterdi.`);
    return ok('Gösterge gösterildi.');
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
    this.sideTaken = id;
    this.sideTakenUsed = false;
    this.say(`${this.players[p].name} yandan taş aldı.`);
    return ok('Yandan taş alındı.');
  }

  /** Kullanmadığın yandan alınan taşı geri bırakıp desteden çekersin. */
  returnSide(p) {
    const g = this.guard(p, 'play');
    if (g) return g;
    const pl = this.players[p];
    const id = this.sideTaken;
    if (id === null || this.sideTakenUsed || !pl.hand.includes(id)) {
      return fail('Geri bırakılacak taş yok.');
    }
    pl.hand.splice(pl.hand.indexOf(id), 1);
    this.discards[(p + 3) % 4].push(id);
    this.sideTaken = null;
    this.sideTakenUsed = false;
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

  /**
   * Seri/çift açma. Hatalıysa reddeder, taşlar elde kalır, ceza yazılır.
   * İlk açılış taş atılana kadar "bekleyen" sayılır, Eli Topla ile geri alınabilir.
   */
  openGroups(p, groups) {
    const g = this.guard(p, 'play');
    if (g) return g;
    const pl = this.players[p];
    if (
      this.sideTaken !== null &&
      !pl.opened &&
      !groups.some((group) => group.includes(this.sideTaken))
    ) {
      return fail('Yandan aldığın taşı kullanmayacaksan geri bırakıp desteden çekmelisin.');
    }
    const e = this.evaluateOpen(p, groups);
    if (!e.ok) return fail(e.message);
    const first = !pl.opened;
    const used = [];
    for (const grp of groups) {
      for (const id of grp) {
        pl.hand.splice(pl.hand.indexOf(id), 1);
        used.push(id);
      }
    }
    if (this.sideTaken !== null && used.includes(this.sideTaken)) {
      this.sideTakenUsed = true;
    }
    const ids = [];
    for (const r of e.groups) {
      const id = this.meldSeq++;
      ids.push(id);
      this.melds.push({
        id,
        owner: p,
        kind: r.kind,
        tiles: [...r.tiles],
        slots: r.slots.map((s) => ({ color: s.color, number: s.number })),
        addedBy: r.tiles.map(() => -1),
      });
    }
    if (first) {
      this.abandonedOpen = false;
      this.prev = {
        maxSeries: this.maxSeriesOpen,
        maxPair: this.maxPairOpen,
        seriesBy: this.seriesOpenBy[p],
        pairBy: this.pairOpenBy[p],
      };
      pl.opened = true;
      this.pendingOpen = true;
      this.pendPairs = e.pairs;
      if (e.pairs) {
        pl.openType = 'pairs';
        pl.pairCount = e.groups.length;
        this.maxPairOpen = Math.max(this.maxPairOpen, pl.pairCount);
        this.pairOpenBy[p] = pl.pairCount;
        this.say(`${pl.name} ${pl.pairCount} çift açtı.`);
      } else {
        pl.openType = 'series';
        pl.openPoints = e.points;
        this.maxSeriesOpen = Math.max(this.maxSeriesOpen, e.points);
        this.seriesOpenBy[p] = e.points;
        this.say(`${pl.name} ${e.points} açtı.`);
      }
      this.undo.push({ kind: 'open', tiles: used, meldIds: ids });
      if (!this.bonusGiven) {
        this.bonusGiven = true;
        this.turnAdjustMs += OPEN_BONUS_MS;
      }
    } else {
      if (e.pairs) pl.pairCount += e.groups.length;
      this.undo.push({
        kind: 'extra',
        tiles: used,
        meldIds: ids,
        pairs: e.pairs ? e.groups.length : 0,
      });
      this.say(`${pl.name} yeni grup açtı.`);
    }
    if (e.pairs && this.players.every((player) => player.openType === 'pairs')) {
      this.finish(null, false, false, true);
      return ok('Herkes çift açtı. El iptal edildi.');
    }
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
      const r = pairs
        ? R.analyzePair(
            g,
            this.okey,
            this.indicatorShownBy === p ? this.indicator : null
          )
        : R.analyzeGroup(g, this.okey);
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
      const req = this.requiredSeriesFor(p);
      if (total < req) return fail(`Seri toplamı ${total}, açmak için en az ${req} gerekli.`);
    } else {
      const req = this.requiredPairsFor(p);
      if (resolved.length < req) {
        return fail(`${resolved.length} çift var, açmak için en az ${req} çift gerekli.`);
      }
    }
    if (seen.size === handSet.size) {
      return fail('Bitiş için bir taşı elinde bırakıp yan tarafa atmalısın.');
    }
    return { ok: true, message: '', groups: resolved, pairs, points: total };
  }

  /** Yanlış açılış / açmaktan vazgeçme: puan cezası (varsayılan 101). Turda bir kez. */
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

  // --------------------------------------------------------- açılışı kesinleştir
  /**
   * Taş atılınca bekleyen açılış kesinleşir.
   * Yandan alınan taşla seri açılırsa 10, çift açılırsa 20 kat ceza yazılır.
   */
  commit(p) {
    let msg = '';
    const side = this.sideTaken;
    if (this.settings.sidePenalty && side !== null) {
      const from = (p + 3) % 4;
      const v = R.isWild(this.okey, side)
        ? R.OKEY_HAND_VALUE
        : R.slotValue(R.slotOf(this.okey, side));
      const pen = v * (this.pendPairs ? 20 : 10);
      this.players[from].score += pen;
      this.penalties.push({
        round: this.round,
        player: from,
        type: this.pendPairs
          ? 'Yandan alınan taşla çift açıldı'
          : 'Yandan alınan taşla seri açıldı',
        points: pen,
      });
      this.say(
        `${this.players[from].name} attığı taşla ${this.players[p].name} ${this.pendPairs ? 'çift' : 'seri'} açtı: +${pen} ceza puanı.`
      );
      msg = ` ${this.players[from].name} +${pen} ceza aldı.`;
    }
    this.pendingOpen = false;
    this.sideTaken = null;
    this.sideTakenUsed = false;
    this.undo = [];
    return msg;
  }

  commitIfPending(p) {
    if (this.pendingOpen) this.commit(p);
  }

  // ------------------------------------------------------------ geri alma
  undoLast(p) {
    const u = this.undo.pop();
    const pl = this.players[p];
    if (u.kind === 'open' || u.kind === 'extra') {
      this.melds = this.melds.filter((m) => !u.meldIds.includes(m.id));
      pl.hand.push(...u.tiles);
      if (u.tiles.includes(this.sideTaken)) this.sideTakenUsed = false;
      if (u.kind === 'extra') {
        pl.pairCount -= u.pairs;
      } else {
        pl.opened = false;
        pl.openType = null;
        pl.openPoints = 0;
        pl.pairCount = 0;
        this.maxSeriesOpen = this.prev.maxSeries;
        this.maxPairOpen = this.prev.maxPair;
        this.seriesOpenBy[p] = this.prev.seriesBy;
        this.pairOpenBy[p] = this.prev.pairBy;
        this.pendingOpen = false;
      }
    } else if (u.kind === 'proc') {
      const m = this.melds.find((x) => x.id === u.meldId);
      if (m) {
        if (u.atEnd) {
          m.tiles.pop();
          m.slots.pop();
          m.addedBy.pop();
        } else {
          m.tiles.shift();
          m.slots.shift();
          m.addedBy.shift();
        }
        if (u.jokerIndex !== undefined) m.slots[u.jokerIndex] = u.previousJokerSlot;
      }
      pl.hand.push(u.tile);
      pl.processedCount--;
      if (u.tile === this.sideTaken) this.sideTakenUsed = false;
    } else if (u.kind === 'pair') {
      this.melds = this.melds.filter((m) => m.id !== u.meldId);
      pl.hand.push(...u.tiles);
      pl.processedCount -= 2;
      if (u.tiles.includes(this.sideTaken)) this.sideTakenUsed = false;
    } else if (u.kind === 'swap') {
      const m = this.melds.find((x) => x.id === u.meldId);
      if (m) m.tiles[u.index] = u.okeyTile;
      pl.hand.splice(pl.hand.indexOf(u.okeyTile), 1);
      pl.hand.push(u.given);
      if (u.given === this.sideTaken) this.sideTakenUsed = false;
    }
  }

  /** Eli Topla: bu turdaki her şeyi (açılış dahil) geri alır, vazgeçme cezası yazar. */
  gatherOpen(p) {
    const g = this.guard(p, 'play');
    if (g) return g;
    if (!this.pendingOpen) return fail('Geri alınacak açılış yok.');
    while (this.undo.length) this.undoLast(p);
    this.abandonedOpen = true;
    this.say(`${this.players[p].name} elini topladı.`);
    return ok('Eli topladın. Düzenleyip yeniden açabilir ya da vazgeçebilirsin.');
  }

  /** Taşları Topla: bu tur işlenen/alınan taşları geri alır, açılışa dokunmaz. */
  gatherTiles(p) {
    const g = this.guard(p, 'play');
    if (g) return g;
    let n = 0;
    while (this.undo.length && this.undo[this.undo.length - 1].kind !== 'open') {
      this.undoLast(p);
      n++;
    }
    if (n === 0) return fail('Geri alınacak taş yok.');
    this.say(`${this.players[p].name} işlediği taşları geri aldı.`);
    return ok('Taşlar geri toplandı.');
  }

  // ---------------------------------------------------------------- işleme
  applyProcess(p, id, meld, ext) {
    const jokerIndex = ext.jokerIndex;
    const previousJokerSlot = jokerIndex === undefined ? undefined : meld.slots[jokerIndex];
    R.extend(meld, id, p, ext);
    const pl = this.players[p];
    pl.hand.splice(pl.hand.indexOf(id), 1);
    pl.processedCount++;
    if (id === this.sideTaken) this.sideTakenUsed = true;
    this.undo.push({ kind: 'proc', tile: id, meldId: meld.id, atEnd: ext.atEnd,
      jokerIndex, previousJokerSlot });
    this.say(`${pl.name} taş işledi.`);
  }

  processTile(p, id, meldId) {
    const g = this.guard(p, 'play');
    if (g) return g;
    const pl = this.players[p];
    if (!pl.opened) return fail('Taş işlemek için önce açmalısın.');
    if (!pl.hand.includes(id)) return fail('Bu taş elinde değil.');
    const meld = this.melds.find((m) => m.id === meldId);
    if (!meld) return fail('Hedef grup bulunamadı.');
    const ext = R.canExtend(meld, id, this.okey);
    if (!ext) return fail('Bu taş bu gruba işlenemez.');
    if (pl.hand.length === 1) {
      return fail('Bitiş için son taşı elinde bırakıp yan tarafa atmalısın.');
    }
    this.applyProcess(p, id, meld, ext);
    return ok('Taş işlendi.');
  }

  /** Taşları İşle: işlenebilen her taşı en uygun yere kendisi işler (okeyi tutar). */
  autoProcess(p) {
    const g = this.guard(p, 'play');
    if (g) return g;
    const pl = this.players[p];
    if (!pl.opened) return fail('Taş işlemek için önce açmalısın.');
    let n = 0;
    let again = true;
    while (again && pl.hand.length > 1) {
      again = false;
      for (const t of [...pl.hand]) {
        if (R.isWild(this.okey, t)) continue;
        let target = null;
        let ext = null;
        for (const m of this.melds) {
          if (m.kind === 'pair') continue;
          const x = R.canExtend(m, t, this.okey);
          if (x) {
            target = m;
            ext = x;
            break;
          }
        }
        if (!target) continue;
        this.applyProcess(p, t, target, ext);
        n++;
        again = true;
        break;
      }
    }
    if (n === 0) return fail('İşlenecek uygun taş yok.');
    return ok(`${n} taş işlendi.`);
  }

  /** Seri açan oyuncu elindeki bir çifti, çift açmış rakibin bölmesine işler. */
  processPair(p, a, b, target) {
    const g = this.guard(p, 'play');
    if (g) return g;
    const pl = this.players[p];
    if (!pl.opened) return fail('Çift işlemek için önce açmalısın.');
    if (pl.openType !== 'series') return fail('Yalnızca seri açan oyuncu çift işleyebilir.');
    if (!Number.isInteger(target) || target < 0 || target > 3 || target === p) {
      return fail('Geçersiz hedef.');
    }
    const tp = this.players[target];
    if (!tp.opened || tp.openType !== 'pairs') return fail('Hedef oyuncu çift açmamış.');
    if (a === b || !pl.hand.includes(a) || !pl.hand.includes(b)) {
      return fail('Bu taşlar elinde değil.');
    }
    const r = R.analyzePair(
      [a, b],
      this.okey,
      this.indicatorShownBy === p ? this.indicator : null
    );
    if (!r) return fail('Seçilen taşlar çift oluşturmuyor.');
    if (pl.hand.length <= 2) {
      return fail('Bitiş için bir taşı elinde bırakıp yan tarafa atmalısın.');
    }
    const id = this.meldSeq++;
    this.melds.push({
      id,
      owner: target,
      kind: 'pair',
      tiles: [...r.tiles],
      slots: r.slots.map((s) => ({ color: s.color, number: s.number })),
      addedBy: [p, p],
    });
    pl.hand.splice(pl.hand.indexOf(a), 1);
    pl.hand.splice(pl.hand.indexOf(b), 1);
    pl.processedCount += 2;
    if (a === this.sideTaken || b === this.sideTaken) this.sideTakenUsed = true;
    this.undo.push({ kind: 'pair', tiles: [a, b], meldId: id });
    this.say(`${pl.name}, ${tp.name} oyuncusunun çiftlerine çift işledi.`);
    return ok('Çift işlendi.');
  }

  /** Okey alma: masadaki okeyin yerini tutan gerçek taşı verip okeyi eline alır. */
  swapOkey(p, id, meldId, index) {
    const g = this.guard(p, 'play');
    if (g) return g;
    const pl = this.players[p];
    if (!pl.opened) return fail('Okey almak için önce açmalısın.');
    if (!pl.hand.includes(id)) return fail('Bu taş elinde değil.');
    const m = this.melds.find((x) => x.id === meldId);
    if (!m) return fail('Hedef grup bulunamadı.');
    if (!Number.isInteger(index) || index < 0 || index >= m.tiles.length) {
      return fail('Geçersiz yer.');
    }
    const cur = m.tiles[index];
    if (!R.isWild(this.okey, cur)) return fail('Burada okey yok.');
    if (m.kind === 'set' && m.tiles.length < 4) {
      return fail('Okeyi almadan önce grubu dört taşla tamamlamalısın.');
    }
    if (R.isWild(this.okey, id)) return fail('Okeyin yerine okey konamaz.');
    const s = R.slotOf(this.okey, id);
    const ms = m.slots[index];
    if (s.color !== ms.color || s.number !== ms.number) {
      return fail('Bu taş okeyin yerine uymuyor.');
    }
    m.tiles[index] = id;
    pl.hand.splice(pl.hand.indexOf(id), 1);
    pl.hand.push(cur);
    if (id === this.sideTaken) this.sideTakenUsed = true;
    this.undo.push({ kind: 'swap', given: id, okeyTile: cur, meldId, index });
    this.say(`${pl.name} masadaki okeyi aldı.`);
    return ok('Okey alındı.');
  }

  discard(p, id) {
    const g = this.guard(p, 'play');
    if (g) return g;
    const pl = this.players[p];
    if (!pl.hand.includes(id)) return fail('Bu taş elinde değil.');
    const kafaFinish = this.lastDrawn?.seat === p && this.lastDrawn.id === id;
    let extra = '';

    // Bekleyen açılış taş atınca kesinleşir.
    if (this.pendingOpen) extra += this.commit(p);

    // Yandan alınıp kullanılmayan taş önce geri bırakılmalı.
    if (this.sideTaken !== null && !this.sideTakenUsed) {
      return fail('Yandan aldığın taşı kullanmadıysan geri bırakıp desteden çekmelisin.');
    }

    if (this.abandonedOpen) {
      const penalty = this.applyWrongOpenPenalty(p);
      if (penalty) extra += ` ${penalty}`;
      this.abandonedOpen = false;
    }
    if (this.sideTaken !== null) {
      this.sideTaken = null;
      this.sideTakenUsed = false;
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
      this.finish(p, R.isWild(this.okey, id), kafaFinish);
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

  finish(winner, okeyFinish = false, kafaFinish = false, voided = false) {
    if (voided) {
      this.players.forEach((p, i) => {
        p.score = this.roundStartScores[i];
      });
      this.penalties = [];
    }
    const pairFinish = winner !== null && this.players[winner].openType === 'pairs';
    const result = scoring.compute({
      players: this.players,
      winner,
      okeyFinish,
      pairFinish,
      okey: this.okey,
      partners: this.settings.partners,
      kafaFinish,
      voided,
    });
    this.lastResult = result;
    this.players.forEach((p, i) => {
      p.score = result.totals[i];
    });
    this.phase = 'finished';
    this.say(
      winner === null
        ? (voided ? 'Herkes çift açtı. El iptal edildi.' : `El bitti: ${result.finishType}.`)
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
      indicatorShownBy: this.indicatorShownBy,
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
      requiredSeries: this.requiredSeriesFor(seat),
      requiredPairs: this.requiredPairsFor(seat),
      canReturnSide: this.canReturnSide(seat),
      canGatherOpen: this.hasPendingOpen(seat),
      canGatherTiles: this.canGatherTiles(seat),
      penalties: this.penalties.map((e) => ({ ...e })),
      result: this.lastResult,
      myHand: [...this.players[seat].hand],
      lastDrawn: this.lastDrawn && this.lastDrawn.seat === seat ? this.lastDrawn.id : null,
    };
  }
}

module.exports = { Game, shuffle };