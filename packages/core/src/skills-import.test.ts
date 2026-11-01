import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { SkillStore, SkillsLoadTool } from './skills.js';
import { fetchSkillImport, parseSkillImportUrl, parseSkillPackage, sha256Hex, SkillImportError } from './skill-import.js';

interface ZipFixtureEntry {
  name: string;
  bytes: Buffer;
  method?: 0 | 8;
  mode?: number;
}

const SKILL = Buffer.from('---\nname: audit-fixture\ndescription: Validate code review imports\n---\n\nReview real source changes and cite evidence.\n', 'utf8');

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ZipFixtureEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = entry.method === 0 ? entry.bytes : deflateRawSync(entry.bytes);
    const method = entry.method ?? 8;
    const crc = crc32(entry.bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((((entry.mode ?? 0o100644) << 16) >>> 0), 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function source(url = 'https://example.invalid/audit-fixture.zip') {
  return { sourceUrl: url, finalUrl: url, fetchedAt: '2026-10-24T10:00:00.000Z' };
}

test('real filesystem install is atomic, records exact hashes, then list/read/skills.load see the installed skill', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-skill-import-install-'));
  const studio = path.join(temp, 'studio-skills');
  await fs.mkdir(studio);
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));

  const packageBytes = zip([
    { name: 'repository/audit-fixture/', bytes: Buffer.alloc(0), method: 0, mode: 0o040755 },
    { name: 'repository/audit-fixture/SKILL.md', bytes: SKILL },
    { name: 'repository/audit-fixture/references/checklist.md', bytes: Buffer.from('# Checklist\nRead the actual changed file.\n') },
    { name: 'repository/audit-fixture/helpers/never-run.sh', bytes: Buffer.from(`#!/bin/sh\nprintf executed > '${path.join(temp, 'script-ran')}'\n`) },
  ]);
  const bundle = parseSkillPackage(packageBytes, source().sourceUrl, source().finalUrl, source().fetchedAt);
  assert.equal(bundle.name, 'audit-fixture');
  assert.deepEqual(bundle.files.map((file) => file.path).sort(), ['SKILL.md', 'helpers/never-run.sh', 'references/checklist.md'].sort());

  const store = new SkillStore(studio, () => ({ folders: [], includeClaude: false }));
  await store.scan();
  const skill = await store.installImported(bundle);
  assert.equal(skill.source, 'studio');
  assert.equal(skill.provenance?.archiveSha256, sha256Hex(packageBytes));
  assert.equal(skill.provenance?.files.find((file) => file.path === 'SKILL.md')?.sha256, sha256Hex(SKILL));
  assert.equal(await fs.readFile(path.join(studio, 'audit-fixture', 'SKILL.md'), 'utf8'), SKILL.toString('utf8'));
  assert.equal((await fs.readFile(path.join(studio, 'audit-fixture', 'references', 'checklist.md'), 'utf8')).includes('actual changed file'), true);
  assert.equal(await fs.readFile(path.join(studio, 'audit-fixture', 'helpers', 'never-run.sh'), 'utf8').then((text) => text.startsWith('#!/bin/sh\n')), true);
  assert.equal(await fs.stat(path.join(temp, 'script-ran')).then(() => true, () => false), false);
  assert.equal((await store.load('audit-fixture')).body, 'Review real source changes and cite evidence.');
  assert.deepEqual((await store.load('audit-fixture')).files.sort(), ['helpers/never-run.sh', 'references/checklist.md'].sort());
  assert.equal((await fs.readdir(path.join(studio, 'audit-fixture'))).includes('MAZZ_PROVENANCE.json'), true);

  const result = await new SkillsLoadTool(store).execute({ name: 'audit-fixture' }, {} as never);
  assert.equal(result.success, true);
  assert.equal((result.output as { instructions: string }).instructions, 'Review real source changes and cite evidence.');
  const listed = (await store.scan()).find((item) => item.name === 'audit-fixture');
  assert.equal(listed?.provenance?.sourceUrl, source().sourceUrl);
});

test('existing skills in any configured source are not replaced or shadowed', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-skill-import-collision-'));
  const studio = path.join(temp, 'studio');
  const project = path.join(temp, 'project');
  const projectSkills = path.join(project, '.mazz', 'skills', 'audit-fixture');
  await fs.mkdir(studio, { recursive: true });
  await fs.mkdir(projectSkills, { recursive: true });
  await fs.writeFile(path.join(projectSkills, 'SKILL.md'), '---\nname: audit-fixture\ndescription: Existing project\n---\n\nOriginal bytes remain.\n');
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));

  const store = new SkillStore(studio, () => ({ folders: [], includeClaude: false, projectRoot: project }));
  const bundle = parseSkillPackage(SKILL, source().sourceUrl, source().finalUrl, source().fetchedAt);
  await assert.rejects(store.installImported(bundle), /existe déjà/u);
  assert.equal(await fs.readFile(path.join(projectSkills, 'SKILL.md'), 'utf8'), '---\nname: audit-fixture\ndescription: Existing project\n---\n\nOriginal bytes remain.\n');
  assert.deepEqual(await fs.readdir(studio), []);
});

test('ZIP parser rejects traversal, absolute paths, symlinks, duplicate paths and CRC corruption', () => {
  const metadata = source();
  for (const name of ['../outside.txt', '/rooted.txt', 'C:/drive.txt', 'dir\\escape.txt']) {
    const malicious = zip([{ name, bytes: Buffer.from('x') }, { name: 'SKILL.md', bytes: SKILL }]);
    assert.throws(() => parseSkillPackage(malicious, metadata.sourceUrl, metadata.finalUrl), SkillImportError, name);
  }

  const symlink = zip([
    { name: 'SKILL.md', bytes: SKILL },
    { name: 'linked', bytes: Buffer.from('../outside'), mode: 0o120777 },
  ]);
  assert.throws(() => parseSkillPackage(symlink, metadata.sourceUrl, metadata.finalUrl), /symbolique/u);

  const duplicate = zip([{ name: 'SKILL.md', bytes: SKILL }, { name: 'skill.md', bytes: SKILL }]);
  assert.throws(() => parseSkillPackage(duplicate, metadata.sourceUrl, metadata.finalUrl), /Collision/u);

  const corrupt = zip([{ name: 'SKILL.md', bytes: SKILL }]);
  const centralOffset = corrupt.readUInt32LE(corrupt.length - 22 + 16);
  corrupt.writeUInt32LE((crc32(SKILL) ^ 0x01000000) >>> 0, 14);
  corrupt.writeUInt32LE((crc32(SKILL) ^ 0x01000000) >>> 0, centralOffset + 16);
  assert.throws(() => parseSkillPackage(corrupt, metadata.sourceUrl, metadata.finalUrl), /CRC/u);
});

test('archive layout and per-entry limits reject ambiguous or oversized packages', () => {
  const metadata = source();
  assert.throws(() => parseSkillPackage(zip([{ name: 'a/SKILL.md', bytes: SKILL }, { name: 'b/SKILL.md', bytes: SKILL }]), metadata.sourceUrl, metadata.finalUrl), /exactement un/u);
  assert.throws(() => parseSkillPackage(zip([{ name: 'SKILL.md', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }]), metadata.sourceUrl, metadata.finalUrl), /trop volumineuse/u);
  assert.throws(() => parseSkillPackage(Buffer.alloc(12 * 1024 * 1024 + 1), metadata.sourceUrl, metadata.finalUrl), /Taille de paquet/u);
});

test('HTTPS URL parsing rejects downgrade, credentials and nonstandard ports; loopback is refused before connection', async () => {
  assert.throws(() => parseSkillImportUrl('http://example.com/SKILL.md'), /HTTPS/u);
  assert.throws(() => parseSkillImportUrl('https://user:pass@example.com/SKILL.md'), /identifiants/u);
  assert.throws(() => parseSkillImportUrl('https://example.com:8443/SKILL.md'), /443/u);
  await assert.rejects(fetchSkillImport('https://127.0.0.1:443/SKILL.md'), /locale|privée|privé|refusée/u);
});

