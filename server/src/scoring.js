'use strict';
const R = require('./rules');

const UNOPENED_PENALTY = 202;
const WINNER_REWARD = 101;

/** Puanlama TEK merkezî fonksiyondur. */
function compute({
    players,
    winner,
    okeyFinish,
    pairFinish,
    okey,
    partners,
    kafaFinish = false,
    voided = false,
}) {
    const deltas = [0, 0, 0, 0];
    const opposingTeamOpened = winner !== null &&
      partners &&
      players.some((p, i) => i % 2 !== winner % 2 && p.opened);
    for (let i = 0; i < 4; i++) {
        const p = players[i];
        const rawHandPoints = R.handPenalty(p.hand, okey);
        if (voided) deltas[i] = 0;
        else if (winner === null) {
            deltas[i] = losingHandPoints(p, rawHandPoints) + pairOver100Penalty(p, rawHandPoints);
        }
        else if (i === winner) {
            const mult = (kafaFinish ? 2 : 1) * (okeyFinish ? 2 : 1) * (pairFinish ? 2 : 1);
            deltas[i] = -WINNER_REWARD * mult;
        }
        else if (partners && i === (winner + 2) % 4) deltas[i] = 0;
        else {
            let mult = (okeyFinish ? 2 : 1) * (pairFinish ? 2 : 1);
            if (!p.opened && kafaFinish) mult *= 2;
            let points = losingHandPoints(p, rawHandPoints) * mult;
            points += pairOver100Penalty(p, rawHandPoints);
            if (!p.opened && kafaFinish && partners && opposingTeamOpened) {
                points = Math.floor(points / 2);
            }
            deltas[i] = points;
        }
    }
    const totals = players.map((p, i) => p.score + deltas[i]);
    const teamTotals = partners ? [totals[0] + totals[2], totals[1] + totals[3]] : [];

    let finishType;
    if (voided) finishType = 'El iptal edildi (herkes çift açtı)';
    else if (winner === null) finishType = 'Deste bitti (kazanan yok)';
    else if (kafaFinish && okeyFinish && pairFinish) finishType = 'Çiftten, okeyle ve kafa bitişi (x8)';
    else if (kafaFinish && okeyFinish) finishType = 'Okey kafa bitişi (x4)';
    else if (kafaFinish && pairFinish) finishType = 'Çiftten kafa bitişi (x4)';
    else if (okeyFinish && pairFinish) finishType = 'Çiftten ve okeyle bitiş (x4)';
    else if (kafaFinish) finishType = 'Kafa bitişi (x2)';
    else if (okeyFinish) finishType = 'Okeyle bitiş (x2)';
    else if (pairFinish) finishType = 'Çiftten bitiş (x2)';
    else finishType = 'Normal bitiş';

    return { winner, finishType, kafaFinish, voided, deltas, totals, teamTotals };
}

function losingHandPoints(player, handPoints) {
    if (!player.opened) return UNOPENED_PENALTY;
    return player.openType === 'pairs' ? handPoints * 2 : handPoints;
}

function pairOver100Penalty(player, handPoints) {
    return player.opened && player.openType === 'pairs' && handPoints > 100 ? 101 : 0;
}

module.exports = { UNOPENED_PENALTY, WINNER_REWARD, compute };