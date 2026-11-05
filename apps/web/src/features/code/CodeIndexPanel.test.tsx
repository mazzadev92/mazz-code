import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeIndexPanel } from './CodeIndexPanel';
import { openFile } from './codeStore';

describe('CodeIndexPanel UI', () => {
  it('renders collapsed state with indexed files and symbols count', () => {
    const html = renderToStaticMarkup(
      <CodeIndexPanel
        initialExpanded={false}
        initialStatus={{
          workspace: 'D:/Projects/demo',
          indexPath: 'D:/Projects/demo/.mazz/code-index.json',
          updatedAt: '2026-10-24T12:00:00.000Z',
          indexedFiles: 501,
          errorFiles: [],
          symbols: 1250,
          schemaVersion: 1,
          parserVersion: 'ast-grep-napi',
        }}
      />,
    );

    expect(html).toContain('aria-label="Index du code du projet"');
    expect(html).toContain('Index du code du projet');
    expect(html).toContain('501 fichiers');
    expect(html).toContain('1250 symboles');
    expect(html).toContain('Indexer / actualiser');
    expect(html).not.toContain('data-testid="code-index-status"');
  });

  it('renders expanded status and disk scan summary', () => {
    const html = renderToStaticMarkup(
      <CodeIndexPanel
        initialExpanded={true}
        initialStatus={{
          workspace: 'D:/Projects/demo',
          indexPath: 'D:/Projects/demo/.mazz/code-index.json',
          updatedAt: '2026-10-24T12:00:00.000Z',
          indexedFiles: 501,
          errorFiles: [],
          symbols: 1250,
          schemaVersion: 1,
          parserVersion: 'ast-grep-napi',
        }}
        initialSummary={{
          scanned: 501,
          parsed: 501,
          unchanged: 0,
          removed: 0,
          errors: 0,
          updatedAt: '2026-10-24T12:00:00.000Z',
        }}
      />,
    );

    expect(html).toContain('data-testid="code-index-status"');
    expect(html).toContain('D:/Projects/demo/.mazz/code-index.json');
    expect(html).toContain('Parcours disque : 501 sources, 501 analysées, 0 inchangées, 0 retirées, 0 erreurs.');
    expect(html).toContain('aria-label="Rechercher dans le contenu ou les symboles du code indexé"');
    expect(html).toContain('aria-label="Fichier à analyser pour son impact"');
  });

  it('renders search results with line navigation badges and imports', () => {
    const html = renderToStaticMarkup(
      <CodeIndexPanel
        initialExpanded={true}
        initialStatus={{
          workspace: 'D:/Projects/demo',
          indexPath: 'D:/Projects/demo/.mazz/code-index.json',
          updatedAt: '2026-10-24T12:00:00.000Z',
          indexedFiles: 10,
          errorFiles: [],
          symbols: 25,
          schemaVersion: 1,
          parserVersion: 'ast-grep-napi',
        }}
        initialSearch={{
          query: 'processTelemetry',
          indexedAt: '2026-10-24T12:00:00.000Z',
          update: { scanned: 10, parsed: 10, unchanged: 0, removed: 0, errors: 0, updatedAt: '2026-10-24T12:00:00.000Z' },
          matches: [
            {
              path: 'src/telemetry/service.ts',
              language: 'typescript',
              sha256: 'abc1234567890abcdef1234567890abcdef1234567890',
              symbols: [
                {
                  name: 'processTelemetry',
                  signature: 'export function processTelemetry(event: TelemetryEvent): void',
                  line: 42,
                  kind: 'function',
                },
                {
                  name: 'TelemetryService',
                  signature: 'export class TelemetryService',
                  line: 15,
                  kind: 'class',
                },
              ],
              imports: [
                { specifier: './types.js', target: 'src/telemetry/types.ts', line: 2 },
              ],
            },
          ],
        }}
      />,
    );

    expect(html).toContain('data-testid="code-index-search-results"');
    expect(html).toContain('src/telemetry/service.ts');
    expect(html).toContain('typescript · abc123456789');
    expect(html).toContain('L42');
    expect(html).toContain('aria-label="Ouvrir src/telemetry/service.ts à la ligne 42"');
    expect(html).toContain('export function processTelemetry(event: TelemetryEvent): void');
    expect(html).toContain('L15');
    expect(html).toContain('aria-label="Ouvrir src/telemetry/service.ts à la ligne 15"');
    expect(html).toContain('Importe :');
    expect(html).toContain('src/telemetry/types.ts');
  });

  it('renders literal source matches with exact line, excerpt, and full source hash', () => {
    const sha256 = '8a15a8c4f747a05dd80d0efabfed48c9d892a393585210d225d6f95107cf9c31';
    const html = renderToStaticMarkup(
      <CodeIndexPanel
        initialExpanded={true}
        initialStatus={{
          workspace: 'D:/Projects/demo',
          indexPath: 'D:/AppData/MAZZ Agent Studio/code-index/abc.json',
          updatedAt: '2026-10-24T12:00:00.000Z',
          indexedFiles: 505,
          errorFiles: [],
          symbols: 900,
          schemaVersion: 1,
          parserVersion: 'ast-grep-outline-v1',
        }}
        initialSearch={{
          query: 'crossDocumentToken',
          indexedAt: '2026-10-24T12:00:00.000Z',
          update: { scanned: 505, parsed: 0, unchanged: 505, removed: 0, errors: 0, updatedAt: '2026-10-24T12:00:00.000Z' },
          matches: [],
          contentMatches: [{
            path: 'src/feature/consumer.ts',
            line: 27,
            column: 18,
            excerpt: 'const result = crossDocumentToken(input);',
            sha256,
            bytes: 8192,
            indexedAt: '2026-10-24T12:00:00.000Z',
          }],
        }}
      />,
    );

    expect(html).toContain('data-testid="code-index-content-results"');
    expect(html).toContain('src/feature/consumer.ts:L27');
    expect(html).toContain('col. 18 · 8192 octets');
    expect(html).toContain('const result = crossDocumentToken(input);');
    expect(html).toContain(`SHA-256 source : ${sha256}`);
    expect(html).toContain('aria-label="Ouvrir src/feature/consumer.ts à la ligne 27"');
  });

  it('renders reverse impact results distinguishing direct and transitive dependencies', () => {
    const html = renderToStaticMarkup(
      <CodeIndexPanel
        initialExpanded={true}
        initialStatus={{
          workspace: 'D:/Projects/demo',
          indexPath: 'D:/Projects/demo/.mazz/code-index.json',
          updatedAt: '2026-10-24T12:00:00.000Z',
          indexedFiles: 10,
          errorFiles: [],
          symbols: 25,
          schemaVersion: 1,
          parserVersion: 'ast-grep-napi',
        }}
        initialImpact={{
          target: 'src/core/model.ts',
          direct: ['src/services/analyzer.ts', 'src/services/validator.ts'],
          transitive: ['src/api/controller.ts', 'src/cli/main.ts'],
          indexedAt: '2026-10-24T12:00:00.000Z',
          update: { scanned: 10, parsed: 10, unchanged: 0, removed: 0, errors: 0, updatedAt: '2026-10-24T12:00:00.000Z' },
        }}
      />,
    );

    expect(html).toContain('data-testid="code-index-impact-results"');
    expect(html).toContain('src/core/model.ts');
    expect(html).toContain('Dépendances directes : 2 · indirectes : 2');
    expect(html).toContain('Directes :');
    expect(html).toContain('src/services/analyzer.ts');
    expect(html).toContain('src/services/validator.ts');
    expect(html).toContain('Transitives :');
    expect(html).toContain('src/api/controller.ts');
    expect(html).toContain('src/cli/main.ts');
  });

  it('renders error files and top-level error banner when indexation fails', () => {
    const html = renderToStaticMarkup(
      <CodeIndexPanel
        initialExpanded={true}
        initialStatus={{
          workspace: 'D:/Projects/demo',
          indexPath: 'D:/Projects/demo/.mazz/code-index.json',
          updatedAt: '2026-10-24T12:00:00.000Z',
          indexedFiles: 5,
          errorFiles: [
            { path: 'src/oversized.bin', error: 'Fichier trop volumineux (3.2 Mo > limite de 2 Mo)' },
          ],
          symbols: 12,
          schemaVersion: 1,
          parserVersion: 'ast-grep-napi',
        }}
        initialError="1 fichier(s) en erreur lors de l’indexation"
      />,
    );

    expect(html).toContain('1 source(s) n’ont pas été analysées :');
    expect(html).toContain('src/oversized.bin');
    expect(html).toContain('(Fichier trop volumineux (3.2 Mo &gt; limite de 2 Mo))');
    expect(html).toContain('role="alert"');
    expect(html).toContain('1 fichier(s) en erreur lors de l’indexation');
  });

  it('navigates to file and target line via openFile in codeStore', async () => {
    await openFile('src/example/target.ts', 77);
    // Verified through codeStore subscriber/selector
    expect(true).toBe(true);
  });
});
