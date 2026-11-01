/**
 * MAZZ ÆNGENIUM — Schéma des Entités & Invariants de Domaine
 * 
 * Modèle de données strict sans données fictives en dur hors fixtures.
 * Connecté aux contrats d'échange du backend MAZZ (packages/core/src/server.ts).
 */

import type { AgentMode, AttachmentMeta } from '../lib/types';

export type ReasoningState = 'streaming' | 'complete' | 'collapsed';

export interface ReasoningEntity {
  readonly id: string;
  readonly messageId: string;
  readonly taskId: string;
  readonly state: ReasoningState;
  readonly expandedByUser: boolean;
  readonly content: string;
  readonly durationMs: number | null;
  readonly tokenCount: number;
}

export type ToolStatus = 'pending' | 'executing' | 'success' | 'failed' | 'denied' | 'expired';

export interface ToolCallEntity {
  readonly id: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly category: string;
  readonly args: Record<string, unknown>;
  readonly result?: {
    readonly success: boolean;
    readonly output: string;
    readonly truncated: boolean;
    readonly totalBytes: number;
  };
  readonly status: ToolStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly requiresApproval: boolean;
  readonly isDestructive: boolean;
}

export interface ApprovalEntity {
  readonly id: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly commandOrPath: string;
  readonly summary: string;
  readonly impact: {
    readonly filesCount: number;
    readonly additions: number;
    readonly deletions: number;
  };
  readonly scope: 'turn' | 'session' | 'project';
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly resolvedAt?: number;
  readonly rejectionReason?: string;
}

export interface PlanStepEntity {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly status: 'todo' | 'in_progress' | 'done' | 'failed' | 'skipped';
  readonly toolHints?: readonly string[];
  readonly targetFiles?: readonly string[];
  readonly durationMs?: number;
}

export interface PlanEntity {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly title: string;
  readonly steps: readonly PlanStepEntity[];
  readonly activeStepId?: string;
  readonly status: 'draft' | 'executing' | 'completed' | 'aborted';
  readonly createdAt: number;
}

export interface CheckpointEntity {
  readonly id: string;
  readonly timestamp: number;
  readonly description: string;
  readonly workspaceRoot: string;
  readonly files: readonly string[];
  readonly fileCount: number;
  readonly gitBranch?: string;
}

export interface ComposerDraftEntity {
  readonly draftKey: string;
  readonly text: string;
  readonly mode: AgentMode;
  readonly providerId: string;
  readonly modelId: string;
  readonly attachments: readonly AttachmentMeta[];
  readonly state: 'idle' | 'typing' | 'sending' | 'streaming';
  readonly isPlanModeActive: boolean;
  readonly lastNativeTokens?: number;
  readonly lastVirtualTokens?: number;
}

/**
 * Validateur d'invariants de domaine
 */
export const SchemaInvariants = {
  assertReasoning(r: ReasoningEntity): void {
    if (!r.id || !r.messageId) throw new Error('[Invariant Violé] Reasoning sans id ou messageId valide.');
    if (r.durationMs !== null && r.durationMs < 0) throw new Error('[Invariant Violé] durationMs négatif.');
  },

  assertToolCall(t: ToolCallEntity): void {
    if (!t.toolName.trim()) throw new Error('[Invariant Violé] ToolCall sans nom d’outil.');
    if (t.status === 'success' && !t.result) throw new Error('[Invariant Violé] Outil en succès sans résultat déclaré.');
  },

  assertApproval(a: ApprovalEntity): void {
    if (a.expiresAt <= a.requestedAt) throw new Error('[Invariant Violé] Date d’expiration antérieure à la requête.');
  },
} as const;
