import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/exceptions.js';
import { AmplitudeCrewAIHooks } from '../../src/integrations/crewai.js';

describe('AmplitudeCrewAIHooks', () => {
  it('throws ProviderError on construction', (): void => {
    expect(() => new AmplitudeCrewAIHooks()).toThrow(ProviderError);
  });

  it('error message mentions Python-only', (): void => {
    expect(() => new AmplitudeCrewAIHooks()).toThrow(/Python-only/);
  });

  it('error message suggests LangChain alternative', (): void => {
    expect(() => new AmplitudeCrewAIHooks()).toThrow(/LangChain/);
  });

  it('error message suggests OpenTelemetry alternative', (): void => {
    expect(() => new AmplitudeCrewAIHooks()).toThrow(/OpenTelemetry/);
  });

  it('error is instance of ProviderError', (): void => {
    try {
      new AmplitudeCrewAIHooks();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
    }
  });

  it('error has correct name', (): void => {
    try {
      new AmplitudeCrewAIHooks();
    } catch (e) {
      expect((e as Error).name).toBe('ProviderError');
    }
  });

  it('error message mentions Node.js unavailability', (): void => {
    expect(() => new AmplitudeCrewAIHooks()).toThrow(
      /not available in Node\.js/,
    );
  });
});
