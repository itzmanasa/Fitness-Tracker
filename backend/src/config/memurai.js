const redis = require('redis');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

if (!process.env.REDIS_MEMBER_PASSWORD) {
    throw new Error('REDIS_MEMBER_PASSWORD is required for the Redis member connection');
}

const client = redis.createClient({
    username: process.env.REDIS_USERNAME || 'ft_redis_member',
    password: process.env.REDIS_MEMBER_PASSWORD,
    disableClientInfo: true,
    socket: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379
    }
});

client.on('error', (err) => console.error('Memurai Client Error', err));

// Auto-connect when this module is required
(async () => {
    try {
        await client.connect();
        console.log('Backend connected to Memurai successfully.');
    } catch (err) {
        console.error('Backend failed to connect to Memurai:', err.message);
    }
})();

module.exports = client;
