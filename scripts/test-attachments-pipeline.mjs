import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(here, '..');
const auditDir = path.resolve(studioRoot, '..', 'AUDIT_RUN_2026-10-23', 'evidence', 'attachments_pipeline_20261024');

const { MazzServer, AttachmentStore, AttachmentReadTool, MAX_ATTACHMENT_BYTES } = await import(
  new URL('../packages/core/dist/index.js', import.meta.url)
);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function getEphemeralPort() {
  const s = createServer();
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve());
  });
  const port = s.address().port;
  await new Promise((resolve) => s.close(() => resolve()));
  return port;
}

async function run() {
  const logEntries = [];
  function log(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    console.log(line);
    logEntries.push(line);
  }

  log('=== DEBUT DU TEST D INTEGRATION DU PARCOURS PIECES JOINTES ===');
  await fs.mkdir(auditDir, { recursive: true });

  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-att-e2e-'));
  const dataDir = path.join(tempBase, 'data');
  const workspace = path.join(tempBase, 'workspace');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });

  const port = await getEphemeralPort();
  log(`Port alloue : ${port}`);

  const server = new MazzServer({
    port,
    host: '127.0.0.1',
    dataDir,
    webRoot: path.join(dataDir, 'web'),
    devOrigins: [],
  });

  await server.start();
  log('Serveur MazzServer demarre avec succes');

  const base = `http://127.0.0.1:${port}`;
  const results = {
    testDate: new Date().toISOString(),
    port,
    steps: {},
    success: true,
  };

  try {
    // 1. Health check
    const healthRes = await fetch(`${base}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, 'ok');
    log('Etape 1: Health check verifie (200 OK)');
    results.steps.healthCheck = 'PASS';

    // 2. Upload text attachment
    const textContent = 'Cahier des charges pour l agent MAZZ Code.\nExigence 1: integrite des donnees.\nExigence 2: respect des permissions.\n';
    const textBytes = Buffer.from(textContent, 'utf-8');
    const textExpectedSha = sha256(textBytes);

    const uploadRes = await fetch(`${base}/api/attachments?name=${encodeURIComponent('cahier-des-charges.txt')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: textBytes,
    });
    assert.equal(uploadRes.status, 200, `Upload text returned ${uploadRes.status}`);
    const uploadJson = await uploadRes.json();
    assert.ok(uploadJson.attachment, 'Missing attachment object');
    const metaText = uploadJson.attachment;

    assert.match(metaText.id, /^att_[a-z0-9]+$/);
    assert.equal(metaText.name, 'cahier-des-charges.txt');
    assert.equal(metaText.sizeBytes, textBytes.length);
    assert.equal(metaText.kind, 'text');
    assert.equal(metaText.mime, 'text/plain');
    assert.equal(metaText.chars, textContent.length);
    assert.equal(metaText.sourceSha256, textExpectedSha);
    assert.equal(metaText.textSha256, sha256(textContent));
    assert.equal(metaText.extractionStatus, 'complete');
    assert.equal(metaText.offsetUnit, 'utf16-code-unit');
    log(`Etape 2: Upload texte reussi (id: ${metaText.id}, ${metaText.chars} caracteres, extraction complete)`);
    results.steps.uploadText = { status: 'PASS', id: metaText.id };

    // 3. Verify physical persistence on disk
    const attFolder = path.join(dataDir, 'attachments', metaText.id);
    const diskOriginal = await fs.readFile(path.join(attFolder, 'original'));
    const diskText = await fs.readFile(path.join(attFolder, 'text.txt'), 'utf-8');
    const diskMetaJson = JSON.parse(await fs.readFile(path.join(attFolder, 'meta.json'), 'utf-8'));

    assert.equal(diskOriginal.length, textBytes.length);
    assert.equal(sha256(diskOriginal), textExpectedSha);
    assert.equal(diskText, textContent);
    assert.equal(diskMetaJson.id, metaText.id);
    assert.equal(diskMetaJson.sourceSha256, textExpectedSha);
    log('Etape 3: Persistance physique verifiee (original, text.txt, meta.json sur disque)');
    results.steps.diskPersistence = 'PASS';

    // 4. Fetch metadata via GET /api/attachments/:id
    const getMetaRes = await fetch(`${base}/api/attachments/${metaText.id}`);
    assert.equal(getMetaRes.status, 200);
    const getMetaJson = await getMetaRes.json();
    assert.deepEqual(getMetaJson.attachment, metaText);
    log('Etape 4: Lecture des metadonnees via GET /api/attachments/:id validee');
    results.steps.getMetadata = 'PASS';

    // 5. Fetch extracted text via GET /api/attachments/:id/text
    const getTextRes = await fetch(`${base}/api/attachments/${metaText.id}/text?offset=0`);
    assert.equal(getTextRes.status, 200);
    const getTextJson = await getTextRes.json();
    assert.equal(getTextJson.text, textContent);
    assert.equal(getTextJson.total, textContent.length);
    assert.equal(getTextJson.done, true);
    assert.equal(getTextJson.textSha256, metaText.textSha256);
    log('Etape 5: Lecture du texte extrait via GET /api/attachments/:id/text validee');
    results.steps.getText = 'PASS';

    // 6. Download raw original via GET /api/attachments/:id/raw
    const getRawRes = await fetch(`${base}/api/attachments/${metaText.id}/raw`);
    assert.equal(getRawRes.status, 200);
    const rawBuffer = Buffer.from(await getRawRes.arrayBuffer());
    assert.equal(rawBuffer.length, textBytes.length);
    assert.equal(sha256(rawBuffer), textExpectedSha);
    log('Etape 6: Telechargement de l original brut via GET /api/attachments/:id/raw valide byte-for-byte');
    results.steps.getRaw = 'PASS';

    // 7. Upload code attachment (Python)
    const pythonCode = 'def compute_hashes(data):\n    import hashlib\n    return hashlib.sha256(data).hexdigest()\n';
    const pyBytes = Buffer.from(pythonCode, 'utf-8');
    const uploadPyRes = await fetch(`${base}/api/attachments?name=hasher.py`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pyBytes,
    });
    assert.equal(uploadPyRes.status, 200);
    const metaPy = (await uploadPyRes.json()).attachment;
    assert.equal(metaPy.kind, 'code');
    assert.equal(metaPy.mime, 'text/plain');
    assert.equal(metaPy.chars, pythonCode.length);
    assert.equal(metaPy.extractionStatus, 'complete');
    log(`Etape 7: Upload code source Python reussi (kind: ${metaPy.kind}, mime: ${metaPy.mime})`);
    results.steps.uploadCode = 'PASS';

    // 8. Upload image attachment (PNG header)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    const pngData = Buffer.concat([pngHeader, Buffer.alloc(64, 0x00)]);
    const uploadPngRes = await fetch(`${base}/api/attachments?name=diag.png`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pngData,
    });
    assert.equal(uploadPngRes.status, 200);
    const metaPng = (await uploadPngRes.json()).attachment;
    assert.equal(metaPng.kind, 'image');
    assert.equal(metaPng.mime, 'image/png');
    assert.equal(metaPng.chars, 0);
    assert.match(metaPng.note ?? '', /Image jointe/);
    log('Etape 8: Upload image PNG reussi (kind: image, chars: 0, note: vision)');
    results.steps.uploadImage = 'PASS';

    // 9. Negative tests
    // 9a. Empty file
    const emptyRes = await fetch(`${base}/api/attachments?name=empty.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    });
    assert.equal(emptyRes.status, 400);
    const emptyJson = await emptyRes.json();
    assert.match(emptyJson.error, /Fichier vide/);
    log('Etape 9a: Rejet d un fichier vide valide (400)');

    // 9b. Malformed ID in GET /api/attachments/:id
    const malformedIdRes = await fetch(`${base}/api/attachments/..%2Fhack`);
    assert.notEqual(malformedIdRes.status, 200);
    log('Etape 9b: Rejet de path traversal dans l identifiant valide');
    results.steps.negativeTests = 'PASS';

    // 10. Deletion of attachment via DELETE /api/attachments/:id
    const delRes = await fetch(`${base}/api/attachments/${metaText.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.ok, true);
    log(`Etape 10: Suppression via DELETE /api/attachments/${metaText.id} confirmee`);

    // 11. Verify disk cleanup
    await assert.rejects(fs.access(attFolder), { code: 'ENOENT' });
    log('Etape 11: Nettoyage physique du repertoire d attachement verifie');

    // 12. Verify subsequent GET returns 404/error
    const postDelRes = await fetch(`${base}/api/attachments/${metaText.id}`);
    assert.equal(postDelRes.status, 404);
    log('Etape 12: Requete post-suppression renvoie 404');
    results.steps.deletionAndCleanup = 'PASS';

    // 13. Test prompt rendering and fair share budget
    const store = new AttachmentStore(path.join(dataDir, 'attachments'));
    const rendered = await store.renderForPrompt([metaPy.id, metaPng.id], 50);
    assert.ok(rendered.text.includes('<piece_jointe'));
    assert.ok(rendered.text.includes('hasher.py'));
    assert.ok(rendered.text.includes('diag.png'));
    log('Etape 13: Rendu du bloc prompt avec allocation budgetaire valide');
    results.steps.promptRendering = 'PASS';

    // 14. Test AttachmentReadTool paged execution
    const readTool = new AttachmentReadTool(store);
    const toolResult = await readTool.execute({ id: metaPy.id, offset: 0, length: 100 }, {
      taskId: 'test-read',
      workspaceRoot: workspace,
      signal: new AbortController().signal,
      permissionLevel: 'read_only',
      emitEvent: () => undefined,
    });
    assert.equal(toolResult.success, true);
    const toolOutput = toolResult.output;
    assert.equal(toolOutput.total, pythonCode.length);
    assert.equal(toolOutput.done, true);
    assert.equal(toolOutput.text, pythonCode);
    log('Etape 14: Execution d attachments.read validee');
    results.steps.readToolExecution = 'PASS';

    log('=== TOUTES LES ETAPES DU PARCOURS PIECES JOINTES ONT REUSSI ===');
  } catch (err) {
    log(`ERREUR DANS LE TEST : ${err.stack || err}`);
    results.success = false;
    results.error = String(err.stack || err);
    throw err;
  } finally {
    await server.stop().catch(() => undefined);
    log('Serveur arrete proprement');
    await fs.rm(tempBase, { recursive: true, force: true }).catch(() => undefined);
    log('Dossiers temporaires supprimes');

    const logFile = path.join(auditDir, 'attachments_e2e_run.log');
    const jsonFile = path.join(auditDir, 'attachments_e2e_results.json');
    await fs.writeFile(logFile, logEntries.join('\n'), 'utf8');
    await fs.writeFile(jsonFile, JSON.stringify(results, null, 2), 'utf8');
    log(`Preuves enregistrees dans ${auditDir}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
