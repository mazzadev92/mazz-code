import { describe, expect, it } from 'vitest';
import { fenceIfJson } from './json-fence';

describe('fenceIfJson', () => {
  it('fenceIfJson_wholeMessageIsAJsonCall_returnsPrettyCodeBlock', () => {
    const out = fenceIfJson('{"name":"fs.read","arguments":{"path":"a.py"}}');
    expect(out.startsWith('```json\n{\n  "name": "fs.read"')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('fenceIfJson_proseOrMixedText_isUntouched', () => {
    expect(fenceIfJson('Voici : {"a":1}')).toBe('Voici : {"a":1}');
    expect(fenceIfJson('bonjour')).toBe('bonjour');
  });

  it('fenceIfJson_invalidOrStreamingJson_isUntouched', () => {
    expect(fenceIfJson('{"a":')).toBe('{"a":');
    expect(fenceIfJson('{"a":1}', true)).toBe('{"a":1}');
  });
});
