const { test } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/mysql');
const controller = require('../src/controllers/workoutController');
const authMiddleware = require('../src/middleware/auth');

const invoke = async (handler, { params = {}, body = {}, query = {}, user = { id: 7 } } = {}) => {
    const res = {
        statusCode: 200,
        payload: undefined,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.payload = value; return this; }
    };
    await handler({ params, body, query, user }, res);
    return res;
};

const withQueries = async (fn) => {
    const original = pool.query;
    try { await fn((implementation) => { pool.query = implementation; }); }
    finally { pool.query = original; }
};

test('valid set is inserted and returned with exercise details', async () => withQueries(async (mock) => {
    const calls = [];
    mock(async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('FROM workout_sessions')) return [[{ id: 12, plan_id: 3 }]];
        if (sql.includes('FROM exercises')) return [[{ id: 4 }]];
        if (sql.includes('FROM plan_exercises')) return [[{ 1: 1 }]];
        if (sql.includes('INSERT INTO workout_sets')) return [{ insertId: 44 }];
        return [[{ id: 44, session_id: 12, exercise_id: 4, exercise_name: 'Squat', set_number: 1, reps: 10, weight: '20.00', completed: 1 }]];
    });
    const res = await invoke(controller.createSet, { params: { id: '12' }, body: { exercise_id: 4, set_number: 1, reps: 10, weight: 20, completed: true } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.id, 44);
    assert.equal(res.payload.exercise_name, 'Squat');
    assert.match(calls.find((c) => c.sql.includes('INSERT INTO workout_sets')).sql, /VALUES \(\?, \?, \?, \?, \?, \?\)/);
}));

test('set endpoint rejects invalid values before querying the database', async () => withQueries(async (mock) => {
    mock(() => { throw new Error('should not query'); });
    for (const [field, value] of [['exercise_id', 0], ['set_number', 0], ['set_number', 1.5], ['reps', -1], ['reps', 501], ['reps', 2.5], ['weight', -0.1], ['weight', 1000], ['completed', 1]]) {
        const body = { exercise_id: 1, set_number: 1, reps: 10, weight: 20, completed: true, [field]: value };
        assert.equal((await invoke(controller.createSet, { params: { id: 2 }, body })).statusCode, 400, field);
    }
}));

test('another user cannot log a set to the session', async () => withQueries(async (mock) => {
    mock(async () => [[]]);
    const res = await invoke(controller.createSet, { params: { id: 12 }, body: { exercise_id: 4, set_number: 1, reps: 10, weight: 20, completed: true } });
    assert.equal(res.statusCode, 404);
}));

test('session creation rejects a plan owned by another user without inserting', async () => withQueries(async (mock) => {
    const sqlCalls = [];
    mock(async (sql, params) => {
        sqlCalls.push({ sql, params });
        return [[]];
    });
    const res = await invoke(controller.createSession, { body: { plan_id: 22 } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.error, 'Workout plan not found.');
    assert.equal(sqlCalls.length, 1);
    assert.match(sqlCalls[0].sql, /WHERE id = \? AND user_id = \?/);
    assert.deepEqual(sqlCalls[0].params, [22, 7]);
}));

test('session creation accepts an owned plan and stores its validated ID', async () => withQueries(async (mock) => {
    const sqlCalls = [];
    mock(async (sql, params) => {
        sqlCalls.push({ sql, params });
        if (sql.includes('FROM workout_plans')) return [[{ id: 22 }]];
        return [{ insertId: 91 }];
    });
    const res = await invoke(controller.createSession, { body: { plan_id: '22' } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(sqlCalls[1].params, [7, 22, '']);
}));

test('finished session returns conflict and is never inserted into', async () => withQueries(async (mock) => {
    let inserts = 0;
    mock(async (sql) => {
        if (sql.includes('end_time IS NULL')) return [[]];
        if (sql.includes('FROM workout_sessions')) return [[{ id: 12, end_time: '2026-01-01' }]];
        if (sql.includes('INSERT')) inserts += 1;
        return [[]];
    });
    const res = await invoke(controller.createSet, { params: { id: 12 }, body: { exercise_id: 4, set_number: 1, reps: 10, weight: 20, completed: true } });
    assert.equal(res.statusCode, 409);
    assert.equal(inserts, 0);
}));

test('unknown exercise and exercise outside plan are rejected', async () => withQueries(async (mock) => {
    mock(async (sql) => {
        if (sql.includes('FROM workout_sessions')) return [[{ id: 12, plan_id: 3 }]];
        if (sql.includes('FROM exercises')) return [[]];
        return [[]];
    });
    assert.equal((await invoke(controller.createSet, { params: { id: 12 }, body: { exercise_id: 99, set_number: 1, reps: 10, weight: 20, completed: true } })).statusCode, 404);
    mock(async (sql) => {
        if (sql.includes('FROM workout_sessions')) return [[{ id: 12, plan_id: 3 }]];
        if (sql.includes('FROM exercises')) return [[{ id: 4 }]];
        return [[]];
    });
    assert.equal((await invoke(controller.createSet, { params: { id: 12 }, body: { exercise_id: 4, set_number: 1, reps: 10, weight: 20, completed: true } })).statusCode, 400);
}));

test('duplicate set number returns HTTP 409', async () => withQueries(async (mock) => {
    mock(async (sql) => {
        if (sql.includes('FROM workout_sessions')) return [[{ id: 12, plan_id: null }]];
        if (sql.includes('FROM exercises')) return [[{ id: 4 }]];
        const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error;
    });
    const res = await invoke(controller.createSet, { params: { id: 12 }, body: { exercise_id: 4, set_number: 1, reps: 10, weight: 20, completed: true } });
    assert.equal(res.statusCode, 409);
}));

test('workout routes require authentication', () => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
    let continued = false;
    authMiddleware({ headers: {} }, res, () => { continued = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(continued, false);
});

test('session detail returns logged sets and history returns completed set counts', async () => withQueries(async (mock) => {
    let call = 0;
    mock(async () => {
        call += 1;
        if (call === 1) return [[{ id: 12, plan_id: null, end_time: null, duration_minutes: null }]];
        if (call === 2) return [[{ id: 44, exercise_id: 4, exercise_name: 'Squat', set_number: 1, reps: 10, weight: '20.00', completed: 1 }]];
        return [[{ id: 12, exercises_completed: 1, sets_completed: 1 }]];
    });
    const detail = await invoke(controller.getSession, { params: { id: 12 } });
    assert.equal(detail.payload.sets.length, 1);
    const history = await invoke(controller.getSessions);
    assert.equal(Number(history.payload[0].exercises_completed), 1);
    assert.equal(Number(history.payload[0].sets_completed), 1);
}));
