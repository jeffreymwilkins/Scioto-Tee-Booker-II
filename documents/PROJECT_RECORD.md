# Tee Time Booker — Project Record

**Last updated:** 2026-05-31
**Owner:** Jeffrey G Wilkins
**Live app (the owner's dashboard):** <https://tee-time-booker-22be88cf5377.herokuapp.com>
**Repo:** <https://github.com/jimmyttt21/tee-time-booker>

> **Claude: this is the live site address.** The sandbox has outbound
> network access, so you can fetch read-only endpoints off this URL
> yourself (e.g. `GET /api/probe-latest`) instead of asking the owner to
> run anything or paste output. See §5 (no terminal) and §6 (checking
> the Probe).

This document is the durable record of what the tee-time-booker app is,
how it works, how it gets deployed, and how Claude should work with the
owner. Keep it up to date — it is the first thing a new Claude session
should read after the session-specific handoff.

---

## 1. What the app does (in plain English)

The app books tee times at Scioto Country Club's Foretees system the
moment the booking window opens, 7 days in advance. Scioto opens the tee
sheet at exactly 7:00:00 AM ET, and slots fill within seconds. A human
clicking refresh can't reliably win — the bot can.

Workflow for one scheduled booking:

1. The owner schedules a desired play date through the web dashboard
   (e.g. "I want to play next Saturday between 9:00 and 11:00, with
   these two partners and one guest").
2. At **6:58 AM ET** on the day 7 days before the play date, a cron job
   wakes the bot. It logs in to Foretees and navigates as far as it can.
3. At **6:59:00 ET** it begins hammering the tee-sheet URL every 100 ms.
4. The instant the page returns the real tee sheet at **7:00:00 ET**,
   the bot picks the best slot in the owner's time window **and clicks
   it in a single in-browser call** (sub-300 ms gap). Foretees then
   holds that slot for several minutes while the bot fills in players
   (member partners + non-member guests, including the built-in TBA
   placeholder) and submits at human pace.
5. The bot **re-fetches the tee sheet and confirms the member's name
   appears on the booked slot** before declaring success. A booking
   record in `bookings.json` records the outcome.

Player count rules: self + up to 3 others (any mix of member partners
and non-member guests). The dashboard and server both enforce this cap.

The app also encodes Scioto's printed **play-window rules** (when each
member category and their guests may play). When the owner asks for a
window that violates the rules — e.g. a non-Family guest at 8 AM on a
Saturday — the server **silently auto-shifts** the booking window to
the nearest allowed time before queuing the run, and the dashboard
shows the adjustment. The rules table is editable via `rules.json`
(see §2.3) and rendered read-only in a dedicated Club Rules tab.

---

## 2. How it's built

### 2.1 Stack

- **Runtime:** Node.js on a Heroku Eco dyno (Docker container, defined in
  `Dockerfile` + `heroku.yml`).
- **Web layer:** Express, serving a single-page dashboard and JSON APIs.
- **Scheduling:** `node-cron` for the daily 6:58 AM ET trigger.
- **Browser automation:** Playwright (Chromium) for logging in and
  driving the Foretees web UI.
- **Storage:** `bookings.json` on the local (ephemeral) dyno disk is
  the synchronous source of truth for every read/write. A private
  GitHub Gist (`GIST_ID` + `GIST_TOKEN` config vars) is the durable
  mirror — fetched at boot to rehydrate the local file, and updated
  via a debounced background PATCH on every save. See
  `src/store.js` and §4 below.
- **Keep-alive:** the dyno pings itself every 20 minutes to stay warm
  (Eco dynos sleep after 30 minutes idle).
- **Timezone:** `TZ=America/New_York` is set on the dyno; all time
  helpers in `src/time.js` use `Intl` APIs to stay timezone-explicit.

### 2.2 Repo layout

```
~/tee-time-booker/
├── server.js          Express dashboard + scheduler boot + keep-alive
├── src/
│   ├── booker.js      Playwright automation (login, navigate, book, partners, guests)
│   ├── scheduler.js   node-cron daily 6:58 ET trigger + startup recovery
│   ├── rules.js       Club play-window engine (intersect + auto-shift)
│   ├── time.js        Timezone-explicit helpers (Intl-based)
│   ├── config.js
│   └── logger.js
├── rules.json         Scioto play-window table (display text + minute intervals)
├── Dockerfile         Container image (Node + Playwright + Chromium)
├── heroku.yml         Heroku container build manifest
├── Procfile           Heroku process entrypoint
├── bookings.json      Booking queue (read/written by web + scheduler)
├── HANDOFF.md         Working handoff between Claude sessions
└── PROJECT_RECORD.md  (this file)
```

### 2.3 Key code paths

**`src/booker.js`**
- `run()` — "Book Now" path. Login → navigate → tee sheet → select slot
  → fill form → submit. Retries up to 5 slots if Foretees rejects with
  "Minimum Player Limit". **Checks `submitBooking()`'s return value** —
  treats `false` as failure (was previously ignored).
- `runPrecision()` — Scheduled 6:58 AM path. Same login/navigate as
  `run()` but waits until `(openTime − 1 minute)` then polls the
  tee-sheet URL **at a two-speed cadence** (2026-05-27 fix): 1000 ms
  intervals before the server clock hits 7:00 ET, then 100 ms intervals
  after, until the real sheet loads. Replaces the previous flat 100 ms
  cadence, which produced up to ~600 identical requests per minute on
  one ForeTees session and almost certainly triggered the 5/27 Session
  Error 3. Then calls `selectTeeTimeFast()` to click the best slot,
  **checks `detectSessionError()`**, and on a hit re-navigates to the
  tee sheet (releases the held slot server-side) and re-picks with the
  failed time on a skip list — up to 3 attempts. Honors
  `booking.bookingOpenTimeOverride` (the Test 7AM tab uses this to
  simulate the 7 AM window at an arbitrary time). Wrapped in a 10-minute
  `Promise.race` watchdog (PR #19). PR #21 (2026-05-14): the watchdog
  catch now schedules `browser.close()` **fire-and-forget** instead of
  awaiting it, because a hung Playwright session can make `close()`
  itself stall — silently re-introducing the very hang the watchdog
  exists to escape. `runPrecision` is now guaranteed to return.
- `selectTeeTime(skipTimes)` — Used by `run()`. Needed spots = 1 +
  partners + guests. Picks the slot whose open-count is closest to
  needed, then breaks ties by closeness to the owner's preferred start
  time. Records `this.chosenTime` for later verification.
- `selectTeeTimeFast(skipTimes)` — **Speed-optimized variant used by
  `runPrecision()`.** Picks the best slot AND clicks the button in a
  SINGLE `page.evaluate()` call, eliminating 3–4 Node↔browser
  round-trips at the most time-sensitive moment of the day. Saves
  roughly 200–500 ms vs. `selectTeeTime`. Records `this.chosenTime`.
- `fillBookingForm()` — Sets self transport, then fills slots **2..G+1
  with guests** and slots **G+2.. with partners**. Slot ordering
  reversed in PR #24 (2026-05-14) — all guests belong to the booking
  member (self), so Foretees expects them adjacent to slot 1.
  Putting partners between self and guests triggers the "Player/Guest
  Association" confirmation modal; placing guests first avoids it
  outright. The `nextSlot <= 4` loop bound naturally handles every
  combination of 0–3 guests with 0–3 partners. Stays human-paced —
  Foretees holds the slot once clicked.
- `addPartner(name, slot)` — Clicks Partners tab; searches the member
  list by last name + handicap pattern `(N.N)`. Falls back to a Members
  tab if the Partners tab doesn't surface the name.
- `addGuest(name, slot, guestType = 'Guest')` — Scioto modal flow
  rewritten in PR #27 (2026-05-14) based on owner-captured DOM.
  `guestType` (Family / Guest / Social Guest), added 2026-05-27,
  plumbs straight into `clickGuestCategory(guestType)` so the booking
  actually sits under the category the rules engine validated against.
  Sequence:
  1. `focusSlot(slotIdx)` clicks `#slot_player_row_<idx>`.
  2. `dismissAddingMemberOrGuestDialog()` closes the
     "Adding a Member or Guest" jQuery UI intro dialog if it popped
     (first slot-click of the session), ticking
     `Don't show this message again` so it stays gone.
  3. `switchToFormTab('Guests', '.ftMs-guestTypes')` →
     `clickGuestCategory('Guest')` opens the **Guest Registration**
     `.ui-dialog`.
  4. **TBA path** (name matches `/^tb[ad]$/i`):
     `clickTbaInRegistration()` clicks the "TBA" item.
  5. **Named-guest path:** `fillGuestRegistrationAndAdd(first, mi,
     last)` runs three strategies under a single try/finally:
     - **Strategy 1 — existing guest pick.** Scan
       `.ftGdb-guestSelect .ftMs-resultList .ftMs-listItem` for
       `"Last, First"` (whitespace-normalized, exact-then-prefix
       match; TBA excluded). Click → wait for the dialog to become
       `display: none`. This is the owner's happy path — works
       whenever the guest was pre-added on Foretees.
     - **Strategy 2 — new guest.** Click
       `[data-fttab=".ftGdb-guestAdd"]` to activate the Add Guests
       tab → fill `input[name="name_first"]` / `name_mi` /
       `name_last` → click the dialog button-pane
       `Add New Guest` → wait for close.
     - **Strategy 3 — TBA fallback.** If both above fail,
       re-switch to Search Guests and click TBA. Records a soft
       `guest_tba_fallback` diagnostic so the dashboard tells the
       owner which slot needs a manual name fix on Foretees.
  6. After-action `readSlotNames`/`didSlotFill` verification. On
     failure, dumps `panelHtml` + `modalHtml` +
     candidate-input list + screenshot into the `guest_add_failed`
     diagnostic.
- Helpers (PR #15 + PR #27, 2026-05-13 / 14):
  `parseGuestName(name)` splits "First [MI] Last";
  `focusSlot(slotIdx)` clicks `#slot_player_row_<idx>` so
  Foretees' "Select Player #N" pointer is on the right row;
  `dismissAddingMemberOrGuestDialog()` closes the intro dialog;
  `findGuestRegistrationModal()` / `waitForGuestRegistrationModal()`
  return a Playwright handle to the visible
  `.ui-dialog[title="Guest Registration"]`;
  `captureModalHtml(handle)` snapshots the modal for diagnostics;
  `waitForModalToClose(handle)` is the universal "Foretees accepted"
  signal (modal becomes `display: none`).
- `submitBooking()` — Clicks the Foretees Submit button using **strict
  selectors only** (`a.submit_request_button` / `a.submit_changes_button`
  or exact-text "Submit Request"/"Submit Changes"). Handles
  "Minimum Player Limit" (retry next slot) and "Member Already Playing"
  (hard fail). **PRs #23 + #25 (2026-05-14): unconditionally clicks
  any visible button matching `/^yes\s*,?\s*continue\b/i` before the
  generic OK/Confirm/Yes dismissal.** Foretees pops a "Player/Guest
  Association" confirmation modal ("Would you like to process the
  request as is? [No, Go Back] [Yes, Continue]") under conditions
  outside our control; the owner's directive is "the tee slot must
  be secured at all costs — anything else can be fixed manually."
  Records `yes_continue_clicked` in diagnostics with the actual
  button label. Returns `true` / `'partial'` / `false` based on
  `verifyBookingOnSheet()`'s tri-state result. **PR #23 also added a
  `verify_failed` diagnostic** to the `false` path capturing
  `chosenTime`, an 800-char page-text snippet, and up to 30 visible
  button labels — guarantees no failure has an empty diagnostics array.
- `verifyBookingOnSheet()` — **Source of truth for success.** After
  submit, re-navigates to the tee sheet and inspects the row at
  `this.chosenTime`. Returns one of: `'verified'` (member on slot AND
  expected player count), `'partial'` (member on slot but
  guests/partners short — tee time IS secured on Foretees),
  or `false` (member not on slot at all). PR #15 split the previous
  `false`/`partial` overlap so the dashboard can distinguish a
  secured-but-incomplete booking from a true failure.
- `probe()` / `_doProbe()` — **read-only diagnostic** (PR #30/#31,
  2026-05-22). Walks the entire booking flow and captures each
  screen's full HTML + a full-page screenshot + a `checkSelectors()`
  health table, **without ever submitting or adding a guest**. It
  briefly opens one open slot's booking form to inspect it; Foretees
  releases that hold on its own. `probeListSlots()` /
  `probeClickSlot()` / `probeHasGuestsTab()` sample slots in a time
  window so the probe lands on one where guests are allowed (morning
  slots hide the Guests tab). 8-minute watchdog. Used to recapture
  the Foretees DOM after the club changes their pages — see §6.
- `detectSessionError()` (added 2026-05-27) — checks both the
  `.ui-dialog-title` text and `slot_container[data-ftjson]`'s
  `page_start_title` + `page_start_notifications` for ForeTees'
  "Session Error N" page. Used by both `runPrecision` and `run` to
  catch and recover from the 5/27 failure mode (`page_start_title:
  "Session Error 3"` modal overlaying an empty Member_slot form)
  instead of pressing on into silent guest-add failures.

**`src/rules.js` + `rules.json`** (added 2026-05-27)
- `rules.json` encodes the printed Scioto play-window table two ways:
  a `table` array with verbatim cell text for every category × day
  (drives the **Club Rules** dashboard tab), and an `engine` object
  with minute-from-midnight intervals for `memberWindows` (Full Member)
  and per-`guestType` `guestWindows` (Family / Guest / Social Guest).
  `tableVersion: "2026-05-27"` so it's obvious when a new table is
  due. Replace the whole file when Scioto issues an update — both
  halves are owner-facing and easy to keep in sync.
- `evaluateBooking({date, start, end, guests})` intersects the Full
  Member's allowed intervals on the date's day-of-week with each
  guest's per-type intervals. If the requested window has ≥15 min of
  overlap with the result, returns that overlap as the effective
  window. Otherwise auto-shifts to the nearest allowed interval
  starting at or after the requested start, preserving the original
  60-min default length (capped to the interval end). Returns
  `{ok, day, original, effective, adjusted, allowed, reason}` —
  or `{ok:false, reason}` if no playable window exists on that day
  for the guest mix.
- `normalizeGuests(input)` accepts the legacy comma-string form
  (`"A, B"`) AND the structured form (`[{name, type}, ...]`) so
  bookings rehydrated from the gist keep working. Missing types
  default to "Guest". Used by both the API helpers and the booker
  constructor.
- Holidays: the rules engine has a `Holidays` key ready in both
  `memberWindows` and `guestWindows`, but no holiday detection wired
  up yet — day-of-week mapping only. Add a holiday flag + lookup
  when Scioto's holiday rules diverge from the Sunday rules in a way
  that matters.

**`server.js`** (API endpoints, all behind optional `DASHBOARD_PASSWORD`)
- `GET  /api/bookings` — list queued bookings with computed `triggerDate`
- `POST /api/bookings` — schedule a future booking. Runs through the
  internal `applyClubRules({...})` helper (2026-05-27): validates
  partners + guests ≤ 3, refuses duplicate play dates, runs
  `rules.evaluateBooking()`, **auto-shifts** the window if needed, and
  stores `timeWindow` (effective), `requestedWindow` (original), and
  `ruleNotice` (human-readable adjustment string) on the booking.
- `DELETE /api/bookings/:id` — remove from queue
- `POST /api/book-now` — immediate `booker.run()` for testing the form
  path without waiting for 7 AM. Also runs `applyClubRules`.
- `GET  /api/bookings/:id` — poll status (used by the dashboard)
- `GET  /api/rules` (2026-05-27) — serves `rules.json` verbatim for
  the Club Rules tab.
- `POST /api/rules/preview` (2026-05-27) — `{date, start, end, guests}`
  → `evaluateBooking()` result. The Schedule / Book Now / Test 7AM
  forms call this on every input change for the live
  ok/auto-shifted/blocked banner under the form.
- `POST /api/probe` — start a read-only Probe run (PR #30/#31).
  `GET /api/probe/:id` polls it; `GET /api/probe-latest` returns the
  most recent result. Probe results are kept in memory + an on-disk
  `probe-latest.json` (gitignored) — **never** in `bookings.json` or
  the gist, so the queue and scheduler are untouched.
- `POST /api/test-precision` — Test 7AM tab. Stores
  `triggerEpochMs` (absolute UTC ms) on the booking and delegates to
  the helper `scheduleTestPrecisionRun(booking)`, which schedules a
  one-shot `setTimeout`. The helper is also called at boot for any
  pending `testRun` rows surviving in the gist (PR #22, 2026-05-14),
  making test runs restart-survivable. Browser launches ~2.5 minutes
  before trigger; trigger must be between 3 minutes and 6 hours in
  the future. If a boot lands more than 10 min past the trigger,
  the test is auto-failed with a clear message instead of firing
  stale.
- **Boot ordering (PR #22, 2026-05-14):** `server.js`'s boot block is
  an async IIFE that `await`s `startScheduler()`, re-arms in-memory
  test timers for any pending testRun rows in the gist, **and then**
  binds the HTTP listener. Closes a ~1–2 s race where POSTs landing
  during the gist boot-sync could be silently overwritten when the
  sync completed.
- **`startedAt` field** (PR #22): set everywhere a booking flips to
  `in_progress` (book-now creation, test-precision firing,
  scheduler `checkAndRunBookings` pre-loop). The
  `DELETE /api/bookings/:id` stale-`in_progress` check (PR #21) now
  keys off `startedAt` — `createdAt` was wrong for real bookings
  because they're scheduled days in advance.

**`src/store.js`**
- `loadBookings()` / `saveBookings(arr)` — local-file source of truth
  (`bookings.json`). Reads and writes are synchronous so the 7:00 AM
  rapid-fire path never blocks on the network.
- `syncFromGistOnBoot()` — fetches the gist and overwrites the local
  file. Called once from `startScheduler()` before anything else
  reads `bookings.json`. No-op when `GIST_ID` / `GIST_TOKEN` are unset.
- Every `saveBookings()` schedules a debounced (1.5 s) background
  PATCH to the gist. Bursts of saves coalesce into one API call.
  Errors are logged but never thrown — the local file remains
  authoritative within a dyno's lifetime, and the next save (or
  reboot) will reconcile.

**`src/scheduler.js`**
- Daily cron at `(openTime − loginLeadMinutes)` ET, default `58 6 * * *`.
- `startScheduler()` is async — it awaits `syncFromGistOnBoot()` from
  `src/store.js` before scheduling cron or running startup-recovery.
  Replaces the old `seedFromEnvIfNeeded()` / `BOOKINGS_JSON` workflow
  (now removed).
- `checkAndRunBookings()` selects pending bookings whose
  `play_date − 7 days == today`. It **skips bookings with
  `testRun: true`** so the Test 7AM tab never accidentally re-fires
  through the cron. **Wrapped in an `isRunning` mutex** so cron +
  startup-recovery can't double-fire in the trigger window (PR #13).
  Sets `startedAt` on every booking that flips to `in_progress`.
- **Startup recovery (PR #21, 2026-05-14):**
  - `in_progress` `testRun` bookings are **immediately failed out** at
    boot with reason "Booking interrupted by dyno restart and could
    not auto-resume." Their in-memory `setTimeout` is gone, and
    blindly re-running them at the wrong time creates ghost bookings.
  - `in_progress` non-test bookings are re-run via
    `checkAndRunBookings()` as before.
  - The dashboard's "Running Now" no longer sticks when a precision
    run dies mid-flight — boot self-heals.

### 2.4 Dashboard tabs

1. **Schedule** — schedule a future booking (date must be 8+ days out).
   Bot fires at 6:58 AM ET, 7 days before play date.
2. **Book Now** — runs the booker immediately on a date 1–7 days out.
   Uses `booker.run()` (no rapid-fire wait). Good for verifying the
   form-filling path.
3. **Test 7AM** — one-shot dry run of the precision flow at a user-picked
   trigger time today. Verifies the entire timing path without waiting
   until tomorrow morning.
4. **Probe** — read-only diagnostic (PR #30/#31). Walks the whole
   booking flow and captures each screen's HTML + a full-page
   screenshot + a selector-health table **without booking anything**.
   Run it after Scioto/Foretees change their pages to recapture the
   DOM. See §6.
5. **My Queue** — view/remove queued bookings. Test bookings show a
   purple `TEST` badge. The queue is automatically mirrored to a
   private GitHub Gist (see §4), so dyno restarts no longer require
   any manual snapshot step. Cards now also surface an
   "Auto-shifted per club rules" line when the rules engine had to
   adjust the requested window.
6. **Club Rules** (added 2026-05-27) — read-only render of the
   `rules.json` table. Shows every member-category row (Full / Spouse
   / Junior / Juvenile / Guests of Full / Guests of Spouse / Social).
   The two rows the engine actively enforces (Full Member + Guests of
   Full) carry an "active" badge; the rest are reference-only. Replace
   `rules.json` to update — the page re-reads on reload.

Each booking form has separate inputs:
- **Member Partners** — Scioto member names (Partners tab → Members tab
  fallback)
- **Guests (Non-Members)** — a dynamic per-row list (2026-05-27): each
  guest has a name input + a **Family / Guest / Social Guest** type
  dropdown. The type travels with the booking and is used both by the
  rules engine (to pick the right play window) and by `addGuest()` (to
  click the matching ForeTees guest category). Type `TBA` (or `TBD`)
  as the name to use ForeTees' To-Be-Announced placeholder.
- A **live rule-preview banner** under each form polls
  `/api/rules/preview` on every input change: green when the requested
  window is allowed, amber when the engine will auto-shift, red when
  the guest mix has no playable window on that day.
- Total partners + guests is capped at 3 (server enforces).

---

## 3. Deployment

### 3.1 How it ships

Heroku auto-deploys from GitHub `main`. To ship a change, **merge a
feature branch into `main`** — Heroku takes it from there. Build takes
~2–3 minutes; the owner can watch the Heroku Activity tab.

The owner already wired up the Heroku ↔ GitHub integration in the
Heroku dashboard's Deploy tab. No further setup needed.

### 3.2 The exact sequence Claude should follow

1. Edit files on the session's designated feature branch.
2. Commit with a clear message.
3. `git push -u origin <feature-branch>` — this works from the sandbox.
4. Open a PR with `mcp__github__create_pull_request` (base: `main`,
   head: feature branch).
5. Merge with `mcp__github__merge_pull_request` (method: `merge`).
6. Heroku auto-deploys. Report success in plain English to the owner.

**Do not attempt `git push origin main` from the sandbox** — the proxy
returns 403. Only the feature branch is pushable directly. Merging into
`main` must go through the GitHub MCP API.

If the owner ever wants a click-to-merge PR instead of auto-merge, open
the PR and stop — they'll click Merge themselves.

---

## 4. Heroku configuration

Config vars currently set on the dyno:

| Var                   | Purpose                                                              |
|-----------------------|----------------------------------------------------------------------|
| `USERNAME`            | Scioto CC login                                                      |
| `PASSWORD`            | Scioto CC login                                                      |
| `MEMBER_NAME`         | `Jeffrey G Wilkins`                                                  |
| `TZ`                  | `America/New_York`                                                   |
| `KEEP_ALIVE_URL`      | The herokuapp.com URL (self-ping every 20 min)                       |
| `DEBUG_SCREENSHOTS`   | Off normally. Flip to `true` to capture screenshots in `/app/screenshots` (ephemeral) |
| `DASHBOARD_PASSWORD`  | Optional gate for the dashboard                                      |
| `GIST_ID`             | Private gist holding the durable `bookings.json` copy                |
| `GIST_TOKEN`          | Fine-grained PAT with `Gists: read & write` scope (no repo scope)    |

### Durable persistence: the bookings.json gist

The Heroku dyno's filesystem is wiped on every restart/redeploy, so
`bookings.json` cannot live on the dyno alone. A private GitHub Gist
holds the canonical copy:

- **Boot:** `src/store.js::syncFromGistOnBoot()` fetches the gist and
  overwrites the local `bookings.json` before the scheduler reads
  anything. Retries up to **3 times** with 2 s backoff on transient
  failure. 401/403/404 are treated as fatal (bad token or bad gist
  id) and short-circuit immediately.
- **Save:** every `saveBookings()` writes the local file
  synchronously (instant — the 7:00 AM critical path never blocks on
  the network), then schedules a debounced background PATCH to the
  gist (1.5 s coalescing window). Bursts of saves collapse into one
  API call.
- **Shutdown:** SIGTERM / SIGINT handlers in `server.js` call
  `flushPending()` from the store before `process.exit`. Any save
  still inside the 1.5 s debounce window is flushed to the gist
  before the dyno dies (Heroku gives ~30 s after SIGTERM — plenty
  for a gist round-trip).
- **Safety invariant — `bootSyncOk` flag:** until the boot fetch
  succeeds (or gist is disabled), **all pushes are blocked**.
  `saveBookings()` still updates the local file but does not PATCH
  the gist. This prevents a transient network failure at boot from
  letting the empty-default local file overwrite the real queue on
  the first save. The next dyno cycle gets another chance to
  boot-sync.
- **Source of truth:** the local file. The gist is the durable mirror
  that survives dyno cycling.

If `GIST_ID` / `GIST_TOKEN` are unset (e.g., local dev) the gist side
is a no-op. The gist's revision history doubles as a free audit log.

### Heroku Platform API access (for Claude)

Claude has direct Heroku Platform API access via an API token stored
in `./.env` as `HEROKU_API_KEY=...` (the `.env` file is in
`.gitignore`, never committed). A future Claude session can do
config-var changes, dyno restarts, log tailing, and release checks
from bash without involving the owner. Example:

```bash
. ./.env && curl -sS \
  -H "Authorization: Bearer $HEROKU_API_KEY" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  https://api.heroku.com/apps/tee-time-booker/config-vars
```

The token has full account access. Never echo it, log it, or commit
it. Don't add the path to git tracking. If it needs to be rotated,
the owner creates a new authorization at
`https://dashboard.heroku.com/account/applications` → Authorizations
→ Create authorization, and pastes the new value into `.env`.

Heroku CLI quick reference (for the owner, not Claude):

```bash
H=~/heroku-cli/heroku/bin/heroku

$H logs --tail -a tee-time-booker      # live logs
$H config -a tee-time-booker           # list env vars
$H config:set KEY=VALUE -a tee-time-booker
$H ps -a tee-time-booker               # dyno status
$H restart -a tee-time-booker          # force restart
$H releases -a tee-time-booker         # deploy history
```

---

## 5. Owner preferences and working style

**These are durable preferences. Follow them in every session.**

- **No terminal — ever.** The owner does not run CLI commands and does
  not want to. This is absolute and applies to **diagnostics too**, not
  just git. Claude does all git/PR/merge work via tool calls and the
  GitHub MCP API, **and fetches any diagnostic data itself** rather than
  asking the owner to run `curl`, tail logs, or copy-paste JSON. The
  sandbox has outbound network access, so:
  - **"Check the probe" → Claude fetches it.** `GET` the live
    `/api/probe-latest` off the dashboard URL (top of this doc),
    strip the `screenshot` blobs, and read the selector-health table
    back to the owner in plain English. See §6.
  - **Logs / screenshots / config** → use the Heroku Platform API
    token in `./.env` (§4), or fetch `/screenshots-files/<name>` and
    the per-booking `diagnostics` arrays. Never ask the owner to open
    a terminal to get this for you.
  - The owner's only interface is the **web dashboard** (clicking
    buttons) and chat. If a task seems to need the terminal, that's a
    signal to do it yourself, not to hand it to the owner.
- **Don't dump logs or diffs** unless asked. Explain results in plain
  English.
- **Repo scope:** GitHub MCP tools are restricted to
  `jimmyttt21/tee-time-booker`. Don't try anything else.
- **Branching:** every session has a designated feature branch (check
  the session's git instructions). Develop and push there. Merge into
  `main` via PR.
- **Heroku Config Vars:** the owner can flip these in the Heroku
  dashboard if asked (e.g. `DEBUG_SCREENSHOTS=true`).
- **Live UI testing:** the owner can't test the live UI for Claude. If
  Claude changes UI, describe what the owner should see and how to
  verify.
- **Auto-deploy:** assume merging to `main` ships it. If the owner wants
  a manual review step, they'll say so.

---

## 6. Recent work

### Probe-check workflow + docs (2026-05-31 session)

Branch: `claude/focused-faraday-coi5D`. Docs-only session — no code
changed.

The owner ran the Probe from the dashboard and asked Claude to "check
it." The first attempt went sideways: Claude looked for `probe-latest.json`
in the sandbox (it's gitignored and only ever exists on the dyno) and
then suggested the owner run `curl`/`jq` themselves. The owner pushed
back — **"I don't ever want to use the terminal… you set up the probe to
be seamless, I should not have to do all this work."** Correct.

The fix is a workflow, now codified: the sandbox **has outbound network
access**, so Claude fetches the probe result directly off the live
dashboard (`GET /api/probe-latest`), strips the base64 screenshots, and
reads the selector-health table back in plain English. Zero terminal,
zero copy-paste for the owner. Verified live this session against run
`probe_1780243925911` (play date 06/05/2026): completed cleanly, every
booking-form selector alive (tee sheet, all three tabs via `data-fttab`,
Guest Registration modal with first/last inputs) — ForeTees unchanged,
no code fix needed. One note: the requested 12:00–14:00 window had no
open slots, so the probe fell back to a 9:30 AM slot to exercise the
guest flow.

Docs updated (this commit): §5 "No terminal" expanded to explicitly
cover diagnostics (Claude fetches probe/logs/screenshots itself); §6
"To re-probe later" now spells out the owner-clicks-Run-Probe →
Claude-fetches-the-result flow with the exact endpoint; the live site
address is called out at the top of this doc and in HANDOFF.md's TL;DR.

### Club rules engine + Session Error 3 recovery (2026-05-27 session)

Branch: `claude/magical-davinci-AiSIo`. Two commits in one PR to `main`.

**Why this session happened.** The owner's 5/27 6:58 AM cron run
(play date 06/03/2026, 13:00–14:00, partner Jeffrey M Wilkins, guests
Chester Scott + Jeff Loehnis, transport C-H) failed with two
`guest_add_failed` diagnostics on slots 2 and 3 with empty
`slotsBefore` / `slotsAfter`. The captured
`slot_container[data-ftjson]` showed
`page_start_title: "Session Error 3"` and
`page_start_notifications: ["Sorry, but there was a problem with your session.","Please exit ForeTees and try again"]`
— ForeTees had served the Member_slot page with an undismissable
jQuery UI modal overlay and no fillable slot inputs. The booker had
no idea and silently failed downstream in `addGuest`. Separately, the
owner wanted the printed clubhouse "Tee Time Times" play-window rules
built into the app so the bot can auto-shift requested windows that
violate them.

**Commit `3f70820` — club-rules engine.**
- New `rules.json` at the repo root with two parallel views of the
  printed Scioto table: a `table` array (verbatim cell text for every
  category × day, drives the Club Rules tab) and an `engine` object
  (`memberWindows` + per-guest-type `guestWindows` as
  minute-from-midnight intervals).
- New `src/rules.js` with `evaluateBooking()` (intersect + auto-shift)
  and `normalizeGuests()` (accepts legacy comma-string AND structured
  `[{name, type}]` form so old bookings rehydrated from the gist keep
  working). Spec-tested against five scenarios from the failing
  diagnostic and adjacent cases: Wed 1pm + 2 Guests → no shift
  (5/27 booking was rules-compliant; failure was session-side), Sat
  8am + 1 Guest → shift to 12:00–13:00, Sun 2pm + non-Family guest →
  shift to 11:00–12:00, Sun 2pm + Family guest → no shift, Thu 11am
  solo → shift to 12:00–13:00 (Full Member's 10:30–12 Thursday blackout).
- `server.js` gained an `applyClubRules({...})` helper used by all
  three POST endpoints (`/api/bookings`, `/api/book-now`,
  `/api/test-precision`), plus `GET /api/rules` (table for display)
  and `POST /api/rules/preview` (live form feedback). Each booking
  record now carries `timeWindow` (effective), `requestedWindow`
  (original), and `ruleNotice` (the human-readable explanation when
  the engine shifted).
- Dashboard: per-guest **dynamic-row Guests input** (name + type
  dropdown), live ok/shift/blocked banner under every form, new
  **Club Rules** tab rendering `rules.json` (engine-driven rows
  badged "active"). My Queue cards surface the `ruleNotice` line.
- `src/booker.js`: constructor normalizes `booking.guests` to
  `{name, type}`; `addGuest(name, slot, guestType='Guest')` plumbs
  the type into `clickGuestCategory(guestType)` so what the engine
  validated is what actually books on ForeTees (matters Sat/Sun
  where Family vs. non-Family have different windows).
- `src/scheduler.js`: log lines render `name (type)` for guests.

**Commit `b066cd2` — Session Error 3 recovery + two-speed rapid-fire.**
- `detectSessionError()` reads both `.ui-dialog-title` and
  `slot_container[data-ftjson]`'s `page_start_title` /
  `page_start_notifications`, so the failure is caught whether the
  modal or the embedded JSON is the source of truth. Unit-tested
  against the exact failure HTML the owner sent.
- `_doRunPrecision` now wraps the slot click in a recovery loop:
  after `selectTeeTimeFast()`, calls `detectSessionError()`, and on
  a hit re-navigates to the tee sheet URL (releases the held slot
  server-side), adds the failed time to a skip list, and re-picks —
  up to 3 slot attempts. The non-precision `run()` loop does the
  same: detect → record `session_error_3` diag → skip to the next
  slot.
- **Two-speed rapid-fire.** The pre-7AM polling used a flat 100 ms
  interval, producing up to ~600 identical requests per minute on
  one ForeTees session — the most plausible trigger for the 5/27
  Session Error 3. The loop now polls every **1000 ms before 7:00 ET**
  (gentle keep-alive, ~60 hits) and switches to **100 ms after 7:00**
  (rapid catch). Per-attempt timeout is also adaptive (4 s slow / 2 s
  fast). The pre-open wait window is unchanged (`openTime - 1 min`
  for real bookings, `openTime` exactly for test-precision runs).

**Owner-visible behavior changes.**
- Booking forms now require a guest **type** per guest. Legacy queued
  bookings stored as comma-strings still book correctly (normalized
  at booker construction) but will all be treated as type "Guest".
- A scheduled booking whose window the rules engine shifted shows two
  times in My Queue — the requested window in the amber
  "Auto-shifted" line, the actual booking window in the big time
  display.
- 6:58 AM cron runs will look quieter in pre-7:00 logs (one
  attempt/sec instead of ten). The 7:00 race itself is unchanged.

**Open follow-ups (carried into next session).**
- **Live verification.** The next real 6:58 AM cron run is the only
  way to confirm the two-speed cadence + Session Error 3 recovery
  fully eliminates the failure mode the 5/27 booking hit. A
  `session_error_3` diagnostic appearing again *after* the slowdown
  would mean the cause is somewhere other than rate (cookie expiry,
  ttdata staleness, etc.) and the recovery loop's 3 attempts gives
  us the data to investigate.
- **Holidays.** `rules.json` has a `Holidays` key but no detection.
  Wire up a holiday list + per-booking flag when Scioto's holiday
  rules diverge meaningfully from Sunday.
- **Other member categories.** The engine enforces "Full" + "Guests
  of Full" only right now (matches the owner's `mship: "Full"` from
  the diagnostic ftjson). Adding Spouse / Junior / Juvenile is just
  more keys under `engine.memberWindows` and a config var to pick
  the active category.

### Shareable gift package — per-user config + setup guide (2026-05-22 session)

Branch: `claude/pensive-carson-WyNdd` (merged to `main` this session). The owner
wants to gift working copies of the booker to two other Scioto members (his dad
and a friend), each running on their own Heroku account with their own Scioto
credentials.

**Distribution model — GitHub template repository.** After weighing options, the
owner chose: each recipient gets their **own private, independent repository**
created from this repo via GitHub's **"Use this template"** feature. The owner
marks this repo as a template (Settings → General → Template repository), then
for each recipient does a short handshake: temporarily invite them as a
collaborator → they click "Use this template" to create their own copy → owner
removes their access. A template-created repo is fully independent (not a fork),
so removing access does not affect it. This gives complete isolation with **no
branch protection / rulesets needed** — recipients never have standing access to
the owner's repo. (A branch-protection ruleset was considered but abandoned:
GitHub gated it behind an organization account for this private repo.)

**Other decisions (owner-chosen):** Heroku hosting (~$5/mo each), free GitHub
Gist for persistence (same as the owner's app), no public one-click deploy button.

**Code changes (all safe for the owner's app — its config vars are already set):**
- `src/config.js` — removed the hardcoded `'Jeffrey G Wilkins'` fallback for
  `memberName`; it is now `process.env.MEMBER_NAME || ''`.
- `server.js` + `index.js` — boot validation now also requires `MEMBER_NAME`
  (previously only `USERNAME` / `PASSWORD`), with a clear error message. A
  recipient who forgets it fails fast instead of booking under a blank name.
- `server.js` — genericized the two dashboard partner-input placeholders and a
  log line that referenced an owner-specific URL.

**New `README.md`** — a complete, non-technical, step-by-step setup guide for
recipients. Part 1 is the template handshake (create GitHub account → gift-giver
invites → "Use this template" → gift-giver removes access). Remaining parts:
the storage Gist + token, Heroku account + Eco plan, creating the app, the one
`heroku stack:set container` step (with an "ask the gift-giver" option),
connecting Heroku to their own repo, all config vars, deploy, keep-alive, the
read-only Probe test, and day-to-day use. A printable PDF of the guide lives at
`documents/Tee-Time-Booker-Setup-Guide.pdf`.

**Owner's remaining manual steps to ship the gift:** mark the repo as a template
(Settings → General), then run the Part 1 handshake with each recipient.

### PR #30 + #31 — read-only Probe mode (2026-05-22 session)

Branch: `claude/epic-knuth-2uS1z`. PR #30 (`c9334c2` → merged as
`cb18b1a`) and PR #31 (`a22174b` → merged as `54f8068`), both
merged to `main`, Heroku auto-deployed.

**Why:** the owner reported Scioto/Foretees "may have changed"
their booking pages and asked for a durable way to keep the bot
working through such changes. The bot drives Foretees entirely
through hard-coded DOM selectors reverse-engineered from
owner-captured HTML, so the answer is a tool that recaptures the
live DOM on demand — instead of the owner hand-capturing each
screen (the workflow PRs #15 and #27 relied on).

**PR #30 — the Probe.** New **Probe** dashboard tab.
`booker.probe()` walks the entire booking flow and captures, for
every screen, the full HTML + a full-page screenshot + a
key-selector health table:

- Read-only and non-destructive — it opens pages and panels only,
  never clicks Submit, never adds a guest. It briefly opens one
  open slot's booking form to inspect it; Foretees releases that
  hold on its own.
- Every step is wrapped so one broken screen never aborts the run;
  8-minute watchdog.
- New `src/booker.js` methods: `probe()` / `_doProbe()`,
  `probeScreenshot()`, `checkSelectors()`, `probeOpenBookingForm()`.
- New `server.js` endpoints: `POST /api/probe`,
  `GET /api/probe/:id`, `GET /api/probe-latest`. Probe results live
  in memory + an on-disk `probe-latest.json` (gitignored) — never
  written to `bookings.json` or the gist, so the queue and
  scheduler are untouched.

**PR #31 — window targeting.** The first probe landed on an
8:00 AM slot, where Foretees restricts guests and hides the Guests
tab. The probe now takes a time window (default 12:00–17:00) and
samples up to 6 open slots until it finds one that exposes a
Guests tab. New methods `probeListSlots()`, `probeClickSlot()`,
`probeHasGuestsTab()`; `/api/probe` accepts `start`/`end`; the
Probe tab gains time inputs.

**Findings (probe run 2026-05-22, play date 05/27/2026): no
breaking changes.** Every selector and step the bot uses — tee
sheet, the four booking-form tabs (Partners/Members/Guests/TBD),
partner list, member search, guest categories, the Guest
Registration modal, TBD "X", and the Submit button — is present
and unchanged, matching the DOM cheatsheet in HANDOFF.md. The
probe even ran the bot's own `switchToFormTab` /
`clickGuestCategory` / `findGuestRegistrationModal` helpers live
and all succeeded. The only difference — a hidden/locked 5th
player row in the Foretees template — has no effect (Scioto is
`maxPlayers4`, `p5:"No"` on every slot) and was already noted in
the DOM cheatsheet. No booking-path code was changed.

**To re-probe later (the owner's flow):** the owner opens the
Dashboard → Probe tab → afternoon window → **Run Probe**, then tells
Claude *"check the probe."* That's all the owner does — no terminal,
no copy-paste.

**How Claude checks it (do this yourself):** the sandbox has outbound
network, so fetch the result straight off the live dashboard:

```bash
curl -s "https://tee-time-booker-22be88cf5377.herokuapp.com/api/probe-latest" \
  | jq 'del(.captures[].screenshot)'   # strip the base64 blobs (payload is ~550 KB)
```

`/api/probe-latest` returns the most recent run's full JSON (in-memory,
falling back to the gitignored on-disk `probe-latest.json`). Each
capture carries a `selectors` health table — **any selector that
dropped to 0 on the booking-form steps (05–10) is what to fix in
`src/booker.js`.** Read the result back in plain English: which screens
loaded, which selectors are alive, and whether ForeTees changed
anything. Add `?pw=<DASHBOARD_PASSWORD>` to the URL if the dashboard
password is set. Do **not** ask the owner to run the curl or paste the
JSON — that's the whole point of the Probe being server-side.

> Note: `probe-latest.json` is gitignored and lives only on the dyno's
> ephemeral disk, so it is **never** present in a fresh sandbox clone.
> The only way to see a run is the live `/api/probe-latest` endpoint
> above.

### PR #27 — `c2c1ecb` + `7538283` + `5ed96f5` + `979315e` → merged as `b86f861` (2026-05-14 final session)

**Guest-modal rewrite based on owner-captured DOM**

Branch: `claude/fix-guest-booking-issue-wqOVd`. Owner reported the
5/21 1:45 PM booking landed the member but **none of the three
named guests filled** — same outcome PR #15 was supposed to
prevent. Dashboard diagnostics showed
`registration-fill:Add New Guest` for every guest (the bot
believed the click succeeded), and `panelHtml` came back empty.

#### Root cause (uncovered when owner shared the real modal HTML)

This session was structured around the owner pasting DevTools
`outerHTML` of each Foretees window in the flow. Two surprises:

1. **There's an intro dialog before the modal.** First slot-click
   per session pops a jQuery UI `.ui-dialog` titled "Adding a
   Member or Guest" with body "You can add members or guests
   using the member selection tool on the right." and a
   `Don't show this message again` checkbox. The bot never knew
   about this and never dismissed it. The dialog modal-overlays
   the page, but `el.click()` from `page.evaluate` fires through
   the overlay — so the bot's focus-slot → Guests tab → Guest
   category → "Add New Guest" sequence all reported success
   while Foretees' app state was gated behind the still-open
   dialog and nothing actually landed.

2. **The Guest Registration dialog has TWO inner tabs.**
   `.ftGdb-tabs` has `Search Guests` (`data-fttab=".ftGdb-guestSelect"`,
   default active, contains a list of existing guests + TBA at
   the top) and `Add Guests` (`data-fttab=".ftGdb-guestAdd"`,
   hidden by default, contains `input[name="name_first"]` /
   `name_mi` / `name_last`). The form inputs are not visible
   until the Add Guests tab is clicked. PR #15's
   `fillGuestRegistrationAndAdd` did a document-wide search for
   "Add New Guest" then walked up to the smallest container with
   2+ visible inputs — with the form panel hidden, that walk
   left the modal entirely and matched inputs elsewhere on the
   page. The "Add New Guest" click then fired on the dialog's
   actual button (which is in `.ui-dialog-buttonpane`, outside
   either tab panel) with the modal's real `name_first` /
   `name_last` empty — Foretees silently rejected.

PR #27's earlier `c2c1ecb` commit (heading-anchored modal +
`<label for=...>` disambiguation) was a reasonable defense but
addressed a different theoretical bug; once the real HTML
arrived, the rewrite in `5ed96f5` superseded it.

#### Commits

- **`c2c1ecb` — Anchor on "Guest Registration" heading.**
  Initial defensive fix before the owner shared modal HTML.
  Walks up from the heading to the modal container, scopes
  input/button searches inside, disambiguates via
  `<label for=...>`, attribute hints, and DOM order. Guards
  against `firstInp === lastInp` collisions. Waits for the
  modal to actually close as the real success signal. Captures
  modal HTML to a new field on `guest_add_failed` diagnostics.
  Dashboard renders the new field plus a candidate-input list.

- **`7538283` — Dismiss the intro dialog.** New
  `dismissAddingMemberOrGuestDialog()` finds the visible
  `.ui-dialog` whose `.ui-dialog-title` text matches
  `Adding a Member or Guest`, ticks the
  `input[name="suppressAlert"]` checkbox (with the React-style
  prototype setter so the click handler fires), clicks the
  button-pane Close, falls back to `.ui-dialog-titlebar-close`.
  Called from `addGuest` immediately after `focusSlot`. Adds
  `intro-dialog-dismissed` to the `attempts` log when it fires.

- **`5ed96f5` — Owner-captured DOM rewrite.** Replaces the
  heuristic input scan with exact-selector logic now that we
  know the real markup:
  - `findGuestRegistrationModal` matches on a visible
    `.ui-dialog` whose `.ui-dialog-title` is exactly
    "Guest Registration".
  - **Strategy 1 (existing guest)**: scan
    `.ftGdb-guestSelect .ftMs-resultList .ftMs-listItem` for
    `"Last, First"` (whitespace-normalized, with exact-then-prefix
    fallback to handle entries like `Martin, Matt G`). TBA is
    explicitly excluded from the match. Click → wait for modal
    to become `display: none` → return.
  - **Strategy 2 (new guest)**: click
    `[data-fttab=".ftGdb-guestAdd"]` → fill via exact
    `input[name="name_first"]` / `name_mi` / `name_last`
    selectors → click the dialog button-pane "Add New Guest".
  - `waitForModalToClose` checks visibility on the dialog
    handle (Foretees hides via `display: none`, not removal,
    so we can't use `.isConnected`).

- **`979315e` — TBA fallback.** Owner explicitly asked for a
  never-lose-the-tee-time safety net. If both Strategy 1
  and Strategy 2 fail, the function re-switches to the
  Search Guests tab, clicks the TBA item, and lets the
  dialog close on the placeholder. Records a new soft
  `guest_tba_fallback` diagnostic listing the strategy errors
  that triggered the fallback. Dashboard renders this event
  yellow (not red) so the booking-summary badge stays
  warning-coloured rather than error-coloured when only TBA
  fallbacks occurred. The booking record itself stays
  `completed` because the slot did fill — the owner is
  expected to fix the name manually on Foretees afterward.

Also refactored `fillGuestRegistrationAndAdd` to a single
try/finally so the modal handle is disposed exactly once
regardless of which strategy wins.

#### Owner workflow this assumes

Owner doesn't have "regular" guests in the traditional sense
but plans to pre-add the day's guests to Foretees before the
booking runs. Strategy 1 will pick them with one click. If
the owner forgets, Strategy 2 fills the form. Strategy 3
fires only if Foretees rejects both.

#### Dashboard changes

- `guest_add_failed` cards now render two new sections when
  populated: a `Guest Registration modal HTML` collapsible
  (auto-expanded) and a `Modal input candidates` list (which
  inputs the bot saw and how it scored them). These should
  make any future failure self-diagnosing without a screen
  recording.
- New `guest_tba_fallback` event card: yellow border/background,
  shows which slot was placeholder-filled and why, with the
  instruction "Fix the name on Foretees if needed."
- Diagnostics-summary badge picks yellow when every event is
  a `guest_tba_fallback`, red otherwise.

#### Live verification (2026-05-14, same evening as merge)

Owner triggered a Test 7AM run at 16:55:43 ET targeting 5/20 in
the 15:00-16:00 window with 1 member + 1 pre-added named guest
(John Brecker) + 1 partner (Alexander Wilkins). Full success at
16:59:09 ET:

```
focus-slot:2 -> intro-dialog-dismissed -> guests-tab:data-fttab
-> guest-category:Guest -> registration-fill:existing:Brecker, John
-> modal-closed:yes
```

Result: `{success:true, partial:false, time:"3:15 PM"}`. Sheet
verified with 3/3 players. Total time from rapid-fire engage to
PRECISION BOOKING COMPLETE was 9.4 seconds. Every new PR #27
code path fired and worked on first live exercise:

- Intro dialog popped and was dismissed (`intro-dialog-dismissed`
  in the attempts log) — confirms the root-cause diagnosis was
  real, not theoretical.
- Strategy 1 (existing-guest pick from the Search Guests list)
  won on the first try.
- `waitForModalToClose` correctly detected the dialog going
  `display: none`.
- `Yes, Continue` confirmation modal was handled by the
  unconditional click from PRs #23/#25.

#### Open follow-ups

- **Strategy 2 (form-fill) is still unverified live** -- Strategy 1
  dominated the first booking because the guest was pre-added.
  If Strategy 2 ever fires and fails, the captured modal HTML
  will show why.
- **Strategy 3 (TBA fallback) is also unverified live** -- triggers
  only if both Strategy 1 and 2 fail.
- **Older open items** carry over from the previous session
  (Section 8 below).

---

### PRs #21–#25 (2026-05-14 night session) — booking-resilience overhaul

Branch: `claude/fix-bookings-bA128`. Owner came back at ~9 PM ET on
2026-05-13 reporting a Test 7AM stuck "Running Now" past its
trigger, blocking the dashboard. Session shipped five PRs in
sequence, each addressing a real failure mode surfaced by the
night's testing, and ended with the system end-to-end live-verified:
a Test 7AM for 5/20 at 15:00–16:00 (Alexander Wilkins + 2 TBA
guests) landed **`completed`** (not partial) on a 3:15 PM slot
with `yes_continue_clicked` recorded in diagnostics.

#### PR #21 — `ba13b22` → merged as `98513df`
**Fix stuck in_progress bookings so dashboard self-heals on dyno restart**

The stuck booking that opened the session had three contributing bugs:

1. Test-precision runs are fired by an in-memory `setTimeout` in
   `server.js`. When a dyno restart kills the run mid-flight, the
   booking is left in `in_progress` forever — the timer is gone,
   and the existing startup-recovery path tries to re-run such
   bookings, which then hang again on the same flaky path (or hit
   a "Member Already Playing" if a prior partial booking secured
   the slot).
2. `runPrecision()`'s 10-minute watchdog catch block did
   `await this.browser.close()`. If Playwright itself is the thing
   that hung, `browser.close()` can stall indefinitely — silently
   re-introducing the very hang the watchdog exists to escape, so
   `runPrecision` never returns and status stays pinned at
   `in_progress`.
3. The dashboard's `DELETE /api/bookings/:id` refused to remove
   anything in `in_progress` — safe in theory, but combined with
   (1)+(2) it left the user with no way out of a dead "Running Now".

Fixes:
- `src/scheduler.js`: on boot, immediately fail-out any `testRun`
  booking still in `in_progress` with reason "Booking interrupted
  by dyno restart and could not auto-resume." Non-test bookings
  keep the existing re-attempt path.
- `src/booker.js::runPrecision()`: watchdog cleanup now schedules
  `browser.close()` fire-and-forget (`b.close().catch(() => {})`)
  instead of awaiting it. `runPrecision` is guaranteed to return.
- `server.js`: `DELETE` now allows clearing `in_progress` bookings
  whose `startedAt` is more than 15 minutes ago (watchdog ceiling
  + buffer). Younger runs are still protected.

#### PR #22 — `4da76fd` → merged as `1d04744`
**Persist test-precision through dyno restart + close boot-window write race**

Three deeper persistence fixes after a follow-up audit:

1. **Boot-window write race closed.** `server.js` called
   `startScheduler()` (async — runs `syncFromGistOnBoot`) without
   `await` and then `app.listen()` on the next line. The local
   `bookings.json` starts empty after a Heroku redeploy. For the
   ~1–2 s the gist fetch is in flight, the API is accepting POSTs
   against the empty file; when the fetch finishes it overwrites
   the local file with the gist contents, silently dropping
   anything submitted in that window. Boot is now wrapped in an
   async IIFE: `await startScheduler()` → re-arm in-memory test
   timers → **then** `app.listen()`.

2. **Test-precision is now restart-survivable.** The booking record
   stores `triggerEpochMs` (absolute UTC ms). The `setTimeout` body
   is factored into a new `scheduleTestPrecisionRun(booking)`
   helper used by both the POST endpoint and the boot recovery
   loop. On boot, the loop scans pending `testRun` rows surviving
   in the gist and calls the helper, which:
   - Schedules a fresh `setTimeout` if the trigger is in the future.
   - Fires immediately if the trigger is in the past but ≤ 10 min
     late.
   - Auto-fails the booking with a clear message if more than 10
     min late (the watchdog's own ceiling) — a stale launch is
     worse than a clean failure. **This resolves the previous
     session's caveat #4 about Test 7AM dyno-restart loss.**

3. **`startedAt` field** added everywhere status flips to
   `in_progress` (`book-now` creation, `test-precision` firing,
   scheduler `checkAndRunBookings` pre-loop). The PR #21 stale-
   `DELETE` check used to key off `createdAt`, which is fine for
   tests but wrong for real bookings (`createdAt` is days in the
   past — the check would always say "stale" and allow clobbering
   a live run). Now keyed off `startedAt`; rows missing the field
   are still deletable as legacy.

Additional: `KEEP_ALIVE_URL` config var is now honored, not just
`HEROKU_APP_NAME` / `RENDER_EXTERNAL_URL`. The boot log says
whether keep-alive is armed and which URL it'll ping.

#### PR #23 — `3e82ae3` → merged as `f0f323a`
**Handle Foretees "Player/Guest Association" confirmation modal**

A live Test 7AM at 21:28 ET (Alex Wilkins + 2 TBA guests, slot
order self/Alex/TBA/TBA) failed at submit with
`Submit did not confirm booking (result: false)` and an **empty**
diagnostics array. Pulling the screenshots from the live dashboard
showed Foretees popped a **Player/Guest Association** modal when
guests aren't sitting immediately after their host member
("Guests should be specified immediately after the member they
belong to. Would you like to process the request as is?
[No, Go Back] [Yes, Continue]").

The generic `submitBooking` popup dismiss matched
`/^(OK|Confirm|Yes)$/i` — "Yes, Continue" failed the regex because
of the comma + extra word. Modal stayed open, real submit never
happened, `verifyBookingOnSheet` correctly reported no booking on
the slot, and the run failed with no clue why.

Fixes in `src/booker.js::submitBooking()`:
- Explicit handler runs **before** the generic dismiss. Looks for
  a button matching `/^yes\s*,?\s*continue\b/i` across `<a>`,
  `<button>`, and `<input type=button|submit>`, clicks it, waits
  2 s, screenshots `09b_post_yes_continue.png`, records
  `yes_continue_clicked` (or `association_modal_unclickable` if
  the modal text is up but the button can't be found —
  superseded by PR #25 which dropped the text gate entirely).
- The `verifyBookingOnSheet → false` path now records a
  `verify_failed` diagnostic with `chosenTime`, an 800-char
  page-text snippet, and the first 30 visible button labels. No
  future "Submit did not confirm" failure can have an empty
  diagnostics array.

#### PR #24 — `5b6facb` → merged as `32cfff9`
**Place guests immediately after self, partners last**

Root-cause fix for the modal PR #23 just learned to dismiss. All
guests belong to the booking member (self), so Foretees expects
them adjacent to slot 1. `fillBookingForm` now processes **guests
first** (slots 2..G+1) and **partners last** (slots G+2..). For
the user's standard "self + 2 TBA + 1 partner" booking, slot
order is now self / TBA / TBA / partner.

PR #23's modal handler stays in `submitBooking` as a defensive
backstop. The `for (i=0; i<list.length && nextSlot<=4; i++,
nextSlot++)` loop handles every combination of 0–3 guests with
0–3 partners cleanly: with 0 guests the guest loop is a no-op
and partners take slots 2..; with 3 guests the partner loop is a
no-op.

#### PR #25 — `954f5d9` → merged as `a5596ed`
**Always click "Yes, Continue" on any Foretees confirmation modal**

Owner's directive after PR #24 went out: *"always click yes,
continue, so booking goes through. I can fix anything after the
fact, except if the tee slot does not get booked!"*

PR #23's handler was gated on detecting the specific Player/Guest
Association modal body text. That gate is unnecessary risk: if
Foretees ever pops a different confirmation modal with a
"Yes, Continue" button, or renames the modal copy slightly, the
gate lets the modal block the submit. Dropped the gate — any
visible `Yes[,]?\s*Continue` button is clicked unconditionally.

#### Verified live (21:49 ET 5/13 EDT, booking `bk_1778723131647_qrw98m`)

- Test 7AM at 21:49 ET, play date 5/20/2026, window 15:00–16:00,
  partners=`Alexander Wilkins`, guests=`TBA, TBA`, transport=C-B.
- Slot order on the form (PR #24): self / TBA / TBA / Alex.
- Foretees did pop the Player/Guest Association modal anyway
  (still unclear what triggers it for this shape — possibly any
  booking with mixed partners + guests, or just a Foretees A/B).
  Handler clicked through cleanly, recorded `yes_continue_clicked`
  in `result.diagnostics` with the exact button label.
- Final status: **`completed`** with `partial: false` and
  `result.time: "3:15 PM"`. `verifyBookingOnSheet` returned
  `'verified'` — member + all expected player count present on
  the slot.

#### Heroku & deployment notes from this session

- **Heroku Platform API was not accessible from the sandbox this
  session** (no `HEROKU_API_KEY` in the environment). Live log
  inspection wasn't possible; diagnosis relied on
  `GET /api/bookings` and the `/screenshots-files/` endpoint
  served by the app itself. Future sessions: check for the API
  token early; without it you're flying without log access.
- **Auto-deploy works as documented** — every PR merge to `main`
  was live on Heroku within ~2–3 minutes. Polling the API after
  a deploy is reliable enough to detect when a new build is
  serving.
- **`DEBUG_SCREENSHOTS=true` is still set** on the dyno (left over
  from earlier session). Useful tonight — without it the PR #23
  diagnosis would have needed a separate roundtrip with the owner
  to flip the flag and re-run. Worth leaving on permanently until
  the system is fully stable.

---

### PR #17 — `455c90b` + `89f7dc7` → merged as `12ff397` (2026-05-13 session)
**Persist bookings.json to a private GitHub Gist; harden against transient failures**

The old `BOOKINGS_JSON` env-var workflow (PR #13) required the owner
to click "Copy snapshot" and paste the value into Heroku config vars
every time a booking was added/edited/removed — easy to forget. PR
#17 replaces it with automatic gist-backed persistence.

**Commit 1 — `455c90b` (basic gist-backed persistence):**
- New `src/store.js` exposing `loadBookings()` / `saveBookings()` /
  `syncFromGistOnBoot()`. Local `bookings.json` is the synchronous
  source of truth; every save schedules a debounced (1.5 s)
  fire-and-forget PATCH to the gist.
- `src/scheduler.js::startScheduler()` is now `async` and `await`s
  `syncFromGistOnBoot()` before scheduling cron or running startup
  recovery. `seedFromEnvIfNeeded()` deleted.
- `server.js` reads/writes go through the store. `/api/snapshot`
  endpoint and "Restart-Proof Snapshot" UI card removed.
- `.env.example` + docs updated. New config vars: `GIST_ID`,
  `GIST_TOKEN`.

**Commit 2 — `89f7dc7` (hardening for zero-loss durability):**
- `syncFromGistOnBoot()` retries the fetch up to 3 times with 2 s
  backoff. 401/403/404 are fatal (bad token / bad id, won't help to
  retry).
- New `bootSyncOk` flag: until boot fetch succeeds (or short-circuits
  for disabled gist), all pushes are blocked. Prevents a transient
  boot-time outage from letting the empty-default local file
  overwrite the real queue on the first save.
- New `flushPending()` exported from the store. SIGTERM / SIGINT
  handlers in `server.js` call it before `process.exit(0)`, so any
  save still inside the 1.5 s debounce window is flushed before the
  dyno dies. Heroku gives ~30 s after SIGTERM.
- `add-booking.js` + the `npm run add` script deleted. The CLI wrote
  to `bookings.json` directly without going through `src/store.js`,
  bypassing the gist — a footgun. The dashboard is now the only
  path to mutate the queue.

**Heroku config:** owner provisioned `GIST_ID` and `GIST_TOKEN`
(classic PAT with `gist` scope), and deleted the old `BOOKINGS_JSON`
config var. Boot logs after the deploy showed:

```
[INFO] Gist persistence enabled. Fetching bookings from gist <id>.
[INFO] Gist sync ok: loaded 0 booking(s) from gist into local file.
```

End-to-end verified live on 2026-05-13: sync took ~270 ms, dashboard
add/remove round-trips to the gist within ~2 s. The
`Diagnostics (1)` orange disclosure on a successful booking that
was visible during this session's first booking was traced to a
separate `didSlotFill` bug (see next entry — branch
`claude/fix-guest-fill-diagnostic`).

### Branch `claude/fix-guest-fill-diagnostic` (2026-05-13 later same day)
**Stop recording false `guest_add_failed` diagnostics when Foretees auto-routes to a different slot**

Symptom: the 2026-05-13 booking (member + 1 partner + 1 TBA guest)
reported status `Booked` on the My Queue tab — Foretees verified all
three players were on the slot — but the same card showed an orange
`Diagnostics (1)` disclosure with this content:

```
guest_add_failed · target slot 3
Attempts: focus-slot:3 → guests-tab → guest-category:Guest →
          registration-TBA:TBA → tbd-X:X → tba-button:none
Slot names before: ["Jeffrey G Wilkins","","","",""]
Slot names after:  ["Jeffrey G Wilkins","TBA","","",""]
```

Root cause: Foretees auto-routes guest/TBA picks to the **leftmost
empty player row**, regardless of which "Select Player #N" prompt is
active in the right panel. Partner-fill for slot 2 (Alexander) had
not yet committed when the TBA-guest add fired for slot 3, so
Foretees correctly dropped the TBA into the leftmost empty row —
slot 2. `didSlotFill(before, slotIdx=2)` (i.e. checking slot 3) saw
slot 3 still empty and wrongly returned `false`, triggering a
spurious `recordDiag('guest_add_failed', ...)`. The booking
nonetheless submitted, Foretees verified all three players, and the
flow returned `success: true`.

Fix: `src/booker.js::didSlotFill()` now accepts the action as
successful if either (a) the targeted row filled, or (b) **any**
previously-empty row among slots 1–4 is now filled. Single-flight
`addGuest()` semantics make the latter unambiguous: any newly-filled
row is attributable to the just-fired click.

What stayed the same:
- Genuine failures (no row anywhere filled, modal-selector miss)
  still record `guest_add_failed` and capture `panelHtml`.
- `addPartner()`, `verifyBookingOnSheet()`, and every other code
  path are untouched.

Files: `src/booker.js` (one function rewritten),
`documents/HANDOFF.md`, `documents/PROJECT_RECORD.md`.

### PR #15 — `d54cf9f` + `ab307bb` → merged as `74dd515` (2026-05-13 session)
**Fix named-guest booking via Guest Registration modal; add `partial` status**

The live 5/20 booking executed on 2026-05-13 but **none of the named
guests landed on the slots** — only the member was on the booking.
Owner captured screenshots of the actual Foretees flow and discovered
the named-guest path goes through a **Guest Registration modal** that
opens after clicking Guests → Guest category, not a panel-side text
input as the old code assumed.

**The corrected flow (per owner's screenshots, applies to both TBA
and named guests):**
1. Click the target player slot (focuses "Select Player #N").
2. Click the **Guests** tab.
3. Click the **Guest** category in the right panel.
4. The **Guest Registration** modal opens with: First Name *,
   Middle Initial, Last Name *, Guest Locker, plus a right-side
   search list whose top entry is "TBA".
5. **Named guest:** type First Name + Last Name (and optional MI),
   click **Add New Guest**.
   **TBA:** click "TBA" in the right-side list.
6. Modal closes, name drops into the player slot.

**Changes (`d54cf9f`):**
- `src/booker.js`:
  - `addGuest()` rewritten — both TBA and named guests follow the
    modal path. The old "try to type into the panel directly" branch
    is gone.
  - New `focusSlot(slotIdx)` — clicks `#slot_player_row_<idx>` so
    Foretees' "Select Player #N" pointer is on the right slot.
  - New `parseGuestName(name)` — splits "First [MI] Last". "Matt
    Brown" → `{first:"Matt", last:"Brown"}`; "John D Smith" →
    `{first:"John", middle:"D", last:"Smith"}`.
  - New `fillGuestRegistrationAndAdd(first, mi, last)` — anchors on
    the visible "Add New Guest" button to find the modal container,
    then fills the inputs by matching labels and attribute hints
    (`first|fname|gst_first|first_name` etc.), then clicks the
    button. Falls back to DOM-order matching if labels don't
    disambiguate. Explicitly excludes the right-side guest-search
    input from First-Name candidates.
- `fillGuestNameAndAdd()` retained but no longer called from
  `addGuest`; safe to remove later.

**`partial` status (`ab307bb`):** even with the fixed flow, the bot
might fail to add a guest (e.g., selector miss on an unexpected modal
variant). Previously a "tee time secured, guests missing" outcome got
marked `failed` on the dashboard — misleading because the booking is
real on Foretees. Added a tri-state:
- `verifyBookingOnSheet()` returns `'verified'` / `'partial'` / `false`.
- `submitBooking()` propagates `'partial'`.
- `run()` / `runPrecision()` return `{ success: true, partial: true }`
  when the slot is secured but player count is short.
- `src/scheduler.js` and `server.js` map this to a new `partial`
  booking status — yellow "Booked (Partial)" badge + helper text:
  *"Tee time secured. One or more guests/partners did not fill —
  add them manually on Foretees."*
- The `BOOKINGS_JSON` seeder treats `partial` as terminal so a dyno
  cycle never replays a partial booking.

**Why this matters per owner's priority** ("secure the tee time no
matter what — I can fill in other info later"): even in the worst
case where the named-guest flow misfires, the bot still submits the
form with the member on it. If Foretees accepts (most afternoon
slots have no min-player rule), the tee time is locked in and the
dashboard now correctly reports it as a `partial` success rather
than `failed`. If Foretees rejects with Minimum Player Limit, the
bot tries up to 5 alternate slots before giving up.

**Verification status:** the named-guest flow is wired per the
owner-captured modal screenshots but has NOT yet been live-verified
against an actual Foretees booking. The next real booking will
confirm it; if anything still misfires, the diagnostic system
captures the modal HTML for next-time selector refinement.

**Deployment workflow (this session):** owner explicitly approved
"make it live" before PR was opened. Push-only on feature branch was
the default; PR was created and merged only on owner go-ahead.
Codified that as the standing pattern.

---

### PR #13 — `16d7864` → merged as `7549885` (2026-05-12 session)
**Harden persistence + restart safety**

> **Superseded by the gist persistence change on branch
> `claude/persist-scheduled-bookings-4NmDO`:** `seedFromEnvIfNeeded()`,
> the `BOOKINGS_JSON` env var, and the `/api/snapshot` endpoint +
> UI card are removed. Persistence is now fully automatic via a
> private GitHub Gist (see §4). The PR #13 mutex fix for the
> double-fire race is still in place. This history is kept for
> context only.

Owner was about to depend on a queued booking surviving overnight on
Heroku Eco. Audit found a real persistence bug and a smaller double-fire
race in the trigger window.

1. **`bookings.json` could silently disappear on a dyno cycle.** The
   existing `BOOKINGS_JSON` env-var fallback only triggered when the
   file was missing or unparseable. After a deploy or restart the slug
   restores `bookings.json` to its git state (`[]`), which is a valid
   parse — so the fallback was skipped and any dashboard-added bookings
   vanished.

2. **Cron + startup-recovery could both fire `checkAndRunBookings()`**
   inside the 6:58–7:15 ET window if the dyno restarted right at the
   trigger. Each call would mark its bookings `in_progress` and run
   them; the second call would also re-pick the same `in_progress`
   bookings via the "interrupted" path, leading to a duplicate
   submission attempt.

Fixes:
- `src/scheduler.js`: new `seedFromEnvIfNeeded()` runs once at boot,
  merges `BOOKINGS_JSON` into the on-disk queue, skipping by id
  (duplicates), by terminal status (`completed`/`failed`/`expired`),
  and by stale trigger date (already passed). Resets seeded
  `in_progress` back to `pending` so startup recovery handles them
  cleanly.
- `src/scheduler.js`: module-level `isRunning` flag wrapped around
  `checkAndRunBookings()` so a second call (cron-fired while a
  startup-recovery run is still in flight) logs a "skipped" message
  and returns instead of re-firing.
- `server.js`: removed the now-redundant env-var fallback from the
  duplicate `loadBookings()` (seeding runs at startup before any
  request can land).
- `server.js`: new `GET /api/snapshot` returns
  `{count, snapshot: "<JSON string of pending bookings>"}`.
- Dashboard: the **My Queue** tab shows a "Restart-Proof Snapshot"
  card (only when there are pending bookings) with a "Copy snapshot
  to clipboard" button + inline instructions for pasting into the
  Heroku `BOOKINGS_JSON` config var.

End-to-end verified on 2026-05-12: setting `BOOKINGS_JSON` to a
fresh-snapshot value restarted the dyno; on boot the new code loaded
the booking from the env var even though the on-disk file was empty.

---

### PR #19 — `6d3e3c5` + `67bfa62` + `edbf251` → merged as `862cd1a` (2026-05-14 session)
**`runPrecision` watchdog + partner-matcher rewrite + TBD-X recognition**

Triggered by an owner report that a Test Precision booking scheduled
for 8:10 PM ET appeared to be "Running Now" past its trigger time.
Diagnosis via the Heroku Platform API showed the booking had actually
failed cleanly at 8:17 PM — the dashboard was just stale. But a
follow-up test on 5/20 surfaced three unrelated real bugs.

**Commit 1 — `6d3e3c5` (10-minute hard timeout):**
- `src/booker.js::runPrecision()` split into a thin wrapper and
  `_doRunPrecision()` (the original body, unchanged).
- Wrapper races `_doRunPrecision()` against a 10 min `setTimeout`
  reject. On loss: force-close `this.browser` so the inner racing
  work can't keep it alive, save a `PRECISION_TIMEOUT` screenshot,
  return `{ success: false, error: 'Booking exceeded 10-minute hard
  timeout' }`. Watchdog is cleared in a `finally`.
- Was originally motivated by the perceived "stuck" booking. Actual
  hangs haven't been observed yet, but the existing precision flow
  has multiple unbounded Playwright waits (`waitForSelector`,
  `waitForNavigation`, etc.) that could hang on a Foretees outage.

**Commit 2 — `67bfa62` (partner name input):**

The 5/20 partial booking's diagnostic showed:

```
[INFO] Adding partner: Alexander Wilkins to slot 2...
[WARN]   Could not find partner "Alexander Wilkins" in Partners tab. Trying Members tab...
[INFO]   Found via Members tab: Welcome, Jeffrey G Wilkins
```

The Members fallback had matched the page header. Two bugs:

- `addPartner()` Partners-tab matcher required the displayed text to
  contain a concatenated `"First Last"` string. Scioto's list
  renders `"Last, First (handicap)"`, so e.g. `"alexander wilkins"`
  as a substring of `"wilkins, alexander (n/a)"` is false. Every
  multi-word partner name failed. Now requires last + first
  separately and scans only `.ftMs-partnerSelect .ftMs-resultList
  .ftMs-listItem`.
- `tryMembersTab()` walked `document.querySelectorAll('div, span,
  li, a, td, p')` and matched the first element whose text contained
  the last name — the "Welcome, &lt;member&gt;" banner won every time.
  Also never typed into the Members search input, so even if scoped
  properly the result list would have been empty. Rewritten: click
  the tab via `[data-fttab=".ftMs-memberSearch"]`, fill +
  `.type(lastName, { delay: 30 })` into `.ftMs-memberSearch
  .ftMs-input`, wait ~800 ms for ajax, then click only inside
  `.ftMs-memberSearch .ftMs-resultList`.

**Commit 3 — `edbf251` (TBD-X = filled):**
- `readSlotNames()` used to read `input[type="text"].value` per row.
  TBD-X rows have an empty input — Foretees encodes "X" in
  `<div class="playerType">X</div>`. So when `addGuest` fell back
  to TBD-X (e.g., because the slot's Foretees rules hide the Guests
  tab), the row WAS filled but the bot reported `guest_add_failed`.
- Added a `.playerType` fallback: when the input is empty, return
  the `.playerType` text — except `"member"` (case-insensitive),
  which is always present on the self row. Now `didSlotFill`
  correctly sees TBD-X as a transition from empty to filled.

**Heroku impact:** auto-deployed from `main` after PR merge.

**Foretees behavior notes (worth knowing for future sessions):**
- The `Member_sheet?calDate=...&select_jump` URL redirects requests
  for not-yet-open dates to the most recent already-open sheet.
  Test Precision on a play date exactly 7 days out (the boundary)
  will therefore burn its full rapid-fire budget without finding a
  match. Use 1–6 days out for tests.
- Some slots have `* Guests are restricted from being added to
  this time.` and Foretees omits the Guests tab entirely. The
  `selectTeeTimeFast` slot picker does not currently filter on this
  rule — see "Open follow-ups" in HANDOFF.md.

---

## 7. Earlier work (2026-05-10 session)

### PR #1 — `8b84b8f` → merged as `f96b3fe`
**Add dedicated Guests field to dashboard and wire up Guests tab booking**

- Dashboard: separate **Guests (Non-Members)** input on Schedule and
  Book Now tabs, alongside the renamed **Member Partners** field.
- API: `guests[]` accepted on `POST /api/bookings` and
  `POST /api/book-now`; partners + guests capped at 3.
- Booker: new `addGuest()` switches to the Guests tab, fills name
  (split or full-name layout), clicks "Add" with a guard against firing
  the form-wide Submit. `selectTeeTime` counts guests in needed-spots.
- Queue + scheduler logs show guests when present.

### PR #2 — `0f74193` → merged as `10806a0`
**Add Test 7AM tab: one-shot precision dry run at user-picked time**

- New `POST /api/test-precision` endpoint.
- `booker.runPrecision()` honors `booking.bookingOpenTimeOverride`.
- Scheduler skips `testRun: true` bookings so the Test 7AM tab doesn't
  re-fire through cron.
- New "Test 7AM" tab in the dashboard, TEST badge in My Queue.

### PR #4 — `b6fd837` → merged as `654fd4e`
**Fix false-success bookings, handle TBA guests, speed up 7am click path**

Found via the 5/13 dry-run: the queue showed `BOOKED: 5:30 PM` but no
booking actually appeared on Foretees. Root causes were three
interacting bugs:

1. `submitBooking()` defaulted to `return true` when no specific
   success/failure pattern matched — so any unexpected page state was
   reported as success.
2. The submit-click selector used a loose `/submit/i` regex that could
   match unrelated links (e.g. "Submit help") instead of the actual
   button.
3. `runPrecision()` and `run()` ignored `submitBooking()`'s return
   value entirely — even an explicit `false` was reported as success.

Fixes:
- Strict submit-button selector (`a.submit_request_button` /
  `a.submit_changes_button` or exact-text only).
- `submitBooking()` defaults to FAILURE when no positive confirmation
  is found.
- New `verifyBookingOnSheet()` re-fetches the tee sheet and confirms
  the member's name is on the chosen slot. This is now the only thing
  that flips a booking to `completed`.
- Both `run()` and `runPrecision()` now check the submit return value.
- `addGuest()` recognises `TBA` (or `TBD` typo) and clicks Foretees'
  built-in TBA option instead of typing it as a name.

Speed pass on the 7 AM critical path (everything between
"tee sheet opens" and "slot button clicked" — the rest stays
human-paced because Foretees holds the slot after the click):
- Rapid-fire interval **200 ms → 100 ms**, per-attempt goto timeout
  **5 s → 2 s**.
- Title + buttons check fused into one in-browser call.
- New `selectTeeTimeFast()` picks AND clicks the best slot in a
  single `page.evaluate()` — saves ~200–500 ms by collapsing 3–4
  Node↔browser round-trips into one.
- The blocking screenshot between sheet-open and slot-click is now
  fire-and-forget so disk I/O doesn't delay the click.

---

## 8. Known caveats and open items

1. **Named-guest flow: live verification still pending.** As of PR #15
   (2026-05-13), `addGuest()` follows the Scioto modal path for both
   TBA and named guests. TBA was verified live in PR #11 (2026-05-11).
   The named-guest path is wired per owner-captured screenshots of the
   Guest Registration modal but has not yet been verified against a
   real booking. On failure the diagnostic system captures
   `panelHtml` and saves a `07_guest_<N>_FAILED.png` screenshot, so a
   single failed run gives us the actual modal markup. If selectors
   need refinement, look at:
   - `fillGuestRegistrationAndAdd()` in `src/booker.js`: input
     matching uses `first|fname|gst_first|first_name` etc. plus
     label proximity. Excludes inputs hinting at `search|locker|filter`
     to avoid the right-side guest-search box.
   - "Add New Guest" button match: exact-text then loose-text, with
     "Submit Request/Changes" and "Close"/"Cancel" excluded.

   The `partial` status added in PR #15 means even a selector miss on
   a single guest won't lose the tee time — the bot still submits and
   the booking is reported as `partial` (secured but incomplete)
   instead of `failed`.

2. **`bookings.json` is on the ephemeral dyno filesystem**, but a
   private GitHub Gist holds the durable copy. `src/store.js`
   rehydrates the local file from the gist at boot and mirrors every
   save back to the gist in the background (debounced 1.5 s). No
   manual snapshot step. See §4 "Durable persistence" for details.
   If `GIST_ID` / `GIST_TOKEN` are unset (or the gist API is
   unreachable at boot), the store falls back to file-only — the
   scheduler still runs, but a dyno restart will wipe the queue.

3. **Eco dyno restarts daily.** Startup recovery covers restarts during
   the 6:58–7:15 window, but a restart at exactly 7:00:01 could miss the
   trigger if browser launch is slow. PR #13's `isRunning` mutex on
   `checkAndRunBookings()` prevents cron + startup-recovery from
   double-firing in this window (which would otherwise submit two
   booking attempts).

4. **Test 7AM dyno-restart is now restart-survivable** (resolved by
   PR #22, 2026-05-14). The booking record stores `triggerEpochMs`
   (absolute UTC ms) and boot recovery re-arms the in-memory
   `setTimeout` from any pending `testRun` rows surviving in the
   gist. If the boot lands more than 10 min past the trigger the
   test is auto-failed with a clear message ("Trigger time passed
   N min ago without firing (likely a dyno restart). Re-schedule
   the test.") instead of firing stale.

5. **Local `git push` to `main` from the sandbox is blocked (403).**
   Always go through the GitHub MCP API.

6. **Foretees "Player/Guest Association" modal can still appear
   even with optimal slot order** (PRs #23–#25, 2026-05-14). PR #24
   moved guests adjacent to self specifically to avoid this modal,
   but live verification at 21:49 ET 5/13 showed Foretees popped it
   anyway for a self / TBA / TBA / partner shape. The
   "Yes, Continue" handler in `submitBooking` resolves it
   unconditionally and the booking goes through, so this is not a
   failure mode — but worth being aware of when reading
   diagnostics: `yes_continue_clicked` is expected, not abnormal.

---

## 9. How to verify before tomorrow morning

The fastest end-to-end check after any change to the guest path:

1. Heroku → Config Vars → set `DEBUG_SCREENSHOTS=true`.
2. Dashboard → **Test 7AM** tab.
3. Trigger Time: ~5 minutes from now (ET). Play Date: today + 7. Time
   window: wide (09:00 – 18:00). Guests: `Bob Smith, TBA`. Transport:
   leave default.
4. **Schedule Test Run.**
5. Watch My Queue (TEST badge):
   - `pending` → `in_progress` ~2:30 before trigger (browser launching)
   - `completed` (green "Booked") — member + all guests/partners on
     the slot
   - `partial` (yellow "Booked (Partial)") — member on slot but at
     least one guest/partner missing. **The tee time IS secured on
     Foretees.** Helper text on the card tells the owner to add the
     missing players manually on Foretees. The booking is not
     re-fired.
   - `failed` (red) — true failure, member not on the slot.
6. **Cross-check on the actual Foretees tee sheet** — the queue's
   `completed`/`partial` status is reliable, but a manual look
   confirms which guests landed.
7. If a guest didn't attach, the booking's `diagnostics` array on
   the My Queue card contains the modal HTML snippet and the
   sequence of attempts (e.g.
   `focus-slot:2 → guests-tab:data-fttab → guest-category:Guest →
   registration-fill:no`). A failure screenshot
   `07_guest_<N>_FAILED.png` is also saved to `/app/screenshots`
   (ephemeral — pull fast if needed).
8. Flip `DEBUG_SCREENSHOTS=false` after.

> **Note on play-date math:** the precision flow only succeeds when
> Foretees has actually opened the tee sheet for the target date. The
> sheet for date `D` opens at 7 AM on `D − 7 days`. So a test booking
> for play date today+7 will succeed (sheet opens at the simulated
> trigger time); a test for play date today+10 will hammer for
> 2 minutes and fail because the sheet isn't open yet on Foretees.

---

## 10. Pointers to other docs

- **`HANDOFF.md`** — short, working handoff between Claude sessions.
  Read it first when starting a session; it captures the most recent
  state and any in-flight context that hasn't yet been folded into this
  record.
- **This file (`PROJECT_RECORD.md`)** — durable reference. Update it
  when you ship something that changes architecture, deployment, or
  owner preferences.
