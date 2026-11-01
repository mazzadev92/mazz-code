import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const laef = readFileSync(new URL('./mazz-tokens.css', import.meta.url), 'utf8');

function token(source: string, name: string): string | undefined {
  return source.match(new RegExp(`${name}:\s*([^;]+);`))?.[1].trim();
}

describe('spec 02 design tokens', () => {
  it('declares the canonical Bioforge Leaf tokens with the spec values', () => {
    expect(token(css, '--mazz-bg-root')).toBe('#0D0D0F');
    expect(token(css, '--mazz-bg-surface-2')).toBe('#1E232B');
    expect(token(css, '--mazz-brand-primary')).toBe('#10B981');
    expect(token(css, '--mazz-brand-accent')).toBe('#06B6D4');
    expect(token(css, '--mazz-brand-violet')).toBe('#8B5CF6');
    expect(token(css, '--mazz-row-height')).toBe('28px');
    expect(token(css, '--mazz-radius-card')).toBe('6px');
  });

  it('aliases app density tokens to the spec instead of duplicating values', () => {
    expect(token(css, '--row-h')).toBe('var(--mazz-row-height)');
    expect(token(css, '--radius-sm')).toBe('var(--mazz-radius-card)');
  });

  it('keeps the generated Laef tokens intact', () => {
    expect(token(laef, '--mazz-obsidian')).toBe('#090D0A');
    expect(token(laef, '--mazz-copper')).toBe('#A87D54');
  });
});
