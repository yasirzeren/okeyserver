'use strict';
module.exports = `
  CREATE TABLE IF NOT EXISTS community_consents (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    version TEXT NOT NULL, accepted BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS player_blocks (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created BIGINT NOT NULL, PRIMARY KEY(account_id, target_id), CHECK(account_id <> target_id)
  );
  CREATE TABLE IF NOT EXISTS community_reports (
    id TEXT PRIMARY KEY, reporter TEXT NOT NULL REFERENCES accounts(id),
    target TEXT NOT NULL REFERENCES accounts(id), kind TEXT NOT NULL CHECK(kind IN ('chat','player')),
    context_key TEXT NOT NULL, room_code TEXT NOT NULL, message_text TEXT NOT NULL,
    reason TEXT NOT NULL, created BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
    reviewer TEXT REFERENCES accounts(id), disposition TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', resolved BIGINT,
    UNIQUE(reporter, context_key)
  );
  CREATE INDEX IF NOT EXISTS community_reports_queue ON community_reports(status, created);
  CREATE INDEX IF NOT EXISTS community_reports_reporter ON community_reports(reporter, created);
`;
