import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusIndicator, toolIndicatorKind } from './StatusIndicators';
import { Spinner } from '../../components/ui';

describe('Laef status indicators and brand spinner', () => {
  it('picks the figure from the real tool name', () => {
    expect(toolIndicatorKind('code.search')).toBe('search');
    expect(toolIndicatorKind('memory.recall')).toBe('memory');
    expect(toolIndicatorKind('terminal.run')).toBe('tool');
  });

  it('is decorative, uses tokens, and only moves while active', () => {
    const idle = renderToStaticMarkup(<StatusIndicator kind="thinking" />);
    expect(idle).toContain('aria-hidden="true"');
    expect(idle).toContain('var(--mazz-living-green)');
    expect(idle).not.toContain('seed-spin');
    expect(renderToStaticMarkup(<StatusIndicator kind="thinking" active />)).toContain('seed-spin');
    expect(renderToStaticMarkup(<StatusIndicator kind="error" />)).toContain('var(--mazz-copper)');
  });

  it('renders the SeedSpinner as the brand variant of Spinner', () => {
    const html = renderToStaticMarkup(<Spinner variant="brand" label="Chargement de la vue" />);
    expect(html).toContain('role="status" aria-label="Chargement de la vue"');
    expect(html).toContain('seed-spin');
    expect(html).toContain('var(--mazz-champagne)');
    expect(renderToStaticMarkup(<Spinner />)).toContain('class="spinner');
  });
});
