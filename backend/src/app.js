const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { respondWithServerError } = require('./utils/respondWithServerError');

// Secrets come only from .env - refuse to start without them
for (const name of [
    'JWT_SECRET',
    'DB_RUNTIME_USER', 'DB_RUNTIME_PASSWORD',
    'DB_CREDENTIAL_USER', 'DB_CREDENTIAL_PASSWORD',
    'DB_ADMIN_API_USER', 'DB_ADMIN_API_PASSWORD'
]) {
    if (!process.env[name]) {
        console.error(`[config] ${name} is not set. Copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
}

const mysqlPool = require('./config/mysql');
const memuraiClient = require('./config/memurai');

const app = express();

// Local development origins are allowed by default. Set CORS_ORIGINS to a
// comma-separated allowlist for the intended frontend origins in deployment.
const corsOrigins = (process.env.CORS_ORIGINS === undefined
    ? 'http://localhost:3000,http://127.0.0.1:3000'
    : process.env.CORS_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Middleware
app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || corsOrigins.includes(origin));
    }
}));
app.use(express.json());

// Routes
const authRoutes = require('./routes/authRoutes');
const workoutRoutes = require('./routes/workoutRoutes');
const journalRoutes = require('./routes/journalRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const goalRoutes = require('./routes/goalRoutes');
const activityRoutes = require('./routes/activityRoutes');
const photoRoutes = require('./routes/photoRoutes');
const adminRoutes = require('./routes/adminRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/workouts', workoutRoutes);
app.use('/api/journals', journalRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/admin', adminRoutes);

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
    try {
        // Check MySQL
        await mysqlPool.query('SELECT 1');
        
        // Check Memurai
        await memuraiClient.ping();

        res.json({ 
            status: 'ok', 
            mysql: 'connected', 
            memurai: 'connected' 
        });
    } catch (error) {
        respondWithServerError(res, error, 'health check', {
            status: 'error', 
            message: 'A required service is temporarily unavailable.'
        });
    }
});

// Express 5 forwards rejected route promises and body-parser errors here.
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    if (error?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body is too large.' });
    }
    return respondWithServerError(res, error, 'unhandled request');
});

// Port Configuration
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`FitTrack backend running on port ${PORT}`);
});
