import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { MazzServer } from './server.js';

const reverseEngineRoot = 'D:\\MAZZ_REVERSE_ENGINE';
const reverseEngineMcpExe = path.join(reverseEngineRoot, 'bin', 'MAZZMCPServer.exe');

async function findAvailableLoopbackPort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Impossible de réserver un port loopback pour le test MCP.');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('Connecteur MAZZ Reverse Engine : vrai binaire stdio, handshake, tools/list et inspection en lecture seule d’une cible temporaire', {
  skip: !existsSync(reverseEngineMcpExe) && `Binaire installé absent : ${reverseEngineMcpExe}`,
}, async () => {
  const labRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-reverse-engine-mcp-lab-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-reverse-engine-mcp-studio-'));
  const targetDir = path.join(labRoot, '15_TESTS', 'connector-contract');
  const target = path.join(targetDir, 'real-installed-mcp-server.exe');
  const port = await findAvailableLoopbackPort();
  const studio = new MazzServer({ port, host: '127.0.0.1', dataDir, webRoot: path.join(dataDir, 'no-web') });
  let started = false;
  const installedExecutableSha256 = await sha256(reverseEngineMcpExe);

  try {
    // MAZZ_LAB_ROOT confines the real server's guard, audit log and runtime data
    // to this disposable lab. The executable itself remains the installed file.
    await fs.mkdir(path.join(labRoot, '14_CONFIG'), { recursive: true });
    await fs.writeFile(path.join(labRoot, '14_CONFIG', 'lab_manifest.json'), '{"name":"temporary MCP connector contract"}\n', 'utf8');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(reverseEngineMcpExe, target);
    const inputHash = await sha256(target);

    await studio.start();
    started = true;
    const base = `http://127.0.0.1:${port}`;
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const saved = await post('/api/mcp/servers', {
      id: 'mazz-reverse-engine-contract',
      name: 'MAZZ Reverse Engine (contrat local)',
      transport: 'stdio',
      command: reverseEngineMcpExe,
      args: [],
      cwd: reverseEngineRoot,
      env: { MAZZ_LAB_ROOT: labRoot, MAZZ_MCP_CONFIRM: 'deny' },
      enabled: true,
      autoStart: false,
    });
    assert.equal(saved.status, 200, await saved.clone().text());

    const startedResponse = await post('/api/mcp/servers/mazz-reverse-engine-contract/start', {});
    const status = await startedResponse.json() as {
      state: string;
      processId?: number;
      serverInfo?: { name?: string; version?: string };
      tools: Array<{ name: string; registeredAs: string }>;
    };
    assert.equal(startedResponse.status, 200, JSON.stringify(status));
    assert.equal(status.state, 'running');
    assert.ok(status.processId, 'Le serveur stdio réel doit exposer son PID tant qu’il fonctionne.');
    assert.equal(status.serverInfo?.name, 'mazz-mcp-native-server');
    assert.ok(status.tools.length >= 20, `Le serveur réel a annoncé ${status.tools.length} outils.`);
    assert.ok(status.tools.some((tool) => tool.name === 'mazz_core_inspect_binary' && tool.registeredAs === 'mcp.mazz-reverse-engine-contract.mazz_core_inspect_binary'));

    const callResponse = await post('/api/mcp/servers/mazz-reverse-engine-contract/call', {
      tool: 'mazz_core_inspect_binary',
      arguments: { file_path: target },
    });
    const call = await callResponse.json() as { success: boolean; output?: { text?: string }; error?: string };
    assert.equal(callResponse.status, 200, JSON.stringify(call));
    assert.equal(call.success, true, JSON.stringify(call));
    const inspection = JSON.parse(call.output?.text ?? 'null') as { file_name?: string; file_size?: number; format?: string; architecture?: string };
    assert.equal(inspection.file_name, path.basename(target));
    assert.equal(inspection.file_size, (await fs.stat(target)).size);
    assert.match(inspection.format ?? '', /PE/i);
    assert.ok(inspection.architecture, 'L’outil réel doit retourner l’architecture détectée.');
    assert.equal(await sha256(target), inputHash, 'L’outil de lecture ne doit pas modifier la cible temporaire.');
    assert.equal(await sha256(reverseEngineMcpExe), installedExecutableSha256, 'Le binaire installé ne doit pas être modifié par l’essai.');

    const stopped = await post('/api/mcp/servers/mazz-reverse-engine-contract/stop', {});
    assert.equal(stopped.status, 200, await stopped.clone().text());
    const remaining = await (await fetch(`${base}/api/mcp/servers`)).json() as {
      servers: Array<{ id: string; status: { state: string; tools: unknown[]; processId?: number } }>;
    };
    const entry = remaining.servers.find((server) => server.id === 'mazz-reverse-engine-contract');
    assert.equal(entry?.status.state, 'stopped');
    assert.deepEqual(entry?.status.tools, []);
    assert.equal(entry?.status.processId, undefined);
    const childExited = await waitForProcessExit(status.processId);
    assert.equal(childExited, true, `Le processus MCP ${status.processId} doit se terminer après stop.`);
    const installedExecutableSha256After = await sha256(reverseEngineMcpExe);
    assert.equal(installedExecutableSha256After, installedExecutableSha256, 'Le binaire installé doit conserver le même SHA-256 après l’arrêt.');

    const evidence = {
      capturedAt: new Date().toISOString(),
      installedExecutable: reverseEngineMcpExe,
      installedExecutableSha256Before: installedExecutableSha256,
      installedExecutableSha256After,
      temporaryLabRoot: labRoot,
      target,
      targetSha256: inputHash,
      handshake: status.serverInfo,
      toolsListed: status.tools.length,
      invokedTool: 'mazz_core_inspect_binary',
      inspection: { format: inspection.format, architecture: inspection.architecture, fileSize: inspection.file_size },
      targetUnchanged: true,
      childPid: status.processId,
      childExited,
      stoppedCleanly: entry?.status.state === 'stopped',
    };
    console.log(`REVERSE_ENGINE_MCP_E2E ${JSON.stringify(evidence)}`);
  } finally {
    if (started) await studio.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(labRoot, { recursive: true, force: true });
  }
});
