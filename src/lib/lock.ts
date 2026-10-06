import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Takes weeks/<W>/.lock ({pid, at}) or throws if a live process holds it. A lock left by a dead pid is taken over.
 * Returns the release function.
 */
export function acquireWeekLock(week: string): () => void {
  const file = path.join(paths.weekDir(week), '.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 1) throw e;
      let pid = 0;
      try { pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid); } catch { /* unreadable: treat as stale */ }
      if (alive(pid)) throw new Error(`Week ${week} is busy (a push or distribute is running).`);
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    let released = false;
    return () => { if (!released) { released = true; fs.rmSync(file, { force: true }); } };
  }
}

/** Runs fn while holding the week's lock, always releasing it. */
export async function withWeekLock<T>(week: string, fn: () => T | Promise<T>): Promise<T> {
  const release = acquireWeekLock(week);
  try { return await fn(); } finally { release(); }
}
