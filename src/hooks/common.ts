import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from '../lib/paths.js';

export const hooksDisabled = (): boolean => process.env.TIMESHEET_DISABLE_HOOKS === '1';

export function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export function logHookError(hook: string, e: unknown): void {
  try {
    fs.mkdirSync(path.dirname(paths.hookErrors()), { recursive: true });
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    fs.appendFileSync(paths.hookErrors(), `${new Date().toISOString()} ${hook} ${msg}\n`);
  } catch { /* never throw from a hook */ }
}

export function isMain(metaUrl: string): boolean {
  try {
    return !!process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === metaUrl;
  } catch {
    return false;
  }
}
