// Pairwise judging for answers no test can check (an explanation, a README, a design choice).
// A small model is asked one narrow question at a time: "which of these two better meets this criterion?".
// The answer is grammar-constrained to "1", "2" or "=", each pair is judged several times with the order
// swapped (position bias cancels out), and candidates are ranked by their wins.
// References: pairwise is more stable than 1-10 scores; single-elimination tournaments (Arena-Lite) keep the
// number of comparisons linear when there are many candidates.
import type { IModelProvider } from '@mazz/providers';
import { wrapPrompt } from './forge.js';

export interface JudgeOptions {
  provider: IModelProvider;
  modelId: string;
  taskId: string;
  /** What "better" means, as one precise criterion ("states the exact return value", not "is better"). */
  criterion: string;
  /** The task or code the candidates answer. */
  context?: string;
  /** Judgements per pair, alternating the order; odd values avoid ties (default 3). */
  repeats?: number;
  temperature?: number;
  /** Above this many candidates, a single-elimination bracket replaces the round robin (default 6). */
  roundRobinMax?: number;
  signal?: AbortSignal;
}

export interface PairResult { a: number; b: number; winsA: number; winsB: number; ties: number }
export interface TournamentResult {
  /** Candidate indexes, best first. */
  ranking: number[];
  /** Wins + half ties, per candidate. */
  scores: number[];
  pairs: PairResult[];
  /** Model calls made. */
  calls: number;
}

export const VERDICT_GRAMMAR = 'root ::= "1" | "2" | "="';

function verdictPrompt(o: JudgeOptions, first: string, second: string): string {
  const instruction = [
    o.context ? `Task:\n${o.context}` : '',
    `Criterion: ${o.criterion}`,
    `Option 1:\n${first}`,
    `Option 2:\n${second}`,
    'Which option better meets the criterion? Answer 1, 2, or = if they are equal.',
  ].filter(Boolean).join('\n\n');
  return wrapPrompt(o.modelId, instruction, 'text', '').replace(/```text\n$/, 'Answer: ');
}

async function verdict(o: JudgeOptions, first: string, second: string): Promise<'1' | '2' | '='> {
  let text = '';
  for await (const ev of o.provider.completePrefix!(verdictPrompt(o, first, second), {
    modelId: o.modelId, taskId: o.taskId, temperature: o.temperature ?? 0.6, topP: 0.9, maxTokens: 2, grammar: VERDICT_GRAMMAR, signal: o.signal,
  })) {
    if (ev.type === 'token') text += ev.delta;
    else if (ev.type === 'error' && ev.fatal) throw new Error(ev.message);
  }
  const c = text.trim()[0];
  return c === '1' || c === '2' ? c : '=';
}

/** Judges one pair `repeats` times, swapping which candidate is shown first on every other call. */
export async function comparePair(o: JudgeOptions, candidates: readonly string[], a: number, b: number): Promise<PairResult> {
  if (!o.provider.completePrefix) throw new Error('Le fournisseur ne permet pas la génération contrainte (completePrefix).');
  const repeats = Math.max(1, o.repeats ?? 3);
  const votes = await Promise.all(Array.from({ length: repeats }, async (_, k) => {
    const swapped = k % 2 === 1;
    const v = await verdict(o, candidates[swapped ? b : a], candidates[swapped ? a : b]);
    if (v === '=') return 'tie';
    return (v === '1') !== swapped ? 'a' : 'b';
  }));
  return { a, b, winsA: votes.filter((v) => v === 'a').length, winsB: votes.filter((v) => v === 'b').length, ties: votes.filter((v) => v === 'tie').length };
}

/** Ranks candidates by pairwise verdicts: round robin when few, single elimination when many. */
export async function tournament(o: JudgeOptions, candidates: readonly string[]): Promise<TournamentResult> {
  const n = candidates.length;
  const scores = new Array<number>(n).fill(0);
  const pairs: PairResult[] = [];
  const repeats = Math.max(1, o.repeats ?? 3);
  const record = (p: PairResult) => {
    pairs.push(p);
    scores[p.a] += p.winsA + p.ties / 2;
    scores[p.b] += p.winsB + p.ties / 2;
  };
  if (n <= (o.roundRobinMax ?? 6)) {
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) record(await comparePair(o, candidates, a, b));
  } else {
    // Single elimination; a bye goes to the last candidate of an odd round. Ties keep the earlier candidate.
    let round = candidates.map((_, i) => i);
    while (round.length > 1) {
      const next: number[] = [];
      for (let i = 0; i + 1 < round.length; i += 2) {
        const p = await comparePair(o, candidates, round[i], round[i + 1]);
        record(p);
        next.push(p.winsB > p.winsA ? round[i + 1] : round[i]);
      }
      if (round.length % 2) next.push(round[round.length - 1]);
      round = next;
    }
  }
  const ranking = scores.map((s, i) => [s, i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]).map(([, i]) => i);
  return { ranking, scores, pairs, calls: pairs.length * repeats };
}
