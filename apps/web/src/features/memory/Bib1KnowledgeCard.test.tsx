import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { knowledgeApi, knowledgeTrust, normalizeKnowledgeContext, type KnowledgeContext } from '../../lib/knowledge';
import { KnowledgeResults } from './Bib1KnowledgeCard';

afterEach(() => vi.unstubAllGlobals());

describe('Bib1 client and citations', () => {
  it('uses same-origin status and bounded manual-context routes', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await knowledgeApi.status();
    await knowledgeApi.context('  addition fractions  ');
    expect(fetch.mock.calls[0][0]).toBe('/api/knowledge');
    expect(fetch.mock.calls[1][0]).toBe('/api/knowledge/context');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ query: 'addition fractions' });
  });

  it('never promotes imported or unknown source states to verified', () => {
    expect(knowledgeTrust('verified').verified).toBe(true);
    expect(knowledgeTrust('source_imported')).toEqual({ label: 'Source importée, non revue', verified: false });
    expect(knowledgeTrust('external_unreviewed').verified).toBe(false);
    expect(knowledgeTrust('published').verified).toBe(false);
  });

  it('accepts the Studio bridge response and retains a shared bounded context for citations', () => {
    const normalized = normalizeKnowledgeContext({ result: { context: 'Texte récupéré [1]', citations: [{ id: 'mazz.test', path: 'note.md', title: 'Note', status: 'source_imported', line: 2 }], methods: [], warnings: ['Source non revue'] } });
    expect(normalized.status).toBe('ok');
    expect(normalized.data?.knowledge?.[0].body).toBe('');
    expect(normalized.data?.context?.text).toBe('Texte récupéré [1]');
    expect(renderToStaticMarkup(<KnowledgeResults result={normalized} />)).toContain('Contexte commun aux références');
    expect(normalizeKnowledgeContext(normalized)).toBe(normalized);
  });

  it('renders clickable citation details and escapes untrusted document text', () => {
    const result: KnowledgeContext = { schema_version: '1.0', status: 'ok', data: { knowledge: [{ id: 'mazz.example', title: 'Test', path: 'note.md', absolute_path: 'D:\\Bib1\\note.md', line: 12, body: '<script>alert(1)</script>', status: 'external_unreviewed', sources: ['source.id'] }] } };
    const html = renderToStaticMarkup(<KnowledgeResults result={result} />);
    expect(html).toContain('<summary');
    expect(html).toContain('note.md:12');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="file:');
    expect(html).toContain('Document externe, non revu');
  });

  it('states absent evidence and permission failures explicitly', () => {
    const empty = renderToStaticMarkup(<KnowledgeResults result={{ schema_version: '1.0', status: 'no_evidence', data: null }} />);
    expect(empty).toContain('Aucun passage pertinent');
    const denied = renderToStaticMarkup(<KnowledgeResults result={{ schema_version: '1.0', status: 'awaiting_permission', data: null, warnings: ['Permission requise'] }} />);
    expect(denied).toContain('role="alert"');
    expect(denied).toContain('Permission requise');
  });
});
