import type {
  ITool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@mazz/shared';
import { FsDeleteTool, FsListTool, FsReadTool, FsSearchTextTool, FsWriteTool } from './fs.js';
import { TerminalRunTool } from './terminal.js';
import { CompilerGccTool, detectToolchains } from './compiler.js';
import { GitStatusTool, globalCheckpointManager } from './git.js';
import { normalizeToolPaths, validateToolArgs } from './validate.js';
import { defaultDenyReason } from './default-deny.js';
import { runToolHooks } from './hooks.js';
import { isInside, physicalPath } from './fs.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CodeMapTool, CodeOutlineTool, CodeSearchTool, FsPatchTool } from './code.js';
import { ProjectCodeIndexTool } from './project-code-index.js';
import { TerminalReadTool, TerminalStartTool, TerminalStopTool } from './jobs.js';
import { FsGlobTool, GitDiffTool, GitLogTool, TestRunTool } from './workspace-tools.js';

export class ToolRegistry {
  private tools = new Map<string, ITool>();

  constructor() {
    this.registerDefaults();
  }

  register(tool: ITool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  private registerDefaults(): void {
    this.register(new FsListTool());
    this.register(new FsReadTool());
    this.register(new FsWriteTool());
    this.register(new FsDeleteTool());
    this.register(new FsSearchTextTool());
    this.register(new TerminalRunTool());
    this.register(new CompilerGccTool());
    this.register(new GitStatusTool());
    this.register(new GitDiffTool());
    this.register(new GitLogTool());
    this.register(new FsGlobTool());
    this.register(new TestRunTool());
    this.register(new FsPatchTool());
    this.register(new CodeSearchTool());
    this.register(new CodeOutlineTool());
    this.register(new CodeMapTool());
    this.register(new ProjectCodeIndexTool());
    this.register(new TerminalStartTool());
    this.register(new TerminalReadTool());
    this.register(new TerminalStopTool());
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Absolute paths outside the project and the allowed directories trigger an
   * access request. A granted directory is added to the run's allowed roots.
   */
  private async checkPathAccess(name: string, params: Record<string, unknown>, context: ToolExecutionContext): Promise<string | null> {
    const candidates: string[] = [];
    for (const k of ['path', 'sourceFiles', 'outputExe', 'cwd']) {
      const v = params[k];
      for (const p of Array.isArray(v) ? v : [v]) if (typeof p === 'string' && p) candidates.push(path.resolve(context.workspaceRoot, p));
    }
    for (const abs of candidates) {
      const physical=physicalPath(abs);
      const blocked = (context.deniedRoots ?? []).find((r) => isInside(r, abs) || isInside(physicalPath(r),physical));
      if (blocked) return `Accès à "${abs}" refusé : dossier protégé (${blocked}).`;
    }
    for (const abs of candidates.filter((c) => !isInside(physicalPath(context.workspaceRoot), physicalPath(c)))) {
      if (isInside(physicalPath(context.workspaceRoot), physicalPath(abs)) || (context.allowedRoots ?? []).some((r) => isInside(physicalPath(r), physicalPath(abs)))) continue;
      if (!context.requestPathAccess) return null; // the tool itself refuses with its confinement error
      const ok = await context.requestPathAccess(physicalPath(abs), name);
      if (!ok) return `Accès à "${abs}" refusé par l’utilisateur.`;
      let root = physicalPath(abs);
      try {
        if (!(await fs.stat(root)).isDirectory()) root = path.dirname(root);
      } catch {
        root = path.dirname(root);
      }
      if (context.allowedRoots) context.allowedRoots.push(root);
      else context.allowedRoots = [root];
    }
    return null;
  }

  async executeTool(
    name: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = this.get(name);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `Outil inconnu : "${name}". Outils disponibles : ${this.list().map((t) => t.name).join(', ')}.`,
        durationMs: 0,
      };
    }

    const argErrors = validateToolArgs(tool.definition.parameters, params);
    if (argErrors.length) {
      return {
        success: false,
        output: null,
        error: `Arguments invalides pour ${name} : ${argErrors.join(' ')}`,
        durationMs: 0,
      };
    }

    params = normalizeToolPaths(params, context.workspaceRoot);
    const { requiresPermission, isDestructive, category } = tool.definition;
    if (context.permissionLevel === 'read_only' && (requiresPermission || isDestructive || category === 'terminal' || category === 'compiler')) {
      return { success: false, output: null, error: `Permission refusée : "${name}" modifie le projet ou exécute du code, interdit en mode "read_only".`, durationMs: 0 };
    }
    const forbidden = defaultDenyReason(name, params, context.workspaceRoot);
    if (forbidden) return { success: false, output: null, error: forbidden, durationMs: 0 };
    const denied = await this.checkPathAccess(name, params, context);
    if (denied) return { success: false, output: null, error: denied, durationMs: 0 };
    const hookPayload = { tool_name: name, tool_input: params, workspace_root: context.workspaceRoot, task_id: context.taskId };
    const preHook = await runToolHooks('PreToolUse', context.hooks, hookPayload);
    if (preHook?.blocked) return { success: false, output: null, error: preHook.message, durationMs: 0 };

    // One id for the start and result events, so a UI can pair them.
    const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    context.emitEvent({
      type: 'tool_start',
      taskId: context.taskId,
      timestamp: Date.now(),
      toolName: name,
      callId,
      params,
    });

    // Check approval if required
    if (tool.definition.requiresPermission && context.permissionLevel === 'ask_on_write') {
      // A refused call still closes its tool_start, otherwise a UI shows it running forever.
      const refuse = (error: string): ToolExecutionResult => {
        context.emitEvent({ type: 'tool_result', taskId: context.taskId, timestamp: Date.now(), toolName: name, callId, success: false, durationMs: 0, output: null, error });
        return { success: false, output: null, error, durationMs: 0 };
      };
      if (!context.requestApproval) return refuse(`Action "${name}" bloquée : l’interface n’a fourni aucun gestionnaire d’autorisation.`);
      const approved = await context.requestApproval(name, params);
      if (!approved) return refuse(`Action "${name}" refusée par l’utilisateur.`);
    }

    const start = Date.now();
    try {
      let result = await tool.execute(params, context);
      const postHook = await runToolHooks('PostToolUse', context.hooks, { ...hookPayload, tool_response: { success: result.success, output: result.output, error: result.error } });
      // The tool already ran: its output is kept, the hook's message is what the model must act on.
      if (postHook?.blocked) result = { ...result, success: false, error: [result.error, postHook.message].filter(Boolean).join('\n') };
      context.emitEvent({
        type: 'tool_result',
        taskId: context.taskId,
        timestamp: Date.now(),
        toolName: name,
        callId,
        success: result.success,
        durationMs: result.durationMs,
        output: result.output,
        error: result.error,
      });
      return result;
    } catch (err) {
      const dur = Date.now() - start;
      const errorMsg = (err as Error).message;
      context.emitEvent({
        type: 'tool_result',
        taskId: context.taskId,
        timestamp: Date.now(),
        toolName: name,
        callId,
        success: false,
        durationMs: dur,
        output: null,
        error: errorMsg,
      });
      return {
        success: false,
        output: null,
        error: errorMsg,
        durationMs: dur,
      };
    }
  }
}

export const defaultToolRegistry = new ToolRegistry();
