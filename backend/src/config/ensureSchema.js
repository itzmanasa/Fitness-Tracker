/**
 * Idempotent schema upgrade, run only by the explicit migration command.
 * Brings an existing fittrack_db up to date without touching existing data:
 *   - users.last_login_at              (column)
 *   - users.role                       (column: admin | member, RBAC)
 *   - user_profiles                    (1:1 table with the user's personal details)
 *   - activity_log, role_audit_log     (tables written by triggers / sp_change_role)
 * Stored objects are created separately by the reviewed bootstrap DBA procedure;
 * the migration runner does not drop or recreate them.
 */
async function columnExists(pool, table, column) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows[0].n > 0;
}

async function ensureSchema(pool) {
    if (!pool) throw new Error('A migration connection is required to verify or upgrade the schema.');
    if (!(await columnExists(pool, 'users', 'last_login_at'))) {
        await pool.query('ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL');
        console.log('[schema] Added users.last_login_at');
    }

    if (!(await columnExists(pool, 'users', 'role'))) {
        await pool.query("ALTER TABLE users ADD COLUMN role ENUM('admin','member') NOT NULL DEFAULT 'member'");
        console.log('[schema] Added users.role');
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_profiles (
            user_id INT PRIMARY KEY,
            date_of_birth DATE NULL,
            gender VARCHAR(20) NULL,
            height_cm DECIMAL(5,1) NULL,
            weight_kg DECIMAL(5,1) NULL,
            fitness_level VARCHAR(20) NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            event_type VARCHAR(40) NOT NULL,
            message VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_activity_user_time (user_id, created_at)
        ) ENGINE=InnoDB
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS role_audit_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            actor_id INT NOT NULL,
            target_user_id INT NOT NULL,
            old_role VARCHAR(10) NOT NULL,
            new_role VARCHAR(10) NOT NULL,
            changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_audit_target FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
}

module.exports = ensureSchema;
