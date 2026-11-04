import { describe, expect, it } from 'vitest';
import { ROUTER_STATUS_LABELS, routerQuotaText, routerResetText } from './router-format';

describe('router section formatting', () => {
  it('routerQuotaText_noDeclaredCap_showsND', () => {
    // Arrange / Act / Assert
    expect(routerQuotaText(undefined)).toBe('N/D');
    expect(routerQuotaText({})).toBe('N/D');
  });

  it('routerQuotaText_requestsAndRpm_areLabelledInsteadOfBareNumbers', () => {
    // Arrange
    const limits = { requests: { used: 0, limit: 14400, remaining: 14400 }, rpm: { used: 0, limit: 30, remaining: 30 } };
    // Act
    const text = routerQuotaText(limits);
    // Assert
    expect(text).toContain('requêtes restants sur');
    expect(text).toContain('30 req/min');
    expect(text).not.toBe('14400 / 30');
  });

  it('routerResetText_picksSecondsMinutesOrHours_andND', () => {
    // Arrange / Act / Assert
    expect(routerResetText(45)).toBe('45 s');
    expect(routerResetText(686 * 60)).toBe('11 h');
    expect(routerResetText(100 * 60)).toBe('100 min');
    expect(routerResetText(null)).toBe('N/D');
  });

  it('routerStatusLabels_everyBackendStatus_hasAFrenchLabel', () => {
    // Arrange
    const statuses = ['missing_key', 'missing_url', 'untested', 'active', 'cooldown', 'exhausted', 'disabled'];
    // Act / Assert
    for (const status of statuses) expect(ROUTER_STATUS_LABELS[status]).toBeTruthy();
  });
});
