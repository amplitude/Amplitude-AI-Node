#!/usr/bin/env node
// Validates an offline eval document before it is posted to Amplitude.
// Zero dependencies (Node 18+). Exits 1 when any error is found.
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
  const push = (field, code) => errors.push({ field, code });
  if (document?.schema_version !== 1) push('schema_version', 'schema_version');
  if (!document?.idempotency_key) push('idempotency_key', 'required');
  if (!Array.isArray(document?.arms) || document.arms.length < 1) push('arms', 'required');
  if (!Array.isArray(document?.evaluators) || document.evaluators.length < 1) {
    push('evaluators', 'required');
  }
  const rows = new Set((document?.dataset?.rows ?? []).map((row) => row.id));
  if (rows.size < 1) push('dataset.rows', 'required');
  const evaluators = new Map((document?.evaluators ?? []).map((item) => [item.id, item]));
  for (const evaluator of evaluators.values()) {
    if (evaluator.kind === 'detector' && !Array.isArray(evaluator.issue_labels)) {
      push(`evaluators.${evaluator.id}.issue_labels`, 'detector_polarity_required');
    }
  }
  const seen = new Set();
  let labels = 0;
  for (const arm of document?.arms ?? []) {
    for (const label of arm.labels ?? []) {
      labels += 1;
      if (!rows.has(label.row_id)) push('arms.labels.row_id', 'unknown_row');
      if (!evaluators.has(label.evaluator_id)) push('arms.labels.evaluator_id', 'unknown_evaluator');
      const key = `${arm.name}\0${label.row_id}\0${label.evaluator_id}`;
      if (seen.has(key)) push('arms.labels', 'duplicate_label');
      seen.add(key);
      if (label.grade_source === 'gold_verified' && !label.reviewed_by) {
        push('arms.labels.grade_source', 'gold_verified_needs_reviewer');
      }
      if (!GRADES.has(label.grade_source)) {
        push('arms.labels.grade_source', 'grade_source_will_be_downgraded');
      }
    }
  }
  if (labels < 1) push('arms.labels', 'label_required');
  return errors;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node check-offline-eval.mjs <document.json>');
    process.exit(1);
  }
  const errors = checkOfflineEval(JSON.parse(readFileSync(file, 'utf8')));
  if (errors.length === 0) {
    console.log('ok');
    return;
  }
  for (const error of errors) console.error(`${error.field}: ${error.code}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
