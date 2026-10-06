import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpHome } from './helpers.js';
import { paths } from '../src/lib/paths.js';
import { withWeekLock } from '../src/lib/lock.js';

const W = '2026-W41';
const lockFile = () => path.join(paths.weekDir(W), '.lock');

describe('withWeekLock', () => {
  beforeEach(() => { tmpHome(); });

  it('holds .lock with pid while running and refuses a second holder', async () => {
    await withWeekLock(W, async () => {
      expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid).toBe(process.pid);
      await expect(withWeekLock(W, async () => 1)).rejects.toThrow('Week 2026-W41 is busy (a push or distribute is running).');
    });
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('takes over a lock left by a dead process', async () => {
    const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.mkdirSync(paths.weekDir(W), { recursive: true });
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: Number(dead), at: new Date().toISOString() }));
    expect(await withWeekLock(W, async () => 'ran')).toBe('ran');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('releases the lock when fn throws', async () => {
    await expect(withWeekLock(W, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(await withWeekLock(W, () => 2)).toBe(2);
  });
});
