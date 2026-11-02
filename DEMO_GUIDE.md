# FitTrack - DBMS Level 3 demo guide

Everything below runs on the database that `database/setup_mysql.js` builds. Each demo item is one file, so you can
open it in a notepad and copy the command.

Commands are for **Windows (cmd)**. Use `cmd /c "..."` in PowerShell so that `<` redirection works. The Redis ACL script
(item 9b) needs Git Bash.

---

## 1. One-time setup (before the evaluation)

1. Copy `.env.example` to `.env` and fill in runtime MySQL account credentials (`ft_member`, `ft_credential`, `ft_api_admin`), Redis settings, and application secrets.
   Keep bootstrap credentials in `database/.env.bootstrap` and migration credentials in `database/.env.migration`; use the tracked `database/*env.example` files as templates and apply restrictive local ACLs.
   - `REDIS_MEMBER_PASSWORD` - password for the Redis member user (demos 9 and 9b)
   - `REDIS_RECOVERY_PASSWORD` - protected local recovery credential (demo 9b only; never commit it)
   All credential files are git-ignored. Passwords are never written into tracked `.sql` or `.js` files.
2. Start MySQL and Memurai.
3. Install packages once: `npm install` in the project root, then in `backend`, `frontend` and `simulator`.
4. Bootstrap only a new, empty database:
   ```
   node database\setup_mysql.js
   ```
   This creates the tables, demo rows, roles, and accounts, then creates stored objects through the bootstrap connection with the locked object definer. The script refuses to proceed if `fittrack_db` already contains objects. Never drop or reset an existing database to run this demo.
   For an existing database, take a backup before the explicit `node database\migrate.js` schema upgrade. Backend startup performs no DDL. Stored-object recreation is a separate bootstrap DBA operation and requires its own approval and write-free window.
5. Start the app (three terminals, from the project root):
   | Terminal | Command |
   |---|---|
   | 1 | `cd backend` then `npm start` |
   | 2 | `cd frontend` then `npm run dev` (Next.js, http://localhost:3000) |
   | 3 | `node simulator\wearableSimulator.js` |

The backend CORS allowlist comes from `CORS_ORIGINS` in `.env`; use a comma-separated list of frontend origins. Local defaults allow port 3000 on `localhost` and `127.0.0.1`. Demo sign-in is disabled by default. To use the demo button during a local presentation, explicitly set `DEMO_LOGIN_ENABLED=true` in the backend `.env` and restart the backend.

### Demo accounts (passwords are stored only as bcrypt hashes)

| Who | Email | Password | App role | Database account |
|---|---|---|---|---|
| Demo member | demo@fittrack.com | FitTrackDemo123! | member | - |
| Admin | admin@fittrack.com | Admin@2026 | admin | `ft_admin` (password from `database/.env.bootstrap`) |
| Member | ravi@fittrack.com | Member@2026 | member | `ft_member` (password from `.env`) |
| Member (trigger demo) | meera@fittrack.com | Member@2026 | member | - |

Before each rehearsal or presentation, run `database\demo\00_reset_for_rehearsal.sql` so that item 7 starts from the same point.

---

## 2. The demo, item by item

### Item 1 - How many users, and their roles
```
cmd /c "mysql -u ft_admin -p -h localhost fittrack_db < database\demo\01_users_and_roles.sql"
```
Shows `COUNT(*)` (4 users), counts per role (1 admin, 3 members), the directory view, and the account's database role.
**In the app:** sign in as `admin@fittrack.com` and open **Users & roles**. Same data, with role counts.

### Item 2 - ER diagram
Open `database\docs\er_diagram.png` (source: `database\docs\er_diagram.mmd`).

### Item 3 - How the ER diagram became a relational schema
Open `database\docs\RELATIONAL_SCHEMA.md` (sections 1 to 3: mapping rules, schema, data dictionary).
To show the real database, run:
```
cmd /c "mysql -u ft_admin -p -h localhost fittrack_db < database\demo\02_schema_inspection.sql"
```
It lists the tables, primary and foreign keys, CHECK and UNIQUE constraints, triggers, procedures and functions.

### Item 4 - Mapping of backend tables to the UI
Open `database\docs\UI_TABLE_MAPPING.md`. One row per screen: the API it calls, the controller, the tables it reads or writes.

### Item 5 - Create / update / delete on every table
```
cmd /c "mysql -u ft_admin -p -h localhost fittrack_db < database\demo\03_crud_all_tables.sql"
```
Inserts, updates and deletes rows in all 10 tables, checks the rows, then deletes them again (children first).
The final line should show `leftover 0`. Every line is also in the file, so you can copy any single command into the notepad.

### Item 6 - Queries
```
cmd /c "mysql -u ft_admin -p -h localhost fittrack_db < database\queries.sql"
```
14 labelled queries: inner join, aggregates with GROUP BY and HAVING, subqueries (NOT IN and NOT EXISTS), a transaction with rollback,
a correlated subquery, two CTEs (`WITH` and `WITH RECURSIVE`), ORDER BY with LIMIT, window `RANK()`, the view, and `EXPLAIN` showing the index.

### Item 7 - Trigger and procedure, data before and after
Reset first (only needed after a previous run):
```
cmd /c "mysql -u ft_admin -p -h localhost fittrack_db < database\demo\00_reset_for_rehearsal.sql"
```
Trigger:
```
cmd /c "mysql -u ft_admin -p -h localhost --force fittrack_db < database\demo\04_trigger_before_after.sql"
```
- **Before:** Meera's weekly goal (target 2) is `active`, and her session 3 is still open.
- **After:** one `UPDATE` on the session. The goal becomes `completed`, and two rows appear in `activity_log`.
- The last statement is refused by the second trigger ("Session is already finished"). That error is expected.

Procedure and function:
```
cmd /c "mysql -u ft_admin -p -h localhost --force fittrack_db < database\demo\05_procedure_function.sql"
```
The function returns session 1's volume (3680 kg). The procedure promotes Ravi to admin and reverts it, and each change is written to `role_audit_log`.
The last-admin refusal is expected.

**Why this trigger is specific to FitTrack:** it implements the fitness rule "a workout counts toward a weekly goal once it is finished,
and the goal completes when the target is reached". It is not a generic audit trigger. The API's goal progress uses the same rule.

### Item 8 - One complex nested query
```
cmd /c "mysql -u ft_admin -p -h localhost fittrack_db < database\demo\07_nested_query.sql"
```
Members who have an active goal and whose average session volume is above the gym-wide average. Three levels of nesting plus an `EXISTS`.
Expected result: Demo User, average 3680 kg.

### Item 9 - Redis (Memurai) create, read, update, delete
```
read -rsp "Redis member password: " REDIS_MEMBER_PASSWORD
export REDISCLI_AUTH="$REDIS_MEMBER_PASSWORD"
printf '\n'
redis-cli -h 127.0.0.1 -p 6379 --user ft_redis_member < database/demo/08_redis_crud.txt
unset REDISCLI_AUTH REDIS_MEMBER_PASSWORD
```
Uses a dedicated synthetic `acl-demo` key namespace, not a real user ID. It creates, reads and updates a journal string, daily activity hash, and sensor stream, then deletes only those three test keys. The demo uses only commands granted to `ft_redis_member`.

Redis role-based access (item 9b, Git Bash):
```
read -rsp "Redis recovery password: " REDIS_RECOVERY_PASSWORD
export REDIS_RECOVERY_PASSWORD
printf '\n'
read -rsp "Redis member password: " REDIS_MEMBER_PASSWORD
export REDIS_MEMBER_PASSWORD
printf '\n'
bash database/demo/09_redis_acl.sh
unset REDIS_RECOVERY_PASSWORD REDIS_MEMBER_PASSWORD
```
The recovery account is used only to configure the member ACL and persist it with `CONFIG REWRITE`. The script tests member access with an isolated journal key and cleans up only that key. It does not use the default account. The backend and simulator use `REDIS_USERNAME` and `REDIS_MEMBER_PASSWORD` from `.env`.

Manual member authentication check:
```
redis-cli -h 127.0.0.1 -p 6379 --user ft_redis_member --askpass PING
```
`--askpass` prompts for a password and ignores `REDISCLI_AUTH`; it does not load `.env`. For scripted checks, provide `REDISCLI_AUTH` through a protected process environment and omit `--askpass`. Never put a password directly in a command line.

The Redis `default` account is disabled. The `ft_redis_recovery` credential is stored outside the repository in a protected local credential file; retrieve it from the local secure store before the ACL demo, never put it in a command argument or commit it. The member account cannot administer ACLs or access keys outside the four FitTrack application namespaces.

### Item 10 - Modifications
The fresh-install database is built with `node database\setup_mysql.js`. Existing databases are migrated only through the separately reviewed migration procedure.

---

## 3. Role-based access in the database (rubric: at least 2 roles)

```
cmd /c "mysql -u ft_member -p -h localhost --force fittrack_db < database\demo\06_rbac_member_denied.sql"
```
As the member account:
- **allowed:** reading names and roles, reading sets, and editing its own working data
- **denied:** `SELECT * FROM users` and `password_hash`, deleting an exercise, changing a role, calling `sp_change_role`, reading the audit log, `DROP TABLE`

The `ft_admin`/`fittrack_admin` account remains for manual administration; `ft_member`/`fittrack_member` is the least-privilege member runtime. `ft_credential` handles registration and password hashes, `ft_api_admin` is used only after admin authorization, and `ft_migrate` is restricted to table/column DDL. Stored objects use the locked `ft_object_definer` account. `database/security/privilege_separation.sql` contains additive grants.

---

## 4. Rubric coverage (50 marks)

| Rubric item | Marks | Where to show it |
|---|---|---|
| ER diagram | 2 | `database/docs/er_diagram.png` |
| Relational schema with keys and constraints | 3 | `database/docs/RELATIONAL_SCHEMA.md`, demo 02 |
| SQL DDL with constraints | 4 | `database/schema.sql` (PK, FK, CHECK, UNIQUE, INDEX), `ALTER` in `backend/src/config/ensureSchema.js`, `DROP ... IF EXISTS` in `programmability.sql` |
| NoSQL / Memurai creation | 4 | `database/docs/RELATIONAL_SCHEMA.md` section 7, `database/memurai_setup.js` |
| Technology justification | 1 | `database/docs/RELATIONAL_SCHEMA.md` section 6 (why MySQL + Memurai) |
| DML operations | 4 | demo 03 (all tables), `queries.sql` |
| Nested / correlated / recursive queries, joins | 4 | `queries.sql` 8, 9, 11; demo 07 |
| Procedure / function, trigger, CTE | 6 | `programmability.sql`; demo 04, 05; `queries.sql` 10, 11 |
| NoSQL feature RUD | 7 | demo 08 (and 09) |
| Next.js interface | 3 | `frontend/src/app/` - App Router routes, shared signed-in layout, client-side role guard |
| Backend / API and DB integration | 2 | Next.js calls the Express API (`frontend/src/api.js`), `backend/src/controllers/*`, `database/docs/UI_TABLE_MAPPING.md` |
| Authentication, min. 2 roles, role-based access in DB | 4 | `users.role`, `requireRole`, demo 06, `database/security/roles.sql` |
| Documentation, Git/GitHub | 2 | this guide, `README.md`, `database/docs/`, git history |
| Originality, individual contribution, viva | 4 | be ready to explain each trigger, the procedure and the role grants |

---

## 5. Security notes

- Runtime credential files are git-ignored; tracked examples contain placeholders only. The backend exits at startup if any runtime account secret is missing.
- The backend and wearable simulator use only `ft_member`, `ft_credential`, and `ft_api_admin` for their respective purposes. Bootstrap and migration credentials are kept in separate local files and never loaded by backend runtime.
- User passwords are bcrypt hashes. `show_users.js` does not query or print password hashes.
- Row ownership (a member editing only their own rows) is enforced by the API. MySQL has no built-in row-level security.
