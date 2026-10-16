import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareArtifact, prepareArtifactContent } from '../../src/artifacts.js';
import { AIConfig } from '../../src/config.js';
import { MockAmplitudeAI } from '../../src/testing.js';
import * as logging from '../../src/utils/logger.js';

const artifact = (html = '<script>private-payload</script>') => ({
  $agent_artifact: { v: 1, type: 'html', title: 'private-title', payload: { html } },
});
const logger = () => {
  const result = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  vi.spyOn(logging, 'getLogger').mockReturnValue(result);
  return result;
};

afterEach(() => vi.restoreAllMocks());

describe('artifact omission diagnostics', () => {
  it('does not introduce a WeakMap exception for untyped primitive config callers', () => {
    logger();
    expect(prepareArtifactContent('Safe', 'legacy' as never)).toBe('Safe');
  });
  it('reports partial attachment drops once per reason per call and warns once per config', () => {
    const log = logger();
    const config = { redactPii: true };
    const input = [
      ...Array.from({ length: 20 }, () => ({ type: 'artifact', ...artifact() })),
      { type: 'text', content: 'Safe sibling' },
    ];
    expect(prepareArtifactContent(input, config)).toEqual([
      { type: 'text', content: 'Safe sibling' },
    ]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).not.toHaveBeenCalled();
    prepareArtifactContent(input, config);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(1);
    prepareArtifactContent(input, { redactPii: true });
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0]?.[0]).toContain('(unsupported_or_sensitive_artifact)');
    expect(JSON.stringify([...log.warn.mock.calls, ...log.debug.mock.calls])).not.toContain(
      'private',
    );
  });

  it('reports unexpected exceptions using only a fixed reason', () => {
    const log = logger();
    const value = Object.defineProperty({}, 'private-key', {
      enumerable: true,
      get() {
        throw new Error('private-exception');
      },
    });
    expect(prepareArtifactContent(value, {})).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain('(preparation_failed)');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private');
  });

  it.each(['metadata_only', 'customer_enriched'])(
    'keeps intentional %s content omission quiet',
    (contentMode) => {
      const log = logger();
      expect(prepareArtifactContent(artifact(), { contentMode })).toBeUndefined();
      expect(prepareArtifact({}, { contentMode })).toBeUndefined();
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.debug).not.toHaveBeenCalled();
    },
  );

  it('uses fixed reasons for malformed JSON, size, and unresolved traversal limits', () => {
    const log = logger();
    prepareArtifactContent('{"$agent_artifact": private-json', {});
    prepareArtifactContent({ status: 'x'.repeat(300_000), ...artifact('<p>Safe</p>') }, {});
    prepareArtifactContent([...Array(10_001).fill('safe'), artifact()], {});
    const messages = log.warn.mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(3);
    expect(messages.some((message) => message.includes('(ambiguous_json)'))).toBe(true);
    expect(messages.some((message) => message.includes('(artifact_size_limit)'))).toBe(true);
    expect(messages.some((message) => message.includes('(traversal_limit)'))).toBe(true);
    expect(messages.join(' ')).not.toContain('private');
  });

  it('does not emit omission diagnostics for preserved ordinary Unicode content', () => {
    const log = logger();
    expect(prepareArtifactContent('{"text":"\\u00e9', {})).toBe('{"text":"\\u00e9');
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('never lets logger failures affect retained sibling data or SDK events', () => {
    const log = logger();
    log.warn.mockImplementation(() => {
      throw new Error('private-logger');
    });
    log.debug.mockImplementation(() => {
      throw new Error('private-debug');
    });
    const config = { redactPii: true };
    for (let i = 0; i < 2; i++)
      expect(prepareArtifactContent({ status: 'ok', ...artifact() }, config)).toEqual({
        status: 'ok',
      });
    const ai = new MockAmplitudeAI(new AIConfig());
    ai.agent('reporter', { userId: 'synthetic-user' }).trackToolCall('report', 10, true, {
      output: { status: 'ok', ...artifact() },
    });
    expect(ai.getEvents()).toHaveLength(1);
    expect(ai.getEvents()[0]!.event_properties!['[Agent] Tool Output']).toBe('{"status":"ok"}');
  });
});
