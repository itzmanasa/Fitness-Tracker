// Controlled integration smoke check for the ft_redis_member account.
// Uses a unique synthetic user/key namespace and deletes only its own keys.
const assert = require('node:assert/strict');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

if (!process.env.REDIS_MEMBER_PASSWORD) {
    throw new Error('REDIS_MEMBER_PASSWORD is required');
}

const redisClient = require('../src/config/memurai');
const mysqlPool = require('../src/config/mysql');
const journals = require('../src/controllers/journalController');
const photos = require('../src/controllers/photoController');
const dashboard = require('../src/controllers/dashboardController');
const activity = require('../src/controllers/activityController');
const { scanKeys } = require('../src/config/scanKeys');

const response = () => ({
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});

const invoke = async (handler, req) => {
    const res = response();
    await handler(req, res);
    assert.ok(res.statusCode < 400, `${handler.name || 'operation'} returned HTTP ${res.statusCode}`);
    return res.body;
};

async function main() {
    const userId = `acl-audit-${Date.now()}`;
    const today = new Date().toISOString().split('T')[0];
    const sensorKey = `fittrack:sensors:${userId}`;
    const dailyKey = `fittrack:activity:daily:${userId}:${today}`;
    const cleanupKeys = [sensorKey, dailyKey];
    const req = { user: { id: userId }, body: {}, params: {}, query: {} };

    try {
        assert.equal(await redisClient.ping(), 'PONG');
        console.log('Redis health PING: passed');

        const journal = await invoke(journals.createJournal, {
            ...req, body: { title: 'ACL smoke test', notes: 'temporary', mood: 'neutral', tags: [] }
        });
        const journalKey = `fittrack:journal:${userId}:${journal.id}`;
        cleanupKeys.push(journalKey);
        const journalList = await invoke(journals.getJournals, req);
        assert.ok(journalList.some((item) => item.id === journal.id));
        await invoke(journals.updateJournal, { ...req, params: { id: journal.id }, body: { notes: 'updated' } });
        await invoke(journals.deleteJournal, { ...req, params: { id: journal.id } });
        console.log('Journal create/list/update/delete: passed');

        const photo = await invoke(photos.createPhoto, {
            ...req, body: { caption: 'ACL smoke test', date: today, tags: [], image_url: null }
        });
        const photoKey = `fittrack:photos:${userId}:${photo.id}`;
        cleanupKeys.push(photoKey);
        const photoList = await invoke(photos.getPhotos, req);
        assert.ok(photoList.some((item) => item.id === photo.id));
        await invoke(photos.deletePhoto, { ...req, params: { id: photo.id } });
        console.log('Photo metadata create/list/delete: passed');

        const timestamp = new Date().toISOString();
        await redisClient.xAdd(sensorKey, '*', {
            timestamp, heart_rate: '88', step_increment: '7', calories_burned: '1.5', activity_state: 'walking'
        });
        await redisClient.hIncrBy(dailyKey, 'total_steps', 7);
        await redisClient.hIncrByFloat(dailyKey, 'total_calories', 1.5);
        await redisClient.hIncrBy(dailyKey, 'reading_counts', 1);
        const stream = await redisClient.xRevRange(sensorKey, '+', '-', { COUNT: 1 });
        const totals = await redisClient.hGetAll(dailyKey);
        assert.equal(stream.length, 1);
        assert.equal(totals.total_steps, '7');
        console.log('Simulator stream/hash write and read commands: passed');

        const originalQuery = mysqlPool.query;
        mysqlPool.query = async (sql) => sql.includes('FROM fitness_goals') ? [[]] : [[{ total: 0 }]];
        try {
            const dashboardData = await invoke(dashboard.getDashboardData, req);
            assert.equal(dashboardData.latestSensor.heart_rate, '88');
            assert.equal(dashboardData.dailyActivity.total_steps, '7');
        } finally {
            mysqlPool.query = originalQuery;
        }
        const status = await invoke(activity.getStatus, req);
        const readings = await invoke(activity.getReadings, { ...req, query: { range: '1h' } });
        const daily = await invoke(activity.getDaily, { ...req, query: { days: '1' } });
        assert.equal(status.status, 'connected');
        assert.equal(readings.summary.readings, 1);
        assert.equal(daily[0].total_steps, 7);
        console.log('Dashboard, activity status, analytics readings and daily totals: passed');
    } finally {
        try { await redisClient.del(cleanupKeys); }
        catch { console.error('Targeted cleanup failed for the isolated ACL smoke-test keys'); }
        try {
            const leftovers = await scanKeys(`fittrack:*:${userId}*`);
            assert.equal(leftovers.length, 0, 'isolated test keys remain after cleanup');
            console.log('Targeted test-key cleanup: passed');
        } catch {
            console.error('Could not verify targeted cleanup of isolated ACL smoke-test keys');
            process.exitCode = 1;
        }
        redisClient.destroy();
    }
}

main().catch((error) => {
    const safeMessage = String(error.message || error).replaceAll(process.env.REDIS_MEMBER_PASSWORD || '', '[redacted]');
    console.error('Redis ACL smoke test failed:', safeMessage);
    process.exitCode = 1;
});
