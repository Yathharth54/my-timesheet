import fs from 'node:fs';
fs.cpSync('src/server/public', 'dist/server/public', { recursive: true, filter: src => !src.endsWith('.keep') });
// tsc writes files without the executable bit; a linked `timesheet` needs it.
fs.chmodSync('dist/cli/index.js', 0o755);
