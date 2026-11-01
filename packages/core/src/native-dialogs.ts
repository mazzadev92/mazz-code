import { execFile } from 'node:child_process';

/**
 * Native Windows pickers (WinForms through PowerShell -STA). They open on the
 * machine running the Studio server, which is the user's own desktop since the
 * server only listens on 127.0.0.1. Returns null when cancelled.
 */

const OWNER = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Show(); $owner.Hide()
`;

function runDialog(script: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Dialogue natif disponible uniquement sous Windows.'));
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${OWNER}; ${script}`],
      { windowsHide: false, timeout: 10 * 60 * 1000 },
      (err, stdout) => {
        if (err) return reject(new Error('Le dialogue natif n’a pas pu s’ouvrir.'));
        const out = stdout.trim();
        resolve(out ? out : null);
      }
    );
  });
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function pickFolder(initial?: string): Promise<string | null> {
  return runDialog(`
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choisir un dossier'
$d.ShowNewFolderButton = $true
${initial ? `$d.SelectedPath = ${psQuote(initial)}` : ''}
if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }`);
}

export function pickFile(filter: 'gguf' | 'exe' | 'any', initial?: string): Promise<string | null> {
  const f = filter === 'gguf' ? 'Modèles GGUF (*.gguf)|*.gguf' : filter === 'exe' ? 'Exécutables (*.exe)|*.exe' : 'Tous les fichiers (*.*)|*.*';
  return runDialog(`
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = ${psQuote(f)}
$d.CheckFileExists = $true
${initial ? `$d.InitialDirectory = ${psQuote(initial)}` : ''}
if ($d.ShowDialog($owner) -eq 'OK') { $d.FileName }`);
}
