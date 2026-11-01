import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DebouncedWriter} from './storage.js';
test('persistence: real write failure is observable and a later write can recover',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-persistence-real-'));
 const blocked=path.join(root,'blocked');await fs.writeFile(blocked,'actual regular file blocks a directory');
 const writer=new DebouncedWriter(path.join(blocked,'session.json'),60000);
 writer.schedule({value:1});await assert.rejects(writer.flush());
 await fs.unlink(blocked);await fs.mkdir(blocked);writer.schedule({value:2});await writer.flush();
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(blocked,'session.json'),'utf8')),{value:2});
 // Retain this isolated physical fixture; never touch user data.
});
