'use strict';
module.exports = `
  CREATE TABLE IF NOT EXISTS market_inventory (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    emoji_id TEXT NOT NULL, expires BIGINT NOT NULL,
    permanent INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0, 1)),
    PRIMARY KEY(account_id, emoji_id)
  );
  CREATE TABLE IF NOT EXISTS market_purchases (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, emoji_id TEXT NOT NULL,
    expires BIGINT NOT NULL, created BIGINT NOT NULL,
    duration TEXT NOT NULL DEFAULT 'rental' CHECK(duration IN ('rental', 'permanent')),
    PRIMARY KEY(account_id, request_id)
  );
  CREATE TABLE IF NOT EXISTS market_ad_daily (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    cutoff BIGINT NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0 AND used <= 5),
    PRIMARY KEY(account_id, cutoff)
  );
  CREATE TABLE IF NOT EXISTS market_ad_offers (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    cutoff BIGINT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('carrots','emoji')),
    emoji_id TEXT, platform TEXT NOT NULL, ad_unit TEXT NOT NULL,
    created BIGINT NOT NULL, expires BIGINT NOT NULL, slot INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired','cancelled')),
    result_amount INTEGER NOT NULL DEFAULT 0, result_expires BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS market_offers_account ON market_ad_offers(account_id, cutoff, status, expires);
  CREATE TABLE IF NOT EXISTS market_ad_transactions (
    id TEXT PRIMARY KEY, offer_id TEXT NOT NULL UNIQUE REFERENCES market_ad_offers(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created BIGINT NOT NULL
  );
`;
