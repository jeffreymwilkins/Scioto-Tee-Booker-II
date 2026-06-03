# Handoff: tee-time-booker

This is the working handoff for Claude in a new chat. It supersedes the
original 2026-05 handoff and adds everything built/learned through
**2026-05-12**, including the persistence hardening that landed the
night before a live 5/20 booking and the Scioto Foretees DOM specifics
that took several test runs to nail down.

---

## TL;DR for the next Claude

- **App**: Heroku-hosted bot that books tee times at Scioto CC's Foretees
  system. **Live dashboard (the owner's site address):**
  <https://tee-time-booker-22be88cf5377.herokuapp.com>. The sandbox has
  outbound network access, so you can hit read-only endpoints on this URL
  yourself (see the Probe note below) — don't ask the owner to.
- **Repo**: <https://github.com/jimmyttt21/tee-time-booker> (single repo).
- **Deploy**: Heroku auto-deploys from GitHub `main`. **To ship a change,
  merge the feature branch into `main`** — Heroku takes it from there.
- **User does not want to use the terminal — ever, including for
  diagnostics.** Do all git/PR/merge work yourself via the GitHub MCP API.
  Local `git push origin main` is blocked by the sandbox proxy (403); the
  GitHub MCP API can merge PRs directly. **And when the owner says "check
  the probe," fetch it yourself** — `GET` the live `/api/probe-latest`
  (sandbox has network), strip the screenshots, read the selector-health
  table back in plain English. Never tell the owner to run `curl`/`jq` or
  paste JSON. (Learned the hard way 2026-05-31.)
- **First-time setup the user already did**: Heroku → tee-time-booker →
  Deploy tab → GitHub integration → enabled auto-deploys from `main`.

---

## What this app does

Hosted on Heroku Eco dyno, runs 24/7 with Express + node-cron + a 20-min
keep-alive ping. Workflow:

1. At **6:58 AM ET**, 7 days before the desired play date, the scheduler
   logs in to Foretees.
2. At **6:59:00 ET** it starts hammering the tee sheet URL every 200 ms.
3. The instant the sheet opens at **7:00:00 ET**, it grabs the best slot
   in the user's window and submits the booking.

Player counts include partners and guests (max 3 others + self).

---

## Heroku config (already set)

- `USERNAME`, `PASSWORD` — Scioto CC login
- `MEMBER_NAME` = "Jeffrey G Wilkins"
- `TZ` = `America/New_York`
- `KEEP_ALIVE_URL` = the herokuapp.com URL
- `DEBUG_SCREENSHOTS` = (off normally; flip to `true` to capture
  screenshots in `/app/screenshots` during a run — ephemeral!)
- `GIST_ID` + `GIST_TOKEN` — durable bookings.json persistence
  across dyno cycles (see "Durable persistence" below).

## Durable persistence (the bookings.json gist)

The Heroku Eco dyno's filesystem is wiped on every restart/redeploy,
so `bookings.json` cannot live on the dyno alone. Instead a private
GitHub Gist holds the canonical copy:

- **Boot:** `src/store.js::syncFromGistOnBoot()` pulls the gist and
  overwrites the local `bookings.json` before the scheduler reads
  anything. Runs once from `startScheduler()`. Retries up to **3
  times** with 2 s backoff on transient network failure. 401/403/404
  are treated as fatal (bad token or bad gist id — retrying won't
  help) and short-circuit immediately.
- **Save:** every `saveBookings()` call writes the local file
  synchronously (instant — the 7:00 AM critical path never blocks on
  the network), then schedules a debounced (1.5 s) PATCH to the gist
  in the background. Bursts of saves coalesce into one API call.
- **Shutdown:** SIGTERM / SIGINT handlers in `server.js` call
  `flushPending()` from the store before `process.exit(0)`, so any
  save still inside the 1.5 s debounce window is flushed to the
  gist before the dyno dies. Heroku gives ~30 s after SIGTERM, which
  is plenty for a gist round-trip.
- **Source-of-truth:** local file. The gist is the durable mirror.

### Safety invariant: never clobber the gist with stale local state

The store tracks a `bootSyncOk` flag. Until `syncFromGistOnBoot()`
finishes successfully (or short-circuits because gist is disabled),
**all pushes are blocked** — `saveBookings()` still updates the
local file but does NOT PATCH the gist. This is the critical
safety property: if the boot fetch fails (e.g., GitHub API unreachable
for the whole 3-retry window), the gist is preserved untouched until
the next dyno cycle gets another chance to boot-sync. Without this
guard, a transient outage would let the empty-default local file
overwrite the real queue on the first save.

The flag is also set when gist is disabled (`GIST_ID` / `GIST_TOKEN`
unset) so file-only mode "just works" — pushes simply no-op.

If `GIST_ID` / `GIST_TOKEN` are unset (e.g., local dev) the gist side
is a no-op and the store is just the local file.

**One-time setup the owner already did:**

1. Created a private gist at gist.github.com containing one file
   named `bookings.json` with the initial content `[]`.
2. Copied the gist id (the hex string in the URL) into Heroku config
   var `GIST_ID`.
3. Created a fine-grained GitHub PAT with **Gists: read & write**
   only (no repo scope needed), copied it into Heroku config var
   `GIST_TOKEN`.

After that, every add/edit/remove on the dashboard automatically
mirrors to the gist within ~1.5 s. No manual snapshot copying. A
dyno restart or redeploy will rehydrate the queue from the gist on
boot. The gist's revision history doubles as a free audit log.

> **Note on the legacy `add-booking.js` CLI**: it was deleted along
> with the `npm run add` script in PR #17. The CLI wrote directly to
> the local `bookings.json` without going through `src/store.js`, so
> it bypassed the gist — a footgun. The dashboard is now the only
> path to mutate the queue.

## Heroku Platform API access (for Claude)

Claude can operate on the Heroku app directly (set config vars,
restart dynos, tail logs, list releases) via the Heroku Platform API.
The owner provisioned an API authorization token; it lives in
`./.env` as `HEROKU_API_KEY=...` (gitignored — `.env` is in
`.gitignore`). Any bash command can use it via `. ./.env` + standard
`curl` calls. Example:

```bash
. ./.env && curl -sS \
  -H "Authorization: Bearer $HEROKU_API_KEY" \
  -H "Accept: application/vnd.heroku+json; version=3" \
  https://api.heroku.com/apps/tee-time-booker/config-vars
```

This means a future Claude session does NOT need to ask the owner
to open the Heroku dashboard for routine ops (deleting config vars,
checking deploy status, tailing logs). Critically: the token has
full account access — don't push it to the repo, don't log it,
don't echo it to any output that gets captured.

CLI for the user (when they want to): `~/heroku-cli/heroku/bin/heroku ...`

---

## Repo layout

```
~/tee-time-booker/
├── server.js          Express dashboard + scheduler boot + keep-alive
├── src/
│   ├── booker.js      Playwright automation (login, navigate, book, guest fill)
│   ├── scheduler.js   node-cron daily 6:58 ET trigger + startup recovery
│   ├── rules.js       Club play-window engine (intersect + auto-shift)
│   ├── time.js        Timezone-explicit helpers (Intl-based)
│   ├── config.js
│   └── logger.js
├── rules.json         Scioto play-window table (display strings + intervals)
├── Dockerfile, heroku.yml, Procfile
├── bookings.json      Booking queue (read/written by web + scheduler)
└── HANDOFF.md         (this file)
```

---

## Dashboard tabs (as of 2026-05-27)

1. **Schedule** — schedule a future booking (date 8+ days out). Bot fires
   at 6:58 AM ET, 7 days before play date.
2. **Book Now** — runs the booker immediately on a date 1-7 days out.
   Uses `booker.run()` (no rapid-fire wait). Good for verifying the
   booking *form filling* works.
3. **Test 7AM** — one-shot dry run of the precision flow (`runPrecision()`)
   at a user-picked trigger time today. Uses `bookingOpenTimeOverride` to
   set when the rapid-fire kicks in. Verifies the full timing path
   without waiting until tomorrow morning.
4. **Probe** — read-only diagnostic (PR #30/#31, 2026-05-22). Walks the
   whole booking flow and captures each screen's HTML + a full-page
   screenshot + a selector-health table, **without booking anything**.
   Run it after Scioto/Foretees change their pages to recapture the DOM.
   See "What was shipped 2026-05-22" below.
   - **Checking a run (the owner's flow):** the owner clicks **Run Probe**
     in the dashboard, then says *"check the probe."* That's all they do.
   - **How you check it:** fetch it yourself off the live URL —
     `curl -s "https://tee-time-booker-22be88cf5377.herokuapp.com/api/probe-latest" | jq 'del(.captures[].screenshot)'`
     (the raw payload is ~550 KB of base64 screenshots; strip them).
     Add `?pw=<DASHBOARD_PASSWORD>` if the dashboard password is set.
     The `selectors` table on each capture flags any selector that
     dropped to 0 on the booking-form steps (05–10) — that's what to fix
     in `src/booker.js`. `probe-latest.json` is gitignored and only on the
     dyno's ephemeral disk, so it is **never** in a fresh sandbox clone;
     the live endpoint is the only way to see a run. **Do not ask the
     owner to run anything or paste the JSON.**
5. **My Queue** — view/remove queued bookings. Test bookings show a
   purple `TEST` badge. The queue is automatically mirrored to a
   private GitHub Gist (see "Durable persistence" above), so dyno
   restarts no longer require any manual snapshot step. Cards now
   surface a `ruleNotice` line when the booker auto-shifted the window.
6. **Club Rules** — read-only render of `rules.json`. Shows every
   member-category row in the Scioto table (Full / Spouse / Junior /
   Juvenile / Guests / Social), with the two rows the engine actively
   enforces (Full Member + Guests of Full) highlighted. Owner replaces
   `rules.json` when Scioto issues a new table; the page re-renders on
   reload.

Each booking form has separate inputs:
- **Member Partners** — comma-separated Scioto member names (Partners tab →
  Members tab fallback).
- **Guests (Non-Members)** — dynamic per-row list: each guest gets a name
  input + a **type** dropdown (Family / Guest / Social Guest). Type flows
  through to `addGuest(name, slot, type)` which clicks the matching
  Foretees guest category — so what the rules engine validates is what
  actually gets booked.
- **Live rule preview** — a banner under each form (`/api/rules/preview`)
  that shows ok / auto-shifted / blocked as the user fills the date,
  window, and guests.
- Total partners + guests capped at 3 (server validates).

---

## Key code paths

### `src/booker.js`
- `run()` — Book Now path. Login → navigate → tee sheet → select → fill form → submit. Retries up to 5 slots if hit by "Minimum Player Limit" errors.
- `runPrecision()` — Scheduled 6:58 AM path. Login → navigate → wait until `openTime - 1min` → **two-speed** URL polling (1000 ms before 7:00 ET, 100 ms after — 2026-05-27 fix to avoid triggering ForeTees' session-abuse heuristics with 600 hits/min) → first successful load → click slot → **check `detectSessionError()`** → fill form → submit. Honors `booking.bookingOpenTimeOverride` when present (used by Test 7AM tab). On Session Error 3, recovers by re-navigating to the tee sheet (releases the held slot server-side) and re-picking with the failed time on a skip list, up to 3 attempts. Wrapped in a 10-minute `Promise.race` watchdog (PR #19): if a Playwright op hangs the run is force-aborted, the browser is force-closed, and a `PRECISION_TIMEOUT` screenshot + failed result is returned so the dashboard never sticks on a runaway booking.
- `fillBookingForm()` — Sets self transport, then fills **guests first** (slots 2..G+1) and **partners last** (slots G+2..). Slot ordering reversed in PR #24 (2026-05-14) so guests sit adjacent to the host member, avoiding Foretees' Player/Guest Association confirmation modal. Loop bound `nextSlot <= 4` handles every combination of 0–3 guests with 0–3 partners.
- `addPartner(name, slot)` — Click Partners tab, then scan `.ftMs-partnerSelect .ftMs-resultList .ftMs-listItem` only (PR #19 scoped this; a whole-document walk used to false-match the "Welcome, <member>" banner). Requires last name AND first name(s) to appear separately in the displayed `"Last, First (handicap)"` text — do NOT require concatenated `"First Last"`, that ordering never occurs in the list. Falls back to `tryMembersTab()` if not found.
- `tryMembersTab(name, transSelectIndex)` — Members-tab fallback. PR #19 rewrote this: clicks the tab via `[data-fttab=".ftMs-memberSearch"]`, **types the last name into `.ftMs-memberSearch .ftMs-input`** (the result list is empty until you type — the old code never typed and matched random page text), waits ~800 ms for ajax results, then clicks a matching `.ftMs-listItem` inside `.ftMs-memberSearch .ftMs-resultList` only. Re-fetches transport `<select>`s after the click and sets transport on the slot.
- `addGuest(name, slot)` — Scioto flow (rewritten in PR #27,
  2026-05-14):
  1. `focusSlot(slotIdx)` — click the target player row.
  2. `dismissAddingMemberOrGuestDialog()` — close the
     "Adding a Member or Guest" jQuery UI intro dialog if it
     popped (first slot-click of the session), ticking
     `Don't show this message again`. Logs
     `intro-dialog-dismissed` in `attempts` when it fires.
  3. `switchToFormTab('Guests', '.ftMs-guestTypes')` →
     `clickGuestCategory('Guest')` → wait for the Guest
     Registration modal.
  4. **TBA path** (`name` matches `/^tb[ad]$/i`):
     `clickTbaInRegistration()`.
  5. **Named-guest path:** `fillGuestRegistrationAndAdd(first, mi,
     last)` — three-strategy cascade:
     - **Strategy 1**: click the existing guest entry in
       `.ftGdb-guestSelect .ftMs-resultList .ftMs-listItem`
       (`Last, First` whitespace-normalized, exact-then-prefix
       match, TBA excluded). Owner's happy path — works
       whenever the guest was pre-added on Foretees.
     - **Strategy 2**: click the `[data-fttab=".ftGdb-guestAdd"]`
       tab → fill `input[name="name_first"]` / `name_mi` /
       `name_last` → click the dialog button-pane
       `Add New Guest`.
     - **Strategy 3 (TBA fallback)**: re-switch to Search Guests
       tab, click TBA. Records a soft `guest_tba_fallback`
       diagnostic.
  6. `waitForModalToClose(modalHandle)` is the universal success
     signal — modal becomes `display: none`.
  7. After-action verification via `readSlotNames`/`didSlotFill`.
     On failure, dumps `panelHtml` + `modalHtml` + screenshot to
     a `guest_add_failed` diagnostic.
  Helpers: `parseGuestName`, `focusSlot`,
  `dismissAddingMemberOrGuestDialog`, `findGuestRegistrationModal`,
  `waitForGuestRegistrationModal`, `captureModalHtml`,
  `fillGuestRegistrationAndAdd`, `waitForModalToClose`.
- `switchToFormTab(label, paneSelector)` — Reliable tab switch using `data-fttab="..."` attribute (Scioto's tabs are `<div data-fttab>` not `<a>`). Falls back to text match.
- `clickGuestCategory(name)`, `clickTbaInRegistration()`, `clickTbdXItem()` — Scioto-specific click helpers (see "Scioto Foretees DOM cheatsheet" below).
- `readSlotNames()` — Returns one string per player row; primary source is the `input[type="text"]` value, but PR #19 added a fallback to the `.playerType` label when the input is empty. That fallback is critical for the TBD-X path: Foretees stores the "X" indicator in `<div class="playerType">X</div>` and leaves the input empty, so the old version of this method reported TBD-X rows as empty and produced spurious `guest_add_failed` diagnostics. The "Member" label on the self row is intentionally ignored (it's always present) so an untouched member row still reads as empty.
- `didSlotFill(beforeSnapshot, slotIdx)` — Compares before/after `readSlotNames()` to confirm a slot got populated.
- `selectTeeTime(skipTimes)` — needed spots = 1 + partners + guests. Best-fit by open-count distance, then by closeness to start time.
- `submitBooking()` — Clicks "Submit Request" via `page.evaluate`. Handles `Minimum Player Limit` (retry next slot), `Member Already Playing` (hard fail), success messages. **PR #23 + #25 (2026-05-14): unconditionally clicks any visible "Yes, Continue" button before the generic OK/Confirm/Yes dismiss** — Foretees pops a Player/Guest Association confirmation modal under conditions we don't fully control, and the only correct behavior is to let the booking through. Records `yes_continue_clicked` in diagnostics. Returns `true` / `'partial'` / `false` based on `verifyBookingOnSheet()` (PR #15). On `false`, PR #23 added a `verify_failed` diagnostic capturing the visible button labels + page-text snippet so no failure has an empty diagnostics array.
- `verifyBookingOnSheet()` — Re-fetches the tee sheet after submit and inspects the row at `this.chosenTime`. Tri-state return (PR #15): `'verified'` (member on slot + expected player count), `'partial'` (member on slot but guests/partners short — tee time IS secured on Foretees), or `false` (member not on slot). Diagnostics record `partial_booking` events.
- `recordDiag(event, payload)` / `forceScreenshot(name)` / `capturePanelHtml()` — Diagnostic plumbing. Every booking now ends with a `diagnostics` array on the booking record containing structured events (`guest_add_failed`, `partial_booking`, `session_error_3`, etc.) so we don't have to set `DEBUG_SCREENSHOTS=true` to retro-debug a failed run. `capturePanelHtml` skips the navbar and prefers the actual `.ftS-requestWrapper` / right-side player panel.
- `detectSessionError()` — Reads both the jQuery UI dialog title and `slot_container[data-ftjson]`'s `page_start_title` + `page_start_notifications` to catch ForeTees' "Session Error N" page that lands on `Member_slot` after an over-aggressive rapid-fire phase. Used by both `runPrecision` and `run` to skip the failed slot and recover instead of pressing on into an empty form.
- `addGuest(name, slot, guestType = 'Guest')` — `guestType` (Family / Guest / Social Guest) is passed straight to `clickGuestCategory(guestType)` so the booking actually sits under the category the rules engine validated against (matters for Sat/Sun where Family guests have wider windows). Constructor normalizes legacy string-only guests to `{name, type: 'Guest'}` for backwards compatibility.

### `src/rules.js` + `rules.json` (added 2026-05-27)
- `rules.json` encodes the Scioto play-window table two ways: a `table` array with verbatim cell text for every category × day (drives the **Club Rules** tab), and an `engine` object with minute-from-midnight intervals for `memberWindows` (Full Member) and per-`guestType` `guestWindows`. Replace the whole file when Scioto issues a new table — both halves are owner-facing and easy to keep in sync.
- `evaluateBooking({date, start, end, guests})` — intersects member + per-guest-type allowed intervals for the date's day-of-week. If the requested window has a ≥15 min overlap with allowed time, uses that overlap. Otherwise picks the nearest allowed interval starting at or after the requested start, preserving the original 60-min default window length (capped to the interval end). Returns `{ok, day, original, effective, adjusted, allowed, reason}` or `{ok:false, reason}` when no window on that day works for the guest mix.
- `normalizeGuests(input)` — accepts the legacy comma-string form (`"A, B"`) AND the structured form (`[{name, type}, ...]`) so old bookings rehydrated from the gist keep working. Missing types default to `Guest`.
- The server's `applyClubRules({date, start, end, partners, guests})` helper wraps all of this for the three POST endpoints (`/api/bookings`, `/api/book-now`, `/api/test-precision`) — they store the adjusted `timeWindow` plus the original `requestedWindow` and a human-readable `ruleNotice` string when the engine shifted the window.
- **Holidays:** day-of-week mapping only for now (no holiday detection). If the owner ever needs Memorial Day / July 4 etc. to follow the Holidays column, add a flag to the booking record + a small lookup; the rules engine already has a `Holidays` key ready in `memberWindows` / `guestWindows`.

### `server.js`
API endpoints (all behind optional `DASHBOARD_PASSWORD` cookie/query):
- `GET /api/bookings` — list with enriched `triggerDate`
- `POST /api/bookings` — schedule (validates partners+guests ≤ 3, no duplicate date, runs `applyClubRules` to auto-shift the window — stored booking carries `timeWindow` (effective), `requestedWindow` (original), and `ruleNotice` when adjusted)
- `GET /api/rules` — serves `rules.json` verbatim for the Club Rules tab
- `POST /api/rules/preview` — `{date, start, end, guests}` → `evaluateBooking()` result. The booking forms call this on every input change for live ok/shift/blocked feedback under the form.
- `DELETE /api/bookings/:id` — remove. PR #21 (2026-05-14) relaxed the in_progress block: an `in_progress` row whose `startedAt` is more than 15 min old (watchdog ceiling + buffer) can now be cleared, so a dashboard never sticks on a dead run. Rows missing `startedAt` (pre-fix legacy data) are also deletable.
- `POST /api/book-now` — immediate `booker.run()`. Sets `startedAt` on creation.
- `GET /api/bookings/:id` — poll status
- `POST /api/test-precision` — stores `triggerEpochMs` (absolute UTC ms) on the booking and calls `scheduleTestPrecisionRun(booking)`. Validates trigger 3 min – 6 h from now. PR #22 (2026-05-14) made test runs restart-survivable: the same helper is also called at boot for any pending `testRun` rows in the gist, so a dyno restart no longer loses an in-flight test.
- **Boot sequence (PR #22):** `server.js` boot is an async IIFE that `await`s `startScheduler()`, re-arms in-memory test timers for any pending testRun rows that survived in the gist, **and then** binds the HTTP listener. The old code called `startScheduler()` without await and listened immediately, opening a 1–2 s window where POSTs could be silently overwritten by the gist boot-sync.

### `src/store.js`
- `loadBookings()` / `saveBookings(arr)` — local-file source of truth.
- `syncFromGistOnBoot()` — called once from `startScheduler()` before any reads. Fetches the gist and overwrites the local file. No-op when `GIST_ID` / `GIST_TOKEN` are unset.
- Background debounced PATCH to the gist on every save (~1.5 s coalescing window). Critical-path saves never block on the network.

### `src/scheduler.js`
- Daily cron at `(openTime - loginLeadMinutes)` ET, default `58 6 * * *`.
- `startScheduler()` is async — it awaits `syncFromGistOnBoot()` before scheduling cron or scanning interrupted bookings. The server boot now also `await`s `startScheduler()` itself (PR #22) before binding the HTTP listener.
- `checkAndRunBookings()` filters pending bookings whose `play_date - 7 days == today`. **Skips `testRun: true` bookings** so the Test 7AM tab never gets accidentally re-fired by the cron. **Wrapped in an `isRunning` mutex** so cron + startup-recovery can't double-fire in the trigger window (PR #13). Sets `startedAt` on every booking that flips to `in_progress`.
- **Startup recovery (revised PR #21):**
  - `in_progress` testRun bookings are immediately failed out with reason "Booking interrupted by dyno restart and could not auto-resume" — their in-memory `setTimeout` is gone and re-running them at the wrong time creates ghost bookings on Foretees.
  - `in_progress` non-test bookings are re-run via `checkAndRunBookings()` as before.

---

## User preferences for working with Claude

- **Do not require the terminal — ever, including for diagnostics.** User
  wants Claude to ship changes AND gather diagnostic data directly. That
  means:
  - Edit files via tool calls.
  - Commit and push to the designated feature branch via `git`.
  - **Open + merge a PR via the GitHub MCP API** (`mcp__github__create_pull_request` then `mcp__github__merge_pull_request`). The merge into `main` triggers Heroku auto-deploy.
  - Do NOT try `git push origin main` from the sandbox — the proxy returns 403. Only the feature branch is pushable directly.
  - **Diagnostics are Claude's job, not the owner's.** The sandbox has
    outbound network, so fetch probe results (`/api/probe-latest`),
    screenshots (`/screenshots-files/<name>`), and Heroku logs (Platform
    API token in `./.env`) **yourself**. The owner's only interface is the
    dashboard's buttons and chat — if a task seems to need a terminal,
    that's a cue to do it for them, never to hand them a command. The
    owner reiterated this forcefully on 2026-05-31 after a probe-check
    detoured into curl/jq instructions.
- **Repo scope**: GitHub MCP tools are restricted to `jimmyttt21/tee-time-booker`. Don't try anything else.
- **Branch**: most recent session branch is `claude/add-documents-folder-6GiFk` (this update). Future sessions will use their own designated branch — check the session's git instructions for the name.
- User is non-technical and will not run CLI commands. Explain results in plain English. Don't dump logs or diffs unless asked.
- User can flip Heroku Config Vars via the Heroku dashboard if asked (e.g., `DEBUG_SCREENSHOTS=true`).
- User cannot test live UI for you. If you change UI, describe what they should see.

---

## How to deploy (the actual sequence)

1. Make code edits on the session's designated feature branch.
2. Commit with a clear message.
3. `git push -u origin <feature-branch>` — this works from the sandbox.
4. Open a PR with `mcp__github__create_pull_request` (base: `main`,
   head: feature branch).
5. Merge with `mcp__github__merge_pull_request` (method: `merge`).
6. Heroku auto-deploys from `main`. Build takes ~2-3 min. User can watch
   the Activity tab in Heroku dashboard.

If the user wants the PR style instead of direct merge (i.e. a click-to-merge
button rather than auto-merge), open the PR and stop — they'll click Merge.

---

## What was shipped 2026-05-10 (this session)

### Commit `8b84b8f` (PR #1, merged as `f96b3fe`)
**Add dedicated Guests field to dashboard and wire up Guests tab booking**
- Dashboard: separate **Guests (Non-Members)** input on Schedule and Book Now tabs, alongside renamed **Member Partners** field.
- API: `guests[]` accepted on POST `/api/bookings` and POST `/api/book-now`; partners + guests capped at 3.
- Booker: new `addGuest()` switches to Guests tab, fills name (split or full-name layout), clicks **Add** with a guard against firing the form-wide Submit. `selectTeeTime` counts guests in needed-spots.
- Queue + scheduler logs show guests when present.

### Commit `0f74193` (PR #2, merged as `10806a0`)
**Add Test 7AM tab: one-shot precision dry run at user-picked time**
- New `POST /api/test-precision` endpoint.
- `booker.runPrecision()` honors `booking.bookingOpenTimeOverride`.
- Scheduler skips `testRun: true` bookings.
- New "Test 7AM" tab in dashboard, TEST badge in My Queue.

---

## What was shipped 2026-05-11 (this session)

Branch: `claude/add-documents-folder-6GiFk`. Test scenario throughout
was **Solo member + 3 TBA placeholders** via the Test 7AM tab.

### PR #9 — Booking diagnostics + partial-booking detection
- New `diagnostics: []` array on every booking record. Events:
  `guest_add_failed`, `partial_booking`, `submit_uncertain`.
- `verifyBookingOnSheet()` after submit: re-fetches the tee sheet,
  finds the slot that holds the member, checks all required player
  names are present. If only the member shows up while guests were
  requested → records `partial_booking` event and marks the booking
  `failed` rather than `completed`.
- `readSlotNames()` snapshots the form state before/after each guest
  add so the booker can tell whether a click actually populated the
  slot vs silently doing nothing.
- `forceScreenshot()` saves a PNG even when `DEBUG_SCREENSHOTS=false`,
  but only on real failure paths so we don't fill the dyno disk.

### PR #10 — Capture the right HTML panel
- First diagnostic round captured the dashboard navbar instead of the
  Foretees player panel, because the page has a "Guests" item in both
  places. Now `capturePanelHtml()` prefers `.ftS-requestWrapper` and
  the right-side player panel, skipping the navbar.

### PR #11 — TBA via the correct Scioto flow
- The earlier "TBA option button + typed-name fallback" never matched
  Scioto's actual DOM and silently submitted partial bookings.
- Correct flow (confirmed manually by owner):
  1. Click **Guests** tab → 3 categories appear (Family / Guest / Social Guest).
  2. Click **Guest** → guest-registration screen opens with a list on the right.
  3. Click **TBA** at the top of that right-side list → the placeholder
     drops into the current `Select Player #N` slot.
- Implementation:
  - `switchToFormTab('Guests', '.ftMs-guestTypes')` — uses `data-fttab` attribute.
  - `clickGuestCategory('Guest')` — clicks the category inside `.ftMs-guestTypes`.
  - `clickTbaInRegistration()` — finds and clicks an exact-text "TBA"
    element, preferring leaf `.ftMs-listItem`/`a`/`button` over containers.
- Fallbacks kept for resilience (TBD tab → "X", generic exact-text "TBA"
  scan). **TBD is intentionally not the primary** because per the owner
  "TBD is to hold for anyone and that is not always allowed depending
  on the time."

### Test result 2026-05-11
Re-ran Test 7AM with `TBA, TBA, TBA`. Result: **success — all 3 TBA
placeholders + the member on the booked slot.** The booking was
auto-cancelled (test run) but the booking-form flow is verified end
to end for the TBA case.

---

## What was shipped 2026-05-12 (this session)

Branch: `claude/test-booking-system-TCNBw`. Context: owner had just
queued a real booking for Wed 5/20 PM (trigger Wed 5/13 6:58 AM ET).
Asked Claude to verify "everything will work, nothing will shut down,
stop running, fail to restart, etc." Audit surfaced two real bugs.

> **Superseded by the GitHub Gist persistence change (claude/persist-scheduled-bookings-4NmDO):** the `BOOKINGS_JSON` env var, `seedFromEnvIfNeeded()`, the `/api/snapshot` endpoint, and the "Copy snapshot" UI are all removed. Persistence is now fully automatic via the gist. The PR #13 history below is kept for context, but the env-var workflow it describes no longer exists.

### PR #13 — Harden persistence + restart safety

1. **Persistence bug.** The existing `loadBookings()` env-var fallback
   only fired when `bookings.json` was missing or unparseable. After a
   deploy or dyno cycle, the slug restores `bookings.json` to its git
   state (`[]`), which is a *valid parse* — so the fallback was
   skipped and any dashboard-added bookings vanished. Fix: new
   `seedFromEnvIfNeeded()` in `src/scheduler.js`, called once from
   `startScheduler()`, merges `BOOKINGS_JSON` into the on-disk queue.
   Skips by id (duplicates already on disk), terminal status
   (`completed`/`partial`/`failed`/`expired`; `partial` added in
   PR #15), and stale trigger date (already past). Resets seeded
   `in_progress` back to `pending`.

2. **Double-fire race.** If the dyno restarted at exactly 6:58–7:15 ET,
   `startScheduler()`'s startup-recovery would call
   `checkAndRunBookings()` and the cron would also fire it in the same
   window. Each call marked its bookings `in_progress` and ran them;
   the second call would also re-pick the same `in_progress` bookings
   via the "interrupted" path → duplicate booking attempt. Fix:
   module-level `isRunning` flag wrapping `checkAndRunBookings()`;
   second call logs a skip message and returns.

3. **Owner-facing UX:** new `GET /api/snapshot` returns a paste-ready
   JSON string of pending bookings. The My Queue tab now shows a
   "Restart-Proof Snapshot" card with a "Copy snapshot to clipboard"
   button + collapsible instructions for pasting into Heroku's
   `BOOKINGS_JSON` config var. Card auto-hides when the queue is empty.

### Verified live

Owner set `BOOKINGS_JSON` to the snapshot of the queued 5/20 booking.
Heroku auto-restarted the dyno. Boot logs showed the booking loaded
even though the slug's `bookings.json` was `[]` — first end-to-end
confirmation that `seedFromEnvIfNeeded()` does what it says. Owner
then edited the booking (swapping `TBA, TBA` for two real named
guests, sidestepping the still-unverified non-TBA named-guest path
for the live run) and updated the env var again. Final queued state:

```
05/20/2026 13:30-15:00 | Transport: C-B | Partners: (none) |
Guests: Matt Martin, Matt Brown, Mitch Delaware | Triggers: 5/13/2026
```

### Workflow note for future Claudes

This manual snapshot workflow is no longer used. Persistence is now
fully automatic via a private GitHub Gist (`GIST_ID` + `GIST_TOKEN`
config vars). See the "Durable persistence" section near the top of
this file for the current model.

---

## What was shipped 2026-05-13 (later same day) — `didSlotFill` false-failure fix

Branch: `claude/fix-guest-fill-diagnostic`. Cosmetic-only follow-up after a
real booking succeeded but the My Queue tab still showed an orange
`Diagnostics (1)` disclosure on the card.

**The bug.** `didSlotFill(before, slotIdx)` was checking only whether the
*specific targeted player row* filled. Foretees actually auto-routes any
guest/TBA pick into the **leftmost empty row**, regardless of which
"Select Player #N" prompt is active in the right panel. So when partner-fill
had not yet populated slot 2 by the time the TBA-guest add fired for slot 3,
Foretees put the TBA into slot 2 — the add succeeded, but `didSlotFill`
looked at slot 3, saw it empty, and recorded a spurious `guest_add_failed`.
The booking submitted, Foretees verified it, status reported as `Booked`,
but the scary diagnostic remained.

**The fix.** `src/booker.js::didSlotFill()` now treats the action as
successful if **any** previously-empty player row among slots 1–4 is now
filled, in addition to the original target-slot check. Single-flight
semantics (one `addGuest()` in flight at a time) mean any newly-filled row
is attributable to the action that just fired.

**What did not change.** Real failures (no row anywhere filled, modal
selector miss) still record `guest_add_failed` and capture `panelHtml`
exactly as before. `addPartner()` and the `verifyBookingOnSheet()` final
check are untouched.

### Verified against the real diagnostic

Real booking 2026-05-13: member + 1 partner (Alexander Wilkins) + 1 TBA
guest. Status reported as **Booked**. Old diagnostic showed:

```
guest_add_failed · target slot 3
Slot names before: ["Jeffrey G Wilkins","","","",""]
Slot names after:  ["Jeffrey G Wilkins","TBA","","",""]
```

The TBA correctly landed in slot 2 (the partner hadn't filled there yet),
and the booking succeeded. Under the new `didSlotFill`, this returns `true`
on the first auto-route attempt and never records the diagnostic.

---

## What was shipped 2026-05-13 (this session)

Branch: `claude/fix-guest-names-booking-m0UMk`. **PR #15 — `d54cf9f` +
`ab307bb` → merged into `main` as `74dd515`**, Heroku auto-deployed.

Context: the live 5/20 booking executed but **none of the named
guests landed on the slots** — only the member was on the booking.
Owner captured screenshots of the actual Foretees flow: the
named-guest path goes through a **Guest Registration modal** that
opens after clicking "Guests" → "Guest" category, not a panel-side
text input.

### Named-guest flow (corrected)

1. Click the target player slot (focuses "Select Player #N").
2. Click the **Guests** tab.
3. Click the **Guest** category in the right panel.
4. The **Guest Registration** modal opens with: First Name *,
   Middle Initial, Last Name *, Guest Locker, plus a right-side
   search list whose top entry is "TBA".
5. Type First Name + Last Name (and optional MI) and click
   **Add New Guest** — the modal closes and the name drops into the
   slot. (TBA path: click "TBA" in the right list instead of typing.)

### Changes — `d54cf9f` (named-guest flow)
- `src/booker.js`:
  - `addGuest()` rewritten — both TBA and named guests share the
    same Scioto modal path (slot focus → Guests tab → Guest category
    → modal action). The old "try to type into the panel directly"
    code is gone.
  - New `focusSlot(slotIdx)` — clicks `#slot_player_row_<idx>` so
    Foretees' "Select Player #N" pointer is on the right slot.
  - New `parseGuestName(name)` — splits "First [MI] Last".
  - New `fillGuestRegistrationAndAdd(first, mi, last)` — anchors on
    the visible "Add New Guest" button to find the modal container,
    fills inputs by label + attribute hints (excluding the right-side
    guest-search box), then clicks the button.
- `fillGuestNameAndAdd()` retained but no longer called from
  `addGuest`; safe to remove if a future session confirms nothing
  else reaches it.

### Changes — `ab307bb` (`partial` status)

Owner's priority: *"the key piece is that I secure the tee time no
matter what. so whatever has to happen for that. i can fill in other
info later if need be."* Form submission was already unconditional
(the loop in `fillBookingForm` ignores `addGuest`'s return value).
But when Foretees accepted a member-only submit because guests didn't
fill, `verifyBookingOnSheet()` returned false and the booking got
marked `failed` — even though the tee time was real and live on
Foretees. That was misleading.

- `verifyBookingOnSheet()` now returns tri-state: `'verified'`
  (member + expected player count), `'partial'` (member on slot but
  player count short — tee time IS secured), or `false` (member not
  on slot).
- `submitBooking()` propagates `'partial'`; `run()` / `runPrecision()`
  return `{ success: true, partial: true }`.
- `src/scheduler.js` and `server.js` map this to a new `partial`
  booking status. Dashboard shows yellow "Booked (Partial)" badge +
  helper text: *"Tee time secured. One or more guests/partners did
  not fill — add them manually on Foretees."*
- `seedFromEnvIfNeeded()` treats `partial` as terminal (alongside
  `completed`/`failed`/`expired`) so a dyno cycle never replays a
  partial booking.
- Dashboard CSS: new `.booking-item.partial` (yellow left border)
  and `.status-partial` (yellow pill).

### How the bot behaves in the worst case

If named-guest fills all fail:
1. The form still submits — the member is on the slot.
2. Foretees either:
   - **Accepts** (most afternoon slots have no min-player rule) →
     `partial` status, tee time secured, owner adds guests manually
     on Foretees.
   - **Rejects with "Minimum Player Limit"** → bot tries up to 5
     alternate slots in the time window.

### Deployment workflow note (codified this session)

The default is: Claude pushes to the feature branch and stops. Owner
explicitly says "make it live" before Claude opens + merges the PR.
This session confirmed the trade-off: small extra step in exchange
for guaranteed sign-off on every deploy. The risky cases (cron,
persistence, scheduler) absolutely need this gate; routine UI fixes
could in principle auto-PR but owner prefers the consistent flow.
Future Claudes: don't auto-merge without explicit go-ahead.

---

### Open follow-ups for next session
- **Named-guest path: live verification still pending.** PR #15
  shipped the corrected Guests → Guest category → **Guest
  Registration modal** flow on 2026-05-13. Logic matches the
  owner-captured modal screenshots but hasn't yet hit a real
  booking. The `partial` status added in PR #15 means a selector
  miss won't lose the tee time — the bot still submits with the
  member on the slot, and the booking is reported as `partial` so
  the owner knows to add guests manually on Foretees. If selectors
  do miss, the failure path captures the modal HTML in
  `panelHtml` + a screenshot at `07_guest_<n>_FAILED.png` so the
  next session can refine `fillGuestRegistrationAndAdd()`.
- **Ghost partial bookings can linger** on Foretees if a previous
  run submitted with only the member. The user clears these
  manually on Foretees before the next test. Worth detecting in
  `runPrecision`/`run` startup (search the next-7-days sheets for
  the member's name and warn) — not a blocker.

---

## What was shipped 2026-05-14 (this session)

Branch: `claude/fix-booking-timeout-sgZP0`. **PR #19 — `6d3e3c5` +
`67bfa62` + `edbf251` → merged into `main` as `862cd1a`**, Heroku
auto-deployed.

Context: owner reported the dashboard showed an 8:10 PM test booking
as "Running Now" past its trigger time. Investigation via the Heroku
Platform API revealed the booking had actually failed at 8:17 PM
(rapid-fire couldn't load the 5/21 tee sheet — see the Foretees
behavior note below). The dashboard staleness was a refresh issue,
not a code bug, but a follow-up test on 5/20 surfaced three
unrelated real bugs in the precision path.

### `6d3e3c5` — 10-minute watchdog on `runPrecision`
The branch name's motivation: a hung Playwright op in
`fillBookingForm` / `submitBooking` had no overall budget and could
pin the dyno indefinitely. The body is now wrapped in a
`Promise.race` against a 10 min watchdog. On timeout: force-close
the browser (so the inner racing work can't keep it alive), save a
`PRECISION_TIMEOUT` screenshot, and return a failed result with the
timeout reason. Inner `_doRunPrecision` keeps its own try/finally for
clean exits; the watchdog only catches genuine hangs.

### `67bfa62` — Partner name input was silently misfiled
The 5/20 partial-booking diagnostic showed
`Found via Members tab: Welcome, Jeffrey G Wilkins` — the partner
add had matched the page's welcome banner. Two combined bugs:
- **Partners-tab matcher** required the displayed text to contain
  the concatenated `"First Last"` string. Scioto renders
  `"Last, First (handicap)"`, so every multi-word partner name
  missed. Dropped that third term; matcher now scans
  `.ftMs-partnerSelect .ftMs-listItem` (scoped) and requires last +
  first to appear separately.
- **Members-tab fallback** walked the whole document for the last
  name and picked up "Welcome, &lt;member&gt;". Also never typed into
  the Members search input — the result list is empty until you
  type, so the fallback could never have worked even if it had been
  scoped. Now: clicks the tab via `data-fttab`, types the last name
  into `.ftMs-memberSearch .ftMs-input`, waits for ajax results,
  clicks only inside `.ftMs-memberSearch .ftMs-resultList`.

### `edbf251` — `readSlotNames` didn't see TBD-X as filled
When the Guests tab is hidden (Foretees restricts guests on certain
slots), `addGuest` falls back to TBD tab + click "X". Foretees
populates the player row with `playerType="X"` but leaves the name
`<input>` empty. The old `readSlotNames` only read the input, so
`didSlotFill` saw no change and recorded a false `guest_add_failed`
diagnostic. Fixed by falling back to the `.playerType` text when
the input is empty (ignoring the always-present `"Member"` label on
the self row so untouched member rows still read as empty).

### Foretees behavior surprises observed this session
- **Boundary-day tee sheets**: requesting `calDate=<today+7 days>`
  via the `Member_sheet` URL with `select_jump` redirects to the
  most recent already-open sheet (e.g., `today+6`). The bot's
  rapid-fire readiness check (title contains "Tee Sheet" +
  `a.teetime_button` exists) correctly rejects the redirect, but it
  means **test-precision on a play date that hasn't actually opened
  yet will burn the full 1200 attempts (~7 minutes) and then fail**.
  For real 6:58 ET runs this is exactly the desired behavior: the
  sheet opens at 7:00 sharp and the bot grabs it. For Test 7AM /
  Test Precision, pick a play date that's already inside the open
  window (1–6 days out, not exactly 7).
- **Guest restrictions per slot**: some Scioto slots (observed on
  8:10 AM 5/20 in tonight's test) carry a Foretees rule
  `* Guests are restricted from being added to this time.` and
  Foretees simply omits the Guests tab from the right-side panel.
  `addGuest` falls through to the TBD-X path, which succeeds (so
  the slot fills) but the tee time only has Member + TBD-X players.
  The bot's `selectTeeTimeFast` does NOT currently check this
  restriction before picking a slot; see Open follow-ups.

### Diagnostic workflow that worked this session
- **Heroku Platform API** is fast and complete for log spelunking:
  POST `/apps/<app>/log-sessions` returns a `logplex_url`; GET that
  URL streams `lines` lines of historical log. Use this instead of
  asking the owner to tail logs.
- **Dashboard screenshots** (`PRECISION_ERROR.png`, etc.) are still
  fetchable via `/screenshots-files/<name>?pw=<DASHBOARD_PASSWORD>`
  while the same dyno is alive. Combined with the structured
  `panelHtml` in each booking's `diagnostics` array, you can often
  diagnose a flow without ever asking the owner to repeat the test.

### Open follow-ups for next session
- **`selectTeeTimeFast` should skip guest-restricted slots when the
  booking has guests.** Today it picks the earliest open slot
  blindly, so a booking with TBA guests on a Saturday morning will
  consistently land on a Member-only slot and end up `partial`.
  Detect the `Guests are restricted` legend (or equivalently, the
  absent `data-fttab=".ftMs-guestTypes"` tab on the slot's form
  panel) and skip those slots when `booking.guests.length > 0`.
- **Boundary-day messaging in Test 7AM.** The dashboard could warn
  when the chosen play date is the 7-day boundary that the test
  will likely run the full rapid-fire budget without finding a
  sheet. Cheap UX win; not a code-correctness issue.

---

## What was shipped 2026-05-14 (later session) — booking-resilience overhaul

Branch: `claude/fix-bookings-bA128`. Five PRs merged into `main`,
Heroku auto-deployed: **#21, #22, #23, #24, #25**.

Context: owner came back at ~9 PM ET reporting a Test 7AM booking
stuck "Running Now" past its trigger, blocking the dashboard. The
session ended with the system end-to-end verified — a live
Test 7AM for 5/20 at 15:00–16:00 with Alexander Wilkins + 2 TBA
guests landed **`completed`** (not partial) on a 3:15 PM slot at
21:49 ET, with `yes_continue_clicked` recorded in diagnostics.

### PR #21 — `ba13b22` → merged as `98513df`
**Fix stuck in_progress bookings so dashboard self-heals on dyno restart**

Three small fixes that together prevent the dashboard from sticking
on "Running Now" forever after a precision-booking run dies:

- `src/scheduler.js`: on boot, immediately fail-out any `testRun`
  booking still in `in_progress`. Test runs are fired by an in-memory
  `setTimeout` in `server.js`, so once the dyno restarts that timer
  is gone and the booking can never resume on its own. The old
  startup-recovery path tried to re-run them, which silently hangs
  (`bookingOpenTimeOverride` already in the past + possible
  Member-Already-Playing if a prior partial booking secured the
  slot).
- `src/booker.js::runPrecision()`: do NOT `await this.browser.close()`
  inside the watchdog catch block. If Playwright itself is the thing
  that hung, `browser.close()` can stall indefinitely and silently
  re-introduces the very hang the watchdog exists to escape. Close
  is now fire-and-forget; `runPrecision` is guaranteed to return.
- `server.js`: `DELETE /api/bookings/:id` now allows removing
  `in_progress` bookings that started more than 15 minutes ago
  (watchdog ceiling + buffer). Younger runs are still protected so
  a live run can't be clobbered.

### PR #22 — `4da76fd` → merged as `1d04744`
**Persist test-precision through dyno restart + close boot-window write race**

Three additional persistence fixes:

- **Boot-window write race closed.** `server.js` used to call
  `startScheduler()` without `await` and then `app.listen()` on the
  next line. The local `bookings.json` starts empty after a Heroku
  redeploy; for the ~1–2 s the gist boot-sync is in flight, the API
  was already accepting POSTs against the empty file. When the sync
  finished it overwrote the local file with gist contents, silently
  dropping anything submitted in that window. Boot is now wrapped
  in an async IIFE that `await`s `startScheduler`, re-arms in-memory
  test timers, AND THEN binds the HTTP listener.
- **Test-precision is now restart-survivable.** The booking record
  stores `triggerEpochMs` (absolute UTC ms). The `setTimeout` body
  is factored into a new `scheduleTestPrecisionRun(booking)` helper
  used by both the POST endpoint and the boot recovery loop. On
  boot, the loop scans pending `testRun` rows surviving in the gist
  and calls the helper. If the boot lands more than 10 min past
  trigger, the test auto-fails with a clear message ("Trigger time
  passed N min ago without firing (likely a dyno restart).
  Re-schedule the test.") instead of firing stale. **This closes
  HANDOFF caveat #4 from the previous session.**
- **`startedAt` field added** everywhere status flips to
  `in_progress` (`book-now` creation, `test-precision` setTimeout
  body, scheduler `checkAndRunBookings` pre-loop). The PR #21
  15-min stale-DELETE check used to key off `createdAt` — fine for
  tests (created seconds before trigger) but wrong for real
  bookings whose `createdAt` is days in the past. Now keyed off
  `startedAt`; rows missing the field are still deletable as legacy.
- **`KEEP_ALIVE_URL` config var** is now honored, not just
  `HEROKU_APP_NAME` / `RENDER_EXTERNAL_URL`. The boot log says
  whether keep-alive is armed and which URL it'll ping.

### PR #23 — `3e82ae3` → merged as `f0f323a`
**Handle Foretees "Player/Guest Association" confirmation modal**

A live Test 7AM at 21:28 ET (Alex Wilkins + 2 TBA guests, slot
order self/Alex/TBA/TBA) failed at submit with
`Submit did not confirm booking (result: false)` and an empty
diagnostics array. Screenshots showed Foretees pops a
**"Player/Guest Association"** modal whenever guests aren't sitting
immediately after their host member ("Guests should be specified
immediately after the member they belong to. Would you like to
process the request as is? [No, Go Back] [Yes, Continue]").

The generic `submitBooking` popup dismiss matched
`/^(OK|Confirm|Yes)$/i` — "Yes, Continue" failed the regex because
of the comma + word, the modal stayed open, the real submit never
happened, `verifyBookingOnSheet` correctly reported no booking on
the slot, and the run failed with zero clue why.

Fixes in `src/booker.js::submitBooking()`:
- New explicit handler runs **before** the generic dismiss. Looks
  for a button matching `/^yes\s*,?\s*continue\b/i` across `<a>`,
  `<button>`, `<input type=button|submit>` and clicks it. Records
  a `yes_continue_clicked` diagnostic with the exact button label.
  Screenshots `09b_post_yes_continue.png`.
- The `verifyBookingOnSheet → false` path now also records a
  `verify_failed` diagnostic capturing `chosenTime`, a 800-char
  page-text snippet, and the first 30 visible button labels. An
  empty diagnostics array on a "Submit did not confirm" failure
  was what cost us a round of diagnosis — that won't happen again.

### PR #24 — `5b6facb` → merged as `32cfff9`
**Place guests immediately after self, partners last**

Root-cause fix for the modal that PR #23 just learned to dismiss.
All guests belong to the booking member (self, slot 1), so
Foretees expects them adjacent to slot 1. `fillBookingForm` now
processes guests **first** (slots 2..G+1) and partners **after**
(slots G+2..). Slot order before vs after, for the standard
"self + 2 TBA + 1 partner" booking:

```
before:                  after:
slot 1: Jeffrey   self   slot 1: Jeffrey   self
slot 2: Alex      partr  slot 2: TBA       guest
slot 3: TBA       guest  slot 3: TBA       guest
slot 4: TBA       guest  slot 4: Alex      partr
```

PR #23's modal handler stays in `submitBooking` as a defensive
backstop. Live verification on 5/20 15:00–16:00 with this exact
shape — Foretees still popped the modal once (Test 7AM run at
21:49 ET, see "Verified live" below), handler clicked through,
booking landed `completed`.

The `for (i=0; i<list.length && nextSlot<=4; i++, nextSlot++)`
loop pattern handles every combination of 0–3 guests with 0–3
partners cleanly: with 0 guests the guest loop is a no-op and
partners take slots 2..; with 3 guests the partner loop is a
no-op.

### PR #25 — `954f5d9` → merged as `a5596ed`
**Always click "Yes, Continue" on any Foretees confirmation modal**

Owner's directive after PR #24 went out: "always click yes,
continue, so booking goes through. I can fix anything after the
fact, except if the tee slot does not get booked!"

PR #23's handler was gated on detecting the specific Player/Guest
Association modal body text. That gate is unnecessary risk: if
Foretees ever pops a different confirmation modal with a
"Yes, Continue" button, or renames the existing modal copy, the
gate would let the modal block the submit. Dropped the gate —
any visible `Yes[,]?\s*Continue` button is clicked unconditionally
before the generic OK/Confirm/Yes dismissal.

### Verified live (end-to-end, 21:49 ET 5/13 EDT)

Test 7AM run, booking `bk_1778723131647_qrw98m`:
- Trigger: 21:49 ET, play date 5/20/2026, window 15:00–16:00,
  partners=`Alexander Wilkins`, guests=`TBA, TBA`, transport=C-B.
- Slot order on the form (PR #24): self / TBA / TBA / Alex.
- Foretees DID pop the Player/Guest Association modal anyway
  (so PR #23's handler still earns its keep — not sure why
  Foretees popped it for this shape, but the handler handled it).
- `yes_continue_clicked` recorded in `result.diagnostics` with
  the actual clicked button label.
- Final status: **`completed`** with `partial: false` and
  `result.time: "3:15 PM"`. `verifyBookingOnSheet` returned
  `'verified'`, meaning member + all expected player count
  present on the slot.

### Open follow-ups for next session
- **`selectTeeTimeFast` guest-restricted slot filter** —
  still open from previous session.
- **Boundary-day Test 7AM messaging** — still open from previous
  session.
- **Empty diagnostics on truly unhandled failures** — PR #23
  added a `verify_failed` diagnostic to the
  `verifyBookingOnSheet → false` path, but other rare error
  branches (e.g., browser crash, login fail) still throw with
  just an error string. Worth a pass to make every failure
  capture at least the visible buttons + page-text snippet so a
  single failed run is always diagnosable from the dashboard.
- **PR #21's `await this.browser.close()` removal in the
  watchdog catch** — fire-and-forget is right under hang
  conditions, but means the inner `_doRunPrecision`'s own
  Playwright calls might error noisily into the logs after
  the result has already been returned. The errors are caught
  by `_doRunPrecision`'s own try/catch so they don't crash the
  process; cosmetic only.

---

## What was shipped 2026-05-14 (final session) — guest-modal rewrite

Branch: `claude/fix-guest-booking-issue-wqOVd`. **PR #27 — `c2c1ecb`
+ `7538283` + `5ed96f5` + `979315e` → merged into `main` as
`b86f861`**, Heroku auto-deployed.

Context: the 5/21 1:45 PM booking landed the member but **none of
the 3 named guests filled** — same failure mode as PR #15 was
supposed to fix. Diagnostics showed `registration-fill:Add New Guest`
for every guest (the bot believed it succeeded) and `panelHtml`
came back empty. Owner shared the actual modal HTML this session,
which exposed three separate bugs and changed our model of the
Foretees guest flow.

### What the owner-captured HTML revealed

The real flow on first slot-click in a session is **three windows**:

1. **"Adding a Member or Guest" intro dialog** — a jQuery UI
   dialog (`.ui-dialog` titled `Adding a Member or Guest`) with a
   `Don't show this message again` checkbox and Close buttons. It
   modal-overlays the page until dismissed. Programmatic `click()`s
   fire through the overlay, which is why every prior diagnostic
   showed focus-slot → guests-tab → guest-category → registration-
   fill all reporting success while no guest landed.
2. **"Guest Registration" modal** — a `.ui-dialog` titled
   `Guest Registration` with two inner tabs in `.ftGdb-tabs`:
   - **Search Guests** (`data-fttab=".ftGdb-guestSelect"`, default
     active) — a `.ftMs-resultList` of existing guests rendered
     as `<div class="ftMs-listItem"><span>Last, First </span></div>`
     (with trailing space), plus `TBA` on top.
   - **Add Guests** (`data-fttab=".ftGdb-guestAdd"`, hidden by
     default) — inputs `name="name_first"`, `name="name_mi"`,
     `name="name_last"` with explicit `<label for=...>` tags. The
     "Add New Guest" button lives in the dialog's
     `.ui-dialog-buttonpane`, not inside either tab panel.
3. **Dialog closes by becoming `display: none`** (it's not removed
   from the DOM) — that's the success signal.

### Why every prior named-guest fix missed

The PR #15 / PR #27-c2c1ecb attempts looked for `Add New Guest` by
text and walked up to a container with 2+ visible inputs. With the
intro dialog still overlaying the page AND the Add Guests tab not
yet active, the only visible text input inside the would-be modal
was the right-side guest-search box — so the matcher fell back to
unrelated inputs elsewhere on the page, fired a click on the
button-pane "Add New Guest" with empty form fields, and Foretees
silently rejected it. `firstInp === lastInp` collisions on labels
sharing a row was a parallel risk that the captured HTML showed is
not actually present (the form uses explicit `<label for=...>`),
but the modal-not-anchored bug was the real killer.

### Fix — three commits

- **`7538283` — Dismiss the intro dialog.** New
  `dismissAddingMemberOrGuestDialog()` finds the visible
  `.ui-dialog` titled "Adding a Member or Guest", ticks the
  suppress-checkbox, clicks the button-pane Close (or titlebar X
  as fallback). Called immediately after `focusSlot` in `addGuest`.
  Logs `intro-dialog-dismissed` in `attempts` when it fires.
- **`5ed96f5` — Rewrite `fillGuestRegistrationAndAdd`** with the
  real DOM in hand. `findGuestRegistrationModal` now anchors on
  the visible `.ui-dialog` whose `.ui-dialog-title` is exactly
  "Guest Registration", and every input/button query is scoped
  inside that container.
  - **Strategy 1 (existing guest)**: scan
    `.ftGdb-guestSelect .ftMs-resultList .ftMs-listItem` for
    `Last, First` (whitespace-normalized, exact-then-prefix match
    so entries like `Martin, Matt G` still hit). Click → wait for
    modal to become `display: none` → done. **TBA is excluded
    from this match** so a guest literally named "Tba" can't pick
    the placeholder.
  - **Strategy 2 (add-new-guest)**: click the
    `[data-fttab=".ftGdb-guestAdd"]` tab → fill exact selectors
    `input[name="name_first"]` / `name_mi` / `name_last` → click
    the `.ui-dialog-buttonpane` "Add New Guest" button → wait for
    modal to close.
  - `waitForModalToClose` is the universal success signal — it
    checks `display:none` / visibility on the modal handle.
- **`979315e` — TBA fallback** at the owner's explicit request.
  If Strategy 1 misses AND Strategy 2 fails (button rejected, form
  validation, etc.), the function re-switches to the Search Guests
  tab, clicks the **TBA** item, and lets the modal close on the
  placeholder. Slot fills, tee time secures. Records a soft
  `guest_tba_fallback` diagnostic (yellow, not red) listing the
  strategy errors that triggered the fallback so the owner knows
  which slot to fix on Foretees afterward.

Refactored to a single try/finally so the modal handle gets
disposed exactly once regardless of which strategy wins.

### Dashboard changes

- `guest_add_failed` cards now render the **modal HTML** and the
  **candidate-input list** when present (alongside the existing
  panel HTML).
- New `guest_tba_fallback` event renders as a yellow warning card
  with "Slot was filled with TBA instead. Fix the name on Foretees
  if needed." The diagnostics-summary badge stays yellow (warning)
  instead of red (error) when only TBA fallbacks happened.

### Owner workflow that this assumes

- Owner pre-adds repeat guests on Foretees so they appear in the
  Search Guests list. Strategy 1 then picks them with one click,
  no form-fill needed. This is the documented happy path.
- One-off guests fall through to Strategy 2; Strategy 3 (TBA) is
  the never-lose-the-tee-time safety net.

### Verified live (Test 7AM, 2026-05-14 16:59 ET)

Owner triggered a Test 7AM run at 16:55:43 ET on 2026-05-14
targeting 5/20 in the 15:00-16:00 window. Booking:

- 1 member (Jeffrey G Wilkins, transport WAL)
- 1 named guest (John Brecker — pre-added on Foretees)
- 1 partner (Alexander Wilkins)

The full attempts log for the guest add:

```
focus-slot:2 -> intro-dialog-dismissed -> guests-tab:data-fttab
-> guest-category:Guest -> registration-fill:existing:Brecker, John
-> modal-closed:yes
```

Every new code path from PR #27 fired and worked on the first live
booking:

- `intro-dialog-dismissed` confirms the "Adding a Member or Guest"
  jQuery UI dialog DID pop and was successfully dismissed (proving
  the root-cause diagnosis was real, not theoretical).
- `registration-fill:existing:Brecker, John` confirms Strategy 1
  (pick from Search Guests list) won — single click on the
  pre-added guest's `Last, First` entry.
- `modal-closed:yes` confirms `waitForModalToClose` correctly
  detected the dialog going `display: none`.
- `Yes, Continue` confirmation modal was handled.
- `verifyBookingOnSheet` returned `verified` with 3/3 players on
  the 3:15 PM slot. Result was `{success:true, partial:false}` —
  not `partial`. End-to-end success.

Total time from rapid-fire engaging to PRECISION BOOKING COMPLETE:
**9.4 seconds.**

### Open follow-ups for next session

- **Strategy 2 (add-new-guest form fill) is still unverified
  live.** Strategy 1 dominated the 5/20 booking because the
  guest was pre-added. If Strategy 2 ever fires and fails, the
  captured modal HTML will show why.
- **Strategy 3 (TBA fallback) is also unverified live.** It only
  triggers if both Strategy 1 and Strategy 2 fail.
- **First-time-in-session intro dialog suppression across logins
  is unverified.** `dismissAddingMemberOrGuestDialog` ticks the
  `Don't show this message again` checkbox, but the dismiss runs
  on every `focusSlot` regardless, so it's safe either way.
- **Older follow-ups still open:** `selectTeeTimeFast`
  guest-restricted slot filter; boundary-day Test 7AM messaging;
  empty diagnostics on truly unhandled failures.

---

## What was shipped 2026-05-22 (this session) — read-only Probe

Branch: `claude/epic-knuth-2uS1z`. **PR #30** (`c9334c2` → merged as
`cb18b1a`) and **PR #31** (`a22174b` → merged as `54f8068`) — both
merged into `main`, Heroku auto-deployed.

Context: the owner reported that Scioto/Foretees "may have changed"
the booking process, order, and menus, and asked for the best way to
keep the bot working through such changes. The bot drives Foretees
entirely through hard-coded DOM selectors reverse-engineered from
owner-captured HTML — so the durable answer is a tool that recaptures
the live DOM on demand, instead of the owner hand-capturing each
screen (the workflow PRs #15 and #27 relied on).

### PR #30 — read-only Probe mode

A new **Probe** dashboard tab. `booker.probe()` walks the whole
booking flow — login → Member Central → Foretees member-id → welcome
→ tee sheet → booking form → Partners/Members/Guests panel tabs →
Guest Registration modal — and captures each screen's full HTML, a
full-page screenshot, and a selector-health table.

- **Read-only / non-destructive.** It only opens pages and panels; it
  never clicks Submit, never adds a guest, never marks a slot. It does
  briefly open one open slot's booking form so the form/panel/modal
  can be seen — Foretees releases that hold on its own when the
  browser closes.
- Every step is wrapped so one broken screen never aborts the run.
  8-minute watchdog.
- `src/booker.js`: `probe()` / `_doProbe()`, `probeScreenshot()`,
  `checkSelectors()`, `probeOpenBookingForm()` (with
  class/time-text/href fallbacks so it still finds slots if the
  tee-sheet buttons are renamed).
- `server.js`: `POST /api/probe`, `GET /api/probe/:id`,
  `GET /api/probe-latest`, plus the Probe tab UI. Probe results live
  in memory + a `probe-latest.json` file — **never written to
  `bookings.json` or the gist**, so the queue and scheduler are
  untouched. `probe-latest.json` is gitignored.

### PR #31 — Probe targets a time window

The first probe run landed on an 8:00 AM slot, where Foretees
restricts guests and hides the Guests tab — so the guest flow
couldn't be seen. The probe now takes a time window (defaults
12:00-17:00) and samples up to 6 open slots in it, stopping on the
first one that actually exposes a Guests tab.

- `src/booker.js`: `probeListSlots()`, `probeClickSlot()`,
  `probeHasGuestsTab()`; `_doProbe()` loops slots in the window.
- `server.js`: `/api/probe` accepts `start`/`end`; the Probe tab
  gains Earliest/Latest time inputs.

### Probe findings (2026-05-22, play date 05/27/2026)

Ran the probe twice. **No breaking changes found** — every selector
and step the bot relies on is present and unchanged:

- Tee sheet: `a.teetime_button`, `.rwdTr`, `.sP.plCol`, "X Open",
  `maxPlayers4`.
- Booking form: 4 tabs in the same order — Partners
  (`.ftMs-partnerSelect`), Members (`.ftMs-memberSearch`), Guests
  (`.ftMs-guestTypes`), TBD (`.ftMs-guestTbd`).
- Partner list, member search, guest categories (Family / Guest /
  Social Guest), the Guest Registration modal (`.ui-dialog` titled
  "Guest Registration", `.ftGdb-tabs` Search/Add Guests,
  `name_first`/`name_mi`/`name_last`, "Add New Guest"), TBD "X",
  `a.submit_request_button` — all match the DOM cheatsheet below.
- The probe ran the bot's own helpers (`switchToFormTab`,
  `clickGuestCategory`, `findGuestRegistrationModal`) against the
  live site and they all succeeded.

One cosmetic difference: the Foretees form template now has a 5th
player row (`slot_player_row_4`). On Scioto it is always hidden +
locked (`ftS-noDisplay ftS-lockedPlayer`) — every slot is
`maxPlayers4` with `p5:"No"` — so the bot's 4-player assumption is
unaffected. This was already noted in the DOM cheatsheet. No code
change made.

**Conclusion:** the bot's automation path is intact as of
2026-05-22. Whatever the owner observed on Foretees is either
cosmetic or on a screen the bot doesn't drive (e.g. the top-nav
"Partners/Guests" menu now links to a `Common_guestdb` guest-database
page — the bot navigates by direct URL, so this doesn't affect it).

### How to re-probe in a future session

1. Dashboard → **Probe** tab → pick a date with an open tee sheet and
   an afternoon time window → **Run Probe** (~1-2 min).
2. Pull the results: `GET /api/probe-latest` returns the full JSON
   (captures + selector tables + screenshot filenames). The dashboard
   renders it on the Probe tab; a Claude session can `curl` the
   endpoint directly (the app URL is in PROJECT_RECORD.md §intro).
3. The selector-health table flags any selector that dropped to 0 —
   that is what to fix in `src/booker.js`.

---

## Scioto Foretees DOM cheatsheet (what we actually know)

Captured live from a real `guest_add_failed` diagnostic on 2026-05-11.
**Re-verified unchanged via the Probe on 2026-05-22.** Useful when
changing booking-form selectors.

### Right-side player panel tab structure

```
<ul class="ftMs-tabs">
  <li><div data-fttab=".ftMs-partnerSelect" class="active">Partners</div></li>
  <li><div data-fttab=".ftMs-memberSearch">Members</div></li>
  <li><div data-fttab=".ftMs-guestTypes">Guests</div></li>
  <li><div data-fttab=".ftMs-guestTbd">TBD</div></li>
</ul>
```

- Tabs are `<div>` elements with a `data-fttab=".ftMs-<paneName>"`
  attribute. **Prefer `data-fttab` selectors** over text matching —
  there are non-tab elements with the same labels elsewhere on the
  page (notably "Guests" in the navbar).
- Active tab gets `.active`; clicking another tab toggles the
  `.ftMs-block.active` pane.

### Panes (visible when their tab is active)

- `.ftMs-partnerSelect` — list of member's saved partners as
  `<div class="ftMs-listItem"><span>Last, First M (handicap)</span></div>`.
  Clicking one drops the partner into the current `Select Player #N` slot.
- `.ftMs-memberSearch` — text input that searches the club's member
  directory. Used as fallback by `tryMembersTab` when a partner isn't
  in the partner list.
- `.ftMs-guestTypes` — three category list items:
  - `<div class="ftMs-listItem"><span>Family</span></div>`
  - `<div class="ftMs-listItem"><span>Guest</span></div>`  ← what the bot clicks
  - `<div class="ftMs-listItem"><span>Social Guest</span></div>`
  Clicking one opens a separate guest-registration screen.
- `.ftMs-guestTbd` — single TBD placeholder option:
  - Prompt: `<div class="ftMs-resultMessage ftMs-guestTbdPrompt"><p><span>Select "X" to mark as "To Be Decided".</span></p></div>`
  - Clickable item: `<div class="ftMs-listItem"><span>X</span></div>`
  - **Restricted at certain times** (per owner). Don't use as the
    primary TBA path.

### Player slots (left side of form)

```
<div class="rwdTr slot_player_row ftS-groupChild ftS-unlockedPlayer playerTypeMember" id="slot_player_row_0">
  <div class="rwdTd ftS-playerCell">
    <div>
      <div class="playerType">Member</div>
      <div class="playerName">
        <input class="ftS-playerNameInput" type="text" readonly>
      </div>
    </div>
  </div>
  <div class="rwdTd ftS-trasportCell">
    <select class="transport_type">
      <option value="C-H">C-H</option>
      <option value="C-A">C-A</option>
      <option value="C-B" selected>C-B</option>
      ...
    </select>
  </div>
  ...
</div>
```

- Rows: `slot_player_row_0` through `slot_player_row_4` (5 rows total).
  Row 4 is hidden + locked (`ftS-noDisplay ftS-lockedPlayer`); only
  rows 0–3 are real bookable slots → max 4 players (self + 3 others).
- Empty slot row has class `emptySlot`; filled rows lose it and gain
  `playerTypeMember` / `playerTypePartner` / `playerTypeGuest` etc.
- Slot name `<input>` is **readonly** — Foretees JS programmatically
  sets `.value` when a partner/guest/TBD/TBA item is clicked. The
  booker reads `.value` via `readSlotNames()` to detect fill.
- Transport `<select class="transport_type">` per slot. Options:
  `''`, `C-H`, `C-A`, `C-B`, `FOR`, `WAL`, `TRL`. Member defaults to
  `C-B`. Disabled selects (row 4) are filtered out in `setSlotTransport`.

### Other panel UI

- `<div class="ftS-playerPrompt">Select Player #2</div>` — current
  pointer indicating which empty slot the next click will fill.
- `<a class="submit_request_button">` — final Submit Request button.
  Booker is careful **not** to match this when clicking "Add Guest" /
  "Add" / "OK".
- `.ftMs-pageOverlay` — modal-ish overlay that appears while the
  member-select panel is open. Doesn't block clicks during normal flow.

### jQuery UI dialogs (captured 2026-05-14 by the owner)

Both are `.ui-dialog` with a `.ui-dialog-title` span. Match by
title text — there can be multiple dialog nodes in the DOM
simultaneously (Foretees keeps hidden ones around).

**"Adding a Member or Guest"** — informational, pops on first
slot-click per session.

```
<div class="ui-dialog ...">
  <div class="ui-dialog-titlebar ...">
    <span class="ui-dialog-title">Adding a Member or Guest</span>
    <button class="ui-button ... ui-dialog-titlebar-close">...</button>
  </div>
  <div class="modal_list alertNotice_container ui-dialog-content ...">
    <div class="main_instructions"><p>You can add members or guests
      using the member selection tool on the right.</p></div>
    <div class="sub_instructions">
      <label>
        <input type="checkbox" name="suppressAlert" value="true">
        Don't show this message again.
      </label>
    </div>
  </div>
  <div class="ui-dialog-buttonpane ...">
    <div class="ui-dialog-buttonset">
      <button class="ui-button ...">
        <span class="ui-button-text">Close</span>
      </button>
    </div>
  </div>
</div>
```

`dismissAddingMemberOrGuestDialog()` ticks `suppressAlert`, clicks
the button-pane Close, falls back to the titlebar X.

**"Guest Registration"** — the real per-guest interaction.

```
<div class="ui-dialog ...">
  <div class="ui-dialog-titlebar ...">
    <span class="ui-dialog-title">Guest Registration</span>
    <button class="... ui-dialog-titlebar-close">...</button>
  </div>
  <div class="modal_list guestDbPrompt_container ui-dialog-content ...">
    <div class="forms_container">
      <ul class="ftGdb-tabs">
        <li><div data-fttab=".ftGdb-guestSelect" class="active">
          Search Guests</div></li>
        <li><div data-fttab=".ftGdb-guestAdd">Add Guests</div></li>
      </ul>
      <div class="right_container ftGdb-guestSelect ftGdb-block active">
        <div class="ftMs-memberSelect ftMs-noTabs">
          <div class="ftMs-block ftMs-guestDbSelect active">
            <div class="ftMs-search">
              <input type="text" class="ftMs-input" value="">
            </div>
            <div class="ftMs-results">
              <div class="ftMs-resultList">
                <div class="ftMs-listItem"><span>TBA</span></div>
                <div class="ftMs-listItem"><span>Martin, Matt </span></div>
                ... (existing guests, "Last, First " with trailing space)
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="left_container ftGdb-guestAdd  ftGdb-block">
        <form>
          <label for="name_first">First Name:</label>
          <input type="text" name="name_first" maxlength="20"> *
          <label for="name_mi">Middle Initial:</label>
          <input type="text" name="name_mi" maxlength="1">
          <label for="name_last">Last Name:</label>
          <input type="text" name="name_last" maxlength="20"> *
          <label for="guest_locker">Guest Locker:</label>
          <select name="guest_locker">...</select>
        </form>
      </div>
    </div>
  </div>
  <div class="ui-dialog-buttonpane ...">
    <div class="ui-dialog-buttonset">
      <button>Close</button>
      <button>Add New Guest</button>
    </div>
  </div>
</div>
```

Key DOM facts:
- `.ftGdb-tabs` is the tab strip; only the panel matching
  `data-fttab` becomes `.active` when its tab is clicked.
- Both panels exist in the DOM at all times but only the active
  one is visible. Don't try to read the Add Guests inputs without
  clicking `[data-fttab=".ftGdb-guestAdd"]` first.
- The TBA entry sits at the top of the Search Guests list and is
  always present even when the member has no saved guests.
- "Add New Guest" is in the dialog's `.ui-dialog-buttonpane`,
  outside both tab panels. Click it without switching tabs.
- After selecting (clicking an existing guest, clicking TBA, or
  clicking Add New Guest with a valid form), the dialog becomes
  `style="display: none;"` and its inner content gets emptied.
  Detect close by visibility, not by removal.

---

## Known caveats and open items

1. **TBA path is verified; named-guest path is wired but not yet
   live-verified.** As of PR #15 (2026-05-13, merged), `addGuest`
   handles both TBA and named guests via the same modal flow
   (Guests → Guest category → Guest Registration modal). TBA clicks
   the "TBA" list item; named guests fill First/Last Name (+ optional
   MI) and click "Add New Guest". The 5/20 booking on 2026-05-13
   submitted the form but the named guests never populated the slots
   — that's the bug PR #15 fixed. **Mitigation if the new flow also
   misses on the first live try:** PR #15 also added a `partial`
   booking status. If guests fail but Foretees accepts a member-only
   submit, the tee time is still secured and the booking is reported
   as `partial` (not `failed`) on the dashboard, with a clear "add
   guests manually on Foretees" prompt. The diagnostic system
   captures the modal HTML on failure; refine selectors then if
   anything still misses.

   To debug failures: the booking record's `diagnostics` array now
   contains structured events with `attempts` (e.g.
   `guests-tab:data-fttab → guest-category:Guest → registration-TBA:no`)
   and a `panelHtml` snippet. No need to flip `DEBUG_SCREENSHOTS=true`
   for ordinary diagnosis anymore. Force-screenshots also save to
   `/app/screenshots/07_guest_*_FAILED.png` on failure regardless.

2. **`bookings.json` is on the ephemeral dyno filesystem**, but a
   private GitHub Gist holds the durable copy. `src/store.js` syncs
   from the gist at boot and mirrors every save back to it in the
   background. No manual snapshot step. See "Durable persistence"
   near the top of this file for the full model. If `GIST_ID` /
   `GIST_TOKEN` aren't set (or the gist API is unreachable at boot),
   the store falls back to file-only — the scheduler still runs but
   a dyno restart will wipe the queue.

3. **Eco dyno restarts daily.** Startup recovery covers restarts during
   the 6:58-7:15 window, but a restart at exactly 7:00:01 could miss the
   trigger if browser launch is slow. PR #13's `isRunning` mutex on
   `checkAndRunBookings()` prevents cron + startup-recovery from
   double-firing in this window (which would otherwise submit two
   booking attempts).

4. **Test 7AM dyno-restart edge case**: the setTimeout is in-memory.
   If the dyno restarts between scheduling a test and firing, the test
   is lost (booking stays `pending`, scheduler skips it because
   `testRun: true`). User just re-schedules.

5. **Local git push to `main` from the sandbox is blocked (403).**
   Always go through the GitHub MCP API (`merge_pull_request`).

---

## Verifying the feature before tomorrow morning

The fastest end-to-end check (recommended first run after any change to
the guest path):

1. Heroku → Config Vars → set `DEBUG_SCREENSHOTS=true`.
2. Dashboard → **Test 7AM** tab.
3. Trigger Time: ~5 minutes from now (ET). Play Date: today+7. Time
   window: wide (09:00 - 18:00). Guests: `Bob Smith`. Transport: leave default.
4. **Schedule Test Run.**
5. Watch My Queue (TEST badge) and Heroku logs (`heroku logs --tail`).
6. Booking should complete in ~30-60s after trigger. If guest didn't end
   up on the booking, pull screenshots from the dyno (ephemeral — grab
   fast via `heroku ps:copy` or just describe what you saw).
7. Flip `DEBUG_SCREENSHOTS=false` after.

---

## Heroku CLI quick reference (for the user, not Claude)

```bash
H=~/heroku-cli/heroku/bin/heroku

$H logs --tail -a tee-time-booker      # live logs
$H config -a tee-time-booker           # list env vars
$H config:set KEY=VALUE -a tee-time-booker
$H ps -a tee-time-booker               # dyno status
$H restart -a tee-time-booker          # force restart
$H releases -a tee-time-booker         # deploy history
```

If `git push heroku main` ever resurfaces in instructions, ignore it —
the user moved to GitHub auto-deploy. Pushing to GitHub `main` is
sufficient and preferred.

---

## What was shipped 2026-05-22 (later session) — shareable gift package

Branch: `claude/pensive-carson-WyNdd`, merged to `main`. The owner wants
to gift working copies of the booker to two other Scioto members (his
dad and a friend), each on their own Heroku account with their own
Scioto credentials.

**Distribution = GitHub template repository.** Each recipient gets their
**own private, independent repo** via GitHub's "Use this template"
button. The owner marks this repo as a template, then per recipient:
temporarily invite as collaborator → they click "Use this template" →
owner removes their access. Template-created repos are independent (not
forks), so removal doesn't affect them. Full isolation, no branch
protection needed. (A protection ruleset was considered but abandoned —
GitHub gated it behind an org account for this private repo.)

**Code changes (safe for the owner's live app — its config vars are set):**
- `src/config.js` — dropped the hardcoded `'Jeffrey G Wilkins'` default
  for `memberName`.
- `server.js` + `index.js` — boot validation now also requires
  `MEMBER_NAME`, so a misconfigured copy fails fast.
- `server.js` — genericized two dashboard placeholders + one log line.

**New `README.md`** — full non-technical setup guide for recipients
(Part 1 is the template handshake). Printable PDF at
`documents/Tee-Time-Booker-Setup-Guide.pdf`.

**Owner's remaining manual steps:** mark the repo as a template
(Settings → General → Template repository), then run the Part 1
handshake with each recipient.

---

## What was shipped 2026-05-27 (this session) — club rules + Session Error 3 recovery

Branch: `claude/magical-davinci-AiSIo`. Two unrelated commits, both
landing in the same PR to `main`.

**Why this session happened.** The owner's 5/27 6:58 AM booking (play
date 06/03/2026, 13:00–14:00, partner Jeffrey M Wilkins, guests Chester
Scott + Jeff Loehnis, transport C-H) failed with two `guest_add_failed`
diagnostic events (`Slot names before: []`, `Slot names after: []`). The
captured `slot_container[data-ftjson]` showed
`page_start_title: "Session Error 3"` and
`page_start_notifications: ["Sorry, but there was a problem with your session.","Please exit ForeTees and try again"]`
— ForeTees had served the Member_slot page with an undismissable jQuery
UI dialog overlay, no fillable slot inputs, and the booker had no idea
and silently failed downstream. Separately, the owner wanted the
clubhouse's printed "Tee Time Times" play-window rules built into the
app so requested windows that violate them can be auto-shifted before
the booking even runs.

### Commit `3f70820` — club-rules engine

- New `rules.json` at the repo root encodes the printed Scioto table.
  Two parallel views: a `table` array (verbatim cell text for every
  category × day, drives display) and an `engine` object (minute-from-
  midnight intervals for `memberWindows` and per-guest-type
  `guestWindows`, drives validation). `tableVersion: "2026-05-27"` so
  it's obvious when a new table needs to land.
- New `src/rules.js`:
  - `evaluateBooking({date, start, end, guests})` intersects the Full
    Member's allowed intervals with the per-guest-type intervals on
    the day-of-week, then either uses the requested window as-is if
    it has ≥15 min of overlap, or auto-shifts to the nearest allowed
    interval (default 60-min length, capped to interval end). Returns
    `{ok, day, original, effective, adjusted, allowed, reason}`.
  - `normalizeGuests(input)` accepts both legacy comma-strings and the
    new `[{name, type}]` shape so bookings rehydrated from the gist
    keep working.
- `server.js`: new `applyClubRules({...})` helper runs validation +
  auto-shift for the three POST endpoints (`/api/bookings`,
  `/api/book-now`, `/api/test-precision`). Each booking record now
  carries `timeWindow` (effective), `requestedWindow` (original), and
  `ruleNotice` (the human-readable explanation when shifted). New
  endpoints `GET /api/rules` (table for display) and
  `POST /api/rules/preview` (live form feedback).
- Dashboard:
  - Each booking form's "Guests" input is now a **dynamic list of rows**
    (`+ Add guest` button) — name input + Family / Guest / Social Guest
    dropdown. Type round-trips to the booker.
  - A coloured **rule-preview** banner under each form polls
    `/api/rules/preview` on every change: green when allowed as-is,
    amber with the adjusted window, red when no window works for the
    guest mix.
  - New **Club Rules** tab renders the full `rules.json` table. The
    two engine-driven rows (Full Member, Guests of Full) are
    highlighted with an "active" badge; the rest are reference-only.
  - **My Queue** cards show an "Auto-shifted per club rules" line when
    `ruleNotice` is set.
- `src/booker.js` constructor now normalizes `booking.guests` to
  `{name, type}` and `addGuest(name, slot, guestType='Guest')` plumbs
  the type into `clickGuestCategory(guestType)` so what the engine
  validated is what actually gets booked on ForeTees.
- `src/scheduler.js` log lines now render `name (type)` for guests.

**Smoke-tested against the failing scenario:** Wed 1pm + 2 Guests → no
adjustment (the 5/27 booking was rules-compliant; the failure was
session-side, fixed by the next commit). Sat 8am + 1 Guest →
auto-shifts to 12:00–13:00. Sun 2pm + non-Family guest → shifts to
11:00–12:00 (Guest type only allowed 9–12 Sundays). Sun 2pm + Family
guest → no adjustment. Thu 11am solo → shifts to 12:00–13:00 (Full
Member's Thu blackout is 10:30am–12pm).

### Commit `b066cd2` — Session Error 3 recovery + two-speed rapid-fire

- `booker.detectSessionError()` reads both `.ui-dialog-title` text AND
  `slot_container[data-ftjson]`'s `page_start_title` /
  `page_start_notifications` so the error is caught even if ForeTees
  shifts the modal markup. Unit-tested against the exact failure HTML
  the owner sent: returns `{detected:true, title:"Session Error 3",
  notifications:[...]}` on the failure case, `{detected:false}` on a
  clean page.
- `_doRunPrecision` now wraps the slot click in a recovery loop:
  after `selectTeeTimeFast()` returns, it calls `detectSessionError()`,
  and on a hit re-navigates to the tee sheet URL (releases the held
  slot server-side), adds the failed time to a skip list, and re-picks
  — up to 3 slot attempts. The non-precision `run()` loop does the
  same: detect → record diag → skip to next slot. Records
  `session_error_3` diagnostics so the failure mode is visible in My
  Queue.
- **Two-speed rapid-fire** in `_doRunPrecision`: 1000 ms polling
  before `openHour:openMin` server clock, 100 ms after. Replaces the
  flat 100 ms cadence (which produced up to ~600 identical requests
  per minute on one ForeTees session — the most plausible trigger for
  the Session Error 3 in the first place). The wait-until window is
  unchanged (still starts at `openTime - 1 min` for real bookings, at
  `openTime` exactly for test-precision runs).

### Owner-visible behavior changes

- Booking forms require a guest **type** per guest now. Legacy queued
  bookings stored as comma-strings still book correctly (normalized in
  the booker constructor) but will all be treated as type "Guest".
- A scheduled booking whose window the rules engine had to shift will
  show two times in My Queue — the requested window in the amber
  "Auto-shifted" line and the actual booking window in the big time
  display.
- 6:58 AM runs will look quieter in the logs pre-7:00 (one hit/sec
  instead of ten/sec). The 7:00 race itself is unchanged.

### Open follow-ups

- **Live verification:** the next real 6:58 AM cron run is the only way
  to confirm the two-speed cadence + Session Error 3 recovery
  eliminates the failure mode the 5/27 booking hit. If a `session_error_3`
  diagnostic shows up again *after* the slowdown, the cause is somewhere
  other than rate (cookie expiry, ttdata staleness, etc.) and the
  recovery loop's 3 attempts buys us the data to investigate.
- **Holidays:** rules.json has a `Holidays` key but no holiday detection.
  Wire up a small holiday list + a booking flag if/when Scioto's holiday
  rules diverge meaningfully.
- **Other member categories:** the engine only enforces "Full" + "Guests
  of Full" right now (matching the owner's `mship: "Full"` per the
  diagnostic ftjson). Adding Spouse/Junior/etc. is just more keys under
  `engine.memberWindows` and a config var to pick the active category.
