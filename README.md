# Fitness tracker

Fitness tracker with a **hybrid DBMS**: MySQL (users, roles, profiles, plans, sessions, goals, triggers, procedures, views)
and Memurai/Redis (simulated wearable stream, daily totals, journals, photo metadata).

## Architecture
```
Next.js 16 (App Router, frontend/)  --HTTP + JWT-->  Express 5 API (backend/)  --> MySQL 8   (structured, relational data)
        http://localhost:3000                          http://localhost:5000     --> Memurai  (streams, hashes, JSON documents)
                                                              ^
                               wearable simulator (simulator/) writes readings to Memurai every 5 s
```
- **Frontend:** Next.js App Router. Each screen is a route in `frontend/src/app/`; signed-in screens share the layout in `frontend/src/app/(app)/layout.jsx`.
- **Backend/API:** Express route handlers in `backend/src/routes` and `backend/src/controllers`. Every route except sign-in/sign-up needs a JWT; admin routes also check the role in MySQL.
- **Configuration:** backend runtime database credentials are split by purpose in local environment files; bootstrap and migration secrets are not loaded by the backend. The backend requires member, credential, and admin API MySQL accounts, plus `JWT_SECRET` and `REDIS_MEMBER_PASSWORD`. Backend and simulator Redis clients authenticate as `REDIS_USERNAME` (default `ft_redis_member`) using `REDIS_MEMBER_PASSWORD`. Redis recovery credentials remain in a protected local file outside the repository.
- **Browser access:** the backend uses the comma-separated `CORS_ORIGINS` allowlist. Local development defaults to `http://localhost:3000` and `http://127.0.0.1:3000`; set the deployed frontend origin(s) in the backend environment. Demo login is disabled by default and requires `DEMO_LOGIN_ENABLED=true` to enable.

### Redis ACL status

The backend, simulator, and Redis setup smoke check use `ft_redis_member`. It is limited to `fittrack:journal:*`, `fittrack:photos:*`, `fittrack:sensors:*`, and `fittrack:activity:*`, with only the Redis commands required by those features. Its ACL is persisted inline in the active Redis configuration; no external ACL file is configured. The `default` account is disabled. The separate `ft_redis_recovery` account is limited to ACL inspection/modification and `CONFIG REWRITE`; its password is stored in a protected local credential file outside this repository and must never be committed or logged. Use the member account for application data operations and the recovery account only for ACL administration.

- **Demo and DBMS documentation:** [`DEMO_GUIDE.md`](DEMO_GUIDE.md) (commands and expected results)
- **ER diagram and relational schema:** [`database/docs/`](database/docs)
- **Screen-to-table mapping:** [`database/docs/UI_TABLE_MAPPING.md`](database/docs/UI_TABLE_MAPPING.md)

## Setup (once)
1. Copy `.env.example` to `.env` and fill in runtime MySQL account credentials, Redis settings, and application secrets. Keep bootstrap credentials in `database/.env.bootstrap` and migration credentials in `database/.env.migration`; both are git-ignored and need restrictive local file permissions.
2. Make sure **MySQL** and **Memurai** are running.
3. Install packages:
   ```
   npm install            (project root - needed by the database scripts)
   cd backend  && npm install
   cd frontend && npm install
   cd simulator && npm install
   ```
4. For a **new, empty database only**, bootstrap the schema and demo data:
   ```
   node database\setup_mysql.js
   ```
   Never run this setup command against an existing database. It is not an upgrade or reset command. Existing databases use the separately reviewed migration procedure below.

The account provisioner creates missing accounts with MySQL-generated random passwords and stores them only in the protected local runtime/bootstrap/migration files. Existing account passwords are not reset.

### Existing database migrations

Backend startup performs no DDL. Review and back up the current database before a maintenance-window migration. The explicit command uses only `DB_MIGRATION_USER` and `DB_MIGRATION_PASSWORD` from `database/.env.migration`:

```powershell
node database\migrate.js
```

This migration command changes tables/columns only and never recreates stored objects. Changes to procedures, functions, triggers, or views use the separate bootstrap DBA procedure and require separate approval. Never use root or the API admin account for ordinary runtime requests.

## Run (three separate terminals, all from the project root)
| Terminal | Command | Notes |
|---|---|---|
| 1 | `cd backend` then `npm start` | API on http://localhost:5000 |
| 2 | `cd frontend` then `npm run dev` | Next.js app on http://localhost:3000 |
| 3 | `node simulator\wearableSimulator.js` | Generates readings for **every registered user** |

Open http://localhost:3000, then sign in with a demo account (see [`DEMO_GUIDE.md`](DEMO_GUIDE.md#demo-accounts-passwords-are-stored-only-as-bcrypt-hashes)), **Create an account**, or **Continue as demo user**. The demo sign-in endpoint is disabled unless the backend environment explicitly sets `DEMO_LOGIN_ENABLED=true`.
Admins see an extra **Users & roles** page.

## Roles
| Level | Role | What it can do |
|---|---|---|
| Application (`users.role`) | `member` | own plans, sessions, goals, journal and gallery |
| Application (`users.role`) | `admin` | everything a member can do, plus **Users & roles** (change roles, see the activity and audit logs) |
| Database (MySQL roles) | `fittrack_member` (account `ft_member`) | column-limited app queries; API ownership predicates scope normal requests, while MySQL grants do not enforce per-user row isolation |
| Database (MySQL roles) | `fittrack_admin` (account `ft_admin`) | full control of `fittrack_db` |
| Database (MySQL roles) | `fittrack_credential` (account `ft_credential`) | registration, login, and password-hash operations only |
| Database (MySQL roles) | `fittrack_api_admin` (account `ft_api_admin`) | narrow admin view/log reads and `sp_change_role` execution |
| Database (MySQL roles) | `fittrack_migration` (account `ft_migrate`) | explicit table/column schema migration only |
| Database (MySQL account) | locked `ft_object_definer` | column-limited execution context for stored objects; cannot log in |

## Where user data lives
| Data | Store | Table / key |
|---|---|---|
| Account (name, email, bcrypt password hash, role, created, last sign-in) | MySQL | `users` |
| Personal details | MySQL | `user_profiles` (1:1 with `users`) |
| Plans, exercises in a plan, sessions, sets, goals | MySQL | `workout_plans`, `plan_exercises`, `exercises`, `workout_sessions`, `workout_sets`, `fitness_goals` |
| Automatic logs (written by triggers / procedure) | MySQL | `activity_log`, `role_audit_log` |
| Wearable readings, daily totals | Memurai | `fittrack:sensors:{userId}`, `fittrack:activity:daily:{userId}:{date}` |
| Journals, photo entries | Memurai | `fittrack:journal:{userId}:{id}`, `fittrack:photos:{userId}:{id}` |

Application passwords are stored only as bcrypt hashes. MySQL connection credentials are kept in ignored, ACL-protected local environment files and never in source code.

## API (Express, base URL `http://localhost:5000/api`)
| Area | Endpoints | Store |
|---|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/demo`, `GET/PUT /auth/me`, `PUT /auth/password` | MySQL `users`, `user_profiles` (register runs in one transaction) |
| Plans | `GET /workouts/exercises`, `GET/POST /workouts/plans`, `GET/PUT/DELETE /workouts/plans/:id` | MySQL `workout_plans`, `plan_exercises`, `exercises` |
| Sessions | `GET/POST /workouts/sessions`, `GET /workouts/sessions/:id`, `POST /workouts/sessions/:id/sets`, `PUT /workouts/sessions/:id/end` | MySQL `workout_sessions`, `workout_sets` (finishing fires `trg_session_finished`) |
| Goals | `GET/POST /goals`, `PUT/DELETE /goals/:id` | MySQL `fitness_goals`, progress from MySQL + Memurai |
| Journal | `GET/POST /journals`, `PUT/DELETE /journals/:id` | Memurai `fittrack:journal:*` |
| Gallery | `GET/POST /photos`, `DELETE /photos/:id` | Memurai `fittrack:photos:*` |
| Activity | `GET /activity/status`, `/activity/readings?range=1h\|24h\|7d\|30d`, `/activity/daily?days=N` | Memurai stream + daily hashes |
| Dashboard | `GET /dashboard` | both |
| Admin (admin role only) | `GET /admin/users`, `PUT /admin/users/:id/role`, `GET /admin/activity` | MySQL, role change through `sp_change_role` |

## Useful commands
```
node database\show_users.js                  list users, roles and profiles
node database\migrate.js                     upgrade an existing database
node database\memurai_setup.js               test Memurai and write sample data
```

## Team contributions

| Member | SRN | Contributions |
|---|---|---|
| Sarthki Vachhani | PES1UG24CS422 | MySQL schema and constraints, triggers and procedure, seed data, demo scripts, Express API |
| Sejal Siddapuram | PES1UG24CS426 | Next.js frontend, backend cleanup, documentation and project report, testing |
Project report (objectives, requirements, architecture, screenshots, test results, conclusion): [`docs/PROJECT_REPORT.md`](docs/PROJECT_REPORT.md)
