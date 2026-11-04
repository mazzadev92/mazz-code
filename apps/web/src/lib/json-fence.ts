/**
 * A reply that is only a JSON object/array (a small model wrote its tool call as plain text) is shown as a
 * formatted code block instead of a wall of raw characters. Anything else, or a partial stream, is untouched.
 */
export function fenceIfJson(text: string, streaming = false): string {
  const t = text.trim();
  if (streaming || !/^[[{][\s\S]*[\]}]$/.test(t)) return text;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed === null || typeof parsed !== 'object') return text;
    return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
  } catch {
    return text;
  }
}
