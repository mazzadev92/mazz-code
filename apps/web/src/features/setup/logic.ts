import type { ServiceEntry } from '../services/services-format';

export const GOALS = [
  { id: 'chat', label: 'Discuter avec une IA' },
  { id: 'code', label: 'Coder avec un agent' },
  { id: 'image', label: 'Générer des images, de la vidéo ou de la 3D' },
  { id: 'speech', label: 'Voix et audio' },
  { id: 'gpu', label: 'Faire tourner un modèle sur un GPU gratuit' },
] as const;

const GOAL_CATEGORIES: Record<string, string[]> = {
  chat: ['managed_inference'],
  code: ['managed_inference'],
  image: ['image_api', '3d_api', 'video_api'],
  speech: ['speech_api'],
  gpu: [],
};

/** Services déjà présentés par une étape dédiée : jamais répétés à l'étape « Autres services ». */
const DEDICATED = new Set(['huggingface', 'kaggle', 'modal', 'colab']);

/** Catégories utiles pour les objectifs choisis ; sans objectif, l'IA par API reste proposée. */
export function categoriesForGoals(goals: string[]): string[] {
  const cats = goals.flatMap((g) => GOAL_CATEGORIES[g] ?? []);
  return cats.length || goals.length ? Array.from(new Set(cats)) : ['managed_inference'];
}

const freeNoCard = (s: ServiceEntry) => s.requires_card === false && s.free_kind !== 'none' && s.free_kind !== 'unknown';

/** Services suggérés : catégories des objectifs, gratuit sans carte d'abord, au plus `max`. */
export function suggestServices(list: ServiceEntry[], goals: string[], max = 8): ServiceEntry[] {
  const cats = categoriesForGoals(goals);
  return list
    .filter((s) => cats.includes(s.category) && !DEDICATED.has(s.id) && s.free_kind !== 'none')
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(freeNoCard(b.s)) - Number(freeNoCard(a.s)) || a.i - b.i)
    .slice(0, max)
    .map((x) => x.s);
}

export interface HardwareInput { ramBytes?: number; cores?: number; gpus?: string[] }
export interface HardwareVerdict { ram: string; cpu: string; gpu: string; disk: string; maxParamsB: number | null; text: string }

const GB = 1024 ** 3;

/** Verdict en clair. Valeur inconnue = « N/D », jamais inventée. Q4 ≈ 0,6 Go par milliard de paramètres, 4 Go réservés au système. */
export function hardwareVerdict(h: HardwareInput): HardwareVerdict {
  const ramGb = h.ramBytes && h.ramBytes > 0 ? h.ramBytes / GB : null;
  const maxParamsB = ramGb === null ? null : Math.max(0, Math.floor((ramGb - 4) / 0.6));
  const text = maxParamsB === null
    ? 'Mémoire non détectée : impossible d’estimer la taille de modèle supportée.'
    : maxParamsB < 1
      ? 'Mémoire limitée : les modèles locaux sont déconseillés, privilégiez les services en ligne gratuits.'
      : `Vous pouvez faire tourner des modèles jusqu’à environ ${maxParamsB} milliards de paramètres en local (quantification Q4, estimation).`;
  return {
    ram: ramGb === null ? 'N/D' : `${ramGb.toFixed(ramGb < 10 ? 1 : 0)} Go`,
    cpu: h.cores && h.cores > 0 ? `${h.cores} threads` : 'N/D',
    gpu: h.gpus === undefined ? 'N/D' : h.gpus.length ? h.gpus.join(', ') : 'Aucun GPU détecté',
    disk: 'N/D',
    maxParamsB,
    text,
  };
}

const K_GOALS = 'mazz.setup.goals';
const K_STEP = 'mazz.setup.step';

export function readGoals(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(K_GOALS) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
export function writeGoals(goals: string[]): void {
  try { localStorage.setItem(K_GOALS, JSON.stringify(goals)); } catch { /* stockage indisponible : l'assistant fonctionne sans */ }
}
export function readStep(max: number): number {
  try {
    const n = Number(localStorage.getItem(K_STEP));
    return Number.isInteger(n) && n >= 0 && n < max ? n : 0;
  } catch { return 0; }
}
export function writeStep(n: number): void {
  try { localStorage.setItem(K_STEP, String(n)); } catch { /* idem */ }
}
