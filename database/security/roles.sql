-- =====================================================================
-- FitTrack - DATABASE-LEVEL role-based access control (RBAC)
--
-- Existing member/manual-admin roles. Accounts are provisioned by
-- security/create_db_accounts.js; generated passwords are saved only in protected
-- ignored environment files, never in this SQL file.
--
--   fittrack_admin   : full control of fittrack_db (tables, views, triggers,
--                      procedures, EXECUTE on sp_change_role, audit log)
--   fittrack_member  : column-limited reads/writes for app operations. API ownership
--                      predicates scope normal requests; MySQL grants do not provide
--                      per-user row isolation. It cannot read password hashes, write
--                      the audit log, change roles, or call sp_change_role.
-- Fresh-install grants are column-limited where possible and re-runnable. This
-- file never drops roles or resets account passwords. Applying narrower grants
-- to an existing installation requires a separately reviewed REVOKE migration;
-- editing this file alone does not remove pre-existing table-level privileges.
-- =====================================================================

CREATE ROLE IF NOT EXISTS 'fittrack_admin', 'fittrack_member';

-- ---- Admin ----------------------------------------------------------
GRANT ALL PRIVILEGES ON fittrack_db.* TO 'fittrack_admin';

-- ---- Member: READ only what the app shows ----------------------------
GRANT SELECT (id, name, description, muscle_group, equipment_needed)
    ON fittrack_db.exercises TO 'fittrack_member';
GRANT SELECT (id, user_id, name, description, created_at, updated_at)
    ON fittrack_db.workout_plans TO 'fittrack_member';
GRANT SELECT (id, plan_id, exercise_id, sets, reps, target_weight, rest_seconds, exercise_order)
    ON fittrack_db.plan_exercises TO 'fittrack_member';
GRANT SELECT (id, user_id, plan_id, start_time, end_time, notes)
    ON fittrack_db.workout_sessions TO 'fittrack_member';
GRANT SELECT (id, session_id, exercise_id, set_number, reps, weight, completed)
    ON fittrack_db.workout_sets TO 'fittrack_member';
GRANT SELECT (id, user_id, goal_type, target_value, start_date, deadline, status)
    ON fittrack_db.fitness_goals TO 'fittrack_member';
GRANT SELECT (user_id, date_of_birth, gender, height_cm, weight_kg, fitness_level)
    ON fittrack_db.user_profiles TO 'fittrack_member';
-- column-level: no password_hash, no role changes visible to a member's SELECT *
GRANT SELECT (id, name, email, role, created_at, last_login_at) ON fittrack_db.users TO 'fittrack_member';

-- ---- Member: WRITE only own working data ------------------------------
GRANT INSERT (user_id, name, description), UPDATE (name, description), DELETE
    ON fittrack_db.workout_plans TO 'fittrack_member';
GRANT INSERT (plan_id, exercise_id, sets, reps, target_weight, rest_seconds, exercise_order), DELETE
    ON fittrack_db.plan_exercises TO 'fittrack_member';
GRANT INSERT (user_id, plan_id, start_time, notes), UPDATE (end_time)
    ON fittrack_db.workout_sessions TO 'fittrack_member';
GRANT INSERT (session_id, exercise_id, set_number, reps, weight, completed)
    ON fittrack_db.workout_sets TO 'fittrack_member';
GRANT INSERT (user_id, goal_type, target_value, start_date, deadline, status),
      UPDATE (goal_type, target_value, start_date, deadline, status), DELETE
    ON fittrack_db.fitness_goals TO 'fittrack_member';
GRANT INSERT (user_id, date_of_birth, gender, height_cm, weight_kg, fitness_level),
      UPDATE (date_of_birth, gender, height_cm, weight_kg, fitness_level)
    ON fittrack_db.user_profiles TO 'fittrack_member';
-- The API allows a signed-in member to update only their own display name and
-- last-login time. These column grants do not constrain row IDs for direct SQL.
GRANT UPDATE (name, last_login_at) ON fittrack_db.users      TO 'fittrack_member';
