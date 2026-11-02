// MAZZ Agent Studio Desktop Application Shell
import { spawn, exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const appUrl = 'http://127.0.0.1:3333/';
const userDataDir = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.mazz', 'studio-chrome-profile');

console.log('Lancement de MAZZ Agent Studio Desktop...');
if (existsSync(chromePath)) {
  const child = spawn(chromePath, [
    `--app=${appUrl}`,
    '--window-size=1480,920',
    `--user-data-dir=${userDataDir}`,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log('Fenetre bureau MAZZ Agent Studio ouverte.');
} else {
  console.log(`Chrome introuvable a ${chromePath}, ouverture dans le navigateur.`);
  exec(`start ${appUrl}`);
}
