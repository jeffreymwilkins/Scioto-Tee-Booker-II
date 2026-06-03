// ---------------------------------------------------------------
// Club-rules engine.
//
// Reads rules.json and answers: given a date + a roster of guests
// (with types), what time intervals on that day may we book?
//
// All times are minutes from midnight in local club time
// (0 = midnight, 540 = 9:00 AM, 1440 = end of day).
//
// The booking dashboard requests a [start, end] window. We
// intersect that with the day's allowed intervals; if the result
// is non-empty we use it as-is. If empty, we shift to the nearest
// allowed interval, preserving the original window length where
// possible. The user told us to "book the next nearest time that
// can be booked" -- so adjustments are silent in the data, but the
// dashboard surfaces what changed.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', 'rules.json');
const MIN_USEFUL_WINDOW_MIN = 15;
const DEFAULT_WINDOW_LEN_MIN = 60;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let cached = null;
let cachedMtime = 0;

function loadRules() {
  const stat = fs.statSync(RULES_FILE);
  if (cached && stat.mtimeMs === cachedMtime) return cached;
  cached = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
  cachedMtime = stat.mtimeMs;
  return cached;
}

// "MM/DD/YYYY" -> "Tuesday" (etc.). Date-only, so TZ doesn't matter.
function dayOfWeek(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split('/').map(Number);
  return DAY_NAMES[new Date(y, m - 1, d).getDay()];
}

// "HH:MM" -> minutes from midnight
function timeToMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minToTime(min) {
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (m === 1440) return '23:59';
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Intersect two lists of [start,end] intervals. Returns merged result.
function intersect(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.start, y.start);
      const e = Math.min(x.end, y.end);
      if (e > s) out.push({ start: s, end: e });
    }
  }
  return mergeIntervals(out);
}

function mergeIntervals(list) {
  if (list.length === 0) return [];
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      out.push(sorted[i]);
    }
  }
  return out;
}

// Allowed intervals on `date` for the Full member + all listed guests.
// guests: [{ name, type: "Family" | "Guest" | "Social Guest" }, ...]
function allowedIntervalsFor(date, guests) {
  const rules = loadRules();
  const day = dayOfWeek(date);
  const engine = rules.engine || {};
  const memberDays = engine.memberWindows || {};
  const guestDays = engine.guestWindows || {};

  let allowed = memberDays[day] || [];
  for (const g of guests || []) {
    const type = (g && g.type) || 'Guest';
    const gWin = (guestDays[day] || {})[type] || [];
    allowed = intersect(allowed, gWin);
    if (allowed.length === 0) return [];
  }
  return allowed;
}

// Adjust a requested [startMin, endMin] window to fit allowed intervals.
// Strategy:
//   1) If the requested window intersects any allowed interval by >= 15 min,
//      use the earliest such intersection (clipped).
//   2) Else find the nearest allowed interval that starts at or after the
//      requested start. Use the first DEFAULT_WINDOW_LEN_MIN of it (capped
//      to interval end).
//   3) Else (only allowed time is earlier than requested) use the last
//      DEFAULT_WINDOW_LEN_MIN of the latest allowed interval before
//      requested start.
//   4) Else (no allowed time that day) return null.
function shiftToAllowed(requestedStart, requestedEnd, allowed) {
  if (allowed.length === 0) return null;
  const reqLen = Math.max(requestedEnd - requestedStart, DEFAULT_WINDOW_LEN_MIN);

  // 1. Useful intersection
  const overlap = intersect(
    [{ start: requestedStart, end: requestedEnd }],
    allowed
  );
  const useful = overlap.find((iv) => iv.end - iv.start >= MIN_USEFUL_WINDOW_MIN);
  if (useful) return { start: useful.start, end: useful.end };

  // 2. Nearest allowed interval starting at or after requested start
  const later = allowed.find((iv) => iv.end > requestedStart);
  if (later) {
    const s = Math.max(later.start, requestedStart);
    const e = Math.min(s + reqLen, later.end);
    return { start: s, end: e };
  }

  // 3. Fall back to last allowed interval before requested start
  const earlier = allowed[allowed.length - 1];
  if (earlier) {
    const e = earlier.end;
    const s = Math.max(earlier.start, e - reqLen);
    return { start: s, end: e };
  }

  return null;
}

// Public: validate + adjust. Returns:
//   { ok: true, original, effective, adjusted, day, allowed, reason? }
//   or { ok: false, reason, day, allowed: [] } if no playable time at all.
function evaluateBooking({ date, start, end, guests }) {
  const day = dayOfWeek(date);
  const allowed = allowedIntervalsFor(date, guests || []);
  const reqStart = timeToMin(start);
  const reqEnd = timeToMin(end);
  const original = { start, end };

  if (allowed.length === 0) {
    return {
      ok: false,
      day,
      allowed: [],
      original,
      reason: buildNoPlayReason(date, guests || []),
    };
  }

  const shifted = shiftToAllowed(reqStart, reqEnd, allowed);
  if (!shifted) {
    return {
      ok: false,
      day,
      allowed,
      original,
      reason: buildNoPlayReason(date, guests || []),
    };
  }

  const effective = { start: minToTime(shifted.start), end: minToTime(shifted.end) };
  const adjusted = effective.start !== start || effective.end !== end;
  return {
    ok: true,
    day,
    allowed,
    original,
    effective,
    adjusted,
    reason: adjusted ? buildAdjustReason(date, guests || [], original, effective) : null,
  };
}

function buildAdjustReason(date, guests, original, effective) {
  const day = dayOfWeek(date);
  const guestSummary = guests.length
    ? ` with ${guests.length} guest${guests.length === 1 ? '' : 's'} (${guests.map((g) => g.type).join(', ')})`
    : '';
  return `${day}${guestSummary}: requested ${original.start}-${original.end} adjusted to ${effective.start}-${effective.end} per club rules.`;
}

function buildNoPlayReason(date, guests) {
  const day = dayOfWeek(date);
  if (guests.length === 0) {
    return `${day}: no allowed play window for Full Members on this day per club rules.`;
  }
  return `${day}: this combination of guest types (${guests.map((g) => g.type).join(', ')}) has no overlapping allowed window with the member. Try a different day or remove the restricted guest.`;
}

// Normalize guests received from the dashboard. Accepts:
//   ["Bob Smith", ...]                    (legacy string form)
//   [{ name, type }, ...]                 (new structured form)
// Empty names are dropped. Missing type defaults to "Guest".
function normalizeGuests(input) {
  if (!input) return [];
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, type: 'Guest' }));
  }
  if (!Array.isArray(input)) return [];
  return input
    .map((g) => {
      if (typeof g === 'string') return { name: g.trim(), type: 'Guest' };
      if (g && typeof g === 'object') {
        return { name: String(g.name || '').trim(), type: String(g.type || 'Guest') };
      }
      return null;
    })
    .filter((g) => g && g.name);
}

module.exports = {
  loadRules,
  dayOfWeek,
  evaluateBooking,
  allowedIntervalsFor,
  normalizeGuests,
  timeToMin,
  minToTime,
  DAY_NAMES,
};
