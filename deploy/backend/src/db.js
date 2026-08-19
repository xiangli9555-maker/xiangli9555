const mysql = require('mysql2/promise');

// mysql2 的 charset 参数对应连接建立时 handshake charset，
// 但对某些版本仍需通过 SET NAMES 保证 3 个通道 (client/connection/results) 全 utf8mb4，
// 否则 WHERE 里的中文字面量会被当 latin1 处理，导致匹配失败。
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'vo_manager_pwd_2026',
  database: process.env.DB_NAME || 'vo_manager',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_unicode_ci'
});

// 每条新连接建立时强制 utf8mb4（用回调风格，promise pool 的 on('connection') 拿到的是原生 conn）
pool.pool.on('connection', (conn) => {
  conn.query("SET NAMES 'utf8mb4' COLLATE 'utf8mb4_unicode_ci'", () => {});
});

module.exports = pool;
