/**
 * Remote APIs do not say which models accept images. This list covers the
 * families documented as multimodal; anything else is treated as text only
 * (images are then described by name, never silently dropped).
 */
const VISION_PATTERNS = [
  /gpt-4o/, /gpt-4\.1/, /gpt-4-turbo/, /gpt-5/, /^o[134](-|$)/, /chatgpt-4o/,
  /claude-(3|sonnet-4|opus-4|haiku-4|sonnet-5|opus-5|haiku-5|fable)/, /claude-.*-(4|5)/,
  /gemini/, /gemma-3/, /llama-4/, /llama-3\.2-.*vision/, /vision/, /-vl\b/, /-vl-/, /vl-/, /llava/, /pixtral/, /mistral-(small|medium)-(2503|2506|3)/, /qwen.*vl/, /qvq/, /internvl/, /minicpm-v/, /smolvlm/, /moondream/, /grok-.*vision/, /grok-4/,
];

export function likelyVisionModel(modelId: string): boolean {
  const id = modelId.toLowerCase().split('/').pop() ?? '';
  return VISION_PATTERNS.some((re) => re.test(id));
}
