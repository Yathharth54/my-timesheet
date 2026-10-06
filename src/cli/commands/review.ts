import { execFile } from 'node:child_process';
import { requireConfig } from '../../lib/store.js';
import { resolveWeek } from '../../lib/week.js';
import { startServer } from '../../server/server.js';
import { ok } from '../out.js';

export async function review(weekArg?: string, open = true): Promise<void> {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  let s;
  try {
    s = await startServer(config.port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    s = { url: `http://127.0.0.1:${config.port}` };
    ok(`Review UI already running`);
  }
  const url = `${s.url}/?week=${week}`;
  ok(`Review ${week} at ${url}  (Ctrl+C to stop)`);
  if (open) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}
