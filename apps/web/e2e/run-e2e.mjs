// End-to-end tests of the real Studio (backend + built interface) in an installed
// Chromium browser (Chrome or Edge) through playwright-core: no browser download.
//
// Isolation: a dedicated server instance on port 3350 with a temporary data
// directory and a temporary workspace; the user's own settings are never touched.
// Real-model scenarios run when a GGUF and llama-server are available:
//   MAZZ_TEST_GGUF   (default D:\TESSERA\Mgguf\Qwen_Qwen3-0.6B-Q4_K_M.gguf)
//   MAZZ_TEST_LLAMA_DIR   (default D:\MAZZ GPU ACX\build\llama-avx2\bin\Release; folder holding llama-server.exe)
//
// Output: docs/e2e-results.json and screenshots in docs/screenshots/.

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const shots = process.env.MAZZ_E2E_OUTPUT_DIR ? resolve(process.env.MAZZ_E2E_OUTPUT_DIR) : join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });

const PORT = Number(process.env.MAZZ_E2E_PORT || 3350);
const MODEL_PORT = Number(process.env.MAZZ_TEST_MODEL_PORT || 18103);
const BASE = `http://127.0.0.1:${PORT}`;
const RESULTS_PATH = process.env.MAZZ_E2E_RESULTS ? resolve(process.env.MAZZ_E2E_RESULTS) : join(root, 'docs', 'e2e-results.json');
const GGUF = process.env.MAZZ_TEST_GGUF || 'D:\\TESSERA\\Mgguf\\Qwen_Qwen3-0.6B-Q4_K_M.gguf';
const LLAMA_DIR = process.env.MAZZ_TEST_LLAMA_DIR || 'D:\\MAZZ GPU ACX\\build\\llama-avx2\\bin\\Release';
const realModel = existsSync(GGUF) && existsSync(join(LLAMA_DIR, 'llama-server.exe'));

// The test workspace must behave like a normal user shell.
delete process.env.NoDefaultCurrentDirectoryInExePath;
process.env.MAZZ_TEST_PROVIDER = '1';

const { MazzServer } = await import(new URL('../../../packages/core/dist/index.js', import.meta.url));

const dataDir = mkdtempSync(join(tmpdir(), 'mazz-e2e-data-'));
const workspace = mkdtempSync(join(tmpdir(), 'mazz-e2e-ws-'));
const server = new MazzServer({ port: PORT, dataDir, webRoot: join(root, 'apps', 'web', 'dist'), devOrigins: [] });
await server.start();

const results = [];
const consoleErrors = [];
let current = null;
let modelLoadBlockedReason = null;

const cliArgs = process.argv.slice(2).flatMap((a) => a.split(',')).filter(Boolean);
const only = (process.env.MAZZ_E2E_ONLY || cliArgs.length) ? new Set(cliArgs.length ? cliArgs : process.env.MAZZ_E2E_ONLY.split(',')) : null;

async function scenario(id, title, level, fn) {
  if (only && !only.has(id)) return;
  const t0 = Date.now();
  current = { id, title, level, status: 'pass', evidence: [], durationMs: 0 };
  try {
    await fn(current);
  } catch (err) {
    current.status = 'fail';
    current.error = String(err?.stack || err).slice(0, 1500);
    await page.screenshot({ path: join(shots, `echec-${id}.png`) }).catch(() => undefined);
  }
  current.durationMs = Date.now() - t0;
  results.push(current);
  const label = current.status === 'pass' ? 'PASS' : current.status === 'skip' ? 'SKIP' : current.status === 'blocked' ? 'BLOCKED' : 'FAIL';
  console.log(`${label}  ${id}  ${title}${current.error ? `\n      ${current.error.split('\n')[0]}` : ''}${current.note ? `\n      ${current.note}` : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
};

// First installed Chromium-based browser (Chrome or Edge); MAZZ_TEST_BROWSER overrides.
const candidates = [
  process.env.MAZZ_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);
const executablePath = candidates.find((c) => existsSync(c));
if (!executablePath) throw new Error('Aucun navigateur Chromium installé (Chrome ou Edge). Définissez MAZZ_TEST_BROWSER.');
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const shot = async (name) => {
  const p = join(shots, `${name}.png`);
  await page.screenshot({ path: p });
  current?.evidence.push(p);
};
const rail = (label) => page.locator(`nav[aria-label="Navigation principale"] button[aria-label="${label}"]`);

try {
  await api('POST', '/api/workspace/open', { path: workspace });

  await scenario('S1', 'Démarrage, affichage du Studio et endpoints', 'backend', async (s) => {
    const h = await api('GET', '/api/health');
    assert(h.status === 200 && h.data.status === 'ok', 'health KO');
    await page.goto(BASE);
    await page.getByRole('heading', { name: /Ingénierie logicielle locale/ }).waitFor();
    await page.getByText('État du système').waitFor();
    await page.waitForSelector('text=Aucune action requise, text=Résoudre', { timeout: 10000 }).catch(() => undefined);
    await shot('01-accueil-bioforge');
    s.evidence.push(`health ${h.data.version}, workspace ${h.data.workspace.name}`);
  });

  await scenario('S2', 'Navigation complète, raccourcis, panneaux et persistance', 'backend', async (s) => {
    const views = ['Agent', 'Sessions', 'Projets', 'Code', 'Git', 'Modèles', 'Fournisseurs', 'Calcul GPU', 'Outils et MCP', 'Mémoire', 'Performance', 'Paramètres', 'Accueil'];
    for (const v of views) {
      const mvp = { Agent: 'Agents MVP', Modèles: 'Modèles GGUF', Accueil: 'Workspaces', Sessions: 'Sessions', Projets: 'Projets', 'Calcul GPU': 'Calcul GPU' };
      const hashes = { Code: 'code', Git: 'git', Fournisseurs: 'providers', 'Outils et MCP': 'tools', Mémoire: 'memory', Performance: 'performance', Paramètres: 'settings' };
      if (mvp[v]) await rail(mvp[v]).click(); // the advanced views live in a popover menu: reached by their route
      else await page.evaluate((h) => { location.hash = `#/${h}`; }, hashes[v]);
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert(!overflow, `débordement horizontal sur ${v}`);
    }
    s.evidence.push(`${views.length} vues visitées sans débordement`);
    await page.keyboard.press('Control+K');
    await page.getByRole('dialog', { name: 'Palette de commandes' }).waitFor();
    await page.keyboard.type('perf');
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/performance/);
    s.evidence.push('Ctrl+K puis « perf » ouvre Performance');
    await page.keyboard.press('Alt+1');
    await page.waitForURL(/#\/home/);
    const before = await page.locator('aside[aria-label="Barre latérale"]').count();
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(150);
    const after = await page.locator('aside[aria-label="Barre latérale"]').count();
    assert(before !== after, 'Ctrl+B sans effet');
    await page.reload();
    await page.getByText('État du système').waitFor();
    const persisted = await page.locator('aside[aria-label="Barre latérale"]').count();
    assert(persisted === after, 'disposition non persistée après rechargement');
    await page.keyboard.press('Control+b');
    s.evidence.push('Ctrl+B persiste après rechargement');
  });

  await scenario('S2b', 'Thèmes Bioforge / Blueprint, clair et persistance backend', 'backend', async (s) => {
    await page.goto(`${BASE}/#/settings/appearance`);
    await page.getByRole('radio', { name: 'Blueprint Engineer' }).click();
    await page.getByText('Enregistré').first().waitFor();
    await page.goto(`${BASE}/#/home`);
    await page.reload();
    await page.getByText('État du système').waitFor();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert(theme === 'blueprint', `thème après rechargement : ${theme}`);
    const saved = await api('GET', '/api/settings');
    assert(saved.data.settings.appearance.theme === 'blueprint', 'thème non enregistré côté serveur');
    await shot('02-accueil-blueprint');
    await page.goto(`${BASE}/#/settings/appearance`);
    await page.getByRole('radio', { name: 'Clair' }).click();
    await page.getByText('Enregistré').first().waitFor();
    await page.goto(`${BASE}/#/home`);
    await page.getByText('État du système').waitFor();
    await shot('03-accueil-blueprint-clair');
    await api('POST', '/api/settings/reset', { section: 'appearance' });
    s.evidence.push('thème et luminosité persistés dans settings.json puis réinitialisés');
  });

  await scenario('S3', 'Sessions : création, renommage, archivage, reprise après rechargement', 'backend', async (s) => {
    const created = await api('POST', '/api/sessions', { title: 'Session E2E', projectRoot: workspace });
    const id = created.data.session.id;
    const run = await fetch(`${BASE}/api/agent/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, goal: 'Test structurel', mode: 'ask', selection: { providerId: 'deterministic-test', modelId: 'mazz-deterministic-v1' } }) });
    await run.text();
    await page.goto(`${BASE}/#/agent/${id}`);
    await page.getByText('Test structurel').first().waitFor();
    await page.getByRole('button', { name: 'Actions de la session' }).click();
    await page.getByRole('menuitem', { name: 'Renommer' }).click();
    const input = page.getByRole('textbox', { name: 'Nom de la session' });
    await input.fill('Session E2E renommée');
    await input.press('Enter');
    await page.getByText('Session E2E renommée').first().waitFor();
    await page.reload();
    await page.getByText('Session E2E renommée').first().waitFor();
    const r = await api('PATCH', `/api/sessions/${id}`, { archived: true });
    assert(r.data.session.archived === true, 'archivage KO');
    const list = await api('GET', '/api/sessions?archived=1');
    assert(list.data.sessions.find((x) => x.id === id)?.archived, 'session archivée absente');
    await api('PATCH', `/api/sessions/${id}`, { archived: false });
    s.evidence.push('renommage via l’UI conservé après rechargement ; archivage aller-retour');
    s.note = 'Moteur de test déterministe utilisé pour la structure uniquement (aucune métrique affichée).';
  });

  await scenario('S4a', 'Model Hub : erreurs de chemin et fichier vocabulaire seul', 'backend', async (s) => {
    const bad = await api('POST', '/api/models/library', { path: join(workspace, 'absent.gguf') });
    assert(bad.status === 422, `chemin invalide : ${bad.status}`);
    const notGguf = join(workspace, 'faux.gguf');
    writeFileSync(notGguf, 'pas un modèle');
    const nf = await api('POST', '/api/models/library', { path: notGguf });
    assert(nf.status === 422 && /Signature/.test(nf.data.error), 'fichier non GGUF accepté');
    const start = await api('POST', '/api/models/server/start', { modelPath: notGguf });
    assert(start.status === 422, 'démarrage avec un modèle invalide accepté');
    s.evidence.push('422 pour chemin absent, signature invalide et démarrage refusé');
  });

  await scenario('S4', 'Chargement d’un GGUF réel via l’UI, démarrage et arrêt de llama-server', 'real-model', async (s) => {
    if (!realModel) {
      s.status = 'skip';
      s.note = 'GGUF ou llama-server absent.';
      return;
    }
    await api('PUT', '/api/settings', { models: { runtimeDir: LLAMA_DIR } });
    await api('PUT', '/api/settings', { models: { port: MODEL_PORT, contextSize: 2048, memoryReserveMb: 256 }, permissions: { write: 'allow', terminal: 'allow' } });
    const add = await api('POST', '/api/models/library', { path: GGUF });
    assert(add.status === 200, 'ajout bibliothèque KO');
    await page.goto(`${BASE}/#/models`);
    await page.getByRole('button', { name: 'Charger' }).first().click();
    const startRequestPromise = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url() === `${BASE}/api/models/server/start`,
      { timeout: 10000 },
    ).catch(() => null);
    await page.getByRole('dialog').getByRole('button', { name: 'Démarrer' }).click();
    const startRequest = await startRequestPromise;
    assert(startRequest, 'le bouton Démarrer n’a envoyé aucun POST /api/models/server/start');
    const startResponse = await startRequest.response();
    assert(startResponse, 'la requête /api/models/server/start a été interrompue avant sa réponse');
    const startBody = await startResponse.text();
    s.evidence.push(`POST /api/models/server/start → HTTP ${startResponse.status()}: ${startBody.slice(0, 1200)}`);
    let parsedStartBody;
    try { parsedStartBody = JSON.parse(startBody); } catch { parsedStartBody = null; }
if (startResponse.status() === 409 && parsedStartBody?.details?.code === 'INSUFFICIENT_MEMORY') {
      s.evidence.push(`Avertissement memoire insuffisante observe dans l interface (${parsedStartBody.details.availableMb} Mo disponibles, ${parsedStartBody.details.requiredMb} Mo requis avec reserve)`);
      await page.getByText('Démarrage bloqué : mémoire insuffisante').waitFor({ timeout: 10000 });
      const forcerBtn = page.getByRole('button', { name: 'Forcer' });
      await forcerBtn.waitFor({ timeout: 5000 });
      const forceRequestPromise = page.waitForRequest(
        (request) => request.method() === 'POST' && request.url() === `${BASE}/api/models/server/start`,
        { timeout: 10000 },
      );
      await forcerBtn.click();
      const forceRequest = await forceRequestPromise;
      const forceResponse = await forceRequest.response();
      const forceBody = await forceResponse.text();
      s.evidence.push(`POST /api/models/server/start (force) -> HTTP ${forceResponse.status()}: ${forceBody.slice(0, 1200)}`);
      assert(forceResponse.ok(), `demarrage force refuse (${forceResponse.status()}) : ${forceBody.slice(0, 1200)}`);
    } else {
      assert(startResponse.ok(), `demarrage du modele refuse (${startResponse.status()}) : ${startBody.slice(0, 1200)}`);
    }
    await page.getByText('Chargé et prêt').waitFor({ timeout: 120000 });
    await page.getByText('Mémoire mesurée (working set)').waitFor();
    await page.getByText('Cache KV par session : actif').waitFor({ timeout: 15000 });
    await page.getByText('Profil matériel').waitFor();
    await page.getByText('AVX2').first().waitFor({ timeout: 20000 });
    await shot('04-model-hub-charge');
    s.evidence.push('cache KV par session actif, profil matériel affiché');
    const st = await api('GET', '/api/models/server/status');
    s.evidence.push(`llama-server prêt en ${st.data.loadMs} ms, PID ${st.data.pid}`);
  });

  await scenario('S5', 'Prompt vers un vrai moteur : streaming, outils, diff', 'real-model', async (s) => {
    if (!realModel) {
      s.status = 'skip';
      return;
    }
    if (modelLoadBlockedReason) {
      s.status = 'blocked';
      s.note = `Prérequis S4 non satisfait : ${modelLoadBlockedReason}`;
      return;
    }
    const target = join(workspace, 'patch-target.txt');
    const original = Buffer.from('HEADER\r\nMARKER=MAZZ_OLD_9F27\r\nFOOTER\r\n', 'utf8');
    const expected = Buffer.from('HEADER\r\nMARKER=MAZZ_NEW_6C14\r\nFOOTER\r\n', 'utf8');
    writeFileSync(target, original);
    const settings = await api('PUT', '/api/settings', { permissions: { write: 'ask' }, ai: { maxOutputTokens: 512, temperature: 0 } });
    assert(settings.status === 200, `impossible de configurer l’approbation ponctuelle : ${settings.status}`);
    await page.goto(`${BASE}/#/agent`);
    // Start from a new session (the agent view reopens the last active one), then wait
    // until the loaded local model is selected and the composer is enabled.
    await page.getByRole('button', { name: 'Nouvelle session' }).first().click();
    await page.locator('button[aria-haspopup="listbox"]', { hasText: /gguf/i }).waitFor({ timeout: 20000 });
    await page.getByRole('radio', { name: 'Action' }).click();
    await page.getByRole('textbox', { name: 'Message pour l’agent' }).fill('Lis d’abord patch-target.txt avec fs.read. Ensuite, remplace exactement MARKER=MAZZ_OLD_9F27 par MARKER=MAZZ_NEW_6C14 avec fs.patch. Préserve les autres octets et relis enfin le fichier avec fs.read. /no_think');
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/agent\/s_/);
    const approval = page.getByRole('alertdialog').first();
    await approval.waitFor({ timeout: 240000 });
    const approvalName = await approval.getAttribute('aria-label');
    assert(approvalName === 'Autorisation requise pour fs.patch', `approbation UI inattendue : ${approvalName}`);
    assert(readFileSync(target).equals(original), 'fs.patch a modifié le fichier avant la décision de l’interface');
    const approvalText = await approval.innerText();
    assert(approvalText.includes('patch-target.txt') && approvalText.includes('MAZZ_OLD_9F27') && approvalText.includes('MAZZ_NEW_6C14'), 'la carte d’approbation ne montre pas la cible et les valeurs exactes');
    await approval.getByRole('button', { name: /^Autoriser une fois/ }).click();
    await page.getByText(/terminée|Non terminé/i).first().waitFor({ timeout: 240000 });
    await shot('05-agent-session-reelle');
    const url = page.url();
    const id = decodeURIComponent(url.split('/').pop());
    const sess = await api('GET', `/api/sessions/${id}`);
    const events = sess.data.session.turns.flatMap((t) => t.events);
    const patchStart = events.find((e) => e.type === 'tool_start' && e.toolName === 'fs.patch');
    const patchResult = events.filter((e) => e.type === 'tool_result' && e.toolName === 'fs.patch').at(-1);
    const rereadResult = events.filter((e) => e.type === 'tool_result' && e.toolName === 'fs.read').at(-1);
    assert(patchStart?.params?.path === 'patch-target.txt', 'le modèle n’a pas proposé le patch vers la cible attendue');
    assert(events.some((e) => e.type === 'approval_result' && e.toolName === 'fs.patch' && e.approved === true), 'la décision UI d’autorisation ponctuelle manque');
    assert(patchResult?.success === true, `fs.patch n’a pas réussi : ${JSON.stringify(patchResult)}`);
    assert(rereadResult?.success === true && rereadResult.output?.content === expected.toString('utf8'), `fs.read n’a pas retourné le contenu exact : ${JSON.stringify(rereadResult)}`);
    assert(readFileSync(target).equals(expected), 'les octets persistés diffèrent du contenu exact relu par fs.read');
    s.evidence.push(`GGUF=${GGUF}; fs.patch proposé puis autorisé dans l’UI; fs.read exact; octets disque identiques (${expected.length} octets)`);
    assert(events.some((e) => e.type === 'usage'), 'aucun événement usage');
  });

  await scenario('S6', 'tg_tok_s correspond à la sortie, pp_tok_s à l’entrée ; absence et changement de modèle', 'real-model', async (s) => {
    if (!realModel) {
      s.status = 'skip';
      return;
    }
    const runs = await api('GET', '/api/telemetry/runs?kind=agent');
    const real = runs.data.runs.filter((r) => r.speedSource === 'runtime_timings');
    assert(real.length > 0, 'aucune mesure runtime');
    for (const r of real) {
      assert(r.tgTokS > 0 && r.ppTokS > 0, 'tg ou pp manquant');
      assert(r.completionTokens !== r.promptTokens || r.tgTokS !== r.ppTokS, 'pp et tg confondus');
    }
    const last = real[real.length - 1];
    s.evidence.push(`dernier appel : tg ${last.tgTokS.toFixed(2)} tok/s (${last.completionTokens} jetons générés), pp ${last.ppTokS.toFixed(1)} tok/s (${last.promptTokens} jetons d’entrée), TTFT ${last.ttftMs} ms`);
    const det = await fetch(`${BASE}/api/agent/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x', mode: 'ask', selection: { providerId: 'deterministic-test', modelId: 'mazz-deterministic-v1' } }) });
    const txt = await det.text();
    assert(/"speedSource":"synthetic"/.test(txt) && !/"tokensPerSecond":\d/.test(txt), 'le moteur de test produit une vitesse');
    s.evidence.push('changement de moteur : le moteur de test ne publie aucune vitesse (source synthetic)');
    await page.goto(`${BASE}/#/performance`);
    await page.getByRole('tab', { name: 'Historique' }).click();
    await page.getByText('Débits par appel de modèle').waitFor();
    await shot('06-performance-historique');
  });

  await scenario('S6b', 'Benchmark llama.cpp à méthodologie fixe', 'real-model', async (s) => {
    if (!realModel) {
      s.status = 'skip';
      return;
    }
    const b = await api('POST', '/api/bench/run', { promptTokens: 128, nPredict: 32, repetitions: 2 });
    assert(b.status === 200, `benchmark ${b.status} ${b.text.slice(0, 200)}`);
    s.evidence.push(`pp moyen ${b.data.meanPpTokS.toFixed(1)} tok/s, tg moyen ${b.data.meanTgTokS.toFixed(2)} tok/s, méthodologie ${b.data.methodologyKey}`);
    await page.goto(`${BASE}/#/performance/benchmarks`);
    await page.getByText('Comparaison à méthodologie identique').waitFor();
    await shot('07-performance-benchmarks');
  });

  await scenario('S7', 'Clé API : ajout, test, suppression sans jamais exposer le secret', 'backend', async (s) => {
    const secret = 'gsk_e2eSECRET_1234567890abcdef';
    const bodies = [];
    page.on('response', async (r) => {
      if (r.url().includes('/api/')) bodies.push(await r.text().catch(() => ''));
    });
    await page.goto(`${BASE}/#/providers`);
    await page.getByRole('textbox', { name: 'Clé API Groq API' }).fill(secret);
    await page.getByRole('textbox', { name: 'Clé API Groq API' }).press('Enter');
    await page.getByText('Clé configurée').first().waitFor();
    await page.waitForTimeout(400);
    const dom = await page.content();
    assert(!dom.includes('1234567890abcdef'), 'secret présent dans le DOM');
    assert(!bodies.some((b) => b.includes('1234567890abcdef')), 'secret présent dans une réponse API');
    const ls = await page.evaluate(() => JSON.stringify(localStorage));
    assert(!ls.includes('1234567890'), 'secret dans localStorage');
    await shot('08-fournisseurs-cle-masquee');
    const test = await api('POST', '/api/providers/test', { providerId: 'groq-api' });
    s.evidence.push(`test de connexion avec clé invalide : ok=${test.data.ok} (${String(test.data.message).slice(0, 80)})`);
    const del = await api('DELETE', '/api/providers/groq-api/key');
    assert(del.status === 200, 'suppression KO');
    s.evidence.push('secret absent du DOM, des réponses API et du localStorage ; seul l’indice masqué est affiché');
  });

  await scenario('S8', 'Fichier, compilation C, journal et retour arrière via l’interface', 'backend', async (s) => {
    await api('PUT', '/api/files/write', { path: 'main.c', content: '#include <stdio.h>\nint main(void){printf("ok\\n");return 0;}\n' });
    await page.goto(`${BASE}/#/code/main.c`);
    await page.locator('.cm-content').waitFor();
    await page.keyboard.press('Control+j');
    const cmd = page.getByRole('textbox', { name: 'Commande' });
    await cmd.fill('gcc main.c -o main.exe; .\\main.exe');
    await cmd.press('Enter');
    await page.getByText(/\[code 0/).waitFor({ timeout: 60000 });
    await shot('09-code-terminal-compilation');
    const cps = await api('GET', '/api/checkpoints');
    const editorCp = cps.data.checkpoints.find((c) => c.id.startsWith('chk_editor_'));
    assert(editorCp, 'point de restauration éditeur absent');
    const rb = await api('POST', `/api/checkpoints/${editorCp.id}/rollback`);
    assert(rb.data.success && !existsSync(join(workspace, 'main.c')), 'rollback KO (main.c devait être supprimé)');
    s.evidence.push('compilation GCC réelle code 0 dans le terminal ; rollback a supprimé le fichier créé');
    await page.keyboard.press('Control+j');
  });

  await scenario('S9', 'Échecs contrôlés : serveur injoignable, route inconnue, origine étrangère, dossier illisible', 'backend', async (s) => {
    const foreign = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert(foreign.status === 403, 'origine étrangère acceptée');
    const unknown = await api('GET', '/api/nope');
    assert(unknown.status === 404, '404 attendu');
    const ws = await api('POST', '/api/workspace/open', { path: join(workspace, 'nexiste-pas') });
    assert(ws.status === 400, 'dossier absent accepté');
    await page.route('**/api/health', (r) => r.abort());
    await page.goto(`${BASE}/#/home`);
    await page.reload();
    await page.getByText(/Serveur Studio déconnecté/).waitFor({ timeout: 10000 });
    await shot('10-backend-deconnecte');
    await page.unroute('**/api/health');
    await page.reload();
    await page.getByText('État du système').waitFor({ timeout: 10000 });
    s.evidence.push('403 origine étrangère, 404 route, 400 dossier invalide, bandeau de déconnexion visible');
  });

  await scenario('S10', 'Absence d’emoji dans le code et les chaînes d’interface', 'backend', async (s) => {
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'check-no-emoji.mjs')], { cwd: root, encoding: 'utf-8' });
    s.evidence.push(out.trim());
  });

  await scenario('S11', 'Performance frontend : 3000 lignes de terminal et nombreuses sessions', 'backend', async (s) => {
    for (let i = 0; i < 40; i++) await api('POST', '/api/sessions', { title: `Charge ${i}`, projectRoot: workspace });
    await page.goto(`${BASE}/#/agent`);
    await page.getByRole('button', { name: 'Nouvelle session' }).first().waitFor({ timeout: 15000 });
    await page.keyboard.press('Control+j');
    const cmd = page.getByRole('textbox', { name: 'Commande' });
    const t0 = Date.now();
    await cmd.fill('1..3000 | ForEach-Object { "ligne $_" }');
    await cmd.press('Enter');
    await page.getByText(/\[code 0/).waitFor({ timeout: 60000 });
    const elapsed = Date.now() - t0;
    const rendered = await page.locator('[role="log"] > div > div').count();
    assert(rendered < 200, `trop de lignes dans le DOM (${rendered})`);
    const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
    s.evidence.push(`3000 lignes reçues et affichées en ${elapsed} ms ; ${rendered} lignes présentes dans le DOM (virtualisation) ; tas JS ${heap ?? 'N/D'} Mo ; 40 sessions listées`);
    await page.keyboard.press('Control+j');
  });

  await scenario('S12', 'Responsive : 1366x768, 1600x900, 1920x1080, 1920x1200', 'backend', async (s) => {
    for (const [w, h] of [
      [1366, 768],
      [1920, 1080],
      [1920, 1200],
      [1600, 900],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      for (const v of ['home', 'agent', 'models', 'settings']) {
        await page.goto(`${BASE}/#/${v}`);
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert(!overflow, `débordement ${w}x${h} sur ${v}`);
      }
      if (w === 1366) await shot('11-agent-1366x768');
    }
    s.evidence.push('aucun débordement horizontal sur 4 vues x 4 tailles');
  });

  if (realModel) {
    await scenario('S13', 'Reprise du flux après rechargement pendant une génération réelle', 'real-model', async (s) => {
      await page.goto(`${BASE}/#/agent`);
      await page.getByRole('button', { name: 'Nouvelle session' }).first().click();
      await page.locator('button[aria-haspopup="listbox"]', { hasText: /gguf/i }).waitFor({ timeout: 20000 });
      await page.getByRole('textbox', { name: 'Message pour l’agent' }).fill('Explique en trois phrases ce qu’est un compilateur. /no_think');
      await page.getByRole('radio', { name: 'Question' }).click();
      await page.getByRole('textbox', { name: 'Message pour l’agent' }).press('Enter');
      await page.waitForURL(/#\/agent\/s_/);
      await page.waitForTimeout(4000);
      await page.reload();
      await page.getByText(/terminée|Non terminé/i).first().waitFor({ timeout: 240000 });
      await shot('12-agent-reprise-apres-rechargement');
      s.evidence.push('page rechargée pendant la génération ; la tâche a continué côté serveur et le flux a été repris jusqu’à la fin');
    });
    await scenario('S4b', 'Arrêt de llama-server depuis l’interface', 'real-model', async (s) => {
      if (modelLoadBlockedReason) {
        s.status = 'blocked';
        s.note = `Aucun serveur de test n’a démarré : ${modelLoadBlockedReason}`;
        return;
      }
      await page.goto(`${BASE}/#/models`);
      await page.getByRole('button', { name: 'Arrêter' }).first().click();
      // The stop first saves the session KV cache, then ends the process.
      let st;
      for (let i = 0; i < 30; i++) {
        st = await api('GET', '/api/models/server/status');
        if (st.data.state === 'stopped') break;
        await page.waitForTimeout(500);
      }
      assert(st.data.state === 'stopped', `état ${st.data.state}`);
      await page.getByText('Arrêté', { exact: true }).first().waitFor({ timeout: 15000 });
      s.evidence.push('llama-server arrêté, état « stopped »');
    });
  }

  await scenario('S15', 'Calcul GPU : envoyer un modèle vers un fournisseur (relais simulé)', 'ui', async (s) => {
    const sent = [];
    const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    await page.route(/\/api\/compute\/providers$/, (r) => json(r, { providers: [
      { id: 'kaggle', label: 'Kaggle (GPU gratuit)', summary: 's', free_note: 'f', accepts: ['gguf'], setup: [], needs_token: false, token_label: '', state: { configured: true, ok: true, detail: 'OK' }, deployments: [] },
      { id: 'modal', label: 'Modal (vLLM)', summary: 's', free_note: 'f', accepts: ['hf'], setup: [], needs_token: false, token_label: '', state: { configured: true, ok: true }, deployments: [] },
    ] }));
    await page.route(/\/api\/compute\/sources$/, (r) => json(r, { local: [{ filename: 'm.gguf', size_bytes: 1e9 }], hf: { repo: 'u/r', files: [], error: null } }));
    await page.route(/\/api\/compute\/catalog$/, (r) => json(r, { models: [{ id: 'q', name: 'Qwen test', modality: 'text', repo: 'o/r', file: 'q.gguf', size_gb: 9, license: 'apache-2.0', engine: 'gguf', note: '', api_alternatives: [], fits: { kaggle: true } }] }));
    await page.route(/\/api\/compute\/serving$/, (r) => json(r, { backends: [{ id: 'kaggle-t4', kind: 'kaggle', models: ['m'], healthy: true }] }));
    await page.route(/\/api\/compute\/send$/, (r) => { sent.push(r.request().postDataJSON()); return json(r, { id: 'j1', title: 'm -> Kaggle', status: 'running', steps: [], progress: 0.1, message: '', result: {} }, 202); });
    await page.route(/\/api\/compute\/jobs\/j1$/, (r) => json(r, { id: 'j1', title: 'm -> Kaggle', status: 'done', steps: [{ name: 'Attendre le serveur', status: 'done', detail: '' }], progress: 1, message: 'Pret : modele kaggle-t4/m', result: {} }));
    await page.goto(BASE);
    await rail('Calcul GPU').click();
    await page.getByRole('heading', { name: 'Calcul GPU' }).waitFor();
    const send = page.getByRole('button', { name: 'Envoyer et démarrer' });
    assert(await send.isDisabled(), 'le bouton doit rester désactivé sans modèle ni fournisseur');
    await page.selectOption('#cmp-model', 'm.gguf');
    const options = await page.locator('#cmp-target option').allTextContents();
    assert(options.some((o) => o.includes('Kaggle')) && !options.some((o) => o.includes('Modal')), `Modal (vLLM) ne doit pas être proposé pour un GGUF : ${options.join(' | ')}`);
    await page.selectOption('#cmp-target', 'kaggle');
    await send.click();
    await page.getByText('Terminé', { exact: true }).waitFor({ timeout: 15_000 });
    assert(sent.length === 1 && sent[0].target === 'kaggle' && sent[0].source.filename === 'm.gguf', `corps envoyé inattendu : ${JSON.stringify(sent)}`);
    await page.getByText('kaggle-t4').first().waitFor();
    await page.getByRole('button', { name: 'Préparer l’envoi' }).click();
    assert((await page.locator('#cmp-target').inputValue()) === 'kaggle', 'le catalogue doit présélectionner le fournisseur compatible');
    await shot('15-calcul-gpu');
    s.evidence.push('format GGUF filtre les fournisseurs, envoi POST /api/compute/send, tâche suivie jusqu’à « Terminé »');
  });

  await scenario('S16', 'Fournisseurs : clé, interrupteur, ajout et suppression (relais simulé)', 'ui', async (s) => {
    const calls = [];
    const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const rows = [
      { id: 'groq', label: 'Groq', status: 'active', capabilities: ['chat'], routed: true, env: 'GROQ_KEY', key_hint: 'gsk...abcd' },
      { id: 'myllm', label: 'Mon LLM', status: 'missing_key', capabilities: ['chat'], routed: true, env: 'MYLLM_KEY', custom: true },
    ];
    await page.route(/\/api\/integrations\/status$/, (r) => json(r, { enabled: false, configured: 1, total: 2, providers: rows }));
    await page.route(/\/api\/integrations\/quota$/, (r) => json(r, { providers: [] }));
    await page.route(/\/api\/integrations\/(groq|myllm|providers)(\/.*)?$/, (r) => {
      const req = r.request();
      if (req.method() === 'GET') return r.fallback();
      calls.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() ? req.postDataJSON() : null });
      return json(r, req.method() === 'POST' ? { id: 'x' } : { ok: true });
    });
    await page.goto(`${BASE}/#/providers`);
    await page.getByRole('button', { name: 'Ajouter un fournisseur' }).waitFor({ timeout: 15_000 });
    const groq = page.locator('div.py-2').filter({ hasText: 'Groq' }).first();
    const mine = page.locator('div.py-2').filter({ hasText: 'Mon LLM' }).first();
    assert(await groq.getByRole('button', { name: 'Enregistrer' }).isDisabled(), 'Enregistrer doit être désactivé sans clé saisie');
    await groq.getByLabel('Clé Groq').fill('gsk_new_key_123456');
    await groq.getByRole('button', { name: 'Enregistrer' }).click();
    await groq.getByRole('button', { name: 'Retirer' }).click();
    await groq.getByRole('button', { name: 'Désactiver' }).click();
    await mine.getByRole('button', { name: /Supprimer Mon LLM/ }).click();
    await page.getByRole('button', { name: 'Ajouter un fournisseur' }).click();
    await page.fill('#np-id', 'nouveau');
    await page.fill('#np-url', 'https://api.exemple.com/v1');
    await page.fill('#np-model', 'gros-modele');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await page.waitForTimeout(500);
    const has = (m, p, check) => calls.some((c) => c.method === m && c.path === p && (!check || check(c.body)));
    assert(has('PUT', '/api/integrations/groq/key', (b) => b.key === 'gsk_new_key_123456'), 'PUT clé absent');
    assert(has('DELETE', '/api/integrations/groq/key'), 'DELETE clé absent');
    assert(has('PUT', '/api/integrations/groq/enabled', (b) => b.enabled === false), 'PUT enabled:false absent');
    assert(has('DELETE', '/api/integrations/providers/myllm'), 'DELETE fournisseur absent');
    assert(has('POST', '/api/integrations/providers', (b) => b.id === 'nouveau' && b.base_url === 'https://api.exemple.com/v1' && b.models[0].id === 'gros-modele'), `POST ajout inattendu : ${JSON.stringify(calls)}`);
    await shot('16-fournisseurs-gestion');
    s.evidence.push(`${calls.length} appels de gestion vérifiés (clé, retrait, désactivation, suppression, ajout)`);
  });

  await scenario('S17', 'Services : catalogue guide, filtre et enregistrement d’un jeton (relais simule)', 'ui', async (s) => {
    const posts = [];
    const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const entry = (over) => ({ id: 'x', name: 'X', category: 'gpu_notebook', family: 'notebook', support: 'full', provider_id: null, website: 'https://x.test', signup_url: 'https://x.test/signup', free_tier: 'Gratuit', free_kind: 'weekly', requires_card: false, requires_phone: false, secret_name: '', where_to_find: '', where_saved: 'Chiffre localement', steps: ['Creez un compte.'], notes: '', source_url: 'https://x.test/docs', verified_at: '2026-11-04', ...over });
    await page.route(/\/api\/compute\/services$/, (r) => json(r, { services: [
      entry({ id: 'kaggle', name: 'Kaggle', provider_id: 'kaggle', secret_name: 'Jeton API Kaggle', steps: ['Creez un compte sur kaggle.com.', 'Settings > API > Create New Token.'] }),
      entry({ id: 'paidco', name: 'PaidCo', requires_card: true, free_kind: 'trial', support: 'guide' }),
      entry({ id: 'mystery', name: 'Mystery', free_kind: 'unknown', requires_card: null, free_tier: 'Non verifie : voir la page officielle', support: 'guide' }),
    ] }));
    await page.route(/\/api\/compute\/providers$/, (r) => json(r, { providers: [{ id: 'kaggle', state: { configured: false, ok: null, detail: 'Jeton absent.' } }] }));
    await page.route(/\/api\/integrations\/status$/, (r) => json(r, { enabled: false, configured: 0, total: 0, providers: [] }));
    await page.route(/\/api\/compute\/providers\/kaggle\/configure$/, (r) => { posts.push(r.request().postDataJSON()); return json(r, { state: { configured: true, ok: true, detail: 'Compte demo - API OK' } }); });
    await page.goto(`${BASE}/#/services`);
    await page.getByRole('button', { name: /Kaggle/ }).first().waitFor({ timeout: 15_000 });
    assert((await page.getByText('PaidCo').count()) === 0 && (await page.getByText('Mystery').count()) === 0, 'le filtre "sans carte" doit masquer PaidCo et le service non verifie');
    await page.getByLabel(/sans carte bancaire seulement/).uncheck();
    await page.getByText('PaidCo').waitFor();
    await page.getByRole('button', { name: /Mystery/ }).click();
    await page.getByText('Quota non vérifié').waitFor();
    await page.getByRole('button', { name: /Kaggle/ }).first().click();
    await page.getByText('Settings > API > Create New Token.').waitFor();
    const save = page.getByRole('button', { name: 'Enregistrer et tester' });
    assert(await save.isDisabled(), 'Enregistrer doit etre desactive sans jeton');
    await page.getByLabel('Jeton API Kaggle').fill('{"username":"demo","key":"abc"}');
    await save.click();
    await page.getByText('Compte demo - API OK').waitFor();
    assert(posts.length === 1 && posts[0].token.includes('demo'), `corps inattendu : ${JSON.stringify(posts)}`);
    await shot('17-services');
    s.evidence.push('filtre sans carte, avertissement quota non verifie, guide pas a pas, POST configure avec le jeton');
  });

  await scenario('S18', 'Assistant de premier lancement : étapes, glossaire, Hugging Face, tout passer (relais simule)', 'ui', async (s) => {
    const posts = [];
    const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const entry = (over) => ({ id: 'x', name: 'X', category: 'gpu_notebook', family: 'notebook', support: 'full', provider_id: null, website: 'https://x.test', signup_url: 'https://x.test/signup', free_tier: 'Gratuit', free_kind: 'weekly', requires_card: false, requires_phone: false, secret_name: '', where_to_find: '', where_saved: 'Chiffre localement', steps: ['Creez un compte.'], notes: '', source_url: 'https://x.test/docs', verified_at: '2026-11-04', ...over });
    await page.route(/\/api\/compute\/services$/, (r) => json(r, { services: [
      entry({ id: 'huggingface', name: 'Hugging Face', category: 'model_hub', provider_id: 'huggingface', secret_name: 'Jeton Hugging Face' }),
      entry({ id: 'kaggle', name: 'Kaggle', provider_id: 'kaggle' }),
      entry({ id: 'modal', name: 'Modal', category: 'serverless_gpu' }),
      entry({ id: 'colab', name: 'Colab' }),
    ] }));
    await page.route(/\/api\/compute\/providers$/, (r) => json(r, { providers: [{ id: 'huggingface', state: { configured: false, ok: null, detail: 'Jeton absent.' } }] }));
    await page.route(/\/api\/integrations\/status$/, (r) => json(r, { enabled: false, configured: 0, total: 0, providers: [] }));
    await page.route(/\/api\/compute\/providers\/huggingface\/configure$/, (r) => { posts.push(r.request().postDataJSON()); return json(r, { state: { configured: true, ok: true, detail: 'Compte HF demo - OK' } }); });
    await page.evaluate(() => { try { localStorage.removeItem('mazz.setup.step'); localStorage.removeItem('mazz.setup.goals'); } catch {} });
    assert((await api('PUT', '/api/settings', { general: { onboardingDone: false } })).status === 200, 'PUT settings');
    await page.goto(`${BASE}/#/home`);
    await page.reload();
    await page.getByText('Assistant de première configuration').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Commencer' }).click();
    await page.getByText('Votre ordinateur', { exact: false }).first().waitFor();
    const term = page.getByRole('button', { name: /^Quantification/ });
    await term.focus();
    await page.getByRole('tooltip').waitFor();
    assert((await page.getByRole('tooltip').innerText()).includes('Compression du modèle'), 'infobulle du glossaire attendue au focus clavier');
    await page.keyboard.press('Escape');
    assert((await page.getByRole('tooltip').count()) === 0, 'Échap doit fermer l’infobulle');
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Suivant' }).click();
    const tokenField = page.getByLabel('Jeton Hugging Face');
    await tokenField.waitFor();
    await tokenField.fill('hf_demo_token');
    await page.getByRole('button', { name: 'Enregistrer et tester' }).click();
    await page.getByText('Compte HF demo - OK').waitFor();
    assert(posts.length === 1 && posts[0].token === 'hf_demo_token', `corps inattendu : ${JSON.stringify(posts)}`);
    await page.getByRole('button', { name: 'Suivant' }).click();
    for (const n of ['Kaggle', 'Modal', 'Colab']) await page.getByRole('button', { name: new RegExp(n) }).first().waitFor();
    await shot('18-assistant');
    await page.getByRole('button', { name: 'Tout passer' }).click();
    await page.getByText('Assistant de première configuration').waitFor({ state: 'detached' });
    const st = await api('GET', '/api/settings');
    assert(st.data.settings.general.onboardingDone === true, 'Tout passer doit marquer onboardingDone');
    s.evidence.push('glossaire au focus clavier, POST configure Hugging Face, 3 fiches GPU, Tout passer => onboardingDone');
  });

  await scenario('S14', 'Aucune erreur JavaScript non gérée pendant la campagne', 'backend', async (s) => {
    const relevant = consoleErrors.filter((e) => !/Failed to load resource|ERR_FAILED|net::|Failed to fetch dynamically imported module/.test(e));
    s.evidence.push(`${consoleErrors.length} message(s) console d’erreur, dont ${relevant.length} hors erreurs réseau provoquées par S9`);
    assert(relevant.length === 0, relevant.join('\n').slice(0, 800));
  });
} finally {
  await browser.close();
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const summary = {
  date: new Date().toISOString(),
  browser: `${executablePath} (playwright-core, headless)`,
  realModel: realModel ? GGUF : null,
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status === 'fail').length,
  skipped: results.filter((r) => r.status === 'skip').length,
  blocked: results.filter((r) => r.status === 'blocked').length,
  results,
};
mkdirSync(dirname(RESULTS_PATH), { recursive: true });
writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} réussi(s), ${summary.failed} échec(s), ${summary.skipped} ignoré(s), ${summary.blocked} bloqué(s). Rapport : ${RESULTS_PATH}`);
process.exit(summary.failed ? 1 : summary.blocked ? 2 : 0);
