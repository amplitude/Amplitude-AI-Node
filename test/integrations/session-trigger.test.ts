import { describe, expect, it } from 'vitest';
import { PROP_SESSION_TRIGGER, SESSION_TRIGGERS } from '../../src/core/constants.js';
import { isSessionTrigger, resolveSessionTrigger } from '../../src/integrations/session-trigger.js';

describe('resolveSessionTrigger', () => {
  it('ships the five triggers under one property', () => {
    expect(PROP_SESSION_TRIGGER).toBe('[Agent] Session Trigger');
    expect(SESSION_TRIGGERS).toEqual(['interactive', 'headless', 'ci', 'scheduled', 'event']);
  });

  it.each(SESSION_TRIGGERS)('accepts %s from each source', (value) => {
    expect(isSessionTrigger(value)).toBe(true);
    expect(resolveSessionTrigger({ explicit: value })).toBe(value);
    expect(resolveSessionTrigger({ env: { AMPLITUDE_SESSION_TRIGGER: value } })).toBe(value);
    expect(resolveSessionTrigger({ harnessHint: value })).toBe(value);
  });

  it('ignores an invalid explicit or env value', () => {
    expect(resolveSessionTrigger({ explicit: 'cron', env: { AMPLITUDE_SESSION_TRIGGER: 'headless' } })).toBe('headless');
    expect(resolveSessionTrigger({ explicit: 'CI', env: { AMPLITUDE_SESSION_TRIGGER: 'Interactive' } })).toBeNull();
    expect(resolveSessionTrigger({ explicit: 42, env: { AMPLITUDE_SESSION_TRIGGER: ' ci' }, harnessHint: 'headless' })).toBe(
      'headless',
    );
  });

  it('reads CI from GITHUB_ACTIONS or a CI value other than empty, false or 0', () => {
    expect(resolveSessionTrigger({ env: { GITHUB_ACTIONS: 'true' } })).toBe('ci');
    expect(resolveSessionTrigger({ env: { GITHUB_ACTIONS: 'false' } })).toBeNull();
    for (const ci of ['true', '1', 'yes']) expect(resolveSessionTrigger({ env: { CI: ci } })).toBe('ci');
    for (const ci of ['', 'false', '0']) expect(resolveSessionTrigger({ env: { CI: ci } })).toBeNull();
  });

  it('ranks explicit over env over CI over the harness hint', () => {
    const env = { CI: 'true', AMPLITUDE_SESSION_TRIGGER: 'scheduled' };
    expect(resolveSessionTrigger({ explicit: 'event', env, harnessHint: 'interactive' })).toBe('event');
    expect(resolveSessionTrigger({ env, harnessHint: 'interactive' })).toBe('scheduled');
    expect(resolveSessionTrigger({ env: { CI: 'true' }, harnessHint: 'interactive' })).toBe('ci');
    expect(resolveSessionTrigger({ explicit: 'interactive', env: { GITHUB_ACTIONS: 'true' } })).toBe('interactive');
  });

  it('is null when nothing says how the session started', () => {
    expect(resolveSessionTrigger()).toBeNull();
    expect(resolveSessionTrigger({ env: {}, harnessHint: { subagent: {} } })).toBeNull();
  });
});
