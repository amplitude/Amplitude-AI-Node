import { createHash } from 'node:crypto';

/**
 * Turns Braintrust experiment rows into one offline-eval document.
 * One experiment is one model. Score names become evaluators. A null score
 * is left out, so a missing label is not stored as a pass. Polarity is set
 * only when the caller names issue labels. A numeric score is not guessed
 * to be better when it is higher.
 *
 * Rows join across arms on the dataset record they came from, not on the
 * experiment event `id`, which is unique per event and never matches across
 * experiments.
 */

export interface BraintrustExperimentRow {
  /** The experiment event id. Unique per event, so it is not used as the row id. */
  id?: string;
  /** The dataset record this event was run on (`origin.id` when `origin.object_type` is `dataset`). */
  origin?: { object_type?: string; object_id?: string; id?: string };
  /** Legacy dataset record id that older Braintrust SDKs logged on experiment events. */
  dataset_record_id?: string;
  input?: unknown;
  expected?: unknown;
  scores?: Record<string, number | boolean | null>;
  metrics?: { start?: number; end?: number };
}

export interface BraintrustExperiment {
  id: string;
  name: string;
  model?: string;
  /** The model provider, for example `openai`. Left unset when unknown. */
  provider?: string;
  promptText?: string;
  promptVersion?: string;
  baseline?: boolean;
  rows: BraintrustExperimentRow[];
}

function datasetRowId(
  row: BraintrustExperimentRow,
  rowKey: ((row: BraintrustExperimentRow) => string | undefined) | undefined,
): string {
  const fromCaller = rowKey?.(row);
  if (fromCaller) return fromCaller;
  const origin = row.origin;
  if (origin?.id && (origin.object_type === undefined || origin.object_type === 'dataset')) return origin.id;
  if (row.dataset_record_id) return row.dataset_record_id;
  throw new Error(
    `Braintrust row ${row.id ?? '(no id)'} has no origin.id or dataset_record_id; pass rowKey to name the dataset row it belongs to`,
  );
}

function defaultIdempotencyKey(
  experiments: readonly BraintrustExperiment[],
  gitSha: string | undefined,
  slice: string,
): string {
  const ids = experiments.map((experiment) => experiment.id).sort();
  const joined = [...ids, `sha:${gitSha ?? ''}`, `slice:${slice}`, 'chunk:0'].join('\n');
  return `braintrust:${createHash('sha256').update(joined).digest('hex')}`;
}

function latencyMs(metrics?: { start?: number; end?: number }): number | undefined {
  if (metrics?.start === undefined || metrics.end === undefined) return undefined;
  const value = Math.round((metrics.end - metrics.start) * 1000);
  if (!Number.isFinite(value) || value > 2_147_483_647) return undefined;
  return Math.max(0, value);
}

export function braintrustExperimentsToDocument(input: {
  datasetName: string;
  experiments: BraintrustExperiment[];
  ranAt?: string;
  gitSha?: string;
  /** `smoke`, `full`, or the dataset version. Part of the default idempotency key. Defaults to `full`. */
  slice?: string;
  idempotencyKey?: string;
  issueLabels?: Record<string, Array<boolean | number | string>>;
  /** Names the dataset row of an event that has no `origin.id` or `dataset_record_id`. */
  rowKey?: (row: BraintrustExperimentRow) => string | undefined;
}): Record<string, unknown> {
  const keyed = input.experiments.map((experiment) =>
    experiment.rows.map((row) => ({ rowId: datasetRowId(row, input.rowKey), row })),
  );
  const samples = new Map<string, BraintrustExperimentRow>();
  const evaluatorIds = new Set<string>();
  for (const rows of keyed) {
    for (const { rowId, row } of rows) {
      if (!samples.has(rowId)) samples.set(rowId, row);
      for (const [name, value] of Object.entries(row.scores ?? {})) {
        if (value !== null && value !== undefined) evaluatorIds.add(name);
      }
    }
  }

  return {
    schema_version: 1,
    idempotency_key:
      input.idempotencyKey ?? defaultIdempotencyKey(input.experiments, input.gitSha, input.slice ?? 'full'),
    source: 'braintrust',
    runner_name: 'braintrust',
    runner_version: 'experiment',
    git_sha: input.gitSha,
    ran_at: input.ranAt ?? new Date().toISOString(),
    content_mode: 'full',
    dataset: {
      name: input.datasetName,
      rows: [...samples].map(([id, sample]) => ({
        id,
        body: { input: sample.input, expected: sample.expected },
      })),
    },
    evaluators: [...evaluatorIds].map((id) => {
      const issues = input.issueLabels?.[id];
      return issues
        ? { id, source: 'custom', kind: 'detector', issue_labels: issues }
        : { id, source: 'custom', kind: 'rubric' };
    }),
    arms: input.experiments.map((experiment, index) => ({
      name: experiment.name,
      provider: experiment.provider,
      model_id: experiment.model,
      prompt_text: experiment.promptText,
      prompt_version: experiment.promptVersion,
      baseline: experiment.baseline === true,
      labels: (keyed[index] ?? []).flatMap(({ rowId, row }) =>
        Object.entries(row.scores ?? {})
          .filter((entry): entry is [string, number | boolean] => entry[1] !== null && entry[1] !== undefined)
          .map(([evaluatorId, value]) => ({
            row_id: rowId,
            evaluator_id: evaluatorId,
            value,
            grade_source: 'single_judge',
            latency_ms: latencyMs(row.metrics),
          })),
      ),
    })),
  };
}
