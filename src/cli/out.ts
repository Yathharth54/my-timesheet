import pc from 'picocolors';
import type { Draft } from '../lib/types.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export async function step<T>(label: string, fn: (update: (suffix: string) => void) => Promise<T>, done?: (r: T) => string): Promise<T> {
  const tty = !!process.stdout.isTTY;
  const start = performance.now();
  let suffix = '';
  let f = 0;
  const timer = tty
    ? setInterval(() => process.stdout.write(`\r${pc.cyan(FRAMES[f++ % FRAMES.length])} ${label} ${pc.dim(suffix)}\x1b[K`), 80)
    : null;
  const clear = () => { if (timer) clearInterval(timer); if (tty) process.stdout.write('\r\x1b[K'); };
  try {
    const r = await fn(s => { suffix = s; });
    clear();
    process.stdout.write(`${done ? done(r) : label} ${pc.dim(fmtMs(performance.now() - start))}\n`);
    return r;
  } catch (e) {
    clear();
    process.stdout.write(`${pc.red('✗')} ${label}\n`);
    throw e;
  }
}

export const added = (what: string, where: string): void => console.log(` ${pc.green('+')} ${what.padEnd(14)} ${pc.dim(where)}`);
export const ok = (msg: string): void => console.log(` ${pc.green('✓')} ${msg}`);
export const fail = (msg: string): void => console.error(`${pc.red('✗')} ${msg}`);

export function weekSummary(d: Draft): string {
  const live = d.items.filter(i => !i.deleted);
  const total = live.reduce((s, i) => s + (i.hours ?? 0), 0);
  const byProject = new Map<string, number>();
  for (const i of live) byProject.set(i.project ?? 'unassigned', (byProject.get(i.project ?? 'unassigned') ?? 0) + (i.hours ?? 0));
  const parts = [...byProject].map(([p, h]) => `${p.toLowerCase()} ${h.toFixed(1)}`);
  return [d.week, `${total.toFixed(1)}h`, ...parts, `${live.length} items`, d.pushed ? 'pushed' : 'not pushed'].join(' · ');
}
