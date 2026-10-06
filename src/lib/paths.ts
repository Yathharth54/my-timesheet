import os from 'node:os';
import path from 'node:path';

export function home(): string {
  return process.env.TIMESHEET_HOME ?? path.join(os.homedir(), '.timesheet');
}

export const paths = {
  config: () => path.join(home(), 'config.json'),
  repos: () => path.join(home(), 'repos.json'),
  examples: () => path.join(home(), 'examples.jsonl'),
  hookErrors: () => path.join(home(), 'hook-errors.log'),
  secrets: () => process.env.TIMESHEET_SECRETS_FILE ?? path.join(home(), 'secrets.json'),
  log: (week: string) => path.join(home(), 'log', `${week}.jsonl`),
  weeksDir: () => path.join(home(), 'weeks'),
  weekDir: (week: string) => path.join(home(), 'weeks', week),
  draft: (week: string) => path.join(home(), 'weeks', week, 'draft.json'),
  context: (week: string) => path.join(home(), 'weeks', week, 'context.json'),
  proposal: (week: string) => path.join(home(), 'weeks', week, 'proposal.json'),
  evidence: (week: string) => path.join(home(), 'weeks', week, 'evidence.json'),
};
