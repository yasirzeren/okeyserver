'use strict';

// Katlama kuralı ayrı modüldür. Kuralı değiştirmek için sadece burası düzenlenir.
const BASE_SERIES = 101;

/** type: 'series' (puan eşiği) veya 'pairs' (çift sayısı eşiği). */
function required({ type, folding, basePairs, maxSeriesOpen, maxPairOpen }) {
    if (type === 'series') {
        return folding ? Math.max(BASE_SERIES, maxSeriesOpen + 1) : BASE_SERIES;
    }
    return folding ? Math.max(basePairs, maxPairOpen + 1) : basePairs;
}

module.exports = { BASE_SERIES, required };