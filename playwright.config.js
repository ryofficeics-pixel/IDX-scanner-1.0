'use strict';

module.exports = {
  testDir: './tests',
  testMatch: /.*\.e2e\.js/,
  timeout: 60000,
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
    viewport: { width:390, height:844 },
  },
};
