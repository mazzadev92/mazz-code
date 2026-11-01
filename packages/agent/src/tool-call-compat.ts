import type { ToolDefinition } from '@mazz/shared';
import { validateToolArgs } from '@mazz/tools';

const MAX_TEXT_CALL_LENGTH = 8_192;
const SAFE_READ_TOOLS = new Set([
  'fs.list',
  'fs.read',
  'fs.search_text',
  'code.search',
  'code.outline',
  'code.map',
  'git.status',
  'knowledge.engines',
  'knowledge.inventory',
  'knowledge.search',
]);
const SAFE_AGENT_CONTROL_TOOLS = new Set(['plan.update']);
const APPROVAL_GATED_FILE_TOOLS = new Set(['fs.write', 'fs.patch']);
const APPROVAL_GATED_EXECUTION_TOOLS = new Set(['terminal.run', 'compiler.gcc']);
const READ_INTENT = /(?:^|[^\p{L}\p{N}_])(?:read|open|list|search|inspect|review|examine|analy[sz]e|find|locate|scan|check|verify|show|display|view|get|fetch|lire|lis|lisez|relire|relis|relisez|ouvrir|ouvre|liste|lister|listons|listez|listent|chercher|recherche|rechercher|inspecter|inspecte|examiner|examine|analyser|analyse|trouve|retrouve|consulte|consulter|vérifie|verifie|vérifier|verifier|voir|regarde|regarder|affiche|afficher)(?=$|[^\p{L}\p{N}_])/iu;
const WRITE_INTENT = /(?:^|[^\p{L}\p{N}_])(?:write|create|edit|modify|update|patch|save|add|implement|make|generate|develop|put|fix|repair|change|adjust|tweak|adapt|redo|remove|delete|insert|wrap|move|configure|setup|init|complete|clean|refactor|applique|appliquer|écris|écrire|ecris|ecrire|crée|créer|cree|creer|créé|édite|éditer|edite|editer|modifie|modifier|mets à jour|mettre à jour|mets|met|mettre|remplace|remplacer|ajoute|ajouter|enregistre|enregistrer|sauvegarde|sauvegarder|implémente|implémenter|implemente|implementer|fais|faire|génère|générer|genere|generer|développe|développer|developpe|developper|réalise|réaliser|realise|realiser|programme|programmer|corrige|corriger|fixe|fixer|répare|repare|réparer|reparer|change|changer|ajuste|ajuster|adapte|adapter|refais|refaire|supprime|supprimer|enlève|enlever|déplace|deplace|déplacer|deplacer|insère|insere|insérer|inserer|englobe|englober|branche|brancher|configure|configurer|initialise|initialiser|complète|compléter|complete|completer|améliore|améliorer|ameliore|ameliorer|nettoie|nettoyer)(?=$|[^\p{L}\p{N}_])/iu;
const CODE_VERB_INTENT = /(?:^|[.!?\n]\s*|please\s+|can you\s+|could you\s+|tu dois\s+|merci de\s+)code\s+(?:a\b|the\b|this\b|that\b|new\b|one\b|my\b|your\b|un\b|une\b|ce\b|cette\b|mon\b|ma\b)/iu;
const FILE_TARGET_INTENT = /(?:^|[^\p{L}\p{N}_])(?:file|fichier|dossier|folder|project|projet|workspace|worktree|script|code|source|repo|repository|module|function|fonction|class|classe|component|composant|app|application|bug|issue|feature|fonctionnalité|config|configuration|settings|paramètres|readme|test|tests|it|this|that)(?=$|[^\p{L}\p{N}_])/iu;
const FILE_PATH_INTENT = /(?:^|[\\/\s"'`])[^\\/\s"'`]+\.(?:txt|md|rst|json|ya?ml|toml|ini|csv|log|conf|config|xml|html|css|scss|sql|py|pyw|c|h|cc|cpp|cxx|hpp|js|jsx|ts|tsx|rs|go|java|cs|rb|php|sh|ps1|bat|cmd|pdf|docx|xlsx|png|jpe?g|gif|svg|zip)(?=$|[^\p{L}\p{N}_])/giu;
const EXECUTION_INTENT = /(?:^|[^\p{L}\p{N}_])(?:run|execute|launch|test|build|compile|start|stop|restart|exec|exécute|exécuter|lance|lancer|teste|tester|construis|construire|compile|compiler|démarre|demarre|démarrer|demarrer|redémarre|redemarre|redémarrer|redemarrer)(?=$|[^\p{L}\p{N}_])/iu;
const NEGATED_WRITE_INTENT = /(?:don't|do not|never|must not|without|avoid)[\s\S]{0,24}(?:write|create|edit|modify|update|patch|save|add|implement|code)|ne\s+(?:pas\s+)?(?:créer|crée|creer|cree|écrire|écris|ecrire|ecris|modifier|modifie|remplacer|remplace|ajouter|ajoute|enregistrer|enregistre|sauvegarder|sauvegarde|éditer|édite|implémenter|implémente|coder|code)(?:\s+pas)?|n['’](?:écrire|écris|ecrire|ecris|créer|crée|creer|cree|modifier|modifie|remplacer|remplace|ajouter|ajoute|enregistrer|enregistre|sauvegarder|sauvegarde|éditer|édite|implémenter|implémente|coder|code)/iu;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
  format: 'raw-json' | 'fenced-json';
}

export interface TextToolCallCandidate {
  name: string;
}

function sanitizeControlCharsInStrings(raw: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        result += c;
      } else if (c === '\\') {
        escaped = true;
        result += c;
      } else if (c === '"') {
        inString = false;
        result += c;
      } else if (c === '\n') {
        result += '\\n';
      } else if (c === '\r') {
        result += '\\r';
      } else if (c === '\t') {
        result += '\\t';
      } else {
        result += c;
      }
    } else {
      if (c === '"') inString = true;
      result += c;
    }
  }
  return result;
}

function extractLoosePayload(raw: string): { name: string; arguments: Record<string, unknown> } | undefined {
  const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return undefined;
  const name = nameMatch[1];

  const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);
  const contentKeyMatch = raw.match(/"(content|patch)"\s*:\s*"/);
  if (pathMatch && contentKeyMatch) {
    const path = pathMatch[1];
    const key = contentKeyMatch[1];
    const contentStart = contentKeyMatch.index! + contentKeyMatch[0].length;
    const lastQuoteIdx = raw.lastIndexOf('"');
    if (lastQuoteIdx > contentStart) {
      const rawContent = raw.slice(contentStart, lastQuoteIdx);
      const content = rawContent
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      return {
        name,
        arguments: {
          path,
          [key]: content,
        },
      };
    }
  }
  return undefined;
}

function readTextToolPayload(text: string): { name: string; arguments: Record<string, unknown>; format: TextToolCall['format'] } | undefined {
  const unwrapped = unwrapJson(text);
  if (!unwrapped) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped.json);
  } catch {
    try {
      parsed = JSON.parse(sanitizeControlCharsInStrings(unwrapped.json));
    } catch {
      const fallback = extractLoosePayload(unwrapped.json);
      if (fallback) {
        parsed = fallback;
      } else {
        return undefined;
      }
    }
  }
  if (hasDuplicateObjectKeys(unwrapped.json) || hasAnotherStructuredPayload(unwrapped.trailing)) return undefined;
  if (!isPlainRecord(parsed) || !('name' in parsed)) return undefined;
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name || name.length > 128) return undefined;
  // Local GGUFs alternate between `arguments`, `args`, and a JSON string that
  // contains the object. Accept those encodings only when they decode to a
  // plain object that still passes the tool schema below.
  const rawArguments = 'arguments' in parsed
    ? parsed.arguments
    : 'args' in parsed ? parsed.args : 'parameters' in parsed ? parsed.parameters : undefined;
  let argumentValue: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      argumentValue = JSON.parse(rawArguments);
    } catch {
      return undefined;
    }
  }
  if (!isPlainRecord(argumentValue)) return undefined;
  return { name, arguments: argumentValue, format: unwrapped.format };
}

/** Detect only the narrow JSON shape of a text-encoded tool request for recovery. */
export function inspectTextToolCallCandidate(text: string): TextToolCallCandidate | undefined {
  const candidate = readTextToolPayload(text);
  return candidate ? { name: candidate.name } : undefined;
}

/** True when the user clearly requested a file mutation, not merely discussed one. */
export function hasExplicitFileMutationIntent(goal: string): boolean {
  if (NEGATED_WRITE_INTENT.test(goal)) return false;
  const explicitlyNamedWriteTool = /\b(?:fs|code|git)(?:\.|__)(?:write|patch|delete)\b/iu.test(goal);
  if (explicitlyNamedWriteTool) return true;

  const inspectOnlyObject = /\b(?:review|inspect|read|find|locate|identify|search|explain|audit|check|compare|examine|analy[sz]e|look at|vérifie|verifie|analyse|inspecte|lis|relis|trouve|cherche|explique|consulte|où est|ou est)\s+(?:(?:the|a|an|le|la|les|un|une|du|des|ce|cette|ces)\s+)?(?:code|patch|script|file|fichier|folder|dossier|readme|bug|issue|feature|function|fonction|method|méthode|class|classe|symbol|symbole)\b/giu;
  const querySymbol = /\b(?:find|locate|identify|show|explain|read|review|inspect|analy[sz]e|trouve|cherche|lis|relis|explique|where(?: is)?|où est|ou est)\s+(?:(?:the|a|an|le|la|les|un|une|du|des|ce|cette|ces)\s+)?(?:function|fonction|method|méthode|class|classe|symbol|symbole)\s+[\p{L}_][\p{L}\p{N}_$]*/giu;
  const queryIdentifier = /\b(?:find|locate|identify|show|explain|read|review|inspect|trouve|cherche|lis|relis|where(?: is)?|où est|ou est)\s+(?:(?:the|a|an|le|la|les|un|une|du|des|ce|cette|ces)\s+)?[\p{L}_][\p{L}\p{N}_$]*\s+(?:function|fonction|method|méthode|class|classe|symbol|symbole)\b/giu;
  const targetGoal = goal
    .replace(/\b(?:fs|code|git)(?:\.|__)(?:list|read|search_text|write|patch|delete|search|map|outline|status)\b/giu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(FILE_PATH_INTENT, ' ')
    .replace(inspectOnlyObject, ' ')
    .replace(querySymbol, ' ')
    .replace(queryIdentifier, ' ');
  const intentGoal = targetGoal
    .replace(/\b(?:function|fonction|method|méthode|class|classe|variable|symbol|symbole|defined|defines|declared|declare|défini|définie|defini|definie|déclaré|déclarée)\s+(?:(?:named|called|nommé|nommée)\s+)?[`"']?[\p{L}_][\p{L}\p{N}_$]*[`"']?/giu, ' ');
  const hasArtifactTarget = new RegExp(FILE_PATH_INTENT.source, 'iu').test(goal) || FILE_TARGET_INTENT.test(targetGoal);
  return hasArtifactTarget && (WRITE_INTENT.test(intentGoal) || CODE_VERB_INTENT.test(intentGoal));
}

export type RequiredExecutionKind = 'compile' | 'test' | 'run';

/** Infer the distinct local verification results explicitly requested by the user. */
export function requiredExecutionKinds(goal: string): RequiredExecutionKind[] {
  const intentGoal = goal
    .replace(/\b(?:fs|code|git|terminal)(?:\.|__)(?:list|read|search_text|write|patch|delete|search|map|outline|status|run)\b/giu, ' ')
    .replace(/(?:^|[\\/\s"'`])[^\\/\s"'`]+\.(?:py|pyw|c|h|cc|cpp|cxx|hpp|js|jsx|ts|tsx|rs|go|java|cs|rb|php|sh|ps1|bat|cmd)(?=$|[\\/\s"'`])/giu, ' ');
  const normalized = intentGoal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const required: RequiredExecutionKind[] = [];
  if (/\b(?:compile|compiler|gcc|compilation|compiler|compil)\b/u.test(normalized)) required.push('compile');
  if (/\b(?:tests?|unittest|pytest|test(?:e|er|ez|ent)|unitaires?|essais?)\b/u.test(normalized)) required.push('test');
  if (/\b(?:run|execute|launch|start|lance|lancer|demarre|demarrer|execute|executer)\b/u.test(normalized)) required.push('run');
  if (!required.length && EXECUTION_INTENT.test(normalized)) required.push('run');
  return required;
}

/** True when the request explicitly requires a local build, test, or execution result. */
export function hasExplicitExecutionIntent(goal: string): boolean {
  return requiredExecutionKinds(goal).length > 0;
}

/** Whether a write request also explicitly asks the agent to obtain a separate decision. */
export function hasExplicitUserDecisionRequest(goal: string): boolean {
  return /(?:ask me|ask the user|let me choose|which (?:format|option|one)|what (?:format|option)|ask before choosing|demande-moi|demande à l'utilisateur|quelle option|quel format|lequel choisir|fais-moi choisir)/iu.test(goal);
}

const CLOSING_CALL_TAG = /^\s*<\/(?:tool_call|tools?|function_call)>\s*/iu;

function unwrapJson(text: string): { json: string; trailing: string; format: TextToolCall['format'] } | undefined {
  let trimmed = text.trim();
  // A short sentence, then the call on its own line ("Le bug est dans chunk ; je le corrige.\n<tool_call>\n{...}"):
  // fine-tuned and Hermes-style models do this, sometimes with a mangled or missing <tool_call> tag
  // (the Qwen2.5-Coder 14B GGUF writes <tools>...</tools>, others <function_call>).
  // The payload must still open its own line: inline JSON inside a sentence
  // ("Tool call: {...}") stays prose so an example cannot be dispatched.
  if (!trimmed.startsWith('{') && !/^```json/iu.test(trimmed)) {
    const start = /(?:^|\n)[ \t]*(?:<(?:tool_call|tools?|function_call)>[ \t]*\n?[ \t]*)?(```json\s*|\{\s*"name"\s*:\s*")/iu.exec(trimmed);
    if (!start) return undefined;
    const payloadIndex = start.index + start[0].length - start[1].length;
    if (payloadIndex > 600) return undefined;
    trimmed = trimmed.slice(payloadIndex).replace(/^\s*<(?:tool_call|tools?|function_call)>\s*/iu, '');
  }
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_CALL_LENGTH) return undefined;
  // Some local GGUFs emit an inline fence (```json { ... } ```) instead of
  // placing the JSON on the next line. Accept both while still requiring the
  // opening fence at the start and a closing fence before parsing.
  const fenced = trimmed.match(/^```json\s*([\s\S]*?)\s*```/iu);
  if (fenced) {
    const trailing = trimmed.slice(fenced[0].length).replace(CLOSING_CALL_TAG, '');
    return { json: fenced[1].trim(), trailing, format: 'fenced-json' };
  }
  if (trimmed.startsWith('{')) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index++) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          const trailing = trimmed.slice(index + 1).replace(CLOSING_CALL_TAG, '');
          return { json: trimmed.slice(0, index + 1), trailing, format: 'raw-json' };
        }
        if (depth < 0) return undefined;
      }
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsDangerousKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDangerousKey);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => DANGEROUS_KEYS.has(key) || containsDangerousKey(child));
}

/**
 * JSON.parse silently keeps the last occurrence of a duplicate key. Reject
 * duplicate keys at every nesting level so a model cannot present one value
 * for review and have a later value silently win during dispatch.
 */
function hasDuplicateObjectKeys(json: string): boolean {
  const objectKeys: Array<Set<string>> = [];
  for (let index = 0; index < json.length;) {
    const char = json[index];
    if (char === '"') {
      const start = index;
      index++;
      while (index < json.length) {
        if (json[index] === '\\') { index += 2; continue; }
        if (json[index] === '"') { index++; break; }
        index++;
      }
      let next = index;
      while (/\s/u.test(json[next] ?? '')) next++;
      if (json[next] === ':' && objectKeys.length > 0) {
        let key: string;
        try { key = JSON.parse(json.slice(start, index)) as string; } catch { return true; }
        const keys = objectKeys[objectKeys.length - 1];
        if (keys.has(key)) return true;
        keys.add(key);
      }
      continue;
    }
    if (char === '{') objectKeys.push(new Set<string>());
    else if (char === '}') objectKeys.pop();
    index++;
  }
  return false;
}

/**
 * Appended prose is tolerated, but a second tool-call-shaped payload is
 * ambiguous. Braces in ordinary prose (for example "{path}") are not a second
 * call and must not discard an otherwise valid request.
 */
function hasAnotherStructuredPayload(trailing: string): boolean {
  if (/```\s*json\b/iu.test(trailing)) return true;
  // Reject a second call and a truncated one whose name was already lost
  // ("{"arguments": ..."): either would make the dispatch ambiguous.
  return /\{\s*"(?:name|arguments|args|parameters)"\s*:/u.test(trailing);
}

/** Resolve an offered name, its dotted form, or the provider's `__` wire form. */
function resolveOfferedTextTool(name: string, offeredTools: readonly ToolDefinition[]): ToolDefinition | undefined {
  const cleaned = name.trim().replace(/^[`"'“”]+|[`"'“”]+$/gu, '').replace(/\(\)$/u, '');
  const exact = offeredTools.filter((tool) => tool.name === cleaned);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;

  const dotted = cleaned.replace(/__/gu, '.');
  const encoded = offeredTools.filter((tool) => tool.name === dotted || tool.name.replace(/\./gu, '__') === cleaned);
  if (encoded.length === 1) return encoded[0];

  if (!cleaned.includes('_')) {
    const stripped = cleaned.toLowerCase().replace(/\./gu, '');
    const matchStripped = offeredTools.filter((tool) => tool.name.toLowerCase().replace(/\./gu, '') === stripped);
    if (matchStripped.length === 1) return matchStripped[0];
  }

  // Wrong namespace, right action ("tools__patch" for fs.patch): accepted only when exactly one offered tool
  // ends with that action.
  const action = /^[a-z]+(?:__|\.)([a-z_]+)$/u.exec(cleaned)?.[1];
  if (action) {
    const byAction = offeredTools.filter((tool) => tool.name.split('.').pop() === action);
    if (byAction.length === 1) return byAction[0];
  }

  return undefined;
}

/**
 * Parses the narrow JSON-in-text dialect emitted by some local GGUFs when they
 * fail to produce a native tool call. Calls must name an offered tool. Reads
 * need clear read intent; file writes and patches additionally require clear,
 * non-negated mutation intent and still pass through the normal approval gate.
 * plan.update is a validated control-plane call with no filesystem side effect.
 */
export function parseTextToolCall(
  text: string,
  goal: string,
  offeredTools: ToolDefinition[],
): TextToolCall | undefined {
  const parsed = readTextToolPayload(text);
  if (!parsed || containsDangerousKey(parsed.arguments)) return undefined;

  // Mentioning a tool identifier while discussing its implementation is not
  // itself an instruction to call that tool.
  const intentGoal = goal.replace(/\b(?:fs|code|git|terminal|compiler)(?:\.|__)(?:list|read|search_text|write|patch|delete|search|map|outline|status|run|gcc)\b/giu, ' ');

  // Providers encode dotted tool names as double underscores for transport
  // (for example `fs.read` becomes `fs__read`). Small local models sometimes
  // copy that transport name into text instead of emitting a native call.
  const definition = resolveOfferedTextTool(parsed.name, offeredTools);
  if (!definition || definition.isDestructive) return undefined;
  if (validateToolArgs(definition.parameters, parsed.arguments).length > 0) return undefined;
  const explicitlyReadOnly = SAFE_READ_TOOLS.has(definition.name)
    && !definition.requiresPermission
    && (READ_INTENT.test(intentGoal) || (WRITE_INTENT.test(intentGoal) && !NEGATED_WRITE_INTENT.test(intentGoal)) || EXECUTION_INTENT.test(intentGoal));
  const safeAgentControl = SAFE_AGENT_CONTROL_TOOLS.has(definition.name)
    && !definition.requiresPermission;
  const approvalGatedFileMutation = APPROVAL_GATED_FILE_TOOLS.has(definition.name)
    && definition.requiresPermission === true
    && WRITE_INTENT.test(intentGoal)
    && !NEGATED_WRITE_INTENT.test(intentGoal);
  const approvalGatedExecution = APPROVAL_GATED_EXECUTION_TOOLS.has(definition.name)
    && definition.requiresPermission === true
    && EXECUTION_INTENT.test(intentGoal);
  if (!explicitlyReadOnly && !approvalGatedFileMutation && !approvalGatedExecution && !safeAgentControl) return undefined;
  return { name: definition.name, arguments: parsed.arguments, format: parsed.format };
}

/** Keep possible JSON tool requests off the transcript until they are checked. */
export function isPossibleTextToolCallPrefix(text: string): boolean {
  const prefix = text.trimStart().toLocaleLowerCase();
  if (prefix.length === 0) return true;
  if (prefix.startsWith('{')) return true;
  const fence = '```json';
  return (prefix.length <= fence.length && fence.startsWith(prefix)) || prefix.startsWith(fence);
}
