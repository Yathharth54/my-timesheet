import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './store.js';

export const HOOK_MARKER = '# my-timesheet';

export const claudeDir = (): string => process.env.TIMESHEET_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
const settingsFile = () => path.join(claudeDir(), 'settings.json');

/** dist/lib/install.js → package root */
export const packageRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const hookCommand = (pkgRoot: string, name: 'session-start' | 'stop'): string =>
  `node "${path.join(pkgRoot, 'dist', 'hooks', `${name}.js`)}" ${HOOK_MARKER}`;

type HookEntry = { type?: string; command?: string; timeout?: number };
type Group = { matcher?: string; hooks?: HookEntry[] };
const isOurs = (h: HookEntry) => typeof h.command === 'string' && h.command.endsWith(HOOK_MARKER);

function stripOurs(groups: Group[] = []): Group[] {
  return groups
    .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !isOurs(h)) }))
    .filter(g => (g.hooks ?? []).length > 0);
}

export function installHooks(pkgRoot: string): void {
  const s = readJson<Record<string, any>>(settingsFile(), {});
  s.hooks ??= {};
  for (const [event, name] of [['SessionStart', 'session-start'], ['Stop', 'stop']] as const) {
    const groups = stripOurs(s.hooks[event]);
    groups.push({ hooks: [{ type: 'command', command: hookCommand(pkgRoot, name), timeout: 5 }] });
    s.hooks[event] = groups;
  }
  writeJsonAtomic(settingsFile(), s);
}

export function uninstallHooks(): void {
  const s = readJson<Record<string, any>>(settingsFile(), {});
  if (!s.hooks) return;
  for (const event of ['SessionStart', 'Stop']) {
    const groups = stripOurs(s.hooks[event]);
    if (groups.length) s.hooks[event] = groups;
    else delete s.hooks[event];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  writeJsonAtomic(settingsFile(), s);
}

export function hooksInstalled(): boolean {
  const s = readJson<Record<string, any>>(settingsFile(), {});
  return ['SessionStart', 'Stop'].every(e => (s.hooks?.[e] ?? []).some((g: Group) => (g.hooks ?? []).some(isOurs)));
}

const skillTargets = (pkgRoot: string): [string, string][] => [
  [path.join(pkgRoot, 'skill', 'SKILL.md'), path.join(claudeDir(), 'skills', 'timesheet', 'SKILL.md')],
  [path.join(pkgRoot, 'skill', 'commands', 'timesheet.md'), path.join(claudeDir(), 'commands', 'timesheet.md')],
];

export function installSkillFiles(pkgRoot: string): string[] {
  for (const [src, dst] of skillTargets(pkgRoot)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return skillTargets(pkgRoot).map(([, dst]) => dst);
}

export function uninstallSkillFiles(): void {
  fs.rmSync(path.join(claudeDir(), 'skills', 'timesheet'), { recursive: true, force: true });
  fs.rmSync(path.join(claudeDir(), 'commands', 'timesheet.md'), { force: true });
}
