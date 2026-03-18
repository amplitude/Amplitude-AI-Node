import {
  AmplitudeAIError,
  ConfigurationError,
  ProviderError,
  TrackingError,
  ValidationError,
} from '@amplitude/ai';
import { describe, expect, it } from 'vitest';

describe('exception hierarchy', () => {
  describe('AmplitudeAIError', () => {
    it('sets name to AmplitudeAIError', (): void => {
      const err = new AmplitudeAIError('test message');
      expect(err.name).toBe('AmplitudeAIError');
    });

    it('sets message correctly', (): void => {
      const err = new AmplitudeAIError('custom message');
      expect(err.message).toBe('custom message');
    });

    it('is an instance of Error', (): void => {
      const err = new AmplitudeAIError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AmplitudeAIError);
    });
  });

  describe('ConfigurationError', () => {
    it('sets name to ConfigurationError', (): void => {
      const err = new ConfigurationError('config fail');
      expect(err.name).toBe('ConfigurationError');
    });

    it('inherits from AmplitudeAIError', (): void => {
      const err = new ConfigurationError('config fail');
      expect(err).toBeInstanceOf(AmplitudeAIError);
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('TrackingError', () => {
    it('sets name to TrackingError', (): void => {
      const err = new TrackingError('track fail');
      expect(err.name).toBe('TrackingError');
    });

    it('inherits from AmplitudeAIError', (): void => {
      const err = new TrackingError('track fail');
      expect(err).toBeInstanceOf(AmplitudeAIError);
      expect(err).toBeInstanceOf(TrackingError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('ProviderError', () => {
    it('sets name to ProviderError', (): void => {
      const err = new ProviderError('provider fail');
      expect(err.name).toBe('ProviderError');
    });

    it('inherits from AmplitudeAIError', (): void => {
      const err = new ProviderError('provider fail');
      expect(err).toBeInstanceOf(AmplitudeAIError);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('ValidationError', () => {
    it('sets name to ValidationError', (): void => {
      const err = new ValidationError('validation fail');
      expect(err.name).toBe('ValidationError');
    });

    it('inherits from AmplitudeAIError', (): void => {
      const err = new ValidationError('validation fail');
      expect(err).toBeInstanceOf(AmplitudeAIError);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('inheritance chain', () => {
    it('all subclasses are instanceof AmplitudeAIError', (): void => {
      expect(new ConfigurationError('x')).toBeInstanceOf(AmplitudeAIError);
      expect(new TrackingError('x')).toBeInstanceOf(AmplitudeAIError);
      expect(new ProviderError('x')).toBeInstanceOf(AmplitudeAIError);
      expect(new ValidationError('x')).toBeInstanceOf(AmplitudeAIError);
    });

    it('subclasses are not instanceof each other', (): void => {
      const configErr = new ConfigurationError('x');
      expect(configErr).not.toBeInstanceOf(TrackingError);
      expect(configErr).not.toBeInstanceOf(ProviderError);
      expect(configErr).not.toBeInstanceOf(ValidationError);
    });
  });
});
