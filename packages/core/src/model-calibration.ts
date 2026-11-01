import type { ToolDefinition } from '@mazz/shared';
import type { IModelProvider } from '@mazz/providers';

export type CalibrationStatus = 'passed' | 'failed' | 'unsupported' | 'error';
export type CalibrationStrategy = 'autonomous' | 'hybrid' | 'guided';

export interface CalibrationCheck {
  status: CalibrationStatus;
  durationMs: number;
  summary: string;
  attempts?: number;
  passedAttempts?: number;
  outputPreview?: string;
}

/** Runtime options that can change a calibration result for the same GGUF. */
export interface CalibrationRuntimeSnapshot {
  binaryPath: string;
  binarySizeBytes: number | null;
  binaryModifiedAtMs: number | null;
  contextSize: number | null;
  threads: number | null;
  batchSize: number | null;
  gpuLayers: number | null;
  jinja: boolean;
  chatTemplateKwargs: Record<string, string | number | boolean | null> | null;
  reasoning: string | null;
  kvCacheType: string | null;
  flashAttn: string | null;
  specType: string | null;
  ngramMatch: number | null;
  ngramMin: number | null;
  ngramMax: number | null;
  draftModelPath: string | null;
  draftMax: number | null;
  poll: number | null;
  prio: number | null;
}

export interface ModelCalibrationProfile {
  providerId: string;
  modelId: string;
  modelPath: string;
  modelSizeBytes: number;
  modelModifiedAtMs: number;
  /** Missing on legacy profiles; those profiles cannot be safely reused. */
  runtime?: CalibrationRuntimeSnapshot;
  calibratedAt: string;
  score: { passed: number; total: number; percent: number };
  strategy: CalibrationStrategy;
  checks: {
    toolCalling: CalibrationCheck;
    constrainedGrammar: CalibrationCheck;
    codeContinuation: CalibrationCheck;
  };
}

const ECHO_TOOL: ToolDefinition = {
  name: 'calibration.echo',
  description: 'Retourne exactement la valeur demandée pour vérifier le protocole d’appel d’outil.',
  category: 'analysis',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
  requiresPermission: false,
};

const TOOL_CALL_ATTEMPTS = 3;
const OUTPUT_PREVIEW_LIMIT = 240;
const CALIBRATION_PROBE_TIMEOUT_MS = 8_000;

function preview(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
  if (!clean) return undefined;
  return clean.length > OUTPUT_PREVIEW_LIMIT ? `${clean.slice(0, OUTPUT_PREVIEW_LIMIT)}…` : clean;
}

function classify(checks: ModelCalibrationProfile['checks']): ModelCalibrationProfile['score'] & { strategy: CalibrationStrategy } {
  const measured = Object.values(checks).filter((check) => check.status !== 'unsupported');
  const passed = measured.filter((check) => check.status === 'passed').length;
  const percent = measured.length ? Math.round((passed / measured.length) * 100) : 0;
  const strategy: CalibrationStrategy = percent >= 90 && measured.length >= 2 && checks.toolCalling.status === 'passed'
    ? 'autonomous'
    : percent >= 50 || checks.toolCalling.status === 'passed'
      ? 'hybrid'
      : 'guided';
  return { passed, total: measured.length, percent, strategy };
}

async function prefixProbe(
  provider: IModelProvider,
  modelId: string,
  prompt: string,
  grammar: string | undefined,
  expected: RegExp,
  taskId: string,
): Promise<CalibrationCheck> {
  if (!provider.completePrefix) return { status: 'unsupported', durationMs: 0, summary: 'Complétion de préfixe non exposée par ce fournisseur.', attempts: 0, passedAttempts: 0 };
  const startedAt = Date.now();
  let output = '';
  try {
    for await (const event of provider.completePrefix(prompt, {
      modelId,
      taskId,
      temperature: 0,
      maxTokens: 32,
      stop: [';'],
      ...(grammar ? { grammar } : {}),
      signal: AbortSignal.timeout(CALIBRATION_PROBE_TIMEOUT_MS),
    })) {
      if (event.type === 'token') output += event.delta;
      if (event.type === 'error' && event.fatal) {
        return { status: 'error', durationMs: Date.now() - startedAt, summary: 'La sonde de génération a été refusée ou interrompue.', attempts: 1, passedAttempts: 0, outputPreview: preview(output) };
      }
    }
    const passed = expected.test(output.trim());
    return {
      status: passed ? 'passed' : 'failed',
      durationMs: Date.now() - startedAt,
      summary: passed ? 'Sortie conforme au contrat.' : 'Sortie hors du contrat attendu.',
      attempts: 1,
      passedAttempts: passed ? 1 : 0,
      outputPreview: preview(output),
    };
  } catch (error) {
    return { status: 'error', durationMs: Date.now() - startedAt, summary: 'La sonde de génération a échoué ou expiré.', attempts: 1, passedAttempts: 0, outputPreview: preview(error instanceof Error ? error.message : String(error)) };
  }
}

/** Runs three bounded, side-effect-free probes against the selected model. */
export async function calibrateModel(
  provider: IModelProvider,
  modelId: string,
  modelPath: string,
  identity: { sizeBytes: number; modifiedAtMs: number },
  runtime?: CalibrationRuntimeSnapshot,
): Promise<ModelCalibrationProfile> {
  const toolStartedAt = Date.now();
  let toolCalling: CalibrationCheck;
  let toolPassed = 0;
  let toolErrors = 0;
  let toolOutputPreview: string | undefined;
  const toolMessages = [
    { role: 'system' as const, content: 'Calibration protocol. Use the offered tool exactly once with the requested value. Do not answer in prose.' },
    { role: 'user' as const, content: 'Call calibration.echo with value exactly MAZZ_CALIBRATION_42.' },
  ];
  for (let attempt = 0; attempt < TOOL_CALL_ATTEMPTS; attempt += 1) {
    try {
      const response = await provider.chatComplete(
        toolMessages,
        [ECHO_TOOL],
        { modelId, taskId: `calibrate-tool-${Date.now()}-${attempt + 1}`, temperature: 0, maxTokens: 96, toolChoice: 'required', signal: AbortSignal.timeout(CALIBRATION_PROBE_TIMEOUT_MS) },
      );
      const call = response.toolCalls?.length === 1 ? response.toolCalls[0] : undefined;
      const passed = call?.name === ECHO_TOOL.name && call.arguments.value === 'MAZZ_CALIBRATION_42';
      if (passed) toolPassed += 1;
      else if (!toolOutputPreview) {
        toolOutputPreview = preview(JSON.stringify({ content: response.content, toolCalls: response.toolCalls?.map(({ name, arguments: args }) => ({ name, arguments: args })) ?? [] }));
      }
    } catch (error) {
      toolErrors += 1;
      if (!toolOutputPreview) toolOutputPreview = preview(error instanceof Error ? error.message : String(error));
    }
  }
  const toolPassedReliably = toolPassed >= 2;
  toolCalling = {
    status: toolPassedReliably ? 'passed' : toolErrors === TOOL_CALL_ATTEMPTS ? 'error' : 'failed',
    durationMs: Date.now() - toolStartedAt,
    summary: `Appel JSON valide dans ${toolPassed}/${TOOL_CALL_ATTEMPTS} essais${toolErrors ? `; ${toolErrors} erreur(s)` : ''}.`,
    attempts: TOOL_CALL_ATTEMPTS,
    passedAttempts: toolPassed,
    outputPreview: toolOutputPreview,
  };

  const constrainedGrammar = await prefixProbe(
    provider,
    modelId,
    'int mazz_calibration_value(void) { return ',
    'root ::= "42"',
    /^42$/u,
    `calibrate-grammar-${Date.now()}`,
  );
  const codeContinuation = await prefixProbe(
    provider,
    modelId,
    'int mazz_calibration_add(int left, int right) { return ',
    undefined,
    /\bleft\s*\+\s*right\b/u,
    `calibrate-code-${Date.now()}`,
  );
  const checks = { toolCalling, constrainedGrammar, codeContinuation };
  const result = classify(checks);
  return {
    providerId: provider.id,
    modelId,
    modelPath,
    modelSizeBytes: identity.sizeBytes,
    modelModifiedAtMs: identity.modifiedAtMs,
    ...(runtime ? { runtime } : {}),
    calibratedAt: new Date().toISOString(),
    score: { passed: result.passed, total: result.total, percent: result.percent },
    strategy: result.strategy,
    checks,
  };
}

const RUNTIME_KEYS: Array<keyof CalibrationRuntimeSnapshot> = [
  'binaryPath', 'binarySizeBytes', 'binaryModifiedAtMs', 'contextSize', 'threads', 'batchSize', 'gpuLayers',
  'jinja', 'chatTemplateKwargs', 'reasoning', 'kvCacheType', 'flashAttn', 'specType', 'ngramMatch',
  'ngramMin', 'ngramMax', 'draftModelPath', 'draftMax', 'poll', 'prio',
];

/** Profiles from different runtime configurations are not interchangeable. */
export function calibrationRuntimeMatches(
  calibrated: CalibrationRuntimeSnapshot | undefined,
  current: CalibrationRuntimeSnapshot | undefined,
): boolean {
  if (!calibrated || !current) return false;
  return RUNTIME_KEYS.every((key) => {
    const left = calibrated[key];
    const right = current[key];
    if (key === 'chatTemplateKwargs') return JSON.stringify(left) === JSON.stringify(right);
    return left === right;
  });
}

export function isModelCalibrationProfile(value: unknown): value is ModelCalibrationProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<ModelCalibrationProfile>;
  const validCheck = (check: unknown): check is CalibrationCheck => {
    if (!check || typeof check !== 'object') return false;
    const entry = check as Partial<CalibrationCheck>;
    return ['passed', 'failed', 'unsupported', 'error'].includes(String(entry.status))
      && Number.isSafeInteger(entry.durationMs) && (entry.durationMs ?? -1) >= 0
      && typeof entry.summary === 'string' && entry.summary.length <= 200
      && (entry.attempts === undefined || Number.isSafeInteger(entry.attempts) && entry.attempts >= 0 && entry.attempts <= 10)
      && (entry.passedAttempts === undefined || Number.isSafeInteger(entry.passedAttempts) && entry.passedAttempts >= 0 && entry.passedAttempts <= (entry.attempts ?? 0))
      && (entry.outputPreview === undefined || typeof entry.outputPreview === 'string' && entry.outputPreview.length <= OUTPUT_PREVIEW_LIMIT + 1);
  };
  const validRuntime = (runtime: unknown): runtime is CalibrationRuntimeSnapshot => {
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return false;
    const item = runtime as Partial<CalibrationRuntimeSnapshot>;
    const nullableNumber = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value);
    return typeof item.binaryPath === 'string' && item.binaryPath.length <= 2048
      && nullableNumber(item.binarySizeBytes) && nullableNumber(item.binaryModifiedAtMs)
      && nullableNumber(item.contextSize) && nullableNumber(item.threads) && nullableNumber(item.batchSize)
      && nullableNumber(item.gpuLayers) && typeof item.jinja === 'boolean'
      && (item.chatTemplateKwargs === null || !!item.chatTemplateKwargs && typeof item.chatTemplateKwargs === 'object' && !Array.isArray(item.chatTemplateKwargs))
      && [item.reasoning, item.kvCacheType, item.flashAttn, item.specType, item.draftModelPath].every((value) => value === null || typeof value === 'string')
      && [item.ngramMatch, item.ngramMin, item.ngramMax, item.draftMax, item.poll, item.prio].every(nullableNumber);
  };
  return typeof item.providerId === 'string' && item.providerId.length <= 100
    && typeof item.modelId === 'string' && item.modelId.length <= 512
    && typeof item.modelPath === 'string' && item.modelPath.length <= 2048
    && Number.isSafeInteger(item.modelSizeBytes) && (item.modelSizeBytes ?? 0) >= 0
    && Number.isFinite(item.modelModifiedAtMs) && (item.modelModifiedAtMs ?? -1) >= 0
    && typeof item.calibratedAt === 'string' && !Number.isNaN(Date.parse(item.calibratedAt))
    && !!item.score && Number.isSafeInteger(item.score.passed) && Number.isSafeInteger(item.score.total)
    && Number.isSafeInteger(item.score.percent) && ['autonomous', 'hybrid', 'guided'].includes(String(item.strategy))
    && !!item.checks && validCheck(item.checks.toolCalling)
    && validCheck(item.checks.constrainedGrammar) && validCheck(item.checks.codeContinuation)
    && (item.runtime === undefined || validRuntime(item.runtime));
}
