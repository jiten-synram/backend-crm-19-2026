'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

// ── Connection pool ────────────────────────────────────────────
const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '3306'),
  database:           process.env.DB_NAME,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           '+05:30',
  charset:            'utf8mb4',
  decimalNumbers:     true,
});

// ── Test connection on startup ─────────────────────────────────
const connectDB = async () => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('✅  MySQL connected — database:', process.env.DB_NAME);
  } catch (err) {
    console.error('❌  MySQL connection failed:', err.message);
    process.exit(1);
  }
};

// ── Helper: run a query ────────────────────────────────────────
// Usage: const rows = await query('SELECT * FROM leads WHERE id = ?', [id])
const query = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

// ── Helper: run query inside a transaction ─────────────────────
// Usage:
//   await withTransaction(async (conn) => {
//     await conn.execute('INSERT ...', [...])
//     await conn.execute('UPDATE ...', [...])
//   })
const withTransaction = async (fn) => {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = { pool, query, withTransaction, connectDB };
