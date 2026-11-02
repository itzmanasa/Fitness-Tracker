// Explicitly upgrades schema tables/columns only, using migration credentials.
// Stored objects are not recreated here; that requires the separate DBA procedure.
//   node database/migrate.js (uses database/.env.migration or process environment)
const ensureSchema = require('../backend/src/config/ensureSchema');
const pool = require('../backend/src/config/mysqlMigration');

(async () => {
    let conn;
    try {
        for (const name of ['DB_MIGRATION_USER', 'DB_MIGRATION_PASSWORD']) {
            if (!process.env[name]) throw new Error(`${name} must be supplied to the migration process.`);
        }
        conn = await pool.getConnection();
        await conn.query("SET ROLE 'fittrack_migration'");
        await ensureSchema(conn);
        console.log('Database schema tables and columns are up to date. Stored objects were not changed.');
    } catch (e) {
        console.error('Migration failed:', e.message);
        process.exitCode = 1;
    } finally {
        if (conn) conn.release();
        await pool.end();
    }
})();
