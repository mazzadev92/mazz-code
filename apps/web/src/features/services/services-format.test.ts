import { describe, expect, it } from 'vitest';
import { filterServices, isUnverified, secretTarget, type ServiceEntry } from './services-format';

const base: ServiceEntry = {
  id: 'kaggle', name: 'Kaggle', category: 'gpu_notebook', family: 'notebook', support: 'full', provider_id: 'kaggle',
  website: 'https://k', signup_url: 'https://k', free_tier: '30 h par semaine', free_kind: 'weekly', requires_card: false,
  requires_phone: true, secret_name: '', where_to_find: '', where_saved: '', steps: [], notes: '', source_url: 'https://k', verified_at: '2026-11-04',
};
const groq: ServiceEntry = { ...base, id: 'groq', name: 'Groq', category: 'managed_inference', provider_id: 'groq', free_tier: 'Non verifie : voir la page officielle', free_kind: 'unknown', requires_card: null };
const paid: ServiceEntry = { ...base, id: 'lambda', name: 'Lambda', provider_id: null, free_kind: 'none', requires_card: true };

describe('services-format', () => {
  it('isUnverified_unknownKindOrNonVerifieText_isTrue', () => {
    expect(isUnverified(groq)).toBe(true);
    expect(isUnverified(base)).toBe(false);
  });

  it('filterServices_freeNoCard_keepsOnlyServicesThatStateNoCardAndAFreeTier', () => {
    const out = filterServices([base, groq, paid], { query: '', category: 'all', freeNoCard: true });
    expect(out.map((s) => s.id)).toEqual(['kaggle']);
  });

  it('filterServices_categoryAndQuery_combine', () => {
    const list = [base, groq, paid];
    expect(filterServices(list, { query: 'gro', category: 'managed_inference', freeNoCard: false }).map((s) => s.id)).toEqual(['groq']);
    expect(filterServices(list, { query: '', category: 'gpu_notebook', freeNoCard: false }).map((s) => s.id)).toEqual(['kaggle', 'lambda']);
  });

  it('secretTarget_computeRouterOrNone_followsProviderIds', () => {
    expect(secretTarget(base, ['kaggle', 'huggingface'], ['groq'])).toEqual({ kind: 'compute', id: 'kaggle' });
    expect(secretTarget(groq, ['kaggle'], ['groq'])).toEqual({ kind: 'router', id: 'groq' });
    expect(secretTarget(paid, ['kaggle'], ['groq'])).toEqual({ kind: 'none' });
  });
});
