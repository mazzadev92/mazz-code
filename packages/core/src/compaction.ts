import type { ChatMessage } from '@mazz/shared';

/**
 * Context compaction rules (spec 03b §4.1): trigger at 75 % of the model window, keep the last 8 turns
 * verbatim, never separate a tool call from its result, and summarise into five fixed sections.
 */

export const COMPACT_TRIGGER_RATIO = 0.75;
export const COMPACT_KEEP_TURNS = 8;
export const COMPACT_SUMMARY_HEADER = '[CONVERSATION COMPACTÉE — RÉSUMÉ D’ÉTAT DU HARNAIS]';
export const COMPACT_SECTIONS = ['Objectif Principal', 'Fichiers Modifiés', 'Décisions Prises', 'Erreurs Résolues', 'Prochaine Étape'] as const;

export const COMPACT_SYSTEM_PROMPT = [
  'Tu résumes une conversation de développement pour qu’un assistant puisse la reprendre.',
  `Réponds exactement dans ce format, en français, sans préambule :\n${COMPACT_SUMMARY_HEADER}`,
  ...COMPACT_SECTIONS.map((section, i) => `${i + 1}. ${section} : …`),
  'Fichiers modifiés : chemins et nature du changement, jamais leur contenu. « aucun » si une rubrique est vide.',
].join('\n');

/** True when the estimated prompt reaches the trigger ratio of the context window. */
export function shouldCompact(estimatedTokens: number, contextWindow: number, ratio = COMPACT_TRIGGER_RATIO): boolean {
  if (!Number.isFinite(estimatedTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  return estimatedTokens >= contextWindow * ratio;
}

/**
 * Index where the verbatim tail starts: the last `keepTurns` user turns are kept, and the cut moves back
 * while it would leave a tool result without the assistant message that called it.
 */
export function compactionCutIndex(messages: readonly ChatMessage[], keepTurns = COMPACT_KEEP_TURNS): number {
  const userIndexes = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  if (userIndexes.length <= keepTurns) return 0;
  let cut = userIndexes[userIndexes.length - keepTurns];
  while (cut > 0 && messages[cut].role === 'tool') cut--;
  // A tool result anywhere in the tail must find its call in the tail as well.
  const tailIds = () => new Set(messages.slice(cut).flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []));
  for (let ids = tailIds(); messages.slice(cut).some((m) => m.role === 'tool' && m.toolCallId && !ids.has(m.toolCallId)); ids = tailIds()) {
    const callIndex = messages.findIndex((m) => m.toolCalls?.some((c) => messages.slice(cut).some((t) => t.toolCallId === c.id)));
    if (callIndex < 0 || callIndex >= cut) break;
    cut = callIndex;
  }
  return cut;
}

/** Checks that a summary has the header and the five numbered sections, in order. */
export function isStructuredSummary(summary: string): boolean {
  if (!summary.includes(COMPACT_SUMMARY_HEADER)) return false;
  let from = summary.indexOf(COMPACT_SUMMARY_HEADER);
  for (const [i, section] of COMPACT_SECTIONS.entries()) {
    const at = summary.indexOf(`${i + 1}. ${section}`, from);
    if (at < 0) return false;
    from = at;
  }
  return true;
}
