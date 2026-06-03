const cron = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const TeeTimeBooker = require('./booker');
const { loadBookings, saveBookings, syncFromGistOnBoot } = require('./store');

const MAX_PENDING_BOOKINGS = 5;

// Prevents cron + startup-recovery from both firing checkAndRunBookings
// in the same trigger window (would cause a duplicate booking attempt).
let isRunning = false;

function getBookingTriggerDate(targetDateStr) {
  const [month, day, year] = targetDateStr.split('/').map(Number);
  const targetDate = new Date(year, month - 1, day);
  const triggerDate = new Date(targetDate);
  triggerDate.setDate(triggerDate.getDate() - config.bookingAdvanceDays);
  return triggerDate;
}

// FIX: Use timezone-aware date string to avoid UTC vs ET mismatch on Heroku
function todayStr() {
  const now = new Date();
  const etStr = now.toLocaleDateString('en-US', {
    timeZone: config.timezone,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  });
  return etStr; // Returns MM/DD/YYYY in ET
}

async function executeBooking(booking) {
  logger.info(`\n========================================`);
  logger.info(`EXECUTING BOOKING: ${booking.date} ${booking.timeWindow.start}-${booking.timeWindow.end}`);
  logger.info(`Partners: ${(booking.partners || []).join(', ') || '(none)'}`);
  logger.info(`Guests: ${(booking.guests || []).map((g) => typeof g === 'string' ? g : `${g.name} (${g.type})`).join(', ') || '(none)'}`);
  logger.info(`Transport: ${booking.transport}`);
  logger.info(`========================================\n`);
  const booker = new TeeTimeBooker(booking);
  const result = await booker.runPrecision();
  const bookings = loadBookings();
  const idx = bookings.findIndex((b) => b.id === booking.id);
  if (idx >= 0) {
    // 'partial' status: tee time IS secured on Foretees, but some
    // guests/partners didn't fill -- user finishes manually.  Treat
    // as a real booking for retry/skip purposes (don't re-run it).
    bookings[idx].status = result.success
      ? (result.partial ? 'partial' : 'completed')
      : 'failed';
    bookings[idx].result = result;
    bookings[idx].completedAt = new Date().toISOString();
    saveBookings(bookings);
  }
  logger.info(`Booking result: ${JSON.stringify(result)}`);
  return result;
}

async function checkAndRunBookings() {
  if (isRunning) {
    logger.info('Scheduler check skipped: another run is already in progress.');
    return;
  }
  isRunning = true;
  try {
    const bookings = loadBookings();
    const today = todayStr();
    logger.info(`Scheduler check at ${new Date().toLocaleString('en-US', { timeZone: config.timezone })} ET. Today = ${today}. ${bookings.length} total bookings.`);
    const todaysBookings = bookings.filter((b) => {
      if (b.status !== 'pending') return false;
      if (b.testRun) return false; // test-precision bookings fire via their own one-shot setTimeout
      const triggerDate = getBookingTriggerDate(b.date);
      const triggerStr = `${String(triggerDate.getMonth() + 1).padStart(2, '0')}/${String(triggerDate.getDate()).padStart(2, '0')}/${triggerDate.getFullYear()}`;
      return triggerStr === today;
    });
    if (todaysBookings.length === 0) {
      logger.info('No bookings to execute today.');
      return;
    }
    logger.info(`${todaysBookings.length} booking(s) to execute today!`);
    const interrupted = bookings.filter((b) => b.status === 'in_progress');
    if (interrupted.length > 0) {
      logger.info(`Found ${interrupted.length} interrupted booking(s). Will re-attempt.`);
      interrupted.forEach((b) => {
        if (!todaysBookings.find((tb) => tb.id === b.id)) {
          todaysBookings.push(b);
        }
      });
    }
    const nowIso = new Date().toISOString();
    for (const booking of todaysBookings) {
      const idx = bookings.findIndex((b) => b.id === booking.id);
      if (idx >= 0) {
        bookings[idx].status = 'in_progress';
        bookings[idx].startedAt = nowIso;
      }
    }
    saveBookings(bookings);
    for (const booking of todaysBookings) {
      try {
        await executeBooking(booking);
      } catch (error) {
        logger.error(`Fatal error executing booking ${booking.id}: ${error.message}`);
        const current = loadBookings();
        const idx = current.findIndex((b) => b.id === booking.id);
        if (idx >= 0) {
          current[idx].status = 'failed';
          current[idx].error = error.message;
          saveBookings(current);
        }
      }
    }
    logger.info('All scheduled bookings for today have been attempted.');
  } finally {
    isRunning = false;
  }
}

async function startScheduler() {
  logger.info('=== Tee Time Booker Scheduler Started ===');
  // Pull the durable copy of bookings.json from the GitHub Gist BEFORE
  // anything else reads the file. On a fresh dyno (FS reset to the
  // image's empty bookings.json) this restores any pending bookings.
  // No-op when GIST_ID / GIST_TOKEN are unset (local dev).
  await syncFromGistOnBoot();
  logger.info(`Timezone: ${config.timezone}`);
  logger.info(`Booking window: ${config.bookingAdvanceDays} days advance, opens at ${config.bookingOpenTime}`);
  logger.info(`Login lead time: ${config.loginLeadMinutes} minutes before open`);
  logger.info(`Max pending bookings: ${MAX_PENDING_BOOKINGS}`);
  const [openHour, openMin] = config.bookingOpenTime.split(':').map(Number);
  let cronMin = openMin - config.loginLeadMinutes;
  let cronHour = openHour;
  if (cronMin < 0) { cronMin += 60; cronHour -= 1; }
  const cronExpr = `${cronMin} ${cronHour} * * *`;
  logger.info(`Daily trigger: ${cronHour}:${String(cronMin).padStart(2, '0')} ET (cron: ${cronExpr})`);
  cron.schedule(cronExpr, () => {
    logger.info('--- SCHEDULED TRIGGER FIRED ---');
    checkAndRunBookings();
  }, { timezone: config.timezone });
  const now = new Date();
  // Use ET time for window check (Heroku runs in UTC)
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  const currentHour = etNow.getHours();
  const currentMin = etNow.getMinutes();
  const windowStartMin = cronHour * 60 + cronMin;
  const windowEndMin = openHour * 60 + openMin + 15;
  const currentTotalMin = currentHour * 60 + currentMin;
  if (currentTotalMin >= windowStartMin && currentTotalMin <= windowEndMin) {
    logger.info('*** STARTUP RECOVERY: We are in the trigger window. Running bookings immediately. ***');
    checkAndRunBookings();
  }
  // Test-precision bookings are fired by an in-memory setTimeout in
  // server.js; once the dyno restarts that timer is gone, so an
  // in_progress testRun is permanently dead and must be failed out
  // (otherwise the dashboard sticks on "Running Now" forever and the
  // user can't delete it via the UI).
  const abandonedTests = loadBookings().filter((b) => b.status === 'in_progress' && b.testRun);
  if (abandonedTests.length > 0) {
    logger.info(`*** STARTUP RECOVERY: Failing ${abandonedTests.length} abandoned test booking(s) (in-memory timer was lost on restart). ***`);
    const current = loadBookings();
    for (const a of abandonedTests) {
      const i = current.findIndex((b) => b.id === a.id);
      if (i >= 0) {
        current[i].status = 'failed';
        current[i].result = { success: false, error: 'Booking interrupted by dyno restart and could not auto-resume (test runs are not auto-recoverable).' };
        current[i].completedAt = new Date().toISOString();
      }
    }
    saveBookings(current);
  }
  const interruptedBookings = loadBookings().filter((b) => b.status === 'in_progress');
  if (interruptedBookings.length > 0) {
    logger.info(`*** STARTUP RECOVERY: Found ${interruptedBookings.length} interrupted booking(s). Re-attempting. ***`);
    checkAndRunBookings();
  }
  const currentBookings = loadBookings();
  const pendingCount = currentBookings.filter((b) => b.status === 'pending').length;
  if (pendingCount === 0) {
    logger.info('No pending bookings. Add bookings via the dashboard.');
  } else {
    logger.info(`${pendingCount} pending booking(s):`);
    currentBookings.filter((b) => b.status === 'pending').forEach((b) => {
      const trigger = getBookingTriggerDate(b.date);
      const partnersStr = (b.partners || []).join(', ') || '(none)';
      const guestsStr = (b.guests || []).length ? ` | Guests: ${b.guests.map((g) => typeof g === 'string' ? g : `${g.name} (${g.type})`).join(', ')}` : '';
      logger.info(`  ${b.date} ${b.timeWindow.start}-${b.timeWindow.end} | Transport: ${b.transport} | Partners: ${partnersStr}${guestsStr} | Triggers: ${trigger.toLocaleDateString()}`);
    });
  }
  logger.info('Scheduler running 24/7. Waiting for trigger times...');
}

module.exports = { startScheduler, checkAndRunBookings, loadBookings, saveBookings, MAX_PENDING_BOOKINGS };
