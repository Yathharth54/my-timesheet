import fs from 'node:fs';
import { home } from '../../lib/paths.js';
import { uninstallHooks, uninstallSkillFiles } from '../../lib/install.js';
import { secretStore } from '../../lib/keychain.js';
import { ok } from '../out.js';

export function uninstall(purge: boolean): void {
  uninstallHooks();
  uninstallSkillFiles();
  ok('Removed hooks, skill and /timesheet command');
  if (purge) {
    secretStore().remove('linear');
    secretStore().remove('everhour');
    fs.rmSync(home(), { recursive: true, force: true });
    ok(`Deleted ${home()} and stored keys`);
  }
}
