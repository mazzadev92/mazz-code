import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { taskGraphStates } from './task-graph.js';

test('taskGraph_planStatuses_mapToPendingRunningCompleted', () => {
  // Arrange
  const items = [
    { id: 'a', dependencies: [], status: 'completed' as const },
    { id: 'b', dependencies: ['a'], status: 'in_progress' as const },
    { id: 'c', dependencies: ['b'], status: 'pending' as const },
  ];
  // Act
  const states = taskGraphStates(items);
  // Assert
  assert.deepEqual(states, { a: 'COMPLETED', b: 'RUNNING', c: 'PENDING' });
});

test('taskGraph_failedDependency_blocksDependentsTransitively', () => {
  // Arrange: d depends on c which depends on failed b; e is independent; f cites a missing task.
  const items = [
    { id: 'a', dependencies: [], status: 'completed' as const },
    { id: 'b', dependencies: ['a'], status: 'in_progress' as const },
    { id: 'c', dependencies: ['b'], status: 'pending' as const },
    { id: 'd', dependencies: ['c'], status: 'pending' as const },
    { id: 'e', dependencies: ['a'], status: 'pending' as const },
    { id: 'f', dependencies: ['missing'], status: 'pending' as const },
  ];
  // Act
  const states = taskGraphStates(items, ['b']);
  // Assert
  assert.deepEqual(states, { a: 'COMPLETED', b: 'FAILED', c: 'BLOCKED', d: 'BLOCKED', e: 'PENDING', f: 'BLOCKED' });
});

test('taskGraph_dependencyCycle_isBlockedNotInfinite', () => {
  // Arrange
  const items = [
    { id: 'x', dependencies: ['y'], status: 'pending' as const },
    { id: 'y', dependencies: ['x'], status: 'pending' as const },
  ];
  // Act
  const states = taskGraphStates(items);
  // Assert
  assert.equal(states.x, 'BLOCKED');
  assert.equal(states.y, 'BLOCKED');
});
