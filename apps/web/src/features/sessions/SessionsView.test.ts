import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../lib/types';
import { fetchSessionForExport, normalizeSessionTitle, patchSessionMetadata, serializeSessionExport, sessionExportFilename } from './SessionsView';

afterEach(() => vi.unstubAllGlobals());

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's_export_1',
    title: 'Analyse du projet',
    projectRoot: 'D:\\projets\\mazz',
    createdAt: 100,
    updatedAt: 200,
    status: 'idle',
    archived: false,
    pinned: true,
    providerId: 'local',
    modelId: 'qwen.gguf',
    mode: 'agent',
    turns: [{
      id: 'turn-1',
      taskId: 'task-1',
      prompt: 'Inspecter le dépôt',
      mode: 'agent',
      providerId: 'local',
      modelId: 'qwen.gguf',
      startedAt: 110,
      status: 'completed',
      events: [],
      finalText: 'Trois modules trouvés.',
      telemetry: [],
    }],
    ...overrides,
  };
}

describe('SessionsView session actions', () => {
  it('normalizes non-empty names to the backend limit', () => {
    expect(normalizeSessionTitle('  Nouvelle analyse  ')).toBe('Nouvelle analyse');
    expect(normalizeSessionTitle('   ')).toBe('');
    expect(normalizeSessionTitle('x'.repeat(130))).toHaveLength(120);
  });

  it('uses a safe Windows-compatible JSON download name', () => {
    expect(sessionExportFilename('Compte rendu: été/automne? ')).toBe('Compte rendu- été-automne-.json');
    expect(sessionExportFilename('CON')).toBe('_CON.json');
    expect(sessionExportFilename('   ')).toBe('session.json');
  });

  it('persists a renamed or pinned session through the existing PATCH endpoint', async () => {
    const updated = sessionRecord({ title: 'Nouvelle analyse', pinned: false });
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ session: updated }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await patchSessionMetadata(updated.id, { title: updated.title, pinned: updated.pinned });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/s_export_1');
    expect(fetch.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ title: 'Nouvelle analyse', pinned: false });
    expect(result).toEqual(updated);
  });

  it('fetches the complete session record from GET and serializes the returned history unchanged', async () => {
    const record = sessionRecord();
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ session: record }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);

    const loaded = await fetchSessionForExport(record.id);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/s_export_1');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', body: undefined });
    expect(loaded).toEqual(record);
    expect(JSON.parse(serializeSessionExport(loaded))).toEqual(record);
    expect(JSON.parse(serializeSessionExport(loaded)).turns).toHaveLength(1);
  });

  it('refuses to export a summary or a record for a different session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: { ...sessionRecord(), turns: undefined } }), { status: 200 })));
    await expect(fetchSessionForExport('s_export_1')).rejects.toThrow('historique de session valide');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: sessionRecord({ id: 'another-session' }) }), { status: 200 })));
    await expect(fetchSessionForExport('s_export_1')).rejects.toThrow('historique de session valide');
  });
});
