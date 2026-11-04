import { describe, expect, it } from 'vitest';
import { buildSendBody, isJobActive, jobPercent, jobTone, providerAcceptsSource } from './compute-format';

describe('compute formatting', () => {
  it('jobPercent_outOfRangeOrNaN_isClamped', () => {
    expect(jobPercent(0.456)).toBe(46);
    expect(jobPercent(3)).toBe(100);
    expect(jobPercent(-1)).toBe(0);
    expect(jobPercent(Number.NaN)).toBe(0);
  });

  it('jobTone_eachStatus_mapsToATone', () => {
    expect(jobTone('done')).toBe('good');
    expect(jobTone('failed')).toBe('bad');
    expect(jobTone('running')).toBe('info');
    expect(jobTone('queued')).toBe('neutral');
  });

  it('isJobActive_onlyQueuedAndRunning', () => {
    expect(isJobActive('queued') && isJobActive('running')).toBe(true);
    expect(isJobActive('done') || isJobActive('failed')).toBe(false);
  });

  it('buildSendBody_blankServedName_isOmitted', () => {
    const source = { type: 'local', filename: 'a.gguf' } as const;
    expect(buildSendBody(source, 'kaggle', '   ').options).toEqual({});
    expect(buildSendBody(source, 'kaggle', ' mon-modele ').options).toEqual({ served_name: 'mon-modele' });
  });

  it('providerAcceptsSource_ggufVsHfRepo_followsAccepts', () => {
    const gguf = { type: 'local', filename: 'a.gguf' } as const;
    const repo = { type: 'hf', repo: 'org/m', file: '' } as const;
    expect(providerAcceptsSource(['gguf'], gguf)).toBe(true);
    expect(providerAcceptsSource(['gguf'], repo)).toBe(false);
    expect(providerAcceptsSource(['hf'], repo)).toBe(true);
    expect(providerAcceptsSource(['hf'], gguf)).toBe(false);
  });
});
