require('dotenv').config();

const config = {
  clubUrl: process.env.CLUB_URL || 'https://www.sciotocc.com/login.aspx',
  username: process.env.USERNAME,
  password: process.env.PASSWORD,
  memberName: process.env.MEMBER_NAME || '',

  foretees: {
    baseUrl: 'https://www1.foretees.com/v5/sciotocc_golf_m56',
    announcePage: '/Member_announce',
    selectPage: '/Member_select',
    sheetPage: '/Member_sheet',
    slotPage: '/Member_slot',
  },

  transportMode: process.env.TRANSPORT_MODE || 'C-B',
  bookingAdvanceDays: 7,
  bookingOpenTime: '07:00',
  loginLeadMinutes: parseInt(process.env.LOGIN_LEAD_MINUTES) || 2,
  timezone: process.env.TZ || 'America/New_York',
  debugScreenshots: process.env.DEBUG_SCREENSHOTS === 'true',
  headless: process.env.HEADLESS !== 'false',
  maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 500,
};

module.exports = config;
