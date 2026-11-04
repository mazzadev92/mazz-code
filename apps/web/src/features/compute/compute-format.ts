export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ComputeJob {
  id: string;
  title: string;
  status: JobStatus;
  steps: Array<{ name: string; status: string; detail: string }>;
  progress: number;
  message: string;
  result: Record<string, unknown>;
}

export type SendSource = { type: 'local'; filename: string } | { type: 'hf'; repo?: string; file: string };

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'En attente',
  running: 'En cours',
  done: 'Terminé',
  failed: 'Échec',
};

export function jobTone(status: JobStatus): 'neutral' | 'info' | 'good' | 'bad' {
  return status === 'done' ? 'good' : status === 'failed' ? 'bad' : status === 'running' ? 'info' : 'neutral';
}

export function jobPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

export function isJobActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** Body of POST /api/compute/send. Blank served names are omitted so the gateway derives one. */
export function buildSendBody(source: SendSource, target: string, servedName: string): { source: SendSource; target: string; options: Record<string, string> } {
  const name = servedName.trim();
  return { source, target, options: name ? { served_name: name } : {} };
}

/** A source can only go to a provider that accepts its kind (gguf file vs Hugging Face repo). */
export function providerAcceptsSource(accepts: string[], source: SendSource): boolean {
  if (source.type === 'hf' && !source.file.toLowerCase().endsWith('.gguf')) return accepts.includes('hf');
  return accepts.includes('gguf');
}
