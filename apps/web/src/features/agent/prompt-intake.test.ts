import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AttachmentMeta } from '../../lib/types';
import { MAX_DIRECT_AGENT_GOAL_CHARS, prepareAgentSubmission, requiresDiskBackedPrompt, textForAgentSubmission } from './prompt-intake';

afterEach(() => vi.unstubAllGlobals());

const attachment = (overrides: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  id: 'att_prompt01', name: 'demande-utilisateur.txt', sizeBytes: 1, kind: 'text', mime: 'text/plain',
  chars: 100_001, sourceSha256: '0'.repeat(64), textSha256: '0'.repeat(64), extractionStatus: 'complete',
  offsetUnit: 'utf16-code-unit', ...overrides,
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const attachmentForPrompt = (text: string) => {
  const hash = sha256(text);
  return attachment({ chars: text.length, sizeBytes: Buffer.byteLength(text, 'utf8'), sourceSha256: hash, textSha256: hash });
};

describe('long agent prompt intake', () => {
  it('keeps prompts within the server goal limit inline', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const prompt = 'x'.repeat(MAX_DIRECT_AGENT_GOAL_CHARS);

    expect(requiresDiskBackedPrompt(prompt)).toBe(false);
    await expect(prepareAgentSubmission(prompt, [])).resolves.toEqual({ goal: prompt, attachments: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(textForAgentSubmission('  question courte  ')).toBe('question courte');
  });

  it('uploads every character of an oversized prompt to the attachment store and sends a read instruction', async () => {
    const prompt = `  Début 𝐀\n${'cahier des charges '.repeat(6000)}\n  `;
    expect(prompt.length).toBeGreaterThan(MAX_DIRECT_AGENT_GOAL_CHARS);
    let uploadedText = '';
    const meta = attachmentForPrompt(prompt);
    const ledger = {
      source: { id: 'prompt-att_prompt01@1', sourceId: 'prompt-att_prompt01', version: 1, sourceTextSha256: meta.textSha256, sourceUtf16Length: prompt.length, sourceLineCount: 3, attachmentId: meta.id },
      analysis: { method: 'deterministic_lexical', llmUsed: false, sourceRetainedCompletely: true, extractionCompleteness: 'not_semantically_exhaustive', semanticUnderstandingClaimed: false, blocksExamined: 1, candidateCount: 1, nonCandidateBlockCount: 0, qualificationCounts: { firm: 1, ambition: 0, optional: 0, unclear: 0 } },
      revision: 1,
    } as const;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/attachments?')) {
        uploadedText = await (init?.body as File).text();
        return new Response(JSON.stringify({ attachment: meta }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(ledger), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);

    const result = await prepareAgentSubmission(prompt, [], 'session-real-01');
    expect(uploadedText).toBe(prompt);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ attachmentId: meta.id, sessionId: 'session-real-01' });
    expect(result.attachments).toEqual([meta]);
    expect(result.requiredPromptAttachmentId).toBe(meta.id);
    expect(result.goal).toContain('attachments.read');
    expect(result.goal).toContain(meta.id);
    expect(result.goal).toContain(String(prompt.length));
    expect(result.goal).toContain(meta.textSha256);
    expect(result.goal).toContain('prompt.requirements.read');
    expect(result.goal).toContain('sourceId=prompt-att_prompt01');
    expect(result.goal).toContain('1 candidats');
    expect(result.goal).toContain('non exhaustif');
  });

  it('does not submit a long prompt when the real backend cannot verify its ledger registration', async () => {
    const prompt = 'x'.repeat(MAX_DIRECT_AGENT_GOAL_CHARS + 1);
    const meta = attachmentForPrompt(prompt);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/attachments?')) {
        await (init?.body as File).text();
        return new Response(JSON.stringify({ attachment: meta }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'registre indisponible' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(prepareAgentSubmission(prompt, [])).rejects.toThrow('registre indisponible');
  });

  it('refuses an upload whose extracted content or integrity hash does not match the original prompt', async () => {
    const prompt = 'x'.repeat(MAX_DIRECT_AGENT_GOAL_CHARS + 1);
    const mismatched = attachmentForPrompt(prompt);
    mismatched.textSha256 = 'f'.repeat(64);
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ attachment: mismatched }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(prepareAgentSubmission(prompt, [])).rejects.toThrow(/empreintes SHA-256 exacts/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a prompt attachment that reports partial extraction or a different UTF-16 length', async () => {
    const prompt = '𝐀'.repeat(MAX_DIRECT_AGENT_GOAL_CHARS / 2 + 1);
    const incomplete = attachmentForPrompt(prompt);
    incomplete.extractionStatus = 'partial';
    const fetch = vi.fn(async () => new Response(JSON.stringify({ attachment: incomplete }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(prepareAgentSubmission(prompt, [])).rejects.toThrow(/texte UTF-16/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains leading and trailing characters when a prompt moves to disk storage', () => {
    const prompt = `  \n${'x'.repeat(MAX_DIRECT_AGENT_GOAL_CHARS + 1)}\n  `;
    expect(textForAgentSubmission(prompt)).toBe(prompt);
  });

  it('refuses a long prompt when the turn already uses all attachment slots', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const prompt = 'x'.repeat(MAX_DIRECT_AGENT_GOAL_CHARS + 1);
    const existing = Array.from({ length: 50 }, (_, index) => attachment({ id: `att_${index}`, name: `file-${index}.txt` }));

    await expect(prepareAgentSubmission(prompt, existing)).rejects.toThrow(/déjà 50 fichiers/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
