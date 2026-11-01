// Edit-time syntax gate (as in SWE-agent's linter on edit): a write that breaks the syntax of a source file
// that was valid is refused, and the exact error goes back to the model. A file that was already broken can
// still be rewritten, so that the agent can fix it. A missing checker (no Python, no gcc) never blocks.
import { spawn } from 'node:child_process';
import path from 'node:path';

type Checker = (content: string, absPath: string) => Promise<string | undefined>;

function run(cmd: string, args: string[], input: string, cwd: string): Promise<{ code: number | null; out: string } | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve(undefined); } }, 10_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(undefined); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out }); } });
    child.stdin.end(input);
  });
}

const python: Checker = async (content, absPath) => {
  const r = await run('python', ['-I', '-c', 'import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(f"ligne {e.lineno}: {e.msg}: {(e.text or \'\').strip()}"); sys.exit(1)'], content, path.dirname(absPath));
  return r && r.code !== 0 ? r.out.trim().split('\n').pop() || 'syntaxe Python invalide' : undefined;
};

const c: Checker = async (content, absPath) => {
  const dir = path.dirname(absPath);
  const r = await run('gcc', ['-fsyntax-only', '-w', '-x', 'c', '-I', dir, '-'], content, dir);
  return r && r.code !== 0 ? r.out.split('\n').find((l) => /error:/.test(l))?.replace(/^<stdin>:/, 'ligne ').trim() || 'syntaxe C invalide' : undefined;
};

const json: Checker = async (content) => {
  try { JSON.parse(content); return undefined; } catch (err) { return `JSON invalide : ${(err as Error).message}`; }
};

const CHECKERS: Record<string, Checker> = { '.py': python, '.c': c, '.json': json };

/** Error text when `newContent` would break a file whose previous content (null: new file) was valid. */
export async function syntaxGate(absPath: string, newContent: string, oldContent: string | null): Promise<string | undefined> {
  const check = CHECKERS[path.extname(absPath).toLowerCase()];
  if (!check) return undefined;
  const error = await check(newContent, absPath);
  if (!error) return undefined;
  // An already broken file stays editable: the agent may be in the middle of repairing it.
  if (oldContent !== null && (await check(oldContent, absPath))) return undefined;
  return `Écriture refusée : le nouveau contenu de ${path.basename(absPath)} n’est pas valide (${error}). Le fichier est inchangé ; corrige cette erreur et réécris.`;
}
