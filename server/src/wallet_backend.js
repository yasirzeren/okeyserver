'use strict';
const { join } = require('node:path');
const { Pool } = require('pg');
const { Wallet } = require('./wallet');
const { PostgresWallet } = require('./postgres_wallet');

async function createWallet({ recoverPending = true } = {}) {
  if (process.env.BUNNY_DATABASE_URL) {
    const url = new URL(process.env.BUNNY_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('Invalid database protocol');
    }
    // Always validate the remote server certificate.
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    const pool = new Pool({
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true },
      max: 4,
      connectionTimeoutMillis: 8000,
    });
    pool.on('error', (error) => console.error('Database pool:', error.code || 'connection error'));
    const wallet = new PostgresWallet(pool);
    try {
      await wallet.initialize();
      return wallet;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  if (process.env.RENDER && !process.env.BUNNY_DB_PATH) return null;
  return new Wallet(process.env.BUNNY_DB_PATH || join(__dirname, '..', 'data', 'bunny.sqlite'), { recoverPending });
}

module.exports = { createWallet };
