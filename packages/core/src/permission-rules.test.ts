import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { matchRules, ruleForAlways } from './permission-rules.js';

test('Permission rules: tool wildcards, glob patterns, deny wins', () => {
  const rules = [
    { tool: 'terminal.run', pattern: 'git *', decision: 'allow' },
    { tool: 'terminal.run', pattern: 'git push *', decision: 'deny' },
    { tool: 'fs.*', pattern: '*.env', decision: 'deny' },
    { tool: 'mcp.github.*', pattern: '*', decision: 'allow' },
  ];
  assert.equal(matchRules(rules, 'terminal.run', { command: 'git status' }), 'allow');
  assert.equal(matchRules(rules, 'terminal.run', { command: 'git push origin main' }), 'deny');
  assert.equal(matchRules(rules, 'terminal.run', { command: 'rm -rf x' }), undefined);
  assert.equal(matchRules(rules, 'fs.write', { path: 'config/.ENV' }), 'deny');
  assert.equal(matchRules(rules, 'mcp.github.create_issue', {}), 'allow');
  assert.equal(matchRules('broken', 'terminal.run', {}), undefined);
  assert.deepEqual(ruleForAlways('terminal.run', { command: '  npm run build' }), { tool: 'terminal.run', pattern: 'npm *', decision: 'allow' });
});
