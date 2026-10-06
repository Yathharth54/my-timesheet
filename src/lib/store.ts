import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { weekDays } from './week.js';
import type { Config, Draft, Repos } from './types.js';

export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
}

export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

export function appendLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip corrupt line */ }
  }
  return out;
}

export const loadConfig = (): Config | null => readJson<Config | null>(paths.config(), null);
export function requireConfig(): Config {
  const c = loadConfig();
  if (!c) throw new Error('my-timesheet is not set up yet. Run: timesheet init');
  return c;
}
export const saveConfig = (c: Config): void => writeJsonAtomic(paths.config(), c);
export const loadRepos = (): Repos => readJson<Repos>(paths.repos(), {});
export const saveRepos = (r: Repos): void => writeJsonAtomic(paths.repos(), r);

export function emptyDraft(week: string): Draft {
  return { week, rev: 0, totalHours: null, days: weekDays(week).slice(0, 5), weightsSource: null, pushed: false, items: [], parents: [] };
}
export const loadDraft = (week: string): Draft | null => readJson<Draft | null>(paths.draft(week), null);
export function saveDraft(d: Draft): Draft {
  d.rev += 1;
  writeJsonAtomic(paths.draft(d.week), d);
  return d;
}

export function listWeeks(): string[] {
  try {
    return fs.readdirSync(paths.weeksDir()).filter(w => /^\d{4}-W\d{2}$/.test(w)).sort().reverse();
  } catch {
    return [];
  }
}
