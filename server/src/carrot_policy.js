'use strict';

const ROOM_COST = 400;
const DAILY_CARROTS = 1000;
const DAY_MS = 86400000;

// Türkiye uses UTC+3, so local noon is 09:00 UTC.
function latestRewardTime(now = Date.now()) {
  const noonUtc = 9 * 3600000;
  return Math.floor((now - noonUtc) / DAY_MS) * DAY_MS + noonUtc;
}

module.exports = { ROOM_COST, DAILY_CARROTS, DAY_MS, latestRewardTime };
