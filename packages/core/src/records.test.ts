import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLog } from './records.js';

async function waitForAuditFile(file: string, minimumEntries = 1, attempts = 50): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const contents = await fs.readFile(file, 'utf8');
      if (contents.endsWith('\n') && contents.trimEnd().split('\n').length >= minimumEntries) return contents;
    } catch {
      // record() creates the data directory and appends asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Audit JSONL did not become readable: ${file}`);
}

test('AuditLog redacts credentials before JSONL persistence and list exposure', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-audit-redaction-'));
  const file = path.join(dataDir, 'audit.jsonl');
  const audit = new AuditLog(dataDir);
  const secrets = [
    'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    'ghp_1234567890ABCDEFGHIJKL',
    'github_pat_abcdefghijklmnopqrstuvwxyz1234',
    'xoxb-123456789012-abcdefghijklmnop',
    'AIza1234567890abcdefghijklmnopqrst',
    'hf_abcdefghijk123456789012',
    'npm_abcd123456789012345678',
    'pypi-abcdefghijklmnopqrstuvwxyz123456',
    'rk_live_12345678901234567890',
    'AKIA1234567890ABCDEF',
    'ASIA1234567890ABCDEF',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'opaque-json-api-key',
    'opaque-json-password',
    'opaque-access-token',
    'opaque-bearer-value',
    'opaque-basic-value',
    'opaque-url-password',
    'opaque-task-token',
  ];

  try {
    audit.record({
      kind: 'settings',
      action: `provider.configure ${secrets[0]}`,
      detail: `provider settings {"apiKey":"${secrets[13]}","password":"${secrets[14]}"}; Authorization: Bearer ${secrets[16]}; Basic ${secrets[17]}; https://audit-user:${secrets[18]}@example.test/mcp?access_token=${secrets[15]}&mode=read`,
      taskId: `task token=${secrets[19]}`,
    });
    audit.record({
      kind: 'secret',
      action: 'credential formats inspected',
      detail: `Anthropic ${secrets[1]} GitHub ${secrets[2]} ${secrets[3]} Slack ${secrets[4]} Google ${secrets[5]} HuggingFace ${secrets[6]} npm ${secrets[7]} PyPI ${secrets[8]} Stripe ${secrets[9]} AWS ${secrets[10]} ${secrets[11]} JWT ${secrets[12]}`,
    });

    const raw = await waitForAuditFile(file, 2);
    const records = raw.trimEnd().split('\n').map((line) => JSON.parse(line) as { action: string; detail?: string; taskId?: string });
    const listed = audit.list();
    const exposed = `${raw}\n${JSON.stringify(records)}\n${JSON.stringify(listed)}`;
    for (const secret of secrets) assert.equal(exposed.includes(secret), false, `secret was exposed: ${secret}`);

    assert.equal(records.length, 2);
    assert.match(records[0].action, /provider\.configure/);
    assert.match(records[0].detail ?? '', /provider settings/);
    assert.match(records[0].detail ?? '', /example\.test\/mcp/);
    assert.match(records[0].detail ?? '', /mode=read/);
    assert.match(records[0].detail ?? '', /"apiKey":"\[REDACTED\]"/);
    assert.equal(listed.length, 2);
    assert.match(listed[1].taskId ?? '', /task token=\[REDACTED\]/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('AuditLog.load and list redact older JSONL records before returning them', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-audit-legacy-'));
  const file = path.join(dataDir, 'audit.jsonl');
  const legacySecret = 'old-access-token-secret-value';
  try {
    await fs.writeFile(file, `${JSON.stringify({
      t: 123,
      kind: 'settings',
      action: 'mcp.connect',
      detail: `https://user:old-url-password@example.test/mcp?access_token=${legacySecret}`,
      taskId: `task apiKey=${legacySecret}`,
    })}\n`, 'utf8');

    const audit = new AuditLog(dataDir);
    await audit.load();
    const entries = audit.list();
    assert.equal(entries.length, 1);
    assert.match(entries[0].detail ?? '', /example\.test\/mcp/);
    assert.match(entries[0].detail ?? '', /access_token=\[REDACTED\]/);
    assert.equal(JSON.stringify(entries).includes(legacySecret), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
