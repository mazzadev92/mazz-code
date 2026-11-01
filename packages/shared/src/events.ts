/**
 * MAZZ ÆNGENIUM — Discriminated Event Stream Contracts
 */

import type { InferenceTelemetry } from './telemetry.js';

export type AgentEventType =
  | 'token'
  | 'thought'
  | 'status'
  | 'tool_start'
  | 'tool_result'
  | 'diff'
  | 'checkpoint'
  | 'rollback'
  | 'usage'
  | 'progress'
  | 'approval_request'
  | 'approval_result'
  | 'plan'
  | 'question'
  | 'question_result'
  | 'forge'
  | 'error'
  | 'complete';

export interface BaseAgentEvent {
  type: AgentEventType;
  timestamp: number;
  taskId: string;
  /** Set on events forwarded from a delegated specialist (agent.delegate): its label. */
  agent?: string;
}

export interface TokenEvent extends BaseAgentEvent {
  type: 'token';
  delta: string;
}

export interface ThoughtEvent extends BaseAgentEvent {
  type: 'thought';
  delta: string;
}

export interface StatusEvent extends BaseAgentEvent {
  type: 'status';
  stage: string;
  message: string;
  contextBudget?: { promptTokens: number; requestedOutputTokens: number; reservedOutputTokens: number; safetyTokens: number; nativeContext: number; outputBudgetAdjusted: boolean; tokenizer: string; method: string };
  contextSnapshot?: { providerId: string; modelId: string; temperature?: number; topP?: number; topK?: number; presencePenalty?: number; toolChoice?: string; responseFormat?: string; cachePrompt?: boolean; messages: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> };
  sourceEvidence?: Array<{path:string;line:number;body:string;status?:string;sha256?:string}>;
}

export interface ToolStartEvent extends BaseAgentEvent {
  type: 'tool_start';
  toolName: string;
  callId: string;
  params: Record<string, unknown>;
  /** Set only when the agent converted a strict, fenced/raw JSON read request into a real tool call. */
  compatibilityProtocol?: 'raw-json' | 'fenced-json';
}

export interface ToolResultEvent extends BaseAgentEvent {
  type: 'tool_result';
  toolName: string;
  callId: string;
  success: boolean;
  durationMs: number;
  output: unknown;
  error?: string;
}

export interface DiffEvent extends BaseAgentEvent {
  type: 'diff';
  filePath: string;
  oldContent: string | null;
  newContent: string;
  patch: string;
}

export interface CheckpointEvent extends BaseAgentEvent {
  type: 'checkpoint';
  checkpointId: string;
  message: string;
  affectedFiles: string[];
}

export interface RollbackEvent extends BaseAgentEvent {
  type: 'rollback';
  checkpointId: string;
  success: boolean;
  restoredFiles: string[];
}

export interface UsageEvent extends BaseAgentEvent {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  /** Output generation speed (tg). Kept for backward compatibility; equals telemetry.tgTokS. */
  tokensPerSecond?: number;
  timeToFirstTokenMs?: number;
  /** Full measurement record with provenance (absent for legacy emitters). */
  telemetry?: InferenceTelemetry;
}

/**
 * Liveness while the model streams output that is not shown as text (tool-call
 * arguments). Throttled; `outputChunks` is cumulative for the current call.
 */
export interface ProgressEvent extends BaseAgentEvent {
  type: 'progress';
  phase: 'tool_call';
  outputChunks: number;
}

export interface ApprovalRequestEvent extends BaseAgentEvent {
  type: 'approval_request';
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  /** Permission category the request belongs to (write, delete, terminal...). */
  category: string;
  reason: string;
}

export interface ApprovalResultEvent extends BaseAgentEvent {
  type: 'approval_result';
  callId: string;
  toolName: string;
  approved: boolean;
  decidedBy: 'user' | 'policy' | 'timeout';
}

export interface PlanItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Task list kept by the agent (plan.update), shown under the conversation. */
export interface PlanEvent extends BaseAgentEvent {
  type: 'plan';
  items: PlanItem[];
}

/** Multiple-choice question to the user (user.ask); the run waits for the answer. */
export interface QuestionEvent extends BaseAgentEvent {
  type: 'question';
  callId: string;
  question: string;
  options: string[];
}

export interface QuestionResultEvent extends BaseAgentEvent {
  type: 'question_result';
  callId: string;
  answer: string;
  answeredBy: 'user' | 'timeout';
}

/** MAZZ Forge progress: blueprint, units, sampled candidates and their oracle verdicts. */
export interface ForgeEvent extends BaseAgentEvent {
  type: 'forge';
  phase: 'blueprint' | 'unit_start' | 'candidate' | 'unit_done' | 'files' | 'verify' | 'summary';
  blueprintId: string;
  unitId?: string;
  file?: string;
  candidate?: number;
  candidates?: number;
  /** repair: a failed candidate rewritten with its real error (compiler, test or oracle output). */
  strategy?: 'stepwise' | 'whole' | 'repair';
  verdict?: 'pass' | 'reject';
  /** unit_done: true when an execution oracle accepted the unit, false when only its syntax was checked. */
  oracle?: boolean;
  detail?: string;
  code?: string;
  success?: boolean;
  concurrency?: number;
  source?: string;
  steps?: string[];
  files?: string[];
  units?: Array<{ id: string; file: string; lang: string; steps: number }>;
  stats?: { generations: number; completionTokens: number; candidates: number; syntaxRejects: number; anchorRejects: number };
}

export interface ErrorEvent extends BaseAgentEvent {
  type: 'error';
  code: string;
  message: string;
  fatal: boolean;
}

export interface CompleteEvent extends BaseAgentEvent {
  type: 'complete';
  success: boolean;
  summary: string;
  durationMs: number;
}

export type AgentEvent =
  | TokenEvent
  | ThoughtEvent
  | StatusEvent
  | ToolStartEvent
  | ToolResultEvent
  | DiffEvent
  | CheckpointEvent
  | RollbackEvent
  | UsageEvent
  | ProgressEvent
  | ApprovalRequestEvent
  | ApprovalResultEvent
  | PlanEvent
  | QuestionEvent
  | QuestionResultEvent
  | ForgeEvent
  | ErrorEvent
  | CompleteEvent;
