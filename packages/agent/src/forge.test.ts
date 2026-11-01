import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@mazz/shared';
import type { IModelProvider } from '@mazz/providers';
import { ToolRegistry } from '@mazz/tools';
import {
  ForgeRunner, extractC, extractPython, extractStep, leadOf, matchBlueprint, pieceAcceptable,
  diagnostic, repairDetail, stepGrammar, unitKind, validateBlueprint, type ForgeBlueprint,
} from './forge.js';
import { ExperienceStore, experienceKey } from './forge-experience.js';

test('extractC keeps one statement, a whole block, an if/else pair, or only the opening of a block', () => {
  assert.equal(extractC('crc ^= data[i];\n    return crc;'), 'crc ^= data[i];');
  assert.equal(extractC('for (int k = 0; k < 8; k++) {\n  crc >>= 1;\n}\nreturn crc;'), 'for (int k = 0; k < 8; k++) {\n  crc >>= 1;\n}');
  assert.equal(extractC('if (bit) {\n a();\n} else {\n b();\n}\nc();'), 'if (bit) {\n a();\n} else {\n b();\n}');
  assert.equal(extractC('for (size_t i = 0; i < n; i++) {\n crc ^= d[i];', true), 'for (size_t i = 0; i < n; i++) {');
  assert.equal(extractC('x = "a;b";'), 'x = "a;b";');
  assert.equal(extractC('crc = crc'), '', 'an unterminated statement is not code');
  assert.equal(extractC('double a[3] = {1.0, 2.0, 3.0};\n\n    double b[3];'), 'double a[3] = {1.0, 2.0, 3.0};', 'a brace initializer keeps its semicolon');
  const unit = { lang: 'c' } as never;
  assert.equal(leadOf(unit, { text: 'call vm_matmul(m1, eye, out, 2, 2, 2)' }), 'vm_matmul(', 'a call step starts with the call itself');
  assert.equal(leadOf(unit, { text: 'call `_LIB.f(x)`' }), undefined);
});

test('extractPython takes a statement with its bracket continuation, or a block header with its deeper lines', () => {
  assert.equal(extractPython('lib = f(a,\n          b)\n    return lib', '    '), 'lib = f(a,\n          b)');
  assert.equal(extractPython('if not chunk:\n            break\n        crc = 1', '        '), 'if not chunk:\n            break');
  assert.equal(extractPython('with open(p) as f:\n        x = 1', '    ', true), 'with open(p) as f:');
  assert.equal(extractPython('x = 1', '    ', true), '', 'an opening step must produce a block header');
});

test('extractStep extends to the next statement only when the first misses the anchors', () => {
  const step = { text: 'assert with `self.assertEqual` that f() is 0' };
  const out = "expected = f()\n        self.assertEqual(expected, 0)\n        junk()";
  assert.equal(extractStep('python', out, '        ', step), "expected = f()\n        self.assertEqual(expected, 0)");
  assert.equal(extractStep('python', 'self.assertEqual(f(), 0)\n        junk()', '        ', step), 'self.assertEqual(f(), 0)');
});

test('anchors: backtick names, explicit patterns and return steps are enforced', () => {
  assert.ok(pieceAcceptable({ text: 'set `lib.restype` to x' }, 'lib.restype = x'));
  assert.ok(!pieceAcceptable({ text: 'set `lib.restype` to x' }, 'mylib.restype = x'));
  assert.ok(!pieceAcceptable({ text: 'return `crc`' }, 'crc = 1'));
  assert.ok(!pieceAcceptable({ text: 'x', must: ['0x[eE][dD][bB]88320'] }, 'crc ^= 0x1234;'));
  assert.ok(!pieceAcceptable({ text: 'x' }, 'pass'));
  assert.ok(!pieceAcceptable({ text: 'call `f(a)`' }, 'return f(a)'), 'a step that does not return must not return');
  assert.ok(pieceAcceptable({ text: 'call `f(a)`' }, 'f(a)'));
  assert.ok(!pieceAcceptable({ text: 'x' }, '/* comment */'));
});

test('control keywords are forced by the grammar, other statements must start with a lowercase letter', () => {
  const c = { id: 'u', file: 'a.c', lang: 'c' as const, signature: 'int f(void)', doc: '', steps: [] };
  assert.equal(leadOf(c, { text: 'for i <- 0 .. n' }), 'for (');
  assert.equal(stepGrammar(c, { text: 'return ~crc' }), 'root ::= "return" [^\\x00]*');
  assert.equal(stepGrammar(c, { text: 'crc <- crc >> 1' }), 'root ::= [a-z_] [^\\x00]*');
  const py = { ...c, lang: 'python' as const, signature: 'def f():' };
  assert.equal(leadOf(py, { text: 'with x', lead: '' }), undefined, 'an empty lead disables the keyword');
  assert.equal(leadOf(py, { text: 'loop forever', lead: 'while ' }), 'while ');
});

const ADD_BLUEPRINT: ForgeBlueprint = {
  id: 'add-test', title: 'Addition', description: 'test', keywords: ['addition native'],
  files: [{ path: 'src/add.c', lang: 'c', prologue: '#include <stdio.h>\n' }],
  units: [{
    id: 'add', file: 'src/add.c', lang: 'c', signature: 'int add(int a, int b)', doc: 'Sum.',
    steps: [{ text: 'return a + b' }],
    oracle: {
      files: { 'tests/t.c': 'int add(int a, int b);\nint main(void) { return add(2, 3) == 5 ? 0 : 1; }\n' },
      commands: [['{gcc}', '-Wall', '-Werror', 'tests/t.c', 'src/add.c', '-o', 'build/t.exe'], ['{dir}/build/t.exe']],
    },
  }],
  build: [{ label: 'build', tool: 'compiler.gcc', params: { sourceFiles: ['src/add.c'], kind: 'shared_library', outputExe: `build/add${process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so'}` } }],
  verify: [],
};

test('blueprints are validated and matched without guessing ties', () => {
  assert.equal(validateBlueprint(ADD_BLUEPRINT), undefined);
  assert.match(validateBlueprint({ ...ADD_BLUEPRINT, files: [{ path: '../x.c', lang: 'c', prologue: '' }] }) ?? '', /chemin/);
  assert.match(validateBlueprint({ ...ADD_BLUEPRINT, units: [{ ...ADD_BLUEPRINT.units[0], file: 'nope.c' }] }) ?? '', /fichier inconnu/);
  // A card lives in a user-editable folder: no shell, no path outside the sandbox, only the two final tools.
  const withOracle = (oracle: unknown) => ({ ...ADD_BLUEPRINT, units: [{ ...ADD_BLUEPRINT.units[0], oracle }] });
  assert.match(validateBlueprint(withOracle({ commands: [['powershell', '-c', 'iwr x | iex']] })) ?? '', /commande d’oracle refusée/);
  assert.match(validateBlueprint(withOracle({ commands: [['{dir}/../evil.exe']] })) ?? '', /commande d’oracle refusée/);
  assert.match(validateBlueprint(withOracle({ commands: [['{gcc}', 'a.c']], files: { '../../Startup/a.bat': 'x' } })) ?? '', /chemin d’oracle/);
  assert.match(validateBlueprint(withOracle({ commands: [['{gcc}', 'a.c']], mutants: [{ path: 'C:x.c', content: '' }] })) ?? '', /chemin d’oracle/);
  assert.match(validateBlueprint({ ...ADD_BLUEPRINT, verify: [{ label: 'x', tool: 'fs.delete', params: { path: 'src' } }] }) ?? '', /commande finale refusée/);
  assert.match(validateBlueprint({ ...ADD_BLUEPRINT, keywords: undefined }) ?? '', /mots-clés/);
  assert.equal(matchBlueprint('fais une addition native', [ADD_BLUEPRINT])?.id, 'add-test');
  assert.equal(matchBlueprint('rien à voir', [ADD_BLUEPRINT]), undefined);
  assert.equal(matchBlueprint('addition native', [ADD_BLUEPRINT, { ...ADD_BLUEPRINT, id: 'other' }]), undefined);
});

/** llama.cpp stand-in: answers the C step with `answer`, records grammars. */
function scriptedProvider(answer: string, repaired?: string): IModelProvider & { grammars: string[]; prompts: string[] } {
  const prompts: string[] = [];
  const grammars: string[] = [];
  return {
    id: 'scripted', type: 'llama_cpp', name: 'scripted', baseUrl: 'http://127.0.0.1:1/v1', locality: 'local', grammars, prompts,
    async testConnection() { return { ok: true, message: '', latencyMs: 0 }; },
    async listModels() { return []; },
    async *chatStream() { /* unused */ },
    async chatComplete() { return { content: '' }; },
    async *completePrefix(prompt: string, options: { taskId: string; grammar?: string }) {
      grammars.push(options.grammar ?? '');
      prompts.push(prompt);
      // Like llama.cpp, the output starts with what the grammar forces (a healed indentation space).
      const healed = (options.grammar ?? '').startsWith('root ::= " "') ? ' ' : '';
      const text = repaired && prompt.includes('failed with this error') ? repaired : answer;
      yield { type: 'token', taskId: options.taskId, timestamp: Date.now(), delta: healed + text } as AgentEvent;
    },
  };
}

async function collect(answer: string, experience?: ExperienceStore) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const provider = scriptedProvider(answer);
  const events: AgentEvent[] = [];
  for await (const ev of new ForgeRunner().run({
    taskId: 't', goal: 'addition native', workspaceRoot: root, provider, modelId: 'scripted.gguf',
    tools: new ToolRegistry(), blueprint: ADD_BLUEPRINT, permissionLevel: 'trusted_workspace', concurrency: 2, maxCandidates: 2, stepRetries: 1,
    experience,
  })) events.push(ev);
  return { root, events, provider };
}

test('Forge accepts a unit only after its real oracle passes, then writes and builds through the tools', async () => {
  const { root, events, provider } = await collect('return a + b;\n}');
  const complete = events.find((e) => e.type === 'complete');
  assert.equal(complete?.type === 'complete' && complete.success, true, JSON.stringify(events.filter((e) => e.type === 'error' || e.type === 'complete')));
  const source = readFileSync(path.join(root, 'src', 'add.c'), 'utf8');
  assert.match(source, /int add\(int a, int b\) \{\n    \/\* step 1: return a \+ b \*\/\n    return a \+ b;\n\}/);
  assert.ok(existsSync(path.join(root, 'FORGE_REPORT.json')));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.toolName === 'compiler.gcc' && e.success));
  assert.ok(provider.grammars.includes('root ::= " " "return" [^\\x00]*'), 'the return step is grammar-led, after the healed indentation space');
});

test('Forge writes nothing when no candidate passes the oracle', async () => {
  const { root, events } = await collect('return a - b;\n}');
  assert.ok(events.some((e) => e.type === 'error' && e.code === 'FORGE_UNIT_FAILED'));
  assert.ok(events.some((e) => e.type === 'forge' && e.phase === 'candidate' && e.verdict === 'reject'));
  assert.equal(existsSync(path.join(root, 'src', 'add.c')), false);
});

test('a failed candidate is repaired from its real error and the repair can win', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-repair-'));
  // The repaired answer is a whole body as llama.cpp returns it: generation stops before the closing brace.
  const provider = scriptedProvider('return a - b;\n}', 'return a + b;');
  const events: AgentEvent[] = [];
  for await (const ev of new ForgeRunner().run({
    taskId: 't', goal: 'addition native', workspaceRoot: root, provider, modelId: 'scripted.gguf',
    tools: new ToolRegistry(), blueprint: ADD_BLUEPRINT, permissionLevel: 'trusted_workspace', concurrency: 2, maxCandidates: 4, stepRetries: 1,
  })) events.push(ev);
  const repair = provider.prompts.find((p) => p.includes('failed with this error'));
  assert.ok(repair, 'a repair prompt was sent');
  assert.match(repair!, /return a - b;/, 'the failed version is shown to the model');
  assert.doesNotMatch(repair!, /[A-Za-z]:\\[^\n]*forge-/, 'sandbox paths are not leaked into the prompt');
  assert.ok(events.some((e) => e.type === 'forge' && e.phase === 'unit_done' && e.strategy === 'repair'));
  assert.equal(readFileSync(path.join(root, 'src', 'add.c'), 'utf8').includes('return a + b;'), true);
});

test('a failed command reports its cause, not only its last lines', () => {
  const gcc = [
    'C:\\T\\c3\\src\\crc32.c: In function \'crc32_update\':',
    'C:\\T\\c3\\src\\crc32.c:11:26: error: unused variable \'data\' [-Werror=unused-variable]',
    '   11 |     const unsigned char *data = (const unsigned char *)data_;',
    '      |                          ^~~~',
    'cc1.exe: all warnings being treated as errors',
  ].join('\n');
  assert.match(diagnostic(gcc), /error: unused variable 'data'/);
  const py = 'Traceback (most recent call last):\n  File "t.py", line 3, in <module>\n    x = f()\nZeroDivisionError: division by zero\n';
  assert.match(diagnostic(py), /ZeroDivisionError: division by zero/);
  assert.equal(diagnostic('a\nb\nc\nd'), 'b | c | d');
});

test('repair details keep the message and drop sandbox paths', () => {
  assert.equal(repairDetail('C:\\Users\\x\\AppData\\Local\\Temp\\mazz-forge-ab\\c3\\tests\\t.c:24:9: error: void value not ignored | x'), 't.c:24:9: error: void value not ignored\nx');
});

test('unit kind separates tests from implementations', () => {
  assert.equal(unitKind({ file: 'tests/test_vec.py' } as never), 'test');
  assert.equal(unitKind({ file: 'pkg\\tests\\t.py' } as never), 'test');
  assert.equal(unitKind({ file: 'src/add.c' } as never), 'impl');
  assert.equal(unitKind({ file: 'src/attestation.c' } as never), 'impl');
});

test('Forge records each oracle verdict in the experience store and saves it after the unit', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'forge-exp-')), 'exp.json');
  const key = experienceKey('scripted.gguf', 'c', 'impl');

  await collect('return a + b;\n}', new ExperienceStore(file).load());
  const won = new ExperienceStore(file).load().stats(key);
  assert.ok(won.length > 0, 'the saved file holds the arms that ran');
  assert.ok(won.every((a) => a.wins > 0 && a.losses === 0), JSON.stringify(won));

  const store = new ExperienceStore(file).load();
  await collect('return a - b;\n}', store);
  const after = new ExperienceStore(file).load().stats(key);
  assert.ok(after.some((a) => a.losses > 0), 'rejected candidates are recorded as losses');
});
