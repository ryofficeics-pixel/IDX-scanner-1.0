'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let count = 0;
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes:true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (entry.name.endsWith('.js')) { execFileSync(process.execPath, ['--check', filename], { stdio:'pipe' }); count += 1; }
  }
}
for (const directory of ['api', 'lib', 'scripts', 'tests', 'stockbit-gateway/src', 'stockbit-gateway/test']) check(directory);
console.log(`Syntax OK: ${count} JavaScript files`);
