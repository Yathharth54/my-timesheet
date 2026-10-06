import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const read = (f: string) => fs.readFileSync(new URL(`../skill/${f}`, import.meta.url), 'utf8');

describe('skill files', () => {
  it('/timesheet review passes the week through to timesheet review', () => {
    expect(read('commands/timesheet.md')).toMatch(/`timesheet review --week <[^>]+>`/);
    expect(read('SKILL.md')).toMatch(/`\/timesheet review <the same week>`/);
  });
});
