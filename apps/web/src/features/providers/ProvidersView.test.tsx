import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ProvidersView from './ProvidersView';

describe('MAZZ Control AI router section', () => {
  it('keeps the router inside the existing providers page and renders the temporary masked test-key field', () => {
    const html = renderToStaticMarkup(<ProvidersView />);

    expect(html).toContain('Routeur MAZZ Control');
    expect(html).toContain('Clé temporaire (facultatif)');
    expect(html).toContain('type="password"');
    expect(html).toContain('jamais enregistrée');
    expect(html).not.toContain('Router MAZZ Control');
  });
});
