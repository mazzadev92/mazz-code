import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SessionRecord, TaskInfo } from '../../lib/types';
import { attachRun, getRun } from '../../lib/agentRuns';

/** Loads a session record, keeps it fresh after runs, re-attaches to a running task. */
export function useSession(sessionId: string | undefined) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (id: string, signal?: AbortSignal) => {
      try {
        const r = await api.get<{ session: SessionRecord; running?: TaskInfo }>(`/api/sessions/${encodeURIComponent(id)}`, signal);
        setSession(r.session);
        setError(null);
        if (r.running && !getRun(id)) {
          const turn = r.session.turns.find((t) => t.taskId === r.running!.taskId);
          attachRun(id, r.running, turn?.prompt ?? '');
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError(err);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    void load(sessionId, ctrl.signal);
    const onFinished = (e: Event) => {
      if ((e as CustomEvent).detail?.sessionId === sessionId) void load(sessionId);
    };
    window.addEventListener('mazz:run-finished', onFinished);
    return () => {
      ctrl.abort();
      window.removeEventListener('mazz:run-finished', onFinished);
    };
  }, [sessionId, load]);

  return { session, setSession, error, loading, reload: () => sessionId && load(sessionId) };
}
