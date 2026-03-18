import { describe, expect, it, vi } from 'vitest';
import { PrivacyConfig } from '../src/core/privacy.js';
import {
  trackAiMessage,
  trackEmbedding,
  trackScore,
  trackSessionEnd,
  trackSpan,
  trackToolCall,
  trackUserMessage,
} from '../src/core/tracking.js';
import { ValidationError } from '../src/exceptions.js';

function makeMockAmplitude(): { track: ReturnType<typeof vi.fn> } {
  return { track: vi.fn() };
}

describe('tracking validation (validate=true)', (): void => {
  const pc = new PrivacyConfig({ validate: true });

  describe('trackUserMessage', (): void => {
    it('throws ValidationError for empty userId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackUserMessage({
          amplitude: amp,
          userId: '',
          messageContent: 'hi',
          sessionId: 'sess-1',
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for empty sessionId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackUserMessage({
          amplitude: amp,
          userId: 'user-1',
          messageContent: 'hi',
          sessionId: '',
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('trackAiMessage', (): void => {
    it('throws ValidationError for empty userId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackAiMessage({
          amplitude: amp,
          userId: '',
          modelName: 'gpt-4',
          provider: 'openai',
          responseContent: 'hello',
          latencyMs: 100,
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for empty model', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackAiMessage({
          amplitude: amp,
          userId: 'user-1',
          modelName: '',
          provider: 'openai',
          responseContent: 'hello',
          latencyMs: 100,
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for negative latencyMs', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackAiMessage({
          amplitude: amp,
          userId: 'user-1',
          modelName: 'gpt-4',
          provider: 'openai',
          responseContent: 'hello',
          latencyMs: -1,
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('trackToolCall', (): void => {
    it('throws ValidationError for empty userId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackToolCall({
          amplitude: amp,
          userId: '',
          toolName: 'search',
          success: true,
          latencyMs: 50,
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for empty toolName', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackToolCall({
          amplitude: amp,
          userId: 'user-1',
          toolName: '',
          success: true,
          latencyMs: 50,
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('trackEmbedding', (): void => {
    it('throws ValidationError for empty userId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackEmbedding({
          amplitude: amp,
          userId: '',
          model: 'text-embedding-3-small',
          provider: 'openai',
          latencyMs: 20,
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('trackSpan', (): void => {
    it('throws ValidationError for empty userId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackSpan({
          amplitude: amp,
          userId: '',
          spanName: 'retrieval',
          traceId: 'trace-1',
          latencyMs: 300,
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('trackSessionEnd', (): void => {
    it('throws ValidationError for empty userId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackSessionEnd({
          amplitude: amp,
          userId: '',
          sessionId: 'sess-1',
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for empty sessionId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackSessionEnd({
          amplitude: amp,
          userId: 'user-1',
          sessionId: '',
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('trackScore', (): void => {
    it('throws ValidationError for empty userId', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackScore({
          amplitude: amp,
          userId: '',
          name: 'accuracy',
          value: 5,
          targetId: 'msg-1',
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for non-numeric value', (): void => {
      const amp = makeMockAmplitude();
      expect(() =>
        trackScore({
          amplitude: amp,
          userId: 'user-1',
          name: 'accuracy',
          value: 'five' as unknown as number,
          targetId: 'msg-1',
          privacyConfig: pc,
        }),
      ).toThrow(ValidationError);
    });
  });
});

describe('tracking validation (validate=false, default)', (): void => {
  it('does not throw for empty strings when validate is false', (): void => {
    const amp = makeMockAmplitude();
    const pc = new PrivacyConfig({ validate: false });

    expect(() =>
      trackUserMessage({
        amplitude: amp,
        userId: '',
        messageContent: 'hi',
        sessionId: '',
        privacyConfig: pc,
      }),
    ).not.toThrow();

    expect(() =>
      trackAiMessage({
        amplitude: amp,
        userId: '',
        modelName: '',
        provider: 'openai',
        responseContent: 'hello',
        latencyMs: -1,
        privacyConfig: pc,
      }),
    ).not.toThrow();

    expect(() =>
      trackToolCall({
        amplitude: amp,
        userId: '',
        toolName: '',
        success: true,
        latencyMs: 50,
        privacyConfig: pc,
      }),
    ).not.toThrow();

    expect(() =>
      trackScore({
        amplitude: amp,
        userId: '',
        name: 'accuracy',
        value: 'five' as unknown as number,
        targetId: 'msg-1',
        privacyConfig: pc,
      }),
    ).not.toThrow();
  });
});
