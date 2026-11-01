import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { MazzAgentLoop } from '@mazz/agent';
import { DeterministicTestProvider } from '@mazz/providers/testing';
import { ToolRegistry } from '@mazz/tools';
import type { AgentEvent } from '@mazz/shared';
import { AttachmentReadTool, AttachmentStore } from './attachments.js';
import { SessionStore } from './sessions.js';
import type { ToolExecutionContext } from '@mazz/shared';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

test('attachment source and extracted text hashes survive restart and paged reads reconstruct exact text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-integrity-'));
  try {
    const originalText = `${'Requirement 𝐀 line\n'.repeat(80)}END_SENTINEL`;
    const bytes = Buffer.from(originalText, 'utf-8');
    const store = new AttachmentStore(dir);
    const meta = await store.add('specification.txt', bytes);

    assert.equal(meta.extractionStatus, 'complete');
    assert.equal(meta.offsetUnit, 'utf16-code-unit');
    assert.equal(meta.sourceSha256, sha256(bytes));
    assert.equal(meta.textSha256, sha256(originalText));
    assert.equal(meta.chars, originalText.length);

    const restartedStore = new AttachmentStore(dir);
    const persisted = await restartedStore.meta(meta.id);
    assert.equal(persisted.id, meta.id);
    assert.equal(persisted.sourceSha256, meta.sourceSha256);
    assert.equal(persisted.textSha256, meta.textSha256);
    assert.equal(persisted.extractionStatus, meta.extractionStatus);
    assert.equal(persisted.offsetUnit, meta.offsetUnit);

    const reader = new AttachmentReadTool(restartedStore);
    const pages: string[] = [];
    for (let offset = 0; offset < persisted.chars;) {
      const result = await reader.execute({ id: meta.id, offset, length: 100 }, {} as ToolExecutionContext);
      assert.equal(result.success, true);
      const value = result.output as { offset: number; length: number; total: number; offsetUnit: string; textSha256: string; text: string; done: boolean };
      assert.equal(value.offset, offset);
      assert.equal(value.total, persisted.chars);
      assert.equal(value.offsetUnit, 'utf16-code-unit');
      assert.equal(value.textSha256, persisted.textSha256);
      pages.push(value.text);
      offset += value.length;
      if (value.done) break;
    }
    assert.equal(pages.join(''), originalText);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('image attachments keep source integrity while explicitly reporting that text extraction is unavailable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-image-'));
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const meta = await new AttachmentStore(dir).add('diagram.png', bytes);
    assert.equal(meta.kind, 'image');
    assert.equal(meta.extractionStatus, 'unavailable');
    assert.equal(meta.sourceSha256, sha256(bytes));
    assert.equal(meta.textSha256, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('UTF-16 text attachments are decoded without changing the source-byte hash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-utf16-'));
  try {
    const originalText = 'Début 𝐀\nExigence UTF-16';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(originalText, 'utf16le')]);
    const store = new AttachmentStore(dir);
    const meta = await store.add('unicode.txt', bytes);

    assert.equal(meta.kind, 'text');
    assert.equal(meta.extractionStatus, 'complete');
    assert.equal(meta.chars, originalText.length);
    assert.equal(meta.sourceSha256, sha256(bytes));
    assert.equal(meta.textSha256, sha256(originalText));
    assert.equal(await store.text(meta.id), originalText);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('invalid UTF-8 later in a large text file is never reported as complete extraction', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-invalid-utf8-'));
  try {
    const bytes = Buffer.concat([Buffer.alloc(65_536, 0x41), Buffer.from([0xff, 0x42])]);
    const store = new AttachmentStore(dir);
    const meta = await store.add('late-invalid.txt', bytes);

    assert.equal(meta.kind, 'text');
    assert.equal(meta.extractionStatus, 'failed');
    assert.match(meta.note ?? '', /Extraction impossible/u);
    assert.equal(meta.chars, 0);
    assert.equal(meta.textSha256, undefined);
    assert.equal((await store.original(meta.id)).meta.sourceSha256, sha256(bytes));
    assert.deepEqual((await fs.readdir(path.join(dir, meta.id))).sort(), ['meta.json', 'original']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('restarted attachment reads reject a truncated or changed original instead of returning it as valid', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-original-corruption-'));
  try {
    const store = new AttachmentStore(dir);
    const bytes = Buffer.from('original bytes with integrity marker');
    const meta = await store.add('source.txt', bytes);
    const restarted = new AttachmentStore(dir);

    await fs.writeFile(path.join(dir, meta.id, 'original'), bytes.subarray(0, bytes.length - 1));
    await assert.rejects(restarted.original(meta.id), /incomplet ou corrompu/);
    const sameSizeCorruption = Buffer.from(bytes);
    const lastByte = sameSizeCorruption.length - 1;
    sameSizeCorruption.writeUInt8(sameSizeCorruption.readUInt8(lastByte) ^ 0xff, lastByte);
    await fs.writeFile(path.join(dir, meta.id, 'original'), sameSizeCorruption);
    await assert.rejects(restarted.original(meta.id), /incomplet ou corrompu/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a missing or altered extracted text file cannot become an empty successful attachments.read result after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-text-corruption-'));
  try {
    const meta = await new AttachmentStore(dir).add('source.txt', Buffer.from('persisted extracted text'));
    const restarted = new AttachmentStore(dir);
    const textPath = path.join(dir, meta.id, 'text.txt');
    await fs.rm(textPath);

    await assert.rejects(restarted.text(meta.id), /ENOENT|no such file/i);
    const result = await new AttachmentReadTool(restarted).execute({ id: meta.id }, {} as ToolExecutionContext);
    assert.equal(result.success, false);

    await fs.writeFile(textPath, 'persisted extracted texX');
    await assert.rejects(restarted.text(meta.id), /incomplet ou corrompu/);
    const altered = await new AttachmentReadTool(restarted).execute({ id: meta.id }, {} as ToolExecutionContext);
    assert.equal(altered.success, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('attachment add publishes only a complete final directory and rejects an unusable storage root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-atomic-add-'));
  try {
    const store = new AttachmentStore(dir);
    const meta = await store.add('committed.txt', Buffer.from('committed only after verification'));
    assert.deepEqual(await fs.readdir(dir), [meta.id]);
    const files = (await fs.readdir(path.join(dir, meta.id))).sort();
    assert.deepEqual(files, ['meta.json', 'original', 'text.txt']);
    const restarted = new AttachmentStore(dir);
    assert.equal((await restarted.original(meta.id)).data.toString('utf-8'), 'committed only after verification');

    const fileRoot = path.join(dir, 'not-a-directory');
    await fs.writeFile(fileRoot, 'occupied');
    await assert.rejects(new AttachmentStore(fileRoot).add('cannot-write.txt', Buffer.from('data')));
    assert.equal(await fs.readFile(fileRoot, 'utf-8'), 'occupied');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('attachment excerpts reuse budget from short files and disclose exact omitted ranges', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-budget-'));
  try {
    const store = new AttachmentStore(dir);
    const short = await store.add('short.txt', Buffer.from('AB'));
    const longText = '0123456789ABCDEFGHIJ';
    const long = await store.add('long.txt', Buffer.from(longText));

    const rendered = await store.renderForPrompt([short.id, long.id], 8);
    assert.equal(rendered.truncated, true);
    assert.match(rendered.text, /<pieces_jointes_partiellement_incluses>/);
    assert.match(rendered.text, new RegExp(`${long.id}[^\\n]*6\\/20 caractères inclus`));
    assert.match(rendered.text, /AB/);
    assert.match(rendered.text, /012345/);
    assert.match(rendered.text, new RegExp(`attachments\\.read id="${long.id}" offset=6 length=20000`));

    const reader = new AttachmentReadTool(store);
    const rest = await reader.execute({ id: long.id, offset: 6, length: 20000 }, {} as ToolExecutionContext);
    assert.equal(rest.success, true);
    assert.equal((rest.output as { text: string }).text, longText.slice(6));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderForPrompt reports the exact UTF-16 prefix included for truncated and complete disk attachments', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-inline-counts-'));
  try {
    const store = new AttachmentStore(dir);
    const fullText = 'FULL';
    const longText = '0123456789ABCDEFGHIJ';
    const full = await store.add('full.txt', Buffer.from(fullText));
    const partial = await store.add('partial.txt', Buffer.from(longText));

    const rendered = await store.renderForPrompt([full.id, partial.id], 16);
    assert.equal(rendered.truncated, true);

    const renderedPrefix = (id: string): string => {
      const blockStart = rendered.text.indexOf(`<piece_jointe id="${id}"`);
      assert.notEqual(blockStart, -1, `missing rendered block for ${id}`);
      const contentStart = rendered.text.indexOf('>\n', blockStart) + 2;
      const blockEnd = rendered.text.indexOf('\n</piece_jointe>', contentStart);
      assert.notEqual(blockEnd, -1, `unterminated rendered block for ${id}`);
      const body = rendered.text.slice(contentStart, blockEnd);
      const truncationNote = body.indexOf('\n[EXTRAIT PARTIEL :');
      return truncationNote < 0 ? body : body.slice(0, truncationNote);
    };

    const fullPrefix = renderedPrefix(full.id);
    const partialPrefix = renderedPrefix(partial.id);
    assert.equal(rendered.inlineCharactersById[full.id], fullPrefix.length);
    assert.equal(rendered.inlineCharactersById[partial.id], partialPrefix.length);
    assert.equal(fullPrefix, fullText);
    assert.equal(partialPrefix, longText.slice(0, rendered.inlineCharactersById[partial.id]));
    assert.equal(rendered.inlineCharactersById[full.id], fullText.length);
    assert.ok(rendered.inlineCharactersById[partial.id] < longText.length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('attachment excerpts never split a UTF-16 surrogate pair', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-surrogate-'));
  try {
    const store = new AttachmentStore(dir);
    const original = `abc𝐀${'z'.repeat(20)}`;
    const meta = await store.add('unicode.txt', Buffer.from(original));
    const rendered = await store.renderForPrompt([meta.id], 4);

    assert.equal(rendered.truncated, true);
    assert.match(rendered.text, /abc\n\[EXTRAIT PARTIEL/);
    assert.doesNotMatch(rendered.text, /\uFFFD/);
    const result = await new AttachmentReadTool(store).execute({ id: meta.id, offset: 3, length: 20000 }, {} as ToolExecutionContext);
    assert.equal((result.output as { text: string }).text, original.slice(3));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('paged reads preserve Unicode pairs across page boundaries and reject malformed or split offsets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-page-surrogate-'));
  try {
    const store = new AttachmentStore(dir);
    const original = `${'A'.repeat(99)}𝐀${'B'.repeat(101)}`;
    const meta = await store.add('unicode-boundary.txt', Buffer.from(original, 'utf8'));
    const reader = new AttachmentReadTool(store);

    const first = await reader.execute({ id: meta.id, offset: 0, length: 100 }, {} as ToolExecutionContext);
    assert.equal(first.success, true);
    const firstPage = first.output as { offset: number; length: number; offsetUnit: string; text: string; boundaryAdjusted: boolean; done: boolean };
    assert.equal(firstPage.offset, 0);
    assert.equal(firstPage.length, 99);
    assert.equal(firstPage.offsetUnit, 'utf16-code-unit');
    assert.equal(firstPage.text, 'A'.repeat(99));
    assert.equal(firstPage.boundaryAdjusted, true);
    assert.equal(firstPage.done, false);
    assert.ok(!(firstPage.text.charCodeAt(firstPage.text.length - 1) >= 0xd800 && firstPage.text.charCodeAt(firstPage.text.length - 1) <= 0xdbff));

    const second = await reader.execute({ id: meta.id, offset: firstPage.offset + firstPage.length, length: 100 }, {} as ToolExecutionContext);
    assert.equal(second.success, true);
    const secondPage = second.output as { offset: number; length: number; offsetUnit: string; text: string; boundaryAdjusted: boolean; done: boolean };
    assert.equal(secondPage.offset, 99);
    assert.ok(secondPage.text.startsWith('𝐀'));
    assert.equal(secondPage.boundaryAdjusted, false);
    assert.equal(secondPage.done, false);
    const third = await reader.execute({ id: meta.id, offset: secondPage.offset + secondPage.length, length: 100 }, {} as ToolExecutionContext);
    assert.equal(third.success, true);
    const thirdPage = third.output as { offset: number; length: number; text: string; done: boolean };
    assert.equal(thirdPage.offset, 199);
    assert.equal(firstPage.text + secondPage.text + thirdPage.text, original);
    assert.equal(thirdPage.done, true);

    for (const invalid of [
      { id: meta.id, offset: 0.5, length: 100 },
      { id: meta.id, offset: -1, length: 100 },
      { id: meta.id, offset: 0, length: 100.5 },
      { id: meta.id, offset: 0, length: 20_001 },
      { id: meta.id, offset: 100, length: 100 }, // between the emoji's UTF-16 code units
    ]) {
      const rejected = await reader.execute(invalid, {} as ToolExecutionContext);
      assert.equal(rejected.success, false);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('disk-backed attachment pages integrate with contiguous agent-loop control flow', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-attachment-agent-e2e-'));
  try {
    const store = new AttachmentStore(path.join(dir, 'attachments'));
    const original = `${'A'.repeat(99)}𝐀${'B'.repeat(101)}`;
    const meta = await store.add('unicode-boundary.txt', Buffer.from(original, 'utf8'));
    assert.ok(meta.textSha256);
    const registry = new ToolRegistry();
    registry.register(new AttachmentReadTool(store));
    const provider = new DeterministicTestProvider([
      { toolCall: { id: 'page-1', name: 'attachments.read', arguments: { id: meta.id, offset: 0, length: 100 } } },
      { toolCall: { id: 'page-2', name: 'attachments.read', arguments: { id: meta.id, offset: 99, length: 100 } } },
      { toolCall: { id: 'page-3', name: 'attachments.read', arguments: { id: meta.id, offset: 199, length: 100 } } },
      { message: `Document intégral vérifié : unicode-boundary.txt, offsets UTF-16 0–${original.length}.` },
    ]);
    const events: AgentEvent[] = [];
    const selection = {
      providerId: 'deterministic-test', modelId: 'deterministic', executionMode: 'local_strict' as const,
      allowedWorkspaceRoots: [dir],
    };

    for await (const event of new MazzAgentLoop(registry).run({
      taskId: 'attachment-real-tool-agent-e2e',
      goal: 'Lis toute la pièce jointe et retourne une réponse référencée.',
      mode: 'ask',
      workspaceRoot: dir,
      selection,
      provider,
      tools: registry,
      maxIterations: 1,
      requiredAttachmentReads: [{ id: meta.id, totalCharacters: original.length, textSha256: meta.textSha256, initiallyReadCharacters: 0 }],
    })) events.push(event);

    const pages = events.filter((event) => event.type === 'tool_result' && event.toolName === 'attachments.read');
    assert.equal(pages.length, 3);
    assert.ok(pages.every((event) => event.type === 'tool_result' && event.success));
    const outputs = pages.map((event) => (event as Extract<AgentEvent, { type: 'tool_result' }>).output as { offset: number; length: number; text: string; done: boolean; offsetUnit: string; boundaryAdjusted: boolean });
    assert.deepEqual(outputs.map(({ offset }) => offset), [0, 99, 199]);
    assert.equal(outputs[0].boundaryAdjusted, true);
    assert.ok(outputs.every((page) => page.offsetUnit === 'utf16-code-unit'));
    assert.equal(outputs.map((page) => page.text).join(''), original);
    assert.equal(outputs.at(-1)?.done, true);
    const lastEvent = events.at(-1);
    assert.ok(lastEvent?.type === 'complete' && lastEvent.success);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session attachment provenance survives flush and a new store instance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-session-attachment-provenance-'));
  try {
    const attachment = await new AttachmentStore(path.join(dir, 'attachments')).add('source.md', Buffer.from('Persisted source provenance.'));
    const store = new SessionStore(dir);
    await store.load();
    const session = store.create({ projectRoot: dir, providerId: 'local', modelId: 'model.gguf', mode: 'ask' });
    const provenance = {
      id: attachment.id, name: attachment.name, sizeBytes: attachment.sizeBytes, kind: attachment.kind, chars: attachment.chars,
      sourceSha256: attachment.sourceSha256, textSha256: attachment.textSha256, extractionStatus: attachment.extractionStatus,
      offsetUnit: attachment.offsetUnit,
    };
    const turn = store.beginTurn(session.id, {
      id: 'turn-integrity', taskId: 'task-integrity', prompt: 'Inspect source.md', mode: 'ask',
      providerId: 'local', modelId: 'model.gguf', startedAt: Date.now(), attachments: [provenance],
    });
    store.endTurn(session.id, turn.id, 'completed', 'Finished');
    await store.flush(session.id);

    const reloaded = new SessionStore(dir);
    await reloaded.load();
    const persisted = reloaded.get(session.id)?.turns[0]?.attachments?.[0];
    assert.deepEqual(persisted, provenance);
    await reloaded.flush(session.id);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
