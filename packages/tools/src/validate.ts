import * as path from 'node:path';
import type { JSONSchemaProperty, ToolJSONSchema } from '@mazz/shared';

/**
 * Strict validation of model-produced tool arguments against the tool schema.
 * Errors are phrased for the model: they say what to send instead, so a small
 * local model can correct itself on the next step.
 */
export function validateToolArgs(schema: ToolJSONSchema, args: unknown): string[] {
  if (isInvalidJsonArguments(args)) return ['Arguments illisibles : JSON invalide. Renvoie un objet JSON conforme au schéma.'];
  return checkObject(schema, args, '');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isInvalidJsonArguments(value: unknown): boolean {
  return !isPlainRecord(value) || ('raw' in value && Object.keys(value).length === 1);
}

function missingRequired(value: unknown): boolean {
  return value === undefined || value === null;
}

function checkObject(
  schema: { properties?: Record<string, JSONSchemaProperty>; required?: string[] },
  value: unknown,
  name: string,
): string[] {
  if (!isPlainRecord(value)) return [`"${name || 'arguments'}" doit être un objet JSON.`];
  const properties = schema.properties ?? {};
  const declared = Object.keys(properties);
  const errors: string[] = [];

  for (const required of schema.required ?? []) {
    if (missingRequired(value[required])) {
      errors.push(`"${name ? `${name}.` : ''}${required}" est requis (${properties[required]?.type ?? 'valeur'}).`);
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const property = properties[key];
    if (!property) {
      // MCP servers sometimes expose an empty/opaque schema. Preserve their
      // arguments in that case; otherwise reject misspelled fields at every depth.
      if (declared.length > 0) errors.push(`Paramètre inconnu "${name ? `${name}.` : ''}${key}". Paramètres acceptés : ${declared.join(', ')}.`);
      continue;
    }
    errors.push(...checkValue(property, child, `${name ? `${name}.` : ''}${key}`));
  }
  return errors;
}

function checkValue(prop: JSONSchemaProperty, value: unknown, name: string): string[] {
  if (value === null) return [`"${name}" ne peut pas être null.`];
  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') return [`"${name}" doit être une chaîne.`];
      if (prop.enum && !prop.enum.includes(value)) return [`"${name}" doit valoir ${prop.enum.map((x) => `"${x}"`).join(' ou ')}.`];
      return [];
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`"${name}" doit être un nombre fini.`];
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) ? [] : [`"${name}" doit être un entier sûr.`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`"${name}" doit être un booléen.`];
    case 'array':
      if (!Array.isArray(value)) return [`"${name}" doit être une liste.`];
      return prop.items ? value.flatMap((item, index) => checkValue(prop.items!, item, `${name}[${index}]`)) : [];
    case 'object':
      return checkObject(prop, value, name);
    default:
      return [`"${name}" utilise un type de schéma non pris en charge (${prop.type}).`];
  }
}

const PATH_KEYS = new Set(['path', 'sourceFiles', 'outputExe']);

/**
 * Absolute paths that point inside the project are rewritten as relative paths
 * (models often echo the absolute workspace path). Paths outside stay untouched
 * so the tool refuses them with its confinement error.
 */
export function normalizeToolPaths(args: Record<string, unknown>, workspaceRoot: string): Record<string, unknown> {
  const root = path.resolve(workspaceRoot);
  const fix = (p: unknown): unknown => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return p;
    const abs = path.resolve(p);
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : p;
  };
  const out: Record<string, unknown> = { ...args };
  for (const k of Object.keys(out)) {
    if (!PATH_KEYS.has(k)) continue;
    out[k] = Array.isArray(out[k]) ? (out[k] as unknown[]).map(fix) : fix(out[k]);
  }
  return out;
}
