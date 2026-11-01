import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Specialist } from '@mazz/agent';
import { parseFrontMatter } from './skills.js';

/**
 * User extensions in the Claude Code formats:
 * - slash commands: `<name>.md` in .mazz/commands, .claude/commands (project)
 *   or the Studio `commands` folder; the body is the prompt, $ARGUMENTS is
 *   replaced by what follows "/name".
 * - sub-agents: `<name>.md` in .mazz/agents, .claude/agents or the Studio
 *   `agents` folder; front matter name / description / tools, body = instructions.
 */

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  source: 'studio' | 'project' | 'claude-project';
  file: string;
}

export interface CustomAgent extends Specialist {
  name: string;
  description: string;
  source: 'studio' | 'project' | 'claude-project';
  file: string;
}

/** Claude Code tool names used in .claude/agents, mapped to Studio tools. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ['fs.read'],
  write: ['fs.write'],
  edit: ['fs.patch'],
  multiedit: ['fs.patch'],
  glob: ['fs.list', 'code.map'],
  grep: ['code.search'],
  ls: ['fs.list'],
  bash: ['terminal.run'],
  powershell: ['terminal.run'],
  websearch: ['web.search'],
  webfetch: ['web.fetch'],
};

function mapTools(raw: string | undefined): string[] {
  const all = ['fs.list', 'fs.read', 'code.search', 'code.outline', 'code.map'];
  if (!raw?.trim()) return all;
  const out = new Set<string>();
  for (const t of raw.split(/[,\s]+/).filter(Boolean)) {
    const key = t.toLowerCase();
    if (CLAUDE_TOOLS[key]) CLAUDE_TOOLS[key].forEach((x) => out.add(x));
    else out.add(t);
  }
  return [...out];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;

async function scan<T>(dirs: Array<{ dir: string; source: T }>): Promise<Array<{ name: string; text: string; source: T; file: string }>> {
  const out: Array<{ name: string; text: string; source: T; file: string }> = [];
  const seen = new Set<string>();
  for (const { dir, source } of dirs) {
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3);
      if (!NAME_RE.test(name) || seen.has(name)) continue;
      const file = path.join(dir, f);
      const text = await fs.readFile(file, 'utf-8').catch(() => '');
      if (!text.trim()) continue;
      seen.add(name);
      out.push({ name, text, source, file });
    }
  }
  return out;
}

export class ExtensionStore {
  constructor(private readonly dataDir: string) {}

  private dirs(kind: 'commands' | 'agents', projectRoot: string) {
    return [
      { dir: path.join(projectRoot, '.mazz', kind), source: 'project' as const },
      { dir: path.join(projectRoot, '.claude', kind), source: 'claude-project' as const },
      { dir: path.join(this.dataDir, kind), source: 'studio' as const },
    ];
  }

  async commands(projectRoot: string): Promise<SlashCommand[]> {
    return (await scan(this.dirs('commands', projectRoot))).map(({ name, text, source, file }) => {
      const { meta, body } = parseFrontMatter(text);
      return { name, description: meta.description || body.trim().split('\n')[0].slice(0, 160), argumentHint: meta['argument-hint'], source, file };
    });
  }

  /** "/name args" to the command prompt, or undefined when no command has this name. */
  async expand(projectRoot: string, goal: string): Promise<{ name: string; prompt: string } | undefined> {
    const m = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(goal.trim());
    if (!m) return undefined;
    const cmd = (await this.commands(projectRoot)).find((c) => c.name === m[1]);
    if (!cmd) return undefined;
    const body = parseFrontMatter(await fs.readFile(cmd.file, 'utf-8')).body.trim();
    const args = (m[2] ?? '').trim();
    return { name: cmd.name, prompt: body.includes('$ARGUMENTS') ? body.replace(/\$ARGUMENTS/g, args) : args ? `${body}\n\n${args}` : body };
  }

  async agents(projectRoot: string): Promise<CustomAgent[]> {
    return (await scan(this.dirs('agents', projectRoot))).map(({ name, text, source, file }) => {
      const { meta, body } = parseFrontMatter(text);
      const steps = Number(meta.maxIterations ?? meta['max-iterations']);
      return {
        name: (meta.name && NAME_RE.test(meta.name) ? meta.name : name).toLowerCase(),
        label: meta.name || name,
        description: (meta.description ?? '').slice(0, 200),
        tools: mapTools(meta.tools),
        instructions: body.trim().slice(0, 6000),
        maxIterations: Number.isFinite(steps) && steps > 0 ? Math.min(20, steps) : 8,
        source,
        file,
      };
    });
  }
}
