// Additively provisions the MySQL accounts and roles. It never drops roles or
// changes passwords for accounts that already exist.
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { runSqlFile } = require('../sqlRunner');
const dotenv = require('dotenv');
const rootDir = path.join(__dirname, '..', '..');

function loadProvisioningEnvironment() {
    const loadFile = (file, preferredKeys = []) => {
        for (const key of preferredKeys) delete process.env[key];
        if (!fs.existsSync(file)) return;
        const fileEnvironment = dotenv.parse(fs.readFileSync(file, 'utf8'));
        for (const [key, value] of Object.entries(fileEnvironment)) {
            if (preferredKeys.includes(key) || process.env[key] === undefined) process.env[key] = value;
        }
    };

    // Preserve inherited non-account settings while taking protected account
    // credentials from their designated files even when stale values are inherited.
    loadFile(path.join(rootDir, '.env'));
    loadFile(path.join(__dirname, '..', '.env.bootstrap'), [
        'DB_BOOTSTRAP_USER', 'DB_BOOTSTRAP_PASSWORD', 'DB_ADMIN_PASSWORD'
    ]);
    loadFile(path.join(__dirname, '..', '.env.migration'), [
        'DB_MIGRATION_USER', 'DB_MIGRATION_PASSWORD'
    ]);
}

const ACCOUNTS = [
    { user: 'ft_admin', envVar: 'DB_ADMIN_PASSWORD', generated: true, envFile: path.join(__dirname, '..', '.env.bootstrap') },
    { user: 'ft_member', envVar: 'DB_RUNTIME_PASSWORD', generated: true, envFile: path.join(rootDir, '.env') },
    { user: 'ft_credential', envVar: 'DB_CREDENTIAL_PASSWORD', generated: true, envFile: path.join(rootDir, '.env') },
    { user: 'ft_api_admin', envVar: 'DB_ADMIN_API_PASSWORD', generated: true, envFile: path.join(rootDir, '.env') },
    { user: 'ft_migrate', envVar: 'DB_MIGRATION_PASSWORD', generated: true, envFile: path.join(__dirname, '..', '.env.migration') },
    { user: 'ft_object_definer', locked: true }
];

function restrictCredentialFileAcl(file, execute = spawnSync, platform = process.platform) {
    if (platform !== 'win32') return;
    const safePath = file.replace(/'/g, "''");
    const command = `$p='${safePath}'; $acl=New-Object System.Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true,$false); $ids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); foreach($id in $ids){$sid=New-Object System.Security.Principal.SecurityIdentifier($id); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl; 'OK'`;
    const result = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0 || result.stdout.trim() !== 'OK') {
        throw new Error('Could not apply the required credential-file ACL.');
    }
}

function storeGeneratedPassword(file, name, value, fileSystem = fs, acl = {}) {
    const validateAcl = acl.validate || assertCredentialFileProtected;
    const restrictAcl = acl.restrict || restrictCredentialFileAcl;
    if (!fileSystem.existsSync(file)) throw new Error('Protected credential file is missing.');
    validateAcl(file);
    const source = fileSystem.readFileSync(file, 'utf8');
    const line = `${name}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    const updated = pattern.test(source)
        ? source.replace(pattern, line)
        : `${source.replace(/\s*$/, '')}\n${line}\n`;
    const temporaryFile = `${file}.${process.pid}.tmp`;
    try {
        fileSystem.writeFileSync(temporaryFile, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        restrictAcl(temporaryFile);
        validateAcl(temporaryFile);
        fileSystem.writeFileSync(temporaryFile, updated, { encoding: 'utf8', flag: 'w', mode: 0o600 });
        fileSystem.renameSync(temporaryFile, file);
    } catch (error) {
        try { fileSystem.rmSync(temporaryFile, { force: true }); } catch { /* preserve original write error */ }
        throw error;
    }
    try {
        validateAcl(file);
    } catch {
        throw new Error('Final credential-file ACL verification failed after atomic replacement. Treat the credential file as unsafe and follow the protected recovery procedure.');
    }
}

function extractGeneratedPassword(rows) {
    const password = rows?.[0]?.['generated password'];
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('MySQL did not return its generated password result column.');
    }
    return password;
}

function recoveryInstructions(user) {
    return `Account ${user}@localhost was created, but its credential was not persisted. Stop provisioning and do not retry account creation. Recover it only through the protected bootstrap DBA workflow: rotate this account with ALTER USER ... IDENTIFIED BY RANDOM PASSWORD, capture MySQL's generated password in memory, write it to its protected environment file without displaying it, then verify authentication without printing the credential. Do not use an interactive mysql command that displays the generated-password result.`;
}

async function createAccountWithGeneratedPassword(conn, account, persist = storeGeneratedPassword) {
    const who = `'${account.user}'@'localhost'`;
    let generatedRows;
    try {
        [generatedRows] = await conn.query(`CREATE USER ${who} IDENTIFIED BY RANDOM PASSWORD`);
    } catch (error) {
        const safeCode = typeof error.code === 'string' ? ` (${error.code})` : '';
        throw new Error(`Could not confirm creation of MySQL account ${account.user}@localhost${safeCode}. Check whether it exists using the protected bootstrap workflow; do not retry blindly. If it exists without a saved credential, follow database/security/ACCOUNT_RECOVERY.md.`);
    }

    let password;
    try {
        password = extractGeneratedPassword(generatedRows);
        persist(account.envFile, account.envVar, password);
    } catch {
        throw new Error(recoveryInstructions(account.user));
    }
    process.env[account.envVar] = password;
    console.log(`[db] created account ${account.user}`);
}

function assertCredentialFileProtected(file, execute = spawnSync, platform = process.platform) {
    if (platform !== 'win32') return;
    const safePath = file.replace(/'/g, "''");
    const check = `$ErrorActionPreference='Stop'; $stage='module'; try { $securityModule=Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'; Import-Module -Name $securityModule -ErrorAction Stop | Out-Null; $stage='acl'; $acl=Get-Acl -LiteralPath '${safePath}'; $allowed=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); $ids=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique); if ($acl.AreAccessRulesProtected -and $ids.Count -gt 0 -and @($ids | Where-Object { $_ -notin $allowed }).Count -eq 0) { 'ACL_CHECK_OK' } else { 'ACL_CHECK_MISMATCH' } } catch { if ($stage -eq 'module') { 'ACL_CHECK_ERROR:MODULE' } else { 'ACL_CHECK_ERROR:GET_ACL' }; exit 2 }`;
    const result = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error) throw new Error('Could not start PowerShell to inspect the credential-file ACL.');
    const output = (result.stdout || '').trim();
    if (output === 'ACL_CHECK_ERROR:MODULE') throw new Error('Could not load Microsoft.PowerShell.Security to inspect the credential-file ACL.');
    if (output === 'ACL_CHECK_ERROR:GET_ACL' || result.status !== 0) throw new Error('Could not inspect credential-file ACL metadata with Get-Acl.');
    if (output === 'ACL_CHECK_MISMATCH') throw new Error('Credential file ACL must be restricted to the current user, SYSTEM, and local Administrators.');
    if (output !== 'ACL_CHECK_OK') throw new Error('The credential-file ACL check returned an unexpected result.');
}

async function createDbAccounts(conn, { createCoreRoles = false } = {}) {
    const names = ACCOUNTS.map(({ user }) => user);
    const [existingRows] = await conn.query(
        `SELECT User, Host, account_locked FROM mysql.user WHERE User IN (${names.map(() => '?').join(', ')})`,
        names
    );
    const existing = new Map(existingRows.filter(({ Host }) => Host === 'localhost').map((row) => [row.User, row]));

    // Refuse a partial/re-run state that cannot authenticate; never rotate an existing password.
    for (const acc of ACCOUNTS) {
        if (acc.locked && existing.has(acc.user) && existing.get(acc.user).account_locked !== 'Y') {
            throw new Error(`${acc.user}@localhost exists but is not locked; refusing to alter it.`);
        }
        if (existing.has(acc.user) && acc.generated && !process.env[acc.envVar]) {
            throw new Error(`${acc.user}@localhost exists but its local credential is missing; refusing to reset it.`);
        }
        if (!existing.has(acc.user) && acc.generated && (!acc.envFile || !fs.existsSync(acc.envFile))) {
            throw new Error(`Protected credential file is required before provisioning ${acc.user}.`);
        }
        if (acc.generated && fs.existsSync(acc.envFile)) assertCredentialFileProtected(acc.envFile);
    }

    if (createCoreRoles) await runSqlFile(conn, path.join(__dirname, 'roles.sql'));
    for (const acc of ACCOUNTS) {
        const who = `'${acc.user}'@'localhost'`;
        if (existing.has(acc.user)) {
            console.log(`[db] preserving existing account ${acc.user} and its password`);
            continue;
        }
        if (acc.locked) {
            await conn.query(`CREATE USER ${who} ACCOUNT LOCK`);
            console.log(`[db] created locked stored-object definer ${acc.user}`);
            continue;
        }
        await createAccountWithGeneratedPassword(conn, acc);
    }

    await runSqlFile(conn, path.join(__dirname, 'privilege_separation.sql'));
}

module.exports = {
    assertCredentialFileProtected,
    createDbAccounts,
    createAccountWithGeneratedPassword,
    extractGeneratedPassword,
    loadProvisioningEnvironment,
    restrictCredentialFileAcl,
    recoveryInstructions,
    storeGeneratedPassword
};

if (require.main === module) {
    (async () => {
        loadProvisioningEnvironment();
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_BOOTSTRAP_USER,
            password: process.env.DB_BOOTSTRAP_PASSWORD,
            database: process.env.DB_NAME || 'fittrack_db',
            multipleStatements: false
        });
        try {
            await createDbAccounts(conn);
            console.log('Database account and role grants are ready.');
        } catch (e) {
            console.error('Could not create accounts:', e.message);
            process.exitCode = 1;
        } finally {
            await conn.end();
        }
    })();
}
