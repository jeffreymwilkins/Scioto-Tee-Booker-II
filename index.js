#!/usr/bin/env node

require('dotenv').config();
const { startScheduler } = require('./src/scheduler');
const logger = require('./src/logger');

logger.info('===================================');
logger.info('  Tee Time Booker - Starting Up');
logger.info(`  Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
logger.info(`  PID: ${process.pid}`);
logger.info('===================================');

if (!process.env.USERNAME || !process.env.PASSWORD || !process.env.MEMBER_NAME) {
  logger.error('Missing required environment variables: USERNAME, PASSWORD, and MEMBER_NAME');
  logger.error('Set them as Heroku config vars (Settings tab) or in .env for local runs.');
  logger.error('MEMBER_NAME must match your name exactly as it appears on the Foretees tee sheet.');
  process.exit(1);
}

startScheduler();

setInterval(() => {
  logger.info(`Heartbeat: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET -- scheduler alive.`);
}, 10 * 60 * 1000);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception (non-fatal): ${err.message}`);
  logger.error(err.stack);
});

process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled rejection (non-fatal): ${err.message || err}`);
});
