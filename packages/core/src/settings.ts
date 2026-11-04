import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './storage.js';
import type { McpServerConfig } from './mcp-manager.js';
import { isModelCalibrationProfile, type ModelCalibrationProfile } from './model-calibration.js';

export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type AgentMode = 'ask' | 'plan' | 'agent' | 'auto' | 'review';

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export interface CustomProviderSetting {
  id: string;
  name: string;
  baseUrl: string;
  locality?: 'local' | 'remote';
  defaultModel?: string;
}

export interface CascadeStepSetting {
  providerId: string;
  modelId: string;
  priority: number;
  enabled: boolean;
  label?: string;
}

export interface StudioSettings {
  version: 1;
  general: {
    language: 'fr' | 'en';
    startView: 'home' | 'agent' | 'last';
    notifications: boolean;
    onboardingDone: boolean;
    confirmBeforeQuit: boolean;
  };
  appearance: {
    theme: 'bioforge' | 'blueprint' | 'claude';
    mode: 'dark' | 'light' | 'system';
    density: 'comfortable' | 'compact';
    uiScale: number;
    motion: 'system' | 'reduced' | 'full';
    highContrast: boolean;
    codeFontSize: number;
  };
  ai: {
    defaultProviderId: string;
    defaultModelId: string;
    executionMode: 'local_strict' | 'hybrid_opt_in' | 'cloud';
    temperature: number;
    topP: number;
    topK: number;
    presencePenalty: number;
    maxOutputTokens: number;
    confirmRemoteSend: boolean;
    /** Remote providers already confirmed once (no confirmation per message afterwards). */
    remoteAcknowledged: string[];
    /** Auxiliary tasks (commit messages, titles): empty = the loaded local model. */
    auxProviderId: string;
    auxModelId: string;
  };
  agent: {
    defaultMode: AgentMode;
    maxIterations: number;
    approvalTimeoutSec: number;
    maxConcurrentTasks: number;
    toolProfile: 'compact' | 'full';
    toolSelection: 'auto' | 'all';
    /** Harness guard rails: small (local 0.6B-4B), large (remote API, 14B+), auto (decided per run from the model). */
    modelProfile: 'auto' | 'small' | 'large';
    /** Characters of attachment text inlined in the request (the rest via attachments.read). */
    attachmentBudgetChars: number;
    /** Reads MAZZ.md / AGENTS.md / CLAUDE.md of the project and the global MAZZ.md. */
    projectInstructions: boolean;
    /** Persistent memory of the agent (memory.* tools and index in the prompt). */
    memory: boolean;
    /** Summarises older turns once a session has more than compactAfterTurns unsummarised turns. */
    autoCompact: boolean;
    compactAfterTurns: number;
  };
  /** Semantic index of folders (local embedding model served by a second llama-server). */
  semantic: { folders: string[]; embeddingModel: string; port: number; threads: number };
  /** MAZZ Universal Knowledge engine (Bib1): available to every model. */
  knowledge: { home: string; port: number; autoContext: boolean };
  /** Internet access of the agent (web.search, web.fetch). */
  web: { engine: 'duckduckgo' | 'searxng' | 'brave'; searxngUrl: string };
  models: {
    llamaServerPath: string;
    scanFolders: string[];
    library: string[];
    calibrations: ModelCalibrationProfile[];
    contextSize: number;
    memoryReserveMb: number;
    threads: number;
    batchSize: number;
    port: number;
    gpuLayers: number;
    jinja: boolean;
    autoStartLast: boolean;
    lastModelPath: string;
    parallel: number;
    cacheRamMb: number;
    kvPersist: boolean;
    kvMaxDiskMb: number;
    draftModelPath: string;
    draftMax: number;
    /** MUCE acceleration profile applied to llama-server (see docs/MUCE_INTEGRATION.md). */
    acceleration: {
      enabled: boolean;
      specType: 'none' | 'ngram-mod' | 'ngram-simple' | 'ngram-map-k' | 'ngram-cache';
      ngramMatch: number;
      ngramMin: number;
      ngramMax: number;
      poll: number;
      prio: number;
      reasoning: 'off' | 'auto' | 'on';
      /** Thinking tokens per reply when reasoning is on (-1: unlimited). Without a cap, small models think until the output budget is gone and never act. */
      reasoningBudget: number;
      kvCacheType: 'f16' | 'q8_0' | 'q4_0';
    };
  };
  terminal: {
    shell: 'powershell' | 'cmd' | 'pwsh';
    timeoutSec: number;
    maxLines: number;
  };
  editor: {
    tabSize: number;
    wordWrap: boolean;
    lineNumbers: boolean;
  };
  permissions: {
    write: PermissionDecision;
    delete: PermissionDecision;
    terminal: PermissionDecision;
    git: PermissionDecision;
    network: PermissionDecision;
    web: PermissionDecision;
    mcp: PermissionDecision;
    /** Allow/deny rules by tool and pattern (permission-rules.ts). */
    rules: Array<{ tool: string; pattern: string; decision: 'allow' | 'deny' }>;
    /** Commands run around every agent tool call: JSON on stdin, exit code 2 blocks (spec 03b §3.2). */
    hooks: { preToolUse: string[]; postToolUse: string[]; timeoutMs: number };
  };
  /** Access to the PC outside the project folder. */
  access: {
    /** project: project only; ask: other folders on request; full: whole PC without asking. */
    mode: 'project' | 'ask' | 'full';
    /** Trusted folders, allowed permanently ("Toujours" answers or added in Settings). */
    extraRoots: string[];
    /** Folders never reachable by the agent, in addition to the built-in ones (secrets, Studio data). */
    protectedRoots: string[];
  };
  muce: { home: string };
  hermes: { pythonPath: string };
  privacy: {
    telemetryRetention: number;
    auditRetention: number;
  };
  performance: {
    metricsIntervalSec: number;
    rollingWindowSec: number;
    recordRuns: boolean;
  };
  projects: { recent: RecentProject[]; lastOpened: string };
  customProviders: CustomProviderSetting[];
  mcpServers: McpServerConfig[];
  skills: {
    /** Extra folders containing skill sub-folders (SKILL.md). */
    folders: string[];
    /** Also read Claude Code skills (~/.claude/skills and <project>/.claude/skills). */
    includeClaude: boolean;
    /** Suggest the most relevant skills to the agent for each request. */
    autoSuggest: boolean;
  };
  cascade: {
    enabled: boolean;
    steps: CascadeStepSetting[];
    maxFallbacks: number;
    cooldownSec: number;
  };
}

export const DEFAULT_SETTINGS: StudioSettings = {
  version: 1,
  general: { language: 'fr', startView: 'home', notifications: true, onboardingDone: false, confirmBeforeQuit: false },
  appearance: { theme: 'claude', mode: 'dark', density: 'comfortable', uiScale: 100, motion: 'system', highContrast: false, codeFontSize: 13 },
  ai: {
    defaultProviderId: 'mazz-cloud',
    defaultModelId: 'Mazz-Technos-Base-4B-Abliterated.Q4_K_M',
    executionMode: 'local_strict',
    temperature: 0.2,
    topP: 0.8,
    topK: 20,
    presencePenalty: 0,
    maxOutputTokens: 2048,
    confirmRemoteSend: true,
    remoteAcknowledged: [],
    auxProviderId: '',
    auxModelId: '',
  },
  agent: { defaultMode: 'agent', maxIterations: 25, approvalTimeoutSec: 300, maxConcurrentTasks: 2, toolProfile: 'compact', toolSelection: 'auto', modelProfile: 'auto', attachmentBudgetChars: 12000, projectInstructions: true, memory: true, autoCompact: true, compactAfterTurns: 10 },
  web: { engine: 'duckduckgo', searxngUrl: '' },
  semantic: { folders: [], embeddingModel: '', port: 8091, threads: 3 },
  // 8095: the engine's own default (8098) is the MUCE service port.
  knowledge: { home: 'D:\\Mazz Code\\Bib1', port: 8095, autoContext: false },
  models: {
    llamaServerPath: '',
    scanFolders: ['D:\\Models Locaux', 'D:\\MAZZ IA\\models\\local'],
    library: [],
    calibrations: [],
    // i5-6500: 4 physical cores, 16 GB; 4096 tokens keeps the KV cache modest.
    contextSize: 4096,
    memoryReserveMb: 1536,
    threads: 4,
    batchSize: 512,
    port: 8080,
    gpuLayers: 0,
    jinja: true,
    autoStartLast: false,
    lastModelPath: '',
    // One slot: on 4 cores parallel decoding only splits the same CPU time.
    parallel: 1,
    // llama.cpp keeps up to 8 GiB of prompt cache in RAM by default: too much for 16 GB.
    cacheRamMb: 1024,
    kvPersist: true,
    kvMaxDiskMb: 4096,
    draftModelPath: '',
    draftMax: 8,
    acceleration: { enabled: true, specType: 'ngram-mod', ngramMatch: 24, ngramMin: 4, ngramMax: 16, poll: 100, prio: 2, reasoning: 'off', reasoningBudget: 512, kvCacheType: 'f16' },
  },
  terminal: { shell: 'powershell', timeoutSec: 120, maxLines: 5000 },
  editor: { tabSize: 2, wordWrap: false, lineNumbers: true },
  permissions: { write: 'ask', delete: 'ask', terminal: 'ask', git: 'ask', network: 'ask', mcp: 'ask', web: 'ask', rules: [], hooks: { preToolUse: [], postToolUse: [], timeoutMs: 10000 } },
  access: { mode: 'ask', extraRoots: [], protectedRoots: [] },
  muce: { home: '' },
  hermes: { pythonPath: '' },
  privacy: { telemetryRetention: 500, auditRetention: 2000 },
  performance: { metricsIntervalSec: 3, rollingWindowSec: 3, recordRuns: true },
  projects: { recent: [], lastOpened: '' },
  customProviders: [],
  mcpServers: [],
  skills: { folders: [], includeClaude: true, autoSuggest: true },
  cascade: {
    enabled: true,
    steps: [
      { providerId: 'mazz-cloud', modelId: 'Mazz-Technos-Base-4B-Abliterated.Q4_K_M', priority: 1, enabled: true, label: 'MAZZ Control (local, Modal, Kaggle, Colab)' },
      { providerId: 'llama-local', modelId: '', priority: 2, enabled: true, label: 'Modèle local configuré' },
      { providerId: 'groq-api', modelId: 'llama-3.3-70b-versatile', priority: 2, enabled: true, label: 'Provider API principal' },
      { providerId: 'llmfaucet', modelId: 'auto:coding', priority: 3, enabled: true, label: 'llmfaucet (auto:coding anonyme)' },
      { providerId: 'ovh-ai', modelId: 'Mistral-Nemo-Instruct-2407', priority: 4, enabled: true, label: 'OVHcloud AI Endpoints (anonyme)' },
    ],
    maxFallbacks: 3,
    cooldownSec: 30,
  },
};

const ENUMS: Record<string, readonly string[]> = {
  'general.language': ['fr', 'en'],
  'general.startView': ['home', 'agent', 'last'],
  'appearance.theme': ['bioforge', 'blueprint', 'claude'],
  'appearance.mode': ['dark', 'light', 'system'],
  'appearance.density': ['comfortable', 'compact'],
  'appearance.motion': ['system', 'reduced', 'full'],
  'ai.executionMode': ['local_strict', 'hybrid_opt_in', 'cloud'],
  'agent.defaultMode': ['ask', 'plan', 'agent', 'auto', 'review', 'forge'],
  'agent.toolProfile': ['compact', 'full'],
  'agent.toolSelection': ['auto', 'all'],
  'agent.modelProfile': ['auto', 'small', 'large'],
  'permissions.mcp': ['allow', 'ask', 'deny'],
  'access.mode': ['project', 'ask', 'full'],
  'models.acceleration.specType': ['none', 'ngram-mod', 'ngram-simple', 'ngram-map-k', 'ngram-cache'],
  'models.acceleration.reasoning': ['off', 'auto', 'on'],
  'models.acceleration.kvCacheType': ['f16', 'q8_0', 'q4_0'],
  'terminal.shell': ['powershell', 'cmd', 'pwsh'],
  'permissions.write': ['allow', 'ask', 'deny'],
  'permissions.delete': ['allow', 'ask', 'deny'],
  'permissions.terminal': ['allow', 'ask', 'deny'],
  'permissions.git': ['allow', 'ask', 'deny'],
  'permissions.network': ['allow', 'ask', 'deny'],
  'permissions.web': ['allow', 'ask', 'deny'],
  'web.engine': ['duckduckgo', 'searxng', 'brave'],
};

const RANGES: Record<string, [number, number]> = {
  'appearance.uiScale': [80, 140],
  'appearance.codeFontSize': [10, 22],
  'ai.temperature': [0, 2],
  'ai.topP': [0, 1],
  'ai.topK': [1, 200],
  'ai.presencePenalty': [-2, 2],
  'ai.maxOutputTokens': [16, 131072],
  'agent.maxIterations': [1, 50],
  'permissions.hooks.timeoutMs': [100, 60000],
  'agent.approvalTimeoutSec': [10, 3600],
  'agent.maxConcurrentTasks': [1, 4],
  'models.contextSize': [256, 262144],
  'models.memoryReserveMb': [512, 8192],
  'models.threads': [1, 64],
  'models.batchSize': [16, 8192],
  'models.port': [1024, 65535],
  'models.gpuLayers': [0, 999],
  'models.parallel': [1, 8],
  'models.acceleration.ngramMatch': [4, 64],
  'models.acceleration.ngramMin': [1, 32],
  'models.acceleration.ngramMax': [2, 128],
  'models.acceleration.reasoningBudget': [-1, 32768],
  'models.acceleration.poll': [0, 100],
  'models.acceleration.prio': [-1, 3],
  'agent.attachmentBudgetChars': [1000, 200000],
  'agent.compactAfterTurns': [4, 50],
  'semantic.port': [1024, 65535],
  'semantic.threads': [1, 16],
  'knowledge.port': [1024, 65535],
  'models.cacheRamMb': [0, 16384],
  'models.kvMaxDiskMb': [256, 65536],
  'models.draftMax': [1, 32],
  'terminal.timeoutSec': [1, 3600],
  'terminal.maxLines': [500, 50000],
  'editor.tabSize': [1, 8],
  'privacy.telemetryRetention': [10, 10000],
  'privacy.auditRetention': [100, 100000],
  'performance.metricsIntervalSec': [1, 60],
  'performance.rollingWindowSec': [1, 30],
  'cascade.maxFallbacks': [1, 10],
  'cascade.cooldownSec': [5, 600],
};

export interface SettingsError {
  path: string;
  message: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merges `patch` into `base`, keeping only keys known by the defaults and values
 * of the expected type. Invalid values are reported, never silently coerced.
 */
export function mergeSettings(base: StudioSettings, patch: unknown): { settings: StudioSettings; errors: SettingsError[] } {
  const errors: SettingsError[] = [];

  const walk = (target: Record<string, unknown>, defaults: Record<string, unknown>, src: unknown, prefix: string) => {
    if (!isPlainObject(src)) return;
    for (const [key, value] of Object.entries(src)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (!(key in defaults)) continue;
      const def = defaults[key];
      if (isPlainObject(def)) {
        if (!isPlainObject(value)) {
          errors.push({ path: p, message: 'Objet attendu.' });
          continue;
        }
        target[key] = { ...(target[key] as object) };
        walk(target[key] as Record<string, unknown>, def, value, p);
        continue;
      }
      if (Array.isArray(def)) {
        if (!Array.isArray(value)) {
          errors.push({ path: p, message: 'Liste attendue.' });
          continue;
        }
        target[key] = value;
        continue;
      }
      if (typeof value !== typeof def) {
        errors.push({ path: p, message: `Type ${typeof def} attendu.` });
        continue;
      }
      if (ENUMS[p] && !ENUMS[p].includes(value as string)) {
        errors.push({ path: p, message: `Valeur non autorisée (${ENUMS[p].join(', ')}).` });
        continue;
      }
      if (RANGES[p]) {
        const [min, max] = RANGES[p];
        if (!Number.isFinite(value) || (value as number) < min || (value as number) > max) {
          errors.push({ path: p, message: `Valeur hors limites [${min} ; ${max}].` });
          continue;
        }
      }
      target[key] = value;
    }
  };

  const settings = structuredClone(base);
  walk(settings as unknown as Record<string, unknown>, DEFAULT_SETTINGS as unknown as Record<string, unknown>, patch, '');
  settings.version = 1;
  // Lists of strings only.
  settings.models.library = settings.models.library.filter((x) => typeof x === 'string').slice(0, 500);
  settings.models.scanFolders = settings.models.scanFolders.filter((x) => typeof x === 'string').slice(0, 50);
  settings.models.calibrations = settings.models.calibrations.filter(isModelCalibrationProfile).slice(-50);
  for (const key of ['preToolUse', 'postToolUse'] as const) {
    settings.permissions.hooks[key] = settings.permissions.hooks[key].filter((x) => typeof x === 'string' && x.trim() !== '').slice(0, 10);
  }
  settings.projects.recent = settings.projects.recent
    .filter((r) => r && typeof r.path === 'string')
    .slice(0, 20);
  if (Array.isArray(settings.cascade?.steps)) {
    settings.cascade.steps = settings.cascade.steps
      .filter((s) => s && typeof s.providerId === 'string')
      .map((s, idx) => ({
        providerId: String(s.providerId).slice(0, 80),
        modelId: String(s.modelId || '').slice(0, 100),
        priority: Number.isSafeInteger(s.priority) ? s.priority : idx + 1,
        enabled: s.enabled !== false,
        label: typeof s.label === 'string' ? s.label.slice(0, 100) : undefined,
      }));
  }
  return { settings, errors };
}

export class SettingsStore {
  private current: StudioSettings = structuredClone(DEFAULT_SETTINGS);
  private readonly file: string;
  private listeners: Array<(s: StudioSettings, prev: StudioSettings) => void> = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  async load(): Promise<StudioSettings> {
    let exists = true;
    try {
      await fs.access(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }
    if (!exists) {
      this.current = structuredClone(DEFAULT_SETTINGS);
      return this.get();
    }

    const raw = await readJson<unknown>(this.file, null);
    if (!isPlainObject(raw)) throw new Error(`Schéma de paramètres JSON invalide : ${this.file}`);
    const version = raw.version === undefined ? 0 : raw.version;
    if (!Number.isSafeInteger(version) || (version as number) < 0) {
      throw new Error(`Version de paramètres invalide : ${String(version)}`);
    }
    if ((version as number) > DEFAULT_SETTINGS.version) {
      throw new Error(`Cette version de paramètres (${version}) est plus récente que celle prise en charge (${DEFAULT_SETTINGS.version}); le fichier original est conservé.`);
    }

    // v0 is the real legacy format used before a `version` field existed.
    // Promote it transactionally: writeJsonAtomic retains the exact v0 bytes
    // in settings.json.bak, and a failed write leaves the original untouched.
    const migrated = version === 0;
    const document = migrated ? { ...raw, version: DEFAULT_SETTINGS.version } : raw;
    const next = mergeSettings(structuredClone(DEFAULT_SETTINGS), document).settings;
    if (migrated) await writeJsonAtomic(this.file, next);
    this.current = next;
    return this.get();
  }

  get(): StudioSettings {
    return structuredClone(this.current);
  }

  onChange(fn: (s: StudioSettings, prev: StudioSettings) => void): void {
    this.listeners.push(fn);
  }

  /** Applies a partial update. Nothing is written when any field is invalid. */
  async update(patch: unknown): Promise<{ settings: StudioSettings; errors: SettingsError[] }> {
    const { settings, errors } = mergeSettings(this.current, patch);
    if (errors.length > 0) return { settings: this.get(), errors };
    const prev = this.current;
    this.current = settings;
    await writeJsonAtomic(this.file, this.current);
    for (const l of this.listeners) l(this.get(), prev);
    return { settings: this.get(), errors: [] };
  }

  async resetSection(section: keyof StudioSettings | 'all'): Promise<StudioSettings> {
    const prev = this.current;
    if (section === 'all') {
      // Keep the user's data lists (library, projects, custom providers).
      this.current = {
        ...structuredClone(DEFAULT_SETTINGS),
        projects: prev.projects,
        customProviders: prev.customProviders,
        models: { ...structuredClone(DEFAULT_SETTINGS.models), library: prev.models.library, scanFolders: prev.models.scanFolders, calibrations: prev.models.calibrations },
      };
    } else if (section in DEFAULT_SETTINGS && section !== 'version') {
      const next = structuredClone(this.current) as unknown as Record<string, unknown>;
      next[section] = structuredClone((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[section]);
      if (section === 'models') {
        (next.models as StudioSettings['models']).library = prev.models.library;
        (next.models as StudioSettings['models']).scanFolders = prev.models.scanFolders;
        (next.models as StudioSettings['models']).calibrations = prev.models.calibrations;
      }
      this.current = next as unknown as StudioSettings;
    } else {
      throw new Error(`Section inconnue : ${String(section)}`);
    }
    await writeJsonAtomic(this.file, this.current);
    for (const l of this.listeners) l(this.get(), prev);
    return this.get();
  }
}
