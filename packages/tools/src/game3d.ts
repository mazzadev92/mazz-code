import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { runBoundedCompilerProcess } from './compiler.js';
import { resolveSafePath } from './fs.js';

/**
 * Optional converter script (.xbg to .glb) supplied by the user through MAZZ_XBG_TO_GLB. The public build ships
 * no converter and no default location: without the variable the tool reports that it is not configured.
 */
export const XBG_TO_GLB_CANDIDATES: string[] = []; // the user supplies the converter through MAZZ_XBG_TO_GLB; the public build ships none
export const EXTRACT_GAME_3D_TIMEOUT_MS = 120_000;

export class ExtractGame3dTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'extract_game_3d',
    description: 'Extrait un modèle 3D depuis un fichier binaire .xbg et génère un fichier .glb standard.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        input_xbg_path: { type: 'string', description: 'Chemin absolu du fichier .xbg' },
        output_glb_path: { type: 'string', description: 'Chemin de destination du modèle .glb' },
      },
      required: ['input_xbg_path'],
    },
    requiresPermission: true,
    isDestructive: false,
  };

  constructor(
    private readonly scriptCandidates: readonly string[] = process.env.MAZZ_XBG_TO_GLB ? [process.env.MAZZ_XBG_TO_GLB] : XBG_TO_GLB_CANDIDATES,
    private readonly python: string = process.env.MAZZ_PYTHON || 'python',
    private readonly timeoutMs: number = EXTRACT_GAME_3D_TIMEOUT_MS,
  ) {}

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    const fail = (error: string): ToolExecutionResult => ({ success: false, output: null, error, durationMs: Date.now() - start });
    try {
      if (typeof params.input_xbg_path !== 'string' || !params.input_xbg_path.trim()) return fail('Paramètre "input_xbg_path" manquant.');
      if (params.output_glb_path !== undefined && typeof params.output_glb_path !== 'string') return fail('Paramètre "output_glb_path" : chaîne attendue.');
      if (!/\.xbg$/i.test(params.input_xbg_path)) return fail('L’entrée doit être un fichier .xbg.');
      const requestedOutput = params.output_glb_path?.trim() || params.input_xbg_path.replace(/\.xbg$/i, '.glb');
      if (!/\.glb$/i.test(requestedOutput)) return fail('La sortie doit être un fichier .glb.');
      const input = resolveSafePath(context.workspaceRoot, params.input_xbg_path, context.allowedRoots);
      const output = resolveSafePath(context.workspaceRoot, requestedOutput, context.allowedRoots);
      const stat = await fs.stat(input).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      if (!stat?.isFile()) return fail(`Fichier .xbg introuvable : ${params.input_xbg_path}`);
      const script = this.scriptCandidates.find((candidate) => existsSync(candidate));
      if (!script) return fail(`Convertisseur xbg_to_glb.py introuvable (cherché : ${this.scriptCandidates.join(', ')}).`);

      await fs.mkdir(path.dirname(output), { recursive: true });
      const run = await runBoundedCompilerProcess(this.python, [script, input, output], path.dirname(script), this.timeoutMs);
      if (run.timedOut) return fail(`Conversion interrompue après ${Math.round(this.timeoutMs / 1000)} s.`);
      if (run.error) return fail(`Python indisponible (${this.python}) : ${run.error}`);
      if (run.code !== 0) return fail(`Échec de la conversion (code ${run.code}) : ${run.stderr.trim().split('\n').slice(-3).join(' ') || run.stdout.trim()}`);
      const glb = await fs.stat(output).catch(() => undefined); // best effort: probe: absent or unreadable path is treated as missing
      if (!glb?.isFile() || glb.size === 0) return fail('Le convertisseur a terminé sans produire de fichier .glb.');
      return {
        success: true,
        output: { glbPath: output, bytes: glb.size, report: run.stdout.trim().split('\n').at(-1) ?? '' },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return fail((err as Error).message);
    }
  }
}
