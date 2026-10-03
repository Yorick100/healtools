const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

function parseAddress(address='127.0.0.1:3306') {
  const i = address.lastIndexOf(':');
  if (i <= 0) return { host: address, port: 3306 };
  return { host: address.slice(0, i), port: Number(address.slice(i + 1)) || 3306 };
}
const addr = parseAddress(process.env.MYSQL_ADDRESS || '127.0.0.1:3306');
const pool = mysql.createPool({
  host: addr.host,
  port: addr.port,
  user: process.env.MYSQL_USERNAME || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'healtools',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_LIMIT || 8),
  queueLimit: 0,
  timezone: 'Z'
});

async function query(sql, params=[]) { const [rows] = await pool.execute(sql, params); return rows; }
async function one(sql, params=[]) { const rows = await query(sql, params); return rows[0] || null; }
async function tx(fn) {
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const out = await fn(conn); await conn.commit(); return out; }
  catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
  finally { conn.release(); }
}
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: addr.host, port: addr.port, user: process.env.MYSQL_USERNAME || 'root', password: process.env.MYSQL_PASSWORD || '', multipleStatements: true, charset: 'utf8mb4'
  });
  try { await conn.query(sql); } finally { await conn.end(); }
}
module.exports = { pool, query, one, tx, migrate };
