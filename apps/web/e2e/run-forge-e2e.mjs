// Browser E2E of the Forge mode through the real Studio UI (playwright-core + installed Chrome/Edge).
// Spawns scripts/forge-e2e-server.mjs --keep (MAZZ_FORGE_UI_ONLY=1): isolated server, GGUF started
// with 4 slots, Forge session created. Then drives the composer, watches the "MAZZ Forge" board,
// and always stops the model server and the isolated server at the end.
// Usage: node apps/web/e2e/run-forge-e2e.mjs [gguf]     (npm run e2e:forge -w @mazz/web)
// Output: AUDIT_RUN_2026-10-25_FORGE/ui-e2e/{results.json,*.png}, server workspace in ui-e2e/server/.

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = join(root, 'AUDIT_RUN_2026-10-25_FORGE', 'ui-e2e');
mkdirSync(out, { recursive: true });
const RUN_TIMEOUT_MS = 30 * 60_000;
const READY_TIMEOUT_MS = 8 * 60_000;
const GOAL = 'Crée un projet Python+C complet et compact de calcul CRC-32/ISO-HDLC sur des fichiers : cœur C, wrapper ctypes, CLI, tests et README.';

const checks = [];
const check = (id, pass, evidence) => {
  checks.push({ id, status: pass ? 'pass' : 'fail', evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${evidence}`);
};
const consoleErrors = [];
const shotsTaken = [];
let base;
let child;
let browser;
let page;
let fatal;

const shot = async (name) => {
  const p = join(out, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => undefined);
  shotsTaken.push(p);
};

// Starts the isolated server and resolves with { base, sessionId } on its ready line.
function startServer() {
  const args = [join(root, 'scripts', 'forge-e2e-server.mjs'), join(out, 'server'), ...process.argv.slice(2, 3), '--keep'];
  child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, MAZZ_FORGE_UI_ONLY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((ok, ko) => {
    const timer = setTimeout(() => ko(new Error('serveur Forge non prêt après 8 min')), READY_TIMEOUT_MS);
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      process.stdout.write(`[serveur] ${d}`);
      buf += d;
      const m = buf.match(/Serveur prêt pour l’interface : (\S+) \(session (\S+)\)/);
      if (m) { clearTimeout(timer); ok({ base: m[1], sessionId: m[2] }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[serveur] ${d}`));
    child.on('exit', (code) => { clearTimeout(timer); ko(new Error(`serveur Forge terminé avant d’être prêt (code ${code})`)); });
  });
}

try {
  const ready = await startServer();
  base = ready.base;
  console.log(`serveur prêt : ${base}, session ${ready.sessionId}`);

  const candidates = [
    process.env.MAZZ_TEST_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  const executablePath = candidates.find((c) => existsSync(c));
  if (!executablePath) throw new Error('Aucun navigateur Chromium installé (Chrome ou Edge). Définissez MAZZ_TEST_BROWSER.');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${base}/#/agent/${encodeURIComponent(ready.sessionId)}`);
  const box = page.getByRole('textbox', { name: 'Message pour l’agent' });
  await box.waitFor({ timeout: 30_000 });
  await page.locator('button[aria-haspopup="listbox"]', { hasText: /gguf/i }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.getByRole('radiogroup', { name: 'Mode de l’agent' }).getByRole('radio', { name: 'Forge' }).click();
  await box.fill(GOAL);
  await shot('01-debut');
  await box.press('Enter');

  const board = page.locator('section[aria-label="MAZZ Forge"]').last();
  await board.waitFor({ timeout: 5 * 60_000 }).catch(() => undefined);

  // Poll until the board shows its summary, a fatal error appears, or the turn ends.
  const t0 = Date.now();
  let firstDot = false;
  let midShot = false;
  let state = 'timeout';
  while (Date.now() - t0 < RUN_TIMEOUT_MS) {
    if (!firstDot && (await board.locator('.forge-dot').count()) > 0) { firstDot = true; await shot('02-premier-candidat'); }
    if (!midShot && Date.now() - t0 > RUN_TIMEOUT_MS / 4) { midShot = true; await shot('03-mi-parcours'); }
    if ((await board.locator('footer p').count()) > 0) { state = 'summary'; break; }
    if ((await page.locator('[role="alert"].text-bad').count()) > 0) { state = 'error'; break; }
    if ((await page.getByText(/Exécution terminée|Non terminé/).count()) > 0) { state = 'ended'; break; }
    await page.waitForTimeout(2000);
  }
  if (!midShot) await shot('03-mi-parcours');
  await page.waitForTimeout(1500);
  await shot('04-fin');
  const elapsed = Math.round((Date.now() - t0) / 1000);

  const boardVisible = await board.isVisible().catch(() => false);
  check('board_visible', boardVisible, `section « MAZZ Forge » ${boardVisible ? 'visible' : 'absente'}`);
  const validated = await board.locator('[data-forge-unit][aria-label*=", validée,"]').count();
  check('unit_validated', validated >= 1, `${validated} unité(s) validée(s)`);
  const summary = board.locator('footer p');
  const summaryText = (await summary.count()) ? await summary.first().innerText() : '';
  const summaryOk = summaryText !== '' && (await summary.first().getAttribute('class'))?.includes('text-muted');
  const alertText = state === 'error' ? await page.locator('[role="alert"].text-bad').first().innerText() : '';
  check('summary_success', Boolean(summaryOk), `état ${state} après ${elapsed}s ; résumé : ${summaryText || alertText || '(aucun)'}`.slice(0, 1200));
  const filesBlock = board.getByText('Fichiers écrits', { exact: true });
  const files = (await filesBlock.count()) ? await filesBlock.locator('xpath=..').locator('li').allInnerTexts() : [];
  check('files_written', files.length > 0, files.length ? `Fichiers écrits : ${files.join(', ')}` : 'liste « Fichiers écrits » absente');
} catch (err) {
  fatal = String(err?.stack || err).slice(0, 1500);
  console.log(`ERREUR  ${fatal}`);
  if (page) await shot('echec');
} finally {
  check('no_console_errors', consoleErrors.length === 0 && !fatal, `${consoleErrors.length} erreur(s) console${consoleErrors.length ? ' : ' + consoleErrors.join(' | ').slice(0, 800) : ''}`);
  await browser?.close().catch(() => undefined);
  if (base) await fetch(`${base}/api/models/server/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
  // The isolated server runs in the child process; kill its tree (llama-server included, if still alive).
  if (child?.pid && child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill(); }
  }
}

const failed = checks.filter((c) => c.status === 'fail').length;
const report = { date: new Date().toISOString(), goal: GOAL, base, fatal: fatal ?? null, passed: checks.length - failed, failed, checks, screenshots: shotsTaken };
writeFileSync(join(out, 'results.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} réussi(s), ${failed} échec(s). Rapport : ${join(out, 'results.json')}`);
process.exit(failed ? 1 : 0);
