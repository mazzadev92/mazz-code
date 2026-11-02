import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolExecutionContext } from '@mazz/shared';
import { ExtractGame3dTool } from './game3d.js';

const context = (workspaceRoot: string) => ({ taskId: 't', workspaceRoot, emitEvent: () => undefined }) as unknown as ToolExecutionContext;

test('extract_game_3d exposes the spec 08 schema', () => {
  const { definition } = new ExtractGame3dTool();
  assert.equal(definition.name, 'extract_game_3d');
  assert.deepEqual(definition.parameters.required, ['input_xbg_path']);
  assert.ok(definition.parameters.properties.output_glb_path);
});

test('extract_game_3d reports a missing input or converter without running anything', async () => {
  // Arrange
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-xbg-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-xbg-outside-'));
  try {
    const tool = new ExtractGame3dTool([path.join(root, 'absent.py')], process.execPath);
    await fs.writeFile(path.join(root, 'present.xbg'), 'not a real game file');

    // Act
    const missing = await tool.execute({ input_xbg_path: 'model.xbg' }, context(root));
    const badExtension = await tool.execute({ input_xbg_path: 'model.obj' }, context(root));
    const escaped = await tool.execute({ input_xbg_path: path.join(outside, 'model.xbg') }, context(root));
    const noConverter = await tool.execute({ input_xbg_path: 'present.xbg' }, context(root));

    // Assert
    assert.match(missing.error ?? '', /introuvable : model\.xbg/);
    assert.match(badExtension.error ?? '', /\.xbg/);
    assert.match(escaped.error ?? '', /Accès refusé/);
    assert.match(noConverter.error ?? '', /xbg_to_glb\.py introuvable/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('extract_game_3d runs the converter with input and output paths and checks the .glb', async () => {
  // Arrange: a stand-in converter (run by node instead of python) that writes the output it is given.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-xbg-run-'));
  try {
    const stub = path.join(root, 'stub.cjs');
    await fs.writeFile(stub, "require('fs').writeFileSync(process.argv[3], 'glTF'); console.log('XBG', process.argv[2].endsWith('.xbg'));\n");
    await fs.writeFile(path.join(root, 'tree.xbg'), 'fixture');
    const tool = new ExtractGame3dTool([stub], process.execPath);

    // Act
    const result = await tool.execute({ input_xbg_path: 'tree.xbg', output_glb_path: 'out/tree.glb' }, context(root));

    // Assert
    assert.equal(result.success, true, result.error ?? '');
    assert.deepEqual(result.output, { glbPath: path.join(root, 'out', 'tree.glb'), bytes: 4, report: 'XBG true' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
