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
    expect(checkOfflineEval(JSON.parse(block ?? ''))).toEqual([]);
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
            { id: 'row-1', input: 'hello', scores: { 'refund-error': 0, tone: null } },
          ],
        },
      ],
    });
    expect(checkOfflineEval(document)).toEqual([]);
    const arm = (document.arms as Array<{ labels: unknown[] }> )[0];
    expect(arm?.labels).toHaveLength(1);
  });
});
