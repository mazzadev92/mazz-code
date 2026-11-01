import * as path from 'node:path';

/**
 * Refusals that no permission mode, rule or approval can lift (spec 03b): shell deletions and process
 * kills (deletion goes through fs.delete, which always asks), and secret files (.env, keys).
 */

const DELETE_OR_KILL = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'taskkill', 'stop-process', 'format']);
const WRAPPERS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'sudo', 'call', 'start']);
const SECRET_EXAMPLES = /\.(example|sample|template|dist)$/i;

function verb(token: string): string {
  return path.basename(token.replace(/^["'&]+|["']+$/g, '')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** First word of each shell segment, looking through wrappers such as `cmd /c` or `powershell -c`. */
export function commandVerbs(command: string): string[] {
  const verbs: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (WRAPPERS.has(verb(tokens[i])) || /^[-/]/.test(tokens[i]))) i++;
    if (i < tokens.length) verbs.push(verb(tokens[i]));
  }
  return verbs;
}

export function isSecretFile(target: string): boolean {
  const name = path.basename(target.replace(/\\/g, '/')).toLowerCase();
  if (SECRET_EXAMPLES.test(name)) return false;
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.key') || name.endsWith('.pem');
}

/** Reason the call is refused outright, or undefined when the normal permission flow applies. */
export function defaultDenyReason(toolName: string, params: Record<string, unknown>): string | undefined {
  if (toolName.startsWith('terminal.') && typeof params.command === 'string') {
    const hit = commandVerbs(params.command).find((v) => DELETE_OR_KILL.has(v));
    if (hit) return `Commande refusée par défaut : "${hit}" supprime des fichiers ou tue des processus. Utilise fs.delete (qui demande confirmation) ou demande à l’utilisateur.`;
  }
  for (const key of ['path', 'sourceFiles', 'outputExe', 'cwd']) {
    const value = params[key];
    for (const p of Array.isArray(value) ? value : [value]) {
      if (typeof p === 'string' && isSecretFile(p)) return `Accès refusé par défaut : "${path.basename(p)}" contient des secrets (.env, clés).`;
    }
  }
  return undefined;
}
