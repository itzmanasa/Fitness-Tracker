-- Additive API/migration roles for MySQL 8.0.46.
-- Apply only after reviewing this SQL and confirming a current backup.
-- Never run setup_mysql.js or this file as part of backend startup.

CREATE ROLE IF NOT EXISTS 'fittrack_credential', 'fittrack_api_admin', 'fittrack_migration';

-- Registration, login, and password updates. Hashes are not readable by the member role.
GRANT SELECT (id, email, password_hash)
    ON fittrack_db.users TO 'fittrack_credential';
GRANT INSERT (name, email, password_hash, last_login_at)
    ON fittrack_db.users TO 'fittrack_credential';
GRANT UPDATE (password_hash, last_login_at)
    ON fittrack_db.users TO 'fittrack_credential';
GRANT INSERT (user_id, date_of_birth, gender, height_cm, weight_kg, fitness_level)
    ON fittrack_db.user_profiles TO 'fittrack_credential';
GRANT UPDATE (date_of_birth, gender, height_cm, weight_kg, fitness_level)
    ON fittrack_db.user_profiles TO 'fittrack_credential';

-- The route's existing authMiddleware + requireRole('admin') execute before this pool is used.
GRANT SELECT ON fittrack_db.v_user_directory TO 'fittrack_api_admin';
GRANT EXECUTE ON PROCEDURE fittrack_db.sp_change_role TO 'fittrack_api_admin';
GRANT SELECT (id, name, email, role) ON fittrack_db.users TO 'fittrack_api_admin';
GRANT SELECT (id, user_id, event_type, message, created_at)
    ON fittrack_db.activity_log TO 'fittrack_api_admin';
GRANT SELECT (id, actor_id, target_user_id, old_role, new_role, changed_at)
    ON fittrack_db.role_audit_log TO 'fittrack_api_admin';

-- Migration DDL is explicit/manual and schema-only. It cannot alter application rows
-- or create/drop stored objects.
GRANT CREATE ON fittrack_db.* TO 'fittrack_migration';
GRANT ALTER ON fittrack_db.users TO 'fittrack_migration';
GRANT REFERENCES ON fittrack_db.users TO 'fittrack_migration';

-- Stored objects use a separate non-login definer account with only the direct
-- column privileges needed by their bodies. Bootstrap DBA creates objects with
-- this explicit DEFINER; the migration account never receives SET_USER_ID/SUPER.
GRANT SELECT (session_id, reps, weight, completed)
    ON fittrack_db.workout_sets TO 'ft_object_definer'@'localhost';
GRANT SELECT (id, user_id, plan_id, start_time, end_time)
    ON fittrack_db.workout_sessions TO 'ft_object_definer'@'localhost';
GRANT SELECT (id, user_id, status, goal_type, target_value, start_date, deadline)
    ON fittrack_db.fitness_goals TO 'ft_object_definer'@'localhost';
GRANT SELECT (id, name, email, role, created_at, last_login_at)
    ON fittrack_db.users TO 'ft_object_definer'@'localhost';
GRANT SELECT (user_id, gender, fitness_level)
    ON fittrack_db.user_profiles TO 'ft_object_definer'@'localhost';
GRANT SELECT (id, name)
    ON fittrack_db.workout_plans TO 'ft_object_definer'@'localhost';
GRANT UPDATE (role) ON fittrack_db.users TO 'ft_object_definer'@'localhost';
GRANT UPDATE (status) ON fittrack_db.fitness_goals TO 'ft_object_definer'@'localhost';
GRANT INSERT (user_id, event_type, message)
    ON fittrack_db.activity_log TO 'ft_object_definer'@'localhost';
GRANT INSERT (actor_id, target_user_id, old_role, new_role)
    ON fittrack_db.role_audit_log TO 'ft_object_definer'@'localhost';

-- Attach the preserved member/manual-admin roles and the new runtime roles.
GRANT 'fittrack_member' TO 'ft_member'@'localhost';
SET DEFAULT ROLE 'fittrack_member' TO 'ft_member'@'localhost';
GRANT 'fittrack_admin' TO 'ft_admin'@'localhost';
SET DEFAULT ROLE 'fittrack_admin' TO 'ft_admin'@'localhost';
GRANT 'fittrack_credential' TO 'ft_credential'@'localhost';
SET DEFAULT ROLE 'fittrack_credential' TO 'ft_credential'@'localhost';
GRANT 'fittrack_api_admin' TO 'ft_api_admin'@'localhost';
SET DEFAULT ROLE 'fittrack_api_admin' TO 'ft_api_admin'@'localhost';
GRANT 'fittrack_migration' TO 'ft_migrate'@'localhost';
-- Migration login explicitly SET ROLE for DDL; its stored-object default roles stay empty.
SET DEFAULT ROLE NONE TO 'ft_migrate'@'localhost';
