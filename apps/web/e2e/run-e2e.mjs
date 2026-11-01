// End-to-end tests of the real Studio (backend + built interface) in an installed
// Chromium browser (Chrome or Edge) through playwright-core: no browser download.
//
// Isolation: a dedicated server instance on port 3350 with a temporary data
// directory and a temporary workspace; the user's own settings are never touched.
// Real-model scenarios run when a GGUF and llama-server are available:
//   MAZZ_TEST_GGUF   (default D:\TESSERA\Mgguf\Qwen_Qwen3-0.6B-Q4_K_M.gguf)
//   MAZZ_TEST_MUCE   (default D:\MAZZ GPU ACX\dist\MUCE-v0.1.0, provides llama-server)
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
const MUCE = process.env.MAZZ_TEST_MUCE || 'D:\\MAZZ GPU ACX\\dist\\MUCE-v0.1.0';
const realModel = existsSync(GGUF) && existsSync(join(MUCE, 'runtimes', 'llama-avx2', 'llama-server.exe'));

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

const only = process.env.MAZZ_E2E_ONLY ? new Set(process.env.MAZZ_E2E_ONLY.split(',')) : null;

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
    const views = ['Agent', 'Sessions', 'Projets', 'Code', 'Git', 'Modèles', 'Fournisseurs', 'Outils et MCP', 'Mémoire', 'Performance', 'MUCE', 'Paramètres', 'Accueil'];
    for (const v of views) {
      await rail(v).click();
      await page.waitForTimeout(250);
      if (v === 'MUCE') {
        await page.getByText('Service MUCE (127.0.0.1:8098)', { exact: true }).waitFor({ timeout: 10_000 });
        assert(await page.getByText('Service MUCE (127.0.0.1:8098)', { exact: true }).count() === 1, 'carte du service MUCE absente');
        assert(await page.getByText('Arrêté', { exact: true }).count() === 1, 'état du service MUCE arrêté absent');
        s.evidence.push('carte du service MUCE et état arrêté visibles; les mesures sont masquées tant que le service ne tourne pas');
      }
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
    await api('POST', '/api/muce/configure', { path: MUCE });
    await api('PUT', '/api/settings', { models: { port: MODEL_PORT, contextSize: 2048 }, permissions: { write: 'allow', terminal: 'allow' } });
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
    await page.getByRole('radio', { name: 'Agent' }).click();
    await page.getByRole('textbox', { name: 'Message pour l’agent' }).fill('Dans patch-target.txt, remplace exactement MARKER=MAZZ_OLD_9F27 par MARKER=MAZZ_NEW_6C14 avec fs.patch. Préserve les autres octets et relis ensuite le fichier avec fs.read. /no_think');
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/agent\/s_/);
    const approval = page.getByRole('alertdialog').first();
    await approval.waitFor({ timeout: 240000 });
    const approvalName = await approval.getAttribute('aria-label');
    assert(approvalName === 'Autorisation requise pour fs.patch', `approbation UI inattendue : ${approvalName}`);
    assert(readFileSync(target).equals(original), 'fs.patch a modifié le fichier avant la décision de l’interface');
    const approvalText = await approval.innerText();
    assert(approvalText.includes('patch-target.txt') && approvalText.includes('MAZZ_OLD_9F27') && approvalText.includes('MAZZ_NEW_6C14'), 'la carte d’approbation ne montre pas la cible et les valeurs exactes');
    await approval.getByRole('button', { name: 'Autoriser une fois', exact: true }).click();
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
    s.evidence.push('403 origine étrangère, 404 route, 400 dossier invalide, bandeau de déconnexion visible');
  });

  await scenario('S10', 'Absence d’emoji dans le code et les chaînes d’interface', 'backend', async (s) => {
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'check-no-emoji.mjs')], { cwd: root, encoding: 'utf-8' });
    s.evidence.push(out.trim());
  });

  await scenario('S11', 'Performance frontend : 3000 lignes de terminal et nombreuses sessions', 'backend', async (s) => {
    for (let i = 0; i < 40; i++) await api('POST', '/api/sessions', { title: `Charge ${i}`, projectRoot: workspace });
    await page.goto(`${BASE}/#/agent`);
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
      await page.getByRole('radio', { name: 'Ask' }).click();
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

  await scenario('S14', 'Aucune erreur JavaScript non gérée pendant la campagne', 'backend', async (s) => {
    const relevant = consoleErrors.filter((e) => !/Failed to load resource|ERR_FAILED|net::/.test(e));
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
