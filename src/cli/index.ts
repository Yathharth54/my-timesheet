#!/usr/bin/env node
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { fail } from './out.js';

const HELP = `timesheet — turn your week into Linear issues + Everhour time

  timesheet init                       set up keys, projects, orgs and hooks
  timesheet review [--week W]          open the review UI (default: this week)
  timesheet push [--week W]            push the week to Linear and Everhour
  timesheet status [--week W]          one-line summary of a week
  timesheet repo <work|personal|ignore> [--path P] [--project NAME]
  timesheet doctor                     check keys, hooks and tools
  timesheet uninstall [--purge]        remove hooks and command (--purge: data too)

  internal (used by /timesheet):
  timesheet prepare [--week W]         build context.json for Claude
  timesheet ingest [--week W]          merge proposal.json into the draft

  W = this | last | YYYY-Www`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      week: { type: 'string' },
      path: { type: 'string' },
      project: { type: 'string' },
      purge: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) { console.log(HELP); return; }
  switch (cmd) {
    case 'init': return (await import('./commands/init.js')).init();
    case 'repo': return (await import('./commands/repo.js')).repo(rest, values);
    case 'prepare': return (await import('./commands/prepare.js')).prepareCmd(values.week);
    case 'ingest': return (await import('./commands/ingest.js')).ingestCmd(values.week);
    case 'status': return (await import('./commands/status.js')).status(values.week);
    case 'review': return (await import('./commands/review.js')).review(values.week, !values['no-open']);
    case 'push': return (await import('./commands/push.js')).pushCmd(values.week);
    case 'doctor': return (await import('./commands/doctor.js')).doctor();
    case 'uninstall': return (await import('./commands/uninstall.js')).uninstall(!!values.purge);
    default: throw new Error(`Unknown command "${cmd}". Run: timesheet --help`);
  }
}

main().catch(e => {
  fail((e as Error).message);
  if (process.env.TIMESHEET_DEBUG) console.error(pc.dim((e as Error).stack ?? ''));
  process.exit(1);
});
