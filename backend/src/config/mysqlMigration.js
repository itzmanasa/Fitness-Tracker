const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({
    path: path.join(__dirname, '..', '..', '..', 'database', '.env.migration'),
    quiet: true
});

module.exports = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_MIGRATION_USER,
    password: process.env.DB_MIGRATION_PASSWORD,
    database: process.env.DB_NAME || 'fittrack_db',
    waitForConnections: true,
    connectionLimit: 1,
    queueLimit: 0
});
