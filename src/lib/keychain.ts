import os from 'node:os';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { paths } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

export type SecretName = 'linear' | 'everhour';
export interface SecretStore { get(n: SecretName): string | null; set(n: SecretName, v: string): void; remove(n: SecretName): void }

const service = (n: SecretName) => `my-timesheet.${n}`;
const account = () => os.userInfo().username;

// Seam for test injection to verify secrets are never exposed in error messages
let execForTests = nodeExecFileSync;
export function setExecForTests(fn: typeof nodeExecFileSync) { execForTests = fn; }

const keychain: SecretStore = {
  get(n) {
    try {
      return execForTests('security', ['find-generic-password', '-s', service(n), '-a', account(), '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  },
  set(n, v) {
    try {
      // Note: Passing the secret via argv ('-w', v) is a brief exposure accepted by the controller.
      // It is not in the error output or on-disk (security does not log it); the risk is limited to
      // process listing during the syscall. We do not pass it via stdin to avoid side effects.
      execForTests('security', ['add-generic-password', '-U', '-s', service(n), '-a', account(), '-w', v], { stdio: 'ignore' });
    } catch {
      throw new Error(`Could not save the ${n} key to the macOS Keychain.`);
    }
  },
  remove(n) {
    try { execForTests('security', ['delete-generic-password', '-s', service(n), '-a', account()], { stdio: 'ignore' }); } catch { /* absent */ }
  },
};

const file: SecretStore = {
  get: n => readJson<Record<string, string>>(paths.secrets(), {})[n] ?? null,
  set(n, v) {
    const all = readJson<Record<string, string>>(paths.secrets(), {});
    all[n] = v;
    writeJsonAtomic(paths.secrets(), all, 0o600);
  },
  remove(n) {
    const all = readJson<Record<string, string>>(paths.secrets(), {});
    delete all[n];
    writeJsonAtomic(paths.secrets(), all, 0o600);
  },
};

export function secretStore(): SecretStore {
  return process.platform === 'darwin' && !process.env.TIMESHEET_SECRETS_FILE ? keychain : file;
}
