import { describe, expect, it } from 'vitest';
import { groupOrchestration } from './orchestration';

const log = [
  { message: 'Profil modèle : tâche découpée', t: 1000 },
  { message: 'Étape 1/12 : appel du modèle.', t: 2000 },
  { message: 'Contexte mesuré : 2322 jetons', t: 2100 },
  { message: 'Exécution de l\'outil web.search.', t: 3000 },
  { message: 'Étape 2/12 : appel du modèle.', t: 5000 },
  { message: 'Exécution de l\'outil web.fetch.', t: 6000 },
];

describe('groupOrchestration', () => {
  it('groupOrchestration_flatLog_groupsPreparationThenOneEntryPerStep', () => {
    // Arrange / Act
    const steps = groupOrchestration(log, false);
    // Assert
    expect(steps.map((s) => s.index)).toEqual([null, 1, 2]);
    expect(steps[1].title).toBe('Étape 1/12 · appel du modèle');
    expect(steps[1].tools).toEqual(['web.search']);
    expect(steps[2].tools).toEqual(['web.fetch']);
  });

  it('groupOrchestration_durations_useNextStepStartAndLastMessageWhenFinished', () => {
    // Arrange / Act
    const steps = groupOrchestration(log, false);
    // Assert
    expect(steps.map((s) => s.durationMs)).toEqual([1000, 3000, 1000]);
    expect(steps.some((s) => s.active)).toBe(false);
  });

  it('groupOrchestration_liveTurn_marksLastStepActiveAndBoundsItWithNow', () => {
    // Arrange / Act
    const steps = groupOrchestration(log, true, 9000);
    // Assert
    expect(steps[2].active).toBe(true);
    expect(steps[2].durationMs).toBe(4000);
    expect(steps[0].active).toBe(false);
  });

  it('groupOrchestration_emptyLog_returnsNoSteps', () => {
    expect(groupOrchestration([], true)).toEqual([]);
  });
});
