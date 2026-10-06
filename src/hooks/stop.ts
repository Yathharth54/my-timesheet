import { classify, realGit, type GitProbe } from '../lib/repo.js';
import { appendLine, loadConfig, loadRepos } from '../lib/store.js';
import { paths } from '../lib/paths.js';
import { isoWeek } from '../lib/week.js';
import type { LogEntry } from '../lib/types.js';
import { hooksDisabled, isMain, logHookError, readStdin } from './common.js';

export function recordTurn(
  input: { cwd: string; session_id: string; transcript_path: string },
  deps: { now: Date; git: GitProbe },
): boolean {
  if (hooksDisabled()) return false;
  const config = loadConfig();
  if (!config) return false;
  const c = classify(input.cwd, loadRepos(), config.workOrgs, deps.git);
  if (c.kind === 'unknown' || c.entry.class !== 'work') return false;
  const entry: LogEntry = {
    t: deps.now.toISOString(),
    session: input.session_id,
    root: c.root,
    repo: c.entry.name ?? c.root,
    project: c.entry.project ?? null,
    transcript: input.transcript_path,
  };
  appendLine(paths.log(isoWeek(deps.now)), entry);
  return true;
}

async function main(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin());
    recordTurn(input, { now: new Date(), git: realGit });
  } catch (e) {
    logHookError('stop', e);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) void main();
