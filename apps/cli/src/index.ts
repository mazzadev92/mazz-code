#!/usr/bin/env node

import * as path from 'node:path';
import { defaultWorkspaceManager, KnowledgeManager, MazzServer } from '@mazz/core';
import { defaultProviderRegistry, isLocalUrl } from '@mazz/providers';
import { defaultToolRegistry, detectToolchains } from '@mazz/tools';
import { defaultHermesBridge } from '@mazz/hermes-bridge';
import { defaultMazzAgentLoop } from '@mazz/agent';
import { defaultModelScanner, parseGgufHeader } from '@mazz/model-manager';
import type { ModelSelection } from '@mazz/shared';
import { prepareCliKnowledge } from './knowledge-context.js';
import { createInterface } from 'node:readline/promises';

/** Confirms one tool call on an interactive terminal; a non-interactive run refuses (use --yes). */
async function askOnTerminal(toolName: string, params: Record<string, unknown>): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`[33m[AUTORISATION][0m ${toolName} ${JSON.stringify(params).slice(0, 400)}
Autoriser ? (o/N) `);
    return /^(o|oui|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const args = process.argv.slice(2);
const command = args[0] || 'help';

function printHeader() {
  console.log('\x1b[32m========================================================\x1b[0m');
  console.log('\x1b[1m\x1b[38;2;201;165;122m  MAZZ ÆNGENIUM — Agent Studio (CLI v1.1.1)\x1b[0m');
  console.log('\x1b[32m========================================================\x1b[0m');
}

async function main() {
  if (args.includes('--help') || command === 'help') {
    printHeader();
    console.log(`
Usage: mazz-agent <commande> [options]

Commandes :
  doctor [--json]                    Rapport de santé système, outils et Hermes
  models list [--json]              Liste des modèles disponibles (locaux & cloud)
  models scan <dossier>             Scanne les fichiers .gguf et affiche leurs métadonnées
  providers list [--json]           Fournisseurs d'IA configurés (sans clés)
  workspace status [<path>] [--json] Analyse l'état du projet et les compilateurs
  tools list [--json]               Liste tous les outils machine disponibles
  start [--port 3333]               Démarre le serveur API/SSE local pour l'UI Studio
  run --prompt <texte> [options]    Exécute une tâche agentique réelle de bout en bout

Options pour "run" :
  --workspace <path>                Chemin du projet cible (défaut: dossier actuel)
  --model <id>                      Modèle à utiliser (défaut: modèle du serveur local)
  --provider <id>                   Provider (défaut: llama-local)
  --base-url <url>                  Endpoint loopback du runtime déjà démarré (ex. http://127.0.0.1:8080/v1)
  --max-output-tokens <nombre>      Budget de génération (défaut: 512)
  --no-knowledge                   Exécute sans récupération documentaire automatique
  --tools none                     Conversation sans outils (le modèle génère réellement la réponse)
  --mode <ask|plan|agent|auto>      Mode d'exécution (défaut: agent)
  --yes                            Exécute écritures et commandes sans confirmation (défaut: confirmation au terminal)
`);
    process.exit(0);
  }

  // 1. Doctor command
  if (command === 'doctor') {
    const ws = await defaultWorkspaceManager.getStatus();
    const hermes = defaultHermesBridge.detect();
    const toolchains = detectToolchains();
    const km = new KnowledgeManager(() => ({ home: 'D:\\Mazz Code\\Bib1', port: 8095, python: 'python' }));
    const bib1Health = await km.call('engine.health', {}).catch(() => null);
    km.stop();
    const knowledge = {
      available: km.available(),
      home: 'D:\\Mazz Code\\Bib1',
      enginesHealthy: bib1Health?.status === 'ok',
      engineVersion: bib1Health?.data?.version ?? null,
    };

    const report = {
      product: 'MAZZ ÆNGENIUM — Agent Studio',
      version: '1.1.1',
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      toolchains,
      workspace: ws,
      knowledge,
      hermes,
    };

    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHeader();
      console.log('\x1b[1mDiagnostic Système & Environnement :\x1b[0m');
      console.log(`  OS : ${process.platform} (${process.arch})`);
      console.log(`  Node.js : ${process.version}`);
      console.log(`  Workspace actif : ${ws.workspaceRoot}`);
      console.log(`  Dépôt Git : ${ws.isGitRepo ? `Oui (branche: ${ws.gitBranch})` : 'Non'}`);
      console.log('\n\x1b[1mCompilateurs & Outils détectés :\x1b[0m');
      for (const t of toolchains) {
        const status = t.isAvailable ? '\x1b[32m[OK] DISPONIBLE\x1b[0m' : '\x1b[31m[--] ABSENT\x1b[0m';
        console.log(`  - ${t.name.padEnd(8)} : ${status} ${t.version || t.path || ''}`);
      }
      console.log('\n\x1b[1mMoteurs Universels Bib1 (MAZZ Knowledge & Engines) :\x1b[0m');
      console.log(`  - Statut : ${knowledge.enginesHealthy ? `\x1b[32mOpérationnel (v${knowledge.engineVersion})\x1b[0m` : '\x1b[31mIndisponible\x1b[0m'}`);
      console.log('\n\x1b[1mConnecteur Hermes :\x1b[0m');
      console.log(`  - Statut : ${hermes.isInstalled ? '\x1b[32mInstallé\x1b[0m' : '\x1b[33mNon installé (UI & Core 100% autonomes)\x1b[0m'}`);
    }
    process.exit(0);
  }

  // 2. Models command
  if (command === 'models') {
    const sub = args[1] || 'list';
    if (sub === 'list') {
      const models = await defaultProviderRegistry.listAllModels();
      const localFiles = await defaultModelScanner.scanDefaultLocations();
      if (args.includes('--json')) {
        console.log(JSON.stringify({ models, localGgufFiles: localFiles }, null, 2));
      } else {
        printHeader();
        console.log('\x1b[1mModèles configurés :\x1b[0m');
        for (const m of models) {
          console.log(`  - \x1b[36m${m.id.padEnd(28)}\x1b[0m (${m.locality}, ${m.toolCalling})`);
        }
        if (localFiles.length > 0) {
          console.log('\n\x1b[1mFichiers .gguf locaux détectés :\x1b[0m');
          for (const f of localFiles) {
            console.log(`  - ${f.fileName} (${f.quantization}, RAM est: ${f.estimatedRamMb} Mo)`);
          }
        }
      }
      process.exit(0);
    }
  }

  // 3. Providers command
  if (command === 'providers') {
    const providers = defaultProviderRegistry.list().map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      baseUrl: p.baseUrl,
    }));
    if (args.includes('--json')) {
      console.log(JSON.stringify({ providers }, null, 2));
    } else {
      printHeader();
      console.log('\x1b[1mFournisseurs IA disponibles :\x1b[0m');
      for (const p of providers) {
        console.log(`  - [${p.id}] ${p.name} -> ${p.baseUrl}`);
      }
    }
    process.exit(0);
  }

  // 4. Tools list
  if (command === 'tools') {
    const tools = defaultToolRegistry.list();
    if (args.includes('--json')) {
      console.log(JSON.stringify({ tools }, null, 2));
    } else {
      printHeader();
      console.log('\x1b[1mOutils réels enregistrés :\x1b[0m');
      for (const t of tools) {
        console.log(`  - \x1b[33m${t.name.padEnd(16)}\x1b[0m : ${t.description}`);
      }
    }
    process.exit(0);
  }

  // 5. Start Server
  if (command === 'start') {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3333;
    const server = new MazzServer({ port });
    await server.start();
    printHeader();
    console.log(`\x1b[32m[OK] Serveur MAZZ Studio opérationnel sur http://127.0.0.1:${port}\x1b[0m`);
    console.log('Appuyez sur Ctrl+C pour arrêter le serveur.');
    // Graceful stop: flush sessions and telemetry, stop llama-server (no orphan process).
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\nArrêt du serveur...');
      await server.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGBREAK', shutdown);
    // A crash must not leave llama-server or PTY children holding RAM and ports.
    const crash = async (error: unknown) => {
      console.error('[ERREUR FATALE]', error);
      await shutdown().catch(() => process.exit(1));
    };
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
    return;
  }

  // 6. Run agent task
  if (command === 'run') {
    const promptIdx = args.indexOf('--prompt');
    if (promptIdx === -1 || !args[promptIdx + 1]) {
      console.error('\x1b[31mErreur : option --prompt requise.\x1b[0m');
      process.exit(1);
    }
    const prompt = args[promptIdx + 1];

    const wsIdx = args.indexOf('--workspace');
    const workspaceRoot = wsIdx !== -1 ? path.resolve(args[wsIdx + 1]) : process.cwd();

    const modelIdx = args.indexOf('--model');
    const modelId = modelIdx !== -1 ? args[modelIdx + 1] : 'local';

    const providerIdx = args.indexOf('--provider');
    const providerId = providerIdx !== -1 ? args[providerIdx + 1] : 'llama-local';
    const baseIdx=args.indexOf('--base-url');
    if(baseIdx!==-1){
      const baseUrl=args[baseIdx+1];
      if(!baseUrl||!isLocalUrl(baseUrl))throw new Error('--base-url exige une URL loopback sans identifiants (LOCAL STRICT).');
      const provider=defaultProviderRegistry.get(providerId);
      if(!provider?.configure)throw new Error('Fournisseur inconnu ou non configurable.');
      provider.configure({baseUrl});
    }
    const budgetIdx=args.indexOf('--max-output-tokens');
    const maxOutputTokens=budgetIdx===-1?512:Number(args[budgetIdx+1]);
    if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>131072)throw new Error('Budget de génération invalide.');

    const modeIdx = args.indexOf('--mode');
    const mode = (modeIdx !== -1 ? args[modeIdx + 1] : 'agent') as any;
    if(!['ask','plan','agent','auto','review'].includes(mode))throw new Error('Mode agent invalide.');

    const selection: ModelSelection = {
      providerId,
      modelId,
      executionMode: 'local_strict',
      allowedWorkspaceRoots: [workspaceRoot],
      maxOutputTokens,
    };

    if (!args.includes('--json')) {
      printHeader();
      console.log(`Exécution de la tâche : "${prompt}"`);
      console.log(`Workspace : ${workspaceRoot}\n`);
    }

    const taskId = `cli_${Date.now()}`;
    const events = [];

    const knowledgeStartedAt = Date.now();
    const knowledge = args.includes('--no-knowledge') ? {goal:prompt,citations:[],methods:[],verification:undefined,directAnswer:undefined,warning:undefined} : await prepareCliKnowledge(prompt, workspaceRoot);
    if (knowledge.warning) console.error(`[CONNAISSANCES] ${knowledge.warning}`);
    if (knowledge.directAnswer) {
      const timestamp = Date.now();
      events.push({ type: 'token', taskId, timestamp, delta: knowledge.directAnswer });
      events.push({ type: 'complete', taskId, timestamp, success: true, summary: knowledge.directAnswer, durationMs: timestamp - knowledgeStartedAt });
      if (args.includes('--json')) {
        console.log(JSON.stringify({ taskId, events, knowledge: { citations: knowledge.citations, methods: knowledge.methods, verification: knowledge.verification }, generationSkipped: true }, null, 2));
      } else {
        console.log(knowledge.directAnswer);
      }
      process.exit(0);
    }

    for await (const ev of defaultMazzAgentLoop.run({
      taskId,
      goal: knowledge.goal,
      workspaceRoot,
      mode,
      selection,
      ...(args[args.indexOf('--tools')+1]==='none' && args.includes('--tools') ? {allowedTools:[]} : {}),
      // --yes runs every tool without asking; otherwise each write/command is confirmed on the terminal, and refused without one.
      permissionLevel: args.includes('--yes') ? 'trusted_workspace' : 'ask_on_write',
      requestApproval: askOnTerminal,
    })) {
      events.push(ev);
      if (!args.includes('--json')) {
        if (ev.type === 'status') {
          console.log(`\x1b[34m[STATUS]\x1b[0m ${ev.message}`);
        } else if (ev.type === 'thought') {
          console.log(`\x1b[35m[RÉFLEXION]\x1b[0m ${ev.delta}`);
        } else if (ev.type === 'tool_start') {
          console.log(`\x1b[33m[OUTIL]\x1b[0m ${ev.toolName} -> ${JSON.stringify(ev.params)}`);
        } else if (ev.type === 'tool_result') {
          console.log(`\x1b[32m[RÉSULTAT]\x1b[0m ${ev.toolName} (succès: ${ev.success}, ${ev.durationMs}ms)`);
        } else if (ev.type === 'token') {
          process.stdout.write(ev.delta);
        } else if (ev.type === 'complete') {
          console.log(`\n[${ev.success ? 'TERMINE' : 'ECHEC'}] ${ev.summary} (${ev.durationMs}ms)`);
        } else if (ev.type === 'error') {
          console.log(`\n\x1b[31m[ERREUR] ${ev.message}\x1b[0m`);
        }
      }
    }

    if (args.includes('--json')) {
      console.log(JSON.stringify({ taskId, events, knowledge: { citations: knowledge.citations, methods: knowledge.methods, verification: knowledge.verification } }, null, 2));
    }
    const completed=[...events].reverse().find(ev=>ev.type==='complete');
    process.exit(completed?.type==='complete' && completed.success ? 0 : 1);
  }

  console.log(`Commande inconnue : "${command}". Utilisez --help.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\x1b[31mErreur fatale :\x1b[0m', err);
  process.exit(1);
});
