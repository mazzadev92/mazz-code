// Response shapes of the Studio backend (packages/core/src/server.ts).
// Agent events and telemetry come from @mazz/shared so both sides stay in sync.
import type { AgentEvent, GgufMetadata, InferenceTelemetry, ModelCapability } from '@mazz/shared';

export type { AgentEvent, GgufMetadata, InferenceTelemetry, ModelCapability };

export type PermissionDecision = 'allow' | 'ask' | 'deny';
export const AGENT_MODE_VALUES = ['ask', 'plan', 'agent', 'auto', 'review', 'forge'] as const;
export type AgentMode = typeof AGENT_MODE_VALUES[number];
export const AGENT_MODE_OPTIONS: ReadonlyArray<{ value: AgentMode; label: string; title: string }> = [
  { value: 'ask', label: 'Ask', title: 'Questions et lecture du projet, aucune modification' },
  { value: 'plan', label: 'Plan', title: 'Plan d’action vérifiable, aucune modification' },
  { value: 'agent', label: 'Agent', title: 'Lecture, écriture, terminal et compilation selon vos permissions' },
  { value: 'auto', label: 'Auto', title: 'Exécute les opérations prévues dans le périmètre configuré ; les refus et garde-fous restent appliqués' },
  { value: 'review', label: 'Review', title: 'Revue de code en lecture seule' },
  { value: 'forge', label: 'Forge', title: 'Projet construit depuis un blueprint Bib1 : chaque fonction est générée, compilée et testée avant écriture' },
];

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === 'string' && (AGENT_MODE_VALUES as readonly string[]).includes(value);
}

export interface StudioSettings {
  version: 1;
  general: { language: 'fr' | 'en'; startView: 'home' | 'agent' | 'last'; notifications: boolean; onboardingDone: boolean; confirmBeforeQuit: boolean };
  appearance: {
    theme: 'bioforge' | 'blueprint';
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
    remoteAcknowledged: string[];
    auxProviderId: string;
    auxModelId: string;
  };
  agent: { defaultMode: AgentMode; maxIterations: number; approvalTimeoutSec: number; maxConcurrentTasks: number; toolProfile: 'compact' | 'full'; toolSelection: 'auto' | 'all'; modelProfile?: 'auto' | 'small' | 'large'; projectInstructions: boolean; memory: boolean; autoCompact: boolean; compactAfterTurns: number };
  models: {
    llamaServerPath: string;
    scanFolders: string[];
    library: string[];
    calibrations: Array<{
      providerId: string; modelId: string; modelPath: string; modelSizeBytes: number; modelModifiedAtMs: number; calibratedAt: string;
      runtime?: {
        binaryPath: string; binarySizeBytes: number | null; binaryModifiedAtMs: number | null;
        contextSize: number | null; threads: number | null; batchSize: number | null; gpuLayers: number | null;
        jinja: boolean; chatTemplateKwargs: Record<string, string | number | boolean | null> | null;
        reasoning: string | null; kvCacheType: string | null; flashAttn: string | null; specType: string | null;
        ngramMatch: number | null; ngramMin: number | null; ngramMax: number | null;
        draftModelPath: string | null; draftMax: number | null; poll: number | null; prio: number | null;
      };
      score: { passed: number; total: number; percent: number };
      strategy: 'autonomous' | 'hybrid' | 'guided';
      checks: Record<string, { status: 'passed' | 'failed' | 'unsupported' | 'error'; durationMs: number; summary: string; attempts?: number; passedAttempts?: number; outputPreview?: string }>;
    }>;
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
    acceleration: {
      enabled: boolean;
      specType: 'none' | 'ngram-mod' | 'ngram-simple' | 'ngram-map-k' | 'ngram-cache';
      ngramMatch: number;
      ngramMin: number;
      ngramMax: number;
      poll: number;
      prio: number;
      reasoning: 'off' | 'auto' | 'on';
      kvCacheType: 'f16' | 'q8_0' | 'q4_0';
    };
  };
  terminal: { shell: 'powershell' | 'cmd' | 'pwsh'; timeoutSec: number; maxLines: number };
  editor: { tabSize: number; wordWrap: boolean; lineNumbers: boolean };
  permissions: { write: PermissionDecision; delete: PermissionDecision; terminal: PermissionDecision; git: PermissionDecision; network: PermissionDecision; mcp: PermissionDecision; web: PermissionDecision; rules: Array<{ tool: string; pattern: string; decision: 'allow' | 'deny' }> };
  web: { engine: 'duckduckgo' | 'searxng' | 'brave'; searxngUrl: string };
  semantic: { folders: string[]; embeddingModel: string; port: number };
  skills: { folders: string[]; includeClaude: boolean; autoSuggest: boolean };
  access: { mode: 'project' | 'ask' | 'full'; extraRoots: string[]; protectedRoots: string[] };
  muce: { home: string };
  hermes: { pythonPath: string };
  knowledge?: { home: string; port: number; autoContext: boolean };
  privacy: { telemetryRetention: number; auditRetention: number };
  performance: { metricsIntervalSec: number; rollingWindowSec: number; recordRuns: boolean };
  projects: { recent: Array<{ path: string; name: string; openedAt: number }>; lastOpened: string };
  customProviders: Array<{ id: string; name: string; baseUrl: string; locality?: 'local' | 'remote'; defaultModel?: string }>;
  cascade?: {
    enabled: boolean;
    steps: Array<{
      providerId: string;
      modelId: string;
      priority: number;
      enabled: boolean;
      label?: string;
    }>;
    maxFallbacks: number;
    cooldownSec: number;
  };
}

export interface Toolchain {
  name: string;
  command: string;
  path: string;
  version?: string;
  isAvailable: boolean;
}

export interface WorkspaceStatus {
  workspaceRoot: string;
  name: string;
  isGitRepo: boolean;
  gitBranch?: string;
  gitDirtyCount: number;
  fileCount: number;
  detectedLanguages: string[];
  toolchains: Toolchain[];
}

export type LlamaState = 'stopped' | 'starting' | 'ready' | 'error' | 'exited';

export interface LlamaStatus {
  state: LlamaState;
  isRunning: boolean;
  pid?: number;
  port: number;
  host: string;
  binaryPath?: string;
  modelPath?: string;
  metadata?: GgufMetadata;
  config?: { contextSize?: number; threads?: number; batchSize?: number; gpuLayers?: number; jinja?: boolean; embeddings?: boolean; port?: number; parallel?: number; cacheRamMb?: number; slotSavePath?: string; draftModelPath?: string; draftMax?: number };
  args?: string[];
  startedAt?: number;
  readyAt?: number;
  loadMs?: number;
  uptimeSeconds?: number;
  exitCode?: number | null;
  lastError?: string;
}

export interface MuceStatus {
  state: 'absent' | 'detected' | 'incompatible' | 'ready' | 'error';
  isConfigured: boolean;
  muceHome?: string;
  isManifestValid: boolean;
  manifest?: { name: string; version: string; manifestVersion?: string; cliPath?: string };
  isCliAvailable: boolean;
  cliAbsolutePath?: string;
  isFallbackActive: boolean;
  generationUsesLlamaCpp?: boolean;
  generativeAcceleration: 'declared' | 'unsupported' | 'unknown';
  speculativeMethods?: string[];
  capabilities?: Record<string, unknown>;
  unsupported?: string[];
  commands?: Record<string, string[]>;
  integrationDocPath?: string;
  llamaRuntimeDir?: string;
  error?: string;
  diagnostics: string[];
}

export interface HermesStatus {
  isInstalled: boolean;
  pythonPath?: string;
  hermesVersion?: string;
  diagnostics: string[];
}

export interface Health {
  status: 'ok' | 'degraded';
  persistence?: {ok:boolean;failures:Array<{file:string;at:string;message:string}>};
  product: string;
  version: string;
  workspace: WorkspaceStatus;
  muce: MuceStatus;
  hermes: HermesStatus;
  llama: LlamaStatus;
  dataDir: string;
  secretProtection: 'dpapi' | 'file-0600';
  secretLoadFailures: string[];
}

export interface DoctorWarning {
  code: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  action?: string;
}

export interface Doctor {
  version: string;
  node: string;
  platform: string;
  cpu: SystemMetrics['cpu'];
  memory: SystemMetrics['memory'];
  gpu: SystemMetrics['gpu'];
  toolchains: Toolchain[];
  llamaServer: { configuredPath: string; discovered: string[] };
  library: { count: number; usable: number };
  providers: { remoteWithKey: number };
  muce: { state: MuceStatus['state']; generativeAcceleration: MuceStatus['generativeAcceleration'] };
  hermes: { installed: boolean };
  llama: LlamaStatus;
  warnings: DoctorWarning[];
}

export interface SystemMetrics {
  sampledAt: number;
  cpu: { model: string; logicalCores: number; usagePercent?: number; usageWindowMs?: number };
  memory: { totalBytes: number; availableBytes: number; usedPercent: number };
  studio: { rssBytes: number; heapUsedBytes: number };
  llamaServer?: { pid: number; workingSetBytes: number; source: string };
  gpu: { detected: Array<{ name: string; driver?: string }>; telemetry: 'unavailable' };
  uptimeSec: number;
}

export interface ProviderInfo {
  id: string;
  type: string;
  name: string;
  baseUrl: string;
  locality: 'local' | 'remote';
  requiresApiKey: boolean;
  hasApiKey: boolean;
  custom: boolean;
  synthetic: boolean;
}

export interface ProviderHealthRecord {
  providerId: string;
  name: string;
  baseUrl: string;
  locality: 'local' | 'remote';
  requiresApiKey: boolean;
  hasApiKey: boolean;
  status: 'healthy' | 'degraded' | 'cooling_down' | 'unavailable';
  isAvailable: boolean;
  coolingDownUntil?: number;
  cooldownRemainingSec?: number;
  lastError?: string;
  lastStatusCode?: number;
  lastLatencyMs?: number;
  retryAfterSec?: number;
  knownQuota?: string;
  quotaDisclaimer?: string;
}

export interface CatalogEntry {
  provider: ProviderInfo;
  models: ModelCapability[];
  reason?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  requiresPermission: boolean;
  isDestructive?: boolean;
  permissionCategory: string;
  offering?: 'always' | 'write-modes' | 'on-topic';
  keywords?: string[];
  parameters: { properties: Record<string, { type: string; description?: string }>; required?: string[] };
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface AttachmentMeta {
  id: string;
  name: string;
  sizeBytes: number;
  kind: 'text' | 'code' | 'pdf' | 'docx' | 'image' | 'binary';
  mime?: string;
  chars: number;
  sourceSha256: string;
  textSha256?: string;
  extractionStatus: 'complete' | 'partial' | 'unavailable' | 'failed' | 'unknown';
  offsetUnit: 'utf16-code-unit';
  pages?: number;
  sourceUrl?: string;
  finalUrl?: string;
  fetchedAt?: number;
  note?: string;
}

export interface SessionTurn {
  id: string;
  taskId: string;
  prompt: string;
  mode: string;
  providerId: string;
  modelId: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';
  events: AgentEvent[];
  finalText: string;
  telemetry: InferenceTelemetry[];
  checkpointId?: string;
  error?: string;
  attachments?: AttachmentMeta[];
}

export interface SessionSummary {
  id: string;
  title: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  archived: boolean;
  pinned: boolean;
  providerId: string;
  modelId: string;
  mode: string;
  extraRoots?: string[];
  summary?: string;
  summarizedTurns?: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypass';
  turnCount: number;
  lastPrompt?: string;
  lastTelemetry?: InferenceTelemetry;
}

export interface SessionRecord extends Omit<SessionSummary, 'turnCount' | 'lastPrompt' | 'lastTelemetry'> {
  turns: SessionTurn[];
}

export interface TaskInfo {
  taskId: string;
  sessionId?: string;
  turnId?: string;
  mode: string;
  providerId: string;
  modelId: string;
  workspaceRoot: string;
  startedAt: number;
  endedAt?: number;
  stage: string;
  done: boolean;
  success?: boolean;
  eventCount: number;
  pendingApprovals: number;
}

export interface TreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes?: number;
  modifiedAt?: number;
  heavy?: boolean;
}

export interface FileContent {
  path: string;
  content?: string;
  binary: boolean;
  tooLarge: boolean;
  sizeBytes: number;
  modifiedAt: number;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  origPath?: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  error?: string;
}

export interface CheckpointSummary {
  id: string;
  timestamp: number;
  description: string;
  workspaceRoot?: string;
  fileCount: number;
  files: string[];
}

export interface TelemetryRecord extends InferenceTelemetry {
  id: string;
  kind: 'agent' | 'inference_test' | 'benchmark';
  taskId?: string;
  sessionId?: string;
  runtime?: { contextSize?: number; threads?: number; batchSize?: number; modelFile?: string; quantization?: string };
}

export interface BenchmarkResult {
  id: string;
  createdAt: number;
  engine: 'llama.cpp';
  methodologyKey: string;
  modelFile: string;
  quantization?: string;
  contextSize?: number;
  threads?: number;
  batchSize?: number;
  promptTokens: number;
  nPredict: number;
  repetitions: number;
  runs: Array<{ ppTokS?: number; tgTokS?: number; promptMs?: number; generationMs?: number; predicted?: number }>;
  meanPpTokS?: number;
  meanTgTokS?: number;
  serverWorkingSetMb?: number;
  buildInfo?: string;
}

export interface AuditEntry {
  t: number;
  kind: string;
  action: string;
  decision?: 'allowed' | 'denied' | 'timeout';
  detail?: string;
  taskId?: string;
}

export interface ShellInfo {
  id: 'powershell' | 'cmd' | 'pwsh';
  label: string;
  executable: string;
  available: boolean;
}

export interface HardwareProfile {
  cpu: { model: string; physicalCores?: number; logicalCores: number; l3CacheKb?: number; avx2?: boolean; fma?: boolean; isaSource: 'muce' | 'unknown' };
  memory: { totalBytes: number; availableBytes: number };
  gpu: string[];
  recommendations: { threads: number; parallel: number; cacheRamMb: number; contextSize: number; maxModelBytes: number; reasons: string[] };
}

export interface AutotuneResult {
  modelFile: string;
  bench: string;
  method: string;
  rows: Array<{ threads: number; ppTokS?: number; tgTokS?: number }>;
  recommended: { threads: number; tgTokS?: number; ppTokS?: number };
  durationMs: number;
  build?: string;
}

export interface KvCacheUsage {
  files: number;
  bytes: number;
  owner?: string;
  maxBytes: number;
  enabled: boolean;
  dir: string;
}
