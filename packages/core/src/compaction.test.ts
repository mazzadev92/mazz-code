import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ChatMessage } from '@mazz/shared';
import { COMPACT_KEEP_TURNS, COMPACT_SECTIONS, COMPACT_SUMMARY_HEADER, COMPACT_SYSTEM_PROMPT, compactionCutIndex, isStructuredSummary, shouldCompact } from './compaction.js';

const turn = (i: number): ChatMessage[] => [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: `r${i}` }];

test('compaction_trigger_firesAt75PercentOfWindow', () => {
  // Arrange / Act / Assert: 12 288 tokens on a 16k window is the threshold of the spec.
  assert.equal(shouldCompact(12_287, 16_384), false);
  assert.equal(shouldCompact(12_288, 16_384), true);
  assert.equal(shouldCompact(5_000, 0), false);
});

test('compaction_cut_keepsLast8TurnsVerbatim', () => {
  // Arrange
  const messages = Array.from({ length: 12 }, (_, i) => turn(i)).flat();
  // Act
  const cut = compactionCutIndex(messages);
  // Assert
  assert.equal(COMPACT_KEEP_TURNS, 8);
  assert.deepEqual(messages.slice(cut).filter((m) => m.role === 'user').map((m) => m.content), ['q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11']);
});

test('compaction_cut_neverSeparatesToolCallFromItsResult', () => {
  // Arrange: the call of turn 3 is answered after the user message that opens the kept tail.
  const messages: ChatMessage[] = [
    ...turn(0), ...turn(1), ...turn(2),
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'a.ts' } }] },
    { role: 'user', content: 'q4 (interjection)' },
    { role: 'tool', toolCallId: 'c1', content: 'contenu' },
    ...Array.from({ length: 7 }, (_, i) => turn(5 + i)).flat(),
  ];
  // Act
  const cut = compactionCutIndex(messages);
  // Assert
  const tail = messages.slice(cut);
  assert.ok(tail.some((m) => m.toolCalls?.some((c) => c.id === 'c1')), 'the call stays with its result');
  assert.ok(tail.some((m) => m.toolCallId === 'c1'));
});

test('compaction_summary_requiresHeaderAndFiveSectionsInOrder', () => {
  // Arrange
  const good = [COMPACT_SUMMARY_HEADER, ...COMPACT_SECTIONS.map((s, i) => `${i + 1}. ${s} : x`)].join('\n');
  const swapped = [COMPACT_SUMMARY_HEADER, ...[...COMPACT_SECTIONS].reverse().map((s, i) => `${i + 1}. ${s} : x`)].join('\n');
  // Act / Assert
  assert.equal(isStructuredSummary(good), true);
  assert.equal(isStructuredSummary(swapped), false);
  assert.equal(isStructuredSummary('résumé libre'), false);
  for (const section of COMPACT_SECTIONS) assert.ok(COMPACT_SYSTEM_PROMPT.includes(section));
});
