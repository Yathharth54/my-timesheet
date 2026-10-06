import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { tmpHome } from './helpers.js';
import { secretStore, setExecForTests } from '../src/lib/keychain.js';
import { paths } from '../src/lib/paths.js';

describe('secretStore (file backend)', () => {
  beforeEach(() => { tmpHome(); });
  it('stores secrets in a 0600 file', () => {
    const s = secretStore();
    expect(s.get('linear')).toBeNull();
    s.set('linear', 'lin_api_123');
    expect(s.get('linear')).toBe('lin_api_123');
    expect(fs.statSync(paths.secrets()).mode & 0o777).toBe(0o600);
    s.remove('linear');
    expect(s.get('linear')).toBeNull();
  });
});

describe('secretStore (keychain backend error handling)', () => {
  const originalSecretsFile = process.env.TIMESHEET_SECRETS_FILE;

  beforeEach(() => {
    tmpHome();
    // Temporarily unset TIMESHEET_SECRETS_FILE to use keychain backend in test
    delete process.env.TIMESHEET_SECRETS_FILE;
  });

  afterEach(() => {
    // Restore original env and reset to real execFileSync
    if (originalSecretsFile) process.env.TIMESHEET_SECRETS_FILE = originalSecretsFile;
    const { execFileSync } = require('node:child_process');
    setExecForTests(execFileSync);
  });

  it('never surfaces secret in Keychain error messages', () => {
    const secret = 'lin_super_secret_12345';
    const fakeExec = () => {
      throw new Error(`Command failed: security add-generic-password ... -w ${secret} ...`);
    };
    setExecForTests(fakeExec as any);

    const s = secretStore();
    expect(() => s.set('linear', secret)).toThrow(/Could not save the linear key to the macOS Keychain/);
    expect(() => s.set('linear', secret)).not.toThrow(new RegExp(secret));
  });
});
