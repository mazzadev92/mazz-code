import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AgentInspector, { CONTEXT_ALERT_PCT } from './AgentInspector';

describe('agent inspector context gauge', () => {
  it('alerts at the 75 % window threshold of spec 02', () => {
    expect(CONTEXT_ALERT_PCT).toBe(75);
  });

  it('shows no invented context metric when no session is selected', () => {
    // Act
    const html = renderToStaticMarkup(<AgentInspector />);
    // Assert
    expect(html).toContain('Aucune session sélectionnée');
    expect(html).not.toMatch(/545[\s.,]?800|347[\s.,]?300/);
  });
});
