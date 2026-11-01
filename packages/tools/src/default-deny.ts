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

function forbiddenCommand(command: string): string | undefined {
  const hit = commandVerbs(command).find((v) => DELETE_OR_KILL.has(v));
  if (hit) return hit;
  if (/\bgit\s+clean\b/i.test(command)) return 'git clean';
  if (/\bfind\b[^\n]*\s-delete\b/i.test(command)) return 'find -delete';
  return undefined;
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
  for (const key of ['path', 'sourceFiles', 'outputExe', 'cwd']) {
    const value = params[key];
    for (const p of Array.isArray(value) ? value : [value]) {
      if (typeof p === 'string' && resolvesToSecret(p, workspaceRoot)) return `Accès refusé par défaut : "${path.basename(p)}" contient des secrets (.env, clés).`;
    }
  }
  return undefined;
}
