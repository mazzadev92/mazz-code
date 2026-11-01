// Forge experience: learns which decoding arm (strategy x temperature bucket) wins per
// `${modelId}|${lang}|${unitKind}`, without touching model weights (reward = oracle verdict).
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ForgeStrategy = 'stepwise' | 'whole';
export interface ForgeArm { strategy: ForgeStrategy; tempBucket: number }
export interface ArmCounts { wins: number; losses: number }
export interface ArmStats extends ForgeArm, ArmCounts { mean: number }
type KeyData = Record<string, ArmCounts>; // armId -> counts

export const DECAY = 0.98;
const STRATEGIES: ForgeStrategy[] = ['stepwise', 'whole'];
export const ALL_ARMS: ForgeArm[] = STRATEGIES.flatMap((strategy) => [0, 1, 2, 3].map((tempBucket) => ({ strategy, tempBucket })));

export const experienceKey = (modelId: string, lang: string, unitKind: string) => `${modelId}|${lang}|${unitKind}`;
const armId = (a: ForgeArm) => `${a.strategy}:${a.tempBucket}`;

/** Current forge.ts portfolio: 'whole' when n%3===2, else 'stepwise'; tempBucket = n%4. */
export function defaultArm(n: number): ForgeArm {
  return { strategy: n % 3 === 2 ? 'whole' : 'stepwise', tempBucket: n % 4 };
}

// Gamma(k,1) via Marsaglia-Tsang (k >= 1 always here, since alpha/beta = 1 + counts).
function gamma(k: number, rng: () => number): number {
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      const u1 = rng() || 1e-12, u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
function betaSample(a: number, b: number, rng: () => number): number {
  const x = gamma(a, rng);
  return x / (x + gamma(b, rng));
}

export class ExperienceStore {
  private data: Record<string, KeyData> = {};
  constructor(readonly filePath: string) {}

  /** Loads the file; missing or corrupt file -> empty store. */
  load(): this {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = {};
      if (raw && typeof raw === 'object' && raw.keys && typeof raw.keys === 'object') {
        for (const [k, arms] of Object.entries(raw.keys as Record<string, KeyData>)) {
          const clean: KeyData = {};
          for (const a of ALL_ARMS) {
            const c = arms?.[armId(a)];
            if (c && Number.isFinite(c.wins) && Number.isFinite(c.losses) && c.wins >= 0 && c.losses >= 0) clean[armId(a)] = { wins: c.wins, losses: c.losses };
          }
          this.data[k] = clean;
        }
      }
    } catch {
      this.data = {};
    }
    return this;
  }

  /** Atomic write: temp file in the same directory, then rename. */
  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys: this.data }, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /** Arm for candidate slot n. No data, or n%4===0 (exploration slot): defaultArm(n). Else Thompson sampling. */
  choose(key: string, n: number, rng: () => number = Math.random): ForgeArm {
    const d = this.data[key];
    if (!d || Object.keys(d).length === 0 || n % 4 === 0) return defaultArm(n);
    let best = defaultArm(n), bestScore = -1;
    for (const a of ALL_ARMS) {
      const c = d[armId(a)] ?? { wins: 0, losses: 0 };
      const s = betaSample(1 + c.wins, 1 + c.losses, rng);
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return { ...best };
  }

  /** Decays every arm of this key by DECAY, then adds the new outcome. */
  record(key: string, arm: ForgeArm, passed: boolean): void {
    const id = armId(arm);
    if (!ALL_ARMS.some((a) => armId(a) === id)) throw new Error(`invalid forge arm: ${id}`);
    const d = (this.data[key] ??= {});
    for (const c of Object.values(d)) { c.wins *= DECAY; c.losses *= DECAY; }
    const c = (d[id] ??= { wins: 0, losses: 0 });
    if (passed) c.wins += 1; else c.losses += 1;
  }

  /** Recorded (decayed) counts per arm; only arms with data. mean = posterior mean (1+w)/(2+w+l). */
  stats(key: string): ArmStats[] {
    const d = this.data[key] ?? {};
    return ALL_ARMS.filter((a) => d[armId(a)]).map((a) => {
      const { wins, losses } = d[armId(a)]!;
      return { ...a, wins, losses, mean: (1 + wins) / (2 + wins + losses) };
    });
  }

  keys(): string[] { return Object.keys(this.data); }
}
