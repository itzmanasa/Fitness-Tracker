# MySQL account credential recovery

Use this procedure only after explicit approval to rotate the affected MySQL account. Do not rerun provisioning while an account exists without a persisted credential.

1. Stop the provisioning process and record the account name reported by the error. Do not copy a password from terminal output or logs. If account creation returned an error, first use the protected bootstrap workflow to determine whether the server created the account before the connection failed. Do not retry blindly.
2. Confirm the protected bootstrap credential file is available and its Windows ACL permits only the current user, SYSTEM, and local Administrators. Never display the file contents.
3. For the configured bootstrap account and `ft_admin`, run `node database/security/rotate_bootstrap_credentials.js --dry-run` to confirm the target usernames and credential file. The normal run rotates `ft_admin` first and the configured bootstrap account last. MySQL dual-password rotation retains each old password while saving and verifying its replacement.
4. The runner discards old secondary passwords only after both replacements are saved and authenticate. If it stops before retirement, it attempts to restore the old local credential values while those passwords remain valid as MySQL secondary credentials. If it stops during retirement, the replacement values are already saved and verified. In either case, the runner leaves `database/.bootstrap-rotation.pending` in place. Do not delete the marker or rerun the tool until the affected accounts have been reviewed.
5. Verify the expected variable names without displaying values. Use the protected bootstrap workflow to recover any account whose rotation state is uncertain.

Do not run `ALTER USER` in an interactive client that prints its result set; MySQL returns the generated password in that result. Do not put a literal password in SQL, a command argument, shell history, or a log.

The normal provisioner never rotates an existing account. The dedicated runner is a deliberate, separate credential rotation and must not be run without explicit approval. MySQL's `RETAIN CURRENT PASSWORD` / `DISCARD OLD PASSWORD` behavior is documented in the [MySQL 8.0 manual](https://dev.mysql.com/doc/refman/8.0/en/password-management.html).
