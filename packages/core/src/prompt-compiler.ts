import { createHash } from 'node:crypto';

export type RequirementQualification = 'firm' | 'ambition' | 'optional' | 'unclear';

export interface PromptSourceSpan {
  /** Zero-based UTF-16 code-unit offset, inclusive. */
  startOffset: number;
  /** Zero-based UTF-16 code-unit offset, exclusive. */
  endOffset: number;
  /** One-based physical line number. */
  startLine: number;
  /** One-based physical line number, inclusive. */
  endLine: number;
}

export interface PromptSection extends PromptSourceSpan {
  id: string;
  level: number;
  title: string;
  /** Exact heading source, including the Markdown marker but excluding its line ending. */
  headingText: string;
  parentSectionId?: string;
}

export interface ExplicitPromptReference extends PromptSourceSpan {
  /** Exact source text for the reference, e.g. `REQ-0007` or `section 2.1`. */
  text: string;
  target: string;
  kind: 'requirement_id' | 'section';
  relation: 'dependency' | 'citation';
  basis: string;
}

export interface PromptRequirementCandidate extends PromptSourceSpan {
  id: string;
  /** Exact source substring. No summary or normalization is substituted here. */
  text: string;
  sectionIds: string[];
  sectionPath: string[];
  qualification: {
    category: RequirementQualification;
    reasons: string[];
    signals: string[];
    method: 'deterministic_lexical';
  };
  /** Only populated when an explicit dependency phrase points at an explicit reference. */
  dependencies: ExplicitPromptReference[];
  /** Explicit references that are not asserted to be dependencies. */
  references: ExplicitPromptReference[];
}

export interface CompiledPrompt {
  schemaVersion: '1.0.0';
  id: string;
  sha256: string;
  hashEncoding: 'UTF-8';
  /** The original text, kept byte-for-byte at the JavaScript string/code-unit level. */
  sourceText: string;
  source: {
    utf16Length: number;
    lineCount: number;
    lineEndingCounts: { lf: number; crlf: number; cr: number };
  };
  sections: PromptSection[];
  candidates: PromptRequirementCandidate[];
  analysis: {
    method: 'deterministic_lexical';
    llmUsed: false;
    sourceRetainedCompletely: true;
    semanticUnderstandingClaimed: false;
    extractionCompleteness: 'not_semantically_exhaustive';
    blocksExamined: number;
    candidateCount: number;
    nonCandidateBlockCount: number;
    qualificationCounts: Record<RequirementQualification, number>;
    dependencyPolicy: 'explicit_reference_only';
  };
}

export interface CompilePromptOptions {
  /** Optional stable caller label. The content hash remains part of every generated ID. */
  sourceId?: string;
}

interface PhysicalLine {
  number: number;
  startOffset: number;
  contentEndOffset: number;
  endOffset: number;
  text: string;
}

interface HeadingLine {
  lineIndex: number;
  line: PhysicalLine;
  level: number;
  title: string;
}

interface TextBlock {
  startOffset: number;
  endOffset: number;
  kind: 'paragraph' | 'list_item' | 'table_row';
  lineStart: number;
  lineEnd: number;
}

interface SignalMatch {
  category: RequirementQualification;
  expression: RegExp;
  reason: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const LIST_MARKER = /^(\s*)(?:[-+*]|\d{1,9}[.)])[ \t]+/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_DIVIDER = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u;

const QUALIFICATION_SIGNALS: SignalMatch[] = [
  {
    category: 'optional',
    expression: /\b(?:optional|optionally|optionnel(?:le|s|les)?|facultatif(?:ve|s|ves)?|facultativement|à titre facultatif|at the user's option|opt[- ]in)\b/giu,
    reason: 'explicit optional/facultative wording',
  },
  {
    category: 'firm',
    expression: /\b(?:must(?: not)?|shall(?: not)?|required|required to|mandatory|obligatoire|doit(?:\s+être|\s+faire|\s+avoir|\s+rester|\s+conserver|\s+fonctionner|\s+permettre|\s+prendre)?|doivent|il faut|il ne faut pas|ne jamais|ne doit pas|ne doivent pas|interdit|interdire|impératif|exigé|exige|never|do not|mustn't|shalln't|toujours|chaque|toute|tous les|toutes les|je veux pouvoir|je veux que|l'utilisateur veut|the user requires)\b/giu,
    reason: 'explicit mandatory or user-wants wording',
  },
  {
    category: 'ambition',
    expression: /\b(?:should(?: not)?|could|would|might|may|aim(?: to)?|goal|target|ambition|aspiration|objective|objectif|ambition|viser|visons|pourrait|pourraient|devrait|devraient|j'aimerais|je souhaiterais|je construirais|je proposerais|je recommanderais|il serait souhaitable|idéalement|we aim|I would|would like to)\b/giu,
    reason: 'aspirational or recommendation wording',
  },
];

const REQUIREMENT_CUE = /\b(?:requirement|requirements|exigence|exigences|must|shall|required|mandatory|obligatoire|doit|doivent|il faut|ne doit|ne jamais|interdit|optional|optionnel|facultatif|should|could|would|aim|goal|objectif|ambition|viser|pourrait|devrait|j'aimerais|je veux pouvoir|je veux que|depends? on|dependent on|prerequisite|blocked by|dépend de|dépendance|prérequis|conditionné par|see requirement|voir exigence|voir la section|see section)\b/iu;

const ACTION_START = /^(?:\s*(?:[-+*]|\d{1,9}[.)])\s+)?(?:please\s+)?(?:create|build|implement|preserve|keep|store|record|retain|add|include|support|ensure|avoid|never|do not|test|measure|compare|read|write|verify|validate|detect|report|reject|refuse|use|provide|expose|maintain|require|conserver|préserver|enregistrer|stocker|ajouter|inclure|supporter|prendre en charge|assurer|éviter|ne jamais|ne pas|tester|mesurer|comparer|lire|écrire|vérifier|valider|détecter|signaler|refuser|utiliser|fournir|exposer|maintenir|créer|construire|implémenter|garantir|interdire|identifier|relier|traiter|accepter|permettre|afficher|séparer|associer|garder|supprimer|annuler|rechercher|indexer|découper|exécuter|auditer|analyser|extraire|classer|unifier|récupérer|comprendre|je veux pouvoir|je veux que)\b/iu;

const DEPENDENCY_PREFIX = /(?:\bdepends?\s+on\b|\bdependent\s+on\b|\bprerequisite(?:\s+is)?\b|\bblocked\s+by\b|\brequires?\b|\bdépend(?:ent)?\s+de\b|\bprérequis(?:\s+est)?\b|\bconditionné(?:e)?\s+par\b|\bnécessite\b)\s*$/iu;
const REQUIREMENT_REFERENCE = /\b(?:REQ|REQUIREMENT|EXIG(?:ENCE|)-?)[-_ ]?\d{1,8}\b/giu;
const SECTION_REFERENCE = /(?:\b(?:section|§|paragraph|paragraphe|step|étape)\s+\d+(?:\.\d+)*(?:[a-z])?\b)/giu;

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function physicalLines(source: string): { lines: PhysicalLine[]; lineEndingCounts: { lf: number; crlf: number; cr: number } } {
  const lines: PhysicalLine[] = [];
  const endings = { lf: 0, crlf: 0, cr: 0 };
  let lineStart = 0;
  let offset = 0;
  let number = 1;
  while (offset < source.length) {
    const code = source.charCodeAt(offset);
    if (code !== 10 && code !== 13) {
      offset += 1;
      continue;
    }
    const contentEndOffset = offset;
    if (code === 13 && source.charCodeAt(offset + 1) === 10) {
      offset += 2;
      endings.crlf += 1;
    } else if (code === 13) {
      offset += 1;
      endings.cr += 1;
    } else {
      offset += 1;
      endings.lf += 1;
    }
    lines.push({
      number,
      startOffset: lineStart,
      contentEndOffset,
      endOffset: offset,
      text: source.slice(lineStart, contentEndOffset),
    });
    number += 1;
    lineStart = offset;
  }
  lines.push({
    number,
    startOffset: lineStart,
    contentEndOffset: source.length,
    endOffset: source.length,
    text: source.slice(lineStart),
  });
  return { lines, lineEndingCounts: endings };
}

function lineAtOffset(lines: PhysicalLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (lines[middle].startOffset <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return lines[Math.max(0, high)]?.number ?? 1;
}

function getHeadings(lines: PhysicalLine[], source: string): HeadingLine[] {
  const headings: HeadingLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = ATX_HEADING.exec(line.text);
    if (!match) continue;
    const title = match[2].trim();
    if (!title) continue;
    headings.push({ lineIndex: index, line, level: match[1].length, title });
  }

  // Support Setext headings without misclassifying Markdown horizontal rules:
  // an underline is accepted only directly after one non-empty, non-list line.
  for (let index = 1; index < lines.length; index += 1) {
    const underline = lines[index].text.trim();
    const previous = lines[index - 1];
    if (!previous.text.trim() || LIST_MARKER.test(previous.text) || ATX_HEADING.test(previous.text)) continue;
    if (underline.length < 3 || !/^(?:=+|-+)$/u.test(underline)) continue;
    if (headings.some((heading) => heading.lineIndex === index || heading.lineIndex === index - 1)) continue;
    headings.push({
      lineIndex: index - 1,
      line: previous,
      level: underline[0] === '=' ? 1 : 2,
      title: previous.text.trim(),
    });
  }
  headings.sort((a, b) => a.lineIndex - b.lineIndex || a.level - b.level);
  return headings;
}

function buildSections(
  source: string,
  lines: PhysicalLine[],
  headings: HeadingLine[],
  documentId: string,
  hashPrefix: string,
): PromptSection[] {
  const sections: PromptSection[] = [];
  const stack: Array<{ heading: HeadingLine; section: PromptSection }> = [];
  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1].heading.level >= heading.level) {
      const closed = stack.pop()!;
      const section = closed.section;
      section.endOffset = heading.line.startOffset;
      section.endLine = lineAtOffset(lines, Math.max(section.startOffset, section.endOffset - 1));
    }
    const parentSectionId = stack[stack.length - 1]?.section.id;
    const id = `${documentId}:${hashPrefix}:section:${heading.line.startOffset}`;
    const nextBoundary = source.length;
    const section: PromptSection = {
      id,
      level: heading.level,
      title: heading.title,
      headingText: source.slice(heading.line.startOffset, heading.line.contentEndOffset),
      startOffset: heading.line.startOffset,
      endOffset: nextBoundary,
      startLine: heading.line.number,
      endLine: lineAtOffset(lines, Math.max(heading.line.startOffset, nextBoundary - 1)),
      ...(parentSectionId ? { parentSectionId } : {}),
    };
    sections.push(section);
    stack.push({ heading, section });
  }
  while (stack.length) {
    const closed = stack.pop()!;
    const section = closed.section;
    section.endOffset = source.length;
    section.endLine = lineAtOffset(lines, Math.max(section.startOffset, source.length - 1));
  }
  return sections;
}

function listMarkerIndent(line: string): number | undefined {
  const match = LIST_MARKER.exec(line);
  if (!match) return undefined;
  return match[1].replace(/\t/gu, '    ').length;
}

function collectBlocks(source: string, lines: PhysicalLine[], headings: HeadingLine[]): TextBlock[] {
  const headingByLine = new Map(headings.map((heading) => [heading.lineIndex, heading]));
  const underlineLineIndexes = new Set<number>();
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:=+|-+)$/u.test(lines[index].text.trim()) && headings.some((item) => item.lineIndex === index - 1)) {
      underlineLineIndexes.add(index);
    }
  }
  const blocks: TextBlock[] = [];
  let paragraphStart: number | undefined;
  let paragraphEnd: number | undefined;
  const flushParagraph = (): void => {
    if (paragraphStart !== undefined && paragraphEnd !== undefined) {
      blocks.push({
        startOffset: paragraphStart,
        endOffset: paragraphEnd,
        kind: 'paragraph',
        lineStart: lineAtOffset(lines, paragraphStart),
        lineEnd: lineAtOffset(lines, Math.max(paragraphStart, paragraphEnd - 1)),
      });
    }
    paragraphStart = undefined;
    paragraphEnd = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (headingByLine.has(index)) {
      flushParagraph();
      continue;
    }
    if (underlineLineIndexes.has(index)) {
      flushParagraph();
      continue;
    }
    if (!line.text.trim()) {
      flushParagraph();
      continue;
    }
    if (TABLE_ROW.test(line.text)) {
      flushParagraph();
      if (!TABLE_DIVIDER.test(line.text)) {
        blocks.push({
          startOffset: line.startOffset,
          endOffset: line.contentEndOffset,
          kind: 'table_row',
          lineStart: line.number,
          lineEnd: line.number,
        });
      }
      continue;
    }
    const indent = listMarkerIndent(line.text);
    if (indent !== undefined) {
      flushParagraph();
      let lastLine = line;
      let next = index + 1;
      for (; next < lines.length; next += 1) {
        const following = lines[next];
        if (!following.text.trim() || headingByLine.has(next) || underlineLineIndexes.has(next) || TABLE_ROW.test(following.text)) break;
        const followingIndent = listMarkerIndent(following.text);
        if (followingIndent !== undefined && followingIndent <= indent) break;
        if (followingIndent !== undefined) break; // a nested list is its own candidate
        lastLine = following;
      }
      blocks.push({
        startOffset: line.startOffset,
        endOffset: lastLine.contentEndOffset,
        kind: 'list_item',
        lineStart: line.number,
        lineEnd: lastLine.number,
      });
      index = lastLine.number - 1;
      continue;
    }
    if (paragraphStart === undefined) paragraphStart = line.startOffset;
    paragraphEnd = line.contentEndOffset;
  }
  flushParagraph();

  // Clamp spans and remove blocks that became empty after preserving exact source offsets.
  return blocks
    .map((block) => ({
      ...block,
      startOffset: Math.max(0, Math.min(block.startOffset, source.length)),
      endOffset: Math.max(0, Math.min(block.endOffset, source.length)),
    }))
    .filter((block) => block.endOffset > block.startOffset);
}

function trimSourceSpan(source: string, start: number, end: number): { startOffset: number; endOffset: number } {
  let startOffset = start;
  let endOffset = end;
  while (startOffset < endOffset && /\s/u.test(source[startOffset])) startOffset += 1;
  while (endOffset > startOffset && /\s/u.test(source[endOffset - 1])) endOffset -= 1;
  return { startOffset, endOffset };
}

function collectSignals(text: string): { category: RequirementQualification; reasons: string[]; signals: string[] } {
  const matches: Array<{ category: RequirementQualification; reason: string; signal: string; index: number }> = [];
  for (const signal of QUALIFICATION_SIGNALS) {
    signal.expression.lastIndex = 0;
    for (let match = signal.expression.exec(text); match; match = signal.expression.exec(text)) {
      matches.push({ category: signal.category, reason: signal.reason, signal: match[0], index: match.index });
      if (!match[0].length) signal.expression.lastIndex += 1;
    }
  }
  const category: RequirementQualification = matches.some((item) => item.category === 'optional')
    ? 'optional'
    : matches.some((item) => item.category === 'firm')
      ? 'firm'
      : matches.some((item) => item.category === 'ambition')
        ? 'ambition'
        : 'unclear';
  const chosen = matches.filter((item) => item.category === category).sort((a, b) => a.index - b.index);
  const uniqueReasons = [...new Set(chosen.map((item) => item.reason))];
  const uniqueSignals = [...new Set(chosen.map((item) => item.signal))];
  if (category === 'unclear') {
    uniqueReasons.push('candidate-shaped text has no explicit strength marker; qualification remains unclear');
  }
  return { category, reasons: uniqueReasons, signals: uniqueSignals };
}

function isRequirementCandidate(text: string, kind: TextBlock['kind']): boolean {
  if (REQUIREMENT_CUE.test(text)) return true;
  if (kind === 'list_item' && ACTION_START.test(text)) return true;
  if (kind === 'table_row' && /\b(?:required|mandatory|essential|optional|obligatoire|facultatif|optionnel|must|shall|yes|non|oui)\b/iu.test(text)) return true;
  return false;
}

function explicitReferences(
  text: string,
  sourceStartOffset: number,
  lines: PhysicalLine[],
): { references: ExplicitPromptReference[]; dependencies: ExplicitPromptReference[] } {
  const found: ExplicitPromptReference[] = [];
  const addMatches = (regex: RegExp, kind: ExplicitPromptReference['kind']): void => {
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      const exactText = match[0];
      const prefix = text.slice(Math.max(0, match.index - 70), match.index);
      const dependency = DEPENDENCY_PREFIX.test(prefix);
      const startOffset = sourceStartOffset + match.index;
      const endOffset = startOffset + exactText.length;
      found.push({
        text: exactText,
        target: exactText.replace(/\s+/gu, ' ').trim(),
        kind,
        relation: dependency ? 'dependency' : 'citation',
        basis: dependency ? 'explicit dependency phrase immediately precedes reference' : 'explicit reference text; no dependency relation inferred',
        startOffset,
        endOffset,
        startLine: lineAtOffset(lines, startOffset),
        endLine: lineAtOffset(lines, Math.max(startOffset, endOffset - 1)),
      });
      if (!exactText.length) regex.lastIndex += 1;
    }
  };
  addMatches(REQUIREMENT_REFERENCE, 'requirement_id');
  addMatches(SECTION_REFERENCE, 'section');
  found.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  const deduped = found.filter((item, index) => index === 0 || item.startOffset !== found[index - 1].startOffset || item.endOffset !== found[index - 1].endOffset);
  return {
    references: deduped,
    dependencies: deduped.filter((reference) => reference.relation === 'dependency'),
  };
}

/**
 * Deterministically inventories prompt structure and lexical requirement candidates.
 * It retains the original string and uses JavaScript's UTF-16 offsets throughout.
 * No model is called and the output is not a claim of semantic understanding or
 * exhaustive requirement extraction.
 */
export function compilePrompt(text: string, options: CompilePromptOptions = {}): CompiledPrompt {
  if (typeof text !== 'string') throw new TypeError('Le prompt doit être une chaîne de caractères.');
  const sourceText = text;
  const sha256 = sha256Utf8(sourceText);
  const hashPrefix = sha256.slice(0, 16);
  const suppliedId = options.sourceId?.trim();
  const documentId = suppliedId ? suppliedId.replace(/[^\p{L}\p{N}._-]+/gu, '-') : `prompt-${hashPrefix}`;
  const { lines, lineEndingCounts } = physicalLines(sourceText);
  const headings = getHeadings(lines, sourceText);
  const sections = buildSections(sourceText, lines, headings, documentId, hashPrefix);
  const blocks = collectBlocks(sourceText, lines, headings);
  const qualificationCounts: Record<RequirementQualification, number> = {
    firm: 0,
    ambition: 0,
    optional: 0,
    unclear: 0,
  };
  const candidates: PromptRequirementCandidate[] = [];
  const activeSections: PromptSection[] = [];
  let headingCursor = 0;

  for (const block of blocks) {
    const span = trimSourceSpan(sourceText, block.startOffset, block.endOffset);
    if (span.endOffset <= span.startOffset) continue;
    const exactText = sourceText.slice(span.startOffset, span.endOffset);
    if (!isRequirementCandidate(exactText, block.kind)) continue;
    while (headingCursor < headings.length && headings[headingCursor].line.startOffset <= span.startOffset) {
      const heading = headings[headingCursor];
      while (activeSections.length && activeSections[activeSections.length - 1].level >= heading.level) {
        activeSections.pop();
      }
      activeSections.push(sections[headingCursor]);
      headingCursor += 1;
    }
    const qualification = collectSignals(exactText);
    const ancestry = activeSections;
    const { references, dependencies } = explicitReferences(exactText, span.startOffset, lines);
    const startLine = lineAtOffset(lines, span.startOffset);
    const endLine = lineAtOffset(lines, Math.max(span.startOffset, span.endOffset - 1));
    const id = `${documentId}:${hashPrefix}:candidate:${span.startOffset}-${span.endOffset}`;
    qualificationCounts[qualification.category] += 1;
    candidates.push({
      id,
      ...span,
      startLine,
      endLine,
      text: exactText,
      sectionIds: ancestry.map((item) => item.id),
      sectionPath: ancestry.map((item) => item.title),
      qualification: {
        ...qualification,
        method: 'deterministic_lexical',
      },
      dependencies,
      references,
    });
  }

  return {
    schemaVersion: '1.0.0',
    id: documentId,
    sha256,
    hashEncoding: 'UTF-8',
    sourceText,
    source: {
      utf16Length: sourceText.length,
      lineCount: lines.length,
      lineEndingCounts,
    },
    sections,
    candidates,
    analysis: {
      method: 'deterministic_lexical',
      llmUsed: false,
      sourceRetainedCompletely: true,
      semanticUnderstandingClaimed: false,
      extractionCompleteness: 'not_semantically_exhaustive',
      blocksExamined: blocks.length,
      candidateCount: candidates.length,
      nonCandidateBlockCount: Math.max(0, blocks.length - candidates.length),
      qualificationCounts,
      dependencyPolicy: 'explicit_reference_only',
    },
  };
}
