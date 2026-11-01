import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { setState } from '../../lib/store';
import type { StudioSettings } from '../../lib/types';
import { ForgePresetCard, slotPreset } from './ForgePreset';

describe('slotPreset', () => {
  it('keeps the per-slot context when switching to 4 slots', () => {
    expect(slotPreset({ parallel: 1, contextSize: 4096 }, 4)).toEqual({ parallel: 4, contextSize: 16384 });
  });
  it('caps at the validation maximum', () => {
    expect(slotPreset({ parallel: 1, contextSize: 131072 }, 4)).toEqual({ parallel: 4, contextSize: 262144 });
  });
  it('goes back to 1 slot with the per-slot context', () => {
    expect(slotPreset({ parallel: 4, contextSize: 16384 }, 1)).toEqual({ parallel: 1, contextSize: 4096 });
  });
  it('never goes below the validation minimum', () => {
    expect(slotPreset({ parallel: 8, contextSize: 256 }, 1)).toEqual({ parallel: 1, contextSize: 256 });
  });
});

describe('ForgePresetCard', () => {
  const render = (models: { parallel: number; contextSize: number }) => {
    setState({ settings: { models } as unknown as StudioSettings });
    return renderToStaticMarkup(<ForgePresetCard />);
  };
  it('offers the Forge preset with measured numbers from one slot', () => {
    const html = render({ parallel: 1, contextSize: 4096 });
    expect(html).toContain('Appliquer : 4 slots, contexte 16384');
    expect(html).toContain('Qwen3 0.6B');
    expect(html).toContain('forge benchmark 2026-10-25');
    expect(html).toContain('redémarré');
  });
  it('offers the way back to 1 slot when the preset is active', () => {
    expect(render({ parallel: 4, contextSize: 16384 })).toContain('Revenir à 1 slot (contexte 4096)');
  });
});
