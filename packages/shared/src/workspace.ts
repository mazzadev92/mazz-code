/**
 * MAZZ ÆNGENIUM — Workspace, Checkpoints, MUCE & Hermes Contracts
 */

export interface DetectedToolchain {
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
  toolchains: DetectedToolchain[];
  lastIndexedAt?: number;
}

export interface FileEntry {
  path: string;
  relativePath: string;
  sizeBytes: number;
  isDirectory: boolean;
  modifiedAt: number;
}

export interface CheckpointRecord {
  id: string;
  timestamp: number;
  description: string;
  files: Record<string, string | null>; // null if file was created (so rollback deletes it)
  binaryFiles?: Record<string,string>; // base64; only for non-text originals
}

export interface RollbackOutcome {
  success: boolean;
  checkpointId: string;
  restoredFiles: string[];
  errors: string[];
}

export interface MuceManifest {
  manifestVersion: string;
  name: string;
  version: string;
  author?: string;
  cliPath?: string;
  dllPath?: string;
  headerPath?: string;
  supportedBackends?: string[];
  capabilities?: {
    hardwareDetection?: boolean;
    cpuOptimization?: boolean;
    ggufRuntime?: boolean;
    benchmark?: boolean;
    autotune?: boolean;
  };
}

export interface HermesDelegationRequest {
  taskId: string;
  objective: string;
  workspacePath: string;
  maxTokens?: number;
  maxDurationSeconds?: number;
  allowedTools?: string[];
  returnArtifacts?: boolean;
}

export interface HermesDelegationResult {
  taskId: string;
  success: boolean;
  finalMessage: string;
  artifactsCreated: string[];
  durationSeconds: number;
  tokenCount?: number;
  error?: string;
}
