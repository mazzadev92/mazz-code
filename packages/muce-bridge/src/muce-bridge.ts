import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { MuceManifest } from '@mazz/shared';

/** UI-facing lifecycle state (see docs/TELEMETRY_SPEC.md, section MUCE). */
export type MuceState = 'absent' | 'detected' | 'incompatible' | 'ready' | 'error';

export interface MuceBridgeStatus {
  state: MuceState;
  isConfigured: boolean;
  muceHome?: string;
  isManifestValid: boolean;
  manifest?: MuceManifest;
  isCliAvailable: boolean;
  cliAbsolutePath?: string;
  isFallbackActive: boolean;
  error?: string;
  diagnostics: string[];
  /** True while token generation is served by llama.cpp (always, until MUCE declares generation). */
  generationUsesLlamaCpp?: boolean;
  /** Whether the manifest declares token-generation acceleration for GGUF models. */
  generativeAcceleration: 'declared' | 'unsupported' | 'unknown';
  capabilities?: Record<string, unknown>;
  unsupported?: string[];
  commands?: Record<string, string[]>;
  integrationDocPath?: string;
  llamaRuntimeDir?: string;
  /** Speculative decoding methods declared by the manifest (llama.cpp runtime, no kernel replacement). */
  speculativeMethods?: string[];
}

/**
 * Accepts both the bridge's own manifest shape and MUCE schema_version 1
 * (product / version / paths.cli / capabilities.unsupported).
 */
export function normalizeMuceManifest(raw: any): { manifest: MuceManifest; extra: Partial<MuceBridgeStatus> } {
  if (raw && typeof raw === 'object' && raw.schema_version !== undefined) {
    const caps = (raw.capabilities || {}) as Record<string, unknown>;
    const unsupported = Array.isArray(caps.unsupported) ? (caps.unsupported as string[]) : [];
    const hasSpeculativeOrGguf = Array.isArray(caps.gguf) && (caps.gguf as string[]).some((c) => /speculative|radix|sparse|native_generation/i.test(c));
    const generative: MuceBridgeStatus['generativeAcceleration'] = hasSpeculativeOrGguf
      ? 'declared'
      : unsupported.includes('muce_llm_kernel_replacement')
        ? 'unsupported'
        : Array.isArray(caps.compute) && (caps.compute as string[]).some((c) => /gguf|llm|token/i.test(c))
          ? 'declared'
          : 'unknown';
    return {
      manifest: {
        manifestVersion: String(raw.schema_version),
        name: raw.product,
        version: raw.version,
        cliPath: raw.paths?.cli,
        dllPath: raw.paths?.dll,
        headerPath: raw.paths?.header,
      },
      extra: {
        generativeAcceleration: generative,
        capabilities: caps,
        unsupported,
        commands: raw.commands,
        llamaRuntimeDir: raw.paths?.llama_runtime_optional,
        speculativeMethods: Array.isArray(caps.gguf) ? (caps.gguf as string[]).filter((c) => c.startsWith('speculative_')) : [],
      },
    };
  }
  const ggufRuntime = raw?.capabilities?.ggufRuntime;
  return {
    manifest: raw as MuceManifest,
    extra: { generativeAcceleration: ggufRuntime === true ? 'declared' : ggufRuntime === false ? 'unsupported' : 'unknown' },
  };
}

export class MuceBridge {
  private muceHome?: string;

  constructor(customMuceHome?: string) {
    this.muceHome = customMuceHome || process.env.MAZZ_MUCE_HOME;
  }

  setMuceHome(newPath: string): void {
    this.muceHome = newPath;
  }

  getMuceHome(): string | undefined {
    return this.muceHome;
  }

  async inspect(): Promise<MuceBridgeStatus> {
    const diagnostics: string[] = [];

    if (!this.muceHome || !this.muceHome.trim()) {
      diagnostics.push('Aucun chemin racine MUCE configuré. Utilisation du fallback transparent llama.cpp.');
      return {
        state: 'absent',
        isConfigured: false,
        isManifestValid: false,
        isCliAvailable: false,
        isFallbackActive: true,
        generativeAcceleration: 'unknown',
        diagnostics,
      };
    }

    const home = path.resolve(this.muceHome);
    diagnostics.push(`Dossier MUCE configuré : "${home}".`);

    // Check directory existence
    try {
      const stat = await fs.stat(home);
      if (!stat.isDirectory()) {
        diagnostics.push('Le chemin configuré n’est pas un dossier.');
        return {
          state: 'error',
          isConfigured: true,
          muceHome: home,
          isManifestValid: false,
          isCliAvailable: false,
          isFallbackActive: true,
          generativeAcceleration: 'unknown',
          error: 'Le chemin configuré n’est pas un dossier.',
          diagnostics,
        };
      }
    } catch (err) {
      diagnostics.push(`Dossier MUCE inaccessible : ${(err as Error).message}`);
      return {
        state: 'error',
        isConfigured: true,
        muceHome: home,
        isManifestValid: false,
        isCliAvailable: false,
        isFallbackActive: true,
        generativeAcceleration: 'unknown',
        error: `Dossier introuvable : ${(err as Error).message}`,
        diagnostics,
      };
    }

    // Check INTEGRATION_MANIFEST.json
    const manifestPath = path.join(home, 'INTEGRATION_MANIFEST.json');
    let manifest: MuceManifest;
    let extra: Partial<MuceBridgeStatus> = {};
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      ({ manifest, extra } = normalizeMuceManifest(JSON.parse(raw)));
    } catch (err) {
      diagnostics.push(`Fichier INTEGRATION_MANIFEST.json absent ou JSON invalide : ${(err as Error).message}`);
      return {
        state: 'incompatible',
        isConfigured: true,
        muceHome: home,
        isManifestValid: false,
        isCliAvailable: false,
        isFallbackActive: true,
        generativeAcceleration: 'unknown',
        error: `Manifeste invalide : ${(err as Error).message}`,
        diagnostics,
      };
    }

    // Validate manifest structure
    if (!manifest.name || !manifest.version) {
      diagnostics.push('Le manifeste MUCE ne contient pas les champs obligatoires "name" et "version".');
      return {
        state: 'incompatible',
        isConfigured: true,
        muceHome: home,
        isManifestValid: false,
        manifest,
        isCliAvailable: false,
        isFallbackActive: true,
        generativeAcceleration: 'unknown',
        error: 'Champs obligatoires manquants dans le manifeste.',
        diagnostics,
      };
    }

    diagnostics.push(`Manifeste valide détecté : ${manifest.name} v${manifest.version}.`);

    // Check CLI binary if specified
    let cliAvailable = false;
    let cliAbsolutePath: string | undefined;

    if (manifest.cliPath) {
      const candidates = [
        path.resolve(home, manifest.cliPath),
        path.resolve(home, 'dist', `MUCE-v${manifest.version}`, manifest.cliPath),
        path.resolve(home, 'dist', 'MUCE-v0.3.5', manifest.cliPath),
        path.resolve(home, 'build', 'Release', path.basename(manifest.cliPath)),
      ];
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          cliAvailable = true;
          cliAbsolutePath = candidate;
          diagnostics.push(`Binaire CLI vérifié : "${candidate}".`);
          break;
        } catch {}
      }
      if (!cliAvailable) {
        diagnostics.push(`Binaire CLI déclaré mais absent sur le disque : "${candidates[0]}".`);
      }
    }

    let integrationDocPath: string | undefined;
    try {
      await fs.access(path.join(home, 'INTEGRATE_WITH_MUCE.md'));
      integrationDocPath = path.join(home, 'INTEGRATE_WITH_MUCE.md');
    } catch {}

    const generativeAcceleration = extra.generativeAcceleration ?? 'unknown';
    if (generativeAcceleration === 'declared') {
      diagnostics.push('Accélération générative active : décodage spéculatif N-Gram, persistance des pools GGML et cache Radix déclarés.');
    } else if (generativeAcceleration === 'unsupported') {
      diagnostics.push('Le manifeste déclare "muce_llm_kernel_replacement" non pris en charge : la génération reste assurée par llama.cpp.');
    }

    return {
      state: cliAvailable ? 'ready' : 'incompatible',
      isConfigured: true,
      muceHome: home,
      isManifestValid: true,
      manifest,
      isCliAvailable: cliAvailable,
      cliAbsolutePath,
      // Legacy contract: the bridge itself is operational when the CLI exists.
      isFallbackActive: !cliAvailable,
      // Token generation stays on llama.cpp unless MUCE declares generative acceleration.
      generationUsesLlamaCpp: !cliAvailable || generativeAcceleration !== 'declared',
      diagnostics,
      ...extra,
      generativeAcceleration,
      integrationDocPath,
    };
  }

  /**
   * Runs one manifest command (hardware, backends, benchmark) without a shell.
   * Only commands declared by the manifest and resolved inside MUCE home are run.
   */
  async runCommand(name: string, timeoutMs = 60000): Promise<{ success: boolean; data?: unknown; raw?: string; error?: string; durationMs: number }> {
    const start = Date.now();
    const status = await this.inspect();
    if (!status.isCliAvailable || !status.cliAbsolutePath || !status.muceHome) {
      return { success: false, error: 'CLI MUCE non disponible.', durationMs: 0 };
    }
    const declared = status.commands?.[name];
    const args = declared ? declared.slice(1) : [name, '--json'];
    if (args.some((a) => /MODEL\.gguf|profiles\//.test(a))) {
      return { success: false, error: `La commande "${name}" exige des paramètres non fournis.`, durationMs: 0 };
    }
    return await new Promise((resolve) => {
      execFile(status.cliAbsolutePath!, args, { cwd: status.muceHome, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        if (err) {
          resolve({ success: false, error: (stderr || err.message).slice(0, 2000), raw: stdout, durationMs });
          return;
        }
        try {
          resolve({ success: true, data: JSON.parse(stdout), durationMs });
        } catch {
          resolve({ success: true, raw: stdout.slice(0, 20000), durationMs });
        }
      });
    });
  }

  async queryHardware(): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const r = await this.runCommand('hardware', 8000);
    return { success: r.success, data: r.data ?? r.raw, error: r.error };
  }
}

export const defaultMuceBridge = new MuceBridge();
