// Administrative directory report. Uses the narrow admin API account, not the member runtime account.
// Never query or display password hashes or full profile details.
//   node database/show_users.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const pool = require('../backend/src/config/mysqlAdmin');

(async () => {
    try {
        const [rows] = await pool.query(`
            SELECT id, name, email, role, gender, fitness_level, sessions, active_goals, created_at, last_login_at
            FROM v_user_directory
            ORDER BY id`);
        console.table(rows);
        const roles = {};
        rows.forEach((r) => { roles[r.role] = (roles[r.role] || 0) + 1; });
        console.log(`${rows.length} user(s) in fittrack_db.users  ->  roles: ${JSON.stringify(roles)}`);
    } catch (e) {
        console.error('Could not read users:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
