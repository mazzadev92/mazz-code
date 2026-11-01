/**
 * Evidence-gated verification of the actions a final answer claims to have
 * performed. Small local models often narrate a successful action without
 * emitting the matching tool call; the harness must not report success when no
 * tool result backs the claim.
 */

export type ClaimKind = 'read' | 'mutation' | 'execution' | 'test' | 'compile';

export interface UnverifiedClaim {
  kind: ClaimKind;
  excerpt: string;
}

export interface ClaimEvidence {
  /** Tools that completed successfully during this task. */
  successfulTools: ReadonlySet<string>;
  /** Files whose contents the harness already injected into the prompt. */
  preloadedReadEvidence?: boolean;
}

const EVIDENCE_BY_KIND: Record<ClaimKind, readonly string[]> = {
  read: [
    'fs.read', 'fs.list', 'fs.search_text', 'code.map', 'code.outline', 'code.search', 'code.index',
    'git.status', 'knowledge.search', 'knowledge.engines', 'knowledge.inventory', 'attachments.read',
    'web.fetch', 'web.search',
  ],
  mutation: ['fs.write', 'fs.patch', 'fs.delete', 'fs.move', 'fs.mkdir'],
  execution: ['terminal.run'],
  test: ['terminal.run'],
  compile: ['compiler.gcc', 'terminal.run'],
};

/**
 * The claimed action must target a concrete artifact. Without this guard,
 * conversational sentences such as "j'ai lu votre message" would be treated as
 * file reads.
 */
const FILE_OBJECT = /(?:fichiers?|code|projets?|scripts?|modules?|sources?|readme|documentations?|docs?|contenus?|workspace|d[ée]p[ôo]ts?|repos?|fonctions?|classes?|tests?|build|programmes?|commandes?|bugs?|[\w./\\-]+\.(?:py|pyw|js|jsx|ts|tsx|rs|go|java|c|h|cc|cpp|cxx|hpp|cs|rb|php|sh|ps1|bat|cmd|md|txt|json|ya?ml|toml|ini|xml|html|css|sql|log))/iu;

interface ClaimRule {
  kind: ClaimKind;
  pattern: RegExp;
}

// Order matters: a sentence such as "j'ai compilé et testé" must credit the
// compiler for the compile claim before the generic execution rule runs.
const CLAIM_RULES: readonly ClaimRule[] = [
  // JavaScript `\b` is ASCII-only even under the `u` flag, so it does not
  // follow an accented final letter ("corrigé"). Use an explicit Unicode
  // non-letter lookahead instead.
  {
    kind: 'compile',
    pattern: /\b(?:j['’]ai|j ai)\s+(?:bien\s+|d[ée]j[àa]\s+)?(?:compil[ée]e?|compile)(?![\p{L}\p{N}_])|\bI(?:'ve| have)\s+(?:already\s+)?(?:compiled|built)(?![\p{L}\p{N}_])/iu,
  },
  {
    kind: 'test',
    pattern: /\b(?:j['’]ai|j ai)\s+(?:bien\s+|d[ée]j[àa]\s+)?(?:test[ée]e?|teste)(?![\p{L}\p{N}_])|\b(?:j['’]ai|j ai)\s+(?:bien\s+|d[ée]j[àa]\s+)?v[ée]rifi[ée]e?\s+(?:que\s+)?(?:les\s+)?tests?(?![\p{L}\p{N}_])|\bI(?:'ve| have)\s+(?:already\s+)?(?:tested|verified)(?![\p{L}\p{N}_])/iu,
  },
  {
    kind: 'execution',
    pattern: /\b(?:j['’]ai|j ai)\s+(?:bien\s+|d[ée]j[àa]\s+)?(?:lanc[ée]e?|lance|ex[ée]cut[ée]e?|execute|d[ée]marr[ée]e?|demarre)(?![\p{L}\p{N}_])|\bI(?:'ve| have)\s+(?:already\s+)?(?:run|executed|launched|started)(?![\p{L}\p{N}_])/iu,
  },
  {
    kind: 'mutation',
    pattern: /\b(?:j['’]ai|j ai)\s+(?:bien\s+|d[ée]j[àa]\s+)?(?:cr[ée][ée]?e?|écrit(?:e)?|ecrit(?:e)?|modifi[ée]e?|corrig[ée]e?|patch[ée]e?|ajout[ée]e?|supprim[ée]e?|renomm[ée]e?|d[ée]plac[ée]e?|remplac[ée]e?|mis [àa] jour)(?![\p{L}\p{N}_])|\bI(?:'ve| have)\s+(?:already\s+)?(?:created|written|modified|patched|fixed|corrected|added|removed|deleted|renamed|moved|replaced|updated)(?![\p{L}\p{N}_])/iu,
  },
  {
    kind: 'read',
    pattern: /\b(?:j['’]ai|j ai)\s+(?:bien\s+|d[ée]j[àa]\s+)?(?:lu|relu|ouvert|consult[ée]e?|parcouru|examin[ée]e?|inspect[ée]e?)(?![\p{L}\p{N}_])|\bI(?:'ve| have)\s+(?:already\s+)?(?:read|opened|reviewed|examined|inspected|listed|searched)(?![\p{L}\p{N}_])/iu,
  },
];

function hasEvidence(kind: ClaimKind, evidence: ClaimEvidence): boolean {
  if (kind === 'read' && evidence.preloadedReadEvidence) return true;
  return EVIDENCE_BY_KIND[kind].some((tool) => evidence.successfulTools.has(tool));
}

/**
 * Returns the first unverified claim per action kind. Fenced code is ignored so
 * an example or a diff inside the answer is never read as a claim.
 */
export function detectUnverifiedClaims(text: string, evidence: ClaimEvidence): UnverifiedClaim[] {
  if (!text.trim()) return [];
  const prose = text.replace(/```[\s\S]*?```/gu, ' ');
  const claims: UnverifiedClaim[] = [];
  const seen = new Set<ClaimKind>();

  for (const rule of CLAIM_RULES) {
    if (seen.has(rule.kind)) continue;
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(prose)) !== null) {
      const tail = prose.slice(match.index + match[0].length, match.index + match[0].length + 160);
      // Do not split on the dot of a file name ("NOTES.md"): only a sentence
      // terminator followed by whitespace or the end of the text ends it.
      const sentence = tail.split(/[!?\n]|\.(?=\s|$)/u)[0] ?? '';
      if (!FILE_OBJECT.test(sentence)) continue;
      const before = prose.slice(Math.max(0, match.index - 24), match.index);
      if (/(?:\bpas\b|\bjamais\b|\bnot\b|\bnever\b|n['’])/iu.test(before)) continue;
      if (hasEvidence(rule.kind, evidence)) break;
      seen.add(rule.kind);
      claims.push({ kind: rule.kind, excerpt: `${match[0]}${sentence}`.trim().slice(0, 160) });
      break;
    }
  }
  return claims;
}

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  read: 'lecture de fichier',
  mutation: 'modification de fichier',
  execution: 'exécution de commande',
  test: 'exécution de tests',
  compile: 'compilation',
};
