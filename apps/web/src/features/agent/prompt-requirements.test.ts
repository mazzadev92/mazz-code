import { describe, expect, it } from 'vitest';
import { promptRequirementTransitionPayload, PROMPT_STATUS_TRANSITIONS } from './PromptRequirementsPanel';

describe('prompt requirement session UI transitions', () => {
  it('offers only the next statuses allowed by the persisted ledger contract', () => {
    expect(PROMPT_STATUS_TRANSITIONS.Candidate).toContain('Needs review');
    expect(PROMPT_STATUS_TRANSITIONS.Candidate).not.toContain('Planned');
    expect(PROMPT_STATUS_TRANSITIONS.Implemented).toContain('Tested');
    expect(PROMPT_STATUS_TRANSITIONS.Superseded).toEqual([]);
  });

  it('binds updates to a session and optimistic version, and requires a physical file for test states', () => {
    const item = { id: 'requirement:1', status: 'Implemented' as const, version: 4 };
    expect(() => promptRequirementTransitionPayload('session-a', item, 'Tested', '')).toThrow(/fichier du workspace/);
    expect(promptRequirementTransitionPayload('session-a', item, 'Tested', 'D:\\project\\evidence\\test.txt')).toEqual({
      sessionId: 'session-a', status: 'Tested', expectedVersion: 4, actor: 'studio-ui',
      evidence: [{
        kind: 'test_result', path: 'D:\\project\\evidence\\test.txt',
        description: 'Preuve associée à Tested depuis l’inspecteur MAZZ.',
      }],
    });
    expect(() => promptRequirementTransitionPayload('session-a', item, 'Candidate', '')).toThrow(/Transition UI refusée/);
  });
});
