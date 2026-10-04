/**
 * Turns Braintrust experiment rows into one offline-eval document.
 * One experiment is one model. Score names become evaluators. A null score
 * is left out, so a missing label is not stored as a pass. Polarity is set
 * only when the caller names issue labels. A numeric score is not guessed
 * to be better when it is higher.
 */

export interface BraintrustExperimentRow {
  id: string;
  input?: unknown;
  expected?: unknown;
  scores?: Record<string, number | boolean | null>;
  metrics?: { start?: number; end?: number };
}

export interface BraintrustExperiment {
  id: string;
  name: string;
  model?: string;
  promptText?: string;
  promptVersion?: string;
  baseline?: boolean;
  rows: BraintrustExperimentRow[];
}

export function braintrustExperimentsToDocument(input: {
  datasetName: string;
  experiments: BraintrustExperiment[];
  ranAt?: string;
  gitSha?: string;
  idempotencyKey?: string;
  issueLabels?: Record<string, Array<boolean | number | string>>;
}): Record<string, unknown> {
  const rowIds = new Set<string>();
  const evaluatorIds = new Set<string>();
  for (const experiment of input.experiments) {
    for (const row of experiment.rows) {
      rowIds.add(row.id);
      for (const [name, value] of Object.entries(row.scores ?? {})) {
        if (value !== null && value !== undefined) evaluatorIds.add(name);
      }
    }
  }

  return {
    schema_version: 1,
    idempotency_key: input.idempotencyKey ?? input.experiments.map((item) => item.id).join('+'),
    source: 'braintrust',
    runner_name: 'braintrust',
    runner_version: 'experiment',
    git_sha: input.gitSha,
    ran_at: input.ranAt ?? new Date().toISOString(),
    content_mode: 'full',
    dataset: {
      name: input.datasetName,
      rows: [...rowIds].map((id) => {
        const sample = input.experiments
          .flatMap((experiment) => experiment.rows)
          .find((row) => row.id === id);
        return { id, body: { input: sample?.input, expected: sample?.expected } };
      }),
    },
    evaluators: [...evaluatorIds].map((id) => {
      const issues = input.issueLabels?.[id];
      return issues
        ? { id, source: 'custom', kind: 'detector', issue_labels: issues }
        : { id, source: 'custom', kind: 'rubric' };
    }),
    arms: input.experiments.map((experiment) => ({
      name: experiment.name,
      provider: 'braintrust',
      model_id: experiment.model,
      prompt_text: experiment.promptText,
      prompt_version: experiment.promptVersion,
      baseline: experiment.baseline === true,
      labels: experiment.rows.flatMap((row) =>
        Object.entries(row.scores ?? {})
          .filter((entry): entry is [string, number | boolean] => entry[1] !== null && entry[1] !== undefined)
          .map(([evaluatorId, value]) => ({
            row_id: row.id,
            evaluator_id: evaluatorId,
            value,
            grade_source: 'single_judge',
            latency_ms:
              row.metrics?.start !== undefined && row.metrics.end !== undefined
                ? Math.max(0, Math.round((row.metrics.end - row.metrics.start) * 1000))
                : undefined,
          })),
      ),
    })),
  };
}
