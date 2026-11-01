import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AttachmentStore } from './attachments.js';
import { compilePrompt } from './prompt-compiler.js';
import { PromptLedgerConflictError, PromptLedgerIntegrityError, PromptLedgerStore, PromptRequirementsReadTool } from './prompt-ledger.js';

async function createFixture(prefix: string): Promise<{ root: string; attachments: AttachmentStore; ledgerPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const attachments = new AttachmentStore(path.join(root, 'attachments'));
  return { root, attachments, ledgerPath: path.join(root, 'ledger', 'requirements.json') };
}

test('ledger registers a real attachment, persists exact spans, hashes workspace identity, and reopens', async () => {
  const fixture = await createFixture('mazz-prompt-ledger-reopen-');
  try {
    const source = [
      '# Cahier —Test—',
      '',
      '- The store must keep the exact source passage 𝐀.',
      '- Optional: record an additional review note.',
      '- A later report could include a summary.',
    ].join('\r\n');
    const attachment = await fixture.attachments.add('specification.md', Buffer.from(source, 'utf8'));
    const compiled = compilePrompt(source, { sourceId: 'workspace-spec' });
    const ledger = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    const registered = await ledger.register(compiled, attachment.id, { workspaceRoot: fixture.root });

    assert.equal(registered.source.id, 'workspace-spec@1');
    assert.equal(registered.source.sourceTextSha256, compiled.sha256);
    assert.equal(registered.source.attachments[0].attachmentId, attachment.id);
    assert.equal(registered.source.attachments[0].sourceSha256, attachment.sourceSha256);
    assert.match(registered.source.workspaceId ?? '', /^[a-f0-9]{32}$/u);
    assert.equal(JSON.stringify(registered).includes(fixture.root), false, 'raw project path must not be stored');
    assert.ok(registered.requirements.length >= 3);
    for (const record of registered.requirements) {
      assert.equal(record.status, 'Candidate');
      assert.equal(record.sourceVersion, 1);
      assert.equal(record.sourceAttachmentId, attachment.id);
      assert.equal(record.sourceTextSha256, compiled.sha256);
      assert.equal(record.sourceOffsetUnit, 'utf16-code-unit');
      assert.equal(source.slice(record.sourceStart, record.sourceEnd), record.text);
      assert.equal(record.sourceEnd - record.sourceStart, record.text.length);
      assert.ok(record.sourceStartLine <= record.sourceEndLine);
    }
    assert.equal(registered.source.extractionCompleteness, 'not_semantically_exhaustive');
    assert.equal(registered.source.semanticReview, 'not_performed');

    const reopened = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    assert.deepEqual(await reopened.listRequirements(), registered.requirements);
    assert.deepEqual(await reopened.verifySources(), {
      sourcesChecked: 1,
      requirementsChecked: registered.requirements.length,
    });
    const stats = await reopened.stats();
    assert.equal(stats.requirements, registered.requirements.length);
    assert.equal(stats.sourceDocuments, 1);
    assert.equal(stats.sourceVersions, 1);
    assert.equal(stats.requirementsByStatus.Candidate, registered.requirements.length);
    assert.ok(stats.requirementsByQualification.firm >= 1);
    assert.equal(stats.extractionCompleteness, 'not_semantically_exhaustive');
    assert.equal(stats.semanticReview, 'not_performed_by_ledger');

    const duplicate = await reopened.register(compiled, attachment.id, { workspaceRoot: fixture.root });
    assert.equal(duplicate.revision, registered.revision, 're-registering the same immutable source is idempotent');
    assert.equal(duplicate.source.workspaceId, registered.source.workspaceId);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('source versions are append-only and preserve prior source-linked requirements', async () => {
  const fixture = await createFixture('mazz-prompt-ledger-versions-');
  try {
    const ledger = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    const firstText = '# Stable source\n- The cache must preserve exact bytes.\n';
    const firstAttachment = await fixture.attachments.add('spec-v1.md', Buffer.from(firstText));
    const first = await ledger.register(compilePrompt(firstText, { sourceId: 'same-spec' }), firstAttachment.id);

    const secondText = `${firstText}- The report must include the source version.\n`;
    const secondAttachment = await fixture.attachments.add('spec-v2.md', Buffer.from(secondText));
    const second = await ledger.register(compilePrompt(secondText, { sourceId: 'same-spec' }), secondAttachment.id);

    assert.equal(second.source.version, 2);
    assert.equal(second.source.id, 'same-spec@2');
    assert.notEqual(second.source.sourceTextSha256, first.source.sourceTextSha256);
    assert.ok(second.requirements.every((item) => item.sourceVersion === 2));
    const records = await ledger.listRequirements();
    assert.ok(records.some((item) => item.sourceVersionId === 'same-spec@1' && item.sourceAttachmentId === firstAttachment.id));
    assert.ok(records.some((item) => item.sourceVersionId === 'same-spec@2' && item.sourceAttachmentId === secondAttachment.id));
    const stats = await ledger.stats();
    assert.equal(stats.sourceDocuments, 1);
    assert.equal(stats.sourceVersions, 2);
    assert.equal(stats.requirements, first.requirements.length + second.requirements.length);
    assert.equal((await ledger.verifySources()).sourcesChecked, 2);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('status/evidence changes are atomic, versioned, persisted, and require hashed files for Tested and Verified', async () => {
  const fixture = await createFixture('mazz-prompt-ledger-evidence-');
  try {
    const source = '# Verification\n- The parser must preserve every source interval.\n';
    const attachment = await fixture.attachments.add('verification.md', Buffer.from(source));
    const ledger = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    const registration = await ledger.register(compilePrompt(source, { sourceId: 'verification-spec' }), attachment.id);
    const requirementId = registration.requirements[0].id;
    const evidenceDir = path.join(fixture.root, 'evidence');
    await fs.mkdir(evidenceDir);
    const testReport = path.join(evidenceDir, 'core-test-result.txt');
    const verificationNote = path.join(evidenceDir, 'review.txt');
    await fs.writeFile(testReport, 'node --test prompt-ledger.test.js\npass 1\n', 'utf8');
    await fs.writeFile(verificationNote, 'Reviewed the exact persisted span against the attached source.\n', 'utf8');

    let record = await ledger.transition(requirementId, 'Extracted', { expectedVersion: 1, actor: 'compiler-review' });
    record = await ledger.transition(requirementId, 'Confirmed', { expectedVersion: record.version });
    record = await ledger.transition(requirementId, 'Planned', { expectedVersion: record.version });
    record = await ledger.transition(requirementId, 'In progress', { expectedVersion: record.version });
    record = await ledger.transition(requirementId, 'Implemented', { expectedVersion: record.version });

    await assert.rejects(
      ledger.transition(requirementId, 'Tested', {
        expectedVersion: record.version,
        evidence: ['the test passed'] as unknown as [],
      }),
      /test_result.*fichier réel/u,
    );
    await assert.rejects(
      ledger.transition(requirementId, 'Tested', {
        expectedVersion: record.version,
        evidence: [{ kind: 'test_result', path: path.join(evidenceDir, 'missing.txt'), description: 'missing result' }],
      }),
      /ENOENT/u,
    );
    assert.equal((await ledger.getRequirement(requirementId))?.version, record.version, 'rejected evidence cannot partially advance state');

    record = await ledger.transition(requirementId, 'Tested', {
      expectedVersion: record.version,
      evidence: [{ kind: 'test_result', path: testReport, description: 'Core targeted test output' }],
    });
    assert.equal(record.status, 'Tested');
    assert.equal(record.evidence[0].integrity, 'file_bytes_hashed');
    assert.equal(record.evidence[0].path, testReport);
    assert.match(record.evidence[0].sha256, /^[a-f0-9]{64}$/u);

    record = await ledger.transition(requirementId, 'Verified', {
      expectedVersion: record.version,
      evidence: [{ kind: 'verification', path: verificationNote, description: 'Independent source-span review note' }],
    });
    assert.equal(record.status, 'Verified');
    assert.equal(record.version, 8);
    assert.deepEqual(await ledger.verifyEvidence(requirementId), { evidenceChecked: 2 });

    const history = await ledger.getHistory(requirementId);
    assert.equal(history.length, 8);
    assert.deepEqual(history.slice(-2).map((event) => [event.fromStatus, event.toStatus, event.recordVersion]), [
      ['Implemented', 'Tested', 7],
      ['Tested', 'Verified', 8],
    ]);
    assert.ok(history.at(-2)?.evidenceIds.length === 1);
    assert.ok(history.at(-1)?.evidenceIds.length === 1);

    const reopened = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    const persisted = await reopened.getRequirement(requirementId);
    assert.equal(persisted?.status, 'Verified');
    assert.equal(persisted?.version, 8);
    assert.equal(persisted?.evidence.length, 2);
    assert.deepEqual(await reopened.verifyEvidence(), { evidenceChecked: 2 });

    await fs.appendFile(testReport, 'tampered\n', 'utf8');
    await assert.rejects(reopened.verifyEvidence(), PromptLedgerIntegrityError);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('optimistic versions serialize concurrent transitions across store instances without lost updates', async () => {
  const fixture = await createFixture('mazz-prompt-ledger-concurrency-');
  try {
    const source = '# Concurrency\n- The registry must keep every committed transition.\n';
    const attachment = await fixture.attachments.add('concurrency.md', Buffer.from(source));
    const firstStore = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    const registered = await firstStore.register(compilePrompt(source, { sourceId: 'concurrency-spec' }), attachment.id);
    const requirementId = registered.requirements[0].id;
    const secondStore = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);

    const outcomes = await Promise.allSettled([
      firstStore.transition(requirementId, 'Extracted', { expectedVersion: 1, actor: 'writer-a' }),
      secondStore.transition(requirementId, 'Needs review', { expectedVersion: 1, actor: 'writer-b' }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof PromptLedgerConflictError);

    const reopened = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    const current = await reopened.getRequirement(requirementId);
    assert.ok(current);
    assert.equal(current.version, 2);
    assert.ok(['Extracted', 'Needs review'].includes(current.status));
    const history = await reopened.getHistory(requirementId);
    assert.equal(history.length, 2);
    assert.equal(history[1].recordVersion, 2);
    assert.equal((await reopened.stats()).revision, 2);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('ledger checksum and attachment byte/text integrity fail closed without overwriting corrupted data', async () => {
  const fixture = await createFixture('mazz-prompt-ledger-integrity-');
  try {
    const source = '# Integrity\n- The source must remain verifiable.\n';
    const attachment = await fixture.attachments.add('integrity.md', Buffer.from(source));
    const ledger = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    await ledger.register(compilePrompt(source, { sourceId: 'integrity-spec' }), attachment.id);
    await ledger.verifySources();

    const attachmentTextFile = path.join(fixture.root, 'attachments', attachment.id, 'text.txt');
    await fs.writeFile(attachmentTextFile, `${source}tampered`, 'utf8');
    await assert.rejects(ledger.verifySources(), /incomplet ou corrompu/u);
    await fs.writeFile(attachmentTextFile, source, 'utf8');

    const originalFile = path.join(fixture.root, 'attachments', attachment.id, 'original');
    await fs.writeFile(originalFile, Buffer.from(`${source}X`, 'utf8'));
    await assert.rejects(ledger.verifySources(), /incomplet ou corrompu/u);

    const rawBeforeTamper = await fs.readFile(fixture.ledgerPath, 'utf8');
    const envelope = JSON.parse(rawBeforeTamper) as { payload: { requirements: Array<{ status: string }> }; integrity: unknown };
    envelope.payload.requirements[0].status = 'Verified';
    const corrupted = JSON.stringify(envelope);
    await fs.writeFile(fixture.ledgerPath, corrupted, 'utf8');
    const reopened = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    await assert.rejects(reopened.stats(), PromptLedgerIntegrityError);
    assert.equal(await fs.readFile(fixture.ledgerPath, 'utf8'), corrupted, 'failed reads must not repair or overwrite corruption');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('prompt.requirements.read returns bounded source-linked pages only for the active workspace', async () => {
  const fixture = await createFixture('mazz-prompt-ledger-tool-');
  const otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-prompt-ledger-other-'));
  try {
    const text = [
      '# Source-backed requirements',
      '- The agent must preserve the first exact source interval.',
      '- The agent must preserve the second exact source interval.',
      '- The agent must preserve the third exact source interval.',
    ].join('\n');
    const attachment = await fixture.attachments.add('tool-spec.md', Buffer.from(text));
    const store = new PromptLedgerStore(fixture.ledgerPath, fixture.attachments);
    const registered = await store.register(compilePrompt(text, { sourceId: 'tool-spec' }), attachment.id, { workspaceRoot: fixture.root });
    assert.ok(registered.requirements.length >= 3);
    const tool = new PromptRequirementsReadTool(store);
    const context = (workspaceRoot: string) => ({
      taskId: 'prompt-ledger-tool-test', workspaceRoot, signal: new AbortController().signal,
      permissionLevel: 'read_only' as const, emitEvent: () => undefined,
    });

    const first = await tool.execute({ sourceId: 'tool-spec', offset: 0, limit: 2 }, context(fixture.root));
    assert.equal(first.success, true, first.error ?? 'première page indisponible');
    assert.equal((first.output as { total: number }).total, registered.requirements.length);
    assert.equal((first.output as { items: unknown[] }).items.length, 2);
    assert.equal((first.output as { nextOffset: number }).nextOffset, 2);
    assert.equal((first.output as { done: boolean }).done, false);

    const second = await tool.execute({ sourceId: 'tool-spec', offset: 2, limit: 2 }, context(fixture.root));
    assert.equal(second.success, true, second.error ?? 'seconde page indisponible');
    const secondPage = second.output as { items: Array<{ text: string; sourceStart: number; sourceEnd: number }>; done: boolean };
    assert.equal(secondPage.done, true);
    for (const item of [...(first.output as { items: Array<{ text: string; sourceStart: number; sourceEnd: number }> }).items, ...secondPage.items]) {
      assert.equal(text.slice(item.sourceStart, item.sourceEnd), item.text);
    }

    const isolated = await tool.execute({ sourceId: 'tool-spec' }, context(otherWorkspace));
    assert.equal(isolated.success, true, isolated.error ?? 'la requête isolée ne doit pas échouer');
    assert.equal((isolated.output as { total: number }).total, 0);
    const invalidPage = await tool.execute({ sourceId: 'tool-spec', limit: 201 }, context(fixture.root));
    assert.equal(invalidPage.success, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
    await fs.rm(otherWorkspace, { recursive: true, force: true });
  }
});

