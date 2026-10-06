import { describe, expect, it } from 'vitest';
import { checkOfflineEval } from '../docs/integrations/check-offline-eval.mjs';
import { braintrustExperimentsToDocument } from '../src/integrations/braintrust-experiment.js';

// Braintrust eval events carry `origin: { object_type: 'dataset', id: <dataset record id> }`;
// the event `id` is unique per event. `dataset_record_id` is the legacy field.
// https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/framework.ts (runEvaluator origin)
// https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/logger.ts (dataset_record_id)

type Arm = { name: string; provider?: string; labels: Array<{ row_id: string; evaluator_id: string }> };
const armsOf = (document: Record<string, unknown>) => document.arms as Arm[];
const rowsOf = (document: Record<string, unknown>) => (document.dataset as { rows: Array<{ id: string }> }).rows;

const origin = (id: string) => ({ object_type: 'dataset', object_id: 'ds-1', id });

describe('braintrustExperimentsToDocument row keys', () => {
  it('joins arms on origin.id, not the per-event id', () => {
    const document = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      issueLabels: { 'refund-error': [1] },
      experiments: [
        {
          id: 'exp-a',
          name: 'gpt',
          baseline: true,
          rows: [{ id: 'evt-a1', origin: origin('rec-1'), input: 'Refund?', scores: { 'refund-error': 0 } }],
        },
        {
          id: 'exp-b',
          name: 'claude',
          rows: [{ id: 'evt-b1', origin: origin('rec-1'), input: 'Refund?', scores: { 'refund-error': 1 } }],
        },
      ],
    });
    expect(rowsOf(document).map((row) => row.id)).toEqual(['rec-1']);
    expect(armsOf(document).map((arm) => arm.labels.map((label) => label.row_id))).toEqual([['rec-1'], ['rec-1']]);
    expect(checkOfflineEval(document).errors).toEqual([]);
  });

  it('falls back to dataset_record_id, then to the caller rowKey', () => {
    const legacy = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      experiments: [{ id: 'exp-a', name: 'gpt', rows: [{ id: 'evt-1', dataset_record_id: 'rec-9', scores: { tone: 3 } }] }],
    });
    expect(rowsOf(legacy).map((row) => row.id)).toEqual(['rec-9']);

    const inline = braintrustExperimentsToDocument({
      datasetName: 'refunds',
      ranAt: '2026-10-03T00:00:00.000Z',
      rowKey: (row) => String((row.input as { ticket: string }).ticket),
      experiments: [{ id: 'exp-a', name: 'gpt', rows: [{ id: 'evt-1', input: { ticket: 't-7' }, scores: { tone: 3 } }] }],
    });
    expect(rowsOf(inline).map((row) => row.id)).toEqual(['t-7']);
  });

  it('refuses to key on the event id when no dataset row is named', () => {
    const build = (row: Record<string, unknown>) => () =>
      braintrustExperimentsToDocument({
        datasetName: 'refunds',
        experiments: [{ id: 'exp-a', name: 'gpt', rows: [{ scores: { tone: 1 }, ...row }] }],
      });
    expect(build({ id: 'evt-1' })).toThrow(/rowKey/);
    expect(build({ id: 'evt-1', origin: { object_type: 'experiment', id: 'evt-0' } })).toThrow(/rowKey/);
  });
});

describe('braintrustExperimentsToDocument arms and keys', () => {
  const experiments = [
    { id: 'exp-a', name: 'gpt', model: 'gpt-4.1', provider: 'openai', baseline: true, rows: [{ origin: origin('r1'), scores: { tone: 2 } }] },
    { id: 'exp-b', name: 'claude', model: 'claude-sonnet', rows: [{ origin: origin('r1'), scores: { tone: 3 } }] },
  ];

  it('sets provider to the model provider, never to braintrust', () => {
    const document = braintrustExperimentsToDocument({ datasetName: 'refunds', ranAt: '2026-10-03T00:00:00.000Z', experiments });
    expect(armsOf(document).map((arm) => arm.provider)).toEqual(['openai', undefined]);
  });

  it('builds the default idempotency key from experiments, git sha, slice, and chunk 0', () => {
    const key = (extra: { gitSha?: string; slice?: string }, list = experiments) =>
      braintrustExperimentsToDocument({ datasetName: 'refunds', ranAt: '2026-10-03T00:00:00.000Z', experiments: list, ...extra })
        .idempotency_key;
    const base = key({ gitSha: '3f2c1ab' });
    expect(base).toMatch(/^braintrust:[0-9a-f]{64}$/);
    expect(key({ gitSha: '3f2c1ab' }, [...experiments].reverse())).toBe(base);
    expect(key({ gitSha: '3f2c1ab', slice: 'full' })).toBe(base);
    expect(key({ gitSha: '9e8d7c6' })).not.toBe(base);
    expect(key({ gitSha: '3f2c1ab', slice: 'smoke' })).not.toBe(base);
  });
});
