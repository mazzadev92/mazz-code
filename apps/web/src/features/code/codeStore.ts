// Open editor tabs, shared by the file tree (sidebar) and the editor area.
import { useSyncExternalStore } from 'react';
import { api, errorMessage, qs } from '../../lib/api';
import type { FileContent } from '../../lib/types';
import { toast } from '../../lib/store';

export interface OpenFile {
  path: string;
  original: string;
  content: string;
  modifiedAt?: number;
  loading: boolean;
  error?: string;
  binary?: boolean;
  tooLarge?: boolean;
  sizeBytes?: number;
  targetLine?: number;
}

interface CodeState {
  files: OpenFile[];
  active?: string;
  activeLine?: number;
  recent: string[];
  treeVersion: number;
}

let state: CodeState = { files: [], recent: [], treeVersion: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<CodeState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useCode<T>(sel: (s: CodeState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
    () => sel(state)
  );
}

export function isDirty(f: OpenFile): boolean {
  return !f.loading && !f.error && f.content !== f.original;
}

export async function openFile(path: string, line?: number): Promise<void> {
  const recent = [path, ...state.recent.filter((p) => p !== path)].slice(0, 15);
  if (state.files.some((f) => f.path === path)) {
    set({ active: path, activeLine: line, recent });
    if (line !== undefined) updateFile(path, { targetLine: line });
    return;
  }
  set({ files: [...state.files, { path, original: '', content: '', loading: true, targetLine: line }], active: path, activeLine: line, recent });
  try {
    const r = await api.get<FileContent>(`/api/files/read${qs({ path })}`);
    updateFile(path, { original: r.content ?? '', content: r.content ?? '', modifiedAt: r.modifiedAt, loading: false, binary: r.binary, tooLarge: r.tooLarge, sizeBytes: r.sizeBytes, targetLine: line });
  } catch (err) {
    updateFile(path, { loading: false, error: errorMessage(err) });
  }
}

export function updateFile(path: string, patch: Partial<OpenFile>): void {
  set({ files: state.files.map((f) => (f.path === path ? { ...f, ...patch } : f)) });
}

export function setActive(path: string): void {
  set({ active: path });
}

export function closeFile(path: string): void {
  const idx = state.files.findIndex((f) => f.path === path);
  const files = state.files.filter((f) => f.path !== path);
  const active = state.active === path ? files[Math.max(0, idx - 1)]?.path : state.active;
  set({ files, active });
}

export async function saveFile(path: string): Promise<boolean> {
  const f = state.files.find((x) => x.path === path);
  if (!f || !isDirty(f)) return true;
  try {
    const r = await api.put<{ modifiedAt: number; checkpointId: string }>('/api/files/write', { path, content: f.content, expectedModifiedAt: f.modifiedAt });
    updateFile(path, { original: f.content, modifiedAt: r.modifiedAt });
    toast('good', 'Fichier enregistré', `${path} (point de restauration ${r.checkpointId})`);
    return true;
  } catch (err) {
    toast('bad', 'Enregistrement impossible', errorMessage(err));
    return false;
  }
}

export async function reloadFile(path: string): Promise<void> {
  try {
    const r = await api.get<FileContent>(`/api/files/read${qs({ path })}`);
    updateFile(path, { original: r.content ?? '', content: r.content ?? '', modifiedAt: r.modifiedAt, error: undefined });
  } catch (err) {
    toast('bad', 'Rechargement impossible', errorMessage(err));
  }
}

export function bumpTree(): void {
  set({ treeVersion: state.treeVersion + 1 });
}

export function resetCode(): void {
  set({ files: [], active: undefined, recent: [], treeVersion: state.treeVersion + 1 });
}
