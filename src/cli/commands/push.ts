import readline from 'node:readline/promises';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadDraft, requireConfig, saveDraft } from '../../lib/store.js';
import { resolveWeek, weekDays } from '../../lib/week.js';
import { secretStore } from '../../lib/keychain.js';
import { Linear } from '../../lib/linear.js';
import { Everhour } from '../../lib/everhour.js';
import { push, type PushEvent } from '../../lib/push.js';
import { fail, ok, step, weekSummary } from '../out.js';

export function clientsFromSecrets() {
  const s = secretStore();
  const lk = s.get('linear');
  const ek = s.get('everhour');
  if (!lk || !ek) throw new Error('API keys missing. Run: timesheet init');
  return { linear: new Linear(lk), everhour: new Everhour(ek) };
}

const LABEL: Record<PushEvent['phase'], string> = { parents: 'Linear parents', issues: 'Linear sub-issues', sync: 'Everhour tasks', time: 'Logging time' };

export async function pushCmd(weekArg?: string): Promise<void> {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  const draft = loadDraft(week);
  if (!draft) throw new Error(`No draft for ${week}. Run /timesheet in Claude first.`);
  const { linear, everhour } = clientsFromSecrets();
  const days = weekDays(week);
  const already = (await everhour.userSeconds(config.everhour.userId, days[0], days[6])) / 3600;
  if (already > 0 && !draft.pushed) {
    const go = await p.confirm({ message: `Everhour already has ${already.toFixed(1)}h for you in ${week}. Push anyway?`, initialValue: false });
    if (p.isCancel(go) || !go) return;
  }
  for (;;) {
    let update: (s: string) => void = () => {};
    let current: PushEvent['phase'] | null = null;
    const result = await step('Pushing', async u => {
      update = u;
      return push(draft, {
        linear, everhour, config, save: saveDraft,
        onProgress: e => { if (e.phase !== current) current = e.phase; update(`${LABEL[e.phase]} ${e.done}/${e.total}`); },
      });
    }, r => (r.status === 'done' ? `Pushed ${r.issues} sub-issues, ${r.hours.toFixed(1)}h` : `Paused: ${r.status.replace('_', ' ')}`));
    if (result.status === 'blocked') {
      for (const w of result.warnings) fail(w.message);
      throw new Error('Fix these in: timesheet review');
    }
    if (result.status === 'awaiting_sync') {
      console.log(`${pc.yellow('!')} ${result.missing.length} issues aren't in Everhour yet:`);
      for (const m of result.missing.slice(0, 8)) console.log(`   ${m.identifier}  ${pc.dim(m.project)}`);
      const projects = [...new Set(result.missing.map(m => m.project))].join(', ');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(`  Open Everhour → Projects → ${projects} → Sync, then press Enter `);
      rl.close();
      continue;
    }
    ok(weekSummary(draft));
    return;
  }
}
