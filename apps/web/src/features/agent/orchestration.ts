export interface OrchestrationStep {
  key: string;
  title: string;
  /** "Étape 3/12" -> 3, null for the preparation group. */
  index: number | null;
  startedAt: number;
  /** Time until the next step started (or the last message when the turn ended). */
  durationMs: number;
  tools: string[];
  lines: string[];
  active: boolean;
}

const STEP_RE = /^Étape\s+(\d+)\s*\/\s*(\d+)\s*:?\s*(.*)$/i;
const TOOL_RE = /outil\s+([\w.:-]+)/i;

/**
 * Groups the flat MCOS status log into one entry per model call ("Étape i/n"), with the tools it ran and the
 * lines that belong to it. Everything before the first step is the preparation group.
 * `live` marks the last group as still running; `now` bounds its duration.
 */
export function groupOrchestration(statuses: Array<{ message: string; t: number }>, live: boolean, now = Date.now()): OrchestrationStep[] {
  const steps: OrchestrationStep[] = [];
  let current: OrchestrationStep | null = null;
  for (const { message, t } of statuses) {
    const m = STEP_RE.exec(message.trim());
    if (m || !current) {
      current = { key: `s${steps.length}`, title: m ? `Étape ${m[1]}/${m[2]} · ${m[3].replace(/\.$/, '') || 'appel du modèle'}` : 'Préparation', index: m ? Number(m[1]) : null, startedAt: t, durationMs: 0, tools: [], lines: [], active: false };
      steps.push(current);
      if (m) continue;
    }
    current.lines.push(message);
    const tool = TOOL_RE.exec(message);
    if (tool && /^Exécution/i.test(message.trim())) current.tools.push(tool[1].replace(/\.$/, ''));
  }
  steps.forEach((s, i) => {
    const end = steps[i + 1]?.startedAt ?? (live ? now : Math.max(s.startedAt, statuses[statuses.length - 1]?.t ?? s.startedAt));
    s.durationMs = Math.max(0, end - s.startedAt);
    s.active = live && i === steps.length - 1;
  });
  return steps;
}
