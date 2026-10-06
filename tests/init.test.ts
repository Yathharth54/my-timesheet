import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installSpec } from '../src/cli/commands/init.js';

describe('init', () => {
  it('installs the exact version that is running', () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(installSpec(fileURLToPath(new URL('..', import.meta.url)))).toBe(`my-timesheet@${version}`);
  });
});
