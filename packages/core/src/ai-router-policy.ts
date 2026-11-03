import type { ExecutionMode } from '@mazz/shared';

export function isAiRouterModelId(modelId: string): boolean {
  return modelId === 'auto' || modelId.startsWith('router/');
}

export function aiRouterSelectionAllowed(mode: ExecutionMode, providerId: string, modelId: string): boolean {
  return !(mode === 'local_strict' && providerId === 'mazz-cloud' && isAiRouterModelId(modelId));
}
