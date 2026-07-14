// Force Playwright to find browsers in node_modules (Heroku compatibility)
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');
const path = require('path');
const fs = require('fs');

class TeeTimeBooker {
  constructor(booking) {
    // booking = {
    //   date: 'MM/DD/YYYY',
    //   timeWindow: { start: 'HH:MM', end: 'HH:MM' },
    //   partners: ['Name1', 'Name2', ...],   <-- members (Partners or Members tab)
    //   guests:   ['Guest1', ...],           <-- non-members (Guests tab)
    //   transport: 'C-B'                     <-- per-booking transport override
    // }
    this.booking = booking;
    if (!Array.isArray(this.booking.partners)) this.booking.partners = [];
    if (!Array.isArray(this.booking.guests)) this.booking.guests = [];
    // Guests may arrive as plain strings (legacy) or {name, type} (current).
    // Normalize to {name, type} so addGuest() can pick the right Foretees
    // guest category (Family / Guest / Social Guest) per row.
    this.booking.guests = this.booking.guests.map((g) =>
      typeof g === 'string' ? { name: g, type: 'Guest' } : { name: g.name, type: g.type || 'Guest' }
    );
    this.browser = null;
    this.page = null;
    // Diagnostic events collected during the run.  Surfaced in the result
    // object so the dashboard can show them even after the dyno restarts
    // (the screenshots dir is ephemeral on Heroku).
    this.diagnostics = [];
    this.screenshotDir = path.join(__dirname, '..', 'screenshots');
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  // Helper: get the transport code for this specific booking
  get transport() {
    return this.booking.transport || config.transportMode;
  }

  async screenshot(name) {
    if (config.debugScreenshots && this.page) {
      const filepath = path.join(this.screenshotDir, `${Date.now()}_${name}.png`);
      await this.page.screenshot({ path: filepath, fullPage: false });
      logger.info(`Screenshot saved: ${name}`);
    }
  }

  // Always saves a screenshot, ignoring the DEBUG_SCREENSHOTS flag.
  // Use for diagnostic moments (failed guest add, missing button, etc.)
  // so we can see what was on screen even on a normal production run.
  async forceScreenshot(name) {
    if (!this.page) return;
    try {
      const filepath = path.join(this.screenshotDir, `${Date.now()}_${name}.png`);
      await this.page.screenshot({ path: filepath, fullPage: false });
      logger.warn(`Diagnostic screenshot saved: ${path.basename(filepath)}`);
    } catch (e) {
      logger.warn(`Could not save diagnostic screenshot "${name}": ${e.message}`);
    }
  }

  // Full-page screenshot for the read-only probe.  Unlike
  // forceScreenshot (viewport only) this captures the whole page so a
  // changed layout is visible end to end.  Returns the saved file's
  // basename (for dashboard links), or null on failure.
  async probeScreenshot(name) {
    if (!this.page) return null;
    try {
      const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${Date.now()}_probe_${safe}.png`;
      await this.page.screenshot({ path: path.join(this.screenshotDir, filename), fullPage: true });
      return filename;
    } catch (e) {
      logger.warn(`[PROBE] screenshot "${name}" failed: ${e.message}`);
      return null;
    }
  }

  // Record a diagnostic event that will be returned in the run result.
  // Survives ephemeral filesystem wipes because it lives on the booking
  // record, not in /app/screenshots.  Keep payload small -- this lands
  // in bookings.json and gets sent to the dashboard.
  recordDiag(event, data) {
    try {
      this.diagnostics.push({
        t: new Date().toISOString(),
        event,
        ...data,
      });
    } catch (e) {
      logger.warn(`recordDiag failed: ${e.message}`);
    }
  }

  // Capture an HTML snippet of the booking form's right-side player
  // panel (where Partners / Members / Guests / TBD controls live).
  // We anchor the search to the transport <select> elements -- those
  // only exist on the Member_slot booking form -- and walk up to a
  // container that contains both the player rows AND the right
  // panel.  Falls back to body-without-navbar if no transport select
  // is reachable.
  async capturePanelHtml() {
    if (!this.page) return null;
    try {
      return await this.page.evaluate(() => {
        const MAX = 20000;
        const trim = (s) => s.length > MAX ? s.substring(0, MAX) + '\n<!-- truncated -->' : s;

        const transports = ['C-H', 'C-A', 'C-B', 'CAR', 'WAL', 'FOR', 'TRL'];
        const transportSelect = [...document.querySelectorAll('select')].find((sel) => {
          const opts = [...sel.options].map((o) => o.value);
          return opts.some((v) => transports.includes(v));
        });

        if (transportSelect) {
          // Walk up until we hit a container whose text includes BOTH
          // "Guests" and "Partners" -- that's the form area containing
          // both the player rows and the right-side selector panel.
          let container = transportSelect.closest('form, table, fieldset, section')
            || transportSelect.parentElement;
          while (container && container !== document.body) {
            const text = (container.textContent || '');
            if (/guests/i.test(text) && /partners/i.test(text)) break;
            container = container.parentElement;
          }
          if (container && container !== document.body) {
            return trim(container.outerHTML || '');
          }
        }

        // Fallback: body with nav chrome stripped out.
        if (!document.body) return null;
        const clone = document.body.cloneNode(true);
        const nav = clone.querySelectorAll(
          'nav, [role="navigation"], #pageHeader, #rwdNavBlock, #rwdNav, #rwdNav2, header, footer, script, style'
        );
        nav.forEach((n) => n.remove());
        return trim(clone.innerHTML || '');
      });
    } catch (e) {
      logger.warn(`capturePanelHtml failed: ${e.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Adds small, randomized delays to mimic human interaction
  // ---------------------------------------------------------------
  async humanDelay(minMs = 300, maxMs = 800) {
    const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
    await this.page.waitForTimeout(delay);
  }

  // ---------------------------------------------------------------
  // STEP 1: Launch browser
  // ---------------------------------------------------------------
  async launchBrowser() {
    logger.info('Launching browser...');
    this.browser = await chromium.launch({
      headless: config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: config.timezone,
    });

    // Remove the "webdriver" flag that marks automated browsers
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    this.page = await context.newPage();
    logger.info('Browser launched successfully.');
  }

  // ---------------------------------------------------------------
  // STEP 2: Log in to Scioto CC website
  // ---------------------------------------------------------------
  async login() {
    logger.info(`Navigating to ${config.clubUrl}`);
    await this.page.goto(config.clubUrl, { waitUntil: 'domcontentloaded' });
    await this.screenshot('01_login_page');

    // Fill username
    const usernameField = this.page.locator('input[type="text"]').first();
    await usernameField.click();
    await usernameField.fill('');
    await usernameField.type(config.username, { delay: 50 });
    await this.humanDelay();

    // Fill password
    const passwordField = this.page.locator('input[type="password"]').first();
    await passwordField.click();
    await passwordField.fill('');
    await passwordField.type(config.password, { delay: 50 });
    await this.humanDelay();

    // Click Login
    await this.page.locator('button[type="submit"], input[type="submit"]').first().click();
    logger.info('Login submitted. Waiting for Member Central...');
    await this.page.waitForURL('**/Member-Central**', { timeout: 60000, waitUntil: 'domcontentloaded' });
    await this.screenshot('02_member_central');
    logger.info('Logged in to Scioto CC Member Central.');
  }

  // ---------------------------------------------------------------
  // STEP 3: Navigate to Foretees and select member
  // ---------------------------------------------------------------
  async navigateToForetees() {
    // Click "Book a Tee Time" tile on Member Central
    logger.info('Clicking "Book a Tee Time"...');

    // The page may have multiple elements matching this text (e.g. a hidden
    // mobile-nav link AND the visible tile).  .first() grabs the first in
    // DOM order, which can be the hidden one.  Instead, iterate and click
    // the first *visible* match.
    const allMatches = this.page.locator('text=BOOK A TEE TIME');
    const count = await allMatches.count();
    let clicked = false;

    for (let i = 0; i < count; i++) {
        const el = allMatches.nth(i);
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.scrollIntoViewIfNeeded();
            await this.humanDelay(200, 400);
            await el.click();
            clicked = true;
            break;
        }
    }

    if (!clicked) {
        // Fallback: try clicking with force on the first match
        logger.warn('No visible "BOOK A TEE TIME" found. Attempting force click...');
        await allMatches.first().click({ force: true, timeout: 10000 });
    }

    // Wait for Foretees member identification page
    await this.page.waitForURL('**foretees.com**', { timeout: 60000, waitUntil: 'domcontentloaded' });
    await this.screenshot('03_member_identification');
    logger.info('Foretees loaded. Selecting member...');

    // Select the correct member name
    const memberButton = this.page.locator(`text="${config.memberName}"`).first();
    await memberButton.click();

    // Wait for the Foretees welcome/announce page
    await this.page.waitForURL('**/Member_announce**', { timeout: 60000, waitUntil: 'domcontentloaded' });
    await this.screenshot('04_foretees_welcome');
    logger.info('Member selected. On Foretees welcome page.');
  }

  // ---------------------------------------------------------------
  // STEP 4: Navigate to the tee sheet for the target date
  // ---------------------------------------------------------------
  async navigateToTeeSheet() {
    const targetDate = this.booking.date; // format: MM/DD/YYYY
    logger.info(`Navigating to tee sheet for ${targetDate}`);

    // Go directly to the tee sheet URL (faster than clicking through calendar)
    const sheetUrl = `${config.foretees.baseUrl}${config.foretees.sheetPage}?calDate=${targetDate}&course=&displayOpt=0&select_jump`;
    await this.page.goto(sheetUrl, { waitUntil: 'domcontentloaded' });
    await this.screenshot('05_tee_sheet');

    // Verify we are on the tee sheet
    const title = await this.page.title();
    if (!title.includes('Tee Sheet')) {
      throw new Error(`Expected Tee Sheet page, got: ${title}`);
    }
    logger.info(`Tee sheet loaded for ${targetDate}.`);
  }

  // ---------------------------------------------------------------
  // STEP 5: Find and click the best available tee time
  //
  // PRIORITY ORDER:
  //   1. Fully open slots (4 open) closest to desired start time
  //   2. If no fully open slots, take any slot with enough open spots
  //   3. Last resort: any available slot in the window
  // ---------------------------------------------------------------
  async selectTeeTime(skipTimes = []) {
    const { start, end } = this.booking.timeWindow;
    const neededSpots = 1 + this.booking.partners.length + this.booking.guests.length; // self + partners + guests
    logger.info(`Looking for available tee time between ${start} and ${end} (need ${neededSpots} spots: 1 self + ${this.booking.partners.length} partners + ${this.booking.guests.length} guests)...`);

    const availableSlots = await this.page.evaluate(({ startTime, endTime }) => {
      function timeToMinutes(timeStr) {
        const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (!match) return -1;
        let hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const ampm = match[3].toUpperCase();
        if (ampm === 'PM' && hours !== 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
        return hours * 60 + minutes;
      }

      function parseInputTime(t) {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      }

      const startMin = parseInputTime(startTime);
      const endMin = parseInputTime(endTime);

      const buttons = document.querySelectorAll('a.teetime_button');
      const slots = [];
      buttons.forEach((btn) => {
        const text = btn.textContent.trim();
        const mins = timeToMinutes(text);
        if (mins >= startMin && mins <= endMin) {
          // The tee sheet shows "X Open" in the .sP.plCol cell.
          // "4 Open" = fully open.  "2 Open" + player names = partially booked.
          const row = btn.closest('.rwdTr');
          const plCell = row ? row.querySelector('.sP.plCol') : null;
          const rawText = plCell ? plCell.textContent.trim() : '';
          const openMatch = rawText.match(/(\d+)\s*Open/);
          const openCount = openMatch ? parseInt(openMatch[1]) : 0;
          const fullyOpen = openCount === 4;

          slots.push({
            time: text,
            minutes: mins,
            open: openCount,
            filled: 4 - openCount,
            fullyOpen: fullyOpen,
          });
        }
      });

      return slots;
    }, { startTime: start, endTime: end });

    if (availableSlots.length === 0) {
      throw new Error(`No available tee times found between ${start} and ${end}.`);
    }

    logger.info(`Found ${availableSlots.length} available slots in window:`);
    availableSlots.forEach((s) => {
      logger.info(`  ${s.time} - ${s.open} open, ${s.filled} filled ${s.fullyOpen ? '(FULLY OPEN)' : ''}`);
    });

    // PRIORITY 1: Fully open slots, sorted by closeness to desired start
    const idealMinutes = (() => {
      const [h, m] = start.split(':').map(Number);
      return h * 60 + m;
    })();

    // Find viable slots: prefer slots where open count best matches our neededSpots
    // This avoids minimum-player-limit errors on fully open foursomes
    const viable = availableSlots
      .filter(s => s.open >= neededSpots)
      .sort((a, b) => {
        // Prefer best-fit (open count closest to neededSpots)
        const aFit = Math.abs(a.open - neededSpots);
        const bFit = Math.abs(b.open - neededSpots);
        if (aFit !== bFit) return aFit - bFit;
        // Then by closeness to desired start time
        return Math.abs(a.minutes - idealMinutes) - Math.abs(b.minutes - idealMinutes);
      });

    // Remove already-tried slots
    const untried = viable.filter(s => !skipTimes.includes(s.time));
    if (untried.length > 0) {
      viable.length = 0;
      untried.forEach(s => viable.push(s));
    }

    if (viable.length === 0) {
      throw new Error(`No tee times with ${neededSpots}+ open spots between ${start} and ${end}.`);
    }

    const chosen = viable[0];
    logger.info(`SELECTED (${chosen.open} open, need ${neededSpots}): ${chosen.time}`);
    this.chosenTime = chosen.time;

    // Click the chosen time slot button
    const buttons = await this.page.$$('a.teetime_button');
    for (const btn of buttons) {
      const text = await btn.textContent();
      if (text.trim() === chosen.time) {
        await btn.click();
        break;
      }
    }

    // Wait for the booking form to load
    await this.page.waitForURL('**/Member_slot**', { timeout: 60000, waitUntil: 'domcontentloaded' });
    await this.screenshot('06_booking_form');
    logger.info('Booking form loaded.');
    return chosen.time;
  }

  // ---------------------------------------------------------------
  // FAST variant of selectTeeTime for the 7am precision race.
  //
  // Finds the best slot and clicks it in a SINGLE in-browser call.
  // selectTeeTime does this as: evaluate(getSlots) -> Node sort ->
  // $$(buttons) -> for-loop click.  That's ~3-4 Node<->browser round
  // trips at the most time-sensitive moment of the day.  This version
  // collapses to ONE roundtrip, saving roughly 200-500ms.
  // ---------------------------------------------------------------
  async selectTeeTimeFast(skipTimes = []) {
    const { start, end } = this.booking.timeWindow;
    const neededSpots = 1 + this.booking.partners.length + this.booking.guests.length;
    logger.info(`[FAST] Selecting slot in ${start}-${end} (need ${neededSpots}); skip=${skipTimes.length}`);

    const result = await this.page.evaluate(({ startTime, endTime, needed, skipList }) => {
      function timeToMinutes(timeStr) {
        const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (!match) return -1;
        let hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const ampm = match[3].toUpperCase();
        if (ampm === 'PM' && hours !== 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
        return hours * 60 + minutes;
      }
      const [sH, sM] = startTime.split(':').map(Number);
      const [eH, eM] = endTime.split(':').map(Number);
      const startMin = sH * 60 + sM;
      const endMin = eH * 60 + eM;
      const idealMin = startMin;

      const buttons = [...document.querySelectorAll('a.teetime_button')];
      const slots = [];
      for (const btn of buttons) {
        const text = btn.textContent.trim();
        const mins = timeToMinutes(text);
        if (mins < startMin || mins > endMin) continue;
        if (skipList.includes(text)) continue;
        const row = btn.closest('.rwdTr');
        const plCell = row ? row.querySelector('.sP.plCol') : null;
        const rawText = plCell ? plCell.textContent.trim() : '';
        const openMatch = rawText.match(/(\d+)\s*Open/);
        const open = openMatch ? parseInt(openMatch[1]) : 0;
        if (open >= needed) {
          slots.push({ btn, text, mins, open });
        }
      }
      if (slots.length === 0) {
        return { error: 'no_viable_slots', scanned: buttons.length };
      }
      slots.sort((a, b) => {
        const aFit = Math.abs(a.open - needed);
        const bFit = Math.abs(b.open - needed);
        if (aFit !== bFit) return aFit - bFit;
        return Math.abs(a.mins - idealMin) - Math.abs(b.mins - idealMin);
      });
      const chosen = slots[0];
      chosen.btn.click();
      return { success: true, time: chosen.text, open: chosen.open, candidates: slots.length };
    }, { startTime: start, endTime: end, needed: neededSpots, skipList: skipTimes });

    if (result.error) {
      throw new Error(`No viable tee times in ${start}-${end} with ${neededSpots}+ open spots (${result.scanned} buttons scanned).`);
    }

    logger.info(`[FAST] Clicked ${result.time} (${result.open} open, ${result.candidates} candidates).`);
    this.chosenTime = result.time;

    await this.page.waitForURL('**/Member_slot**', { timeout: 60000, waitUntil: 'domcontentloaded' });
    logger.info('[FAST] Booking form loaded.');

    // Screenshot is non-blocking: don't make the critical path wait on disk I/O
    if (config.debugScreenshots) {
      this.screenshot('06_booking_form').catch(() => {});
    }
    return result.time;
  }

  // ---------------------------------------------------------------
  // STEP 6: Fill in the booking form (partners + transport)
  //
  // The Foretees booking form (Member_slot) layout:
  //   - Player rows 1-4, each with: name input, transport <select>, 9-holes checkbox
  //   - Right panel: "Select Player #N" with tabs: Partners, Members, Guests, TBD
  //   - Partners tab shows names like "Hall, Dr.Jeffrey A (12.0)"
  //   - Clicking a partner name fills the current target player slot
  //   - Transport dropdowns are standard <select> elements
  //
  // From live testing we learned:
  //   - Player 1 (self) is pre-filled with "Jeffrey G Wilkins"
  //   - Transport defaults to C-B; we set it per-booking
  //   - Partner names in the list use "Last, First (handicap)" format
  //   - Clicking a partner auto-advances the "Select Player #N" pointer
  // ---------------------------------------------------------------
  async fillBookingForm() {
    logger.info(`Filling booking form (transport: ${this.transport})...`);
    await this.humanDelay(500, 1000);

    // Set transport for Player 1 (self) -- it is the first <select> on the form
    await this.setSlotTransport(0, this.transport);
    logger.info(`Set transport for self (Player 1) to ${this.transport}`);

    let nextSlot = 2; // Player 1 is self; guests + partners fill 2,3,4

    // Foretees expects guests to sit immediately after the member they
    // belong to.  All our guests belong to the booking member (self,
    // slot 1), so guests must come BEFORE partners -- otherwise
    // Foretees pops the "Player/Guest Association" confirmation modal.
    // (We still handle that modal in submitBooking as a backstop.)

    // -- Add guests first (Guests tab) so they sit right after self --
    for (let i = 0; i < this.booking.guests.length && nextSlot <= 4; i++, nextSlot++) {
      const guest = this.booking.guests[i];
      logger.info(`Adding guest: ${guest.name} (${guest.type}) to slot ${nextSlot}...`);
      await this.addGuest(guest.name, nextSlot, guest.type);
    }

    // -- Then add member partners (Partners tab, fall back to Members tab) --
    for (let i = 0; i < this.booking.partners.length && nextSlot <= 4; i++, nextSlot++) {
      const partnerName = this.booking.partners[i];
      logger.info(`Adding partner: ${partnerName} to slot ${nextSlot}...`);
      await this.addPartner(partnerName, nextSlot);
    }

    await this.screenshot('07_form_filled');
    logger.info('Booking form filled.');
  }

  // Find all transport <select>s on the form (one per player slot) in DOM order
  async getTransportSelects() {
    const selects = await this.page.$$('select');
    const transSelects = [];
    for (const sel of selects) {
      const options = await sel.$$eval('option', (opts) => opts.map((o) => o.value));
      if (options.some((v) => ['C-H', 'C-A', 'C-B', 'CAR', 'WAL', 'FOR', 'TRL'].includes(v))) {
        transSelects.push(sel);
      }
    }
    return transSelects;
  }

  // slotIndex is 0-based: 0 = self, 1 = slot 2, 2 = slot 3, 3 = slot 4
  async setSlotTransport(slotIndex, transport) {
    const selects = await this.getTransportSelects();
    if (selects[slotIndex]) {
      await selects[slotIndex].selectOption(transport);
      return true;
    }
    return false;
  }

  async addPartner(partnerName, targetSlot) {
    const partnersTab = this.page.locator('a:has-text("Partners"), div:has-text("Partners")').first();
    const ptExists = await partnersTab.count();
    if (ptExists > 0) {
      await partnersTab.click({ force: true });
      // Poll for the partner list to actually populate (AJAX can be slow
      // on the first booking of a session) instead of a fixed short delay.
      const deadline = Date.now() + 3000;
      let hasItems = false;
      while (Date.now() < deadline) {
        hasItems = await this.page.evaluate(() => {
          const c = document.querySelector('.ftMs-partnerSelect .ftMs-resultList')
                 || document.querySelector('.ftMs-partnerSelect');
          return !!(c && c.querySelectorAll('.ftMs-listItem').length > 0);
        });
        if (hasItems) break;
        await this.page.waitForTimeout(150);
      }
    }

    // Partners are displayed as "Last, First (handicap)" e.g. "Hall, Dr.Jeffrey A (12.0)".
    // Search ONLY inside the Partners panel -- a whole-document walk would
    // match unrelated elements (e.g. the "Welcome, <member>" page banner).
    // Require BOTH the last name and the first-name token(s) to appear; do
    // NOT require the concatenated "First Last" string -- that order never
    // occurs in the "Last, First (handicap)" list display, so requiring it
    // is the bug that made every multi-word name miss.
    const partnerClicked = await this.page.evaluate((name) => {
      const parts = name.split(' ');
      if (parts.length < 2) return null;
      const last = parts[parts.length - 1].toLowerCase();
      const first = parts.slice(0, -1).join(' ').toLowerCase();

      const container = document.querySelector('.ftMs-partnerSelect .ftMs-resultList')
                     || document.querySelector('.ftMs-partnerSelect');
      if (!container) return null;

      const items = container.querySelectorAll('.ftMs-listItem');
      for (const el of items) {
        const text = el.textContent.trim();
        if (text.length > 60) continue;
        const t = text.toLowerCase();
        if (t.includes(last) && t.includes(first)) {
          el.click();
          return text;
        }
      }
      return null;
    }, partnerName);

    if (partnerClicked) {
      logger.info(`  Clicked partner: ${partnerClicked}`);
      await this.humanDelay(500, 1000);
      await this.setSlotTransport(targetSlot - 1, this.transport);
      logger.info(`  Set transport for ${partnerName} to ${this.transport}`);
    } else {
      logger.warn(`  Could not find partner "${partnerName}" in Partners tab. Trying Members tab...`);
      await this.tryMembersTab(partnerName, targetSlot - 1);
    }
  }

  // ---------------------------------------------------------------
  // Add a guest -- non-member name typed into the Guests tab form.
  //
  // Scioto's Foretees panel uses 4 tabs in <ul class="ftMs-tabs">:
  //   Partners | Members | Guests | TBD
  //
  // Each tab is <div data-fttab=".ftMs-<paneName>">TabLabel</div>.
  // The "TBD" tab contains a single <div class="ftMs-listItem">
  // <span>X</span></div> -- clicking it marks the current Select
  // Player #N slot as "To Be Decided" (which is Scioto's term for
  // what other clubs call TBA).
  //
  // For real (non-TBA) guests, the Guests tab shows guest
  // CATEGORIES (Family / Guest / Social Guest), not a name input.
  // The exact next-step UX for entering a guest name is not yet
  // captured in our diagnostics, so this code best-efforts it and
  // records detailed diagnostics on failure.
  // ---------------------------------------------------------------
  async addGuest(guestName, targetSlot, guestType = 'Guest') {
    const isTba = /^tb[ad]$/i.test(guestName.trim());
    const slotIdx = targetSlot - 1;

    const before = await this.readSlotNames();
    logger.info(`  Slot name state before guest #${targetSlot} ("${guestName}"): ${JSON.stringify(before)}`);

    // Reset per-guest modal diagnostic state so it never leaks
    // between guests if an earlier one was the one that captured it.
    this.lastModalHtml = null;
    this.lastModalCandidates = null;

    const attempts = [];
    let added = false;

    // Scioto flow per owner (both TBA and named guests share the modal):
    //   1) Click the target player slot (focuses "Select Player #N")
    //   2) Click "Guests" tab (shows categories: Family / Guest / Social Guest)
    //   3) Click "Guest" category --> opens the Guest Registration modal
    //   4a) Named guest: type First Name + Last Name, click "Add New Guest"
    //   4b) TBA:         click "TBA" at the top of the right-side list
    const focused = await this.focusSlot(slotIdx);
    attempts.push(`focus-slot:${focused ? targetSlot : 'no'}`);
    await this.humanDelay(150, 300);

    // Foretees pops an "Adding a Member or Guest" jQuery UI dialog on
    // first slot-click in a session.  Dismiss it (with the suppress
    // checkbox ticked) before proceeding -- otherwise it modal-overlays
    // the page and blocks the real Guest Registration modal.
    const dismissed = await this.dismissAddingMemberOrGuestDialog();
    if (dismissed) {
      attempts.push('intro-dialog-dismissed');
      await this.humanDelay(200, 400);
    }

    const guestsTab = await this.switchToFormTab('Guests', '.ftMs-guestTypes');
    attempts.push(`guests-tab:${guestsTab || 'no'}`);

    if (guestsTab) {
      await this.humanDelay(250, 500);
      const cat = await this.clickGuestCategory(guestType);
      attempts.push(`guest-category:${guestType}:${cat || 'no'}`);

      if (cat) {
        // Wait for the Guest Registration modal to render
        await this.humanDelay(600, 1100);

        if (isTba) {
          const tbaClick = await this.clickTbaInRegistration();
          attempts.push(`registration-TBA:${tbaClick || 'no'}`);
          if (tbaClick) {
            await this.humanDelay(500, 900);
            added = await this.didSlotFill(before, slotIdx);
          }
        } else {
          const { first, middle, last } = this.parseGuestName(guestName);
          const result = await this.fillGuestRegistrationAndAdd(first, middle, last);
          if (result && result.error) {
            const errSuffix = result.reason ? ':' + result.reason :
                              result.strategyErrors ? ':[' + result.strategyErrors.join('|') + ']' : '';
            attempts.push(`registration-fill:err=${result.error}${errSuffix}`);
            if (result.modalHtml) {
              this.lastModalHtml = result.modalHtml;
              this.lastModalCandidates = result.candidates || null;
            }
          } else if (result && result.clicked) {
            attempts.push(`registration-fill:${result.clicked}`);
            if (result.fallback) {
              // TBA placeholder used because both the existing-guest and
              // add-new-guest paths failed.  Slot still gets filled so
              // the tee time is secured, but surface a soft diagnostic
              // so the dashboard tells the owner to fix the name on
              // Foretees afterward.
              attempts.push(`tba-fallback:[${(result.strategyErrors || []).join('|')}]`);
              logger.warn(`  Slot ${targetSlot} filled with TBA instead of "${guestName}".`);
              this.recordDiag('guest_tba_fallback', {
                guestName,
                targetSlot,
                strategyErrors: result.strategyErrors || [],
              });
            }
            if (result.modalClosed) attempts.push('modal-closed:yes');
            await this.humanDelay(400, 800);
            added = await this.didSlotFill(before, slotIdx);
          } else {
            attempts.push('registration-fill:no');
          }
        }
      }
    }

    // TBA-only fallbacks (named guests have no second path -- there is no
    // "type a name without using the modal" UI on Scioto Foretees).
    if (!added && isTba) {
      // Fallback A: TBD tab + X (some Foretees installs use this)
      const tbdSwitch = await this.switchToFormTab('TBD', '.ftMs-guestTbd');
      if (tbdSwitch) {
        await this.humanDelay(200, 400);
        const xClicked = await this.clickTbdXItem();
        attempts.push(`tbd-X:${xClicked || 'no'}`);
        if (xClicked) {
          await this.humanDelay(500, 900);
          added = await this.didSlotFill(before, slotIdx);
        }
      }

      // Fallback B: any visible exact-text TBA element
      if (!added) {
        const tbaLabel = await this.tryClickTbaOption();
        attempts.push(`tba-button:${tbaLabel || 'none'}`);
        if (tbaLabel) {
          await this.humanDelay(400, 800);
          added = await this.didSlotFill(before, slotIdx);
        }
      }
    }

    const after = await this.readSlotNames();
    logger.info(`  Slot name state after guest #${targetSlot}: ${JSON.stringify(after)} (attempts: ${attempts.join(' -> ')})`);

    if (!added) {
      logger.error(`  GUEST ADD FAILED: "${guestName}" did not populate slot ${targetSlot}. Tried: ${attempts.join(', ')}`);
      await this.forceScreenshot(`07_guest_${targetSlot}_FAILED`);
      const panelHtml = await this.capturePanelHtml();
      const modalHtml = this.lastModalHtml || null;
      const candidates = this.lastModalCandidates || null;
      this.lastModalHtml = null;
      this.lastModalCandidates = null;
      this.recordDiag('guest_add_failed', {
        guestName,
        targetSlot,
        attempts,
        slotsBefore: before,
        slotsAfter: after,
        panelHtml,
        modalHtml,
        candidates,
      });
      return false;
    }

    logger.info(`  Guest "${guestName}" added to slot ${targetSlot} (slot now reads "${after[slotIdx]}").`);
    await this.screenshot(`07_guest_${targetSlot}_added`);

    const ok = await this.setSlotTransport(slotIdx, this.transport);
    if (ok) {
      logger.info(`  Set transport for guest ${guestName} to ${this.transport}`);
    } else {
      logger.warn(`  No transport <select> at slot index ${slotIdx} for guest ${guestName}`);
    }
    return true;
  }

  // ---------------------------------------------------------------
  // Switch to a tab in the right-side player panel.  Scioto's
  // panel uses <div data-fttab=".ftMs-<paneName>">Label</div>
  // inside <ul class="ftMs-tabs">.  Pass the paneSelector when
  // known (most reliable); otherwise we fall back to text match.
  // Returns the strategy that worked, or null.
  // ---------------------------------------------------------------
  async switchToFormTab(label, paneSelector) {
    const result = await this.page.evaluate(({ tabLabel, pane }) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };

      // A. data-fttab attribute match (Scioto pattern)
      if (pane) {
        const tabs = [...document.querySelectorAll(`[data-fttab="${pane}"]`)].filter(visible);
        if (tabs.length > 0) { tabs[0].click(); return 'data-fttab'; }
      }

      // B. exact text match on tab divs within .ftMs-tabs
      const tabDivs = [...document.querySelectorAll('.ftMs-tabs li > div, .ftMs-tabs li > a, [role="tab"]')]
        .filter(visible);
      const exact = tabDivs.find((el) => new RegExp(`^${tabLabel}$`, 'i').test((el.textContent || '').trim()));
      if (exact) { exact.click(); return 'ftMs-tabs-text'; }

      // C. any clickable with exact tab label
      const any = [...document.querySelectorAll('a, button, div, span, li')]
        .filter(visible)
        .find((el) => new RegExp(`^${tabLabel}$`, 'i').test((el.textContent || '').trim()));
      if (any) { any.click(); return 'any-text'; }

      return null;
    }, { tabLabel: label, pane: paneSelector });

    if (result) {
      logger.info(`  Switched to ${label} tab (${result}).`);
    } else {
      logger.warn(`  Could not locate ${label} tab.`);
    }
    return result;
  }

  // Click the X placeholder inside the TBD pane on Scioto's
  // booking form.  That's the actual control that marks the
  // current Select Player slot as "To Be Decided".
  async clickTbdXItem() {
    return await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const panel = document.querySelector('.ftMs-guestTbd');
      if (!panel) return null;
      const items = [...panel.querySelectorAll('.ftMs-listItem')].filter(visible);
      // Prefer an item whose own text is exactly "X" (not the "Select X to mark..." prompt)
      const xItem = items.find((el) => /^X$/i.test((el.textContent || '').trim()));
      if (xItem) {
        xItem.click();
        return 'X';
      }
      // Fallback: the inner <span>X</span>
      const xSpan = [...panel.querySelectorAll('span')]
        .filter(visible)
        .find((el) => /^X$/i.test((el.textContent || '').trim()));
      if (xSpan) {
        xSpan.click();
        return 'X-span';
      }
      return null;
    });
  }

  // Click a guest CATEGORY (Family / Guest / Social Guest) inside the
  // Guests tab's category list.  Returns the label clicked, or null.
  async clickGuestCategory(preferred) {
    return await this.page.evaluate(({ pref }) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const panel = document.querySelector('.ftMs-guestTypes');
      if (!panel) return null;
      const items = [...panel.querySelectorAll('.ftMs-listItem')].filter(visible);
      if (items.length === 0) return null;

      const textOf = (el) => (el.textContent || '').trim();
      const exact = items.find((el) => new RegExp(`^${pref}$`, 'i').test(textOf(el)));
      if (exact) { exact.click(); return textOf(exact); }
      // Otherwise pick the first visible category
      items[0].click();
      return textOf(items[0]);
    }, { pref: preferred || 'Guest' });
  }

  // After Guests -> Guest category, Scioto presents a guest
  // registration screen with a right-side list whose top entry is
  // "TBA".  Click that.  Falls back to any visible exact-text "TBA".
  async clickTbaInRegistration() {
    return await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const textOf = (el) => (el.textContent || el.value || '').trim();

      // Prefer leaf clickable elements (a, button, listItem) over containers.
      const leafSet = new Set(['a', 'button', 'input']);
      const candidates = [...document.querySelectorAll(
        '.ftMs-listItem, a, button, input[type="button"], input[type="submit"], li, div, span, td'
      )].filter(visible);

      candidates.sort((x, y) => {
        const xl = leafSet.has(x.tagName.toLowerCase()) || x.classList.contains('ftMs-listItem') ? 0 : 1;
        const yl = leafSet.has(y.tagName.toLowerCase()) || y.classList.contains('ftMs-listItem') ? 0 : 1;
        return xl - yl;
      });

      const exact = candidates.find((el) => /^TBA$/i.test(textOf(el)));
      if (exact) { exact.click(); return textOf(exact); }

      const loose = candidates.find((el) => /^TBA(\b|[\s\-:])/i.test(textOf(el)));
      if (loose) { loose.click(); return textOf(loose); }

      return null;
    });
  }

  // ---------------------------------------------------------------
  // Click the "Guests" tab on the Foretees right-side player panel.
  // Tries multiple selector strategies, preferring elements that
  // look like actual tab headers over arbitrary "Guests" text on
  // the page.
  // ---------------------------------------------------------------
  async switchToGuestsTab() {
    const result = await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };

      // 1. Elements whose className mentions "tab" with exact text "Guests"
      const tabby = [...document.querySelectorAll('a, div, li, span, button')]
        .filter(visible)
        .filter((el) => /tab/i.test(el.className || ''));
      const tabbyMatch = tabby.find((el) => /^guests$/i.test(el.textContent.trim()));
      if (tabbyMatch) { tabbyMatch.click(); return 'tab-class'; }

      // 2. Anchor with exact text "Guests"
      const anchors = [...document.querySelectorAll('a')].filter(visible);
      const aMatch = anchors.find((el) => /^guests$/i.test(el.textContent.trim()));
      if (aMatch) { aMatch.click(); return 'a-exact'; }

      // 3. Any clickable with exact text "Guests"
      const any = [...document.querySelectorAll('a, button, div, span, li, td')]
        .filter(visible)
        .find((el) => /^guests$/i.test(el.textContent.trim()));
      if (any) { any.click(); return 'any-exact'; }

      return null;
    });

    if (result) {
      logger.info(`  Switched to Guests tab (${result}).`);
    } else {
      logger.warn(`  Could not locate Guests tab on the booking form.`);
    }
    await this.humanDelay(300, 600);
  }

  // ---------------------------------------------------------------
  // Try to click a dedicated TBA option on the Guests tab.  Returns
  // the clicked element's text if found, null otherwise.  Prefers
  // leaf clickable elements (a/button/input) over container divs to
  // avoid clicking a wrapper whose click handler doesn't fire.
  // ---------------------------------------------------------------
  async tryClickTbaOption() {
    return await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };

      const all = [...document.querySelectorAll(
        'a, button, input[type="button"], input[type="submit"], div, span, td, li'
      )].filter(visible);

      // Prefer "leaf" tags (anchor/button/input) over container tags.
      const leafTags = new Set(['a', 'button', 'input']);
      all.sort((x, y) => {
        const xLeaf = leafTags.has(x.tagName.toLowerCase()) ? 0 : 1;
        const yLeaf = leafTags.has(y.tagName.toLowerCase()) ? 0 : 1;
        return xLeaf - yLeaf;
      });

      const textOf = (el) => (el.textContent || el.value || '').trim();

      // Exact "TBA" first
      const exact = all.find((el) => /^TBA$/i.test(textOf(el)));
      if (exact) { exact.click(); return textOf(exact); }

      // Loose: "TBA Guest", "TBA - To Be Announced", etc.
      const loose = all.find((el) => /^TBA(\b|[\s\-:])/i.test(textOf(el)));
      if (loose) { loose.click(); return textOf(loose); }

      return null;
    });
  }

  // ---------------------------------------------------------------
  // Split a free-form guest name into first / middle-initial / last.
  // "Matt Brown"      -> { first: "Matt",  middle: "",  last: "Brown" }
  // "John D Smith"    -> { first: "John",  middle: "D", last: "Smith" }
  // "Mary Ann Jones"  -> { first: "Mary Ann",            last: "Jones" }
  // "Madonna"         -> { first: "Madonna",             last: "" }
  // ---------------------------------------------------------------
  parseGuestName(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { first: '', middle: '', last: '' };
    if (parts.length === 1) return { first: parts[0], middle: '', last: '' };
    if (parts.length >= 3 && parts[parts.length - 2].length === 1) {
      return {
        first: parts.slice(0, -2).join(' '),
        middle: parts[parts.length - 2],
        last: parts[parts.length - 1],
      };
    }
    return {
      first: parts.slice(0, -1).join(' '),
      middle: '',
      last: parts[parts.length - 1],
    };
  }

  // ---------------------------------------------------------------
  // Foretees pops a jQuery UI dialog titled "Adding a Member or
  // Guest" the first time you click a player slot in a session.
  // It's just an informational overlay ("...use the member selection
  // tool on the right") but it modal-overlays the page until
  // dismissed, blocking the real Guest Registration modal from
  // being interactable.  Programmatic clicks still fire on the
  // page underneath, which is why every previous step looked like
  // it had succeeded while no guest actually landed.
  //
  // Tick "Don't show this message again" so it doesn't reappear,
  // then close the dialog.  Returns true if a dialog was dismissed.
  // ---------------------------------------------------------------
  async dismissAddingMemberOrGuestDialog() {
    return await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      // Find a visible ui-dialog whose titlebar text is the one we want
      const dialogs = [...document.querySelectorAll('.ui-dialog')].filter(visible);
      const target = dialogs.find((d) => {
        const title = d.querySelector('.ui-dialog-title');
        return title && /adding\s+a\s+member\s+or\s+guest/i.test((title.textContent || '').trim());
      });
      if (!target) return false;

      // Tick "Don't show this message again" if present
      const suppress = target.querySelector('input[type="checkbox"][name="suppressAlert"]');
      if (suppress && !suppress.checked) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
        setter.call(suppress, true);
        suppress.dispatchEvent(new Event('change', { bubbles: true }));
        suppress.dispatchEvent(new Event('click', { bubbles: true }));
      }

      // Prefer the button-pane Close, fall back to the titlebar X
      const paneCloseBtn = [...target.querySelectorAll('.ui-dialog-buttonpane button')]
        .find((b) => /^close$/i.test((b.textContent || '').trim()));
      if (paneCloseBtn) { paneCloseBtn.click(); return true; }

      const xBtn = target.querySelector('.ui-dialog-titlebar-close');
      if (xBtn) { xBtn.click(); return true; }

      return true;
    });
  }

  // ---------------------------------------------------------------
  // Click the target player row to move Foretees' "Select Player #N"
  // pointer to that slot.  The pointer normally auto-advances after
  // each fill, but we focus explicitly as a safety guard so guests
  // never land on the wrong slot.
  // ---------------------------------------------------------------
  async focusSlot(slotIdx) {
    return await this.page.evaluate((idx) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const row = document.querySelector(`#slot_player_row_${idx}`);
      if (!row || !visible(row)) return false;
      // The readonly name input is the most reliable click target -- the
      // page wires its click handler to "make this slot the active one".
      const nameInp = row.querySelector('input.ftS-playerNameInput, input[type="text"]');
      (nameInp || row).click();
      return true;
    }, slotIdx);
  }

  // ---------------------------------------------------------------
  // Fill the Scioto Guest Registration modal's First Name / Middle
  // Initial / Last Name inputs and click the "Add New Guest" button.
  // Returns { clicked: 'Add New Guest', modalClosed: bool } on
  // success, or null if the modal couldn't be located / filled.
  //
  // Modal layout (per owner-captured screenshot 2026-05-13):
  //   - Heading: "Guest Registration"
  //   - First Name *, Middle Initial, Last Name *, Guest Locker
  //   - Right side: search input + list (TBA + existing guests)
  //   - Footer: "Close" and "Add New Guest" buttons
  //
  // Hardening notes (2026-05-14):
  //   - Anchor on the "Guest Registration" heading so we never
  //     misidentify a panel-side Add-Guest link as the modal action.
  //   - Scope ALL input/button searches to inside the modal container.
  //   - Use <label for=...> first, then attribute hints, then a
  //     left-to-right input pass (First, MI, Last) over the LEFT side
  //     of the modal (excluding the right-side search column).
  //   - Wait for the modal to close after clicking Add as the real
  //     success signal -- if it stays open, Foretees rejected the add.
  // ---------------------------------------------------------------
  async findGuestRegistrationModal() {
    // Returns a Playwright ElementHandle for the visible jQuery UI
    // dialog whose titlebar reads "Guest Registration".  Owner
    // captured this HTML on 2026-05-14: the modal is a
    // .ui-dialog containing a .ui-dialog-title.  Multiple dialogs
    // may exist in the DOM (Foretees keeps hidden ones around), so
    // we filter on visibility.
    const handle = await this.page.evaluateHandle(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const dialogs = [...document.querySelectorAll('.ui-dialog')].filter(visible);
      const target = dialogs.find((d) => {
        const title = d.querySelector('.ui-dialog-title');
        return title && /^guest\s+registration$/i.test((title.textContent || '').trim());
      });
      return target || null;
    });
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }
    return element;
  }

  async waitForGuestRegistrationModal(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const handle = await this.findGuestRegistrationModal();
      if (handle) return handle;
      await this.page.waitForTimeout(100);
    }
    return null;
  }

  async captureModalHtml(modalHandle, maxLen = 20000) {
    if (!modalHandle) return null;
    try {
      return await modalHandle.evaluate((el, max) => {
        const html = el.outerHTML || '';
        return html.length > max ? html.substring(0, max) + '\n<!-- truncated -->' : html;
      }, maxLen);
    } catch (e) {
      logger.warn(`captureModalHtml failed: ${e.message}`);
      return null;
    }
  }

  async fillGuestRegistrationAndAdd(firstName, middleInitial, lastName) {
    const modal = await this.waitForGuestRegistrationModal(4000);
    if (!modal) {
      logger.warn(`  "Guest Registration" modal did not appear for "${firstName} ${lastName}".`);
      return { error: 'modal_not_found', modalHtml: null };
    }

    // Failures from each strategy accumulate here so the TBA fallback
    // diagnostic can show the reader what we tried before falling back.
    const strategyErrors = [];

    try {
      // ---- Strategy 1: select an existing guest from the Search Guests list ----
      // Owner-captured DOM (2026-05-14): items in
      // .ftGdb-guestSelect .ftMs-resultList .ftMs-listItem read
      // "Last, First " (with trailing space).  If the owner pre-added
      // the guest on Foretees, this path skips the form entirely.
      const existing = await modal.evaluate((container, { first, last }) => {
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        };
        const items = [...container.querySelectorAll('.ftGdb-guestSelect .ftMs-resultList .ftMs-listItem')].filter(visible);
        const more  = [...container.querySelectorAll('.ftMs-resultList .ftMs-listItem')].filter(visible);
        const pool = items.length ? items : more;

        const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const targetLF = normalize(`${last}, ${first}`);
        const targetFL = normalize(`${first} ${last}`);

        // Reject TBA from the existing-guest match so a guest literally
        // named "Tba" can't accidentally select the placeholder.
        const isTba = (el) => /^tba$/i.test((el.textContent || '').trim());

        let target = pool.find((el) => !isTba(el) && normalize(el.textContent) === targetLF);
        if (!target) target = pool.find((el) => !isTba(el) && normalize(el.textContent).startsWith(targetLF));
        if (!target) target = pool.find((el) => !isTba(el) && normalize(el.textContent) === targetFL);
        if (!target) return null;

        target.click();
        return target.textContent.trim();
      }, { first: firstName, last: lastName });

      if (existing) {
        logger.info(`  Selected existing guest "${existing}" from Search Guests list.`);
        const closed = await this.waitForModalToClose(modal, 3500);
        if (closed) {
          return { clicked: `existing:${existing}`, modalClosed: true };
        }
        strategyErrors.push('existing_modal_stayed_open');
        logger.warn(`  Modal stayed open after clicking existing guest "${existing}" -- falling back.`);
      } else {
        strategyErrors.push('existing_not_in_list');
      }

      // ---- Strategy 2: switch to "Add Guests" tab and fill the form ----
      // Owner-captured DOM: .ftGdb-tabs has Search Guests (default
      // active) and Add Guests; inputs are name_first / name_mi /
      // name_last; the "Add New Guest" button is in the dialog
      // button-pane.
      const tabSwitched = await modal.evaluate((container) => {
        let tab = container.querySelector('.ftGdb-tabs [data-fttab=".ftGdb-guestAdd"]');
        if (!tab) {
          tab = [...container.querySelectorAll('.ftGdb-tabs li > div, .ftGdb-tabs li > a')]
            .find((el) => /^add\s+guests?$/i.test((el.textContent || '').trim()));
        }
        if (!tab) return false;
        tab.click();
        return true;
      });

      if (!tabSwitched) {
        strategyErrors.push('add_tab_not_found');
      } else {
        await this.humanDelay(200, 400);

        const filled = await modal.evaluate((container, { first, mi, last }) => {
          const setVal = (el, v) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          const firstInp = container.querySelector('input[name="name_first"]');
          const miInp    = container.querySelector('input[name="name_mi"]');
          const lastInp  = container.querySelector('input[name="name_last"]');
          if (!firstInp || !lastInp) {
            return {
              ok: false,
              reason: 'inputs_not_found',
              haveFirst: !!firstInp,
              haveLast: !!lastInp,
              haveMi: !!miInp,
            };
          }
          setVal(firstInp, first);
          if (mi && miInp) setVal(miInp, mi);
          setVal(lastInp, last);
          return { ok: true, first: firstInp.value, last: lastInp.value, mi: miInp ? miInp.value : '' };
        }, { first: firstName, mi: middleInitial, last: lastName });

        if (!filled.ok) {
          strategyErrors.push(`add_form_${filled.reason}`);
        } else {
          logger.info(`  Filled Add Guests form: first="${filled.first}" mi="${filled.mi}" last="${filled.last}".`);
          await this.humanDelay(300, 600);

          const clicked = await modal.evaluate((container) => {
            const btns = [...container.querySelectorAll('.ui-dialog-buttonpane button')];
            const target = btns.find((b) => /^add\s+new\s+guest$/i.test((b.textContent || '').trim()));
            if (!target) return null;
            target.click();
            return 'Add New Guest';
          });

          if (!clicked) {
            strategyErrors.push('add_button_not_found');
          } else {
            logger.info(`  Clicked "${clicked}" button. Waiting for modal to close...`);
            const modalClosed = await this.waitForModalToClose(modal, 3500);
            if (modalClosed) {
              return { clicked, modalClosed: true };
            }
            strategyErrors.push('add_modal_did_not_close');
            logger.warn(`  Modal still visible after clicking "Add New Guest" -- Foretees likely rejected the add.`);
          }
        }
      }

      // ---- Strategy 3 (fallback): click TBA from the Search Guests list ----
      // Owner's priority is always "secure the tee time no matter what."
      // Filling the slot with TBA still books the time -- the owner can
      // edit the player name on Foretees afterward.  This requires
      // switching back to the Search Guests tab (we may have left it
      // active on the Add Guests tab in Strategy 2).
      logger.warn(`  Falling back to TBA placeholder for "${firstName} ${lastName}" (strategy errors: ${strategyErrors.join(', ')}).`);

      await modal.evaluate((container) => {
        let tab = container.querySelector('.ftGdb-tabs [data-fttab=".ftGdb-guestSelect"]');
        if (!tab) {
          tab = [...container.querySelectorAll('.ftGdb-tabs li > div, .ftGdb-tabs li > a')]
            .find((el) => /^search\s+guests?$/i.test((el.textContent || '').trim()));
        }
        if (tab) tab.click();
      });
      await this.humanDelay(200, 400);

      const tbaClicked = await modal.evaluate((container) => {
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        };
        const pool = [...container.querySelectorAll('.ftGdb-guestSelect .ftMs-resultList .ftMs-listItem, .ftMs-resultList .ftMs-listItem')]
          .filter(visible);
        const target = pool.find((el) => /^tba$/i.test((el.textContent || '').trim()));
        if (!target) return false;
        target.click();
        return true;
      });

      if (!tbaClicked) {
        strategyErrors.push('tba_not_in_list');
        const modalHtml = await this.captureModalHtml(modal);
        return { error: 'all_strategies_failed', strategyErrors, modalHtml };
      }

      const tbaClosed = await this.waitForModalToClose(modal, 3500);
      if (!tbaClosed) {
        strategyErrors.push('tba_modal_did_not_close');
        const modalHtml = await this.captureModalHtml(modal);
        return { error: 'all_strategies_failed', strategyErrors, modalHtml };
      }
      logger.info(`  TBA fallback succeeded for "${firstName} ${lastName}" -- slot filled with placeholder.`);
      return { clicked: 'TBA-fallback', modalClosed: true, fallback: true, strategyErrors };
    } finally {
      await modal.dispose();
    }
  }

  async waitForModalToClose(modalHandle, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stillVisible = await modalHandle.evaluate((el) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      }).catch(() => false);
      if (!stillVisible) return true;
      await this.page.waitForTimeout(100);
    }
    return false;
  }

  // ---------------------------------------------------------------
  // Fill a guest name into the Guests-tab inputs and click Add.
  // Supports split first/last layouts and single full-name layouts.
  // Returns the label of the button clicked, or null if no button
  // was found.
  // ---------------------------------------------------------------
  async fillGuestNameAndAdd(firstName, lastName) {
    const filled = await this.page.evaluate(({ first, last }) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')]
        .filter(visible);

      const matchInput = (patterns) => inputs.find((el) => {
        const hay = (
          (el.name || '') + ' ' +
          (el.id || '') + ' ' +
          (el.placeholder || '') + ' ' +
          (el.getAttribute('aria-label') || '')
        ).toLowerCase();
        return patterns.some((p) => hay.includes(p));
      });

      const firstInput = matchInput(['first', 'fname', 'gst_first']);
      const lastInput  = matchInput(['last', 'lname', 'gst_last']);
      const fullInput  = matchInput(['guest_name', 'gst_name', 'full_name', 'guest name']);

      if (firstInput && lastInput) {
        setVal(firstInput, first);
        if (last) setVal(lastInput, last);
        return { mode: 'split' };
      }
      if (fullInput) {
        setVal(fullInput, (first + ' ' + last).trim());
        return { mode: 'full' };
      }
      // Fallback: only consider inputs that look guest-related to avoid
      // typing into the member player-row name inputs.
      const guestInputs = inputs.filter((el) => {
        const hay = (
          (el.name || '') + ' ' +
          (el.id || '') + ' ' +
          (el.placeholder || '') + ' ' +
          (el.getAttribute('aria-label') || '')
        ).toLowerCase();
        return /guest|gst/.test(hay);
      });
      const firstGuest = guestInputs.find((el) => !el.value);
      if (firstGuest) {
        setVal(firstGuest, (first + ' ' + last).trim());
        return { mode: 'fallback' };
      }
      return null;
    }, { first: firstName, last: lastName });

    if (!filled) {
      logger.warn(`  No guest-name input found for "${firstName} ${lastName}".`);
      return null;
    }
    logger.info(`  Filled guest input (${filled.mode}): "${(firstName + ' ' + lastName).trim()}".`);
    await this.humanDelay(300, 600);

    const clicked = await this.page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')]
        .filter(visible);
      const isFormSubmit = (t) => /submit\s+(request|changes)/i.test(t);
      const textOf = (el) => (el.textContent || el.value || '').trim().toLowerCase();

      const labels = ['add guest', 'add', 'ok'];
      for (const label of labels) {
        const btn = candidates.find((el) => textOf(el) === label && !isFormSubmit(textOf(el)));
        if (btn) { btn.click(); return label; }
      }
      const loose = candidates.find((el) => {
        const t = textOf(el);
        return !isFormSubmit(t) && /\b(add\s*guest|add)\b/.test(t);
      });
      if (loose) { loose.click(); return textOf(loose); }
      return null;
    });

    if (clicked) {
      logger.info(`  Clicked guest add button: "${clicked}".`);
    } else {
      logger.warn(`  No Add/Submit button found on Guests tab.`);
    }
    return clicked;
  }

  // ---------------------------------------------------------------
  // Detect ForeTees "Session Error N" modal on the Member_slot page.
  // The modal HTML carries a jQuery UI dialog with title "Session Error 3"
  // (or "Session Error N"); the actual form data also embeds
  // page_start_title / page_start_notifications under
  // slot_container[data-ftjson]. We check both sources so we catch the
  // error even if the modal markup changes.
  // ---------------------------------------------------------------
  async detectSessionError() {
    return await this.page.evaluate(() => {
      const titleEl = document.querySelector('.ui-dialog-title');
      const titleText = titleEl ? (titleEl.textContent || '').trim() : '';
      const subText = (document.querySelector('.sub_instructions') || {}).textContent || '';
      let ftjson = null;
      const container = document.querySelector('.slot_container');
      if (container) {
        try { ftjson = JSON.parse(container.getAttribute('data-ftjson') || '{}'); }
        catch (e) { ftjson = null; }
      }
      const pageStartTitle = (ftjson && ftjson.page_start_title) || '';
      const pageStartNotifs = (ftjson && Array.isArray(ftjson.page_start_notifications))
        ? ftjson.page_start_notifications : [];

      const sessionRe = /session\s*error/i;
      const sorryRe = /problem with your session/i;
      const matched =
        sessionRe.test(titleText) ||
        sessionRe.test(pageStartTitle) ||
        sorryRe.test(subText) ||
        pageStartNotifs.some((n) => sorryRe.test(n));
      if (!matched) return { detected: false, title: '', notifications: [] };
      return {
        detected: true,
        title: pageStartTitle || titleText || 'Session Error',
        notifications: pageStartNotifs.length ? pageStartNotifs : [subText.trim()].filter(Boolean),
      };
    }).catch(() => ({ detected: false, title: '', notifications: [] }));
  }

  // ---------------------------------------------------------------
  // Read the current name-input value for each player slot row on
  // the booking form.  Returns an array of length up to 4 (one entry
  // per transport <select> we see), where each entry is the trimmed
  // name input value or '' if empty.  Used to verify that a partner
  // or guest click actually populated the target slot.
  // ---------------------------------------------------------------
  async readSlotNames() {
    return await this.page.evaluate(() => {
      const transports = ['C-H', 'C-A', 'C-B', 'CAR', 'WAL', 'FOR', 'TRL'];
      const rows = [];
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opts = [...sel.options].map((o) => o.value);
        if (!opts.some((v) => transports.includes(v))) continue;

        // Walk up to the closest container that holds an <input type="text">.
        // That container is the player row.
        let row = sel.closest('tr');
        if (!row || !row.querySelector('input[type="text"]')) {
          let p = sel.parentElement;
          while (p && !p.querySelector('input[type="text"]')) p = p.parentElement;
          row = p;
        }
        if (!row) { rows.push(''); continue; }
        const nameInp = row.querySelector('input[type="text"]');
        const name = nameInp ? (nameInp.value || '').trim() : '';
        if (name) { rows.push(name); continue; }
        // TBD-X rows have an empty name input -- Foretees stores the "X"
        // indicator in a sibling .playerType div instead.  Treat that as
        // "filled" so addGuest's TBD-X fallback isn't logged as failed.
        const typeEl = row.querySelector('.playerType');
        const typeTxt = typeEl ? (typeEl.textContent || '').trim() : '';
        // Slot 0 (the member's own row) always has playerType="Member"
        // even when empty -- ignore that label.  Anything else (e.g.
        // "X", "Guest") indicates the slot has been populated.
        if (typeTxt && typeTxt.toLowerCase() !== 'member') {
          rows.push(typeTxt);
          continue;
        }
        rows.push('');
      }
      return rows;
    });
  }

  // Did the add succeed?  Foretees auto-routes guest/TBA picks to the
  // leftmost empty player row regardless of which "Select Player #N"
  // prompt is active, so we count the action as successful if either:
  //   1. The targeted slotIdx itself filled (or its value changed), OR
  //   2. Any previously-empty row among the 4 player slots is now
  //      filled -- the add landed somewhere, just not in the row we
  //      targeted.  Without this fallback we'd record a spurious
  //      guest_add_failed diagnostic on every successful guest add
  //      that happened to land in a different row than expected.
  async didSlotFill(before, slotIdx) {
    const after = await this.readSlotNames();
    const targetIsFilled = after[slotIdx] && after[slotIdx].length > 0;
    if (targetIsFilled && before[slotIdx] !== after[slotIdx]) return true;
    const len = Math.min(4, Math.max(before.length, after.length));
    for (let i = 0; i < len; i++) {
      const wasEmpty = !before[i];
      const nowFilled = after[i] && after[i].length > 0;
      if (wasEmpty && nowFilled) return true;
    }
    return false;
  }

  // Fallback: search the Members tab if partner is not in the Partners list
  async tryMembersTab(partnerName, transSelectIndex) {
    // Anchor on the data-fttab attribute -- a plain :has-text("Members")
    // also matches the "Member_select" / "Member Central" navigation
    // elsewhere on the page.
    const membersTabSwitched = await this.page.evaluate(() => {
      const tab = document.querySelector('[data-fttab=".ftMs-memberSearch"]');
      if (tab) { tab.click(); return true; }
      return false;
    });
    if (!membersTabSwitched) {
      logger.error(`  Could not locate Members tab.`);
      return;
    }
    await this.humanDelay(300, 500);

    // The Members tab shows a search input; results don't appear until we
    // type.  Type the last name, wait for the ajax result list to populate.
    const lastName = partnerName.split(' ').pop();
    const searchInput = this.page.locator('.ftMs-memberSearch .ftMs-input').first();
    if (await searchInput.count() === 0) {
      logger.error(`  Members search input not found.`);
      return;
    }
    await searchInput.fill('');
    await searchInput.type(lastName, { delay: 30 });
    await this.humanDelay(700, 1000);

    // Click a matching row INSIDE the Members result list only.  A whole-
    // document walk previously matched the "Welcome, <member>" page banner
    // and returned a false success.
    const clicked = await this.page.evaluate((name) => {
      const parts = name.split(' ');
      if (parts.length < 2) return null;
      const last = parts[parts.length - 1].toLowerCase();
      const first = parts.slice(0, -1).join(' ').toLowerCase();
      const list = document.querySelector('.ftMs-memberSearch .ftMs-resultList');
      if (!list) return null;
      const items = list.querySelectorAll('.ftMs-listItem');
      for (const el of items) {
        const text = el.textContent.trim();
        if (text.length > 60) continue;
        const t = text.toLowerCase();
        if (t.includes(last) && t.includes(first)) {
          el.click();
          return text;
        }
      }
      return null;
    }, partnerName);

    if (clicked) {
      logger.info(`  Found via Members tab: ${clicked}`);
      await this.humanDelay(300, 600);
      const updatedSelects = await this.page.$$('select');
      const updatedTransSelects = [];
      for (const sel of updatedSelects) {
        const options = await sel.$$eval('option', (opts) => opts.map((o) => o.value));
        if (options.some((v) => ['C-H', 'C-A', 'C-B', 'CAR', 'WAL', 'FOR', 'TRL'].includes(v))) {
          updatedTransSelects.push(sel);
        }
      }
      if (updatedTransSelects[transSelectIndex]) {
        await updatedTransSelects[transSelectIndex].selectOption(this.transport);
      }
    } else {
      logger.error(`  FAILED to find partner "${partnerName}" anywhere.`);
    }
  }

  // ---------------------------------------------------------------
  // STEP 7: Submit the booking
  //
  // Foretees uses two different submit button labels:
  //   - "Submit Request"  -- booking a fully open slot (new tee time)
  //   - "Submit Changes"  -- modifying an existing booking
  // We handle both. Also handles error popups:
  //   - "Minimum Player Limit" -- slot requires more players
  //   - "Member Already Playing" -- member already booked nearby
  // ---------------------------------------------------------------
  async submitBooking() {
    logger.info('Submitting booking...');
    await this.screenshot('08_pre_submit');

    // Click the Foretees submit button using EXACT selectors only.
    // A loose /submit/i regex risks clicking unrelated links (e.g. help
    // links, navigation) and was the proximate cause of false-success
    // booking reports.  We accept only the two canonical buttons.
    const clickedLabel = await this.page.evaluate(() => {
      const targets = [
        document.querySelector('a.submit_request_button'),
        document.querySelector('a.submit_changes_button'),
      ].filter(Boolean);
      if (targets.length === 0) {
        // Strict text fallback: only "Submit Request" or "Submit Changes"
        const links = [...document.querySelectorAll('a')];
        const exact = links.find((a) => /^submit\s+(request|changes)$/i.test(a.textContent.trim()));
        if (exact) targets.push(exact);
      }
      if (targets.length === 0) return null;
      const btn = targets[0];
      const label = btn.textContent.trim();
      btn.click();
      return label;
    });

    if (!clickedLabel) {
      logger.error('Could not find Submit Request/Changes button on booking form.');
      await this.screenshot('08_no_submit_button');
      return false;
    }
    logger.info(`Clicked submit button: "${clickedLabel}"`);

    // Wait for Foretees to respond (popup or navigation)
    await this.page.waitForTimeout(2000);
    await this.screenshot('09_post_submit');

    // Check for known error popups
    const pageText = await this.page.textContent('body').catch(() => '');

    // Minimum player restriction -- return special status for outer retry
    if (pageText.includes('Minimum Player Limit') || pageText.includes('minimum of')) {
      logger.info('Minimum player limit hit - will retry with next slot');
      await this.page.evaluate(() => {
        const btn = [...document.querySelectorAll('a')].find((a) => /^(OK|Close|Cancel)$/i.test(a.textContent.trim()));
        if (btn) btn.click();
      });
      await this.page.waitForTimeout(1000);
      return 'min_player_limit';
    }

    // Member already playing (double-booked within 4 hours)
    if (pageText.includes('Member Already Playing') || pageText.includes('already scheduled to play')) {
      throw new Error(`Member is already booked on ${this.booking.date} within 4 hours of this time. Remove the existing booking first or choose a different time.`);
    }

    // Always click any "Yes, Continue" button if present.  Foretees pops
    // a Player/Guest Association confirmation modal when slot order isn't
    // ideal (and possibly other confirmations) -- the user's directive is
    // unambiguous: the booking must go through, anything else can be
    // fixed manually after the fact.  Generic OK/Confirm/Yes dismissal
    // below doesn't match "Yes, Continue" because of the comma, so this
    // explicit pass runs first.
    const yesContinueClicked = await this.page.evaluate(() => {
      const btn = [...document.querySelectorAll('a, button, input[type=button], input[type=submit]')].find((el) => {
        const t = (el.textContent || el.value || '').trim();
        return /^yes\s*,?\s*continue\b/i.test(t);
      });
      if (!btn) return null;
      const label = (btn.textContent || btn.value || '').trim();
      btn.click();
      return label;
    });
    if (yesContinueClicked) {
      this.recordDiag('yes_continue_clicked', { button: yesContinueClicked });
      logger.info(`Clicked confirmation button: "${yesContinueClicked}"`);
      await this.page.waitForTimeout(2000);
      await this.screenshot('09b_post_yes_continue');
    }

    // Dismiss any "OK / Confirm" popup Foretees pops after a successful submit
    const popupLabel = await this.page.evaluate(() => {
      const btn = [...document.querySelectorAll('a')].find((a) => /^(OK|Confirm|Yes)$/i.test(a.textContent.trim()));
      if (btn) {
        const label = btn.textContent.trim();
        btn.click();
        return label;
      }
      return null;
    });
    if (popupLabel) {
      logger.info(`Dismissed post-submit popup: "${popupLabel}"`);
      await this.page.waitForTimeout(1500);
      await this.screenshot('10_post_popup');
    }

    // SOURCE OF TRUTH: re-fetch the tee sheet and confirm the member's name
    // is on the chosen slot.  In-page text like "successfully" / "Confirmation"
    // is unreliable and previously caused false-success bookings.
    //
    // verifyBookingOnSheet now returns one of:
    //   'verified' -- member on slot AND all expected players present
    //   'partial'  -- member on slot but guests/partners didn't fill (the
    //                 tee time IS secured on Foretees; user can fill in
    //                 the missing players manually)
    //   false      -- member not on slot at all (true verification fail)
    const verified = await this.verifyBookingOnSheet();
    if (verified === 'verified') {
      logger.info('BOOKING CONFIRMED via tee-sheet verification.');
      return true;
    }
    if (verified === 'partial') {
      logger.warn('BOOKING PARTIALLY CONFIRMED: tee time secured but some guests/partners did not fill. User should add them manually.');
      return 'partial';
    }
    logger.error('BOOKING NOT CONFIRMED: member name not found on chosen slot.');
    // Capture what the page actually said when we gave up.  Without this
    // a "Submit did not confirm" failure has no clues at all -- if some
    // future unhandled Foretees popup blocks the submit, we want a
    // breadcrumb instead of an empty diagnostics array.
    const pageTextAtFail = await this.page.textContent('body').catch(() => '');
    const visibleButtons = await this.page.evaluate(() => {
      return [...document.querySelectorAll('a, button, input[type=button], input[type=submit]')]
        .map((el) => (el.textContent || el.value || '').trim())
        .filter(Boolean)
        .filter((t) => t.length < 80)
        .slice(0, 30);
    }).catch(() => []);
    this.recordDiag('verify_failed', {
      chosenTime: this.chosenTime,
      pageTextSnippet: pageTextAtFail.slice(0, 800),
      visibleButtons,
    });
    await this.screenshot('11_verification_failed');
    return false;
  }

  // ---------------------------------------------------------------
  // Verify a booking actually landed by re-fetching the tee sheet
  // and checking:
  //   1) the member's name is on the chosen time slot
  //   2) the row has at least the expected number of players
  //      (1 self + partners + guests).
  // The player-count check catches the silent-partial-booking case
  // where the form submitted with only the member because guest
  // adds didn't take.
  // Returns true only on positive confirmation of both checks.
  // ---------------------------------------------------------------
  // Returns one of:
  //   'verified' -- member on slot AND all expected players present
  //   'partial'  -- member on slot but guests/partners short (tee time IS booked)
  //   false      -- member not on slot at all
  async verifyBookingOnSheet() {
    const chosenTime = this.chosenTime;
    if (!chosenTime) {
      logger.warn('verifyBookingOnSheet: no chosenTime recorded; cannot verify.');
      return false;
    }
    const expectedPlayers = 1 + (this.booking.partners || []).length + (this.booking.guests || []).length;
    const targetDate = this.booking.date;
    const sheetUrl = `${config.foretees.baseUrl}${config.foretees.sheetPage}?calDate=${targetDate}&course=&displayOpt=0&select_jump`;
    try {
      await this.page.goto(sheetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      logger.warn(`verifyBookingOnSheet: tee-sheet reload failed: ${e.message}`);
      return false;
    }
    const result = await this.page.evaluate(({ name, time }) => {
      const parts = name.trim().split(/\s+/);
      const first = parts[0] || '';
      const last = parts[parts.length - 1] || '';
      const inspectRow = (row) => {
        const rowText = (row.textContent || '').trim();
        const hasFull = name && rowText.includes(name);
        const hasFirstLast = first && last && rowText.includes(first) && rowText.includes(last);
        const openMatch = rowText.match(/(\d+)\s*Open/);
        const openCount = openMatch ? parseInt(openMatch[1]) : null;
        return {
          hasMember: hasFull || hasFirstLast,
          openCount,
          rowText: rowText.substring(0, 240),
        };
      };

      // Try via the tee-time button first
      const buttons = [...document.querySelectorAll('a.teetime_button')];
      for (const btn of buttons) {
        if (btn.textContent.trim() === time) {
          const row = btn.closest('.rwdTr');
          if (!row) return { found: false, reason: 'no_row' };
          return { found: true, ...inspectRow(row) };
        }
      }
      // Fallback: scan all rows for the time text
      const rows = [...document.querySelectorAll('.rwdTr')];
      for (const row of rows) {
        if ((row.textContent || '').includes(time)) {
          return { found: true, ...inspectRow(row) };
        }
      }
      return { found: false, reason: 'no_matching_row' };
    }, { name: config.memberName, time: chosenTime });

    if (!result.found) {
      logger.warn(`Verification failed for ${chosenTime} on ${targetDate}: ${result.reason || 'no_row'}.`);
      return false;
    }
    if (!result.hasMember) {
      logger.warn(`Verification failed: member name not on ${chosenTime} for ${targetDate}. Row: ${result.rowText || '(none)'}`);
      return false;
    }
    if (result.openCount != null) {
      const actualPlayers = 4 - result.openCount;
      if (actualPlayers < expectedPlayers) {
        logger.warn(`PARTIAL BOOKING: ${chosenTime} has ${actualPlayers}/${expectedPlayers} players (member is on, but ${expectedPlayers - actualPlayers} guest/partner slot(s) didn't take). The tee time IS secured -- add missing players manually on Foretees. Row: ${result.rowText}`);
        await this.forceScreenshot('11_partial_booking_on_sheet');
        this.recordDiag('partial_booking', {
          chosenTime,
          targetDate,
          expectedPlayers,
          actualPlayers,
          rowText: result.rowText,
        });
        return 'partial';
      }
      logger.info(`Verified: ${config.memberName} on ${chosenTime} with ${actualPlayers}/${expectedPlayers} players for ${targetDate}.`);
    } else {
      logger.info(`Verified: ${config.memberName} on ${chosenTime} for ${targetDate} (open count not parseable; player-count check skipped).`);
    }
    return 'verified';
  }

  // ---------------------------------------------------------------
  // MAIN: Run the full booking sequence (for on-demand / testing)
  // ---------------------------------------------------------------
  async run() {
    try {
      await this.launchBrowser();
      await this.login();
      await this.navigateToForetees();

      const triedSlots = [];
      const MAX_SLOT_ATTEMPTS = 5;

      for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt++) {
        await this.navigateToTeeSheet();
        const bookedTime = await this.selectTeeTime(triedSlots);
        triedSlots.push(bookedTime);
        const sessionErr = await this.detectSessionError();
        if (sessionErr.detected) {
          this.recordDiag('session_error_3', {
            attempt: attempt + 1,
            chosenTime: bookedTime,
            title: sessionErr.title,
            notifications: sessionErr.notifications,
          });
          logger.warn(`Session Error after clicking ${bookedTime}: "${sessionErr.title}". Skipping and trying another slot.`);
          continue;
        }
        await this.fillBookingForm();
        const result = await this.submitBooking();

        if (result === 'min_player_limit') {
          logger.info(`Slot ${bookedTime} has min player limit, trying next slot (attempt ${attempt + 1}/${MAX_SLOT_ATTEMPTS})...`);
          continue;
        }

        if (result === true) {
          logger.info(`Booking complete for ${this.booking.date} at ${bookedTime}.`);
          return { success: true, time: bookedTime, diagnostics: this.diagnostics };
        }

        if (result === 'partial') {
          logger.warn(`Tee time SECURED at ${bookedTime} but some guests/partners did not fill. Add them manually on Foretees.`);
          return { success: true, partial: true, time: bookedTime, diagnostics: this.diagnostics };
        }

        // Submit returned false: verification failed.  Don't retry the same
        // slot -- the form data is likely the issue, not the slot.
        return { success: false, error: `Submit did not confirm booking for ${bookedTime}.`, time: bookedTime, diagnostics: this.diagnostics };
      }

      throw new Error('All available tee times have minimum player limits. Try adding more partners or a different time window.');
    } catch (error) {
      logger.error(`Booking failed: ${error.message}`);
      await this.screenshot('ERROR_' + error.message.substring(0, 30).replace(/[^a-zA-Z0-9]/g, '_'));
      return { success: false, error: error.message, diagnostics: this.diagnostics };
    } finally {
      if (this.browser) {
        await this.browser.close();
        logger.info('Browser closed.');
      }
    }
  }

  // ---------------------------------------------------------------
  // PRECISION MODE: The competitive booking engine.
  //
  // Timeline:
  //   6:58 AM  - Scheduler fires, launches browser
  //   6:58-59  - Log in to Scioto CC, navigate to Foretees, select member
  //   6:59:00  - Logged in, sitting on Foretees. Start hammering the
  //              tee sheet URL every 200ms.
  //   7:00:00  - Booking window opens. First successful tee sheet load
  //              triggers immediate slot selection and booking.
  //
  // The goal: be the first request that hits the tee sheet after the
  // server clock rolls to 7:00 AM.
  // ---------------------------------------------------------------
  async runPrecision() {
    // Hard cap on the whole precision run so a hung Playwright op
    // (e.g., a stalled fillBookingForm or submitBooking) can't pin the
    // dyno indefinitely.  Real runs finish well under this; the longest
    // observed legitimate path is ~3 min wait + ~2 min rapid-fire +
    // ~30 s form + ~10 s submit.  Set generously so we only catch
    // genuine hangs, not slow-but-working runs.
    const RUN_TIMEOUT_MS = 10 * 60 * 1000;
    let watchdogTimer;
    const watchdog = new Promise((_, reject) => {
      watchdogTimer = setTimeout(() => {
        reject(new Error(`Booking exceeded ${RUN_TIMEOUT_MS / 60000}-minute hard timeout`));
      }, RUN_TIMEOUT_MS);
    });

    try {
      return await Promise.race([this._doRunPrecision(), watchdog]);
    } catch (error) {
      logger.error(`Precision booking failed: ${error.message}`);
      await this.screenshot('PRECISION_TIMEOUT').catch(() => {});
      // Fire-and-forget close: if Playwright itself is hung the close
      // call can stall indefinitely.  We must not let watchdog cleanup
      // re-introduce the hang it is trying to escape, so we don't
      // await it.  The inner _doRunPrecision will settle on its own.
      if (this.browser) {
        const b = this.browser;
        this.browser = null;
        b.close().catch(() => {});
        logger.info('Browser force-close scheduled after timeout.');
      }
      return { success: false, error: error.message, diagnostics: this.diagnostics };
    } finally {
      clearTimeout(watchdogTimer);
    }
  }

  async _doRunPrecision() {
    try {
      await this.launchBrowser();
      await this.login();
      await this.navigateToForetees();

      // We are now logged in and on the Foretees welcome page.
      logger.info('Logged in and ready. Preparing for precision booking...');

      const now = new Date();
      // Test-precision flow can override the booking-open time so we can dry-run
      // the rapid-fire path at any time today.
      const openTime = this.booking.bookingOpenTimeOverride || config.bookingOpenTime;
      const isTestRun = !!this.booking.bookingOpenTimeOverride;
      if (isTestRun) {
        logger.info(`*** TEST PRECISION: using override open time ${openTime} (instead of ${config.bookingOpenTime}) ***`);
      }
      const [openHour, openMin] = openTime.split(':').map(Number);

      // Real 7 AM booking: start rapid-fire 1 minute BEFORE open so we're
      // poised to grab the sheet the instant it appears.
      //
      // Test mode: the play date's tee sheet is already available (because
      // the play date is within the 7-day window).  If we start 1 minute
      // early the bot will book at openMin-1, defeating the purpose of
      // simulating the 7 AM race.  In test mode, wait until openTime
      // exactly before hammering, and prove the rapid-fire path's
      // first-load behavior.
      const rapidStartTime = new Date(now);
      if (isTestRun) {
        rapidStartTime.setHours(openHour, openMin, 0, 0);
      } else {
        rapidStartTime.setHours(openHour, openMin - 1, 0, 0);
      }

      const msUntilRapid = rapidStartTime.getTime() - now.getTime();

      if (msUntilRapid > 0) {
        const fmtMin = isTestRun ? openMin : openMin - 1;
        logger.info(`Waiting ${Math.round(msUntilRapid / 1000)}s until rapid-fire starts at ${openHour}:${String(fmtMin).padStart(2, '0')}:00${isTestRun ? ' (test mode: starting AT the override time)' : ' (1 minute before open)'}...`);
        await this.page.waitForTimeout(msUntilRapid);
      }

      // -------------------------------------------------------
      // RAPID-FIRE PHASE: poll the tee sheet URL until it loads
      // with the target date available.
      //
      // Two-speed cadence so we don't trigger Foretees' session-abuse
      // heuristics with 600 identical requests in 60 seconds:
      //   pre-open    : 1000 ms interval (gentle keep-alive, ~60 hits)
      //   open onward : 100 ms interval  (rapid catch within ~2 min)
      // We only switch to fast cadence at the server clock's 7:00 ET,
      // not earlier, since being early just costs requests with no
      // upside (the sheet isn't published yet).
      // -------------------------------------------------------
      logger.info('=== RAPID-FIRE MODE ENGAGED ===');
      const targetDate = this.booking.date;
      const sheetUrl = `${config.foretees.baseUrl}${config.foretees.sheetPage}?calDate=${targetDate}&course=&displayOpt=0&select_jump`;
      const openMsTodayET = new Date();
      openMsTodayET.setHours(openHour, openMin, 0, 0);
      const openEpochMs = openMsTodayET.getTime();

      let sheetLoaded = false;
      let attempts = 0;
      const maxAttempts = 1200;
      const SLOW_INTERVAL_MS = 1000;
      const FAST_INTERVAL_MS = 100;
      const FAST_TIMEOUT_MS = 2000;
      const SLOW_TIMEOUT_MS = 4000;

      while (!sheetLoaded && attempts < maxAttempts) {
        attempts++;
        const isFast = Date.now() >= openEpochMs;
        const intervalMs = isFast ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
        const navTimeoutMs = isFast ? FAST_TIMEOUT_MS : SLOW_TIMEOUT_MS;
        const attemptTime = new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

        try {
          await this.page.goto(sheetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: navTimeoutMs,
          });

          // Fused check: title + button presence in a single in-browser call.
          const ready = await this.page.evaluate(() => {
            return document.title.includes('Tee Sheet')
                   && document.querySelectorAll('a.teetime_button').length > 0;
          });

          if (ready) {
            sheetLoaded = true;
            logger.info(`TEE SHEET LOADED on attempt ${attempts} at ${attemptTime} (${isFast ? 'fast' : 'slow'} cadence)`);
            break;
          }

          if (attempts % 20 === 0) {
            logger.info(`  Attempt ${attempts} at ${attemptTime} -- tee sheet not yet available (${isFast ? 'fast' : 'slow'})...`);
          }
          await this.page.waitForTimeout(intervalMs);
        } catch (e) {
          if (attempts % 20 === 0) {
            logger.warn(`  Attempt ${attempts}: ${e.message.substring(0, 50)}`);
          }
          await this.page.waitForTimeout(intervalMs);
        }
      }

      if (!sheetLoaded) {
        throw new Error(`Tee sheet did not become available after ${attempts} attempts.`);
      }

      // Fire-and-forget screenshot -- do NOT block the slot click.
      if (config.debugScreenshots) {
        this.screenshot('05_tee_sheet_loaded').catch(() => {});
      }

      // CRITICAL PATH: pick + click slot in ONE in-browser call.
      // Everything after this is human-paced; Foretees holds the slot
      // for several minutes while we fill in players.
      //
      // After the click lands on Member_slot we check for Session Error
      // 3 ("Sorry, but there was a problem with your session"). When it
      // fires the slot page loads with no fillable inputs and the form
      // is overlaid by an undismissable modal -- if we don't notice, we
      // burn through the guest-add path and report a misleading failure.
      // Recovery: navigate back to the tee sheet (releases the held
      // slot server-side) and re-pick, skipping the time that errored.
      let bookedTime;
      const skipTimes = [];
      const MAX_SLOT_RETRIES = 3;
      let lastError;
      for (let attempt = 1; attempt <= MAX_SLOT_RETRIES; attempt++) {
        try {
          bookedTime = await this.selectTeeTimeFast(skipTimes);
        } catch (e) {
          throw e; // no more viable slots -- give up
        }
        const sessionErr = await this.detectSessionError();
        if (!sessionErr.detected) break;
        lastError = sessionErr;
        this.recordDiag('session_error_3', {
          attempt,
          chosenTime: bookedTime,
          title: sessionErr.title,
          notifications: sessionErr.notifications,
        });
        logger.warn(`Session Error after clicking ${bookedTime}: "${sessionErr.title}". Recovering and re-picking (attempt ${attempt}/${MAX_SLOT_RETRIES}).`);
        skipTimes.push(bookedTime);
        bookedTime = null;
        if (attempt === MAX_SLOT_RETRIES) {
          throw new Error(`ForeTees Session Error after ${MAX_SLOT_RETRIES} slot attempts: "${sessionErr.title}". Tried times: ${skipTimes.join(', ')}.`);
        }
        // Release the held slot server-side by navigating away, then
        // back to a fresh tee sheet load.
        await this.page.goto(sheetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await this.page.waitForTimeout(500);
      }
      if (!bookedTime) {
        throw new Error(`Could not obtain a bookable slot${lastError ? ` (last error: ${lastError.title})` : ''}.`);
      }

      await this.fillBookingForm();
      const submitResult = await this.submitBooking();
      if (submitResult !== true && submitResult !== 'partial') {
        throw new Error(`Submit did not confirm booking (result: ${submitResult}).`);
      }

      const finishTime = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const partial = submitResult === 'partial';
      if (partial) {
        logger.warn(`PRECISION BOOKING SECURED (PARTIAL) at ${finishTime} for ${this.booking.date} at ${bookedTime}. Some guests/partners didn't fill -- add manually on Foretees.`);
      } else {
        logger.info(`PRECISION BOOKING COMPLETE at ${finishTime} for ${this.booking.date} at ${bookedTime}.`);
      }
      return { success: true, partial, time: bookedTime, completedAt: finishTime, diagnostics: this.diagnostics };
    } catch (error) {
      logger.error(`Precision booking failed: ${error.message}`);
      await this.screenshot('PRECISION_ERROR');
      return { success: false, error: error.message, diagnostics: this.diagnostics };
    } finally {
      if (this.browser) {
        await this.browser.close();
        logger.info('Browser closed.');
      }
    }
  }

  // ===============================================================
  // READ-ONLY PROBE
  //
  // Walks the entire booking flow -- login, Member Central, Foretees
  // member-id, welcome, tee sheet, booking form, the Partners /
  // Members / Guests panel tabs, and the Guest Registration modal --
  // and captures each screen's full HTML, a screenshot, and a
  // key-selector health check.
  //
  // It NEVER books anything: it only opens pages and panels.  It does
  // not click Submit, does not add a guest, does not mark a slot.
  // The one mildly stateful thing it does is open a single open
  // slot's booking form so the form / panel / modal can be seen;
  // Foretees releases that hold on its own once the browser closes.
  //
  // Used to re-learn the DOM after Scioto / Foretees change their
  // pages.  Every step is wrapped so one broken screen never aborts
  // the probe -- it captures whatever rendered and moves on.
  //
  // Returns { success, error, captures: [...] }.
  // ===============================================================
  async probe() {
    this.probeCaptures = [];
    const TIMEOUT_MS = 8 * 60 * 1000;
    let timer;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Probe exceeded ${TIMEOUT_MS / 60000}-minute timeout`)),
        TIMEOUT_MS
      );
    });
    try {
      return await Promise.race([this._doProbe(), watchdog]);
    } catch (error) {
      logger.error(`[PROBE] ${error.message}`);
      if (this.browser) {
        const b = this.browser;
        this.browser = null;
        b.close().catch(() => {});
      }
      return { success: false, error: error.message, captures: this.probeCaptures };
    } finally {
      clearTimeout(timer);
    }
  }

  async _doProbe() {
    const HTML_CAP = 150000;

    // Capture the current page: URL, title, full HTML, a full-page
    // screenshot, and a key-selector health check.  Returns the
    // capture object so the caller can attach extra fields.
    const snapshot = async (step, note) => {
      const c = {
        step, note: note || '', url: '', title: '',
        html: '', screenshot: null, selectors: null,
        t: new Date().toISOString(),
      };
      try { c.url = this.page.url(); } catch (e) {}
      try { c.title = await this.page.title(); } catch (e) {}
      try {
        let html = await this.page.content();
        if (html.length > HTML_CAP) {
          html = html.substring(0, HTML_CAP) + `\n<!-- truncated at ${HTML_CAP} chars -->`;
        }
        c.html = html;
      } catch (e) {
        c.html = `(could not capture HTML: ${e.message})`;
      }
      c.screenshot = await this.probeScreenshot(step);
      try { c.selectors = await this.checkSelectors(); } catch (e) {}
      this.probeCaptures.push(c);
      logger.info(`[PROBE] ${step}: "${c.title}" (${c.url})`);
      return c;
    };

    try {
      await this.launchBrowser();

      // --- Login ---
      try {
        await this.login();
      } catch (e) {
        await snapshot('00_login_FAILED',
          `Login did not complete: ${e.message}. Scioto's login page may have changed.`);
        return { success: false, error: `Login failed: ${e.message}`, captures: this.probeCaptures };
      }
      await snapshot('01_member_central', 'Scioto Member Central, right after login.');

      // --- Open Foretees from the "Book a Tee Time" tile ---
      let onForetees = false;
      try {
        const matches = this.page.locator('text=BOOK A TEE TIME');
        const count = await matches.count();
        let clicked = false;
        for (let i = 0; i < count; i++) {
          const el = matches.nth(i);
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.scrollIntoViewIfNeeded();
            await el.click();
            clicked = true;
            break;
          }
        }
        if (!clicked && count > 0) {
          await matches.first().click({ force: true, timeout: 10000 });
          clicked = true;
        }
        if (!clicked) throw new Error('no "BOOK A TEE TIME" element found on Member Central');
        await this.page.waitForURL('**foretees.com**', { timeout: 60000, waitUntil: 'domcontentloaded' });
        onForetees = true;
      } catch (e) {
        await snapshot('02_book_a_tee_time_FAILED',
          `Could not get from Member Central to Foretees: ${e.message}. The "Book a Tee Time" link/tile may have changed.`);
      }

      if (onForetees) {
        await snapshot('02_foretees_member_id',
          'Foretees member-identification page (choose which member). With a single member this may already be the welcome page.');
        try {
          const memberButton = this.page.locator(`text="${config.memberName}"`).first();
          if (await memberButton.count() > 0) {
            await memberButton.click();
            await this.page
              .waitForURL('**/Member_announce**', { timeout: 30000, waitUntil: 'domcontentloaded' })
              .catch(() => {});
          }
        } catch (e) {}
        await snapshot('03_foretees_welcome', 'Foretees welcome / announcements page.');
      }

      // --- Tee sheet for the probe date ---
      let onSheet = false;
      try {
        const sheetUrl = `${config.foretees.baseUrl}${config.foretees.sheetPage}?calDate=${this.booking.date}&course=&displayOpt=0&select_jump`;
        await this.page.goto(sheetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        onSheet = true;
      } catch (e) {}
      const sheetCap = await snapshot('04_tee_sheet',
        `Tee sheet for ${this.booking.date}. The time-slot rows and the "book" links/buttons live here.`);
      if (!onSheet) {
        sheetCap.note += '  [The tee sheet page did not load cleanly -- captured whatever rendered.]';
      }

      // --- Find a booking form to inspect.  Prefer a slot that
      //     ALLOWS guests so the guest flow can be captured -- many
      //     morning slots restrict guests and hide the Guests tab,
      //     showing only Partners / Members / TBD. ---
      const win = this.booking.timeWindow || { start: '00:00', end: '23:59' };
      const sheetUrl = `${config.foretees.baseUrl}${config.foretees.sheetPage}?calDate=${this.booking.date}&course=&displayOpt=0&select_jump`;
      let slots = [];
      if (onSheet) {
        try { slots = await this.probeListSlots(win); } catch (e) {}
      }
      logger.info(`[PROBE] ${slots.length} open slot(s) in ${win.start}-${win.end}: ${slots.slice(0, 12).join(', ')}`);

      let onForm = false;
      let usedTime = null;
      let guestAllowed = false;
      const sampled = [];
      const maxTry = Math.min(slots.length, 6);
      for (let i = 0; i < maxTry; i++) {
        if (i > 0) {
          try { await this.page.goto(sheetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
        }
        const clicked = await this.probeClickSlot(slots[i]);
        if (!clicked) continue;
        await this.page.waitForTimeout(900);
        onForm = true;
        usedTime = slots[i];
        const hasGuests = await this.probeHasGuestsTab().catch(() => false);
        sampled.push(`${slots[i]}:${hasGuests ? 'guests-OK' : 'no-guests-tab'}`);
        if (hasGuests) { guestAllowed = true; break; }
      }

      // Fallback: window had no usable slots -- open any open slot.
      if (!onForm) {
        const opened = await this.probeOpenBookingForm();
        if (opened.ok) {
          onForm = true;
          usedTime = opened.time;
          await this.page.waitForTimeout(1200);
          guestAllowed = await this.probeHasGuestsTab().catch(() => false);
          sampled.push(`${opened.time}:fallback-any-slot`);
        } else {
          await snapshot('04b_no_slot_to_open',
            `Could not open any booking form: ${opened.reason}. The tee-sheet slot links may have been renamed.`);
        }
      }

      if (onForm) {
        await snapshot('05_booking_form',
          `Booking form opened via slot "${usedTime}". Guests ${guestAllowed ? 'ARE allowed here' : 'are NOT allowed on the sampled slot(s) -- pick an afternoon window to see the guest flow'}. Sampled: ${sampled.join(', ')}. Player rows + the right-side selector panel are here.`);
      }

      // --- Walk the player panel: focus a slot, tabs, guest modal ---
      if (onForm) {
        try {
          await this.focusSlot(1);
          await this.humanDelay(200, 400);
          const dismissed = await this.dismissAddingMemberOrGuestDialog();
          await snapshot('06_after_slot_focus',
            dismissed
              ? 'Clicked player slot 2; dismissed the "Adding a Member or Guest" intro dialog.'
              : 'Clicked player slot 2 (no intro dialog appeared, or it could not be found).');
        } catch (e) {}

        try {
          const t = await this.switchToFormTab('Partners', '.ftMs-partnerSelect');
          await this.humanDelay(300, 500);
          await snapshot('07_partners_tab',
            `Partners tab (tab-switch strategy: ${t || 'NOT FOUND'}). The member-partner list is here.`);
        } catch (e) {}

        try {
          const t = await this.switchToFormTab('Members', '.ftMs-memberSearch');
          await this.humanDelay(300, 500);
          await snapshot('08_members_tab',
            `Members tab (tab-switch strategy: ${t || 'NOT FOUND'}). The member search box is here.`);
        } catch (e) {}

        try {
          const t = await this.switchToFormTab('Guests', '.ftMs-guestTypes');
          await this.humanDelay(300, 500);
          await snapshot('09_guests_tab',
            `Guests tab (tab-switch strategy: ${t || 'NOT FOUND'}). The guest categories (Family / Guest / Social Guest) are here.`);
          if (t) {
            const cat = await this.clickGuestCategory('Guest');
            await this.humanDelay(900, 1300);
            const modalCap = await snapshot('10_guest_registration_modal',
              `Clicked guest category "${cat || 'NOT FOUND'}". The Guest Registration modal should be visible/captured here.`);
            const modal = await this.findGuestRegistrationModal();
            if (modal) {
              modalCap.modalHtml = await this.captureModalHtml(modal, HTML_CAP);
              await modal.dispose();
            } else {
              modalCap.note += '  [No ".ui-dialog" titled "Guest Registration" found -- the modal anchor may have changed. See the full HTML above.]';
            }
          }
        } catch (e) {}
      }

      return { success: true, captures: this.probeCaptures };
    } catch (error) {
      logger.error(`[PROBE] unexpected: ${error.message}`);
      return { success: false, error: error.message, captures: this.probeCaptures };
    } finally {
      if (this.browser) {
        await this.browser.close().catch(() => {});
        logger.info('[PROBE] Browser closed.');
      }
    }
  }

  // Find any open tee-time slot on the current tee sheet and click it
  // to open the (read-only) booking form.  Tries the known
  // a.teetime_button class first, then falls back to time-text
  // anchors and Member_slot links so the probe still works even if
  // Foretees renamed the slot buttons.  Returns
  // { ok, time, how, totalButtons, reason }.
  async probeOpenBookingForm() {
    let result;
    try {
      result = await this.page.evaluate(() => {
        const isTime = (t) => /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test((t || '').trim());
        let buttons = [...document.querySelectorAll('a.teetime_button')];
        let how = 'a.teetime_button';
        if (buttons.length === 0) {
          buttons = [...document.querySelectorAll('a, button')].filter((el) => isTime(el.textContent));
          how = 'time-text anchor/button';
        }
        if (buttons.length === 0) {
          buttons = [...document.querySelectorAll('a[href*="Member_slot"]')];
          how = 'a[href*=Member_slot]';
        }
        if (buttons.length === 0) {
          return { ok: false, reason: 'no tee-time slot links found by any strategy' };
        }
        let chosen = null;
        for (const btn of buttons) {
          const row = btn.closest('.rwdTr, tr');
          const m = (row ? row.textContent || '' : '').match(/(\d+)\s*Open/i);
          if (m && parseInt(m[1]) >= 1) { chosen = btn; break; }
        }
        if (!chosen) chosen = buttons[0];
        const time = (chosen.textContent || '').trim().slice(0, 40);
        chosen.click();
        return { ok: true, time, how, totalButtons: buttons.length };
      });
    } catch (e) {
      return { ok: false, reason: `error scanning the tee sheet: ${e.message}` };
    }
    if (!result.ok) return result;
    try {
      await this.page.waitForURL('**/Member_slot**', { timeout: 30000, waitUntil: 'domcontentloaded' });
    } catch (e) {
      result.reason = 'clicked a slot but the Member_slot URL did not load within 30s; captured whatever rendered';
    }
    return result;
  }

  // List the open tee-time slots (e.g. "1:30 PM") within a time
  // window on the current tee sheet, so the probe can sample slots
  // looking for one where guests are allowed.
  async probeListSlots(window) {
    return await this.page.evaluate((win) => {
      const toMin = (s) => {
        const m = String(s).match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (!m) return -1;
        let h = parseInt(m[1]);
        const mm = parseInt(m[2]);
        const ap = m[3].toUpperCase();
        if (ap === 'PM' && h !== 12) h += 12;
        if (ap === 'AM' && h === 12) h = 0;
        return h * 60 + mm;
      };
      const [sh, sm] = String(win.start).split(':').map(Number);
      const [eh, em] = String(win.end).split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      const out = [];
      for (const btn of document.querySelectorAll('a.teetime_button')) {
        const t = (btn.textContent || '').trim();
        const mn = toMin(t);
        if (mn < startMin || mn > endMin) continue;
        const row = btn.closest('.rwdTr');
        const m = (row ? row.textContent || '' : '').match(/(\d+)\s*Open/i);
        if (m && parseInt(m[1]) >= 1) out.push(t);
      }
      return out;
    }, window);
  }

  // Click the tee-time slot whose visible text is exactly `time`.
  // Returns true once the click fired (and the Member_slot form is
  // given up to 30s to load).
  async probeClickSlot(time) {
    let clicked = false;
    try {
      clicked = await this.page.evaluate((t) => {
        const btn = [...document.querySelectorAll('a.teetime_button')]
          .find((b) => (b.textContent || '').trim() === t);
        if (!btn) return false;
        btn.click();
        return true;
      }, time);
    } catch (e) {
      return false;
    }
    if (!clicked) return false;
    try {
      await this.page.waitForURL('**/Member_slot**', { timeout: 30000, waitUntil: 'domcontentloaded' });
    } catch (e) {}
    return true;
  }

  // Is there a real Guests tab on the current booking form?  A
  // guest-restricted slot shows only Partners / Members / TBD, so the
  // probe uses this to keep sampling slots until it finds one where
  // the guest flow can actually be seen.
  async probeHasGuestsTab() {
    return await this.page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-fttab]')];
      const ft = (el) => (el.getAttribute('data-fttab') || '').toLowerCase();
      if (tabs.some((t) => ft(t).includes('guest') && !ft(t).includes('tbd'))) return true;
      if (tabs.some((t) => /^guests$/i.test((t.textContent || '').trim()))) return true;
      if (document.querySelector('.ftMs-guestTypes')) return true;
      return false;
    });
  }

  // Count the key DOM selectors the booker depends on, on whatever
  // page is currently loaded.  Surfaces at a glance which hooks still
  // exist after a Foretees change -- a 0 on a selector that should be
  // present is the red flag.
  async checkSelectors() {
    return await this.page.evaluate(() => {
      const n = (sel) => {
        try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }
      };
      const transportSelects = [...document.querySelectorAll('select')].filter((s) =>
        [...s.options].some((o) => ['C-H', 'C-A', 'C-B', 'CAR', 'WAL', 'FOR', 'TRL'].includes(o.value))
      ).length;
      const dialogTitles = [...document.querySelectorAll('.ui-dialog .ui-dialog-title')]
        .map((t) => (t.textContent || '').trim())
        .filter(Boolean);
      return {
        'a.teetime_button': n('a.teetime_button'),
        '.rwdTr (sheet/form rows)': n('.rwdTr'),
        '.sP.plCol (open-count cell)': n('.sP.plCol'),
        'transport <select>': transportSelects,
        'slot_player_row_*': n('[id^="slot_player_row_"]'),
        '.ftMs-tabs': n('.ftMs-tabs'),
        '[data-fttab]': n('[data-fttab]'),
        '.ftMs-partnerSelect': n('.ftMs-partnerSelect'),
        '.ftMs-memberSearch': n('.ftMs-memberSearch'),
        '.ftMs-guestTypes': n('.ftMs-guestTypes'),
        '.ftMs-listItem': n('.ftMs-listItem'),
        '.ftGdb-tabs': n('.ftGdb-tabs'),
        'input[name="name_first"]': n('input[name="name_first"]'),
        'input[name="name_last"]': n('input[name="name_last"]'),
        '.ui-dialog': n('.ui-dialog'),
        'a.submit_request_button': n('a.submit_request_button'),
        'a.submit_changes_button': n('a.submit_changes_button'),
        'ui-dialog titles present': dialogTitles,
      };
    });
  }
}

module.exports = TeeTimeBooker;
