import fs from 'node:fs';
fs.cpSync('src/server/public', 'dist/server/public', { recursive: true, filter: src => !src.endsWith('.keep') });
