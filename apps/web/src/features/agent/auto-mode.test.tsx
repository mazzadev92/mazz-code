import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../../../../../packages/core/src/settings.js';
import { AGENT_MODE_OPTIONS, isAgentMode } from '../../lib/types';
import { AGENT_DEFAULT_MODE_OPTIONS } from '../settings/SettingsView';
import { Composer } from './Composer';

describe('Auto agent mode', () => {
  it('is an actual Composer option and is selected when the session uses it', () => {
    const html = renderToStaticMarkup(
      <Composer
        draftKey="auto-mode-test"
        mode="auto"
        onModeChange={() => undefined}
        model={null}
        onModelChange={() => undefined}
        running={false}
        onSubmit={() => undefined}
        onStop={() => undefined}
        history={[]}
      />,
    );

    expect(html).toContain('role="radiogroup" aria-label="Mode de l’agent"');
    expect(html).toMatch(/<button(?=[^>]*role="radio")(?=[^>]*aria-checked="true")(?=[^>]*title="Exécute les opérations prévues[^\"]*")[^>]*>Auto<\/button>/);
    expect(AGENT_MODE_OPTIONS.map(({ value }) => value)).toEqual(['ask', 'plan', 'agent', 'auto', 'review', 'forge']);
    expect(AGENT_DEFAULT_MODE_OPTIONS).toEqual(AGENT_MODE_OPTIONS.map(({ value, label }) => ({ value, label })));
    expect(isAgentMode('auto')).toBe(true);
    expect(isAgentMode('unrestricted')).toBe(false);
  });

  it('persists and restores Auto as the default without changing permission policy', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-auto-settings-'));
    try {
      const store = new SettingsStore(dataDir);
      await store.load();
      const updated = await store.update({
        agent: { defaultMode: 'auto' },
        permissions: { write: 'deny', delete: 'ask', terminal: 'deny' },
      });
      expect(updated.errors).toEqual([]);
      expect(updated.settings.agent.defaultMode).toBe('auto');

      const bytes = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8');
      const persisted = JSON.parse(bytes);
      expect(persisted.agent.defaultMode).toBe('auto');
      expect(persisted.permissions).toMatchObject({ write: 'deny', delete: 'ask', terminal: 'deny' });

      const restored = await new SettingsStore(dataDir).load();
      expect(restored.agent.defaultMode).toBe('auto');
      expect(restored.permissions).toMatchObject({ write: 'deny', delete: 'ask', terminal: 'deny' });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
