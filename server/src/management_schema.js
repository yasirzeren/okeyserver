'use strict';

module.exports = `
  CREATE TABLE IF NOT EXISTS password_resets (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id), digest TEXT NOT NULL,
    issued BIGINT NOT NULL, expires BIGINT NOT NULL, attempts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_controls (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    status TEXT NOT NULL CHECK(status IN ('active', 'banned', 'deleted')),
    reason TEXT NOT NULL, updated BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS managers (
    slot INTEGER PRIMARY KEY CHECK(slot IN (1, 2)),
    account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id)
  );
  CREATE TABLE IF NOT EXISTS management_state (id INTEGER PRIMARY KEY);
  INSERT INTO management_state VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS management_audit (
    request_id TEXT PRIMARY KEY,
    actor TEXT NOT NULL REFERENCES accounts(id),
    target TEXT NOT NULL REFERENCES accounts(id),
    action TEXT NOT NULL, reason TEXT NOT NULL, time BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS management_migrations (id INTEGER PRIMARY KEY);
  INSERT INTO managers(slot, account_id)
  SELECT 1, id FROM accounts WHERE bunny_manager_email_hash(email) = 'd5c307ce08edb11545d706db59e39a986887234906e766048bda1231ec48aa0f'
    AND NOT EXISTS(SELECT 1 FROM managers)
    AND NOT EXISTS(SELECT 1 FROM management_migrations WHERE id = 1)
  ON CONFLICT DO NOTHING;
  INSERT INTO management_migrations VALUES (1) ON CONFLICT DO NOTHING;
`;
