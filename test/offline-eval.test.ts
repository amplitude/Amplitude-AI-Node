import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { braintrustExperimentsToDocument } from '../src/integrations/braintrust-experiment.js';
import { OfflineEvalUploadError, reportOfflineEval } from '../src/offline-eval.js';
import { checkOfflineEval } from '../docs/integrations/check-offline-eval.mjs';

describe('reportOfflineEval', () => {
  it('posts the document with the project key and secret and does not retry a 409', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 409,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error_code: 'idempotency_conflict' }),
    }));

    await expect(
      reportOfflineEval(
        { schema_version: 1 },
        { apiKey: 'key', secretKey: 'secret', fetchImpl: fetchImpl as never },
      ),
    ).rejects.toMatchObject({ status: 409, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('key:secret').toString('base64')}`,
    );
    expect(headers.authorization).not.toContain('secret');
  });

  it('surfaces the validation errors of a 400', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          error_code: 'invalid_document',
          validation_errors: [
            { field: 'evaluators.issue_labels', code: 'detector_polarity_required' },
          ],
        }),
    }));

    await expect(
      reportOfflineEval(
        { schema_version: 1 },
        { apiKey: 'key', secretKey: 'secret', fetchImpl: fetchImpl as never },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_document',
      validationErrors: [
        { field: 'evaluators.issue_labels', code: 'detector_polarity_required' },
      ],
    });
  });

  it('retries a 503 whose body is not JSON', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => '0' },
        text: async () => '<html>unavailable</html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ result_id: 'run-1', replayed: false }),
      });

    const result = await reportOfflineEval(
      { schema_version: 1 },
      { apiKey: 'key', secretKey: 'secret', fetchImpl: fetchImpl as never },
    );
    expect(result.result_id).toBe('run-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 and then returns the result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => '0' },
        text: async () => JSON.stringify({ error_code: 'upstream_error' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ result_id: 'run-1', replayed: false }),
      });

    const result = await reportOfflineEval(
      { schema_version: 1 },
      { apiKey: 'key', secretKey: 'secret', fetchImpl: fetchImpl as never },
    );
    expect(result.result_id).toBe('run-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps Retry-After at 60 seconds', async () => {
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: TimerHandler, ms?: number) => {
      delays.push(Number(ms));
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '100000' },
        text: async () => JSON.stringify({ error_code: 'rate_limited' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ result_id: 'run-1', replayed: false }),
      });

    const result = await reportOfflineEval(
      { schema_version: 1 },
      { apiKey: 'key', secretKey: 'secret', fetchImpl: fetchImpl as never },
    );
    expect(result.result_id).toBe('run-1');
    expect(delays).toEqual([60_000]);
    vi.restoreAllMocks();
  });

  it('fails before the network when the secret is missing', async () => {
    vi.stubEnv('AMPLITUDE_API_KEY', '');
    vi.stubEnv('AMPLITUDE_SECRET_KEY', '');
    await expect(reportOfflineEval({})).rejects.toBeInstanceOf(OfflineEvalUploadError);
  });
});

describe('offline eval document', () => {
  it('keeps the vendored schema on version 1', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../docs/integrations/offline-eval-document.schema.json', import.meta.url),
        'utf8',
      ),
    ) as { properties: { schema_version: { const: number } }; required: string[] };
    expect(schema.properties.schema_version.const).toBe(1);
    expect(schema.required).toEqual(
      expect.arrayContaining(['schema_version', 'dataset', 'evaluators', 'arms']),
    );
  });

  it('accepts the complete example in the guide', () => {
    const guide = readFileSync(
      new URL('../docs/integrations/offline-eval.md', import.meta.url),
      'utf8',
    );
    const section = guide.slice(guide.indexOf('### Example: one complete run'));
    const block = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(block).toBeDefined();
    expect(checkOfflineEval(JSON.parse(block ?? ''))).toEqual({ errors: [], warnings: [] });
  });

  it('maps one Braintrust experiment per model and skips a null score', () => {
    const document = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      issueLabels: { 'refund-error': [1] },
      experiments: [
        {
          id: 'exp-a',
          name: 'gpt',
          model: 'gpt-4.1',
          baseline: true,
          rows: [
            { origin: { object_type: 'dataset', id: 'row-1' }, input: 'hello', scores: { 'refund-error': 0, tone: null } },
          ],
        },
      ],
    });
    expect(checkOfflineEval(document)).toEqual({ errors: [], warnings: [] });
    const arm = (document.arms as Array<{ labels: unknown[] }> )[0];
    expect(arm?.labels).toHaveLength(1);
  });

  it('reports an empty issue label list as an error', () => {
    const document = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      issueLabels: { tone: [] },
      experiments: [
        {
          id: 'exp-a',
          name: 'gpt',
          baseline: true,
          rows: [{ origin: { object_type: 'dataset', id: 'row-1' }, scores: { tone: true } }],
        },
      ],
    });
    expect(checkOfflineEval(document).errors.map((error) => error.code)).toContain(
      'detector_polarity_required',
    );
  });

  it('warns when gold_verified has no reviewer and still passes', () => {
    const document = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      issueLabels: { tone: [true] },
      experiments: [
        {
          id: 'exp-a',
          name: 'gpt',
          baseline: true,
          rows: [{ origin: { object_type: 'dataset', id: 'row-1' }, scores: { tone: true } }],
        },
      ],
    });
    const arm = (document.arms as Array<{ labels: Array<Record<string, unknown>> }>)[0];
    const label = arm?.labels[0];
    if (label) label.grade_source = 'gold_verified';
    const result = checkOfflineEval(document);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      { field: 'arms.labels.grade_source', code: 'gold_verified_downgraded' },
    ]);
  });

  it('keeps one idempotency key when Braintrust experiments are reordered', () => {
    const experiments = [
      {
        id: 'exp-b',
        name: 'claude',
        rows: [{ origin: { object_type: 'dataset', id: 'row-1' }, scores: { tone: 0.4 } }],
      },
      {
        id: 'exp-a',
        name: 'gpt',
        baseline: true,
        rows: [{ origin: { object_type: 'dataset', id: 'row-1' }, scores: { tone: 0.8 } }],
      },
    ];
    const forward = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      experiments,
    });
    const backward = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      experiments: [...experiments].reverse(),
    });
    expect(forward.idempotency_key).toBe(backward.idempotency_key);
    expect(String(forward.idempotency_key)).toMatch(/^braintrust:[0-9a-f]{64}$/);
    const rubric = (forward.evaluators as Array<Record<string, unknown>>)[0];
    expect(rubric?.kind).toBe('rubric');
    expect(rubric?.score_min).toBeUndefined();
    expect(checkOfflineEval(forward).warnings.map((warning) => warning.code)).toContain(
      'rubric_bounds_missing',
    );
    expect(checkOfflineEval(forward).errors).toEqual([]);
  });

  it('rejects two rows that name the same session', () => {
    const document = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      issueLabels: { tone: [true] },
      experiments: [
        {
          id: 'exp-a',
          name: 'gpt',
          baseline: true,
          rows: [
            { origin: { object_type: 'dataset', id: 'row-1' }, scores: { tone: true } },
            { origin: { object_type: 'dataset', id: 'row-2' }, scores: { tone: false } },
          ],
        },
      ],
    });
    const rows = document.dataset as { rows: Array<Record<string, unknown>> };
    rows.rows[0] = { ...rows.rows[0], session_id: 'sess-1' };
    rows.rows[1] = { ...rows.rows[1], session_id: 'sess-1' };
    expect(checkOfflineEval(document).errors.map((error) => error.code)).toContain(
      'duplicate_session',
    );
  });

  it('warns that an ootb evaluator is stored as custom', () => {
    const document = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      issueLabels: { tone: [true] },
      experiments: [
        {
          id: 'exp-a',
          name: 'gpt',
          baseline: true,
          rows: [{ origin: { object_type: 'dataset', id: 'row-1' }, scores: { tone: true } }],
        },
      ],
    });
    const evaluators = document.evaluators as Array<Record<string, unknown>>;
    evaluators[0] = { ...evaluators[0], source: 'ootb' };
    const checked = checkOfflineEval(document);
    expect(checked.errors).toEqual([]);
    expect(checked.warnings.map((warning) => warning.code)).toContain(
      'evaluator_source_downgraded',
    );
  });

  it('omits a Braintrust latency that does not fit an integer column', () => {
    const document = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      issueLabels: { tone: [true] },
      experiments: [
        {
          id: 'exp-a',
          name: 'gpt',
          baseline: true,
          rows: [
            {
              origin: { object_type: 'dataset', id: 'row-1' },
              scores: { tone: true },
              metrics: { start: 0, end: 1_700_000_000 },
            },
          ],
        },
      ],
    });
    const label = (document.arms as Array<{ labels: Array<Record<string, unknown>> }>)[0]
      ?.labels[0];
    expect(label?.latency_ms).toBeUndefined();
    expect(label?.value).toBe(true);
  });
});
