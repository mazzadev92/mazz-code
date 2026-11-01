import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ToolDefinition } from '@mazz/shared';
import { PLAN_DEFINITION } from './specialists.js';
import { hasExplicitFileMutationIntent, inspectTextToolCallCandidate, isPossibleTextToolCallPrefix, parseTextToolCall } from './tool-call-compat.js';

test('file mutation intent separates edits from reading, review, compilation, and code identifiers', () => {
  for (const request of [
    'Lis patch-target.txt.',
    'Review the code and explain the add function.',
    'Find the add function and read main.c.',
    'Compile main.c with gcc.',
    'Show the existing patch.',
    'Ne crée pas de fichier.',
    'Lis fixture.txt avec fs.read et n’écris rien.',
  ]) assert.equal(hasExplicitFileMutationIntent(request), false, request);

  for (const request of [
    'Patch main.c to fix the CRC bug.',
    'Crée un petit projet Python.',
    'Utilise fs.patch pour remplacer OLD par NEW dans result.txt.',
  ]) assert.equal(hasExplicitFileMutationIntent(request), true, request);
});

const readTool: ToolDefinition = {
  name: 'fs.read',
  description: 'Reads a text file from the workspace.',
  category: 'fs',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  requiresPermission: false,
};

const knowledgeReadTools: ToolDefinition[] = [
  {
    name: 'knowledge.engines',
    description: 'Lists the available knowledge tools.',
    category: 'mcp',
    parameters: { type: 'object', properties: {} },
    requiresPermission: false,
  },
  {
    name: 'knowledge.inventory',
    description: 'Counts the physical files in configured vaults.',
    category: 'memory',
    parameters: { type: 'object', properties: {} },
    requiresPermission: false,
  },
  {
    name: 'knowledge.search',
    description: 'Searches the knowledge vault with citations.',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, vault_path: { type: 'string' } },
      required: ['query'],
    },
    requiresPermission: false,
  },
];

test('read-only text tool compatibility accepts the local GGUF fenced JSON format', () => {
  const parsed = parseTextToolCall(
    '```json\n{"name":"fs.read","arguments":{"path":"brief.txt"}}\n```',
    'Lire le fichier brief.txt et renvoyer sa sentinelle.',
    [readTool],
  );
  assert.deepEqual(parsed, { name: 'fs.read', arguments: { path: 'brief.txt' }, format: 'fenced-json' });
});

test('read-only text tool compatibility maps the provider wire name back to the offered tool', () => {
  const parsed = parseTextToolCall(
    '```json\n{"name":"fs__read","arguments":{"path":"brief.txt"}}\n```',
    'Lis le fichier brief.txt.',
    [readTool],
  );
  assert.deepEqual(parsed, { name: 'fs.read', arguments: { path: 'brief.txt' }, format: 'fenced-json' });
});

test('text-call normalization accepts only exact offered names or the canonical double-underscore wire name', () => {
  const canonical = (name: string) => `{"name":${JSON.stringify(name)},"arguments":{"path":"brief.txt"}}`;
  assert.equal(parseTextToolCall(canonical('fs_read'), 'Read brief.txt.', [readTool]), undefined);
  assert.equal(parseTextToolCall(canonical('FS__READ'), 'Read brief.txt.', [readTool]), undefined);
  assert.equal(parseTextToolCall(canonical('fs__read'), 'Read brief.txt.', [readTool])?.name, 'fs.read');
  assert.equal(parseTextToolCall(canonical('fs.read'), 'Read brief.txt.', [readTool])?.name, 'fs.read');
  assert.equal(parseTextToolCall(canonical('fs.read'), 'Read brief.txt.', [readTool, { ...readTool }]), undefined);
});

test('explicitly read-only knowledge catalogue calls are recoverable from local GGUF wire names', () => {
  const cases = [
    { name: 'knowledge.engines', arguments: {}, goal: 'List the available Bib1 MCP tools.' },
    { name: 'knowledge.inventory', arguments: {}, goal: 'Inspect the physical vault inventory.' },
    { name: 'knowledge.search', arguments: { query: 'Qwen local models' }, goal: 'Search the knowledge vault for Qwen local models.' },
  ];
  for (const item of cases) {
    const payload = JSON.stringify({ name: item.name.replace(/\./gu, '__'), arguments: item.arguments });
    assert.deepEqual(parseTextToolCall(payload, item.goal, knowledgeReadTools), {
      name: item.name,
      arguments: item.arguments,
      format: 'raw-json',
    });
  }
});

test('read intent recognizes the French infinitive in the knowledge catalogue request', () => {
  const payload = '{"name":"knowledge__engines","arguments":{}}';
  assert.deepEqual(
    parseTextToolCall(payload, 'Utilise knowledge.engines pour lister les outils réellement exposés.', [knowledgeReadTools[0]]),
    { name: 'knowledge.engines', arguments: {}, format: 'raw-json' },
  );
});

test('read-only recovery does not extend to the permission-gated knowledge engine or arbitrary no-permission tools', () => {
  const engineTool: ToolDefinition = {
    name: 'knowledge.engine',
    description: 'Invokes a MAZZ engine operation.',
    category: 'mcp',
    parameters: {
      type: 'object',
      properties: { operation: { type: 'string' }, task: { type: 'string' }, args: { type: 'object', properties: {} } },
      required: ['operation'],
    },
    requiresPermission: true,
  };
  const arbitraryTool: ToolDefinition = { ...readTool, name: 'project.status' };
  assert.equal(
    parseTextToolCall(
      '{"name":"knowledge__engine","arguments":{"operation":"methods.find"}}',
      'Run methods.find through knowledge.engine.',
      [engineTool],
    ),
    undefined,
  );
  assert.equal(
    parseTextToolCall(
      '{"name":"project__status","arguments":{"path":"."}}',
      'Read the project status.',
      [arbitraryTool],
    ),
    undefined,
  );
});

test('structured plan updates accept the local GGUF text-call dialect only when the safe tool is offered', () => {
  const arguments_ = {
    objective: 'Créer et vérifier un artefact.',
    constraints: ['Rester dans le workspace.'],
    acceptanceCriteria: ['Les deux fichiers sont vérifiés.'],
    items: [{ id: 's1', content: 'Créer source.txt', dependencies: [], status: 'in_progress' }],
  };
  const payload = `\`\`\`json\n${JSON.stringify({ name: 'plan__update', arguments: arguments_ })}\n\`\`\``;
  assert.deepEqual(parseTextToolCall(payload, 'Crée un artefact en 5 étapes séquentielles.', [PLAN_DEFINITION]), {
    name: 'plan.update', arguments: arguments_, format: 'fenced-json',
  });
  assert.equal(parseTextToolCall(payload, 'Crée un artefact en 5 étapes séquentielles.', []), undefined);
});

test('terminal text calls require an offered permission-gated tool and explicit execution intent', () => {
  const terminalTool: ToolDefinition = {
    name: 'terminal.run',
    description: 'Run a command in the workspace.',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        shell: { type: 'string', enum: ['powershell', 'cmd'] },
        cwd: { type: 'string' },
      },
      required: ['command'],
    },
    requiresPermission: true,
  };
  const args = { command: 'node -e "console.log(1)"', shell: 'powershell', cwd: '.' };
  const payload = `\`\`\`json\n${JSON.stringify({ name: 'terminal__run', arguments: args })}\n\`\`\``;
  assert.deepEqual(parseTextToolCall(payload, 'Exécute terminal.run dans le workspace pour vérifier les fichiers.', [terminalTool]), {
    name: 'terminal.run', arguments: args, format: 'fenced-json',
  });
  assert.equal(parseTextToolCall(payload, 'Explique l’outil terminal.run.', [terminalTool]), undefined);
  assert.equal(parseTextToolCall(payload, 'Exécute terminal.run.', [{ ...terminalTool, requiresPermission: false }]), undefined);
});

test('compiler text calls require an offered permission-gated compiler and explicit compile intent', () => {
  const compilerTool: ToolDefinition = {
    name: 'compiler.gcc',
    description: 'Compile C or C++ files with GCC.',
    category: 'compiler',
    parameters: {
      type: 'object',
      properties: {
        sourceFiles: { type: 'array', items: { type: 'string' } },
        outputExe: { type: 'string' },
      },
      required: ['sourceFiles', 'outputExe'],
    },
    requiresPermission: true,
  };
  const args = { sourceFiles: ['src/crc32.c'], outputExe: 'build/crc32.dll' };
  const payload = JSON.stringify({ name: 'compiler__gcc', arguments: args });
  assert.deepEqual(parseTextToolCall(payload, 'Compile src/crc32.c with compiler.gcc.', [compilerTool]), {
    name: 'compiler.gcc', arguments: args, format: 'raw-json',
  });
  assert.equal(parseTextToolCall(payload, 'Explain the compiler.gcc tool.', [compilerTool]), undefined);
  assert.equal(parseTextToolCall(payload, 'Compile src/crc32.c.', [{ ...compilerTool, requiresPermission: false }]), undefined);
});

test('read-only text tool compatibility rejects ambiguous, unsafe, unoffered, and malformed payloads', () => {
  const destructive: ToolDefinition = { ...readTool, name: 'fs.delete', isDestructive: true };
  const protectedRead: ToolDefinition = { ...readTool, requiresPermission: true };
  assert.equal(parseTextToolCall('{"name":"fs.read","arguments":{"path":"brief.txt"}}', 'Print this JSON object.', [readTool]), undefined);
  assert.equal(parseTextToolCall('Tool call: {"name":"fs.read","arguments":{"path":"brief.txt"}}', 'Read brief.txt.', [readTool]), undefined);
  assert.equal(parseTextToolCall('{"name":"fs.read","arguments":{"path":"brief.txt"}}', 'Read brief.txt.', []), undefined);
  assert.equal(parseTextToolCall('{"name":"fs.delete","arguments":{"path":"brief.txt"}}', 'Delete brief.txt.', [destructive]), undefined);
  assert.equal(parseTextToolCall('{"name":"fs.read","arguments":{"path":"brief.txt"}}', 'Read brief.txt.', [protectedRead]), undefined);
  assert.equal(parseTextToolCall('{"name":"fs.read","arguments":{"__proto__":{"x":1}}}', 'Read brief.txt.', [readTool]), undefined);
  assert.equal(parseTextToolCall('{not json}', 'Read brief.txt.', [readTool]), undefined);
});

test('text calls with duplicate JSON keys are rejected instead of silently taking the last value', () => {
  const payloads = [
    '{"name":"fs.read","name":"fs.delete","arguments":{"path":"brief.txt"}}',
    '{"name":"fs.read","arguments":{"path":"first.txt","path":"second.txt"}}',
    '{"name":"fs.read","arguments":{"path":"first.txt","p\\u0061th":"second.txt"}}',
    '{"name":"fs.read","arguments":{"nested":{"value":1,"value":2},"path":"brief.txt"}}',
  ];
  for (const payload of payloads) {
    assert.equal(parseTextToolCall(payload, 'Read brief.txt.', [readTool]), undefined);
    assert.equal(inspectTextToolCallCandidate(payload), undefined);
  }
});

test('text calls reject schema-invalid arguments before returning a dispatchable call', () => {
  const invalidPayloads = [
    '{"name":"fs.read","arguments":{"path":7}}',
    '{"name":"fs.read","arguments":{"path":"brief.txt","unexpected":true}}',
    '{"name":"fs.read","arguments":{}}',
  ];
  for (const payload of invalidPayloads) {
    assert.equal(parseTextToolCall(payload, 'Read brief.txt.', [readTool]), undefined);
  }
});

test('file mutation text calls require an offered, permission-gated tool and affirmative user intent', () => {
  const writeTool: ToolDefinition = {
    ...readTool,
    name: 'fs.write',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    requiresPermission: true,
    isDestructive: false,
  };
  const payload = '```json\n{"name":"fs__write","arguments":{"path":"result.txt","content":"ok"}}\n```';
  const accepted = parseTextToolCall(payload, 'Crée le fichier result.txt avec le contenu demandé.', [writeTool]);
  assert.deepEqual(accepted, {
    name: 'fs.write',
    arguments: { path: 'result.txt', content: 'ok' },
    format: 'fenced-json',
  });
  assert.equal(parseTextToolCall(payload, 'Ne crée pas de fichier.', [writeTool]), undefined);
  assert.equal(parseTextToolCall(payload, 'Print this JSON object.', [writeTool]), undefined);
  assert.equal(parseTextToolCall(payload, 'Explique le fonctionnement de fs.write.', [writeTool]), undefined);
  assert.equal(parseTextToolCall(payload, 'Create result.txt.', [{ ...writeTool, requiresPermission: false }]), undefined);
  assert.equal(parseTextToolCall(payload, 'Create result.txt.', []), undefined);
});

test('file patch text calls accept the local GGUF inline-fenced JSON and exact French replacement wording', () => {
  const patchTool: ToolDefinition = {
    ...readTool,
    name: 'fs.patch',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { search: { type: 'string' }, replace: { type: 'string' } },
            required: ['search', 'replace'],
          },
        },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'edits'],
    },
    requiresPermission: true,
    isDestructive: false,
  };
  const payload = '```json { "name": "fs__patch", "arguments": { "path": "result.txt", "edits": [{ "search": "ORIGINAL_SENTINEL=old", "replace": "SENTINEL=new" }], "replaceAll": true } } ```';
  const accepted = parseTextToolCall(
    payload,
    'Utilise fs.patch pour remplacer exactement ORIGINAL_SENTINEL=old par SENTINEL=new dans result.txt.',
    [patchTool],
  );
  assert.deepEqual(accepted, {
    name: 'fs.patch',
    arguments: { path: 'result.txt', edits: [{ search: 'ORIGINAL_SENTINEL=old', replace: 'SENTINEL=new' }], replaceAll: true },
    format: 'fenced-json',
  });
});

test('read-only text tool compatibility recognizes French reread instructions when a tool is named too', () => {
  const parsed = parseTextToolCall(
    '{"name":"fs__read","arguments":{"path":"result.txt"}}',
    'Utilise fs.write, puis relis result.txt avec fs.read.',
    [readTool],
  );
  assert.equal(parsed?.name, 'fs.read');
});

test('tool compatibility extracts a leading call when a small GGUF appends answer text', () => {
  const jsonThenAnswer = '{"name":"fs__read","arguments":{"path":"result.txt"}}\n```plaintext\nSENTINEL=from-disk\n```';
  const fencedThenAnswer = '```json\n{"name":"fs__read","arguments":{"path":"result.txt"}}\n```\nI will now report the contents.';
  for (const text of [jsonThenAnswer, fencedThenAnswer]) {
    assert.deepEqual(
      parseTextToolCall(text, 'Relis result.txt.', [readTool]),
      { name: 'fs.read', arguments: { path: 'result.txt' }, format: text.startsWith('{') ? 'raw-json' : 'fenced-json' },
    );
  }
});

test('tool compatibility rejects a second structured payload appended to an otherwise valid call', () => {
  const first = '{"name":"fs__read","arguments":{"path":"first.txt"}}';
  const second = '{"name":"fs__read","arguments":{"path":"second.txt"}}';
  assert.equal(parseTextToolCall(`${first}\n${second}`, 'Read first.txt.', [readTool]), undefined);
  assert.equal(parseTextToolCall(`${first}\n{"arguments":`, 'Read first.txt.', [readTool]), undefined);
  assert.equal(parseTextToolCall(`\`\`\`json\n${first}\n\`\`\`\n\`\`\`json\n${second}\n\`\`\``, 'Read first.txt.', [readTool]), undefined);
});

test('tool compatibility safely extracts loose file content when model emits unescaped internal quotes', () => {
  const writeTool: ToolDefinition = {
    name: 'fs.write',
    description: 'Writes a file.',
    category: 'fs',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    requiresPermission: true,
  };
  const malformedJson = '```json\n{\n  "name": "fs__write",\n  "arguments": {\n    "path": "test.py",\n    "content": "cursor.execute(\\"SELECT * FROM t\\")\\nprint(\\"done\\")"\n  }\n}\n```';
  // Note: with unescaped internal quotes in python string:
  const rawWithUnescaped = '```json\n{\n  "name": "fs__write",\n  "arguments": {\n    "path": "test.py",\n    "content": "cursor.execute("SELECT * FROM t")\\nprint("done")"\n  }\n}\n```';
  const parsed = parseTextToolCall(rawWithUnescaped, 'Écris le script test.py.', [writeTool]);
  assert.equal(parsed?.name, 'fs.write');
  assert.equal(parsed?.arguments.path, 'test.py');
  assert.match(parsed?.arguments.content as string, /SELECT \* FROM t/);
});

test('read-only text tool compatibility holds only plausible leading JSON prefixes', () => {
  assert.equal(isPossibleTextToolCallPrefix('  ```json\n{'), true);
  assert.equal(isPossibleTextToolCallPrefix('{"name"'), true);
  assert.equal(isPossibleTextToolCallPrefix('The file contains'), false);
});

test('toolCallCompat_proseThenCallOnItsOwnLine_isParsed_evenWithMangledTag', () => {
  // Arrange: what the fine-tuned Qwen2.5-Coder produced (sentence, broken <tool_call> tag, JSON, no closing tag).
  const text = 'Je lis le fichier.\n\u63a8\ufffd\n{"name": "fs__read", "arguments": {"path": "src/utils.py"}}\n';
  // Act
  const call = parseTextToolCall(text, 'Lis src/utils.py', [readTool]);
  // Assert
  assert.deepEqual(call?.arguments, { path: 'src/utils.py' });
  assert.equal(call?.name, 'fs.read');
  assert.equal(parseTextToolCall('Voici un exemple de format : {"a": 1}', 'Lis src/utils.py', [readTool]), undefined);
});

test('toolCallCompat_wrongNamespaceRightAction_mapsToTheSingleOfferedTool', () => {
  // Arrange: a fine-tuned model wrote "tools__read" for fs.read.
  const text = '{"name": "tools__read", "arguments": {"path": "src/utils.py"}}';
  // Act
  const call = parseTextToolCall(text, 'Lis src/utils.py', [readTool]);
  // Assert
  assert.equal(call?.name, 'fs.read');
  assert.equal(parseTextToolCall('{"name": "tools__read", "arguments": {"path": "a"}}', 'Lis a', [readTool, { ...readTool, name: 'git.read' }]), undefined, 'ambiguous action');
});

test('toolCallCompat_trailingProseWithBraces_isNotMistakenForASecondCall', () => {
  const call = parseTextToolCall(
    '```json\n{"name":"fs.read","arguments":{"path":"brief.txt"}}\n```\nLe contenu de {brief.txt} est affiché.',
    'Lis le fichier brief.txt.',
    [readTool],
  );
  assert.equal(call?.name, 'fs.read');
  assert.deepEqual(call?.arguments, { path: 'brief.txt' });
});

test('toolCallCompat_argsAliasAndJsonStringArguments_areAccepted', () => {
  const withAlias = parseTextToolCall('{"name":"fs.read","args":{"path":"brief.txt"}}', 'Lis le fichier brief.txt.', [readTool]);
  assert.deepEqual(withAlias, { name: 'fs.read', arguments: { path: 'brief.txt' }, format: 'raw-json' });

  const withString = parseTextToolCall(
    '{"name":"fs.read","arguments":"{\\"path\\":\\"brief.txt\\"}"}',
    'Lis le fichier brief.txt.',
    [readTool],
  );
  assert.deepEqual(withString, { name: 'fs.read', arguments: { path: 'brief.txt' }, format: 'raw-json' });
});

test('toolCallCompat_inlineExampleAfterProse_isStillRejected', () => {
  assert.equal(parseTextToolCall(
    'Tool call: {"name":"fs__read","arguments":{"path":"brief.txt"}}',
    'Lis le fichier brief.txt.',
    [readTool],
  ), undefined);
});

test('toolCallCompat_toolsTagFromQwenCoder14B_isParsed', () => {
  // Arrange: exact shape measured on Mazz-Technos-Ultra-14B through llama-server (2026-11-01).
  const text = '<tools>\n{\n  "name": "fs__read",\n  "arguments": {\n    "path": "src/utils.py",\n    "offset": 9\n  }\n}\n</tools>';
  const tool = { ...readTool, parameters: { ...readTool.parameters, properties: { ...readTool.parameters.properties, offset: { type: 'integer' as const } } } };
  // Act
  const call = parseTextToolCall(text, 'Lis src/utils.py', [tool]);
  // Assert
  assert.equal(call?.name, 'fs.read');
  assert.deepEqual(call?.arguments, { path: 'src/utils.py', offset: 9 });
});
