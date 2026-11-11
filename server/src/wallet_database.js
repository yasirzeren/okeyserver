'use strict';

function postgresQueries(connection) {
  const query = (sql, args) => {
    let index = 0;
    return connection.query(sql.replace(/\?/g, () => '$' + ++index), args);
  };
  return {
    lock: ' FOR UPDATE',
    movementOrder: 'time DESC, sequence DESC',
    get: async (sql, ...args) => (await query(sql, args)).rows[0],
    all: async (sql, ...args) => (await query(sql, args)).rows,
    run: async (sql, ...args) => (await query(sql, args)).rowCount,
    exec: (sql) => connection.query(sql),
  };
}

class PostgresDatabase {
  constructor(pool) {
    this.pool = pool;
    Object.assign(this, postgresQueries(pool));
  }
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(postgresQueries(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }
  close() { return this.pool.end(); }
}

module.exports = { PostgresDatabase };
