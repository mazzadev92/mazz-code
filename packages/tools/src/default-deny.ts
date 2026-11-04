import * as path from 'node:path';
import { physicalPath } from './fs.js';

/**
 * Refusals that no permission mode, rule or approval can lift (spec 03b): shell deletions and process
 * kills (deletion goes through fs.delete, which always asks), and secret files (.env, keys).
 * This is a deny-list, so defence in depth only: terminal commands still go through user approval.
 */

const DELETE_OR_KILL = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred',
  'taskkill', 'stop-process', 'spps', 'kill', 'pkill', 'killall', 'format',
]);
/** Commands that run another command: every word after them is checked, not only the first. */
const WRAPPERS = new Set([
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'wsl', 'sudo', 'call', 'start', 'xargs', 'env',
  'nohup', 'timeout', 'iex', 'invoke-expression', 'eval', 'exec', 'node', 'python', 'python3', 'py',
]);
/** Parameter names that carry file-system paths: every access check (secrets, protected folders, path jail) reads this one list. */
export const PATH_PARAM_KEYS = ['path', 'sourceFiles', 'outputExe', 'cwd', 'input_xbg_path', 'output_glb_path'] as const;
const SECRET_EXAMPLES = /\.(example|sample|template|dist)$/i;

function verb(token: string): string {
  return path.basename(token.replace(/^["'&@]+|["',;]+$/g, '')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** Words that run as commands in each shell segment, including subshells and wrapped commands. */
export function commandVerbs(command: string): string[] {
  const verbs: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|&\n`(){}]|\$\(/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const first = verb(tokens[0]);
    verbs.push(first);
    // Behind a wrapper the command may follow flags taking values (-ExecutionPolicy Bypass): check every word.
    if (WRAPPERS.has(first)) verbs.push(...tokens.slice(1).map(verb));
  }
  return verbs;
}

/** Deletions spelled without a deleting verb: git, robocopy mirrors, .NET and script-language calls, encoded PowerShell. */
const DELETE_PATTERNS: Array<[RegExp, string]> = [
  [/\bgit\s+(?:-\S+\s+)*(?:clean|rm)\b/i, 'git clean/rm'],
  [/\bgit\s+(?:-\S+\s+)*reset\b[^\n]*--hard\b/i, 'git reset --hard'],
  [/\bgit\s+(?:-\S+\s+)*checkout\b[^\n]*\s--(?:\s|$)/i, 'git checkout --'],
  [/\bfind\b[^\n]*\s-delete\b/i, 'find -delete'],
  [/\brobocopy\b[^\n]*\/(?:mir|purge)\b/i, 'robocopy /MIR'],
  [/\]::Delete\s*\(|\bDeleteFile\b|\bRemoveDirectory\b/i, '.NET Delete'],
  [/\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|rmSync|rmdirSync|unlinkSync|fs\.rm)\b/i, 'suppression par script'],
  // -e, -en, -enc ... -EncodedCommand: an opaque base64 payload cannot be checked, so it is refused.
  [/\s-e(?:n(?:c(?:o(?:d(?:e(?:d(?:c\w*)?)?)?)?)?)?)?\s+[A-Za-z0-9+/=]{16,}/i, 'PowerShell -EncodedCommand'],
];

/** cmd.exe drops ^ escapes and empty quote pairs inside words (r^m, r""m): undo them before reading verbs. */
function unescapeShell(command: string): string {
  return command.replace(/\^(.)/g, '$1').replace(/(\w)(?:""|'')(\w)/g, '$1$2');
}

function forbiddenCommand(raw: string): string | undefined {
  const command = unescapeShell(raw);
  const hit = commandVerbs(command).find((v) => DELETE_OR_KILL.has(v));
  if (hit) return hit;
  return DELETE_PATTERNS.find(([re]) => re.test(command))?.[1];
}

export function isSecretFile(target: string): boolean {
  // Windows ignores trailing dots/spaces and opens the main stream for "name:stream".
  const name = path.basename(target.replace(/\\/g, '/')).toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');
  if (SECRET_EXAMPLES.test(name)) return false;
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.key') || name.endsWith('.pem');
}

function resolvesToSecret(target: string, workspaceRoot?: string): boolean {
  if (isSecretFile(target)) return true;
  try {
    return isSecretFile(physicalPath(path.resolve(workspaceRoot ?? '.', target)));
  } catch {
    return false;
  }
}

/** Reason the call is refused outright, or undefined when the normal permission flow applies. */
export function defaultDenyReason(toolName: string, params: Record<string, unknown>, workspaceRoot?: string): string | undefined {
  if (toolName.startsWith('terminal.') && typeof params.command === 'string') {
    const hit = forbiddenCommand(params.command);
    if (hit) return `Commande refusée par défaut : "${hit}" supprime des fichiers ou tue des processus. Utilise fs.delete (qui demande confirmation) ou demande à l’utilisateur.`;
    if (params.command.split(/[\s"'=<>|;&]+/).some((word) => word && isSecretFile(word))) {
      return 'Commande refusée par défaut : elle cite un fichier de secrets (.env, clés).';
    }
  }
  for (const key of PATH_PARAM_KEYS) {
    const value = params[key];
    for (const p of Array.isArray(value) ? value : [value]) {
      if (typeof p === 'string' && resolvesToSecret(p, workspaceRoot)) return `Accès refusé par défaut : "${path.basename(p)}" contient des secrets (.env, clés).`;
    }
  }
  return undefined;
}
