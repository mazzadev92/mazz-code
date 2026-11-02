/**
 * Task graph states (spec 07 §3): the plan keeps pending / in_progress / completed, the graph view adds
 * FAILED (reported by the caller) and BLOCKED, set automatically on every task that depends, directly
 * or transitively, on a FAILED or BLOCKED task.
 */

export type TaskState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'FAILED';

export interface TaskGraphItem {
  id: string;
  dependencies: string[];
  status: 'pending' | 'in_progress' | 'completed';
}

export function taskGraphStates(items: readonly TaskGraphItem[], failed: Iterable<string> = []): Record<string, TaskState> {
  const failedIds = new Set(failed);
  const byId = new Map(items.map((item) => [item.id, item]));
  const states: Record<string, TaskState> = {};
  const visiting = new Set<string>();
  const stateOf = (id: string): TaskState => {
    if (states[id]) return states[id];
    const item = byId.get(id);
    // A dependency missing from the plan, or a dependency cycle, can never be satisfied.
    if (!item || visiting.has(id)) return 'BLOCKED';
    visiting.add(id);
    let state: TaskState;
    if (item.status === 'completed') state = 'COMPLETED';
    else if (failedIds.has(id)) state = 'FAILED';
    else if (item.dependencies.some((dep) => ['FAILED', 'BLOCKED'].includes(stateOf(dep)))) state = 'BLOCKED';
    else state = item.status === 'in_progress' ? 'RUNNING' : 'PENDING';
    visiting.delete(id);
    states[id] = state;
    return state;
  };
  for (const item of items) stateOf(item.id);
  return states;
}
