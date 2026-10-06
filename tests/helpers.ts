import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, Draft, Item } from '../src/lib/types.js';

export function tmpDir(prefix = 'ts-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function tmpHome(): string {
  const dir = tmpDir('ts-home-');
  process.env.TIMESHEET_HOME = dir;
  process.env.TIMESHEET_CLAUDE_DIR = path.join(dir, 'claude');
  process.env.TIMESHEET_SECRETS_FILE = path.join(dir, 'secrets.json');
  return dir;
}

export function testConfig(o: Partial<Config> = {}): Config {
  return {
    version: 1,
    linear: { assigneeId: 'user-1', assigneeEmail: 'me@x.ai' },
    everhour: { userId: 42 },
    projects: [
      { id: 'proj-box', name: 'Boxsy', teamId: 'team-box', kind: 'billable', stateId: 'state-box', labelIds: [] },
      { id: 'proj-int', name: 'Dev - Internal', teamId: 'team-the', kind: 'internal', stateId: 'state-the', labelIds: [] },
    ],
    internalProject: 'Dev - Internal',
    workOrgs: ['TheAgenticAI'],
    gitEmails: ['me@x.ai'],
    nudge: false,
    port: 4747,
    ...o,
  };
}

let seq = 0;
export function makeItem(o: Partial<Item> = {}): Item {
  return {
    id: o.id ?? `i${++seq}`,
    title: 'Some task',
    description: 'Did a technical thing. It worked.',
    project: 'Boxsy',
    bucketReason: 'client feature',
    day: '2026-10-05',
    evidence: { commits: [], sessions: [], manual: false },
    weight: 1,
    weightReason: null,
    hours: null,
    locked: false,
    edited: false,
    deleted: false,
    linear: null,
    everhour: null,
    ...o,
  };
}

export function makeDraft(o: Partial<Draft> = {}): Draft {
  return {
    week: '2026-W41',
    rev: 1,
    totalHours: null,
    days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
    weightsSource: null,
    pushed: false,
    items: [],
    parents: [],
    ...o,
  };
}
