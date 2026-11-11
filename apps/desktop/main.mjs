/**
 * MAZZ Code — coque de bureau Electron.
 *
 * Démarre la passerelle Python (127.0.0.1:7070), puis le serveur Studio Node sur un port libre,
 * affiche l'interface une fois les deux prêts, et arrête proprement tous les enfants à la fermeture.
 *
 * Aucune donnée du propriétaire n'est lue : le dossier de données est %APPDATA%\Mazz Code
 * (ou <installation>\data quand portable.flag est présent), créé au premier lancement.
 */
import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.resolve(here, '..', '..', '..'); // apps/desktop -> D:\Mazz Code
const EXE_DIR = path.dirname(process.execPath);
const PORTABLE = existsSync(path.join(EXE_DIR, 'portable.flag'));

const DATA_ROOT = process.env.MAZZ_DESKTOP_DATA
  ? path.resolve(process.env.MAZZ_DESKTOP_DATA)
  : PORTABLE
    ? path.join(EXE_DIR, 'data')
    : path.join(app.getPath('appData'), app.isPackaged ? 'Mazz Code' : 'Mazz Code Dev');
const LOGS_DIR = path.join(DATA_ROOT, 'logs');
const MODELS_DIR = PORTABLE ? path.join(EXE_DIR, 'models') : path.join(DATA_ROOT, 'models');
const WORKSPACE_DIR = path.join(DATA_ROOT, 'workspace');
const ELECTRON_DIR = path.join(DATA_ROOT, 'electron');
const LOG_FILE = path.join(LOGS_DIR, 'desktop.log');

/**
 * Variables propres à la copie portable (clé Hugging Face, dépôt, options).
 * Format KEY=VALUE. Les variables déjà présentes dans l'environnement gardent la priorité.
 */
function readPortableEnv(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const PORTABLE_ENV = readPortableEnv(path.join(DATA_ROOT, 'portable.env'));
const MODAL_CONFIG = path.join(DATA_ROOT, 'modal.toml');

mkdirSync(LOGS_DIR, { recursive: true });
mkdirSync(MODELS_DIR, { recursive: true });
mkdirSync(WORKSPACE_DIR, { recursive: true });
mkdirSync(ELECTRON_DIR, { recursive: true });

// Mode portable : le profil Chromium (cookies, stockage local, cache) reste lui aussi sur la cle USB.
app.setPath('userData', ELECTRON_DIR);
app.setPath('sessionData', ELECTRON_DIR);

const logStream = createWriteStream(LOG_FILE, { flags: 'a' });
function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  logStream.write(text);
  if (!app.isPackaged) process.stdout.write(text);
}

function layout() {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return {
      resources: res,
      studio: path.join(res, 'studio'),
      gateway: path.join(res, 'gateway'),
      python: path.join(res, 'python', 'python.exe'),
      node: path.join(res, 'node', 'node.exe'),
      llama: path.join(res, 'llama', 'llama-server.exe'),
      legal: path.join(res, 'legal'),
    };
  }
  // Développement : utilise les binaires déjà installés sur la machine, ou ceux préparés par
  // scripts/build-desktop.mjs (build/desktop/resources).
  const staged = process.env.MAZZ_DESKTOP_RESOURCES || path.join(DEV_ROOT, 'build', 'desktop', 'resources');
  const hasStaged = existsSync(path.join(staged, 'studio', 'apps', 'cli', 'dist', 'index.js'));
  const python =
    process.env.MAZZ_PYTHON ||
    (existsSync('C:\\Python314\\python.exe') ? 'C:\\Python314\\python.exe' : 'python');
  const node = process.env.MAZZ_NODE || 'node';
  return {
    resources: hasStaged ? staged : DEV_ROOT,
    studio: hasStaged ? path.join(staged, 'studio') : path.join(DEV_ROOT, 'MAZZ_AGENT_STUDIO'),
    gateway: hasStaged ? path.join(staged, 'gateway') : path.join(DEV_ROOT, 'mazz_control'),
    python: hasStaged && existsSync(path.join(staged, 'python', 'python.exe'))
      ? path.join(staged, 'python', 'python.exe')
      : python,
    node: hasStaged && existsSync(path.join(staged, 'node', 'node.exe'))
      ? path.join(staged, 'node', 'node.exe')
      : node,
    llama: existsSync(path.join(staged, 'llama', 'llama-server.exe'))
      ? path.join(staged, 'llama', 'llama-server.exe')
      : '',
    legal: existsSync(path.join(staged, 'legal')) ? path.join(staged, 'legal') : path.join(DEV_ROOT, 'docs', 'legal'),
  };
}

const L = layout();
const desktopToken = randomBytes(32).toString('hex');

let win = null;
let gateway = null;
let studio = null;
let studioPort = 0;
let shuttingDown = false;
let startupFailed = false;
const recent = [];

function remember(line) {
  recent.push(line);
  if (recent.length > 80) recent.shift();
}

function setStatus(text) {
  log(text);
  if (win && !win.isDestroyed()) win.webContents.send('desktop-status', text);
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.MAZZ_HOME = DATA_ROOT;
  env.AI_ENV_FILE = path.join(DATA_ROOT, '.env');
  for (const [key, value] of Object.entries(PORTABLE_ENV)) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  // Profil Modal transporté avec la copie portable (jeton du propriétaire, jamais dans la version publique).
  if (existsSync(MODAL_CONFIG)) env.MODAL_CONFIG_PATH = MODAL_CONFIG;
  // Configuration Kaggle transportée avec la copie portable (compte et jeton du propriétaire).
  const kaggleDir = path.join(DATA_ROOT, 'kaggle');
  if (existsSync(path.join(kaggleDir, 'kaggle.json'))) {
    env.KAGGLE_CONFIG_DIR = kaggleDir;
  } else if (existsSync(path.join(DATA_ROOT, 'kaggle.json'))) {
    env.KAGGLE_CONFIG_DIR = DATA_ROOT;
  }
  env.MAZZ_WORKSPACE_ROOT = WORKSPACE_DIR;
  env.MAZZ_RESOURCES_DIR = L.resources;
  env.MAZZ_WEB_ROOT = path.join(L.studio, 'apps', 'web', 'dist');
  env.MAZZ_MODEL_DIRS = MODELS_DIR;
  env.MAZZ_LEGACY_DIRS = MODELS_DIR;
  env.MAZZ_PORT = '7070';
  env.MAZZ_DESKTOP_TOKEN = desktopToken;
  if (L.llama) env.MAZZ_LLAMA_SERVER = L.llama;
  env.PATH = [path.dirname(L.node), path.dirname(L.python), path.dirname(L.llama || ''), env.PATH]
    .filter((p) => p && p !== '.')
    .join(path.delimiter);
  return env;
}

function pipe(child, name) {
  const write = (chunk) => {
    for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      remember(`${name}: ${line}`);
      logStream.write(`${name}: ${line}\n`);
    }
  };
  child.stdout?.on('data', write);
  child.stderr?.on('data', write);
  child.on('error', (err) => {
    remember(`${name}: erreur ${err.message}`);
    log(`${name}: erreur ${err.message}`);
  });
  return child;
}

function spawnChild(name, exe, args, cwd) {
  const out = createWriteStream(path.join(LOGS_DIR, `${name}.log`), { flags: 'a' });
  out.write(`\n===== ${new Date().toISOString()} ${exe} ${args.join(' ')}\n`);
  const child = spawn(exe, args, {
    cwd,
    env: childEnv({}),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => out.write(c));
  child.stderr.on('data', (c) => out.write(c));
  child.on('exit', (code, signal) => {
    out.write(`===== sortie code=${code} signal=${signal} ${new Date().toISOString()}\n`);
    out.end();
    if (!shuttingDown && !startupFailed) {
      const detail = `${name} s'est arrêté (code ${code ?? 'inconnu'}). Consultez ${path.join(LOGS_DIR, `${name}.log`)}.`;
      log(detail);
      if (win) fail(detail);
    }
  });
  return pipe(child, name);
}

function freePort(start = 3333) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, attempts) => {
      const srv = net.createServer();
      srv.once('error', () => {
        if (attempts <= 0) reject(new Error(`Aucun port libre à partir de ${start}.`));
        else tryPort(p + 1, attempts - 1);
      });
      srv.once('listening', () => {
        const address = srv.address();
        const port = typeof address === 'object' && address ? address.port : p;
        srv.close(() => resolve(port));
      });
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start, 50);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (shuttingDown) throw new Error('Arrêt demandé.');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(500);
  }
  throw new Error(`${label} ne répond pas après ${Math.round(timeoutMs / 1000)} s (${last}).`);
}

async function startBackend() {
  if (!existsSync(path.join(L.gateway, 'app.py')) && !existsSync(path.join(L.gateway, 'app.pyc'))) {
    throw new Error(`Passerelle introuvable : ${L.gateway}`);
  }
  if (!existsSync(path.join(L.studio, 'apps', 'cli', 'dist', 'index.js'))) {
    throw new Error(`Studio introuvable : ${L.studio}`);
  }

  setStatus('Démarrage de la passerelle locale…');
  const gatewayEntry = existsSync(path.join(L.gateway, 'app.py')) ? 'app.py' : 'app.pyc';
  gateway = spawnChild('gateway', L.python, [gatewayEntry], L.gateway);
  await waitHttp('http://127.0.0.1:7070/api/session/status', 90_000, 'La passerelle MAZZ Control');

  studioPort = await freePort(3333);
  setStatus('Démarrage du Studio…');
  studio = spawnChild(
    'studio',
    L.node,
    [path.join(L.studio, 'apps', 'cli', 'dist', 'index.js'), 'start', '--port', String(studioPort)],
    L.studio
  );
  await waitHttp(`http://127.0.0.1:${studioPort}/api/health`, 120_000, 'Le Studio MAZZ');

  setStatus(`Prêt : http://127.0.0.1:${studioPort}/`);
  return `http://127.0.0.1:${studioPort}/`;
}

function killTree(child, force = false) {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (err) {
    log(`taskkill ${pid} impossible : ${err.message}`);
  }
  if (!force) {
    try { child.kill(); } catch { /* déjà arrêté */ }
  }
}

async function waitExit(child, ms) {
  if (!child || child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(ms).then(() => false),
  ]);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Arrêt demandé : fermeture des processus enfants.');
  if (studio) {
    try {
      await fetch(`http://127.0.0.1:${studioPort}/api/desktop/shutdown`, {
        method: 'POST',
        headers: { 'x-mazz-desktop-token': desktopToken },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log(`Arrêt du Studio par HTTP impossible : ${err.message}`);
    }
    if (!(await waitExit(studio, 15_000))) {
      log('Studio toujours vivant : arrêt de son arbre de processus.');
      killTree(studio);
      await waitExit(studio, 5_000);
      killTree(studio, true);
    }
  }
  if (gateway) {
    try {
      await fetch('http://127.0.0.1:7070/api/desktop/shutdown', {
        method: 'POST',
        headers: { 'x-mazz-desktop-token': desktopToken },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log(`Arrêt de la passerelle par HTTP impossible : ${err.message}`);
    }
    if (!(await waitExit(gateway, 8_000))) {
      log('Passerelle toujours vivante : arrêt de son arbre de processus.');
      killTree(gateway, true);
      await waitExit(gateway, 3_000);
    }
  }
  log('Arrêt terminé.');
}

function fail(summary) {
  if (startupFailed || shuttingDown) return;
  startupFailed = true;
  setStatus('Démarrage impossible.');
  const detail = [summary, '', ...recent.slice(-25)].join('\n');
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(here, 'error.html'), {
      query: { summary, detail: detail.slice(0, 12_000), logs: LOGS_DIR },
    });
    win.show();
  }
  // Les enfants éventuels sont arrêtés après l'affichage : l'utilisateur voit d'abord la cause.
  setTimeout(() => void shutdown().finally(() => undefined), 1500);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#1c1a17',
    title: 'Mazz Code',
    icon: path.join(here, 'assets', 'app.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${studioPort}/`) && !url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  win.loadFile(path.join(here, 'loading.html'));
}

function menu() {
  return Menu.buildFromTemplate([
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Ouvrir le dossier des journaux',
          click: () => void shell.openPath(LOGS_DIR),
        },
        { type: 'separator' },
        { label: 'Quitter', role: 'quit' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Taille normale' },
        { role: 'zoomIn', label: 'Agrandir' },
        { role: 'zoomOut', label: 'Réduire' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: 'Licence et mentions légales',
          click: () => void shell.openPath(path.join(L.legal, 'EULA.md')),
        },
        {
          label: 'Signaler un problème',
          click: () => void shell.openExternal('https://github.com/'),
        },
      ],
    },
  ]);
}

ipcMain.handle('desktop-open-logs', () => shell.openPath(LOGS_DIR));
ipcMain.handle('desktop-quit', () => app.quit());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    log(`Mazz Code ${app.getVersion()} — Electron ${process.versions.electron} — ${os.platform()} ${os.arch()}`);
    log(`Données : ${DATA_ROOT}${PORTABLE ? ' (portable)' : ''}`);
    Menu.setApplicationMenu(menu());
    createWindow();
    try {
      const url = await startBackend();
      if (win && !win.isDestroyed()) {
        await win.loadURL(url);
        win.show();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Échec du démarrage : ${message}`);
      fail(message);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown().finally(() => {
      logStream.end();
      app.exit(0);
    });
  });
}
