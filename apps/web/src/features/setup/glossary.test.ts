import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GLOSSARY } from './glossary';

const dir = dirname(fileURLToPath(import.meta.url));

describe('glossaire', () => {
  it('chaque définition est renseignée', () => {
    for (const [id, e] of Object.entries(GLOSSARY)) {
      expect(e.label.trim(), id).not.toBe('');
      expect(e.text.trim().length, id).toBeGreaterThan(10);
    }
  });
  it('couvre les termes de la spécification', () => {
    for (const id of ['modele', 'parametres', 'gguf', 'quantification', 'vram', 'gpu', 'quota', 'cle', 'huggingface', 'kaggle', 'colab', 'modal', 'tunnel', 'contexte', 'agent']) {
      expect(GLOSSARY[id], id).toBeDefined();
    }
  });
  it('tous les <Term id> des textes de l’assistant existent', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
    const used = files.flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/<Term id="([a-z]+)"/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(5);
    for (const id of used) expect(GLOSSARY[id], `Term inconnu : ${id}`).toBeDefined();
  });
});
