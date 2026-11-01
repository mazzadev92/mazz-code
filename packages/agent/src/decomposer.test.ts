import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  decomposeTask, microTaskCodePrompt, microTaskDeterministicAcceptanceArtifact, microTaskPrefixContract, microTaskPrompt,
  validatePrefixImplementation,
} from './decomposer.js';

const crcProjectRequest = `Monte dans le workspace un petit projet vraiment utilisable : une commande Python qui calcule le CRC-32/ISO-HDLC d'un ou plusieurs fichiers, et un cœur en C chargé par Python avec ctypes. La lecture des gros fichiers doit se faire par blocs de 64 Kio, sans charger tout le fichier en mémoire. Le résultat Python doit être compatible avec zlib.crc32(data, seed). Ajoute un README court, des tests unittest Python pour les vecteurs vide et « 123456789 » (résultat attendu CBF43926), le calcul incrémental sur plusieurs blocs et un fichier binaire temporaire, puis un petit test C compilable. Avant d'implémenter, vérifie dans Bib1 les paramètres CRC-32 de référence et garde une citation de la source trouvée dans le README; si Bib1 ne la trouve pas, dis-le clairement au lieu d'inventer une source. Explore d'abord ce workspace vide et l'outillage disponible. Crée uniquement les fichiers nécessaires, compile réellement la DLL et le test C, lance les tests Python et le CLI, puis corrige tout échec avant de conclure. N'écris que dans ce workspace, ne supprime rien et garde le projet compact.`;

test('le décomposeur construit une file déterministe pour un projet Python+C multi-artifact', () => {
  const task = decomposeTask(crcProjectRequest);
  assert.ok(task);
  assert.equal(task.detectedLanguage, 'fr');
  assert.equal(task.items[0]?.role, 'inspect');
  assert.equal(task.items.some((item) => item.role === 'research' && item.content.includes('knowledge.search')), true);
  assert.equal(task.items.some((item) => item.content.includes('src/crc32.c')), true);
  assert.equal(task.items.some((item) => item.content.includes('src/crc32.py')), true);
  assert.equal(task.items.some((item) => item.content.includes('tests/test_crc32.py')), true);
  assert.equal(task.items.some((item) => item.content.includes('tests/crc32_smoke.c')), true);
  assert.equal(task.items.some((item) => item.content.includes('README.md')), true);
  assert.match(task.items.find((item) => item.role === 'research')?.instruction ?? '', /Topic: Python zlib binascii crc32 API seed incremental CRC-32 ISO-HDLC check 123456789/u);
  const sharedExtension = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
  const executableExtension = process.platform === 'win32' ? '.exe' : '';
  assert.equal(task.items.some((item) => item.role === 'compile-library' && item.content.includes(`build/crc32${sharedExtension}`)), true);
  assert.equal(task.items.some((item) => item.role === 'run-integration'), true);
  assert.equal(task.items.some((item) => item.role === 'compile-test' && item.content.includes(`build/crc32_smoke${executableExtension}`)), true);
  assert.equal(task.items.some((item) => item.role === 'run-test'), true);
  assert.equal(task.items.some((item) => item.role === 'run-cli'), true);
  const runTestInstruction = task.items.find((item) => item.role === 'run-test')?.instruction ?? '';
  assert.match(runTestInstruction, process.platform === 'win32'
    ? /command="python -m unittest discover -s tests -v;/u
    : /command="python3 -m unittest discover -s tests -v && \.\/build\/crc32_smoke"/u);
  assert.match(task.items.find((item) => item.role === 'run-cli')?.instruction ?? '', /command="python \\"src\/crc32\.py\\" --help"/u);
  const integration = task.items.find((item) => item.role === 'run-integration');
  assert.ok(integration);
  const compileIndex = task.items.findIndex((item) => item.role === 'compile-library');
  const integrationIndex = task.items.findIndex((item) => item.role === 'run-integration');
  const testIndex = task.items.findIndex((item) => item.role === 'run-test');
  assert.ok(compileIndex < integrationIndex && integrationIndex < testIndex, 'le chargement ctypes est vérifié après compilation et avant les tests');
  const integrationCommandJson = integration.instruction.match(/\bcommand=("(?:\\.|[^"\\])*")/u)?.[1];
  assert.ok(integrationCommandJson);
  const integrationCommand = JSON.parse(integrationCommandJson) as string;
  assert.match(integrationCommand, /python -c "import ctypes, runpy, sys; from pathlib import Path; ns=runpy\.run_path\('src\/crc32\.py'\)/u);
  assert.match(integrationCommand, /isinstance\(value, ctypes\.CDLL\)/u);
  assert.ok(integrationCommand.includes(`expected=Path('build/crc32${sharedExtension}').resolve()`));
  assert.ok(integration.instruction.includes(`ctypes.CDLL charge précisément build/crc32${sharedExtension}`));
  assert.match(integrationCommand, /MAZZ_NATIVE_LOAD_OK/u);
  assert.ok(task.items.length <= 20);
  assert.equal(task.items[0]?.status, 'in_progress');
  assert.ok(task.items.slice(1).every((item) => item.status === 'pending'));
  assert.ok(task.items.slice(1).every((item, index) => item.dependencies.includes(task.items[index]?.id ?? 'missing')));

  const sourcePrompt = microTaskPrompt(task, task.items[2], 2);
  assert.match(sourcePrompt, /src\/crc32\.c/);
  assert.ok(sourcePrompt.length < crcProjectRequest.length);
  assert.equal(sourcePrompt.includes('tests/test_crc32.py'), false);
  assert.equal(sourcePrompt.includes('Objectif:'), false, 'une micro-tâche n’injecte pas l’objectif complet au modèle');
  assert.doesNotMatch(sourcePrompt, /\b\d+\/\d+\b/u, 'un compteur fractionnaire ne ressemble pas à une demande de calcul');
  assert.match(sourcePrompt, /N’ajoute aucune explication/u);
});

test('la synthèse de code envoie des exigences locales au fichier sans répéter le projet entier', () => {
  const goal = 'Crée un projet Python et C dans le workspace avec src/crc32.h, src/crc32.c, src/crc32.py, tests/test_crc32.py et README.md. Le cœur C exporte crc32_update(uint32_t seed, const void *data, size_t length). Le résultat respecte zlib.crc32(data, seed), y compris les mises à jour incrémentales. Les tests couvrent 123456789 -> CBF43926 et les fichiers sont vérifiés avec GCC et Python.';
  const task = decomposeTask(goal);
  assert.ok(task);
  const header = task.items.find((item) => item.role === 'source' && item.content.includes('src/crc32.h'));
  assert.ok(header);
  const prompt = microTaskCodePrompt(header);
  assert.match(prompt, /src\/crc32\.h/u);
  assert.match(prompt, /crc32_update\(uint32_t seed/u);
  assert.doesNotMatch(prompt, /Project objective:|Acceptance criteria:|Related source and test contracts/u);
  assert.doesNotMatch(prompt, /tests\/test_crc32\.py|README\.md/u);
  assert.ok(prompt.length < 900, `prompt en-tête concis attendu, obtenu ${prompt.length} caractères`);
});

test('les micro-tâches Python gardent les exigences complètes au lieu de les couper au milieu d’une phrase', () => {
  const request = 'Crée un petit programme Python et C complet dans le workspace. Fichiers : src/crc32_engine.c, src/crc32.py, tests/test_crc32.py et README.md. Le moteur C exporte crc32_update(uint32_t seed, const unsigned char *data, size_t length) et respecte zlib.crc32(data, seed). Le module Python charge build/crc32_engine.dll avec ctypes, lit chaque fichier par blocs de 65536 octets et affiche pour chaque fichier son nom et un CRC hexadécimal sur 8 chiffres. Ajoute les tests unittest et compile puis vérifie le programme avec GCC et Python.';
  const task = decomposeTask(request);
  assert.ok(task);
  const pythonStep = task.items.find((item) => item.role === 'source' && item.content === 'Create src/crc32.py with fs.write.');
  assert.ok(pythonStep);
  assert.match(pythonStep.instruction, /son nom et un CRC hexadécimal sur 8 chiffres\./u);
  assert.doesNotMatch(pythonStep.instruction, /pour chaque\s*$/u);
});

test('le contrat de préfixe scaffold l’ABI C, le wrapper ctypes et les vérifications exactes NativeAdd', () => {
  const request = 'Crée un petit projet « NativeAdd » Python+C dans ce workspace. Contrat : `engine.c` exporte `int engine_add(int left, int right)` pour ctypes et, avec `ENGINE_SMOKE`, inclut un `main` qui vérifie 19+23=42 puis imprime `C_OK`. `app.py` charge réellement `build/engine.dll` avec ctypes, fournit `add` et une CLI argparse (`python app.py add 19 23` affiche 42). `tests/test_app.py` vérifie 19+23, -7+3 et 0+0 par la bibliothèque native. `README.md` donne les commandes d’usage. Avant d’écrire, appelle knowledge.search dans Bib1 pour `Python ctypes CDLL argtypes restype`; cite une source et une ligne réellement retournées dans README, ou indique qu’aucune n’a été trouvée. Utilise fs.list, fs.write, compiler.gcc et terminal.run. Compile `build/engine.dll` en bibliothèque partagée, puis `build/engine_smoke.exe` depuis engine.c avec `-DENGINE_SMOKE`. Lance unittest, le smoke C et la CLI `--help` puis `add 19 23`. Corrige les erreurs à partir des sorties réelles des outils.';
  const task = decomposeTask(request);
  assert.ok(task);
  const cStep = task.items.find((item) => item.role === 'source' && item.content.includes('engine.c'));
  const pythonStep = task.items.find((item) => item.role === 'source' && item.content.includes('app.py'));
  assert.ok(cStep);
  assert.ok(pythonStep);
  const cPrefix = microTaskPrefixContract(task, cStep);
  const pythonPrefix = microTaskPrefixContract(task, pythonStep);
  assert.ok(cPrefix);
  assert.ok(pythonPrefix);
  assert.equal(cPrefix.functionName, 'engine_add');
  assert.deepEqual(cPrefix.parameterNames, ['left', 'right']);
  assert.equal(cPrefix.integerAddition, true);
  assert.equal(cPrefix.grammar, 'root ::= "left + right" | "right + left"');
  assert.match(cPrefix.prefix, /return $/u);
  assert.equal(pythonPrefix.requiredNativeCall, '_engine.engine_add(left, right)');
  assert.match(cPrefix.prefix, /MAZZ_EXPORT int engine_add\(int left, int right\) \{/u);
  assert.match(cPrefix.suffix, /ENGINE_SMOKE[\s\S]*C_OK/u);
  assert.deepEqual(cPrefix.stop, [';', '<|im_end|>']);
  assert.match(pythonPrefix.prefix, /ctypes\.CDLL[\s\S]*engine_add\.argtypes[\s\S]*def add\(left: int, right: int\) -> int:/u);
  assert.match(pythonPrefix.suffix, /argparse[\s\S]*add_argument[\s\S]*raise SystemExit/u);
  assert.deepEqual(pythonPrefix.stop, ['\n\n', '<|im_end|>']);
  assert.match(task.items.find((item) => item.role === 'research')?.instruction ?? '', /Topic: Python ctypes CDLL argtypes restype/u);
  const unquotedResearchTask = decomposeTask(request.replace('pour `Python ctypes CDLL argtypes restype`', 'les détails Python ctypes CDLL argtypes restype'));
  assert.ok(unquotedResearchTask);
  assert.match(unquotedResearchTask.items.find((item) => item.role === 'research')?.instruction ?? '', /Topic: Python ctypes CDLL argtypes restype/u);
  assert.match(task.items.find((item) => item.role === 'compile-test')?.instruction ?? '', /flags=\["-Wall","-DENGINE_SMOKE"\]/u);
  assert.match(task.items.find((item) => item.role === 'run-cli')?.instruction ?? '', /app\.py.*add 19 23.*42/u);
  const cliInstruction = task.items.find((item) => item.role === 'run-cli')?.instruction ?? '';
  const cliCommandJson = cliInstruction.match(/\bcommand=("(?:\\.|[^"\\])*")/u)?.[1];
  assert.ok(cliCommandJson);
  assert.match(JSON.parse(cliCommandJson) as string, /Write-Error "Valeur attendue 42 absente\."/u);

  assert.match(validatePrefixImplementation('return engine_add(left, right);', cPrefix) ?? '', /récursivement/u);
  assert.match(validatePrefixImplementation('return left + right;', cPrefix) ?? '', /Complète seulement l’expression/u);
  assert.equal(validatePrefixImplementation('left + right', cPrefix), undefined);
  assert.match(validatePrefixImplementation('return left + right', pythonPrefix) ?? '', /appel natif _engine\.engine_add/u);
  assert.equal(validatePrefixImplementation('return _engine.engine_add(left, right)', pythonPrefix), undefined);

  const testStep = task.items.find((item) => item.role === 'test-source');
  const docsStep = task.items.find((item) => item.role === 'documentation');
  assert.ok(pythonStep);
  assert.ok(testStep);
  assert.ok(docsStep);
  const pythonArtifact = microTaskDeterministicAcceptanceArtifact(task, pythonStep);
  assert.match(pythonArtifact?.content ?? '', /ctypes\.CDLL[\s\S]*engine_add\.argtypes[\s\S]*engine_add\.restype/u);
  assert.match(pythonArtifact?.content ?? '', /Path\(__file__\)\.resolve\(\)\.parent \/ "build\/engine\.dll"/u);
  assert.match(pythonArtifact?.content ?? '', /return int\(_engine\.engine_add\(left, right\)\)/u);
  assert.doesNotMatch(pythonArtifact?.content ?? '', /return left \+ right/u);
  assert.match(pythonArtifact?.content ?? '', /argparse[\s\S]*add_argument[\s\S]*raise SystemExit/u);
  const testArtifact = microTaskDeterministicAcceptanceArtifact(task, testStep);
  assert.match(testArtifact?.content ?? '', /from app import add/u);
  assert.match(testArtifact?.content ?? '', /\(19, 23, 42\), \(-7, 3, -4\), \(0, 0, 0\)/u);
  assert.match(testArtifact?.content ?? '', /self\.assertEqual\(add\(left, right\), expected\)/u);
  const citedReadme = microTaskDeterministicAcceptanceArtifact(task, docsStep, {
    citations: [{ title: 'ctypes — Python interface', path: 'Programming/ctypes.md', line: 42, body: 'CDLL argtypes restype' }],
  });
  assert.match(citedReadme?.content ?? '', /ctypes — Python interface.*Programming\/ctypes\.md, ligne 42/u);
  assert.match(citedReadme?.content ?? '', /python app\.py add 19 23/u);
  const uncitedReadme = microTaskDeterministicAcceptanceArtifact(task, docsStep, { citations: [] });
  assert.match(uncitedReadme?.content ?? '', /aucune source avec chemin et ligne vérifiables/u);

  const nestedTask = decomposeTask(request.replace('`engine.c`', '`src/engine.c`').replace('`app.py`', '`src/app.py`'));
  assert.ok(nestedTask);
  const nestedPythonStep = nestedTask.items.find((item) => item.role === 'source' && item.content.includes('src/app.py'));
  assert.ok(nestedPythonStep);
  const nestedPrefix = microTaskPrefixContract(nestedTask, nestedPythonStep);
  assert.match(nestedPrefix?.prefix ?? '', /Path\(__file__\)\.resolve\(\)\.parents\[1\] \/ "build\/engine\.dll"/u);
  const nestedArtifact = microTaskDeterministicAcceptanceArtifact(nestedTask, nestedPythonStep);
  assert.match(nestedArtifact?.content ?? '', /Path\(__file__\)\.resolve\(\)\.parents\[1\] \/ "build\/engine\.dll"/u);
});

test('le contrat CRC32 borne une ABI pointeur et injecte seulement le résultat Bib1 vérifiable', () => {
  const goal = `${crcProjectRequest} Les fichiers ABI sont src/crc32.h et src/crc32.c. L’ABI publique est uint32_t crc32_update(uint32_t seed, const void *data, size_t length).`;
  const task = decomposeTask(goal);
  assert.ok(task);
  const headerStep = task.items.find((item) => item.role === 'source' && item.content.includes('src/crc32.h'));
  const cStep = task.items.find((item) => item.role === 'source' && item.content.includes('src/crc32.c'));
  assert.ok(headerStep);
  assert.ok(cStep);

  const header = microTaskDeterministicAcceptanceArtifact(task, headerStep);
  assert.match(header?.content ?? '', /#include <stdint\.h>[\s\S]*uint32_t crc32_update\(uint32_t seed, const void \*data, size_t length\);/u);

  const bib1 = {
    context: 'CRC-32/ISO-HDLC uses the reflected polynomial 0xEDB88320 and check value CBF43926 for 123456789.',
    citations: [{ label: 'CRC-32/ISO-HDLC parameters', path: 'Algorithms/CRC32.md', line: 18 }],
  };
  const contract = microTaskPrefixContract(task, cStep, bib1);
  assert.ok(contract);
  assert.equal(contract.functionName, 'crc32_update');
  assert.equal(contract.returnCType, 'uint32_t');
  assert.deepEqual(contract.parameterNames, ['seed', 'data', 'length']);
  assert.deepEqual(contract.parameterCTypes, ['uint32_t', 'const void *', 'size_t']);
  assert.match(contract.prefix, /Implement CRC-32\/ISO-HDLC\.[\s\S]*Match zlib\.crc32\(data, seed\), including incremental updates\./u);
  assert.match(contract.prefix, /Bib1 reference: reflected polynomial 0xEDB88320\./u);
  assert.equal(contract.grammar, undefined, 'une grammaire addition ne doit pas limiter le corps CRC');
  assert.equal(contract.maxTokens, 256);
  assert.equal(validatePrefixImplementation(
    'const unsigned char *bytes = (const unsigned char *)data;\nuint32_t crc = seed ^ UINT32_C(0xFFFFFFFF);\nfor (size_t i = 0; i < length; ++i) {\n    crc ^= bytes[i];\n    for (unsigned bit = 0; bit < 8; ++bit) {\n        uint32_t mask = (uint32_t)-(int32_t)(crc & 1U);\n        crc = (crc >> 1) ^ (UINT32_C(0xEDB88320) & mask);\n    }\n}\nreturn crc ^ UINT32_C(0xFFFFFFFF);',
    contract,
  ), undefined);
  assert.match(validatePrefixImplementation('return crc32_update(seed, data, length);', contract) ?? '', /récursivement/u);
});

test('le décomposeur utilise les chemins et les signaux de test quand le texte est en espagnol', () => {
  const request = 'Crea un proyecto en src/engine.rs y tests/engine_test.rs. Implementa el motor, añade pruebas y ejecuta cargo test. Mantén los cambios dentro del workspace y no borres archivos ajenos. El proyecto debe exponer una API estable, manejar errores de entrada, conservar las interfaces públicas existentes y documentar cómo ejecutar las pruebas.';
  const task = decomposeTask(request);
  assert.ok(task);
  assert.equal(task.detectedLanguage, 'es');
  assert.ok(task.items.some((item) => item.content.includes('src/engine.rs')));
  assert.ok(task.items.some((item) => item.content.includes('tests/engine_test.rs')));
  assert.ok(task.items.some((item) => item.role === 'run-test'));
  const source = task.items.find((item) => item.role === 'source');
  assert.ok(source);
  assert.match(microTaskPrompt(task, source, task.items.indexOf(source)), /Implementa src\/engine\.rs/);
});

test('les demandes courtes ou sans artefacts identifiables ne déclenchent pas de décomposition spéculative', () => {
  assert.equal(decomposeTask('Fixe le bug dans ce fichier.'), undefined);
  assert.equal(decomposeTask('Crée une application complète et géniale, fais tout ce qui est nécessaire.'), undefined);
});
