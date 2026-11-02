// Creates a new, empty fittrack_db: schema -> seed -> accounts/grants -> stored programs.
//   node database/setup_mysql.js
// Uses database/.env.bootstrap and database/.env.migration; refuses non-empty databases.
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { runSqlFile } = require('./sqlRunner');
const { createDbAccounts } = require('./security/create_db_accounts');

function loadEnvironmentFile(file, preferredKeys = []) {
    for (const key of preferredKeys) delete process.env[key];
    if (!fs.existsSync(file)) return;
    const fileEnvironment = dotenv.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(fileEnvironment)) {
        if (preferredKeys.includes(key) || process.env[key] === undefined) process.env[key] = value;
    }
}

// Existing process values take precedence for general settings. Protected
// account credentials are authoritative for their own account-specific keys.
loadEnvironmentFile(path.join(__dirname, '..', '.env'));
loadEnvironmentFile(path.join(__dirname, '.env.bootstrap'), [
    'DB_BOOTSTRAP_USER', 'DB_BOOTSTRAP_PASSWORD', 'DB_ADMIN_PASSWORD'
]);
loadEnvironmentFile(path.join(__dirname, '.env.migration'), [
    'DB_MIGRATION_USER', 'DB_MIGRATION_PASSWORD'
]);

(async () => {
    let conn;
    try {
        for (const name of ['DB_BOOTSTRAP_USER', 'DB_BOOTSTRAP_PASSWORD']) {
            if (!process.env[name]) throw new Error(`${name} is required in database/.env.bootstrap.`);
        }
        for (const name of ['DB_MIGRATION_USER']) {
            if (!process.env[name]) throw new Error(`${name} must be configured before fresh database setup.`);
        }
        console.log('Connecting to MySQL with the separate bootstrap account...');
        conn = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_BOOTSTRAP_USER,
            password: process.env.DB_BOOTSTRAP_PASSWORD,
            multipleStatements: false
        });

        const dir = __dirname;
        const dbName = process.env.DB_NAME || 'fittrack_db';
        const [existingObjects] = await conn.query(
            `SELECT
                (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?) AS table_objects,
                (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) AS routines,
                (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?) AS triggers,
                (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS events`,
            [dbName, dbName, dbName, dbName]
        );
        if (Object.values(existingObjects[0]).some((count) => Number(count) > 0)) {
            throw new Error('setup_mysql.js is restricted to an empty database. Use the reviewed migration procedure for existing data.');
        }
        console.log(`schema.sql            -> ${await runSqlFile(conn, path.join(dir, 'schema.sql'))} statements`);
        console.log(`seed.sql              -> ${await runSqlFile(conn, path.join(dir, 'seed.sql'))} statements`);

        await createDbAccounts(conn, { createCoreRoles: true });
        console.log(`programmability.sql   -> ${await runSqlFile(conn, path.join(dir, 'programmability.sql'))} statements (bootstrap creates objects with the locked least-privilege definer)`);
        console.log('Database setup complete!');
        process.exitCode = 0;
    } catch (error) {
        console.error('Database setup failed:', error.message);
        process.exitCode = 1;
    } finally {
        if (conn) await conn.end().catch(() => {});
    }
})();
