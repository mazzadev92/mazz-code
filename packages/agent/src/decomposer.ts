/**
 * Small, deterministic task feeder for multi-artifact coding requests.
 *
 * This deliberately uses structure that survives translation (paths,
 * extensions, lists and verification markers) plus compact FR/EN action
 * vocabularies. It never asks a model to summarize the prompt before the
 * model starts implementing it. Unsupported or ambiguous requests fall back
 * to the normal agent planner instead of guessing file names or scope.
 */

export type DetectedRequestLanguage = 'fr' | 'en' | 'es' | 'de' | 'pt' | 'it' | 'ru' | 'zh' | 'ja' | 'ar' | 'und';
export type MicroTaskRole = 'inspect' | 'research' | 'source' | 'test-source' | 'documentation' | 'compile-library' | 'compile-test' | 'run-integration' | 'run-test' | 'run-cli';

export interface MicroTaskStep {
  id: string;
  content: string;
  dependencies: string[];
  status: 'pending' | 'in_progress';
  instruction: string;
  role: MicroTaskRole;
}

export interface DecomposedTask {
  detectedLanguage: DetectedRequestLanguage;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  items: MicroTaskStep[];
}

interface MicroTaskStrings {
  safety: string;
  inspect: string;
  research: string;
  source: (target: string, language: string, requirements: string) => string;
  test: (target: string, requirements: string) => string;
  docs: (target: string, requirements: string, citationRule: string) => string;
  docsBib1: string;
  docsPlain: string;
  objective: string;
  constraints: string;
  continue: string;
  summary: string;
  toolOnly: string;
}

const MICRO_TASK_STRINGS: Record<'fr' | 'en' | 'es', MicroTaskStrings> = {
  fr: {
    safety: 'Respecte les contraintes globales. Écris uniquement cette cible; ne conclus pas avant les preuves des outils.',
    inspect: 'Appelle exactement fs.list avec path="." pour lister la racine du workspace en lecture seule.',
    research: 'Utilise knowledge.search avec query seulement pour trouver les références dans le Bib1 déjà configuré; omets vault_path. Retourne les paramètres et citations exactes pour la documentation.',
    source: (target, language, requirements) => `Implémente ${target} avec fs.write. Écris seulement ce fichier et produis du code ${language} complet. Exigences :\n${requirements}`,
    test: (target, requirements) => `Écris ${target} avec fs.write. Les tests doivent appeler la vraie implémentation et échouer avec un code non nul. Exigences :\n${requirements}`,
    docs: (target, requirements, citationRule) => `Écris ${target} avec fs.write. Explique comment construire, utiliser et vérifier le projet. ${citationRule}\nExigences :\n${requirements}`,
    docsBib1: 'Cite seulement les sources retournées par Bib1; si aucune n’a été trouvée, indique-le sans inventer de référence.',
    docsPlain: 'Suis les exigences demandées sans ajouter de dépendances ou de fonctions.',
    objective: 'Objectif', constraints: 'Contraintes',
    continue: 'Exécute uniquement cette étape; attends la suivante après réussite.',
    summary: 'Toutes les étapes planifiées ont un résultat d’outil réussi. Résume les résultats sans ajouter de réussite non vérifiée.',
    toolOnly: 'Appelle uniquement l’outil de cette étape, avec ses arguments exacts. N’ajoute aucune explication.',
  },
  en: {
    safety: 'Follow the global constraints. Write only this target; do not claim checks passed without tool evidence.',
    inspect: 'Call fs.list exactly with path="." to list the workspace root in read-only mode.',
    research: 'Use knowledge.search with query only to find references in the already configured Bib1 library; omit vault_path. Return exact parameters and citations for the documentation.',
    source: (target, language, requirements) => `Implement ${target} with fs.write. Write only this file and produce complete ${language} code. Requirements:\n${requirements}`,
    test: (target, requirements) => `Write ${target} with fs.write. Tests must call the real implementation and exit non-zero on failure. Requirements:\n${requirements}`,
    docs: (target, requirements, citationRule) => `Write ${target} with fs.write. Explain how to build, use, and verify the project. ${citationRule}\nRequirements:\n${requirements}`,
    docsBib1: 'Cite only sources returned by Bib1; if none were found, say so without inventing a reference.',
    docsPlain: 'Follow the requested requirements without adding dependencies or features.',
    objective: 'Objective', constraints: 'Constraints',
    continue: 'Do only this step; wait for the next after success.',
    summary: 'Every planned step has a successful tool result. Summarize the evidence without claiming anything unverified.',
    toolOnly: 'Call only the tool requested in this step, using its exact arguments. Do not add an explanation.',
  },
  es: {
    safety: 'Respeta las restricciones globales. Escribe solo este archivo; no afirmes que una comprobación pasó sin evidencia de una herramienta.',
    inspect: 'Usa fs.list exactamente con path="." para listar la raíz del workspace en modo de solo lectura.',
    research: 'Usa knowledge.search solo con query para buscar referencias en Bib1 ya configurado; omite vault_path. Devuelve los parámetros y las citas exactas para la documentación.',
    source: (target, language, requirements) => `Implementa ${target} con fs.write. Escribe solo este archivo y crea código ${language} completo. Requisitos:\n${requirements}`,
    test: (target, requirements) => `Escribe ${target} con fs.write. Las pruebas deben llamar a la implementación real y terminar con código distinto de cero si fallan. Requisitos:\n${requirements}`,
    docs: (target, requirements, citationRule) => `Escribe ${target} con fs.write. Explica cómo construir, usar y verificar el proyecto. ${citationRule}\nRequisitos:\n${requirements}`,
    docsBib1: 'Cita solo fuentes devueltas por Bib1; si no encuentra ninguna, indícalo sin inventar referencias.',
    docsPlain: 'Sigue los requisitos pedidos sin añadir dependencias ni funciones.',
    objective: 'Objetivo', constraints: 'Restricciones',
    continue: 'Haz solo este paso; espera al siguiente tras el éxito.',
    summary: 'Todas las etapas tienen un resultado de herramienta satisfactorio. Resume las pruebas sin afirmar nada no verificado.',
    toolOnly: 'Usa solo la herramienta de esta etapa con los argumentos exactos. No añadas explicaciones.',
  },
};

function stringsFor(language: DetectedRequestLanguage): MicroTaskStrings {
  return language === 'fr' || language === 'es' ? MICRO_TASK_STRINGS[language] : MICRO_TASK_STRINGS.en;
}

const SOURCE_EXTENSIONS = new Set(['py', 'pyw', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'js', 'jsx', 'ts', 'tsx', 'rs', 'go', 'java', 'cs', 'rb', 'php', 'sh', 'ps1', 'bat', 'cmd']);
const EXTENSION_LANGUAGE: Record<string, string> = {
  py: 'Python', pyw: 'Python', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++',
  js: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', rs: 'Rust', go: 'Go',
  java: 'Java', cs: 'C#', rb: 'Ruby', php: 'PHP', sh: 'Shell', ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch',
};

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function truncateAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const limited = value.slice(0, maxLength + 1);
  const boundary = limited.lastIndexOf(' ');
  return `${limited.slice(0, boundary > maxLength * 0.6 ? boundary : maxLength).trimEnd()}…`;
}

function detectLanguage(text: string): DetectedRequestLanguage {
  if (/[\u4e00-\u9fff]/u.test(text)) return 'zh';
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
  if (/[\u0400-\u04ff]/u.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/u.test(text)) return 'ar';
  const value = normalize(text);
  const clues: Array<[DetectedRequestLanguage, RegExp]> = [
    ['fr', /\b(?:le|la|les|des|dans|avec|puis|ensuite|cree|creer|ecris|ajoute|tests?|fichier|projet|compile|lance|verifie|recherche)\b/gu],
    ['es', /\b(?:el|la|los|las|con|para|luego|crear|escribe|agrega|prueba|archivo|proyecto|compila|ejecuta|verifica)\b/gu],
    ['de', /\b(?:der|die|das|mit|und|dann|erstelle|schreibe|hinzufuegen|teste|datei|projekt|kompiliere|ausfuehren)\b/gu],
    ['pt', /\b(?:com|para|depois|crie|escreva|adicione|testes?|arquivo|projeto|compile|execute|verifique)\b/gu],
    ['it', /\b(?:il|lo|gli|con|poi|crea|scrivi|aggiungi|test|file|progetto|compila|esegui|verifica)\b/gu],
    ['en', /\b(?:the|with|then|create|write|add|test|file|project|compile|run|verify|build|implement)\b/gu],
  ];
  const ranked = clues.map(([language, pattern]) => [language, [...value.matchAll(pattern)].length] as const)
    .sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[1] ? ranked[0][0] : 'und';
}

function splitClauses(goal: string): string[] {
  return goal
    .replace(/\r/g, '')
    .split(/\n+/u)
    .flatMap((line) => line
      .replace(/\s+(?:and then|then|after that|puis|ensuite|despues|luego|dann|poi)\s+/giu, '. ')
      .split(/(?<=[.!?;])\s+/u))
    .map((clause) => clause.replace(/^\s*(?:[-*]|\d{1,2}[.)])\s*/u, '').trim())
    .filter(Boolean);
}

function explicitTargets(goal: string): string[] {
  const matches = goal.match(/(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_.-]+\.(?:pyw?|c|h|cc|cpp|cxx|hpp|js|jsx|ts|tsx|rs|go|java|cs|rb|php|sh|ps1|bat|cmd|md|rst|toml|json|ya?ml|txt)(?=$|[\s.,;:!?)}\]"'`]|[\\/])/giu) ?? [];
  const targets = new Map<string, string>();
  for (const match of matches) {
    const value = match.replace(/\\/g, '/').replace(/^["'`]|["'`,;:!?)]$/gu, '');
    if (/^(?:[A-Za-z]:\/|\/|\.\.\/)/u.test(value)) continue;
    const key = value.toLowerCase();
    if (!targets.has(key)) targets.set(key, value);
  }
  return [...targets.values()];
}

function projectSlug(goal: string, targets: readonly string[]): string {
  const explicitSource = targets.find((target) => SOURCE_EXTENSIONS.has(target.split('.').at(-1)?.toLowerCase() ?? ''));
  if (explicitSource) {
    const basename = explicitSource.split('/').at(-1)!.replace(/\.[^.]+$/u, '').replace(/^(?:test|spec)[_-]/iu, '');
    if (basename.length > 1) return basename.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 32);
  }
  const crcName = goal.match(/\b(?:crc)[-_ ]?(\d{1,3})\b/iu);
  if (crcName) return `crc${crcName[1]}`;
  const named = goal.match(/\b(?:called|named|nomme|intitule|baptise|appelle)\s+["'`]?([\p{L}\p{N}_-]{2,40})/iu);
  if (named) return normalize(named[1]).replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 32);
  const identifier = goal.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,4}\b/iu);
  if (identifier) return identifier[0].toLowerCase().slice(0, 32);
  return 'project';
}

function inferLanguages(goal: string, targets: readonly string[]): string[] {
  const found = new Set<string>();
  for (const target of targets) {
    const extension = target.split('.').at(-1)?.toLowerCase() ?? '';
    const language = EXTENSION_LANGUAGE[extension];
    if (language) found.add(language);
  }
  const value = normalize(goal);
  if (/\bpython\b/u.test(value)) found.add('Python');
  if (/\b(?:c\+\+|cpp)\b/u.test(value)) found.add('C++');
  else if (/\b(?:language c|langage c|en c|c core|core c|c companion|c complementaire|python.{0,80}\bc\b|\bc\b.{0,80}python)\b/u.test(value)) found.add('C');
  if (/\b(?:javascript|node(?:\.js)?|js)\b/u.test(value)) found.add('JavaScript');
  if (/\btypescript\b/u.test(value)) found.add('TypeScript');
  if (/\brust\b/u.test(value)) found.add('Rust');
  if (/\bgolang\b|\bgo language\b/u.test(value)) found.add('Go');
  if (/\bjava\b/u.test(value)) found.add('Java');
  if (/\bc#\b|\bcsharp\b/u.test(value)) found.add('C#');
  return [...found];
}

function isTestTarget(target: string): boolean {
  return /(?:^|\/)(?:tests?|specs?)(?:\/|$)|(?:^|[._-])(?:test|tests|spec|smoke)(?:[._-]|$)/iu.test(target);
}

function isDocumentationTarget(target: string): boolean {
  return /(?:^|\/)readme\.[^.]+$/iu.test(target) || /\.(?:md|rst)$/iu.test(target);
}

function testRequested(goal: string): boolean {
  return /\b(?:tests?|unittest|pytest|jest|vitest|unit tests?|test suite|essais?|pruebas?|testes?|测试|テスト|тесты)\b/iu.test(normalize(goal));
}

function readmeRequested(goal: string): boolean {
  return /\b(?:readme|documentation|docs?|manuel|documentation|documentacion|documentacao|dokumentation)\b/iu.test(normalize(goal));
}

function codeActionRequested(goal: string): boolean {
  return /\b(?:create|write|build|implement|develop|add|generate|make|fix|change|modify|refactor|cree|creer|ecris|ecrire|monte|ajoute|developpe|implemente|corrige|modifie|construye|crear|escribe|agrega|erstelle|schreibe|erzeuge|crie|escreva|aggiungi|scrivi)\b/iu.test(normalize(goal));
}

function hasBuildOrRunRequest(goal: string): boolean {
  return /\b(?:compile|compilation|compiler|gcc|build|run|execute|launch|test|tests|unittest|pytest|compile|lance|lancer|execute|executer|teste|tester|verifie|verifier|essais?|compila|ejecuta|prueba|kompiliere|ausfuehren)\b/iu.test(normalize(goal));
}

function sharedLibraryExtension(): string {
  return process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
}

function executableExtension(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

function relevantClauses(goal: string, target: string, role: MicroTaskRole, language?: string): string[] {
  const clauses = splitClauses(goal);
  const baseName = target.split('/').at(-1)?.replace(/\.[^.]+$/u, '').toLowerCase() ?? '';
  const fileExtension = target.split('.').at(-1)?.toLowerCase() ?? '';
  const rolePattern = role === 'test-source'
    ? /\b(?:test|tests|unittest|pytest|vecteur|vector|smoke|essai|testes?|prueba|testes?)\b/iu
    : role === 'documentation'
      ? /\b(?:readme|documentation|docs?|citation|source|reference|référence|bib1|bibliotheque|bibliothèque|api|function|fonction|module|export|expose|signature|cli|command|commande|example|exemple|valid input|entrée valide)\b/iu
      : /\b(?:code|source|core|library|shared|ctypes|crc|zlib|polynomial|seed|blocks?|blocs?|function|fonction|module|script|program|application|export|expose|api|interface|signature|method|class|return|reject|raise|strip|cli|command|commande|python|c\+\+|rust|typescript|javascript)\b/iu;
  const scored = clauses.map((clause, index) => {
    const value = normalize(clause);
    let score = index === 0 ? 1 : 0;
    if (value.includes(baseName) && baseName.length > 2) score += 5;
    if (fileExtension && value.includes(`.${fileExtension}`)) score += 3;
    if (language && value.includes(normalize(language))) score += 3;
    if (rolePattern.test(value)) score += 2;
    if (role === 'source' && /\b(?:module|export|expose|api|interface|signature|reject|raise|throws?|strip|whitespace|argument|argparse|ctypes|loads?|native|seed|incremental|blocks?)\b/iu.test(value)) score += 3;
    if (/(?:crc|zlib|polynomial|polynome|seed|64\s*(?:kio|kb)|ctypes|incremental|incremente|empty|vide|123456789|cbf43926)/iu.test(value)) score += 2;
    return { clause, index, score };
  }).filter((item) => item.score > 0);
  // A microtask must carry only the requirements that affect this artifact.
  // Ranking first avoids forwarding every test, documentation, and research
  // clause to each file-writing call on a small model.
  return scored
    .filter((item) => !/^(?:the files? (?:requested|are)|les fichiers? (?:demandés|demandes)|files?:|fichiers\s*:)/iu.test(item.clause))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, role === 'test-source' ? 4 : role === 'source' && ['h', 'hpp', 'hxx'].includes(fileExtension) ? 2 : role === 'source' ? 4 : 3)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.clause);
}

function requestConstraints(goal: string): string[] {
  // Keep only cross-cutting safety constraints. Compress compound user
  // sentences instead of copying unrelated requirements to every step.
  const value = normalize(goal);
  const constraints: string[] = [];
  const mentionsWorkspace = /\b(?:workspace|working directory|repository|repo|projet|dossier|carpeta|ordner|diretorio|directorio)\b/iu.test(value);
  const scopeCue = /\b(?:only|inside|within|keep changes|uniquement|seulement|dans|solo|nur|apenas|somente|mant[eé]n|mant[eé]m|keep)\b/iu.test(value);
  if (mentionsWorkspace && scopeCue) constraints.push('Work only inside the selected workspace.');
  if (/\b(?:do not|don't|never|no)\b.{0,32}\b(?:delete|remove|erase|overwrite|replace|borres|elimines|supprime|efface|loeschen|borrar|eliminar)\b|\bne\s+(?:supprime|modifie|efface)\b.{0,24}\b(?:pas|rien|aucun|aucune)\b/iu.test(value)) {
    constraints.push('Do not delete or overwrite unrelated files.');
  }
  if (/\b(?:compact|small|minimal|uniquement les fichiers necessaires|only necessary files|keep it small|pequeno|pequeno|klein)\b/iu.test(value)) {
    constraints.push('Keep the project compact and limited to requested files.');
  }
  if (!constraints.length) constraints.push('Work only inside the selected workspace and preserve unrelated files.');
  return constraints.slice(0, 3);
}

function explicitKnowledgeQuery(goal: string): string | undefined {
  const tool = /\bknowledge\.search\b/iu.exec(goal);
  if (!tool || tool.index === undefined) return undefined;
  const afterTool = goal.slice(tool.index + tool[0].length);
  const quoted = afterTool.match(/(?:^\s*|\b(?:for|pour|sur|about|concernant|query|sujet|topic)\s*)[\u0060'“"]([^\u0060'”"]{3,240})[\u0060'”"]/iu)?.[1]?.trim();
  if (quoted) return quoted;
  const clause = afterTool.split(/[.;\r\n]/u, 1)[0] ?? '';
  const query = clause
    .replace(/^\s*(?:(?:dans|in|from)\s+(?:Bib1|the vault|the knowledge base)\s*)?/iu, '')
    .replace(/^\s*(?:pour|sur|for|about|to|concernant)\s*/iu, '')
    .replace(/^\s*(?:(?:les|des|the)\s+)?(?:details?|détails?|informations?|information)(?:\s+(?:de|sur|concernant|about|on))?\s*/iu, '')
    .replace(/^\s*(?:(?:rechercher?|retrouver?|chercher?|trouver?|search(?:ing)?|find)\s+)/iu, '')
    .trim();
  return query.length >= 3 ? query.slice(0, 240).trim() : undefined;
}

function taskInstruction(role: MicroTaskRole, target: string | undefined, goal: string, language: string | undefined, paths: readonly string[], slug: string, detectedLanguage: DetectedRequestLanguage): string {
  const strings = stringsFor(detectedLanguage);
  const objectiveClause = splitClauses(goal)[0];
  const selected = role === 'research'
    ? splitClauses(goal).filter((clause) => /\b(?:bib1|vault|knowledge library|bibliotheque|biblioteca|citation|reference|crc|polynomial|polynome)\b/iu.test(normalize(clause))).slice(0, 3)
    : target ? relevantClauses(goal, target, role, language) : splitClauses(goal).slice(0, 5);
  // Keep full relevant clauses. Slicing at a fixed character count used to
  // cut paths and requirements in the middle (for example, after "for each"),
  // which made small-model artifact prompts ambiguous. Drop lower-priority
  // clauses at sentence boundaries instead of truncating their text.
  const extension = target?.split('.').at(-1)?.toLowerCase();
  const briefLimit = role === 'test-source' ? 1200
    : role === 'source' && ['h', 'hpp', 'hxx'].includes(extension ?? '') ? 500
      : role === 'source' && ['c', 'cc', 'cpp', 'cxx'].includes(extension ?? '') ? 800
        : role === 'source' ? 1_000
          : 900;
  const briefParts: string[] = [];
  let briefLength = 0;
  for (const clause of selected.filter((item) => item !== objectiveClause)) {
    const separatorLength = briefParts.length ? 1 : 0;
    if (briefLength + separatorLength + clause.length > briefLimit) continue;
    briefParts.push(clause);
    briefLength += separatorLength + clause.length;
  }
  const brief = briefParts.join('\n');
  const safety = strings.safety;
  if (role === 'inspect') return strings.inspect;
  if (role === 'research') {
    const explicitTopic = explicitKnowledgeQuery(goal);
    const query = explicitTopic
      ?? (/\bcrc\s*-?\s*32\b/iu.test(goal)
        ? 'Python zlib binascii crc32 API seed incremental CRC-32 ISO-HDLC check 123456789'
        : brief || slug);
    return `${strings.research}\nTopic: ${query}`;
  }
  if (role === 'source') return `${strings.source(target ?? '', language ?? 'source', brief)}\n${safety}`;
  if (role === 'test-source') return `${strings.test(target ?? '', brief)}\n${safety}`;
  if (role === 'documentation') {
    const requiresBib1 = /\b(?:bib1|vault|knowledge library|bibliotheque|biblioteca|citation|citations|references|reference|source de reference)\b/iu.test(normalize(goal));
    return `${strings.docs(target ?? '', brief, requiresBib1 ? strings.docsBib1 : strings.docsPlain)}\n${safety}`;
  }
  if (role === 'compile-library') return `Compile le cœur C en bibliothèque partagée avec compiler.gcc. sourceFiles=${JSON.stringify(paths)}; outputExe=${JSON.stringify(`build/${slug}${sharedLibraryExtension()}`)}; kind="shared_library"; flags=["-Wall"]. Le résultat sera chargé par Python ctypes. N’invente pas le résultat.`;
  if (role === 'compile-test') {
    const smokeFlag = /\bENGINE_SMOKE\b/u.test(goal) ? ',"-DENGINE_SMOKE"' : '';
    const sources = paths.length ? paths : [];
    return `Compile le test C avec compiler.gcc. sourceFiles=${JSON.stringify(sources)}; outputExe=${JSON.stringify(`build/${slug}_smoke${executableExtension()}`)}; kind="executable"; flags=["-Wall"${smokeFlag}]. N’invente pas le résultat.`;
  }
  if (role === 'run-integration') {
    const pythonSource = paths.find((file) => /\.pyw?$/iu.test(file));
    if (!pythonSource) return 'Vérifie par terminal.run que le module Python charge la bibliothèque native; un résultat réel sans code de sortie nul ne valide pas cette étape.';
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const pythonString = (value: string) => `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
    const expectedLibrary = `build/${slug}${sharedLibraryExtension()}`;
    const script = `import ctypes, runpy, sys; from pathlib import Path; ns=runpy.run_path(${pythonString(pythonSource)}); expected=Path(${pythonString(expectedLibrary)}).resolve(); loaded=any(isinstance(value, ctypes.CDLL) and isinstance(value._name, str) and Path(value._name).resolve()==expected for value in ns.values()); print(${pythonString('MAZZ_NATIVE_LOAD_OK')} if loaded else ${pythonString('MAZZ_NATIVE_LOAD_MISSING')}); sys.exit(0 if loaded else 2)`;
    // PowerShell's native argument conversion drops nested double quotes when
    // -Command is passed through CreateProcess. Keep Python literals single
    // quoted inside a double-quoted -c argument so the script reaches Python
    // intact on Windows and remains valid in POSIX shells.
    const command = `${python} -c "${script}"`;
    return `Vérifie réellement l’intégration Python+C avec terminal.run : importe ${pythonSource}, exige que ctypes.CDLL charge précisément ${expectedLibrary} et le marqueur MAZZ_NATIVE_LOAD_OK. Un autre objet CDLL ne suffit pas. command=${JSON.stringify(command)}. Attends un code de sortie nul avant de conclure.`;
  }
  if (role === 'run-test') {
    const commandParts: string[] = [];
    if (paths.some((file) => /\.py$/iu.test(file))) commandParts.push(`${process.platform === 'win32' ? 'python' : 'python3'} -m unittest discover -s tests -v`);
    if (paths.some((file) => /\.(?:c|cc|cpp|cxx)$/iu.test(file)) || /\bENGINE_SMOKE\b|\bC\s+smoke\b|\bsmoke\s+C\b/iu.test(goal)) {
      commandParts.push(process.platform === 'win32' ? `& 'build/${slug}_smoke${executableExtension()}'` : `./build/${slug}_smoke${executableExtension()}`);
    }
    const command = commandParts.length > 1
      ? process.platform === 'win32'
        ? `${commandParts[0]}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ${commandParts.slice(1).join('; ')}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
        : commandParts.join(' && ')
      : commandParts[0];
    return command
      ? `Lance réellement les tests demandés avec terminal.run. command=${JSON.stringify(command)}. Ne conclus qu’après un code de sortie nul.`
      : `Lance réellement les tests demandés avec terminal.run. Exécute la commande de test adaptée au workspace et attends un code de sortie nul.`;
  }
  const pythonSource = paths.find((file) => /\.py$/iu.test(file));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const commandTarget = pythonSource ? JSON.stringify(pythonSource) : undefined;
  const explicitCli = goal.match(/\bpython\s+[`'"]?([\w./\\-]+\.py)[`'"]?\s+([A-Za-z_]\w*)\s+(-?\d+)\s+(-?\d+)/iu);
  const command = commandTarget
    ? explicitCli && explicitCli[1] === pythonSource
      ? `${python} ${commandTarget} --help; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $mazzCliOutput = ${python} ${commandTarget} ${explicitCli[2]} ${explicitCli[3]} ${explicitCli[4]}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if ($mazzCliOutput -notmatch '(^|\\D)42(\\D|$)') { Write-Error "Valeur attendue 42 absente."; exit 1 }; Write-Output $mazzCliOutput`
      : `${python} ${commandTarget} --help`
    : undefined;
  return command
    ? `Vérifie la CLI avec terminal.run sans modifier les fichiers. command=${JSON.stringify(command)} et attends un code de sortie nul.`
    : `Vérifie la CLI avec terminal.run en exécutant le mode d’aide sans modifier les fichiers. Attends un code de sortie nul avant de conclure.`;
}

function pushStep(items: MicroTaskStep[], role: MicroTaskRole, content: string, instruction: string): void {
  const id = `s${items.length + 1}`;
  items.push({ id, content: content.slice(0, 500), dependencies: items.length ? [items.at(-1)!.id] : [], status: items.length ? 'pending' : 'in_progress', instruction, role });
}

/** Return a bounded, deterministic sequence only when the request has enough structure to avoid guessing. */
export function decomposeTask(goal: string): DecomposedTask | undefined {
  const cleanGoal = goal.trim();
  if (cleanGoal.length < 240 || cleanGoal.length > 20_000) return undefined;
  const targets = explicitTargets(cleanGoal);
  const languages = inferLanguages(cleanGoal, targets);
  const hasTests = testRequested(cleanGoal);
  const hasReadme = readmeRequested(cleanGoal);
  const hasPaths = targets.length >= 2;
  const languagePair = languages.length >= 2;
  const hasSourcePath = targets.some((target) => SOURCE_EXTENSIONS.has(target.split('.').at(-1)?.toLowerCase() ?? ''));
  const hasProjectIntent = codeActionRequested(cleanGoal) || /\b(?:project|application|app|program|programme|script|projet|application|logiciel|programa|proyecto|projekt|progetto)\b/iu.test(normalize(cleanGoal));
  const multiDeliverable = hasPaths || languagePair && (hasTests || hasReadme) || hasSourcePath && (hasTests || hasReadme || hasBuildOrRunRequest(cleanGoal))
    || hasProjectIntent && hasTests && hasReadme;
  if (!multiDeliverable || !languages.length || !(hasProjectIntent || hasPaths)) return undefined;

  const slug = projectSlug(cleanGoal, targets) || 'project';
  const sourceTargets = targets.filter((target) => SOURCE_EXTENSIONS.has(target.split('.').at(-1)?.toLowerCase() ?? '') && !isTestTarget(target));
  const testTargets = targets.filter(isTestTarget);
  const documentationTargets = targets.filter(isDocumentationTarget);

  if (!sourceTargets.length) {
    if (languages.includes('C') && languages.includes('Python')) {
      sourceTargets.push(`src/${slug}.c`, `src/${slug}.py`);
    } else {
      const primary = languages[0];
      const extension = Object.entries(EXTENSION_LANGUAGE).find(([, value]) => value === primary)?.[0] ?? 'py';
      sourceTargets.push(`src/${slug}.${extension}`);
    }
  }
  if (hasTests && !testTargets.length) {
    if (languages.includes('Python')) testTargets.push(`tests/test_${slug}.py`);
    if (languages.includes('C') && /\b(?:c test|test c|c smoke|smoke test|test C|test C)\b/iu.test(cleanGoal)) testTargets.push(`tests/${slug}_smoke.c`);
    if (!testTargets.length) {
      const sourceExtension = sourceTargets[0]?.split('.').at(-1) ?? 'py';
      testTargets.push(`tests/test_${slug}.${sourceExtension}`);
    }
  }
  if (hasReadme && !documentationTargets.length) documentationTargets.push('README.md');

  const items: MicroTaskStep[] = [];
  const detectedLanguage = detectLanguage(cleanGoal);
  if (/\b(?:workspace|project|repository|repo|projet|dossier|carpeta|ordner|diretorio|directorio)\b/iu.test(normalize(cleanGoal)) || hasPaths || languagePair) {
    // Keep the plan action class unambiguous: the checker treats natural
    // language "inspect" as a read, while fs.list is a list operation.
    pushStep(items, 'inspect', 'List the workspace with fs.list.', taskInstruction('inspect', undefined, cleanGoal, undefined, [], slug, detectedLanguage));
  }
  if (/\b(?:bib1|vault|knowledge library|bibliotheque|biblioteca|citation|citations|references|références|reference source|source de reference)\b/iu.test(normalize(cleanGoal))) {
    // Keep the explicit tool and natural-language verb in the same search
    // action class so validation and tool dispatch agree.
    pushStep(items, 'research', 'Use knowledge.search for Bib1 references.', taskInstruction('research', undefined, cleanGoal, undefined, [], slug, detectedLanguage));
  }

  for (const target of sourceTargets) {
    const extension = target.split('.').at(-1)?.toLowerCase() ?? '';
    const language = EXTENSION_LANGUAGE[extension];
    pushStep(items, 'source', `Create ${target} with fs.write.`, taskInstruction('source', target, cleanGoal, language, [], slug, detectedLanguage));
  }
  for (const target of testTargets) {
    const extension = target.split('.').at(-1)?.toLowerCase() ?? '';
    pushStep(items, 'test-source', `Create ${target} with fs.write.`, taskInstruction('test-source', target, cleanGoal, EXTENSION_LANGUAGE[extension], [], slug, detectedLanguage));
  }
  for (const target of documentationTargets) {
    pushStep(items, 'documentation', `Write ${target} with fs.write.`, taskInstruction('documentation', target, cleanGoal, undefined, [], slug, detectedLanguage));
  }

  const cSources = sourceTargets.filter((target) => /\.(?:c|cc|cpp|cxx)$/iu.test(target));
  const cTests = testTargets.filter((target) => /\.(?:c|cc|cpp|cxx)$/iu.test(target));
  const pythonSource = sourceTargets.find((target) => /\.pyw?$/iu.test(target));
  const sharedLibraryRequested = languages.includes('Python') && languages.includes('C')
    || /\b(?:ctypes|shared library|dynamic library|bibliotheque partagee|dll|\.dll)\b/iu.test(normalize(cleanGoal));
  if (sharedLibraryRequested && cSources.length) {
    const libraryPath = `build/${slug}${sharedLibraryExtension()}`;
    pushStep(items, 'compile-library', `Compile a shared library with compiler.gcc to ${libraryPath}.`, taskInstruction('compile-library', undefined, cleanGoal, 'C', cSources, slug, detectedLanguage));
    if (languages.includes('Python') && pythonSource) {
      const integrationContent = `Import ${pythonSource} with terminal.run and verify it loads the compiled C library through ctypes.CDLL.`;
      pushStep(items, 'run-integration', integrationContent, taskInstruction('run-integration', undefined, cleanGoal, 'Python', [pythonSource], slug, detectedLanguage));
    }
  }
  const hasCSmoke = /\bENGINE_SMOKE\b|\bC\s+smoke\b|\bsmoke\s+C\b/iu.test(cleanGoal);
  if ((hasBuildOrRunRequest(cleanGoal) || cTests.length || hasCSmoke) && cSources.length && (cTests.length || hasCSmoke)) {
    const executablePath = `build/${slug}_smoke${executableExtension()}`;
    pushStep(items, 'compile-test', `Compile the C smoke executable with compiler.gcc to ${executablePath}.`, taskInstruction('compile-test', undefined, cleanGoal, 'C', [...cSources, ...cTests], slug, detectedLanguage));
  }
  if (hasTests) {
    pushStep(items, 'run-test', 'Run the requested tests with terminal.run.', taskInstruction('run-test', undefined, cleanGoal, undefined, testTargets, slug, detectedLanguage));
  }
  if (/\b(?:cli|command line|command-line|commande|console|--help|argumentparser|argparse)\b/iu.test(normalize(cleanGoal)) && languages.includes('Python')) {
    pushStep(items, 'run-cli', 'Run the CLI help check with terminal.run.', taskInstruction('run-cli', undefined, cleanGoal, 'Python', sourceTargets, slug, detectedLanguage));
  }

  if (items.length < 2 || items.length > 20) return undefined;
  // A request that asks for a build without test files still gets one bounded
  // compile stage when the source is C/C++; other build tools remain model-led.
  if (hasBuildOrRunRequest(cleanGoal) && cSources.length && !items.some((item) => item.role.startsWith('compile'))) {
    const outputPath = `build/${slug}${executableExtension()}`;
    const insertAt = items.findIndex((item) => item.role === 'run-test' || item.role === 'run-cli');
    const compileStep: MicroTaskStep = {
      id: 'compile', content: `Compile the C program with compiler.gcc to ${outputPath}.`, dependencies: [], status: 'pending',
      instruction: `Compile with compiler.gcc using sourceFiles=${JSON.stringify(cSources)}, outputExe="${outputPath}", flags=["-Wall"].`, role: 'compile-test',
    };
    const position = insertAt < 0 ? items.length : insertAt;
    items.splice(position, 0, compileStep);
  }

  items.forEach((item, index) => {
    item.id = `s${index + 1}`;
    item.dependencies = index ? [`s${index}`] : [];
    item.status = index ? 'pending' : 'in_progress';
  });
  const clauses = splitClauses(cleanGoal);
  const objective = truncateAtWord(clauses[0] ?? cleanGoal, 240);
  const constraints = requestConstraints(cleanGoal);
  const acceptanceCriteria = [
    `Tous les fichiers demandés du projet ${slug} sont créés ou modifiés dans le workspace.`,
    ...(sharedLibraryRequested ? ['La bibliothèque C est compilée et effectivement chargée par le module Python via ctypes.CDLL.'] : []),
    ...(hasTests ? ['Les tests réellement demandés sont exécutés et retournent un code de sortie nul.'] : []),
    ...(hasReadme && /bib1|citation|source/iu.test(normalize(cleanGoal)) ? ['Le README ne cite que les sources réellement retournées par Bib1.'] : []),
  ];
  return { detectedLanguage, objective, constraints, acceptanceCriteria, items };
}

/** Build the only user content sent for the current feeder stage. */
export function microTaskPrompt(task: DecomposedTask, currentStep: MicroTaskStep | undefined, stepIndex: number, evidence: readonly string[] = []): string {
  void stepIndex; // Progress lives in the plan UI; fractions confuse tiny local models.
  const strings = stringsFor(task.detectedLanguage);
  if (!currentStep) return `<microtask_summary>${strings.objective}: ${task.objective}\nCriteria: ${task.acceptanceCriteria.join(' ; ')}\n${strings.summary}</microtask_summary>`;
  // Keep tiny-model action prompts local to the current step. Repeating the
  // full project objective and unrelated tool results caused 0.6B models to
  // explain the project instead of invoking the one offered tool.
  const selected = currentStep.role === 'documentation'
    ? evidence.filter((item) => item.includes('knowledge.search')).slice(-1)
    : [];
  const escaped = selected.map((item) => item.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;'));
  const prior = escaped.length ? `\n<verified_tool_results trust="untrusted_tool_data">${escaped.join('\n')}</verified_tool_results>` : '';
  return `<microtask role="${currentStep.role}">\n${currentStep.instruction}\n${strings.toolOnly}${prior}</microtask>`;
}

/**
 * Build a file-local generation request for the NeuroKernel code synthesis
 * path. The model supplies source text only; the controller chooses the
 * target and performs the fs.write call through the normal permission path.
 */
export function microTaskCodePrompt(currentStep: MicroTaskStep, evidence: readonly string[] = []): string {
  if (!['source', 'test-source', 'documentation'].includes(currentStep.role)) {
    throw new Error(`L’étape ${currentStep.id} ne correspond pas à une génération de fichier.`);
  }
  const target = pathTargets(currentStep.content)[0];
  if (!target) throw new Error(`L’étape ${currentStep.id} ne fournit pas une cible de fichier unique.`);
  const extension = target.split('.').at(-1)?.toLowerCase() ?? '';
  const language = EXTENSION_LANGUAGE[extension] ?? (extension === 'md' ? 'Markdown' : 'text');
  const selectedEvidence = currentStep.role === 'documentation'
    ? evidence.filter((item) => item.includes('knowledge.search')).slice(-1)
    : [];
  const fileRequirements = currentStep.instruction
    .replace(/\b(?:avec|with|using)\s+fs\.write\b/giu, '')
    .replace(/\b(?:appelle|call|use)\s+fs\.write\b/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const sections = [
    `<artifact path="${target}" language="${language}">`,
    `This file's requirements: ${fileRequirements || currentStep.instruction}`,
    selectedEvidence.length
      ? `<verified_tool_results trust="untrusted_tool_data">${selectedEvidence.join('\n')}</verified_tool_results>`
      : '',
    'Return only the complete contents of this one file. Do not call or describe tools. Do not include markdown fences, explanations, placeholders, or claims that tests passed.',
    '</artifact>',
  ].filter(Boolean);
  return sections.join('\n');
}

export interface PrefixCompletionContract {
  target: string;
  prefix: string;
  suffix: string;
  stop: string[];
  grammar?: string;
  maxTokens: number;
  generatedUnit: string;
  functionName: string;
  parameterNames: string[];
  returnCType?: string;
  parameterCTypes?: string[];
  requiredNativeCall?: string;
  integerAddition?: boolean;
}

export interface DeterministicAcceptanceArtifact {
  content: string;
  description: string;
}

function nativeAddContract(task: DecomposedTask): { pythonName: string; functionName: string; parameters: string[] } | undefined {
  const cStep = task.items.find((item) => item.role === 'source' && /\.c$/iu.test(pathTargets(item.content)[0] ?? ''));
  const pythonStep = task.items.find((item) => item.role === 'source' && /\.py$/iu.test(pathTargets(item.content)[0] ?? ''));
  const testStep = task.items.find((item) => item.role === 'test-source' && /\.py$/iu.test(pathTargets(item.content)[0] ?? ''));
  const hasNativeBuild = task.items.some((item) => item.role === 'compile-library');
  const hasTests = task.items.some((item) => item.role === 'run-test');
  if (!cStep || !pythonStep || !testStep || !hasNativeBuild || !hasTests) return undefined;
  const contractText = task.items.map((item) => item.instruction).join('\n');
  if (!/ctypes/i.test(contractText) || !/argparse/i.test(contractText) || !/19\s*\+\s*23/u.test(contractText)
    || !/-7\s*\+\s*3/u.test(contractText) || !/0\s*\+\s*0/u.test(contractText)) return undefined;
  const cSignature = contractText.match(/\bint\s+(engine_[A-Za-z_]\w*)\s*\(\s*int\s+([A-Za-z_]\w*)\s*,\s*int\s+([A-Za-z_]\w*)\s*\)/u);
  const pythonName = pythonStep.instruction.match(/\b(?:fournit|provides|exposes?)\s+[`'“"]?([A-Za-z_]\w*)/iu)?.[1];
  if (!cSignature || !pythonName || !/add/iu.test(cSignature[1]!)) return undefined;
  return { functionName: cSignature[1]!, parameters: [cSignature[2]!, cSignature[3]!], pythonName };
}

interface ExplicitCFunctionContract {
  signature: string;
  returnCType: string;
  functionName: string;
  parameters: Array<{ cType: string; name: string }>;
}

function explicitCFunctionContract(task: DecomposedTask): ExplicitCFunctionContract | undefined {
  const contracts = task.items.map((item) => item.instruction).join('\n');
  const returnTypePattern = '(?:unsigned\\s+|signed\\s+)?(?:int|void|char|short|long|float|double|size_t|uint\\d+_t|int\\d+_t)';
  // Accept an explicitly declared ABI even when the request says "declares"
  // instead of "exports". The complete typed signature and unique-declaration
  // check remain mandatory before the controller creates any scaffold.
  const signaturePattern = new RegExp(`(?:\\b(?:exports?|exporte|exportent|ABI|signature)\\s+)?(${returnTypePattern}\\s+[A-Za-z_]\\w*\\s*\\([^)]*\\))`, 'giu');
  const declarations = [...contracts.replace(/`/gu, '').matchAll(signaturePattern)].map((match) => match[1]!
    .replace(/\s+/gu, ' ').replace(/\s*\*\s*/gu, ' *').trim());
  const uniqueDeclarations = [...new Set(declarations)];
  if (uniqueDeclarations.length !== 1) return undefined;
  const signature = uniqueDeclarations[0]!;
  const parsed = signature.match(new RegExp(`^(${returnTypePattern})\\s+([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)$`, 'u'));
  if (!parsed) return undefined;
  const scalarType = '(?:unsigned\\s+int|signed\\s+int|int|unsigned\\s+long|signed\\s+long|long|unsigned\\s+short|signed\\s+short|short|size_t|uint\\d+_t|int\\d+_t)';
  const pointerType = '(?:const\\s+)?(?:void|unsigned\\s+char|signed\\s+char|char|uint\\d+_t|int\\d+_t)\\s*\\*';
  const parameters = parsed[3]!.split(',').map((part) => {
    const declaration = part.trim().replace(/\s*\*\s*/gu, ' *');
    const value = declaration.match(new RegExp(`^(${pointerType})\\s*([A-Za-z_]\\w*)$`, 'u'))
      ?? declaration.match(new RegExp(`^(${scalarType})\\s+([A-Za-z_]\\w*)$`, 'u'));
    return value ? { cType: value[1]!.replace(/\s+/gu, ' ').trim(), name: value[2]! } : undefined;
  });
  if (parameters.length < 1 || parameters.length > 4 || parameters.some((parameter) => !parameter)
    || /\bvoid\b/u.test(parsed[1]!)) return undefined;
  return {
    signature, returnCType: parsed[1]!.replace(/\s+/gu, ' ').trim(), functionName: parsed[2]!,
    parameters: parameters as Array<{ cType: string; name: string }>,
  };
}

function firstCrcPolynomial(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const output = value as Record<string, unknown>;
  const records = Array.isArray(output.citations) ? output.citations : Array.isArray(output.results) ? output.results : [];
  for (const candidate of records) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const context = [output.context, record.title, record.label, record.path, record.absolute_path, record.body, record.content, record.text]
      .filter((part): part is string => typeof part === 'string').join(' ');
    if (!/crc\s*-?\s*32|iso[- ]hdlc|zlib|binascii/iu.test(context)) continue;
    const polynomial = context.match(/\b0x(?:EDB88320|04C11DB7)\b/iu)?.[0];
    if (polynomial) return polynomial.toUpperCase();
  }
  return undefined;
}

function cPrefixContractComment(currentStep: MicroTaskStep, knowledgeSearchResult?: unknown): string {
  const requirements = currentStep.instruction.match(/(?:Exigences|Requirements|Requisitos)\s*:\s*([\s\S]*?)(?:\n(?:Respecte|Follow|Respeta)\b|$)/iu)?.[1]
    ?.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim() ?? '';
  const hints: string[] = [];
  if (/crc\s*-?\s*32/iu.test(requirements)) hints.push('Implement CRC-32/ISO-HDLC.');
  if (/zlib\.crc32|increm|incremental/iu.test(requirements)) hints.push('Match zlib.crc32(data, seed), including incremental updates.');
  if (/vide|empty|longueur.{0,12}zero|length.{0,12}zero/iu.test(requirements)) hints.push('For zero length, return the seed unchanged.');
  if (/123456789[\s\S]{0,50}(?:CBF43926|cbf43926)|(?:CBF43926|cbf43926)[\s\S]{0,50}123456789/iu.test(requirements)) hints.push('Check vector: 123456789 -> 0xCBF43926.');
  const polynomial = firstCrcPolynomial(knowledgeSearchResult);
  if (polynomial === '0XEDB88320') hints.push('Bib1 reference: reflected polynomial 0xEDB88320.');
  if (!hints.length && requirements) hints.push(requirements.slice(0, 520).replace(/\*\//gu, '* /'));
  return hints.length ? `/* ${hints.join(' ')} */\n` : '';
}

function firstBib1Citation(value: unknown): { title: string; path: string; line: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const output = value as Record<string, unknown>;
  const records = Array.isArray(output.citations) ? output.citations
    : Array.isArray(output.results) ? output.results : [];
  for (const candidate of records) {
    if (!candidate || typeof candidate !== 'object') continue;
    const citation = candidate as Record<string, unknown>;
    const title = typeof citation.title === 'string' ? citation.title.trim()
      : typeof citation.label === 'string' ? citation.label.trim() : '';
    const sourcePath = typeof citation.path === 'string' ? citation.path.trim()
      : typeof citation.absolute_path === 'string' ? citation.absolute_path.trim() : '';
    const body = typeof citation.body === 'string' ? citation.body : '';
    const line = Number(citation.line);
    if (title && sourcePath && /(?:ctypes|CDLL|argtypes|restype)/iu.test(`${title} ${sourcePath} ${body}`)
      && Number.isSafeInteger(line) && line > 0) return { title, path: sourcePath, line };
  }
  return undefined;
}

/** Resolve a project-root-relative library from a Python source file at any depth. */
function pythonProjectRootExpression(sourcePath: string): string {
  const directoryDepth = sourcePath.replace(/\\/gu, '/').split('/').slice(0, -1).length;
  return directoryDepth === 0
    ? 'Path(__file__).resolve().parent'
    : `Path(__file__).resolve().parents[${directoryDepth}]`;
}

/**
 * Produce a small, mechanically exact acceptance harness or README only when
 * the request explicitly describes this native Python/C addition contract.
 * The implementation remains model-authored; tests and citations do not.
 */
export function microTaskDeterministicAcceptanceArtifact(
  task: DecomposedTask,
  currentStep: MicroTaskStep,
  knowledgeSearchResult?: unknown,
): DeterministicAcceptanceArtifact | undefined {
  const target = currentStep.role === 'source' ? pathTargets(currentStep.content)[0] : undefined;
  const cFunction = explicitCFunctionContract(task);
  if (target && cFunction && /\.(?:h|hpp|hxx)$/iu.test(target)) {
    const guard = `MAZZ_${cFunction.functionName.toUpperCase()}_H`;
    return {
      description: 'déclaration C générée depuis la signature ABI explicitement fournie',
      content: [
        `#ifndef ${guard}`,
        `#define ${guard}`,
        '',
        '#include <stddef.h>',
        '#include <stdint.h>',
        '',
        '#ifdef __cplusplus',
        'extern "C" {',
        '#endif',
        '',
        `${cFunction.signature};`,
        '',
        '#ifdef __cplusplus',
        '}',
        '#endif',
        '',
        '#endif',
        '',
      ].join('\n'),
    };
  }
  const contract = nativeAddContract(task);
  if (!contract) return undefined;
  if (currentStep.role === 'source' && /\.py$/iu.test(pathTargets(currentStep.content)[0] ?? '')) {
    const target = pathTargets(currentStep.content)[0];
    if (!target) return undefined;
    const library = task.items.find((item) => item.role === 'compile-library')?.instruction.match(/outputExe=("(?:\\.|[^"\\])*")/u)?.[1];
    if (!library) return undefined;
    let libraryPath: unknown;
    try { libraryPath = JSON.parse(library); } catch { return undefined; }
    if (typeof libraryPath !== 'string' || libraryPath.split(/[\\/]/u).includes('..')) return undefined;
    return {
      description: 'liaison ctypes et CLI générées depuis l’ABI C explicitement demandée',
      content: [
        'import argparse',
        'import ctypes',
        'from pathlib import Path',
        '',
        `_engine = ctypes.CDLL(str(${pythonProjectRootExpression(pathTargets(currentStep.content)[0] ?? '')} / ${JSON.stringify(libraryPath)}))`,
        `_engine.${contract.functionName}.argtypes = [ctypes.c_int, ctypes.c_int]`,
        `_engine.${contract.functionName}.restype = ctypes.c_int`,
        '',
        `def ${contract.pythonName}(${contract.parameters.join(': int, ')}: int) -> int:`,
        `    return int(_engine.${contract.functionName}(${contract.parameters.join(', ')}))`,
        '',
        'def main() -> int:',
        '    parser = argparse.ArgumentParser(description="Call the native C engine.")',
        `    command = parser.add_subparsers(dest="command", required=True).add_parser(${JSON.stringify(contract.pythonName)})`,
        ...contract.parameters.map((parameter) => `    command.add_argument(${JSON.stringify(parameter)}, type=int)`),
        '    options = parser.parse_args()',
        `    print(${contract.pythonName}(${contract.parameters.map((parameter) => `options.${parameter}`).join(', ')}))`,
        '    return 0',
        '',
        'if __name__ == "__main__":',
        '    raise SystemExit(main())',
        '',
      ].join('\n'),
    };
  }
  if (currentStep.role === 'test-source') {
    const target = pathTargets(currentStep.content)[0];
    if (!target?.endsWith('.py')) return undefined;
    const pythonSource = task.items.find((item) => item.role === 'source' && /\.py$/iu.test(pathTargets(item.content)[0] ?? ''));
    const moduleName = pathTargets(pythonSource?.content ?? 'app.py').at(-1)?.replace(/\.py$/iu, '') ?? 'app';
    return {
      description: 'jeu de tests déterministe fondé sur les trois vecteurs explicites du contrat',
      content: [
        'import unittest',
        `from ${moduleName} import ${contract.pythonName}`,
        '',
        'class NativeAddTests(unittest.TestCase):',
        '    def test_add_vectors_through_the_native_library(self) -> None:',
        `        cases = ((19, 23, 42), (-7, 3, -4), (0, 0, 0))`,
        '        for left, right, expected in cases:',
        '            with self.subTest(left=left, right=right):',
        `                self.assertEqual(${contract.pythonName}(left, right), expected)`,
        '',
        "if __name__ == '__main__':",
        '    unittest.main()',
        '',
      ].join('\n'),
    };
  }
  if (currentStep.role === 'documentation') {
    const target = pathTargets(currentStep.content)[0];
    if (!target?.toLowerCase().endsWith('readme.md')) return undefined;
    const cTarget = pathTargets(task.items.find((item) => item.role === 'source' && /\.c$/iu.test(pathTargets(item.content)[0] ?? '') )?.content ?? '')[0] ?? 'engine.c';
    const pythonTarget = pathTargets(task.items.find((item) => item.role === 'source' && /\.py$/iu.test(pathTargets(item.content)[0] ?? '') )?.content ?? '')[0] ?? 'app.py';
    const library = task.items.find((item) => item.role === 'compile-library')?.instruction.match(/outputExe=("(?:\\.|[^"\\])*")/u)?.[1];
    let libraryPath = 'build/engine.dll';
    try { if (library) libraryPath = JSON.parse(library) as string; } catch { /* use the declared fixture path */ }
    const citation = firstBib1Citation(knowledgeSearchResult);
    const citationText = citation
      ? `Bib1 — “${citation.title}”, ${citation.path}, ligne ${citation.line}.`
      : 'Bib1 : aucune source avec chemin et ligne vérifiables n’a été retournée pour la recherche ctypes.';
    return {
      description: 'README généré depuis les commandes et chemins d’acceptation vérifiables',
      content: [
        '# NativeAdd',
        '',
        'Petit exemple Windows où le moteur C réalise l’addition et Python le charge réellement avec `ctypes`.',
        '',
        '## Construire et vérifier',
        '',
        'Depuis la racine du projet avec GCC et Python installés :',
        '',
        '```powershell',
        'New-Item -ItemType Directory -Force build | Out-Null',
        `gcc -Wall -shared ${cTarget} -o ${libraryPath}`,
        `gcc -Wall -DENGINE_SMOKE ${cTarget} -o build/engine_smoke.exe`,
        'python -m unittest discover -s tests -v',
        '& .\\build\\engine_smoke.exe',
        '```',
        '',
        '## Utiliser',
        '',
        '```powershell',
        `python ${pythonTarget} --help`,
        `python ${pythonTarget} add 19 23`,
        '```',
        '',
        'La dernière commande affiche `42`. La fonction Python appelle le symbole exporté du moteur natif; elle ne recalcule pas l’addition.',
        '',
        '## Source Bib1',
        '',
        citationText,
        '',
      ].join('\n'),
    };
  }
  return undefined;
}

/** Check semantic requirements that a syntax-only compiler cannot prove. */
export function validatePrefixImplementation(body: string, contract: PrefixCompletionContract): string | undefined {
  const isPython = contract.target.toLowerCase().endsWith('.py');
  const isC = /\.(?:c|cc|cpp|cxx)$/iu.test(contract.target);
  const code = isPython
    ? body.replace(/#[^\r\n]*/gu, '')
    : body.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\r\n]*/gu, '');
  if (isC) {
    const escapedName = contract.functionName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`\\b${escapedName}\\s*\\(`, 'u').test(code)) {
      return `Le corps appelle récursivement ${contract.functionName}; implémente son opération sans rappeler cette fonction.`;
    }
    if (contract.integerAddition) {
      const first = contract.parameterNames[0]?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const second = contract.parameterNames[1]?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const expression = code.trim().replace(/;\s*$/u, '');
      if (!first || !second || !new RegExp(`^(?:${first}\\s*\\+\\s*${second}|${second}\\s*\\+\\s*${first})$`, 'u').test(expression)) {
        return `Complète seulement l’expression ${contract.parameterNames.join(' + ')} après return; n’ajoute ni return, ni appel à ${contract.functionName}.`;
      }
    }
  }
  if (contract.requiredNativeCall) {
    const compactCode = code.replace(/\s+/gu, '');
    const compactCall = contract.requiredNativeCall.replace(/\s+/gu, '');
    if (!compactCode.includes(compactCall) || !/\breturn\s+_engine\./u.test(code)) {
      return `Le wrapper Python doit retourner l’appel natif ${contract.requiredNativeCall}; aucun calcul de remplacement en Python n’est autorisé.`;
    }
  }
  return undefined;
}

/**
 * Make a code-only prefix contract when the request declares an unambiguous C
 * function ABI. The host owns imports, exports and CLI/test scaffolding; the
 * model is responsible for the implementation body inserted between them.
 */
export function microTaskPrefixContract(task: DecomposedTask, currentStep: MicroTaskStep, knowledgeSearchResult?: unknown): PrefixCompletionContract | undefined {
  if (currentStep.role !== 'source') return undefined;
  const target = pathTargets(currentStep.content)[0];
  if (!target) return undefined;
  const extension = target.split('.').at(-1)?.toLowerCase();
  const contracts = task.items.map((item) => item.instruction).join('\n');
  const cFunction = explicitCFunctionContract(task);
  if (!cFunction) return undefined;
  const { signature, returnCType, functionName, parameters } = cFunction;

  if (['c', 'cc', 'cpp', 'cxx'].includes(extension ?? '')) {
    const header = task.items
      .map((item) => pathTargets(item.content)[0])
      .find((candidate) => candidate?.endsWith('.h') && candidate.replace(/\\/g, '/').replace(/[^/]+$/u, '') === target.replace(/\\/g, '/').replace(/[^/]+$/u, ''));
    const headerInclude = header ? `#include "${header.split('/').at(-1)}"\n` : '';
    const integerAddition = parameters.length === 2 && returnCType === 'int'
      && /add$/iu.test(functionName) && parameters.every((parameter) => parameter.cType === 'int');
      const prefix = [
      headerInclude.trimEnd(),
      '#include <stdint.h>',
      '#include <stddef.h>',
      ...(contracts.includes('ENGINE_SMOKE') ? ['#include <stdio.h>'] : []),
      '#if defined(_WIN32)',
      '#define MAZZ_EXPORT __declspec(dllexport)',
      '#else',
      '#define MAZZ_EXPORT',
      '#endif',
      '',
      cPrefixContractComment(currentStep, knowledgeSearchResult).trimEnd(),
      `MAZZ_EXPORT ${signature} {`,
        ...(integerAddition
          ? [`    /* Return the sum of ${parameters[0]!.name} and ${parameters[1]!.name}; do not call ${functionName}. */`, '    return ']
          : ['']),
      ].filter(Boolean).join('\n') + (integerAddition ? '' : '\n');
    const smoke = contracts.includes('ENGINE_SMOKE') && /19\s*\+\s*23\s*=\s*42/u.test(contracts)
      ? `\n#ifdef ENGINE_SMOKE\nint main(void) {\n    if (${functionName}(19, 23) != 42) return 1;\n    puts("C_OK");\n    return 0;\n}\n#endif\n`
      : '';
    return {
      target, prefix, suffix: integerAddition ? `;\n}\n${smoke}` : `\n}\n${smoke}`,
      stop: integerAddition ? [';', '<|im_end|>'] : ['\n}\n', '<|im_end|>'], maxTokens: integerAddition ? 32 : 256,
      ...(integerAddition ? { grammar: `root ::= "${parameters[0]!.name} + ${parameters[1]!.name}" | "${parameters[1]!.name} + ${parameters[0]!.name}"` } : {}),
      generatedUnit: functionName, functionName, parameterNames: parameters.map((parameter) => parameter.name),
      returnCType, parameterCTypes: parameters.map((parameter) => parameter.cType),
      integerAddition,
    };
  }

  if (extension === 'py' && contracts.includes('ctypes') && /\b(?:argparse|CLI|ligne de commande)\b/iu.test(contracts)) {
    if (parameters.some((parameter) => parameter.cType.includes('*'))) return undefined;
    const libraryPath = task.items.find((item) => item.role === 'compile-library')?.instruction.match(/\boutputExe=("(?:\\.|[^"\\])*")/u)?.[1];
    if (!libraryPath) return undefined;
    let relativeLibrary: unknown;
    try { relativeLibrary = JSON.parse(libraryPath); } catch { return undefined; }
    if (typeof relativeLibrary !== 'string' || relativeLibrary.split(/[\\/]/u).includes('..')) return undefined;
    const pythonName = contracts.match(/\b(?:fournit|provides|exposes?)\s+[`'" ]?([A-Za-z_]\w*)/iu)?.[1] ?? functionName;
    const args = parameters;
    const ctypesType = (cType: string): string => cType === 'int' ? 'ctypes.c_int'
      : cType === 'unsigned int' ? 'ctypes.c_uint'
        : cType === 'long' ? 'ctypes.c_long'
          : cType === 'unsigned long' ? 'ctypes.c_ulong'
            : cType === 'short' ? 'ctypes.c_short'
              : cType === 'unsigned short' ? 'ctypes.c_ushort'
      : cType === 'size_t' ? 'ctypes.c_size_t'
                : cType.startsWith('uint') ? `ctypes.c_uint${cType.match(/\d+/u)?.[0]}`
                  : `ctypes.c_int${cType.match(/\d+/u)?.[0]}`;
    const prefix = [
      'import argparse',
      'import ctypes',
      'from pathlib import Path',
      '',
      `_engine = ctypes.CDLL(str(${pythonProjectRootExpression(target)} / ${JSON.stringify(relativeLibrary).replace(/\\/g, '\\\\')}))`,
      `_engine.${functionName}.argtypes = [${args.map((argument) => ctypesType(argument.cType)).join(', ')}]`,
      `_engine.${functionName}.restype = ${ctypesType(returnCType)}`,
      '',
      `def ${pythonName}(${args.map((argument) => `${argument.name}: int`).join(', ')}) -> int:`,
      '',
    ].join('\n') + '\n';
    const suffix = [
      '',
      'def main() -> int:',
      '    parser = argparse.ArgumentParser(description="Call the native C engine.")',
      `    command = parser.add_subparsers(dest="command", required=True).add_parser(${JSON.stringify(pythonName)})`,
      ...args.map((argument) => `    command.add_argument(${JSON.stringify(argument.name)}, type=int)`),
      '    options = parser.parse_args()',
      `    print(${pythonName}(${args.map((argument) => `options.${argument.name}`).join(', ')}))`,
      '    return 0',
      '',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
      '',
    ].join('\n');
    return {
      target, prefix, suffix, stop: ['\n\n', '<|im_end|>'], maxTokens: 96, generatedUnit: pythonName,
      functionName, parameterNames: args.map((argument) => argument.name),
      returnCType, parameterCTypes: args.map((argument) => argument.cType),
      requiredNativeCall: `_engine.${functionName}(${args.map((argument) => argument.name).join(', ')})`,
    };
  }
  return undefined;
}

function pathTargets(text: string): string[] {
  const matches = text.match(/(?:[\p{L}\p{N}_.-]+[\\/][\p{L}\p{N}_.-]+|[\p{L}\p{N}_.-]+\.[\p{L}]{1,8})/gu) ?? [];
  return [...new Set(matches.map((value) => value.replace(/\\/g, '/')).filter((value) => !value.startsWith('fs.')))];
}
