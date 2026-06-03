// ---------------------------------------------------------------
// Bookings persistence.
//
// Local `bookings.json` is the synchronous, in-process source of
// truth used by every read and write. A private GitHub Gist is the
// durable copy that survives Heroku dyno cycling:
//
//   * Boot: syncFromGistOnBoot() overwrites the local file with the
//     gist contents BEFORE anything else reads bookings.json. Retries
//     a few times on transient failure.
//   * Save: writes the local file synchronously (instant), then
//     schedules a fire-and-forget, debounced PATCH to the gist.
//   * Shutdown: flushPending() awaits any in-flight or pending push
//     so SIGTERM doesn't drop a save the dyno just accepted.
//
// Critical-path reads/writes during the 6:58/7:00 ET window therefore
// never touch the network. The gist round-trip happens in the
// background after the in-memory queue has already been updated.
//
// Safety invariant: we NEVER push to the gist unless the boot fetch
// succeeded (or gist was disabled). Otherwise a transient network
// failure at boot would let the empty-default local file overwrite
// the real queue on the gist on the first save.
//
// If GIST_ID + GIST_TOKEN are not set (e.g., local dev), the gist
// side is a no-op and the store is just the local file.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const BOOKINGS_FILE = path.join(__dirname, '..', 'bookings.json');
const GIST_FILENAME = 'bookings.json';
const GIST_API = 'https://api.github.com';
const GIST_DEBOUNCE_MS = 1500;
const BOOT_FETCH_ATTEMPTS = 3;
const BOOT_FETCH_RETRY_MS = 2000;

const GIST_ID = process.env.GIST_ID || '';
const GIST_TOKEN = process.env.GIST_TOKEN || '';

// Set true once syncFromGistOnBoot finishes successfully (or has
// nothing to do because gist is disabled). Until then, saveBookings()
// will not push to the gist -- preventing a stale local file from
// overwriting the real queue when boot sync failed.
let bootSyncOk = false;

function gistEnabled() {
  return Boolean(GIST_ID && GIST_TOKEN);
}

function loadBookings() {
  if (fs.existsSync(BOOKINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
    } catch (e) {
      logger.error(`Failed to parse bookings.json: ${e.message}`);
    }
  }
  return [];
}

function writeLocalFile(bookings) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}

function saveBookings(bookings) {
  writeLocalFile(bookings);
  scheduleGistPush();
}

// Debounced background push. Coalesces bursts of saves (e.g. status
// transitions during a booking run) into one API call. Always reads
// the current on-disk contents at flush time so the gist reflects the
// latest committed state, not a stale snapshot.
let pushTimer = null;
let pushInFlight = false;
let pushAgainWhenDone = false;

function scheduleGistPush() {
  if (!gistEnabled()) return;
  if (!bootSyncOk) {
    // Boot fetch hasn't succeeded yet (or failed all retries). Pushing
    // now would risk clobbering the gist with the empty-default local
    // file. Skip; the next dyno cycle gets another chance to boot-sync.
    return;
  }
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    flushToGist();
  }, GIST_DEBOUNCE_MS);
}

async function flushToGist() {
  if (!gistEnabled() || !bootSyncOk) return;
  if (pushInFlight) {
    pushAgainWhenDone = true;
    return;
  }
  pushInFlight = true;
  let content;
  try {
    content = fs.readFileSync(BOOKINGS_FILE, 'utf-8');
  } catch (e) {
    logger.error(`flushToGist: cannot read local file: ${e.message}`);
    pushInFlight = false;
    return;
  }
  try {
    const res = await fetch(`${GIST_API}/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tee-time-booker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: { [GIST_FILENAME]: { content } },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`Gist push failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    } else {
      logger.info(`Gist push ok (${content.length} bytes).`);
    }
  } catch (e) {
    logger.error(`Gist push error: ${e.message}`);
  } finally {
    pushInFlight = false;
    if (pushAgainWhenDone) {
      pushAgainWhenDone = false;
      scheduleGistPush();
    }
  }
}

// Awaits any pending/in-flight push so SIGTERM doesn't drop a save
// that was still inside the debounce window. Heroku gives ~30 s after
// SIGTERM before SIGKILL, which is plenty for a gist round-trip.
async function flushPending() {
  if (!gistEnabled() || !bootSyncOk) return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
    await flushToGist();
  }
  // If a push was already in flight when SIGTERM hit, wait it out.
  // Also catches a re-push triggered by pushAgainWhenDone.
  while (pushInFlight) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function fetchGistOnce() {
  const res = await fetch(`${GIST_API}/gists/${GIST_ID}`, {
    headers: {
      'Authorization': `Bearer ${GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tee-time-booker',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Called once from startScheduler() before anything else reads
// bookings.json. Tries a few times to fetch the gist and overwrite
// the local file. On total failure, leaves bootSyncOk=false so
// subsequent saves stay file-only and the gist is preserved
// untouched until the next dyno cycle gets another chance.
async function syncFromGistOnBoot() {
  if (!gistEnabled()) {
    logger.info('Gist persistence disabled (GIST_ID / GIST_TOKEN not set). Using local file only.');
    bootSyncOk = true; // file-only mode is "synced" by definition
    return;
  }
  logger.info(`Gist persistence enabled. Fetching bookings from gist ${GIST_ID}.`);

  let data;
  for (let attempt = 1; attempt <= BOOT_FETCH_ATTEMPTS; attempt++) {
    try {
      data = await fetchGistOnce();
      break;
    } catch (e) {
      // 401/403/404 are not retryable -- bad token or bad gist id.
      const fatal = e.status === 401 || e.status === 403 || e.status === 404;
      const isLast = attempt === BOOT_FETCH_ATTEMPTS;
      logger.error(`Gist fetch attempt ${attempt}/${BOOT_FETCH_ATTEMPTS} failed: ${e.message}`);
      if (fatal || isLast) {
        logger.error('Gist boot sync FAILED. Running file-only for this dyno lifetime. Gist will be re-synced on the next restart.');
        return; // bootSyncOk stays false -- pushes blocked
      }
      await new Promise((r) => setTimeout(r, BOOT_FETCH_RETRY_MS));
    }
  }

  const file = data.files && data.files[GIST_FILENAME];
  if (!file) {
    // First-time gist: no bookings.json yet. Mark boot-sync ok so we
    // can seed the gist from current local state on the next save.
    logger.info(`Gist has no ${GIST_FILENAME} file yet. Will seed it on next save.`);
    bootSyncOk = true;
    scheduleGistPush();
    return;
  }
  let content = file.content;
  // Gists truncate files >1MB; in that case GitHub returns a
  // raw_url we can fetch separately. Our payload is tiny so this
  // shouldn't trip, but guard anyway.
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url);
    if (raw.ok) content = await raw.text();
  }
  try {
    JSON.parse(content); // validate before overwriting local
  } catch (e) {
    logger.error(`Gist content is not valid JSON (${e.message}). Keeping local file as-is and disabling pushes.`);
    return; // bootSyncOk stays false -- never push over invalid gist content
  }
  fs.writeFileSync(BOOKINGS_FILE, content);
  const count = JSON.parse(content).length;
  logger.info(`Gist sync ok: loaded ${count} booking(s) from gist into local file.`);
  bootSyncOk = true;
}

module.exports = {
  loadBookings,
  saveBookings,
  syncFromGistOnBoot,
  flushPending,
  gistEnabled,
  BOOKINGS_FILE,
};
