import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../../lib/store.js';
import { secretStore } from '../../lib/keychain.js';
import { claudeDir, hooksInstalled } from '../../lib/install.js';
import { Linear } from '../../lib/linear.js';
import { Everhour } from '../../lib/everhour.js';

const line = (good: boolean, msg: string) => console.log(` ${good ? pc.green('✓') : pc.red('✗')} ${msg}`);
const has = (cmd: string) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

export async function doctor(): Promise<void> {
  const config = loadConfig();
  line(!!config, config ? 'config found' : 'no config, run: timesheet init');
  const s = secretStore();
  const lk = s.get('linear');
  const ek = s.get('everhour');
  try { const v = lk ? await new Linear(lk).viewer() : null; line(!!v, v ? `Linear key works (${v.email})` : 'Linear key missing'); }
  catch (e) { line(false, `Linear key rejected: ${(e as Error).message}`); }
  try { const v = ek ? await new Everhour(ek).me() : null; line(!!v && v.linearConnected, v ? `Everhour key works (user ${v.id})${v.linearConnected ? '' : ', Linear integration not detected'}` : 'Everhour key missing'); }
  catch (e) { line(false, `Everhour key rejected: ${(e as Error).message}`); }
  line(hooksInstalled(), 'hooks installed in ~/.claude/settings.json');
  line(fs.existsSync(path.join(claudeDir(), 'commands', 'timesheet.md')), '/timesheet command installed');
  line(has('claude'), 'claude CLI available (for weights)');
  line(has('gh'), 'gh CLI available (for work orgs)');
}
