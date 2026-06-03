#!/usr/bin/env node

require('dotenv').config();
const TeeTimeBooker = require('./src/booker');
const logger = require('./src/logger');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') parsed.date = args[++i];
    else if (args[i] === '--start') parsed.start = args[++i];
    else if (args[i] === '--end') parsed.end = args[++i];
    else if (args[i] === '--partners') parsed.partners = args[++i];
    else if (args[i] === '--transport') parsed.transport = args[++i];
    else if (args[i] === '--dry-run') parsed.dryRun = true;
  }
  return parsed;
}

async function main() {
  const args = parseArgs();
  if (!args.date) {
    console.log('Usage: node book-now.js --date MM/DD/YYYY --start HH:MM --end HH:MM --partners "Name1, Name2"');
    console.log('Add --dry-run to test without submitting');
    process.exit(1);
  }
  const booking = {
    date: args.date,
    timeWindow: { start: args.start || '07:00', end: args.end || '18:00' },
    partners: args.partners ? args.partners.split(',').map((p) => p.trim()).filter(Boolean) : [],
    transport: args.transport || process.env.TRANSPORT_MODE || 'C-B',
  };
  logger.info('=== IMMEDIATE BOOKING MODE ===');
  logger.info(`Date: ${booking.date}`);
  logger.info(`Time window: ${booking.timeWindow.start} - ${booking.timeWindow.end}`);
  logger.info(`Partners: ${booking.partners.join(', ') || '(none)'}`);
  logger.info(`Transport: ${booking.transport}`);
  logger.info(`Dry run: ${args.dryRun ? 'YES' : 'NO'}`);
  const booker = new TeeTimeBooker(booking);
  if (args.dryRun) {
    booker.submitBooking = async function () {
      logger.info('[DRY RUN] Would submit booking here. Skipping.');
      await this.screenshot('DRY_RUN_would_submit');
      return { success: true, dryRun: true };
    };
  }
  const result = await booker.run();
  logger.info(`Result: ${JSON.stringify(result)}`);
  process.exit(result.success ? 0 : 1);
}

main().catch((e) => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
