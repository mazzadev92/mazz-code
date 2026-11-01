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
  return allow ? 'allow' : undefined;
}

/** Rule saved by an "Always" answer: the command's first word for terminals, else the tool. */
export function ruleForAlways(toolName: string, params: Record<string, unknown>): PermissionRule {
  const command = typeof params.command === 'string' ? params.command.trim() : '';
  if (command) {
    const head = command.split(/\s+/)[0];
    return { tool: toolName, pattern: `${head} *`, decision: 'allow' };
  }
  return { tool: toolName, pattern: '*', decision: 'allow' };
}
