'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
let count = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) walk(absolute);
    else if (item.name.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' });
      count++;
    }
  }
}
for (const directory of ['src', 'scripts', 'tests', 'desktop']) walk(path.join(root, directory));
console.log(`Syntax OK: ${count} JavaScript files`);
