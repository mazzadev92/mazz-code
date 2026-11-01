import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRun, startRun } from './agentRuns';

afterEach(() => vi.unstubAllGlobals());

function stubBrowserEvents(): void {
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal('CustomEvent', class extends Event {
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      super(type);
      this.detail = init?.detail;
    }
  });
}

function liveRunResponse(sessionId: string): Response {
  const meta = { taskId: `task-${sessionId}`, turnId: `turn-${sessionId}`, sessionId };
  const complete = { type: 'complete', success: true, timestamp: Date.now() };
  const stream = [
    `event: meta\ndata: ${JSON.stringify(meta)}\n\n`,
    `id: 0\ndata: ${JSON.stringify(complete)}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('startRun prompt attachment contract', () => {
  it('omits requiredPromptAttachmentId from the real run request for a normal prompt', async () => {
    stubBrowserEvents();
    const sessionId = 'session-normal-prompt-contract';
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/agent/run') return liveRunResponse(sessionId);
      return new Response(JSON.stringify(url.includes('/api/sessions') ? { sessions: [] } : { tasks: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);

    try {
      await startRun({ goal: 'Résume le projet.', mode: 'agent', providerId: 'llama-local', modelId: 'local.gguf' });
      const request = fetch.mock.calls.find(([input]) => String(input) === '/api/agent/run');
      expect(request).toBeDefined();
      const body = JSON.parse(String(request?.[1]?.body));
      expect(body.goal).toBe('Résume le projet.');
      expect(body).not.toHaveProperty('requiredPromptAttachmentId');
    } finally {
      clearRun(sessionId);
    }
  });

  it('sends the required long-prompt attachment id alongside its attachment id', async () => {
    stubBrowserEvents();
    const sessionId = 'session-long-prompt-contract';
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/agent/run') return liveRunResponse(sessionId);
      return new Response(JSON.stringify(url.includes('/api/sessions') ? { sessions: [] } : { tasks: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);

    try {
      await startRun({
        goal: 'Lire intégralement la demande jointe.',
        attachments: [{
          id: 'att_long_prompt', name: 'demande-utilisateur.txt', sizeBytes: 1024, kind: 'text', mime: 'text/plain', chars: 100_001,
          sourceSha256: 'source-hash', textSha256: 'text-hash', extractionStatus: 'complete', offsetUnit: 'utf16-code-unit',
        }],
        requiredPromptAttachmentId: 'att_long_prompt',
        mode: 'agent',
        providerId: 'llama-local',
        modelId: 'local.gguf',
        topP: 0.8,
        topK: 20,
        presencePenalty: 1.5,
      });
      const request = fetch.mock.calls.find(([input]) => String(input) === '/api/agent/run');
      expect(request).toBeDefined();
      const body = JSON.parse(String(request?.[1]?.body));
      expect(body.goal).toBe('Lire intégralement la demande jointe.');
      expect(body.attachments).toContain('att_long_prompt');
      expect(body.requiredPromptAttachmentId).toBe('att_long_prompt');
      expect(body.selection).toMatchObject({ topP: 0.8, topK: 20, presencePenalty: 1.5 });
    } finally {
      clearRun(sessionId);
    }
  });
});
