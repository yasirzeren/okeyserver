'use strict';
const R = require('./rules');

const UNOPENED_PENALTY = 202;
const WINNER_REWARD = 101;

/** Puanlama TEK merkezî fonksiyondur. */
function compute({ players, winner, okeyFinish, pairFinish, okey, partners }) {
    const mult = (okeyFinish ? 2 : 1) * (pairFinish ? 2 : 1);
    const deltas = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
        const p = players[i];
        const handPts = p.opened ? R.handPenalty(p.hand, okey) : UNOPENED_PENALTY;
        if (winner === null) deltas[i] = handPts;
        else if (i === winner) deltas[i] = -WINNER_REWARD * mult;
        else if (partners && i === (winner + 2) % 4) deltas[i] = 0;
        else deltas[i] = handPts * mult;
    }
    const totals = players.map((p, i) => p.score + deltas[i]);
    const teamTotals = partners ? [totals[0] + totals[2], totals[1] + totals[3]] : [];

    let finishType;
    if (winner === null) finishType = 'Deste bitti (kazanan yok)';
    else if (okeyFinish && pairFinish) finishType = 'Çiftten ve okeyle bitiş (x4)';
    else if (okeyFinish) finishType = 'Okeyle bitiş (x2)';
    else if (pairFinish) finishType = 'Çiftten bitiş (x2)';
    else finishType = 'Normal bitiş';

    return { winner, finishType, deltas, totals, teamTotals };
}

module.exports = { UNOPENED_PENALTY, WINNER_REWARD, compute };