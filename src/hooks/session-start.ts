import fs from 'node:fs';
import { classify, realGit, setRepo, type GitProbe } from '../lib/repo.js';
import { loadConfig, loadDraft, loadRepos } from '../lib/store.js';
import { paths } from '../lib/paths.js';
import { isoWeek, shiftWeek } from '../lib/week.js';
import type { Config } from '../lib/types.js';
import { hooksDisabled, isMain, logHookError, readStdin } from './common.js';

const billable = (c: Config) => c.projects.filter(p => p.kind === 'billable').map(p => p.name).join(', ');

function askClass(root: string, slug: string | null, c: Config): string {
  return [
    `my-timesheet: this folder (${root}${slug ? ` — ${slug}` : ''}) is not classified yet, so no work is being logged here.`,
    `Early in this session, at a natural moment, ask the user once: is this Work, Personal, or Ignore?`,
    `If Work, also ask which billable project it belongs to (${billable(c)}).`,
    `Then run: timesheet repo <work|personal|ignore> --path "${root}" [--project "<name>"]. Do not bring it up again.`,
  ].join(' ');
}

function askProject(root: string, name: string, c: Config): string {
  return `my-timesheet: ${name} is a work repo but has no billable project yet. Ask the user once which project it bills to (${billable(c)}), then run: timesheet repo work --path "${root}" --project "<name>".`;
}

function nudge(c: Config, now: Date): string | null {
  if (!c.nudge) return null;
  const dow = now.getDay();
  const isSundayEvening = dow === 0 && now.getHours() >= 18;
  const isMonday = dow === 1;
  if (!isSundayEvening && !isMonday) return null;
  const week = isMonday ? shiftWeek(isoWeek(now), -1) : isoWeek(now);
  if (!fs.existsSync(paths.log(week))) return null;
  if (loadDraft(week)?.pushed) return null;
  return `my-timesheet: the timesheet for ${week} hasn't been pushed. Mention once, briefly, that the user can run /timesheet${isMonday ? ' last' : ''}.`;
}

export function sessionStartContext(input: { cwd: string }, deps: { now: Date; git: GitProbe }): string | null {
  if (hooksDisabled()) return null;
  const config = loadConfig();
  if (!config) return null;
  const c = classify(input.cwd, loadRepos(), config.workOrgs, deps.git);
  const lines: string[] = [];
  if (c.kind === 'org') {
    setRepo(c.root, c.entry);
    lines.push(askProject(c.root, c.entry.name ?? c.root, config));
  } else if (c.kind === 'unknown') {
    lines.push(askClass(c.root, c.slug, config));
  } else if (c.entry.class === 'work' && !c.entry.project) {
    lines.push(askProject(c.root, c.entry.name ?? c.root, config));
  }
  const n = nudge(config, deps.now);
  if (n) lines.push(n);
  return lines.length ? lines.join('\n\n') : null;
}

async function main(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as { cwd: string };
    const ctx = sessionStartContext(input, { now: new Date(), git: realGit });
    if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
  } catch (e) {
    logHookError('session-start', e);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) void main();
