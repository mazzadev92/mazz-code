import { describe, expect, it } from 'vitest';
import type { ServiceEntry } from '../services/services-format';
import { categoriesForGoals, diskVerdict, hardwareVerdict, suggestServices } from './logic';

const mk = (id: string, category: string, over: Partial<ServiceEntry> = {}): ServiceEntry => ({
  id, name: id, category, family: 'f', support: 'guide', provider_id: null, website: '', signup_url: '', free_tier: 'x', free_kind: 'daily',
  requires_card: false, requires_phone: false, secret_name: '', where_to_find: '', where_saved: '', steps: [], notes: '', source_url: '', verified_at: '', ...over,
});

describe('categoriesForGoals', () => {
  it('maps goals to categories', () => {
    expect(categoriesForGoals(['image'])).toEqual(['image_api', '3d_api', 'video_api']);
    expect(categoriesForGoals(['speech'])).toEqual(['speech_api']);
    expect(categoriesForGoals(['chat', 'code'])).toEqual(['managed_inference']);
  });
  it('defaults to managed_inference with no goal, none for gpu only', () => {
    expect(categoriesForGoals([])).toEqual(['managed_inference']);
    expect(categoriesForGoals(['gpu'])).toEqual([]);
  });
});

describe('suggestServices', () => {
  const list = [
    mk('paid', 'managed_inference', { requires_card: true }),
    mk('groq', 'managed_inference'),
    mk('huggingface', 'managed_inference'),
    mk('dead', 'managed_inference', { free_kind: 'none' }),
    mk('flux', 'image_api'),
  ];
  it('puts free-without-card first, drops dedicated and non-free services', () => {
    expect(suggestServices(list, ['chat']).map((s) => s.id)).toEqual(['groq', 'paid']);
  });
  it('filters by goal and caps at max', () => {
    expect(suggestServices(list, ['image']).map((s) => s.id)).toEqual(['flux']);
    const many = Array.from({ length: 12 }, (_, i) => mk(`s${i}`, 'speech_api'));
    expect(suggestServices(many, ['speech'])).toHaveLength(8);
  });
});

describe('hardwareVerdict', () => {
  it('estimates from RAM', () => {
    const v = hardwareVerdict({ ramBytes: 16 * 1024 ** 3, cores: 8, gpus: ['RTX 3060'] });
    expect(v.ram).toBe('16 Go');
    expect(v.cpu).toBe('8 threads');
    expect(v.gpu).toBe('RTX 3060');
    expect(v.maxParamsB).toBe(20);
    expect(v.text).toContain('20 milliards');
  });
  it('shows N/D for unknown values and never invents', () => {
    const v = hardwareVerdict({});
    expect([v.ram, v.cpu, v.gpu, v.disk]).toEqual(['N/D', 'N/D', 'N/D', 'N/D']);
    expect(v.maxParamsB).toBeNull();
  });
  it('distinguishes no GPU from unknown and flags tiny RAM', () => {
    expect(hardwareVerdict({ gpus: [] }).gpu).toBe('Aucun GPU détecté');
    const small = hardwareVerdict({ ramBytes: 3 * 1024 ** 3 });
    expect(small.maxParamsB).toBe(0);
    expect(small.text).toContain('limitée');
  });
});

describe('diskVerdict', () => {
  const GB = 1024 ** 3;
  it('computes a plain-language verdict', () => {
    const v = diskVerdict(52 * GB);
    expect(v.maxModelGb).toBe(50);
    expect(v.text).toBe('52 Go libres : suffisant pour un modèle de 50 Go (environ 83 milliards de paramètres en Q4).');
  });
  it('flags low space and never invents when unknown', () => {
    expect(diskVerdict(2.5 * GB).text).toContain('insuffisant');
    expect(diskVerdict(null)).toEqual({ text: 'Espace disque non détecté.', maxModelGb: null });
    expect(hardwareVerdict({ diskFreeBytes: 10 * GB }).disk).toBe('10 Go libres');
  });
});
