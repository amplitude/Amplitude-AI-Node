#!/usr/bin/env node
// Validates an offline eval document before it is posted to Amplitude.
// Zero dependencies (Node 18+). Exits 1 when any error is found.
// A warning is printed and does not fail the process.
//
//   node docs/integrations/check-offline-eval.mjs run.json

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GRADES = new Set([
  'gold_verified',
  'provisional_consensus',
  'single_judge',
  'human_feedback',
]);

export function checkOfflineEval(document) {
  const errors = [];
  const warnings = [];
  const push = (field, code) => errors.push({ field, code });
  const warn = (field, code) => warnings.push({ field, code });
  if (document?.schema_version !== 1) push('schema_version', 'schema_version');
  if (!document?.idempotency_key) push('idempotency_key', 'required');
  if (!Array.isArray(document?.arms) || document.arms.length < 1) push('arms', 'required');
  if (!Array.isArray(document?.evaluators) || document.evaluators.length < 1) {
    push('evaluators', 'required');
  }

  const chunkValues = [document?.group_id, document?.chunk_index, document?.chunk_count];
  const chunkCount = chunkValues.filter((value) => value !== undefined && value !== null).length;
  if (chunkCount !== 0 && chunkCount !== 3) push('group_id', 'incomplete_chunk');
  if (
    typeof document?.chunk_index === 'number' &&
    typeof document?.chunk_count === 'number' &&
    document.chunk_index >= document.chunk_count
  ) {
    push('chunk_index', 'chunk_out_of_range');
  }

  const rows = new Set();
  for (const row of document?.dataset?.rows ?? []) {
    if (rows.has(row.id)) {
      push('dataset.rows.id', 'duplicate_row');
      break;
    }
    rows.add(row.id);
  }
  if (rows.size < 1) push('dataset.rows', 'required');

  const evaluators = new Map();
  for (const evaluator of document?.evaluators ?? []) {
    if (evaluators.has(evaluator.id)) {
      push('evaluators.id', 'duplicate_evaluator');
      break;
    }
    evaluators.set(evaluator.id, evaluator);
    if (
      evaluator.kind === 'detector' &&
      (!Array.isArray(evaluator.issue_labels) || evaluator.issue_labels.length === 0)
    ) {
      push(`evaluators.${evaluator.id}.issue_labels`, 'detector_polarity_required');
    }
    if (
      typeof evaluator.score_min === 'number' &&
      typeof evaluator.score_max === 'number' &&
      evaluator.score_min > evaluator.score_max
    ) {
      push('evaluators.score_min', 'score_range');
    }
  }

  const armNames = new Set();
  const seen = new Set();
  let labels = 0;
  let baselines = 0;
  for (const arm of document?.arms ?? []) {
    if (armNames.has(arm.name)) {
      push('arms.name', 'duplicate_arm');
      break;
    }
    armNames.add(arm.name);
    if (arm.baseline === true) baselines += 1;
    for (const label of arm.labels ?? []) {
      labels += 1;
      if (!rows.has(label.row_id)) push('arms.labels.row_id', 'unknown_row');
      if (!evaluators.has(label.evaluator_id)) push('arms.labels.evaluator_id', 'unknown_evaluator');
      const key = `${arm.name}\0${label.row_id}\0${label.evaluator_id}`;
      if (seen.has(key)) push('arms.labels', 'duplicate_label');
      seen.add(key);
      if (label.grade_source === 'gold_verified' && !String(label.reviewed_by ?? '').trim()) {
        warn('arms.labels.grade_source', 'gold_verified_downgraded');
      } else if (!GRADES.has(label.grade_source)) {
        warn('arms.labels.grade_source', 'grade_source_downgraded');
      }
    }
  }
  if (baselines > 1) push('arms.baseline', 'multiple_baselines');
  if (labels < 1) push('arms.labels', 'label_required');
  return { errors, warnings };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node check-offline-eval.mjs <document.json>');
    process.exit(1);
  }
  const { errors, warnings } = checkOfflineEval(JSON.parse(readFileSync(file, 'utf8')));
  for (const warning of warnings) console.error(`${warning.field}: ${warning.code}`);
  if (errors.length === 0) {
    console.log('ok');
    return;
  }
  for (const error of errors) console.error(`${error.field}: ${error.code}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
