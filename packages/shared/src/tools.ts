/**
 * MAZZ ÆNGENIUM — Tooling and Execution Contracts
 */

export type ToolCategory =
  | 'fs'
  | 'terminal'
  | 'git'
  | 'compiler'
  | 'mcp'
  | 'analysis'
  | 'memory';

export type ToolPermissionLevel =
  | 'read_only'
  | 'ask_on_write'
  | 'trusted_workspace'
  | 'custom';

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface ToolJSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: ToolJSONSchema;
  requiresPermission: boolean;
  isDestructive?: boolean;
}

export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  output: T;
  error?: string;
  exitCode?: number;
  durationMs: number;
}

/** Commands run around every tool call (spec 03b §3.2): JSON on stdin, exit code 2 blocks. */
export interface ToolHooks {
  preToolUse?: string[];
  postToolUse?: string[];
  timeoutMs?: number;
}

export interface ToolExecutionContext {
  taskId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  /** Effective locality mode for the current request; optional for older tool callers. */
  executionMode?: import('./models.js').ExecutionMode;
  permissionLevel: ToolPermissionLevel;
  emitEvent: (event: import('./events.js').AgentEvent) => void;
  requestApproval?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
  /** Directories outside the project the tools may use (granted by the user). Mutable per run. */
  allowedRoots?: string[];
  /** Asks the user for access to a path outside the project and allowed roots. */
  requestPathAccess?: (absPath: string, toolName: string) => Promise<boolean>;
  /** Directories never reachable, whatever the access mode (secrets, Studio data). */
  deniedRoots?: string[];
  /** PreToolUse / PostToolUse hook commands configured by the user. */
  hooks?: ToolHooks;
}

export interface ITool {
  readonly definition: ToolDefinition;
  execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
