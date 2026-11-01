import { writeFileSync } from 'node:fs';
import { defaultToolRegistry } from '../../packages/tools/dist/index.js';
const keep = ['fs.read', 'fs.write', 'fs.patch', 'fs.list', 'code.search', 'code.outline', 'terminal.run'];
const tools = defaultToolRegistry.list().filter((t) => keep.includes(t.name)).map((t) => ({ type: 'function', function: { name: t.name.replace('.', '__'), description: t.description, parameters: t.parameters } }));
writeFileSync(new URL('./tools.json', import.meta.url), JSON.stringify(tools, null, 2));
console.log(tools.map((t) => t.function.name).join(', '));
