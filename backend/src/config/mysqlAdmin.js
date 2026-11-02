const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

module.exports = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_ADMIN_API_USER,
    password: process.env.DB_ADMIN_API_PASSWORD,
    database: process.env.DB_NAME || 'fittrack_db',
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0
});
