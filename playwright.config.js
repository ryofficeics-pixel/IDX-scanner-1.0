'use strict';

module.exports = {
  testDir: './tests',
  testMatch: /.*\.e2e\.js/,
  timeout: 60000,
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width:390, height:844 },
  },
};
