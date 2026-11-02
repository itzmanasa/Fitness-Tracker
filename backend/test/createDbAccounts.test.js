const test = require('node:test');
const assert = require('node:assert/strict');
const {
    assertCredentialFileProtected,
    createAccountWithGeneratedPassword,
    extractGeneratedPassword,
    restrictCredentialFileAcl,
    storeGeneratedPassword
} = require('../../database/security/create_db_accounts');
const { getRotationTargets, loadRotationEnvironment, rotateCredentials } = require('../../database/security/rotate_bootstrap_credentials');

const account = {
    user: 'ft_test_account',
    envVar: 'FT_TEST_PASSWORD',
    envFile: 'mock-credentials.env'
};

const rotationEnv = () => ({
    DB_BOOTSTRAP_USER: 'root',
    DB_BOOTSTRAP_PASSWORD: 'mock-bootstrap-secret',
    DB_ADMIN_PASSWORD: 'mock-admin-secret'
});

function rotationHarness({ lookup, failedAuth = {}, marker, persist, markerStateError, aclFailure } = {}) {
    const calls = { connectionUsers: [], sql: [], marker: 0, persist: 0 };
    const adminConnection = {
        query: async (sql) => {
            calls.sql.push(sql);
            if (sql.startsWith('SELECT User, Host')) {
                if (lookup) return lookup();
                return [[
                    { User: 'ft_admin', Host: 'localhost' },
                    { User: 'root', Host: 'localhost' }
                ]];
            }
            if (sql.includes('IDENTIFIED BY RANDOM PASSWORD')) return [[{ 'generated password': 'mock-new-password' }]];
            return [[]];
        },
        end: async () => {}
    };
    const mysqlClient = {
        createConnection: async (config) => {
            calls.connectionUsers.push(config.user);
            if (calls.connectionUsers.length === 1 && config.user === 'root' && config.password === rotationEnv().DB_BOOTSTRAP_PASSWORD) return adminConnection;
            if (failedAuth[config.user]) throw Object.assign(new Error('mock secret must not escape'), { code: failedAuth[config.user] });
            return { query: async () => [[{ ok: 1 }]], end: async () => {} };
        }
    };
    const runMarker = () => {
        calls.marker += 1;
        if (marker) marker();
    };
    const store = (file, name, value) => {
        calls.persist += 1;
        if (persist) return persist(file, name, value, calls.persist);
    };
    const options = {
        env: rotationEnv(),
        file: 'mock-bootstrap.env',
        marker: 'mock-pending',
        fileSystem: {
            existsSync: () => {
                if (markerStateError) throw markerStateError;
                return false;
            },
            rmSync: () => {}
        },
        mysqlClient,
        checkCredentialFile: () => { if (aclFailure) throw aclFailure; },
        createMarker: runMarker,
        persist: store,
        output: () => {}
    };
    return { calls, options };
}

test('extracts the exact MySQL generated password result column', () => {
    assert.equal(extractGeneratedPassword([{ 'generated password': 'mock-generated-secret' }]), 'mock-generated-secret');
    assert.throws(() => extractGeneratedPassword([{ generated_password: 'wrong-column' }]), /result column/);
});

test('fails safely when account creation fails and does not persist a credential', async () => {
    let persistCalls = 0;
    const conn = {
        query: async () => { throw Object.assign(new Error('sensitive driver detail'), { code: 'ER_SPECIFIC' }); }
    };

    await assert.rejects(
        createAccountWithGeneratedPassword(conn, account, () => { persistCalls += 1; }),
        (error) => error.message.includes('ft_test_account@localhost') &&
            error.message.includes('ER_SPECIFIC') &&
            error.message.includes('do not retry blindly') &&
            !error.message.includes('sensitive driver detail') &&
            !error.message.includes('mock-generated-secret')
    );
    assert.equal(persistCalls, 0);
});

test('reports a safe recovery procedure if generated credential persistence fails', async () => {
    const conn = { query: async () => [[{ 'generated password': 'mock-generated-secret' }]] };
    await assert.rejects(
        createAccountWithGeneratedPassword(conn, account, () => { throw new Error('disk detail'); }),
        (error) => error.message.includes('ft_test_account@localhost') &&
            error.message.includes('Stop provisioning') &&
            error.message.includes('ALTER USER ... IDENTIFIED BY RANDOM PASSWORD') &&
            !error.message.includes('mock-generated-secret') &&
            !error.message.includes('disk detail')
    );
});

test('persists generated credentials atomically using only mocked filesystem operations', () => {
    const files = new Map([['mock-credentials.env', 'OTHER_VALUE=unchanged\n']]);
    const mockFs = {
        existsSync: (file) => files.has(file),
        readFileSync: (file) => files.get(file),
        writeFileSync: (file, content) => files.set(file, content),
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        rmSync: (file) => files.delete(file)
    };

    storeGeneratedPassword('mock-credentials.env', 'FT_TEST_PASSWORD', 'mock-generated-secret', mockFs, {
        validate: () => {},
        restrict: () => {}
    });
    assert.match(files.get('mock-credentials.env'), /^OTHER_VALUE=unchanged\nFT_TEST_PASSWORD="mock-generated-secret"\n$/);
    assert.equal([...files.keys()].some((file) => file.endsWith('.tmp')), false);
});

test('verifies the final credential file ACL after the atomic rename', () => {
    const files = new Map([['mock-credentials.env', 'EXISTING=value\n']]);
    const validated = [];
    const mockFs = {
        existsSync: (file) => files.has(file),
        readFileSync: (file) => files.get(file),
        writeFileSync: (file, content) => files.set(file, content),
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        rmSync: (file) => files.delete(file)
    };

    assert.throws(() => storeGeneratedPassword(
        'mock-credentials.env', 'FT_TEST_PASSWORD', 'mock-generated-secret', mockFs,
        {
            validate: (file) => {
                validated.push(file);
                if (file === 'mock-credentials.env' && validated.length === 3) {
                    throw new Error('sensitive ACL diagnostic');
                }
            },
            restrict: () => {}
        }
    ), (error) => error.message.includes('Final credential-file ACL verification failed') &&
        !error.message.includes('sensitive ACL diagnostic') &&
        !error.message.includes('mock-generated-secret'));
    assert.equal(validated[0], 'mock-credentials.env');
    assert.match(validated[1], /^mock-credentials\.env\.\d+\.tmp$/);
    assert.equal(validated[2], 'mock-credentials.env');
    assert.equal([...files.keys()].some((file) => file.endsWith('.tmp')), false);
});

test('bootstrap credential file values override stale inherited variables without changing unrelated environment', () => {
    const inherited = {
        DB_BOOTSTRAP_USER: 'stale-user',
        DB_BOOTSTRAP_PASSWORD: 'stale-bootstrap-secret',
        DB_ADMIN_PASSWORD: 'stale-admin-secret',
        DB_HOST: 'inherited-host',
        OTHER_SETTING: 'keep-me'
    };
    const env = loadRotationEnvironment(
        'DB_BOOTSTRAP_USER=root\nDB_BOOTSTRAP_PASSWORD=file-bootstrap-secret\nDB_ADMIN_PASSWORD=file-admin-secret\n',
        inherited
    );

    assert.equal(env.DB_BOOTSTRAP_USER, 'root');
    assert.equal(env.DB_BOOTSTRAP_PASSWORD, 'file-bootstrap-secret');
    assert.equal(env.DB_ADMIN_PASSWORD, 'file-admin-secret');
    assert.equal(env.DB_HOST, 'inherited-host');
    assert.equal(env.OTHER_SETTING, 'keep-me');
    assert.equal(inherited.DB_BOOTSTRAP_USER, 'stale-user');
});

test('rotation dry run lists configured accounts without database or filesystem mutation', async () => {
    const env = {
        DB_BOOTSTRAP_USER: 'root',
        DB_BOOTSTRAP_PASSWORD: 'mock-bootstrap-secret',
        DB_ADMIN_PASSWORD: 'mock-admin-secret'
    };
    const targets = getRotationTargets(env, 'mock-bootstrap.env');
    assert.deepEqual(targets.map(({ user, host }) => `${user}@${host}`), ['ft_admin@localhost', 'root@localhost']);

    let connectionCalls = 0;
    const output = [];
    const result = await rotateCredentials({
        dryRun: true,
        env,
        file: 'mock-bootstrap.env',
        marker: 'mock-pending',
        mysqlClient: { createConnection: async () => { connectionCalls += 1; } },
        fileSystem: { existsSync: () => false },
        checkCredentialFile: () => {},
        output: (line) => output.push(line)
    });
    assert.equal(result.dryRun, true);
    assert.equal(connectionCalls, 0);
    assert.match(output.join('\n'), /ft_admin@localhost/);
    assert.match(output.join('\n'), /root@localhost/);
    assert.doesNotMatch(output.join('\n'), /mock-(bootstrap|admin)-secret/);
});

test('ACL checker distinguishes PowerShell module-load and Get-Acl failures from ACL mismatches', () => {
    assert.throws(
        () => assertCredentialFileProtected('mock-credentials.env', () => ({ status: 2, stdout: 'ACL_CHECK_ERROR:MODULE' }), 'win32'),
        /Could not load Microsoft\.PowerShell\.Security/
    );
    assert.throws(
        () => assertCredentialFileProtected('mock-credentials.env', () => ({ status: 2, stdout: 'ACL_CHECK_ERROR:GET_ACL' }), 'win32'),
        /Could not inspect credential-file ACL metadata with Get-Acl/
    );
    assert.throws(
        () => assertCredentialFileProtected('mock-credentials.env', () => ({ status: 0, stdout: 'ACL_CHECK_MISMATCH' }), 'win32'),
        /Credential file ACL must be restricted/
    );
});

test('credential ACL command passes Set-Acl path and ACL as separate parameters', () => {
    let powershellCommand;
    restrictCredentialFileAcl('mock-credentials.env', (_exe, args, options) => {
        assert.equal(args[0], '-NoProfile');
        assert.equal(args[1], '-NonInteractive');
        assert.equal(args[2], '-Command');
        assert.equal(options.windowsHide, true);
        powershellCommand = args[3];
        return { status: 0, stdout: 'OK' };
    }, 'win32');

    assert.match(powershellCommand, /Set-Acl -LiteralPath \$p -AclObject \$acl/);
    assert.doesNotMatch(powershellCommand, /Set-Acl -LiteralPath \$p-AclObject \$acl/);
});

test('rotation diagnostics identify bootstrap connection failures without exposing driver messages', async () => {
    const h = rotationHarness();
    h.options.mysqlClient.createConnection = async () => {
        throw Object.assign(new Error('secret-containing driver message'), { code: 'ECONNREFUSED' });
    };
    await assert.rejects(rotateCredentials(h.options), (error) =>
        error.message.includes('Bootstrap MySQL connection/authentication failed (ECONNREFUSED)') &&
        !error.message.includes('secret-containing driver message')
    );
    assert.equal(h.calls.marker, 0);
    assert.equal(h.calls.sql.length, 0);
});

test('rotation diagnostics distinguish pending-marker inspection and ACL preflight failures', async () => {
    const markerInspection = rotationHarness({ markerStateError: Object.assign(new Error('sensitive path'), { code: 'EACCES' }) });
    await assert.rejects(rotateCredentials(markerInspection.options), (error) =>
        error.message.includes('Could not inspect pending-marker state (EACCES)') &&
        !error.message.includes('sensitive path')
    );
    assert.equal(markerInspection.calls.connectionUsers.length, 0);

    const acl = rotationHarness({ aclFailure: new Error('Could not load Microsoft.PowerShell.Security to inspect the credential-file ACL.') });
    await assert.rejects(rotateCredentials(acl.options), /Credential-file ACL preflight failed: PowerShell security module load failed/);
    assert.equal(acl.calls.connectionUsers.length, 0);
});

test('rotation diagnostics distinguish account lookup failures', async () => {
    const h = rotationHarness({ lookup: async () => { throw Object.assign(new Error('sensitive SQL detail'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }); } });
    await assert.rejects(rotateCredentials(h.options), (error) =>
        error.message.includes('MySQL account lookup failed (ER_TABLEACCESS_DENIED_ERROR)') &&
        !error.message.includes('sensitive SQL detail')
    );
    assert.equal(h.calls.marker, 0);
});

test('rotation diagnostics identify configured accounts missing from MySQL metadata', async () => {
    const h = rotationHarness({ lookup: async () => [[{ User: 'ft_admin', Host: 'localhost' }]] });
    await assert.rejects(rotateCredentials(h.options), /Rotation stopped before password changes because these configured accounts are absent: root@localhost/);
    assert.equal(h.calls.marker, 0);
    assert.equal(h.calls.connectionUsers.length, 1);
});

test('rotation diagnostics identify which existing credential authentication failed', async () => {
    const adminFailure = rotationHarness({ failedAuth: { ft_admin: 'ER_ACCESS_DENIED_ERROR' } });
    await assert.rejects(rotateCredentials(adminFailure.options), /Existing credential check for ft_admin@localhost connection\/authentication failed for ft_admin@localhost \(ER_ACCESS_DENIED_ERROR\)/);
    assert.equal(adminFailure.calls.marker, 0);
    assert.equal(adminFailure.calls.connectionUsers.includes('root'), true);

    const bootstrapFailure = rotationHarness({ failedAuth: { root: 'ER_ACCESS_DENIED_ERROR' } });
    await assert.rejects(rotateCredentials(bootstrapFailure.options), /Existing credential check for root@localhost connection\/authentication failed for root@localhost \(ER_ACCESS_DENIED_ERROR\)/);
    assert.equal(bootstrapFailure.calls.marker, 0);
});

test('rotation diagnostics distinguish authentication from post-authentication probe failures', async () => {
    const h = rotationHarness();
    const originalCreateConnection = h.options.mysqlClient.createConnection;
    h.options.mysqlClient.createConnection = async (config) => {
        if (config.user === 'ft_admin') {
            return {
                query: async () => { throw Object.assign(new Error('sensitive query error'), { code: 'ER_SPECIFIC' }); },
                end: async () => {}
            };
        }
        return originalCreateConnection(config);
    };
    await assert.rejects(rotateCredentials(h.options), (error) =>
        error.message.includes('Existing credential check for ft_admin@localhost connection authenticated but SELECT 1 failed') &&
        error.message.includes('(ER_SPECIFIC)') &&
        !error.message.includes('sensitive query error')
    );
    assert.equal(h.calls.marker, 0);
});

test('rotation diagnostics distinguish pending-marker creation failures', async () => {
    const h = rotationHarness({ marker: () => { throw Object.assign(new Error('sensitive path detail'), { code: 'EACCES' }); } });
    await assert.rejects(rotateCredentials(h.options), (error) =>
        error.message.includes('Pending-marker creation failed (EACCES)') &&
        !error.message.includes('sensitive path detail')
    );
    assert.equal(h.calls.sql.some((sql) => sql.startsWith('ALTER USER')), false);
    assert.equal(h.calls.persist, 0);
});

test('rotation diagnostics identify credential-file persistence errors and preserve rollback attempts', async () => {
    const h = rotationHarness({
        persist: (_file, _name, _value, attempt) => {
            if (attempt === 1) throw Object.assign(new Error('sensitive filesystem detail'), { code: 'EIO' });
        }
    });
    await assert.rejects(rotateCredentials(h.options), (error) =>
        error.message.includes('Credential-file persistence failed for ft_admin@localhost (EIO)') &&
        error.message.includes('Original local credential values were restored') &&
        !error.message.includes('sensitive filesystem detail') &&
        !error.message.includes('mock-new-password')
    );
    assert.equal(h.calls.marker, 1);
    assert.equal(h.calls.sql.some((sql) => sql.includes('DISCARD OLD PASSWORD')), false);
    assert.equal(h.calls.persist, 3);
});
