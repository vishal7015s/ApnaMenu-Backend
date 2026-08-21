// ====================================
// ApnaMenu Backend — Entry Point
// ====================================

const express = require('express');
const http = require('http');
const path = require('path');
const compression = require('compression');
const pinoHttp = require('pino-http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

dotenv.config();

const connectDB = require('./config/db');
const logger = require('./utils/logger');
const { initSentry } = require('./utils/sentry');
const { initRedis, isRedisReady, getRedisClient, duplicateClient } = require('./config/redis');
const { apiRateLimiter, webhookRateLimiter } = require('./middleware/rateLimiter');
const { initializeSocket } = require('./services/socket.service');
const { startRiderSearchExpiryJob } = require('./services/riderBroadcast.service');
const { startAutoCancelJob } = require('./services/orderAutoCancel.service');
const { startRiderFailsafeCron } = require('./services/riderFailsafeCron.service');
const { initRedis: initTimerRedis, recoverExpiredTimers, getTimerStatus } = require('./services/orderTimer.service');

initSentry();

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MOCK_PAYMENTS === 'true') {
  logger.warn('ALLOW_MOCK_PAYMENTS=true in production — disable immediately');
}

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const kitchenRoutes = require('./routes/kitchen.routes');
const menuRoutes = require('./routes/menu.routes');
const orderRoutes = require('./routes/order.routes');
const adminRoutes = require('./routes/admin.routes');
const riderRoutes = require('./routes/rider.routes');
const walletRoutes = require('./routes/wallet.routes');
const notificationRoutes = require('./routes/notification.routes');
const bannerRoutes = require('./routes/banner.routes');
const homeRoutes = require('./routes/home.routes');
const dishRoutes = require('./routes/dish.routes');

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:5173', 'https://adminapnamenu.vercel.app'];

const socketCorsOrigins = process.env.SOCKET_CORS_ORIGINS
  ? process.env.SOCKET_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : corsOrigins;

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

// Build socket CORS — React Native sends requests with no/null Origin,
// so we use a function origin validator that always allows when configured as '*'.
const socketCorsOrigin = (() => {
  if (socketCorsOrigins.length === 1 && socketCorsOrigins[0] === '*') {
    return (origin, callback) => callback(null, true);
  }
  if (socketCorsOrigins.length === 1) return socketCorsOrigins[0];
  return (origin, callback) => {
    // allow null origin (React Native) or any in the list
    if (!origin || socketCorsOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Socket CORS blocked: ' + origin));
  };
})();

const io = new Server(server, {
  cors: {
    origin: socketCorsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Allow longer polling intervals for mobile
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.set('io', io);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/orders/webhook', webhookRateLimiter);

app.use('/api', (req, res, next) => {
  if (req.path === '/orders/webhook') return next();
  if (req.path === '/riders/location') return next(); // Bypass live location updates
  return apiRateLimiter(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

async function getHealthStatus() {
  const mongoose = require('mongoose');
  const mongoOk = mongoose.connection.readyState === 1;
  let redisOk = null;
  if (process.env.REDIS_URL) {
    try {
      await initRedis();
      if (isRedisReady()) {
        await getRedisClient().ping();
        redisOk = true;
      } else {
        redisOk = false;
      }
    } catch {
      redisOk = false;
    }
  }
  return {
    mongo: mongoOk ? 'ok' : 'down',
    redis: process.env.REDIS_URL ? (redisOk ? 'ok' : 'down') : 'not_configured',
    timers: getTimerStatus(),
  };
}

app.get('/api/health', async (req, res) => {
  const components = await getHealthStatus();
  const allOk = components.mongo === 'ok' && (components.redis !== 'down');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    message: 'ApnaMenu API health',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    components,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/kitchens', kitchenRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/riders', riderRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/dishes', dishRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use((err, req, res, next) => {
  logger.error({ err }, 'Server error');
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

initializeSocket(io);
startRiderSearchExpiryJob(io);
startAutoCancelJob(io);
startRiderFailsafeCron(io);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    await initRedis();
    await initTimerRedis();
    await recoverExpiredTimers(io);

    if (isRedisReady()) {
      try {
        const { createAdapter } = require('@socket.io/redis-adapter');
        const pubClient = duplicateClient();
        const subClient = duplicateClient();
        if (pubClient && subClient) {
          await Promise.all([pubClient.connect(), subClient.connect()]);
          io.adapter(createAdapter(pubClient, subClient));
          logger.info('Socket.io Redis adapter enabled');
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'Socket.io Redis adapter unavailable — single-node mode');
      }
    }

    server.listen(PORT, () => {
      logger.info(`ApnaMenu Backend running on port ${PORT}`);
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
};

startServer();

module.exports = { app, server, io };