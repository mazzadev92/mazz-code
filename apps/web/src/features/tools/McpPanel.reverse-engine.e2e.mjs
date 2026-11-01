// Real UI-to-MCP integration test. Uses a temporary MAZZ data directory and
// workspace, the installed Reverse Engine executable, and an installed browser.
// Run from the repository root with: node apps/web/src/features/tools/McpPanel.reverse-engine.e2e.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../');
const webRoot = path.join(repoRoot, 'apps', 'web');
const executable = 'D:\\MAZZ_REVERSE_ENGINE\\bin\\MAZZMCPServer.exe';
const engineRoot = 'D:\\MAZZ_REVERSE_ENGINE';
const browserCandidates = [
  process.env.MAZZ_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);
const browserPath = browserCandidates.find(existsSync);
const evidenceDir = process.env.MAZZ_REVERSE_UI_EVIDENCE_DIR
  ? path.resolve(process.env.MAZZ_REVERSE_UI_EVIDENCE_DIR)
  : path.resolve(repoRoot, '..', 'AUDIT_RUN_2026-10-23', 'evidence', 'reverse_engine_ui');

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function sha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function namedOrIndexed(container, label, selector, index) {
  const named = container.getByLabel(label);
  return await named.count() ? named : container.locator(selector).nth(index);
}

async function waitForExit(pid, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const evidence = {
  capturedAt: new Date().toISOString(),
  status: 'RUNNING',
  browser: browserPath ?? null,
  installedExecutable: executable,
  checks: [],
};
let studio;
let browser;
let page;
let tempRoot;
let validServerStarted = false;
let validServerId = 'mazz-reverse-engine';
let childPid;
let failure;

function passed(name, details) {
  evidence.checks.push({ name, status: 'PASS', details });
  console.log(`PASS ${name}${details ? ` — ${details}` : ''}`);
}

try {
  if (!existsSync(executable)) throw new Error(`BLOCKED: binaire installé absent (${executable}).`);
  if (!browserPath) throw new Error('BLOCKED: aucun Chrome/Edge installé; définissez MAZZ_TEST_BROWSER.');
  console.log('SETUP temporary data and workspace');
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-reverse-engine-ui-'));
  const dataDir = path.join(tempRoot, 'studio-data');
  const labRoot = path.join(tempRoot, 'reverse-engine-lab');
  const target = path.join(labRoot, '15_TESTS', 'inspection-copy', 'MAZZMCPServer.exe');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(labRoot, { recursive: true });
  await fs.copyFile(executable, target);
  const installedHashBefore = await sha256(executable);
  const targetHashBefore = await sha256(target);
  const distPath = path.join(webRoot, 'dist');
  const distIndex = path.join(distPath, 'index.html');
  const distAssets = path.join(distPath, 'assets');
  const toolsAssetName = (await fs.readdir(distAssets)).find((file) => /^ToolsView-.*\.js$/.test(file));
  if (!toolsAssetName) throw new Error(`BLOCKED: aucun bundle ToolsView trouvé dans ${distAssets}.`);
  const toolsAssetPath = path.join(distAssets, toolsAssetName);
  const toolsAssetText = await fs.readFile(toolsAssetPath, 'utf8');
  evidence.servedWebDist = {
    root: distPath,
    indexLastWriteTime: (await fs.stat(distIndex)).mtime.toISOString(),
    toolsBundle: toolsAssetPath,
    toolsBundleLastWriteTime: (await fs.stat(toolsAssetPath)).mtime.toISOString(),
    toolsBundleSha256: await sha256(toolsAssetPath),
    containsPidLabel: toolsAssetText.includes('PID'),
    containsServerIdentityLabel: toolsAssetText.includes('Serveur :'),
  };
  const apiPort = await availablePort();
  const base = `http://127.0.0.1:${apiPort}`;

  // Serve the current production web dist through the isolated Studio instance.
  console.log('SETUP import current core dist');
  const { MazzServer } = await import(pathToFileURL(path.join(repoRoot, 'packages', 'core', 'dist', 'index.js')).href);
  console.log('SETUP start isolated Studio API');
  studio = new MazzServer({ port: apiPort, host: '127.0.0.1', dataDir, webRoot: path.join(webRoot, 'dist') });
  await studio.start();
  console.log(`SETUP Studio API listening at ${base}`);
  await fs.mkdir(path.join(labRoot, '14_CONFIG'), { recursive: true });
  await fs.writeFile(path.join(labRoot, '14_CONFIG', 'lab_manifest.json'), JSON.stringify({ name: 'temporary UI connector test' }) + '\n');
  const post = async (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const getJson = async (url) => {
    const response = await fetch(`${base}${url}`);
    const body = await response.json();
    assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
    return body;
  };
  const setMcpPermissionInUi = async (permission) => {
    await page.goto(`${base}/#/settings/permissions`);
    const selector = page.getByLabel('Outils des serveurs MCP');
    await selector.waitFor();
    await selector.selectOption(permission);
    await page.getByText('Enregistré', { exact: true }).waitFor({ timeout: 10000 });
    const currentSettings = await getJson('/api/settings');
    assert.equal(currentSettings.settings.permissions.mcp, permission, `La permission MCP doit être enregistrée via l’interface (${permission}).`);
    await page.goto(`${base}/#/tools`);
    await page.getByRole('heading', { name: 'Outils, MCP et compétences' }).waitFor();
    await page.getByRole('tab', { name: 'Serveurs MCP' }).click();
  };
  const appUrl = base;
  console.log(`SETUP launch browser at ${appUrl}`);
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${appUrl}/#/tools`);
  await page.getByRole('heading', { name: 'Outils, MCP et compétences' }).waitFor();
  await page.getByRole('tab', { name: 'Serveurs MCP' }).click();
  await page.getByRole('button', { name: 'MAZZ Reverse Engine' }).click();
  const dialog = page.getByRole('dialog', { name: 'Serveur MCP : MAZZ Reverse Engine' });
  const commandField = await namedOrIndexed(dialog, 'Commande MCP', 'input', 2);
  const cwdField = await namedOrIndexed(dialog, 'Dossier de travail MCP', 'input', 3);
  const envField = await namedOrIndexed(dialog, 'Variables d’environnement MCP', 'textarea', 1);
  const configuredCommand = await commandField.inputValue();
  const configuredCwd = await cwdField.inputValue();
  assert.equal(configuredCommand, executable, 'Le modèle UI doit préremplir le binaire Reverse Engine installé.');
  assert.equal(configuredCwd, engineRoot, 'Le modèle UI doit préremplir le dossier installé.');
  await envField.fill(`MAZZ_LAB_ROOT=${labRoot}\nMAZZ_MCP_CONFIRM=deny`);
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await dialog.waitFor({ state: 'hidden' });

  let serverCard = page.getByText(`mcp.${validServerId}`, { exact: true }).locator('xpath=ancestor::section[1]');
  await serverCard.waitFor();
  assert.ok((await serverCard.innerText()).includes(executable), 'La configuration affichée doit conserver le chemin réel.');
  passed('configuration UI du binaire installé', `${configuredCommand}; cwd=${configuredCwd}; laboratoire temporaire uniquement`);

  await serverCard.getByRole('button', { name: 'Démarrer' }).click();
  const toolsButton = serverCard.getByRole('button', { name: /(Afficher|Masquer) les outils/ });
  await toolsButton.waitFor({ timeout: 45000 });
  const cardText = await serverCard.innerText();
  assert.match(cardText, /(?:version\s+)?1\.0\.0/);
  assert.match(cardText, /mazz-mcp-native-server/);
  validServerStarted = true;
  const runningState = await getJson('/api/mcp/servers');
  const liveEntry = runningState.servers.find((server) => server.id === validServerId);
  assert.equal(liveEntry?.status.state, 'running');
  childPid = liveEntry?.status.processId;
  assert.ok(childPid, 'Le backend doit exposer le PID du processus stdio réel.');
  assert.equal(liveEntry?.status.serverInfo?.name, 'mazz-mcp-native-server');
  assert.equal(liveEntry?.status.serverInfo?.version, '1.0.0');
  assert.ok(liveEntry.status.tools.length >= 20, `Nombre réel d’outils: ${liveEntry?.status.tools.length}`);
  const uiPidVisible = (await serverCard.innerText()).includes(`PID ${childPid}`);
  passed('démarrage UI/backend réel', `identity=${liveEntry.status.serverInfo.name} ${liveEntry.status.serverInfo.version}; pid=${childPid}; ${liveEntry.status.tools.length} outils`);

  // ToolTester has no agent approval dialog; configure its policy through the real settings UI.
  await setMcpPermissionInUi('allow');
  serverCard = page.getByText(`mcp.${validServerId}`, { exact: true }).locator('xpath=ancestor::section[1]');
  const inspectionToolLabel = `mcp.${validServerId}.mazz_core_inspect_binary`;
  if (!(await serverCard.getByText(inspectionToolLabel, { exact: true }).count())) {
    await serverCard.getByRole('button', { name: /(Afficher|Masquer) les outils/ }).click();
  }
  await serverCard.getByText(inspectionToolLabel, { exact: true }).waitFor();
  const toolSelect = serverCard.getByLabel('Outil à tester');
  await (await toolSelect.count() ? toolSelect : serverCard.locator('select').first()).selectOption('mazz_core_inspect_binary');
  const argsInput = serverCard.getByLabel('Arguments JSON');
  await (await argsInput.count() ? argsInput : serverCard.locator('input').last()).fill(JSON.stringify({ file_path: target }));
  await serverCard.getByRole('button', { name: 'Tester' }).click();
  const callResult = serverCard.locator('pre').last();
  await callResult.waitFor({ timeout: 30000 });
  const displayedResult = await callResult.innerText();
  const inspection = JSON.parse(displayedResult);
  assert.equal(inspection.file_name, path.basename(target));
  assert.equal(inspection.file_size, (await fs.stat(target)).size);
  assert.match(inspection.format ?? '', /PE/i);
  assert.ok(inspection.architecture, 'Le vrai résultat de l’outil doit contenir une architecture.');
  assert.equal(await sha256(target), targetHashBefore, 'La cible temporaire a été modifiée pendant l’inspection.');
  evidence.inspectionTargetSha256After = await sha256(target);
  passed('appel depuis le tester UI à l’outil réel en lecture seule', `mazz_core_inspect_binary -> ${inspection.format}/${inspection.architecture}, ${inspection.file_size} octets; résultat visible dans l’interface`);

  await serverCard.getByRole('button', { name: 'Arrêter' }).click();
  await serverCard.getByText('Arrêté', { exact: true }).waitFor();
  const stoppedState = await getJson('/api/mcp/servers');
  const stoppedEntry = stoppedState.servers.find((server) => server.id === validServerId);
  assert.equal(stoppedEntry?.status.state, 'stopped');
  assert.equal(stoppedEntry?.status.processId, undefined);
  assert.deepEqual(stoppedEntry?.status.tools, []);
  assert.ok(await waitForExit(childPid), `Le processus MCP ${childPid} est encore actif après Stop.`);
  validServerStarted = false;
  passed('arrêt depuis l’UI', `PID ${childPid} terminé; état stopped; liste d’outils vidée`);

  // A permission denial must not be rendered as a running connection.
  await setMcpPermissionInUi('deny');
  serverCard = page.getByText(`mcp.${validServerId}`, { exact: true }).locator('xpath=ancestor::section[1]');
  await serverCard.getByRole('button', { name: 'Démarrer' }).click();
  await page.getByText(/Action refusée par le centre de permissions/).waitFor();
  await serverCard.getByText('Arrêté', { exact: true }).waitFor();
  const deniedState = await getJson('/api/mcp/servers');
  const deniedEntry = deniedState.servers.find((server) => server.id === validServerId);
  assert.equal(deniedEntry?.status.state, 'stopped');
  assert.equal(deniedEntry?.status.processId, undefined);
  passed('refus de permissions visible sans faux état running', 'le backend a refusé le démarrage et l’UI est restée arrêtée');

  // Re-enable only in the temporary server, then verify a genuinely absent exe.
  await setMcpPermissionInUi('ask');
  await page.getByRole('button', { name: 'Ajouter un serveur' }).click();
  const missingDialog = page.getByRole('dialog', { name: 'Ajouter un serveur MCP' });
  const absentExecutable = path.join(tempRoot, 'missing', 'not-installed.exe');
  const idInput = await namedOrIndexed(missingDialog, 'Identifiant du serveur MCP', 'input', 0);
  const nameInput = await namedOrIndexed(missingDialog, 'Nom affiché du serveur MCP', 'input', 1);
  const commandInput = await namedOrIndexed(missingDialog, 'Commande MCP', 'input', 2);
  const cwdInput = await namedOrIndexed(missingDialog, 'Dossier de travail MCP', 'input', 3);
  await idInput.fill('missing-engine-test');
  await nameInput.fill('Binaire absent E2E');
  await commandInput.fill(absentExecutable);
  await cwdInput.fill(labRoot);
  await missingDialog.getByRole('button', { name: 'Enregistrer' }).click();
  await missingDialog.waitFor({ state: 'hidden' });
  const missingCard = page.getByText('mcp.missing-engine-test', { exact: true }).locator('xpath=ancestor::section[1]');
  await missingCard.getByRole('button', { name: 'Démarrer' }).click();
  await missingCard.getByText('Erreur', { exact: true }).waitFor({ timeout: 30000 });
  await missingCard.getByText(new RegExp(absentExecutable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).waitFor();
  const afterMissing = await getJson('/api/mcp/servers');
  const missingEntry = afterMissing.servers.find((server) => server.id === 'missing-engine-test');
  assert.equal(missingEntry?.status.state, 'error');
  assert.equal(missingEntry?.status.processId, undefined);
  passed('binaire absent indiqué comme erreur', `UI et API exposent l’échec réel pour ${absentExecutable}`);

  assert.deepEqual(pageErrors, [], `Erreurs runtime navigateur: ${pageErrors.join('\n')}`);
  assert.equal(await sha256(executable), installedHashBefore, 'Le binaire installé a changé pendant l’E2E.');
  evidence.installedExecutableSha256After = await sha256(executable);
  assert.equal(evidence.inspectionTargetSha256After, targetHashBefore);
  assert.equal(evidence.installedExecutableSha256After, installedHashBefore);
  evidence.installedExecutableUnchanged = true;
  evidence.inspectionTargetUnchanged = true;
  evidence.status = uiPidVisible ? 'PASS' : 'PARTIAL';
  evidence.temporaryLab = labRoot;
  evidence.installedExecutableSha256 = installedHashBefore;
  evidence.inspectionTarget = target;
  evidence.inspectionTargetSha256 = targetHashBefore;
  evidence.browserPageErrors = pageErrors;
  evidence.uiPidVisible = uiPidVisible;
  if (!uiPidVisible) {
    evidence.checks.push({
      name: 'PID visible dans l’interface',
      status: 'BLOCKED',
      details: `La dist servie ne contient pas encore la modification source qui affiche le PID ${childPid}; identité/version et état réel restent visibles.`,
    });
  } else {
    passed('PID visible dans l’interface', `PID ${childPid}`);
  }
} catch (error) {
  failure = error;
  evidence.status = String(error?.message ?? error).startsWith('BLOCKED:') ? 'BLOCKED' : 'FAIL';
  evidence.error = String(error?.stack ?? error);
  if (page) {
    await page.screenshot({ path: path.join(evidenceDir, `failure-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
  }
} finally {
  if (validServerStarted && studio) await studio.stop().catch((error) => { evidence.cleanupError = String(error); });
  else if (studio) await studio.stop().catch((error) => { evidence.cleanupError = String(error); });
  if (browser) await browser.close().catch((error) => { evidence.browserCleanupError = String(error); });
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true }).catch((error) => { evidence.tempCleanupError = String(error); });
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `mcp-panel-reverse-engine-${evidence.capturedAt.replace(/[:.]/g, '-')}.json`);
  evidence.evidencePath = evidencePath;
  await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`EVIDENCE ${evidencePath}`);
  console.log(`MCP_REVERSE_ENGINE_UI_E2E ${JSON.stringify(evidence)}`);
}

if (failure) {
  console.error(failure);
  process.exitCode = evidence.status === 'BLOCKED' ? 2 : 1;
} else if (evidence.status === 'PARTIAL') {
  process.exitCode = 2;
}
