// Explicit, approval-gated rotation for the bootstrap and manual-admin credentials.
// Usage: node database/security/rotate_bootstrap_credentials.js [--dry-run]
// This file never prints credential contents or MySQL result rows.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const {
    assertCredentialFileProtected,
    extractGeneratedPassword,
    storeGeneratedPassword
} = require('./create_db_accounts');

const databaseDir = path.join(__dirname, '..');
const bootstrapFile = path.join(databaseDir, '.env.bootstrap');
const pendingFile = path.join(databaseDir, '.bootstrap-rotation.pending');
const BOOTSTRAP_CREDENTIAL_KEYS = [
    'DB_BOOTSTRAP_USER',
    'DB_BOOTSTRAP_PASSWORD',
    'DB_ADMIN_PASSWORD'
];

function loadRotationEnvironment(bootstrapContents, inheritedEnv = process.env) {
    const bootstrapEnv = dotenv.parse(bootstrapContents);
    const env = { ...inheritedEnv };
    for (const key of BOOTSTRAP_CREDENTIAL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(bootstrapEnv, key)) env[key] = bootstrapEnv[key];
        else delete env[key];
    }
    return env;
}

function getRotationTargets(env, credentialFile) {
    const bootstrapUser = env.DB_BOOTSTRAP_USER;
    if (!bootstrapUser || !/^[A-Za-z0-9_.-]+$/.test(bootstrapUser)) {
        throw new Error('DB_BOOTSTRAP_USER is missing or invalid in the protected bootstrap configuration.');
    }
    if (!env.DB_BOOTSTRAP_PASSWORD) {
        throw new Error('DB_BOOTSTRAP_PASSWORD is required in the protected bootstrap configuration.');
    }
    if (!env.DB_ADMIN_PASSWORD) {
        throw new Error('DB_ADMIN_PASSWORD is required in the protected bootstrap configuration for ft_admin.');
    }
    if (bootstrapUser === 'ft_admin') {
        throw new Error('The bootstrap and ft_admin credentials resolve to the same account; refusing ambiguous rotation.');
    }
    return [
        { user: 'ft_admin', host: 'localhost', envVar: 'DB_ADMIN_PASSWORD', file: credentialFile },
        { user: bootstrapUser, host: 'localhost', envVar: 'DB_BOOTSTRAP_PASSWORD', file: credentialFile }
    ];
}

function safeAccount(target) {
    return `'${target.user}'@'${target.host}'`;
}

function errorCode(error) {
    return typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
}

function safeFailure(message) {
    const failure = new Error(message);
    failure.safeDiagnostic = true;
    return failure;
}

function operationFailure(message, error) {
    return safeFailure(`${message} (${errorCode(error)}).`);
}

function createPendingMarker(file, targets) {
    const content = JSON.stringify({
        status: 'rotation-in-progress',
        accounts: targets.map(({ user, host }) => `${user}@${host}`),
        started_at: new Date().toISOString()
    }, null, 2);
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function verifyCredential(mysqlClient, config, accountName, phase = 'authentication preflight') {
    let verificationConnection;
    try {
        verificationConnection = await mysqlClient.createConnection(config);
    } catch (error) {
        throw safeFailure(`${phase} connection/authentication failed for ${accountName} (${errorCode(error)}).`);
    }
    try {
        await verificationConnection.query('SELECT 1');
    } catch (error) {
        throw safeFailure(`${phase} connection authenticated but SELECT 1 failed for ${accountName} (${errorCode(error)}).`);
    } finally {
        if (verificationConnection) await verificationConnection.end().catch(() => {});
    }
}

async function rotateCredentials({
    dryRun = false,
    env = process.env,
    file = bootstrapFile,
    marker = pendingFile,
    mysqlClient = mysql,
    fileSystem = fs,
    persist = storeGeneratedPassword,
    checkCredentialFile = assertCredentialFileProtected,
    createMarker = createPendingMarker,
    output = console.log
} = {}) {
    const targets = getRotationTargets(env, file);
    if (dryRun) {
        checkCredentialFile(file);
        output('Dry run: no database connection or file changes will occur.');
        targets.forEach(({ user, host, file: credentialFile }) => {
            output(`Would rotate ${user}@${host}; would update ${path.basename(credentialFile)}.`);
        });
        let pending;
        try {
            pending = fileSystem.existsSync(marker);
        } catch (error) {
            throw operationFailure('Could not inspect pending-marker state', error);
        }
        if (pending) output('A previous rotation is pending; recover it before a real run.');
        return { dryRun: true, accounts: targets.map(({ user, host }) => `${user}@${host}`) };
    }

    let markerExists;
    try {
        markerExists = fileSystem.existsSync(marker);
    } catch (error) {
        throw operationFailure('Could not inspect pending-marker state', error);
    }
    if (markerExists) {
        throw new Error('A prior bootstrap credential rotation is pending. Do not run again; follow ACCOUNT_RECOVERY.md first.');
    }
    try {
        checkCredentialFile(file);
    } catch (error) {
        const message = typeof error.message === 'string' ? error.message : '';
        const category = message.includes('Microsoft.PowerShell.Security')
            ? 'PowerShell security module load failed'
            : message.includes('Get-Acl')
                ? 'Get-Acl metadata inspection failed'
                : message.includes('ACL must be restricted')
                    ? 'ACL mismatch'
                    : 'ACL check failed';
        throw new Error(`Credential-file ACL preflight failed: ${category}.`);
    }

    let adminConnection;
    let rotationStarted = false;
    let retiringOldPasswords = false;
    const previousCredentials = new Map(targets.map((target) => [target.envVar, env[target.envVar]]));
    try {
        try {
            adminConnection = await mysqlClient.createConnection({
                host: env.DB_HOST || '127.0.0.1',
                port: env.DB_PORT || 3306,
                user: env.DB_BOOTSTRAP_USER,
                password: env.DB_BOOTSTRAP_PASSWORD,
                database: env.DB_NAME || 'fittrack_db',
                multipleStatements: false
            });
        } catch (error) {
            throw operationFailure('Bootstrap MySQL connection/authentication failed', error);
        }

        const placeholders = targets.map(() => '?').join(', ');
        let existing;
        try {
            [existing] = await adminConnection.query(
                `SELECT User, Host FROM mysql.user WHERE User IN (${placeholders}) AND Host = 'localhost'`,
                targets.map(({ user }) => user)
            );
        } catch (error) {
            throw operationFailure('MySQL account lookup failed', error);
        }
        if (!Array.isArray(existing)) {
            throw safeFailure('MySQL account lookup returned an invalid response; no password changes were attempted.');
        }
        const found = new Set(existing.map(({ User, Host }) => `${User}@${Host}`));
        const missing = targets.filter(({ user, host }) => !found.has(`${user}@${host}`));
        if (missing.length) {
            throw new Error(`Rotation stopped before password changes because these configured accounts are absent: ${missing.map(({ user, host }) => `${user}@${host}`).join(', ')}.`);
        }

        // Confirm each current configured password works before changing any account.
        for (const target of targets) {
            await verifyCredential(mysqlClient, {
                host: env.DB_HOST || '127.0.0.1',
                port: env.DB_PORT || 3306,
                user: target.user,
                password: env[target.envVar],
                database: env.DB_NAME || 'fittrack_db',
                multipleStatements: false
            }, `${target.user}@${target.host}`, `Existing credential check for ${target.user}@${target.host}`);
        }

        try {
            createMarker(marker, targets);
        } catch (error) {
            throw operationFailure('Pending-marker creation failed', error);
        }
        rotationStarted = true;

        for (const target of targets) {
            const account = safeAccount(target);
            let rows;
            try {
                [rows] = await adminConnection.query(
                    `ALTER USER ${account} IDENTIFIED BY RANDOM PASSWORD RETAIN CURRENT PASSWORD`
                );
            } catch (error) {
                const code = typeof error.code === 'string' ? ` (${error.code})` : '';
                throw safeFailure(`Could not confirm password rotation for ${target.user}@${target.host}${code}. The prior password is retained when MySQL completed the dual-password change; keep the rotation pending and follow ACCOUNT_RECOVERY.md.`);
            }

            let replacement;
            try {
                replacement = extractGeneratedPassword(rows);
            } catch (error) {
                throw safeFailure(`Generated-password result was invalid for ${target.user}@${target.host}; keep the rotation pending and follow ACCOUNT_RECOVERY.md.`);
            }
            try {
                persist(target.file, target.envVar, replacement);
            } catch (error) {
                throw safeFailure(`Credential-file persistence failed for ${target.user}@${target.host} (${errorCode(error)}); the previous password is retained as a secondary credential. Keep the rotation pending and follow ACCOUNT_RECOVERY.md.`);
            }
            env[target.envVar] = replacement;
            await verifyCredential(mysqlClient, {
                host: env.DB_HOST || '127.0.0.1',
                port: env.DB_PORT || 3306,
                user: target.user,
                password: replacement,
                database: env.DB_NAME || 'fittrack_db',
                multipleStatements: false
            }, `${target.user}@${target.host}`, `Replacement authentication check for ${target.user}@${target.host}`);
            output(`Replacement authentication verified for ${target.user}@${target.host}.`);
        }

        // Only retire rollback passwords after all replacement values are saved and verified.
        retiringOldPasswords = true;
        for (const target of targets) {
            try {
                await adminConnection.query(`ALTER USER ${safeAccount(target)} DISCARD OLD PASSWORD`);
            } catch (error) {
                throw operationFailure(`Old-password retirement failed for ${target.user}@${target.host}`, error);
            }
            await verifyCredential(mysqlClient, {
                host: env.DB_HOST || '127.0.0.1',
                port: env.DB_PORT || 3306,
                user: target.user,
                password: env[target.envVar],
                database: env.DB_NAME || 'fittrack_db',
                multipleStatements: false
            }, `${target.user}@${target.host}`, `Post-retirement authentication check for ${target.user}@${target.host}`);
        }

        try {
            fileSystem.rmSync(marker, { force: true });
        } catch (error) {
            throw operationFailure('Pending-marker removal failed after credential verification', error);
        }
        output('Credential rotation completed. Replacement authentication succeeded and previous secondary passwords were discarded.');
        return { dryRun: false, accounts: targets.map(({ user, host }) => `${user}@${host}`) };
    } catch (error) {
        // Never forward raw driver/filesystem errors; they may contain SQL or configuration details.
        if (!rotationStarted) {
            if (error.safeDiagnostic || error.message?.startsWith('Rotation stopped before password changes')) throw error;
            throw new Error('Pre-change rotation step failed (UNKNOWN). No credential contents were logged.');
        }
        if (!retiringOldPasswords) {
            // The old credentials remain valid as MySQL secondary passwords. Restore
            // their local file values so an operator can authenticate during recovery.
            const restoreFailures = [];
            for (const target of targets) {
                const previous = previousCredentials.get(target.envVar);
                try {
                    persist(target.file, target.envVar, previous);
                    env[target.envVar] = previous;
                } catch (error) {
                    restoreFailures.push(`${target.user}@${target.host} (${errorCode(error)})`);
                }
            }
            if (restoreFailures.length) {
                const cause = error.safeDiagnostic ? `${error.message} ` : '';
                throw new Error(`${cause}Local credential restoration failed for: ${restoreFailures.join(', ')}. The recovery marker remains. Use the protected recovery workflow; do not rerun or remove the marker.`);
            }
        }
        const cause = error.safeDiagnostic ? `${error.message} ` : 'Rotation stopped during a pre-retirement operation. ';
        throw new Error(`${cause}Original local credential values were restored; the recovery marker remains. Do not rerun or remove the marker until the affected accounts have been reviewed using the protected bootstrap recovery workflow and ACCOUNT_RECOVERY.md.`);
    } finally {
        if (adminConnection) await adminConnection.end().catch(() => {});
    }
}

async function main(args) {
    if (args.some((arg) => arg !== '--dry-run') || args.filter((arg) => arg === '--dry-run').length > 1) {
        throw new Error('Usage: node database/security/rotate_bootstrap_credentials.js [--dry-run]');
    }
    const bootstrapContents = fs.readFileSync(bootstrapFile, 'utf8');
    const env = loadRotationEnvironment(bootstrapContents);
    await rotateCredentials({ dryRun: args.includes('--dry-run'), env });
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { getRotationTargets, loadRotationEnvironment, rotateCredentials };
