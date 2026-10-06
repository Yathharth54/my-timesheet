import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Linear } from '../../lib/linear.js';
import { Everhour } from '../../lib/everhour.js';
import { secretStore } from '../../lib/keychain.js';
import { loadConfig, saveConfig } from '../../lib/store.js';
import { installHooks, installSkillFiles, packageRoot } from '../../lib/install.js';
import type { Config, ProjectConfig } from '../../lib/types.js';
import { added, step } from '../out.js';

const bail = <T>(v: T): Exclude<T, symbol> => {
  if (p.isCancel(v)) { p.cancel('Cancelled'); process.exit(1); }
  return v as Exclude<T, symbol>;
};

/** `my-timesheet@<version>` of the package at pkgRoot, so init installs exactly the version that is running. */
export function installSpec(pkgRoot: string): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as { version: string };
  return `my-timesheet@${version}`;
}

function stablePackageRoot(): string {
  const here = packageRoot();
  if (!here.includes(`${path.sep}_npx${path.sep}`)) return here;
  execFileSync('npm', ['install', '-g', installSpec(here)], { stdio: 'inherit' });
  return path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'my-timesheet');
}

export async function init(): Promise<void> {
  p.intro(pc.inverse(' my-timesheet '));
  const prev = loadConfig();
  const pkgRoot = await step('Installing timesheet', async () => stablePackageRoot(), r => `${pc.green('◇')} Installed  ${pc.dim(r)}`);

  const linearKey = bail(await p.password({ message: 'Linear personal API key (Linear → Settings → Security & access → API keys)' }));
  const linear = new Linear(linearKey);
  const me = await step('Linear', () => linear.viewer(), v => `${pc.green('◇')} Linear  ✓ ${v.email}`);
  const all = await linear.projects();
  const chosenIds = bail(await p.multiselect({
    message: 'Which projects do you log time to?',
    options: all.map(pr => ({ value: pr.id, label: pr.name, hint: pr.teams.map(t => t.key).join(',') })),
    initialValues: prev?.projects.map(x => x.id) ?? [],
    required: true,
  })) as string[];
  const chosen = all.filter(pr => chosenIds.includes(pr.id));
  const internalId = bail(await p.select({
    message: 'Which one is internal (not billable)?',
    options: chosen.map(pr => ({ value: pr.id, label: pr.name })),
    initialValue: chosen.find(pr => /internal/i.test(pr.name))?.id,
  })) as string;
  const statusName = bail(await p.text({ message: 'Status for created issues', initialValue: 'Done' }));
  const projects: ProjectConfig[] = [];
  for (const pr of chosen) {
    const team = pr.teams[0];
    if (!team) throw new Error(`Project ${pr.name} has no team.`);
    const states = await linear.states(team.id);
    const st = states.find(s => s.name.toLowerCase() === statusName.toLowerCase());
    if (!st) throw new Error(`Team ${team.name} has no status "${statusName}". Available: ${states.map(s => s.name).join(', ')}`);
    projects.push({ id: pr.id, name: pr.name, teamId: team.id, kind: pr.id === internalId ? 'internal' : 'billable', stateId: st.id, labelIds: [] });
  }

  const everhourKey = bail(await p.password({ message: 'Everhour API key (Everhour → Settings → Profile → API)' }));
  const eh = await step('Everhour', () => new Everhour(everhourKey).me(), v => `${pc.green('◇')} Everhour  ✓ user ${v.id}${v.linearConnected ? ' · linear integration active' : pc.yellow(' · Linear integration not detected')}`);

  let orgs: string[] = [];
  try { orgs = execFileSync('gh', ['api', 'user/orgs', '--jq', '.[].login'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* gh missing */ }
  const workOrgs = orgs.length
    ? bail(await p.multiselect({ message: 'Which GitHub orgs are work?', options: orgs.map(o => ({ value: o, label: o })), initialValues: prev?.workOrgs ?? [], required: false })) as string[]
    : bail(await p.text({ message: 'Work GitHub orgs (comma-separated)', initialValue: prev?.workOrgs.join(',') ?? '' })).split(',').map(s => s.trim()).filter(Boolean);

  const nudge = bail(await p.confirm({ message: 'Remind you on Sunday evening if the week is not pushed?', initialValue: prev?.nudge ?? false }));

  let gitEmail = '';
  try { gitEmail = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim(); } catch { /* none */ }

  const config: Config = {
    version: 1,
    linear: { assigneeId: me.id, assigneeEmail: me.email },
    everhour: { userId: eh.id },
    projects,
    internalProject: projects.find(x => x.kind === 'internal')!.name,
    workOrgs,
    gitEmails: [...new Set([gitEmail, me.email].filter(Boolean))],
    nudge,
    port: prev?.port ?? 4747,
  };
  const secrets = secretStore();
  secrets.set('linear', linearKey);
  secrets.set('everhour', everhourKey);
  saveConfig(config);

  const t0 = performance.now();
  installHooks(pkgRoot);
  const files = installSkillFiles(pkgRoot);
  console.log(`Installed 2 hooks, 1 skill, 1 command in ${Math.round(performance.now() - t0)}ms`);
  added('SessionStart', '~/.claude/settings.json');
  added('Stop', '~/.claude/settings.json');
  for (const f of files) added(path.basename(path.dirname(f)) === 'commands' ? '/timesheet' : 'skill', f);
  p.outro('Ready. Work as usual; on Sunday run /timesheet in Claude.');
}
