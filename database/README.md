# FitTrack Database

Hybrid design: **MySQL** for structured, related, transactional data and **Memurai** (Redis protocol) for high-volume or flexible data.

## Files
| File | Purpose |
|---|---|
| `schema.sql` | tables, primary/foreign keys, CHECK, UNIQUE and index definitions (fresh install) |
| `programmability.sql` | 2 triggers, 1 procedure, 1 function, 2 views (idempotent, uses `DELIMITER`) |
| `seed.sql` | demo users with roles, profiles, exercises, plans, sessions, sets, goals |
| `security/roles.sql` | additive database roles `fittrack_admin` and `fittrack_member`; no role drops |
| `security/privilege_separation.sql` | grants for credential, admin API, schema-only migration roles, and locked stored-object definer; review before application |
| `security/create_db_accounts.js` | creates fresh-install accounts without resetting existing account passwords |
| `security/ACCOUNT_RECOVERY.md` | safe, approval-gated recovery steps if generated credential persistence fails |
| `security/rotate_bootstrap_credentials.js` | explicit bootstrap/manual-admin password rotation; supports a no-change `--dry-run` |
| `sqlRunner.js` | runs `.sql` files statement by statement, honouring `DELIMITER` |
| `setup_mysql.js` | empty-database bootstrap: schema, seed, roles/accounts, then stored programs with the locked object definer |
| `migrate.js` | explicit upgrade using only `database/.env.migration`; backend startup never runs DDL |
| `queries.sql` | the important queries (joins, aggregates, subqueries, CTEs, views, index plan) |
| `demo/` | one script per demo item (see `../DEMO_GUIDE.md`) |
| `docs/` | ER diagram (`er_diagram.png`, `.mmd`, `.svg`), `RELATIONAL_SCHEMA.md`, `UI_TABLE_MAPPING.md` |
| `show_users.js` | admin API directory report; omits sensitive profile details and password hashes |
| `memurai_setup.js` | connection test and sample writes for Memurai |

## Fresh database bootstrap

`setup_mysql.js` is for a new, empty database only. It uses the separate bootstrap credential file and seeds demo rows. It creates stored objects through the bootstrap DBA connection with a locked, least-privilege definer account. Never use it as an upgrade command.
```
node database/setup_mysql.js
```

## Existing database migration

Review a backup before running `node database/migrate.js`. It uses only `database/.env.migration` and performs table/column DDL; backend startup never runs DDL. It does not recreate stored objects. Procedure, function, trigger, and view changes require the separate bootstrap DBA procedure and separate approval because binary logging is enabled and `log_bin_trust_function_creators` is disabled.

## Memurai key design
| Key | Type | Notes |
|---|---|---|
| `fittrack:sensors:{userId}` | Stream | append-only wearable readings |
| `fittrack:activity:daily:{userId}:{YYYY-MM-DD}` | Hash | daily totals, updated often |
| `fittrack:journal:{userId}:{id}` | String (JSON) | flexible journal entries |
| `fittrack:photos:{userId}:{id}` | String (JSON) | photo metadata (no image files) |
