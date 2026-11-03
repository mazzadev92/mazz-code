/**
 * Permission rules by pattern, like Claude Code's allow/deny lists:
 * { tool: 'terminal.run', pattern: 'git *', decision: 'allow' }.
 * `tool` accepts a trailing wildcard ('mcp.github.*', '*'); `pattern` is a
 * case-insensitive glob (* any characters) matched against the call's subject:
 * the command for terminal tools, the path for files, the URL for web.fetch,
 * the query for web.search. A matching deny always wins over an allow.
 */

export interface PermissionRule {
  tool: string;
  pattern: string;
  decision: 'allow' | 'deny';
}

function globToRegex(glob: string): RegExp {
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** What a rule pattern is matched against for a given call. */
export function ruleSubject(params: Record<string, unknown>): string {
  for (const k of ['command', 'path', 'url', 'query', 'outputExe']) {
    const v = params[k];
    if (typeof v === 'string' && v) return v.replace(/\\/g, '/');
  }
  return '';
}

export function matchRules(rules: unknown, toolName: string, params: Record<string, unknown>): 'allow' | 'deny' | undefined {
  if (!Array.isArray(rules)) return undefined;
  const subject = ruleSubject(params);
  let allow = false;
  for (const r of rules as PermissionRule[]) {
    if (!r || typeof r.tool !== 'string' || (r.decision !== 'allow' && r.decision !== 'deny')) continue;
    if (!globToRegex(r.tool).test(toolName)) continue;
    if (!globToRegex(r.pattern || '*').test(subject)) continue;
    if (r.decision === 'deny') return 'deny';
    allow = true;
  }
  // A glob like "git *" would also match "git status; iex ...": only a command made of plain arguments is auto-allowed.
  if (allow && typeof params.command === 'string' && !isPlainSafeCommand(params.command)) return undefined;
  return allow ? 'allow' : undefined;
}

/** Options that make a command run another program, load config or write elsewhere, whatever the subcommand. */
const RISKY_OPTION = /^(-c.*|--config-env.*|--output.*|--exec.*|--extcmd.*|--upload-pack.*|--receive-pack.*|--git-dir.*|--work-tree.*|--namespace.*|--open-files-in-pager.*|--ext-diff|--textconv|--pager.*|--editor.*)$/i;
/** git subcommands that run configured programs or rewrite history: never auto-allowed. */
const RISKY_GIT_SUBCOMMAND = new Set(['config', 'difftool', 'mergetool', 'submodule', 'daemon', 'instaweb', 'bisect', 'rebase', 'filter-branch', 'gc', 'maintenance', 'hook', 'credential', 'send-email', 'archive', 'bundle', 'fetch', 'pull', 'push', 'clone', 'remote', 'ls-remote']);

function isPlainSafeCommand(command: string): boolean {
  if (!PLAIN_COMMAND.test(command)) return false;
  const words = command.trim().split(/\s+/);
  if (words.slice(1).some((w) => RISKY_OPTION.test(w))) return false;
  if (/^git(\.exe)?$/i.test(words[0])) {
    // An option before the subcommand (-C, -c, --exec-path...) changes what the subcommand reads or runs.
    if (!words[1] || words[1].startsWith('-') || RISKY_GIT_SUBCOMMAND.has(words[1].toLowerCase())) return false;
  }
  return true;
}

/**
 * Allow-list, not deny-list: words, paths, flags and key=value only. Quotes, parentheses, $, ;, &, |, <, >, ^, %,
 * backticks and line breaks (whatever the shell grammar) are excluded, and so is a word starting with @ (PowerShell splat).
 */
const PLAIN_COMMAND = /^(?!(?:.*\s)?@)[\w .\/\\:=,+@-]+$/;

/** Rule saved by an "Always" answer: the command's first word for terminals, else the tool. */
export function ruleForAlways(toolName: string, params: Record<string, unknown>): PermissionRule {
  const command = typeof params.command === 'string' ? params.command.trim() : '';
  if (command) {
    const head = command.split(/\s+/)[0];
    return { tool: toolName, pattern: `${head} *`, decision: 'allow' };
  }
  return { tool: toolName, pattern: '*', decision: 'allow' };
}
