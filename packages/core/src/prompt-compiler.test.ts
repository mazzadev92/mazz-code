import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compilePrompt } from './prompt-compiler.js';

test('compilePrompt preserves exact Unicode source and UTF-16 spans across CRLF sections and lists', () => {
  const source = [
    '# Project —Test—',
    '',
    '## Firm requirements',
    '- The original prompt must remain byte-for-byte represented in the stored string —Core—.',
    '  Keep this continuation with its parent list item.',
    '',
    '## Proposed direction',
    'The system could index sections before asking a small local model to reason.',
    '',
    '### Optional work',
    '- Optional: add a second parser if the primary parser cannot retain tables.',
    '',
  ].join('\r\n');

  const compiled = compilePrompt(source, { sourceId: 'unicode-fixture' });
  const firm = compiled.candidates.find((candidate) => candidate.text.startsWith('- The original prompt'));
  const ambition = compiled.candidates.find((candidate) => candidate.text.startsWith('The system could'));
  const optional = compiled.candidates.find((candidate) => candidate.text.startsWith('- Optional:'));

  assert.ok(firm);
  assert.ok(ambition);
  assert.ok(optional);
  assert.equal(compiled.sourceText, source);
  assert.equal(compiled.source.utf16Length, source.length);
  assert.equal(compiled.sha256, createHash('sha256').update(source, 'utf8').digest('hex'));
  assert.equal(compiled.hashEncoding, 'UTF-8');
  assert.equal(compiled.source.lineEndingCounts.crlf, 11);
  assert.equal(compiled.source.lineEndingCounts.lf, 0);
  assert.equal(source.slice(firm.startOffset, firm.endOffset), firm.text);
  assert.equal(firm.startOffset, source.indexOf('- The original prompt'));
  assert.equal(firm.endLine, 5);
  assert.ok(firm.text.includes('\r\n  Keep this continuation'));
  assert.equal(firm.qualification.category, 'firm');
  assert.equal(ambition.qualification.category, 'ambition');
  assert.equal(optional.qualification.category, 'optional');
  assert.deepEqual(firm.sectionPath, ['Project —Test—', 'Firm requirements']);
  assert.deepEqual(optional.sectionPath, ['Project —Test—', 'Proposed direction', 'Optional work']);
  assert.equal(compiled.sections.find((section) => section.title === 'Optional work')?.parentSectionId,
    compiled.sections.find((section) => section.title === 'Proposed direction')?.id);
  assert.equal(compiled.analysis.llmUsed, false);
  assert.equal(compiled.analysis.semanticUnderstandingClaimed, false);
  assert.equal(compiled.analysis.extractionCompleteness, 'not_semantically_exhaustive');
});

test('compilePrompt records only explicit requirement dependencies and keeps citations separate', () => {
  const source = [
    '## Dependency graph',
    '- Implement report output. It depends on REQ-0007 and see section 3.2.',
    '- The notes mention REQ-0008, but do not say it is a prerequisite.',
  ].join('\n');

  const compiled = compilePrompt(source);
  const dependent = compiled.candidates.find((candidate) => candidate.text.includes('depends on'));
  const citationOnly = compiled.candidates.find((candidate) => candidate.text.includes('mention REQ-0008'));

  assert.ok(dependent);
  assert.ok(citationOnly);
  assert.deepEqual(dependent.dependencies.map((reference) => reference.target), ['REQ-0007']);
  assert.deepEqual(dependent.references.map((reference) => [reference.target, reference.relation]), [
    ['REQ-0007', 'dependency'],
    ['section 3.2', 'citation'],
  ]);
  assert.deepEqual(citationOnly.dependencies, []);
  assert.equal(citationOnly.references[0]?.target, 'REQ-0008');
  assert.equal(citationOnly.references[0]?.relation, 'citation');
  assert.equal(compiled.analysis.dependencyPolicy, 'explicit_reference_only');
});

test('candidate IDs are deterministic for an identical document and change with its content hash', () => {
  const text = '# Stable\n- The source must be retained.\n';
  const first = compilePrompt(text, { sourceId: 'task/spec' });
  const second = compilePrompt(text, { sourceId: 'task/spec' });
  const changed = compilePrompt(`${text}extra`, { sourceId: 'task/spec' });

  assert.equal(first.id, 'task-spec');
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.candidates.map((item) => item.id), second.candidates.map((item) => item.id));
  assert.notEqual(first.sha256, changed.sha256);
  assert.notEqual(first.candidates[0]?.id, changed.candidates[0]?.id);
});

test('qualifications report their lexical evidence and leave unmarked candidates unclear', () => {
  const source = [
    '- Never send the project text outside the machine.',
    '- It should preserve the selected section during processing.',
    '- A second parser is optional when a document format requires it.',
    '- Include the archive path when useful.',
  ].join('\n');
  const compiled = compilePrompt(source);

  assert.deepEqual(compiled.candidates.map((item) => item.qualification.category), [
    'firm', 'ambition', 'optional', 'unclear',
  ]);
  assert.ok(compiled.candidates[0].qualification.signals.includes('Never'));
  assert.ok(compiled.candidates[1].qualification.signals.includes('should'));
  assert.ok(compiled.candidates[2].qualification.signals.includes('optional'));
  assert.match(compiled.candidates[3].qualification.reasons.join(' '), /remains unclear/);
  assert.deepEqual(compiled.analysis.qualificationCounts, { firm: 1, ambition: 1, optional: 1, unclear: 1 });
});

test('compilePrompt supports a 50,000-word input without truncating or summarizing the source', () => {
  const body = `${'ordinary '.repeat(49_999)}The final section must remain searchable.`;
  const source = `# Long specification\n${body}`;
  const compiled = compilePrompt(source);

  assert.equal(compiled.sourceText, source);
  assert.equal(compiled.source.utf16Length, source.length);
  assert.equal(compiled.sha256, createHash('sha256').update(source, 'utf8').digest('hex'));
  assert.ok(compiled.candidates.some((candidate) => candidate.text === body));
  assert.equal(compiled.analysis.sourceRetainedCompletely, true);
  assert.equal(compiled.analysis.llmUsed, false);
  assert.equal(compiled.analysis.extractionCompleteness, 'not_semantically_exhaustive');
});

test('empty, plain, Unicode, and mixed line endings have stable physical line accounting', () => {
  const empty = compilePrompt('');
  assert.equal(empty.sourceText, '');
  assert.equal(empty.source.utf16Length, 0);
  assert.equal(empty.source.lineCount, 1);
  assert.equal(empty.candidates.length, 0);

  const mixed = compilePrompt('Intro —Part—\n- Store this exactly.\r\n## Tail\rDone');
  const candidate = mixed.candidates[0];
  assert.ok(candidate);
  assert.equal(mixed.source.lineEndingCounts.lf, 1);
  assert.equal(mixed.source.lineEndingCounts.crlf, 1);
  assert.equal(mixed.source.lineEndingCounts.cr, 1);
  assert.equal(mixed.source.lineCount, 4);
  assert.equal(candidate.startLine, 2);
  assert.equal(mixed.sourceText.slice(candidate.startOffset, candidate.endOffset), candidate.text);
});

test('explicit section references are not turned into requirements or inferred dependencies', () => {
  const source = 'The implementation must follow section 2.1; keep the text as written.';
  const compiled = compilePrompt(source);
  const candidate = compiled.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.qualification.category, 'firm');
  assert.deepEqual(candidate.dependencies, []);
  assert.equal(candidate.references.length, 1);
  assert.equal(candidate.references[0].target, 'section 2.1');
  assert.equal(candidate.references[0].relation, 'citation');
});
