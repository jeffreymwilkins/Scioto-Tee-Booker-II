#!/usr/bin/env node

// ---------------------------------------------------------------
// Combined web server + scheduler.
//
// Serves a simple booking dashboard on Heroku's $PORT and runs
// the 24/7 cron scheduler in the same process. Because they share
// the same filesystem, the web UI can read/write bookings.json
// directly and the scheduler picks up changes immediately.
// ---------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { startScheduler } = require('./src/scheduler');
const { loadBookings, saveBookings, flushPending } = require('./src/store');
const TeeTimeBooker = require('./src/booker');
const logger = require('./src/logger');
const rules = require('./src/rules');

const app = express();
const PORT = process.env.PORT || 3000;
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

// Simple auth: optional DASHBOARD_PASSWORD env var
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------
// Bookings persistence is provided by ./src/store -- local file as
// fast cache, GitHub Gist as the durable copy across dyno cycles.
// ---------------------------------------------------------------

function generateId() {
  return `bk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Apply club-rules validation + auto-shift to a booking request body.
// Returns { error, status } on hard failure, or { ok: true, partnerList,
// guestList, originalWindow, effectiveWindow, ruleNotice } on success.
// guestList is the normalized [{name, type}] array used both for storage
// and for the booker's Foretees guest-category clicks.
function applyClubRules({ date, start, end, partners, guests }) {
  const partnerList = partners
    ? partners.split(',').map((p) => p.trim()).filter(Boolean)
    : [];
  const guestList = rules.normalizeGuests(guests);
  if (partnerList.length + guestList.length > 3) {
    return { error: 'You can only add up to 3 partners + guests combined.', status: 400 };
  }
  const verdict = rules.evaluateBooking({ date, start, end, guests: guestList });
  if (!verdict.ok) {
    return { error: `Club rules: ${verdict.reason}`, status: 400 };
  }
  return {
    ok: true,
    partnerList,
    guestList,
    originalWindow: verdict.original,
    effectiveWindow: verdict.effective,
    ruleNotice: verdict.adjusted ? verdict.reason : null,
  };
}

// ---------------------------------------------------------------
// Optional basic auth middleware
// ---------------------------------------------------------------
function checkAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const provided = req.query.pw || req.body?.pw || req.headers['x-password'];
  if (provided === DASHBOARD_PASSWORD) return next();
  // Check cookie
  const cookie = req.headers.cookie || '';
  if (cookie.includes(`pw=${DASHBOARD_PASSWORD}`)) return next();
  res.status(401).send(loginPage());
}

function loginPage() {
  return `<!DOCTYPE html><html><head><title>Login</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f0;}
  form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center;}
  input{padding:.5rem 1rem;font-size:1rem;border:1px solid #ccc;border-radius:6px;margin:.5rem 0;}
  button{padding:.5rem 1.5rem;font-size:1rem;background:#2d5a27;color:#fff;border:none;border-radius:6px;cursor:pointer;}
  </style></head><body>
  <form method="GET"><h2>Tee Time Booker</h2><p>Enter dashboard password:</p>
  <input type="password" name="pw" autofocus><br><button type="submit">Enter</button></form></body></html>`;
}

// ---------------------------------------------------------------
// API: club rules table (for display) + live booking preview
// ---------------------------------------------------------------
app.get('/api/rules', checkAuth, (req, res) => {
  try {
    res.json(rules.loadRules());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rules/preview', checkAuth, (req, res) => {
  const { date, start, end, guests } = req.body || {};
  if (!date || !start || !end) {
    return res.status(400).json({ error: 'date, start, end required.' });
  }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be MM/DD/YYYY format.' });
  }
  try {
    const normalized = rules.normalizeGuests(guests);
    const verdict = rules.evaluateBooking({ date, start, end, guests: normalized });
    res.json(verdict);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------
// API: list bookings
// ---------------------------------------------------------------
app.get('/api/bookings', checkAuth, (req, res) => {
  const bookings = loadBookings();
  // Add trigger date to each
  const enriched = bookings.map(b => {
    const [month, day, year] = b.date.split('/').map(Number);
    const target = new Date(year, month - 1, day);
    const trigger = new Date(target.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { ...b, triggerDate: trigger.toLocaleDateString('en-US', { timeZone: 'America/New_York' }) };
  });
  res.json(enriched);
});

// ---------------------------------------------------------------
// API: add a booking
// ---------------------------------------------------------------
app.post('/api/bookings', checkAuth, (req, res) => {
  const { date, start, end, partners, guests, transport } = req.body;

  if (!date || !start || !end) {
    return res.status(400).json({ error: 'Date, start time, and end time are required.' });
  }

  // Validate date format
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be MM/DD/YYYY format.' });
  }

  const bookings = loadBookings();

  // Duplicate prevention: reject if a pending booking already exists for the same date
  const existingPending = bookings.find(b =>
    b.status === 'pending' && b.date === date
  );
  if (existingPending) {
    return res.status(400).json({
      error: 'You already have a pending booking for ' + date + '. Remove it first to create a new one.'
    });
  }

  const pendingCount = bookings.filter(b => b.status === 'pending').length;
  if (pendingCount >= 5) {
    return res.status(400).json({ error: 'Maximum 5 pending bookings. Remove one first.' });
  }

  const ruled = applyClubRules({ date, start, end, partners, guests });
  if (ruled.error) return res.status(ruled.status).json({ error: ruled.error });

  const booking = {
    id: generateId(),
    date,
    timeWindow: ruled.effectiveWindow,
    requestedWindow: ruled.originalWindow,
    ruleNotice: ruled.ruleNotice,
    partners: ruled.partnerList,
    guests: ruled.guestList,
    transport: transport || 'C-B',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  bookings.push(booking);
  saveBookings(bookings);
  logger.info(`Dashboard: Added booking ${booking.id} for ${date} ${start}-${end}`);
  res.json({ success: true, booking });
});

// ---------------------------------------------------------------
// API: remove a booking
// ---------------------------------------------------------------
app.delete('/api/bookings/:id', checkAuth, (req, res) => {
  const bookings = loadBookings();
  const target = bookings.find(b => b.id === req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Booking not found.' });
  }
  // Block deletion only when the run is plausibly still live.  The
  // precision watchdog caps at 10 min, so anything started more than
  // 15 min ago is either done-but-not-persisted (dyno crash) or
  // genuinely abandoned -- the user must be able to clear it.
  // For real (non-test) bookings createdAt can be days in the past,
  // so we key off startedAt (set when status flips to in_progress).
  // No startedAt at all is treated as a legacy stuck row from before
  // this field existed -- allow the user to clear it.
  if (target.status === 'in_progress') {
    const startedMs = target.startedAt ? new Date(target.startedAt).getTime() : null;
    if (startedMs && Date.now() - startedMs < 15 * 60 * 1000) {
      return res.status(400).json({ error: 'Cannot remove a booking that is currently running. Wait a few minutes and try again.' });
    }
    logger.info(`Dashboard: Force-clearing stale in_progress booking ${req.params.id} (started ${startedMs ? Math.round((Date.now()-startedMs)/60000)+' min ago' : 'unknown'}).`);
  }
  const filtered = bookings.filter(b => b.id !== req.params.id);
  saveBookings(filtered);
  logger.info(`Dashboard: Removed booking ${req.params.id}`);
  res.json({ success: true });
});

// ---------------------------------------------------------------
// API: book now (immediate test booking)
// ---------------------------------------------------------------
app.post('/api/book-now', checkAuth, (req, res) => {
  const { date, start, end, partners, guests, transport } = req.body;

  if (!date || !start || !end) {
    return res.status(400).json({ error: 'Date, start time, and end time are required.' });
  }

  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be MM/DD/YYYY format.' });
  }

  const ruled = applyClubRules({ date, start, end, partners, guests });
  if (ruled.error) return res.status(ruled.status).json({ error: ruled.error });

  const nowIso = new Date().toISOString();
  const booking = {
    id: generateId(),
    date,
    timeWindow: ruled.effectiveWindow,
    requestedWindow: ruled.originalWindow,
    ruleNotice: ruled.ruleNotice,
    partners: ruled.partnerList,
    guests: ruled.guestList,
    transport: transport || 'C-B',
    status: 'in_progress',
    bookNow: true,
    createdAt: nowIso,
    startedAt: nowIso,
  };

  // Save it so it shows up in the queue
  const bookings = loadBookings();
  bookings.push(booking);
  saveBookings(bookings);

  logger.info(`Book Now: Starting immediate booking ${booking.id} for ${date} ${start}-${end}`);

  // Fire off the booker in the background (don't await)
  const booker = new TeeTimeBooker(booking);
  booker.run()
    .then(result => {
      logger.info(`Book Now: ${booking.id} completed -- ${JSON.stringify(result)}`);
      const current = loadBookings();
      const idx = current.findIndex(b => b.id === booking.id);
      if (idx !== -1) {
        current[idx].status = result.success
          ? (result.partial ? 'partial' : 'completed')
          : 'failed';
        current[idx].result = result;
        saveBookings(current);
      }
    })
    .catch(err => {
      logger.error(`Book Now: ${booking.id} failed -- ${err.message}`);
      const current = loadBookings();
      const idx = current.findIndex(b => b.id === booking.id);
      if (idx !== -1) {
        current[idx].status = 'failed';
        current[idx].result = { error: err.message };
        saveBookings(current);
      }
    });

  // Return immediately -- client polls /api/bookings/:id for status
  res.json({ success: true, bookingId: booking.id });
});

// ---------------------------------------------------------------
// API: get single booking status (for polling)
// ---------------------------------------------------------------
app.get('/api/bookings/:id', checkAuth, (req, res) => {
  const bookings = loadBookings();
  const booking = bookings.find(b => b.id === req.params.id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found.' });
  }
  res.json(booking);
});

// ---------------------------------------------------------------
// Screenshots: list and serve diagnostic screenshots written by
// the booker.  The booker writes a "_FAILED" screenshot on guest-add
// failure regardless of DEBUG_SCREENSHOTS, so this endpoint lets you
// inspect what was on the page when something went wrong without
// SSH'ing into the dyno.  Files are ephemeral on Heroku Eco dynos.
// ---------------------------------------------------------------
app.get('/api/screenshots', checkAuth, (req, res) => {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return res.json([]);
    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => {
        const stat = fs.statSync(path.join(SCREENSHOTS_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use('/screenshots-files', checkAuth, express.static(SCREENSHOTS_DIR));

app.get('/screenshots', checkAuth, (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Diagnostic Screenshots</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui;background:#f0f4f0;margin:0;padding:1rem;}
  h1{color:#2d5a27;margin-top:0;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem;}
  .card{background:#fff;border-radius:8px;padding:.5rem;box-shadow:0 1px 4px rgba(0,0,0,.08);}
  .card img{width:100%;border-radius:4px;cursor:zoom-in;}
  .card .name{font-size:.75rem;color:#444;word-break:break-all;margin-top:.25rem;}
  .card .mt{font-size:.7rem;color:#888;}
  .empty{color:#666;padding:2rem;text-align:center;}
  a{color:#2d5a27;}
  .toolbar{margin-bottom:1rem;}
</style></head><body>
<h1>Diagnostic Screenshots</h1>
<div class="toolbar"><a href="/">&larr; Back to dashboard</a> &middot; <button onclick="location.reload()">Refresh</button></div>
<div id="content" class="empty">Loading...</div>
<script>
fetch('/api/screenshots').then(r => r.json()).then(files => {
  var c = document.getElementById('content');
  if (!files.length) { c.className = 'empty'; c.textContent = 'No screenshots in this dyno. Note that Heroku wipes /app/screenshots on every redeploy. The dashboard now also shows diagnostics on the failed booking card itself, which survives across page refreshes within the dyno lifetime.'; return; }
  c.className = 'grid';
  c.innerHTML = files.map(f => {
    var d = new Date(f.mtime).toLocaleString('en-US', { timeZone: 'America/New_York' });
    var url = '/screenshots-files/' + encodeURIComponent(f.name);
    return '<div class="card">' +
      '<a href="' + url + '" target="_blank"><img src="' + url + '" alt="' + f.name + '"></a>' +
      '<div class="name">' + f.name + '</div>' +
      '<div class="mt">' + d + '</div>' +
    '</div>';
  }).join('');
}).catch(e => { document.getElementById('content').textContent = 'Error: ' + e.message; });
</script>
</body></html>`);
});

// ---------------------------------------------------------------
// API: test the precision (6:58/7:00 rapid-fire) flow at an
// arbitrary trigger time today. One-shot. Doesn't touch the
// regular 6:58 ET cron — that still runs tomorrow as normal.
// ---------------------------------------------------------------
// Schedules an in-memory setTimeout to fire a test-precision booking.
// Also used at boot to recover any pending testRun bookings whose
// scheduler-side timer was lost when the dyno died.  triggerEpochMs
// on the booking record is the absolute UTC ms target -- survives
// dyno restarts, unlike the previous "HH:MM today" decoding.
function scheduleTestPrecisionRun(booking) {
  const triggerEpochMs = booking.triggerEpochMs;
  if (typeof triggerEpochMs !== 'number') {
    logger.error(`Test Precision ${booking.id}: cannot schedule, missing triggerEpochMs.`);
    return;
  }
  const launchLeadMs = 2.5 * 60 * 1000;
  const msUntilLaunch = triggerEpochMs - launchLeadMs - Date.now();
  const msPastTrigger = Date.now() - triggerEpochMs;

  // If we're already well past the trigger (>10 min, the watchdog's
  // own ceiling), don't fire a stale run -- mark it failed so the
  // user sees what happened.  This is the dyno-restart case where the
  // test was scheduled hours ahead and we just booted up too late.
  if (msPastTrigger > 10 * 60 * 1000) {
    logger.info(`Test Precision ${booking.id}: trigger was ${Math.round(msPastTrigger/60000)} min ago, marking failed.`);
    const current = loadBookings();
    const i = current.findIndex(b => b.id === booking.id);
    if (i !== -1 && current[i].status === 'pending') {
      current[i].status = 'failed';
      current[i].result = { success: false, error: `Trigger time passed ${Math.round(msPastTrigger/60000)} min ago without firing (likely a dyno restart). Re-schedule the test.` };
      current[i].completedAt = new Date().toISOString();
      saveBookings(current);
    }
    return;
  }

  const launchInMs = Math.max(0, msUntilLaunch);
  logger.info(`Test Precision queued: ${booking.id} -- launch in ${Math.round(launchInMs/1000)}s, rapid-fire at ${booking.triggerTime} ET`);

  setTimeout(() => {
    logger.info(`Test Precision firing: ${booking.id}`);
    const current = loadBookings();
    const idx = current.findIndex(b => b.id === booking.id);
    if (idx === -1) {
      logger.info(`Test Precision ${booking.id} was removed before firing. Skipping.`);
      return;
    }
    if (current[idx].status !== 'pending') {
      logger.info(`Test Precision ${booking.id} is already ${current[idx].status}. Skipping.`);
      return;
    }
    current[idx].status = 'in_progress';
    current[idx].startedAt = new Date().toISOString();
    saveBookings(current);

    const booker = new TeeTimeBooker(booking);
    booker.runPrecision()
      .then(result => {
        logger.info(`Test Precision: ${booking.id} done -- ${JSON.stringify(result)}`);
        const after = loadBookings();
        const i = after.findIndex(b => b.id === booking.id);
        if (i !== -1) {
          after[i].status = result.success
            ? (result.partial ? 'partial' : 'completed')
            : 'failed';
          after[i].result = result;
          after[i].completedAt = new Date().toISOString();
          saveBookings(after);
        }
      })
      .catch(err => {
        logger.error(`Test Precision: ${booking.id} failed -- ${err.message}`);
        const after = loadBookings();
        const i = after.findIndex(b => b.id === booking.id);
        if (i !== -1) {
          after[i].status = 'failed';
          after[i].result = { error: err.message };
          after[i].completedAt = new Date().toISOString();
          saveBookings(after);
        }
      });
  }, launchInMs);
}

app.post('/api/test-precision', checkAuth, (req, res) => {
  const { date, start, end, partners, guests, transport, triggerTime } = req.body;

  if (!date || !start || !end || !triggerTime) {
    return res.status(400).json({ error: 'Date, time window, and trigger time are required.' });
  }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be MM/DD/YYYY format.' });
  }
  if (!/^\d{2}:\d{2}$/.test(triggerTime)) {
    return res.status(400).json({ error: 'Trigger time must be HH:MM (24-hour ET).' });
  }

  // Build a Date at triggerTime today in ET. The Heroku dyno has TZ set to
  // America/New_York, so new Date().setHours() works in ET.
  const [tHour, tMin] = triggerTime.split(':').map(Number);
  const triggerDate = new Date();
  triggerDate.setHours(tHour, tMin, 0, 0);
  const triggerEpochMs = triggerDate.getTime();
  const msUntilTrigger = triggerEpochMs - Date.now();

  if (msUntilTrigger <= 0) {
    return res.status(400).json({ error: 'Trigger time must be in the future (today, ET).' });
  }
  if (msUntilTrigger < 3 * 60 * 1000) {
    return res.status(400).json({ error: 'Trigger time must be at least 3 minutes from now (browser login takes ~1-2 min).' });
  }
  if (msUntilTrigger > 6 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Trigger time must be within the next 6 hours.' });
  }

  const ruled = applyClubRules({ date, start, end, partners, guests });
  if (ruled.error) return res.status(ruled.status).json({ error: ruled.error });

  const booking = {
    id: generateId(),
    date,
    timeWindow: ruled.effectiveWindow,
    requestedWindow: ruled.originalWindow,
    ruleNotice: ruled.ruleNotice,
    partners: ruled.partnerList,
    guests: ruled.guestList,
    transport: transport || 'C-B',
    bookingOpenTimeOverride: triggerTime, // <-- booker waits until this time, then rapid-fires
    status: 'pending',
    testRun: true,
    triggerTime,
    triggerEpochMs, // absolute target so we can recover on dyno restart
    createdAt: new Date().toISOString(),
  };

  const bookings = loadBookings();
  bookings.push(booking);
  saveBookings(bookings);

  scheduleTestPrecisionRun(booking);

  const launchLeadMs = 2.5 * 60 * 1000;
  const msUntilLaunch = Math.max(0, msUntilTrigger - launchLeadMs);
  res.json({ success: true, bookingId: booking.id, msUntilLaunch, triggerTime });
});

// ---------------------------------------------------------------
// API: read-only probe.  Walks the whole booking flow and captures
// every screen's HTML + screenshot WITHOUT booking anything.  Used
// to re-learn the Foretees DOM after Scioto/Foretees change their
// pages.  Probe results are kept in memory + a single on-disk file
// (probe-latest.json) -- they are NOT written to bookings.json, so
// they never touch the gist or the scheduler.
// ---------------------------------------------------------------
const PROBE_LATEST_FILE = path.join(__dirname, 'probe-latest.json');
const probeRuns = {}; // id -> { id, status, date, startedAt, finishedAt, captures, error }

app.post('/api/probe', checkAuth, (req, res) => {
  const { date, start, end } = req.body;
  if (!date || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'A play date in MM/DD/YYYY format is required.' });
  }
  if (Object.values(probeRuns).some((p) => p.status === 'running')) {
    return res.status(400).json({ error: 'A probe is already running. Wait for it to finish.' });
  }

  // Window the probe samples for a slot to inspect.  Default to the
  // afternoon, where guests are usually allowed -- morning slots
  // often restrict guests and hide the Guests tab.
  const window = {
    start: /^\d{2}:\d{2}$/.test(start || '') ? start : '12:00',
    end: /^\d{2}:\d{2}$/.test(end || '') ? end : '17:00',
  };

  // Keep memory bounded -- retain only the two most recent prior runs.
  const old = Object.keys(probeRuns)
    .sort((a, b) => new Date(probeRuns[a].startedAt) - new Date(probeRuns[b].startedAt));
  while (old.length > 2) delete probeRuns[old.shift()];

  const id = `probe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const run = { id, status: 'running', date, window, startedAt: new Date().toISOString(), captures: [], error: null };
  probeRuns[id] = run;
  logger.info(`Probe ${id}: starting read-only DOM capture for ${date} (${window.start}-${window.end})`);

  const finish = (result) => {
    run.status = result && result.success ? 'completed' : 'failed';
    run.captures = (result && result.captures) || [];
    run.error = (result && result.error) || null;
    run.finishedAt = new Date().toISOString();
    logger.info(`Probe ${id}: ${run.status} -- ${run.captures.length} screen(s) captured`);
    try {
      fs.writeFileSync(PROBE_LATEST_FILE, JSON.stringify(run));
    } catch (e) {
      logger.warn(`Probe ${id}: could not persist probe-latest.json: ${e.message}`);
    }
  };

  const booker = new TeeTimeBooker({ date, timeWindow: window });
  booker.probe()
    .then(finish)
    .catch((err) => {
      logger.error(`Probe ${id}: crashed -- ${err.message}`);
      finish({ success: false, error: err.message, captures: [] });
    });

  res.json({ success: true, probeId: id });
});

app.get('/api/probe/:id', checkAuth, (req, res) => {
  const run = probeRuns[req.params.id];
  if (!run) return res.status(404).json({ error: 'Probe not found.' });
  res.json(run);
});

app.get('/api/probe-latest', checkAuth, (req, res) => {
  const runs = Object.values(probeRuns)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  if (runs.length > 0) return res.json(runs[0]);
  try {
    if (fs.existsSync(PROBE_LATEST_FILE)) {
      return res.json(JSON.parse(fs.readFileSync(PROBE_LATEST_FILE, 'utf8')));
    }
  } catch (e) {
    logger.warn(`Could not read probe-latest.json: ${e.message}`);
  }
  res.json(null);
});

// ---------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------
app.get('/', checkAuth, (req, res) => {
  // Set auth cookie if password provided
  if (DASHBOARD_PASSWORD && req.query.pw === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', `pw=${DASHBOARD_PASSWORD}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  }
  res.send(dashboardHtml());
});

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tee Time Booker</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7f5;
      color: #1a1a1a;
      min-height: 100vh;
    }
    .header {
      background: linear-gradient(135deg, #2d5a27 0%, #1a3a15 100%);
      color: white;
      padding: 1.5rem 1rem;
      text-align: center;
    }
    .header h1 { font-size: 1.5rem; font-weight: 600; }
    .header p { font-size: 0.85rem; opacity: 0.8; margin-top: 0.25rem; }
    .container { max-width: 600px; margin: 0 auto; padding: 1rem; }

    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .card h2 {
      font-size: 1.1rem;
      margin-bottom: 1rem;
      color: #2d5a27;
      border-bottom: 2px solid #e8ede8;
      padding-bottom: 0.5rem;
    }

    label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 0.25rem;
      margin-top: 0.75rem;
    }
    label:first-of-type { margin-top: 0; }

    input, select {
      width: 100%;
      padding: 0.6rem 0.75rem;
      font-size: 1rem;
      border: 1.5px solid #d0d7d0;
      border-radius: 8px;
      background: #fafbfa;
      transition: border-color 0.2s;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #2d5a27;
      background: #fff;
    }

    .time-row { display: flex; gap: 0.75rem; }
    .time-row > div { flex: 1; }

    .hint {
      font-size: 0.75rem;
      color: #888;
      margin-top: 0.2rem;
    }

    .btn {
      display: block;
      width: 100%;
      padding: 0.75rem;
      font-size: 1rem;
      font-weight: 600;
      color: white;
      background: #2d5a27;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 1.25rem;
      transition: background 0.2s;
    }
    .btn:hover { background: #3a7a32; }
    .btn:disabled { background: #999; cursor: not-allowed; }

    .btn-danger {
      background: none;
      color: #c44;
      border: 1px solid #c44;
      padding: 0.35rem 0.75rem;
      font-size: 0.8rem;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }
    .btn-danger:hover { background: #fdd; }

    .booking-item {
      border: 1.5px solid #e0e5e0;
      border-radius: 10px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.75rem;
      position: relative;
    }
    .booking-item.pending { border-left: 4px solid #2d5a27; }
    .booking-item.completed { border-left: 4px solid #4a9; }
    .booking-item.partial { border-left: 4px solid #d4a017; }
    .booking-item.failed { border-left: 4px solid #c44; }
    .booking-item.in_progress { border-left: 4px solid #e8a030; }

    .booking-date {
      font-size: 1.1rem;
      font-weight: 700;
      color: #2d5a27;
    }
    .booking-time { font-size: 0.95rem; color: #333; }
    .booking-detail { font-size: 0.8rem; color: #666; margin-top: 0.25rem; }
    .booking-status {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      margin-top: 0.35rem;
    }
    .status-pending { background: #e8f5e0; color: #2d5a27; }
    .status-completed { background: #d4f0e0; color: #2a7a55; }
    .status-partial { background: #fff1c2; color: #8a6a00; }
    .status-failed { background: #fde0e0; color: #c44; }
    .status-in_progress { background: #fff3d0; color: #a07020; }

    .booking-actions { position: absolute; top: 0.75rem; right: 0.75rem; }

    .empty-state {
      text-align: center;
      padding: 2rem 1rem;
      color: #999;
      font-size: 0.95rem;
    }

    .toast {
      position: fixed;
      bottom: 1.5rem;
      left: 50%;
      transform: translateX(-50%);
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      font-size: 0.9rem;
      z-index: 100;
      animation: fadeIn 0.3s;
    }
    .toast-success { background: #2d5a27; }
    .toast-error { background: #c44; }
    @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } }

    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 1rem;
    }
    .tab {
      flex: 1;
      padding: 0.6rem;
      text-align: center;
      font-size: 0.9rem;
      font-weight: 600;
      background: #e8ede8;
      border: none;
      cursor: pointer;
      color: #555;
    }
    .tab:first-child { border-radius: 8px 0 0 8px; }
    .tab:last-child { border-radius: 0 8px 8px 0; }
    .tab:not(:first-child):not(:last-child) { border-radius: 0; }
    .tab.active { background: #2d5a27; color: white; }

    /* Per-guest row (name + type) */
    .guest-list { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.4rem; }
    .guest-row { display: flex; gap: 0.4rem; align-items: center; }
    .guest-row input { flex: 2; min-width: 0; }
    .guest-row select { flex: 1; min-width: 0; padding: 0.5rem; border: 1px solid #ccc; border-radius: 6px; font-size: 0.9rem; background: #fff; }
    .guest-row .btn-remove {
      background: #e8ede8; color: #555; border: none; border-radius: 6px;
      padding: 0 0.6rem; cursor: pointer; font-size: 1.1rem; line-height: 1;
      height: 2.25rem;
    }
    .guest-row .btn-remove:hover { background: #f8d8d8; color: #a33; }
    .btn-mini {
      background: #fff; border: 1px dashed #2d5a27; color: #2d5a27;
      padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.85rem;
      cursor: pointer; font-weight: 500;
    }
    .btn-mini:hover { background: #f0f4f0; }

    /* Inline rules feedback under a form */
    .rule-preview {
      margin: 0.6rem 0;
      padding: 0.6rem 0.8rem;
      border-radius: 6px;
      font-size: 0.85rem;
      line-height: 1.4;
      border-left: 3px solid #aaa;
    }
    .rule-preview.ok      { background: #f0f7ee; border-left-color: #2d5a27; color: #2d5a27; }
    .rule-preview.shift   { background: #fff8e8; border-left-color: #c08a20; color: #6e4a00; }
    .rule-preview.block   { background: #fff0f0; border-left-color: #c44;    color: #a22; }

    /* Club rules table */
    .rules-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .rules-table th, .rules-table td { border: 1px solid #d0d0d0; padding: 0.4rem 0.5rem; vertical-align: top; text-align: left; }
    .rules-table th { background: #e8ede8; color: #2d5a27; font-weight: 700; }
    .rules-table td.cat { background: #f0f4f0; font-weight: 600; max-width: 12rem; }
    .rules-table tr.engine-driven td { background: #f0f7ee; }
    .rules-table .badge {
      display: inline-block; font-size: 0.65rem; font-weight: 700;
      padding: 0.05rem 0.35rem; margin-left: 0.3rem; border-radius: 3px;
      background: #2d5a27; color: #fff; vertical-align: middle;
    }
    .rules-wrap { overflow-x: auto; }
  </style>
</head>
<body>

  <div class="header">
    <h1>Scioto CC Tee Time Booker</h1>
    <p>Schedule automated tee time bookings</p>
  </div>

  <div class="container">
    <div class="tabs">
      <button class="tab active" onclick="showTab('add')">Schedule</button>
      <button class="tab" onclick="showTab('booknow')">Book Now</button>
      <button class="tab" onclick="showTab('testprecision')">Test 7AM</button>
      <button class="tab" onclick="showTab('probe')">Probe</button>
      <button class="tab" onclick="showTab('queue')">My Queue</button>
      <button class="tab" onclick="showTab('rules')">Club Rules</button>
    </div>

    <!-- ADD BOOKING TAB -->
    <div id="tab-add">
      <div class="card">
        <h2>New Tee Time</h2>
        <form id="booking-form" onsubmit="return submitBooking(event)">
          <label for="date">Date You Want to Play</label>
          <input type="date" id="date" required>
          <div class="hint">Must be 7+ days from today (booking opens 7 days in advance)</div>

          <div class="time-row">
            <div>
              <label for="start">Earliest Time</label>
              <input type="time" id="start" value="09:00" required>
            </div>
            <div>
              <label for="end">Latest Time</label>
              <input type="time" id="end" value="10:00" required>
            </div>
          </div>
          <div class="hint">The bot will book the best fully-open slot in this window</div>

          <label for="partners">Member Partners</label>
          <input type="text" id="partners" placeholder="e.g. John Smith, Jane Doe">
          <div class="hint">Comma-separated Scioto member names (Partners or Members tab)</div>

          <label>Guests (Non-Members)</label>
          <div id="guests-list" class="guest-list"></div>
          <button type="button" class="btn-mini" onclick="addGuestRow('guests-list')">+ Add guest</button>
          <div class="hint">Each guest gets a type. Foretees has three: <strong>Family</strong> (member's spouse/kids/parents/siblings), <strong>Guest</strong>, <strong>Social Guest</strong>. Type affects when the guest may play (see Club Rules tab).</div>
          <div class="hint" style="color:#888;">Total of partners + guests cannot exceed 3</div>

          <div id="rule-preview" class="rule-preview" style="display:none;"></div>

          <label for="transport">Transportation</label>
          <select id="transport">
            <option value="C-B" selected>B Caddie (C-B)</option>
            <option value="C-A">A Caddie (C-A)</option>
            <option value="C-H">Honor Caddie (C-H)</option>
            <option value="FOR">Forecaddie (FOR)</option>
            <option value="WAL">Walking (WAL)</option>
            <option value="TRL">Trolley (TRL)</option>
          </select>

          <button type="submit" class="btn" id="submit-btn">Add Booking</button>
        </form>
      </div>

      <div class="card">
        <h2>How It Works</h2>
        <p style="font-size:0.85rem; color:#555; line-height:1.5;">
          Scioto's tee sheet opens <strong>7 days in advance at 7:00 AM ET</strong>.
          When you add a booking here, the bot will automatically log in at 6:58 AM
          on the right morning and start refreshing the tee sheet. The instant it
          opens at 7:00 AM, it grabs the best available slot in your time window
          and books it with your partners and transport preference.
        </p>
      </div>
    </div>

    <!-- BOOK NOW TAB -->
    <div id="tab-booknow" style="display:none;">
      <div class="card">
        <h2>Book Now (Test)</h2>
        <form id="booknow-form" onsubmit="return submitBookNow(event)">
          <label for="bn-date">Date You Want to Play</label>
          <input type="date" id="bn-date" required>
          <div class="hint">Must be a date with an open tee sheet (today through 7 days out)</div>

          <div class="time-row">
            <div>
              <label for="bn-start">Earliest Time</label>
              <input type="time" id="bn-start" value="09:00" required>
            </div>
            <div>
              <label for="bn-end">Latest Time</label>
              <input type="time" id="bn-end" value="18:00" required>
            </div>
          </div>
          <div class="hint">Wide window recommended for testing</div>

          <label for="bn-partners">Member Partners</label>
          <input type="text" id="bn-partners" placeholder="e.g. John Smith, Jane Doe">
          <div class="hint">Comma-separated Scioto member names (Partners or Members tab)</div>

          <label>Guests (Non-Members)</label>
          <div id="bn-guests-list" class="guest-list"></div>
          <button type="button" class="btn-mini" onclick="addGuestRow('bn-guests-list')">+ Add guest</button>
          <div class="hint">Each guest gets a Foretees type (Family / Guest / Social Guest). See Club Rules tab.</div>
          <div class="hint" style="color:#888;">Total of partners + guests cannot exceed 3</div>

          <div id="bn-rule-preview" class="rule-preview" style="display:none;"></div>

          <label for="bn-transport">Transportation</label>
          <select id="bn-transport">
            <option value="C-B" selected>B Caddie (C-B)</option>
            <option value="C-A">A Caddie (C-A)</option>
            <option value="C-H">Honor Caddie (C-H)</option>
            <option value="FOR">Forecaddie (FOR)</option>
            <option value="WAL">Walking (WAL)</option>
            <option value="TRL">Trolley (TRL)</option>
          </select>

          <button type="submit" class="btn" id="booknow-btn" style="background:#e8a030;">Book Now</button>
        </form>
      </div>

      <div class="card">
        <h2>What This Does</h2>
        <p style="font-size:0.85rem; color:#555; line-height:1.5;">
          This runs the booking bot <strong>right now</strong> instead of waiting for the
          scheduled time. Use it to test that everything works. The bot will log in,
          find the best open slot in your time window, and attempt to book it immediately.
          Check My Queue to see the result.
        </p>
      </div>

      <div id="booknow-status" style="display:none;" class="card">
        <h2>Booking in Progress...</h2>
        <p id="booknow-status-text" style="font-size:0.9rem; color:#555; line-height:1.5;">
          The bot is running. This typically takes 30-60 seconds. The page will update automatically.
        </p>
        <div id="booknow-spinner" style="text-align:center; padding:1rem;">
          <div style="display:inline-block; width:2rem; height:2rem; border:3px solid #e8ede8; border-top-color:#2d5a27; border-radius:50%; animation:spin 1s linear infinite;"></div>
        </div>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      </div>
    </div>

    <!-- TEST PRECISION TAB -->
    <div id="tab-testprecision" style="display:none;">
      <div class="card">
        <h2>Test 7AM Auto-Booking</h2>
        <form id="testprecision-form" onsubmit="return submitTestPrecision(event)">
          <label for="tp-trigger">Trigger Time Today (ET)</label>
          <input type="time" id="tp-trigger" required>
          <div class="hint">When to fire the precision flow. Browser launches ~2.5 min earlier to be logged in and ready.</div>

          <label for="tp-date">Play Date</label>
          <input type="date" id="tp-date" required>
          <div class="hint">Pick a date whose tee sheet is already open today (1-7 days out).</div>

          <div class="time-row">
            <div>
              <label for="tp-start">Earliest Time</label>
              <input type="time" id="tp-start" value="09:00" required>
            </div>
            <div>
              <label for="tp-end">Latest Time</label>
              <input type="time" id="tp-end" value="18:00" required>
            </div>
          </div>

          <label for="tp-partners">Member Partners</label>
          <input type="text" id="tp-partners" placeholder="e.g. Randy Gerber">
          <div class="hint">Comma-separated Scioto member names</div>

          <label>Guests (Non-Members)</label>
          <div id="tp-guests-list" class="guest-list"></div>
          <button type="button" class="btn-mini" onclick="addGuestRow('tp-guests-list')">+ Add guest</button>
          <div class="hint">Each guest gets a Foretees type. See Club Rules tab.</div>
          <div id="tp-rule-preview" class="rule-preview" style="display:none;"></div>
          <div class="hint">Comma-separated guest names</div>

          <label for="tp-transport">Transportation</label>
          <select id="tp-transport">
            <option value="C-B" selected>B Caddie (C-B)</option>
            <option value="C-A">A Caddie (C-A)</option>
            <option value="C-H">Honor Caddie (C-H)</option>
            <option value="FOR">Forecaddie (FOR)</option>
            <option value="WAL">Walking (WAL)</option>
            <option value="TRL">Trolley (TRL)</option>
          </select>

          <button type="submit" class="btn" id="testprecision-btn" style="background:#9c4bcc;">Schedule Test Run</button>
        </form>
      </div>

      <div class="card">
        <h2>What This Does</h2>
        <p style="font-size:0.85rem; color:#555; line-height:1.5;">
          Runs the <strong>exact same code path</strong> as the 6:58 AM scheduler, but at a time
          <em>you</em> pick today. Verifies the full flow end-to-end: login &rarr; navigate &rarr; wait until
          trigger &minus; 1 min &rarr; rapid-fire URL hammering &rarr; slot selection &rarr; form fill (incl. guests) &rarr; submit.
        </p>
        <p style="font-size:0.85rem; color:#555; line-height:1.5; margin-top:0.5rem;">
          The regular 6:58 ET cron is <strong>not affected</strong> &mdash; this is a one-shot.
        </p>
      </div>

      <div id="testprecision-status" style="display:none;" class="card">
        <h2>Test Scheduled</h2>
        <p id="testprecision-status-text" style="font-size:0.9rem; color:#555; line-height:1.5;"></p>
      </div>
    </div>

    <!-- PROBE TAB -->
    <div id="tab-probe" style="display:none;">
      <div class="card">
        <h2>Probe ForeTees (Read-Only)</h2>
        <form id="probe-form" onsubmit="return submitProbe(event)">
          <label for="pr-date">Play Date to Inspect</label>
          <input type="date" id="pr-date" required>
          <div class="hint">Pick a date with an open tee sheet (today through 7 days out).</div>

          <div class="time-row">
            <div>
              <label for="pr-start">Earliest Time</label>
              <input type="time" id="pr-start" value="12:00" required>
            </div>
            <div>
              <label for="pr-end">Latest Time</label>
              <input type="time" id="pr-end" value="17:00" required>
            </div>
          </div>
          <div class="hint">The probe samples open slots in this window and opens one to inspect. Use an afternoon window &mdash; morning slots often restrict guests and hide the Guests tab.</div>

          <button type="submit" class="btn" id="probe-btn" style="background:#0077b6;">Run Probe</button>
        </form>
      </div>

      <div class="card">
        <h2>What This Does</h2>
        <p style="font-size:0.85rem; color:#555; line-height:1.5;">
          Walks the whole booking flow &mdash; login, ForeTees, tee sheet, booking
          form, the Partners / Members / Guests panel tabs, and the Guest
          Registration modal &mdash; and captures the HTML, a screenshot, and a
          selector health-check of every screen.
        </p>
        <p style="font-size:0.85rem; color:#555; line-height:1.5; margin-top:0.5rem;">
          <strong>It never books anything.</strong> It only opens pages and panels &mdash;
          it never clicks Submit and never adds a guest. It briefly opens one open
          slot's booking form so it can be inspected, then closes the browser;
          ForeTees releases that slot on its own.
        </p>
        <p style="font-size:0.85rem; color:#555; line-height:1.5; margin-top:0.5rem;">
          Run this after Scioto or ForeTees change their booking pages, then share
          the results so the bot's selectors can be updated. Takes about 1-2 minutes.
          Avoid running it right around a scheduled 7:00 AM booking.
        </p>
      </div>

      <div id="probe-status" style="display:none;" class="card">
        <h2 id="probe-status-title">Probe Running...</h2>
        <p id="probe-status-text" style="font-size:0.9rem; color:#555; line-height:1.5;"></p>
        <div id="probe-spinner" style="text-align:center; padding:1rem;">
          <div style="display:inline-block; width:2rem; height:2rem; border:3px solid #e8ede8; border-top-color:#0077b6; border-radius:50%; animation:spin 1s linear infinite;"></div>
        </div>
      </div>

      <div id="probe-results"></div>
    </div>

    <!-- QUEUE TAB -->
    <div id="tab-queue" style="display:none;">
      <div class="card">
        <h2>Booking Queue</h2>
        <div id="bookings-list">
          <div class="empty-state">Loading...</div>
        </div>
      </div>
    </div>

    <!-- CLUB RULES TAB -->
    <div id="tab-rules" style="display:none;">
      <div class="card">
        <h2>Club Play Windows</h2>
        <p style="font-size:0.85rem;color:#555;line-height:1.5;">
          Booking attempts are auto-shifted to the nearest allowed window per these rules.
          You're configured as a <strong>Full Member</strong> for validation purposes.
          When the club issues a new table, send it to me and I'll update <code>rules.json</code>.
        </p>
        <div id="rules-table-container" class="empty-state">Loading rules...</div>
      </div>
    </div>
  </div>

  <script>
    // Shared HTML escaper for raw captures / diagnostics.
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Tab switching
    function showTab(tab) {
      document.getElementById('tab-add').style.display = tab === 'add' ? 'block' : 'none';
      document.getElementById('tab-booknow').style.display = tab === 'booknow' ? 'block' : 'none';
      document.getElementById('tab-testprecision').style.display = tab === 'testprecision' ? 'block' : 'none';
      document.getElementById('tab-probe').style.display = tab === 'probe' ? 'block' : 'none';
      document.getElementById('tab-queue').style.display = tab === 'queue' ? 'block' : 'none';
      document.getElementById('tab-rules').style.display = tab === 'rules' ? 'block' : 'none';
      const order = { add: 0, booknow: 1, testprecision: 2, probe: 3, queue: 4, rules: 5 };
      document.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', order[tab] === i);
      });
      if (tab === 'queue') loadBookingsList();
      if (tab === 'probe') loadLatestProbe();
      if (tab === 'rules') loadRulesTable();
    }

    // Set default date to 8 days from now
    (function() {
      const d = new Date();
      d.setDate(d.getDate() + 8);
      document.getElementById('date').value = d.toISOString().split('T')[0];
    })();

    // -------------------------------------------------------------
    // Guest rows: name + Foretees type (Family / Guest / Social Guest)
    // -------------------------------------------------------------
    const GUEST_TYPES = ['Family', 'Guest', 'Social Guest'];

    function addGuestRow(containerId, presetName, presetType) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const row = document.createElement('div');
      row.className = 'guest-row';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Guest name';
      nameInput.value = presetName || '';
      const typeSelect = document.createElement('select');
      GUEST_TYPES.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        if (t === (presetType || 'Guest')) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-remove';
      removeBtn.title = 'Remove guest';
      removeBtn.textContent = '×';
      removeBtn.onclick = () => { row.remove(); previewRulesFor(containerId); };
      nameInput.addEventListener('input', () => previewRulesFor(containerId));
      typeSelect.addEventListener('change', () => previewRulesFor(containerId));
      row.appendChild(nameInput);
      row.appendChild(typeSelect);
      row.appendChild(removeBtn);
      container.appendChild(row);
    }

    function collectGuests(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return [];
      return Array.from(container.querySelectorAll('.guest-row')).map((row) => {
        const name = (row.querySelector('input').value || '').trim();
        const type = row.querySelector('select').value;
        return name ? { name, type } : null;
      }).filter(Boolean);
    }

    // Map a guest-list container to its date/time inputs + preview slot.
    const FORM_MAP = {
      'guests-list':    { dateId: 'date',    startId: 'start',    endId: 'end',    previewId: 'rule-preview' },
      'bn-guests-list': { dateId: 'bn-date', startId: 'bn-start', endId: 'bn-end', previewId: 'bn-rule-preview' },
      'tp-guests-list': { dateId: 'tp-date', startId: 'tp-start', endId: 'tp-end', previewId: 'tp-rule-preview' },
    };

    async function previewRulesFor(containerId) {
      const m = FORM_MAP[containerId];
      if (!m) return;
      const dateInput = document.getElementById(m.dateId);
      const startInput = document.getElementById(m.startId);
      const endInput = document.getElementById(m.endId);
      const preview = document.getElementById(m.previewId);
      if (!preview) return;
      if (!dateInput.value || !startInput.value || !endInput.value) {
        preview.style.display = 'none'; return;
      }
      const [yy, mm, dd] = dateInput.value.split('-');
      const date = mm + '/' + dd + '/' + yy;
      const guests = collectGuests(containerId);
      try {
        const res = await fetch('/api/rules/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, start: startInput.value, end: endInput.value, guests }),
        });
        const v = await res.json();
        preview.style.display = 'block';
        if (!v.ok) {
          preview.className = 'rule-preview block';
          preview.innerHTML = '<strong>Cannot book:</strong> ' + esc(v.reason || 'no allowed window');
          return;
        }
        if (v.adjusted) {
          preview.className = 'rule-preview shift';
          preview.innerHTML = '<strong>' + esc(v.day) + ':</strong> requested ' +
            esc(v.original.start) + '–' + esc(v.original.end) +
            ' → will book in <strong>' + esc(v.effective.start) + '–' + esc(v.effective.end) +
            '</strong> per club rules.';
        } else {
          preview.className = 'rule-preview ok';
          preview.innerHTML = '<strong>' + esc(v.day) + ':</strong> ' +
            esc(v.effective.start) + '–' + esc(v.effective.end) + ' is allowed for this group.';
        }
      } catch (err) {
        preview.style.display = 'none';
      }
    }

    function wireRulePreview(containerId) {
      const m = FORM_MAP[containerId];
      if (!m) return;
      ['dateId', 'startId', 'endId'].forEach((k) => {
        const el = document.getElementById(m[k]);
        if (el) {
          el.addEventListener('change', () => previewRulesFor(containerId));
          el.addEventListener('input', () => previewRulesFor(containerId));
        }
      });
      previewRulesFor(containerId);
    }

    // Seed each form with one empty guest row so the layout doesn't look empty.
    // (Actually start with zero -- user clicks "+ Add guest" if they want one.)
    // Wire live preview after the DOM is ready.
    document.addEventListener('DOMContentLoaded', () => {
      wireRulePreview('guests-list');
      wireRulePreview('bn-guests-list');
      wireRulePreview('tp-guests-list');
    });

    // -------------------------------------------------------------
    // Club Rules table renderer
    // -------------------------------------------------------------
    async function loadRulesTable() {
      const container = document.getElementById('rules-table-container');
      try {
        const res = await fetch('/api/rules');
        const data = await res.json();
        const days = ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Holidays'];
        const engineCats = new Set(['Full, Life, Non-Resident, National, Sub-Full, Golf Members',
          'Guests of Full, Life, National, Non-Resident & Sub-Full Golf Members']);
        let html = '<div class="rules-wrap"><table class="rules-table"><thead><tr>';
        html += '<th>Category</th>';
        days.forEach((d) => { html += '<th>' + d + '</th>'; });
        html += '</tr></thead><tbody>';
        (data.table || []).forEach((row) => {
          const isEngine = engineCats.has(row.category);
          const cls = isEngine ? 'engine-driven' : '';
          html += '<tr class="' + cls + '"><td class="cat">' + esc(row.category) +
            (isEngine ? '<span class="badge">active</span>' : '') + '</td>';
          days.forEach((d) => { html += '<td>' + esc((row.cells || {})[d] || '') + '</td>'; });
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        html += '<p style="font-size:0.8rem;color:#666;margin-top:.75rem;">Rows highlighted as <strong>active</strong> are the ones the booker enforces (Full Member + Guests of Full Member). Other rows are shown for reference. Table version: ' + esc(data.tableVersion || 'unknown') + '.</p>';
        container.className = '';
        container.innerHTML = html;
      } catch (err) {
        container.className = 'empty-state';
        container.textContent = 'Failed to load rules: ' + err.message;
      }
    }

    // Submit booking
    async function submitBooking(e) {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Adding...';

      const dateInput = document.getElementById('date').value; // YYYY-MM-DD
      const [y, m, d] = dateInput.split('-');
      const date = m + '/' + d + '/' + y; // Convert to MM/DD/YYYY

      const body = {
        date: date,
        start: document.getElementById('start').value,
        end: document.getElementById('end').value,
        partners: document.getElementById('partners').value,
        guests: collectGuests('guests-list'),
        transport: document.getElementById('transport').value,
      };

      try {
        const res = await fetch('/api/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.success) {
          const note = data.booking && data.booking.ruleNotice
            ? ' Window auto-shifted: ' + data.booking.timeWindow.start + '–' + data.booking.timeWindow.end + '.'
            : '';
          showToast('Booking added.' + note, 'success');
          document.getElementById('partners').value = '';
          document.getElementById('guests-list').innerHTML = '';
          previewRulesFor('guests-list');
          showTab('queue');
        } else {
          showToast(data.error || 'Something went wrong.', 'error');
        }
      } catch (err) {
        showToast('Network error. Try again.', 'error');
      }

      btn.disabled = false;
      btn.textContent = 'Add Booking';
    }

    // Load and display bookings
    async function loadBookingsList() {
      const container = document.getElementById('bookings-list');
      try {
        const res = await fetch('/api/bookings');
        const bookings = await res.json();

        if (bookings.length === 0) {
          container.innerHTML = '<div class="empty-state">No bookings yet. Add one to get started!</div>';
          return;
        }

        // Sort: pending first, then by date
        bookings.sort((a, b) => {
          const order = { pending: 0, in_progress: 1, failed: 2, completed: 3 };
          if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
          return new Date(a.date) - new Date(b.date);
        });

        function renderDiagnostics(bid, diags) {
          var rows = diags.map(function(d, i) {
            var body;
            if (d.event === 'guest_add_failed') {
              var esc = function(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
              var preStyle = 'white-space:pre-wrap;word-break:break-all;background:#222;color:#eee;padding:.5rem;border-radius:4px;font-size:.7rem;max-height:400px;overflow:auto;';
              body =
                '<div><b>Guest:</b> "' + (d.guestName || '') + '" (target slot ' + d.targetSlot + ')</div>' +
                '<div><b>Attempts:</b> ' + (d.attempts || []).join(' &rarr; ') + '</div>' +
                '<div><b>Slot names before:</b> ' + JSON.stringify(d.slotsBefore) + '</div>' +
                '<div><b>Slot names after:</b> ' + JSON.stringify(d.slotsAfter) + '</div>';
              if (d.candidates && d.candidates.length) {
                body += '<details style="margin-top:.5rem;"><summary>Modal input candidates (' + d.candidates.length + ')</summary>' +
                  '<pre style="' + preStyle + '">' + esc(JSON.stringify(d.candidates, null, 2)) + '</pre></details>';
              }
              if (d.modalHtml) {
                body += '<details style="margin-top:.5rem;" open><summary>Guest Registration modal HTML</summary>' +
                  '<pre style="' + preStyle + '">' + esc(d.modalHtml) + '</pre></details>';
              }
              body += '<details style="margin-top:.5rem;"><summary>Guests-panel HTML snippet</summary>' +
                '<pre style="' + preStyle + '">' + esc(d.panelHtml || '(none captured)') + '</pre></details>';
            } else if (d.event === 'partial_booking') {
              body =
                '<div><b>Slot:</b> ' + d.chosenTime + ' on ' + d.targetDate + '</div>' +
                '<div><b>Players on row:</b> ' + d.actualPlayers + ' / ' + d.expectedPlayers + ' expected</div>' +
                '<div><b>Row text:</b> <code style="font-size:.7rem;">' + (d.rowText || '').replace(/</g,'&lt;') + '</code></div>';
            } else if (d.event === 'guest_tba_fallback') {
              body =
                '<div><b>Guest:</b> "' + (d.guestName || '') + '" (slot ' + d.targetSlot + ')</div>' +
                '<div><b>Why:</b> ' + (d.strategyErrors || []).join(' &rarr; ') + '</div>' +
                '<div style="margin-top:.3rem;font-size:.75rem;">Slot was filled with <b>TBA</b> instead. Fix the name on Foretees if needed.</div>';
            } else {
              body = '<pre style="font-size:.7rem;">' + JSON.stringify(d, null, 2).replace(/</g,'&lt;') + '</pre>';
            }
            var isWarning = d.event === 'guest_tba_fallback';
            var color = isWarning ? '#a06800' : '#c44';
            var bg = isWarning ? '#fff8e8' : '#fff8f8';
            return '<div style="border-left:3px solid ' + color + ';padding:.4rem .6rem;margin:.3rem 0;background:' + bg + ';border-radius:4px;">' +
              '<div style="font-weight:600;color:' + color + ';font-size:.8rem;">' + d.event + ' &middot; <span style="color:#888;font-weight:400;">' + d.t + '</span></div>' +
              body +
            '</div>';
          }).join('');
          var anyErr = diags.some(function(d) { return d.event !== 'guest_tba_fallback'; });
          var summaryColor = anyErr ? '#c44' : '#a06800';
          return '<details style="margin-top:.5rem;"><summary style="cursor:pointer;color:' + summaryColor + ';font-weight:600;">Diagnostics (' + diags.length + ')</summary>' + rows + '</details>';
        }

        container.innerHTML = bookings.map(b => {
          const statusLabel = {
            pending: 'Scheduled',
            in_progress: 'Running Now',
            completed: 'Booked',
            partial: 'Booked (Partial)',
            failed: 'Failed',
          }[b.status] || b.status;

          var guestList = (b.guests || []).map(function(g) {
            return typeof g === 'string' ? g : (g.name + ' (' + g.type + ')');
          });
          var testBadge = b.testRun ? '<span style="display:inline-block;background:#9c4bcc;color:white;font-size:0.65rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:3px;margin-left:0.4rem;vertical-align:middle;">TEST</span>' : '';
          var triggerLabel = b.testRun
            ? 'Test fires today at ' + (b.triggerTime || '?') + ' ET'
            : 'Bot books on: ' + (b.triggerDate || '?') + ' at 6:58 AM ET';
          var ruleNoticeBlock = b.ruleNotice
            ? '<div class="booking-detail" style="margin-top:0.3rem;background:#fff8e8;border-left:3px solid #c08a20;padding:.3rem .5rem;color:#6e4a00;font-size:.78rem;border-radius:4px;">Auto-shifted per club rules: requested ' +
                esc((b.requestedWindow && b.requestedWindow.start) || '?') + '–' + esc((b.requestedWindow && b.requestedWindow.end) || '?') +
                ', booking ' + esc(b.timeWindow.start) + '–' + esc(b.timeWindow.end) + '.</div>'
            : '';
          return '<div class="booking-item ' + b.status + '">' +
            ((b.status === 'pending' || b.status === 'failed' || b.status === 'completed' || b.status === 'partial') ? '<div class="booking-actions"><button class="btn-danger" onclick="removeBooking(\\'' + b.id + '\\')">Remove</button></div>' : '') +
            '<div class="booking-date">' + b.date + testBadge + '</div>' +
            '<div class="booking-time">' + b.timeWindow.start + ' - ' + b.timeWindow.end + '</div>' +
            ruleNoticeBlock +
            '<div class="booking-detail">Partners: ' + (b.partners.length > 0 ? b.partners.join(', ') : 'Solo') + '</div>' +
            (guestList.length > 0 ? '<div class="booking-detail">Guests: ' + guestList.join(', ') + '</div>' : '') +
            '<div class="booking-detail">Transport: ' + b.transport + '</div>' +
            '<div class="booking-detail">' + triggerLabel + '</div>' +
            '<span class="booking-status status-' + b.status + '">' + statusLabel + '</span>' +
            (b.result && b.result.time ? '<div class="booking-detail" style="margin-top:0.3rem;color:#2d5a27;font-weight:600;">Booked: ' + b.result.time + '</div>' : '') +
            (b.status === 'partial' ? '<div class="booking-detail" style="margin-top:0.3rem;color:#8a6a00;font-weight:600;">Tee time secured. One or more guests/partners did not fill -- add them manually on Foretees.</div>' : '') +
            (b.result && b.result.error ? '<div class="booking-detail" style="margin-top:0.3rem;color:#c44;">Error: ' + b.result.error + '</div>' : '') +
            (b.result && b.result.diagnostics && b.result.diagnostics.length ? renderDiagnostics(b.id, b.result.diagnostics) : '') +
          '</div>';
        }).join('');
      } catch (err) {
        container.innerHTML = '<div class="empty-state">Failed to load bookings.</div>';
      }
    }

    // Remove a booking
    async function removeBooking(id) {
      if (!confirm('Remove this booking?')) return;
      try {
        const res = await fetch('/api/bookings/' + id, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          showToast('Booking removed.', 'success');
          loadBookingsList();
        } else {
          showToast(data.error || 'Could not remove.', 'error');
        }
      } catch (err) {
        showToast('Network error.', 'error');
      }
    }

    // Set default Book Now date to tomorrow
    (function() {
      const d2 = new Date();
      d2.setDate(d2.getDate() + 1);
      document.getElementById('bn-date').value = d2.toISOString().split('T')[0];
    })();

    // Test Precision defaults: trigger 5 min from now, play date 7 days out
    (function() {
      const d3 = new Date();
      d3.setDate(d3.getDate() + 7);
      document.getElementById('tp-date').value = d3.toISOString().split('T')[0];
      const t = new Date();
      t.setMinutes(t.getMinutes() + 5);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      document.getElementById('tp-trigger').value = hh + ':' + mm;
    })();

    async function submitTestPrecision(e) {
      e.preventDefault();
      const btn = document.getElementById('testprecision-btn');
      btn.disabled = true;
      btn.textContent = 'Scheduling...';

      const dateInput = document.getElementById('tp-date').value;
      const [y, m, d] = dateInput.split('-');
      const date = m + '/' + d + '/' + y;

      const body = {
        date: date,
        start: document.getElementById('tp-start').value,
        end: document.getElementById('tp-end').value,
        partners: document.getElementById('tp-partners').value,
        guests: collectGuests('tp-guests-list'),
        transport: document.getElementById('tp-transport').value,
        triggerTime: document.getElementById('tp-trigger').value,
      };

      try {
        const res = await fetch('/api/test-precision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.success) {
          const statusEl = document.getElementById('testprecision-status');
          const textEl = document.getElementById('testprecision-status-text');
          const launchInSec = Math.round(data.msUntilLaunch / 1000);
          const launchInMin = Math.floor(launchInSec / 60);
          const remSec = launchInSec % 60;
          textEl.innerHTML =
            '<strong>Trigger:</strong> ' + data.triggerTime + ' ET today<br>' +
            '<strong>Browser launches:</strong> in ~' + launchInMin + 'm ' + remSec + 's<br>' +
            '<strong>Booking ID:</strong> ' + data.bookingId + '<br><br>' +
            'Open <a href="#" onclick="showTab(\\'queue\\');return false;">My Queue</a> to watch the status, or tail the Heroku logs.';
          statusEl.style.display = 'block';
          btn.textContent = 'Test Scheduled';
        } else {
          showToast(data.error || 'Something went wrong.', 'error');
          btn.disabled = false;
          btn.textContent = 'Schedule Test Run';
        }
      } catch (err) {
        showToast('Network error. Try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Schedule Test Run';
      }
    }

    // Submit Book Now
    async function submitBookNow(e) {
      e.preventDefault();
      const btn = document.getElementById('booknow-btn');
      btn.disabled = true;
      btn.textContent = 'Starting...';

      const dateInput = document.getElementById('bn-date').value;
      const [y, m, d] = dateInput.split('-');
      const date = m + '/' + d + '/' + y;

      const body = {
        date: date,
        start: document.getElementById('bn-start').value,
        end: document.getElementById('bn-end').value,
        partners: document.getElementById('bn-partners').value,
        guests: collectGuests('bn-guests-list'),
        transport: document.getElementById('bn-transport').value,
      };

      try {
        const res = await fetch('/api/book-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('booknow-status').style.display = 'block';
          document.getElementById('booknow-btn').style.display = 'none';
          pollBookingStatus(data.bookingId);
        } else {
          showToast(data.error || 'Something went wrong.', 'error');
          btn.disabled = false;
          btn.textContent = 'Book Now';
        }
      } catch (err) {
        showToast('Network error. Try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Book Now';
      }
    }

    // Poll for booking result
    function pollBookingStatus(bookingId) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch('/api/bookings/' + bookingId);
          const booking = await res.json();
          if (booking.status === 'completed') {
            clearInterval(interval);
            document.getElementById('booknow-spinner').style.display = 'none';
            document.getElementById('booknow-status').querySelector('h2').textContent = 'Booking Successful!';
            document.getElementById('booknow-status').querySelector('h2').style.color = '#2d5a27';
            document.getElementById('booknow-status-text').innerHTML =
              '<strong style="color:#2d5a27;">Booked: ' + (booking.result && booking.result.time ? booking.result.time : 'Done') + '</strong>';
            resetBookNowForm();
          } else if (booking.status === 'partial') {
            clearInterval(interval);
            document.getElementById('booknow-spinner').style.display = 'none';
            document.getElementById('booknow-status').querySelector('h2').textContent = 'Tee Time Secured (Partial)';
            document.getElementById('booknow-status').querySelector('h2').style.color = '#8a6a00';
            document.getElementById('booknow-status-text').innerHTML =
              '<strong style="color:#8a6a00;">Booked: ' + (booking.result && booking.result.time ? booking.result.time : 'Done') + '</strong>' +
              '<div style="margin-top:0.5rem;color:#8a6a00;">One or more guests/partners did not fill. Open Foretees and add the missing players manually.</div>';
            resetBookNowForm();
          } else if (booking.status === 'failed') {
            clearInterval(interval);
            document.getElementById('booknow-spinner').style.display = 'none';
            document.getElementById('booknow-status').querySelector('h2').textContent = 'Booking Failed';
            document.getElementById('booknow-status').querySelector('h2').style.color = '#c44';
            document.getElementById('booknow-status-text').innerHTML =
              '<span style="color:#c44;">' + (booking.result && booking.result.error ? booking.result.error : 'Unknown error') + '</span>';
            resetBookNowForm();
          }
        } catch (err) { /* keep polling */ }
      }, 3000);
    }

    function resetBookNowForm() {
      const btn = document.getElementById('booknow-btn');
      btn.disabled = false;
      btn.textContent = 'Book Now';
      btn.style.display = 'block';
    }

    // ----- Probe (read-only DOM capture) -----

    // Default probe date to tomorrow
    (function() {
      const dp = new Date();
      dp.setDate(dp.getDate() + 1);
      document.getElementById('pr-date').value = dp.toISOString().split('T')[0];
    })();

    async function submitProbe(e) {
      e.preventDefault();
      const btn = document.getElementById('probe-btn');
      btn.disabled = true;
      btn.textContent = 'Starting...';

      const dateInput = document.getElementById('pr-date').value;
      const [y, m, d] = dateInput.split('-');
      const date = m + '/' + d + '/' + y;

      try {
        const res = await fetch('/api/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: date,
            start: document.getElementById('pr-start').value,
            end: document.getElementById('pr-end').value,
          }),
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('probe-results').innerHTML = '';
          document.getElementById('probe-status').style.display = 'block';
          document.getElementById('probe-spinner').style.display = 'block';
          const titleEl = document.getElementById('probe-status-title');
          titleEl.textContent = 'Probe Running...';
          titleEl.style.color = '#0077b6';
          document.getElementById('probe-status-text').textContent =
            'Logging in and walking the booking flow without booking anything. This takes 1-2 minutes.';
          btn.textContent = 'Running...';
          pollProbe(data.probeId);
        } else {
          showToast(data.error || 'Could not start probe.', 'error');
          btn.disabled = false;
          btn.textContent = 'Run Probe';
        }
      } catch (err) {
        showToast('Network error. Try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Run Probe';
      }
    }

    function pollProbe(id) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch('/api/probe/' + id);
          if (!res.ok) return;
          const run = await res.json();
          if (run.status === 'completed' || run.status === 'failed') {
            clearInterval(interval);
            renderProbeResult(run);
            const btn = document.getElementById('probe-btn');
            btn.disabled = false;
            btn.textContent = 'Run Probe';
          }
        } catch (err) { /* keep polling */ }
      }, 3000);
    }

    async function loadLatestProbe() {
      try {
        const res = await fetch('/api/probe-latest');
        const run = await res.json();
        if (!run) return;
        if (run.status === 'running') {
          document.getElementById('probe-status').style.display = 'block';
          document.getElementById('probe-spinner').style.display = 'block';
          pollProbe(run.id);
        } else if (run.status === 'completed' || run.status === 'failed') {
          renderProbeResult(run);
        }
      } catch (err) { /* ignore */ }
    }

    function renderProbeResult(run) {
      const statusEl = document.getElementById('probe-status');
      statusEl.style.display = 'block';
      document.getElementById('probe-spinner').style.display = 'none';
      const titleEl = document.getElementById('probe-status-title');
      const textEl = document.getElementById('probe-status-text');
      const caps = run.captures || [];

      if (run.status === 'failed' && caps.length === 0) {
        titleEl.textContent = 'Probe Failed';
        titleEl.style.color = '#c44';
        textEl.textContent = run.error || 'Unknown error.';
        document.getElementById('probe-results').innerHTML = '';
        return;
      }
      titleEl.textContent = run.status === 'failed' ? 'Probe Finished (with errors)' : 'Probe Complete';
      titleEl.style.color = run.status === 'failed' ? '#a06800' : '#2d5a27';
      textEl.innerHTML = caps.length + ' screen(s) captured for ' + esc(run.date || '') + '.' +
        (run.error ? ' <span style="color:#a06800;">Note: ' + esc(run.error) + '</span>' : '') +
        ' Expand each screen below.';

      const preStyle = 'white-space:pre-wrap;word-break:break-all;background:#1e1e1e;' +
        'color:#e0e0e0;padding:.6rem;border-radius:4px;font-size:.68rem;max-height:480px;overflow:auto;';

      document.getElementById('probe-results').innerHTML = caps.map(function(c) {
        var sel = '';
        if (c.selectors) {
          var rows = Object.keys(c.selectors).map(function(k) {
            var v = c.selectors[k];
            var disp, color;
            if (Array.isArray(v)) {
              disp = v.length ? v.join(', ') : '(none)';
              color = '#555';
            } else {
              disp = v;
              color = v > 0 ? '#2a7a55' : '#c44';
            }
            return '<tr><td style="padding:.1rem .6rem .1rem 0;color:#555;">' + esc(k) + '</td>' +
              '<td style="padding:.1rem 0;font-weight:600;color:' + color + ';">' + esc(disp) + '</td></tr>';
          }).join('');
          sel = '<details style="margin:.45rem 0;"><summary style="cursor:pointer;font-size:.8rem;color:#0077b6;">Selector health check</summary>' +
            '<table style="font-size:.72rem;border-collapse:collapse;margin-top:.3rem;">' + rows + '</table></details>';
        }
        var shot = c.screenshot
          ? '<div style="margin:.35rem 0;font-size:.8rem;"><a href="/screenshots-files/' +
            encodeURIComponent(c.screenshot) + '" target="_blank">View full-page screenshot</a></div>'
          : '<div style="margin:.35rem 0;font-size:.78rem;color:#999;">(no screenshot)</div>';
        var modalBlock = c.modalHtml
          ? '<details style="margin:.45rem 0;" open><summary style="cursor:pointer;font-size:.8rem;color:#0077b6;font-weight:600;">Guest Registration modal HTML</summary>' +
            '<pre style="' + preStyle + '">' + esc(c.modalHtml) + '</pre></details>'
          : '';
        return '<div class="card" style="margin-bottom:.75rem;">' +
          '<div style="font-weight:700;color:#0077b6;font-size:.95rem;">' + esc(c.step) + '</div>' +
          (c.note ? '<div style="font-size:.8rem;color:#666;margin:.25rem 0;">' + esc(c.note) + '</div>' : '') +
          '<div style="font-size:.72rem;color:#999;word-break:break-all;margin-top:.2rem;">' +
            esc(c.title || '(no title)') + ' &middot; ' + esc(c.url || '') + '</div>' +
          sel + shot + modalBlock +
          '<details style="margin-top:.4rem;"><summary style="cursor:pointer;font-size:.8rem;color:#0077b6;">Full page HTML (' +
            (c.html ? c.html.length : 0) + ' chars)</summary>' +
          '<pre style="' + preStyle + '">' + esc(c.html || '(none)') + '</pre></details>' +
        '</div>';
      }).join('');
    }

    // Toast notification
    function showToast(msg, type) {
      const existing = document.querySelector('.toast');
      if (existing) existing.remove();
      const el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------
logger.info('===================================');
logger.info('  Tee Time Booker - Starting Up');
logger.info(`  Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
logger.info(`  PID: ${process.pid}`);
logger.info('===================================');

// Validate required config
if (!process.env.USERNAME || !process.env.PASSWORD || !process.env.MEMBER_NAME) {
  logger.error('Missing required environment variables: USERNAME, PASSWORD, and MEMBER_NAME');
  logger.error('Set them as Heroku config vars (Settings tab) or in .env for local runs.');
  logger.error('MEMBER_NAME must match your name exactly as it appears on the Foretees tee sheet.');
  process.exit(1);
}

// Boot: gist-sync the bookings BEFORE accepting requests so a POST
// that lands in the boot window can't be silently overwritten when
// the sync overwrites the local file.  Also re-arm in-memory test
// timers from any pending testRun bookings that survived the gist
// (recovers tests that were scheduled before a dyno restart).
(async () => {
  try {
    await startScheduler();
  } catch (e) {
    logger.error(`startScheduler failed: ${e.message}`);
    logger.error(e.stack || '(no stack)');
  }

  // Re-arm in-memory setTimeouts for pending test bookings. Real
  // (non-test) scheduled bookings are driven by the daily cron in
  // src/scheduler.js, so they already survive restarts via the gist.
  try {
    const pendingTests = loadBookings().filter((b) => b.status === 'pending' && b.testRun && b.triggerEpochMs);
    if (pendingTests.length > 0) {
      logger.info(`*** BOOT: re-arming ${pendingTests.length} pending test booking(s) from gist-persisted state. ***`);
      for (const t of pendingTests) scheduleTestPrecisionRun(t);
    }
  } catch (e) {
    logger.error(`Test re-arm failed: ${e.message}`);
  }

  app.listen(PORT, () => {
    logger.info(`Dashboard running on port ${PORT}`);
    logger.info(`Open your Heroku app's URL (the "Open app" button) to manage bookings`);
  });
})();

// ---------------------------------------------------------------
// Keep-alive: ping ourselves every 20 minutes to prevent Heroku
// Eco dyno from sleeping (the scheduler must stay awake).
// Accepts KEEP_ALIVE_URL (explicit), RENDER_EXTERNAL_URL, or
// HEROKU_APP_NAME (Heroku doesn't set this automatically; user
// must opt in via config var).
// ---------------------------------------------------------------
const keepAliveUrl =
  process.env.KEEP_ALIVE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : '');
if (keepAliveUrl) {
  logger.info(`Keep-alive enabled: pinging ${keepAliveUrl} every 20 min.`);
  setInterval(() => {
    const http = require('https');
    http.get(keepAliveUrl, () => {}).on('error', () => {});
  }, 20 * 60 * 1000);
} else {
  logger.info('Keep-alive disabled (set KEEP_ALIVE_URL or HEROKU_APP_NAME to enable).');
}

// ---------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------
setInterval(() => {
  logger.info(`Heartbeat: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET -- alive.`);
}, 10 * 60 * 1000);

// ---------------------------------------------------------------
// Graceful shutdown. Heroku sends SIGTERM, then waits ~30s before
// SIGKILL. Flush any pending/in-flight gist push first so a save
// that landed inside the 1.5s debounce window isn't lost when the
// dyno dies.
// ---------------------------------------------------------------
let shuttingDown = false;
async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received. Flushing pending gist push and shutting down...`);
  try {
    await flushPending();
  } catch (e) {
    logger.error(`flushPending error during shutdown: ${e.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception (non-fatal): ${err.message}`);
  logger.error(err.stack);
});

process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled rejection (non-fatal): ${err.message || err}`);
});
