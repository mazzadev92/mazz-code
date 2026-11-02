import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AgentInspector, { CONTEXT_ALERT_PCT, contextLimitFor } from './AgentInspector';

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

describe('context limit per backend', () => {
  it('uses the measured --ctx-size for the local engine and labels spec windows as such', () => {
    // Act
    const local = contextLimitFor({ providerId: 'llama-local', modelId: 'any.gguf' }, 8192);
    const modal = contextLimitFor({ providerId: 'mazz-cloud', modelId: 'Qwen2.5-Coder-32B-Instruct-AWQ' }, 8192);
    const base = contextLimitFor({ providerId: 'mazz-cloud', modelId: 'Mazz-Technos-Base-4B-Abliterated.Q4_K_M' }, undefined);
    const unknown = contextLimitFor({ providerId: 'groq-api', modelId: 'llama-3.3-70b-versatile' }, 8192);
    // Assert
    expect(local).toEqual({ limit: 8192, source: 'runtime', label: 'llama-server (--ctx-size)' });
    expect(modal).toEqual({ limit: 32_768, source: 'spec', label: 'Modal 32B' });
    expect(base).toEqual({ limit: 16_384, source: 'spec', label: 'Base-4B' });
    expect(unknown).toBeUndefined();
  });
});