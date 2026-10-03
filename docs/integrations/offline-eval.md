# Offline eval runs + Amplitude Agent Analytics: run upload

**Amplitude Agent Analytics can store an offline eval run (a model bake-off over a fixed dataset) in your project, from any eval runner, over one authenticated HTTP call.**

Last verified: 2026-10-03. This is an Amplitude-authored guide. Braintrust, LangSmith, Langfuse, and MLflow are trademarks of their owners; this guide is not affiliated with or endorsed by them. Corrections are welcome as a pull request.

---

## Part 1: Overview

### What this is

An offline eval run is the dataset, the prompt, the models and their versions, and one arm of labels per model. Your eval runner (Braintrust experiments, LangSmith or Langfuse datasets, MLflow, a notebook, a warehouse job) already produces it. This guide turns that run into one JSON document and posts it to your Amplitude project, usually from CI after the runner finishes.

```text
eval runner (CI, notebook, scheduled job)
  -> build one document      dataset rows, evaluators, one arm per model
  -> check-offline-eval.mjs   catches the mistakes the server would reject or downgrade
  -> reportOfflineEval(doc)   POST https://developer-api.amplitude.com/v1/agent-analytics/offline-eval-results
  -> stored in the project    one run, compared pairwise against the baseline arm
```

**This is not conversation ingest.** An offline run is not an agent conversation. Do not send it as `[Agent]` events, and do not send `[Agent] Session Record` or `[Agent] Evaluator Result` for it. Production conversations keep arriving through the SDK, OTLP, a warehouse import, or one of the log-forwarding guides in this directory. If you also forward Braintrust, LangSmith, or Langfuse logs, keep doing that; this upload is only the bake-off.

### What you get

- The run stored in your project, keyed by an idempotency key you choose, so a CI retry never duplicates it.
- Per evaluator, a pairwise comparison of every arm against the baseline arm, on the rows both arms scored. A missing label is never counted as a pass.
- A winner only for evaluators whose issue values you name (`issue_labels`). Other evaluators show value counts, and rubric scores show a mean without treating higher as better.
- Rows tied to a production session, when you say they are one, so a regression can be traced back to the session.

### What your run must already contain

- **A stable row id** for every dataset row, the same across arms. Labels join on it.
- **One label per row, evaluator, and arm**, with the value the evaluator produced. Scores that were not computed are left out, not sent as zero or false.
- **Which values are issues**, for every detector. The upload does not guess polarity from an evaluator's name.

### What you need before starting

1. The Amplitude project's API key and secret key (Settings, Projects, General). The secret key is only for this call; never put it in client code or on the analytics client.
2. The project's data center: US or EU.

### Effort

Usually a few hours: map the runner's output to the document, check it, and add one CI step. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. Use the exact field names shown; the document schema rejects unknown fields.

### Do not guess

Stop and ask the user for these. Never infer them from names:

1. **The issue values of each detector.** For each evaluator that flags a problem, which values mean "this row has the issue" (for example `[true]`, `[1]`, or `["refusal"]`). This sets `issue_labels`. An evaluator without them is uploaded as a `classifier` or `rubric`, and no winner is shown for it.
2. **The baseline arm.** Which model or prompt the others are compared against. Without one, the first arm by name is the baseline.
3. **Whether rows are production sessions.** Set `dataset.rows[].session_id` only when the user confirms a row was taken from a real session in this project.
4. **A gold dataset.** Set `dataset.gold_dataset_id` only when the user names a gold dataset that already exists in Agent Analytics. The upload never creates one.
5. **Whether prompt text and row bodies may leave their environment.** If not, use `content_mode: "metadata"`; the server drops them before storage.
6. **Who reviewed the labels.** Use `grade_source: "gold_verified"` only with a `reviewed_by`; otherwise the label is stored as `single_judge`.

### Phase 1: Detect

Find out and print:

- Which runner produced the results and where its output is (an API, a results file, a table).
- Whether CI already runs the eval, and in which language.
- Whether `AMPLITUDE_API_KEY` and `AMPLITUDE_SECRET_KEY` are available as CI secrets (never hard-code them).
- The project's data center (US or EU).
- The size of a typical run: rows, arms, and evaluators.

**PAUSE.** Show the findings and ask the user to confirm them, plus the do-not-guess answers.

### Phase 2: Map

Build the document for one real run and show it to the user:

- **Dataset.** One `dataset.rows[]` entry per row, with its stable `id`. Put the input, and the expected output if any, in `body`.
- **Evaluators.** One entry per evaluator: `kind` is `detector` when it flags an issue (with `issue_labels`), `classifier` when it returns one of a fixed set of values, `rubric` when it returns a score (set `score_min` and `score_max` when known). `source` is `custom` unless the evaluator is one of Amplitude's built-in evaluators, then `ootb`.
- **Arms.** One per model or prompt variant, with `model_id`, `provider`, `model_version`, `prompt_version`, and `prompt_text` when known. Mark exactly one `baseline: true`.
- **Labels.** One per row, evaluator, and arm: `row_id`, `evaluator_id`, `value`, `grade_source`, and optionally `cost_usd` and `latency_ms`.

Then run the checker and fix every line it prints:

```bash
curl -sSLO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/check-offline-eval.mjs
node check-offline-eval.mjs run.json
```

**PAUSE.** Show the user the document (or its first rows) and the checker output.

### Phase 3: Implement

Add a step after the eval finishes that builds the document and posts it:

```ts
import { reportOfflineEval } from '@amplitude/ai';

const result = await reportOfflineEval(document, { serverZone: 'US' });
console.log(result.result_id, result.replayed, result.warnings);
```

`reportOfflineEval` reads `AMPLITUDE_API_KEY` and `AMPLITUDE_SECRET_KEY` when `apiKey` and `secretKey` are omitted. EU projects pass `serverZone: 'EU'`. Python runners use `report_offline_eval` from `amplitude-ai` with the same document. For Braintrust experiments, use the adapter in the Reference.

Use the experiment id, the git sha, and the chunk index as `idempotency_key`, so a retried CI job replays instead of duplicating.

### Phase 4: Verify

1. Post one run. The response has `result_id`, `replayed: false`, the stored `counts`, and any `warnings` (grade downgrades). Show them to the user.
2. Post the same document again and confirm `replayed: true` with the same `result_id`.
3. Confirm with the user that `counts` matches the runner: arms, rows, and labels.

### Phase 5: Ship

- Keep the checker in CI before the upload, so a document the server would reject fails the build with a readable message.
- Do not retry 400, 401, 403, 409, or 413; fix the document or the credentials. The SDK already retries 429 and 503.
- Split runs larger than 8 MB into chunks (see Reference).

---

## Reference

### Rules

1. `schema_version` is `1`. The full JSON Schema is [`offline-eval-document.schema.json`](./offline-eval-document.schema.json).
2. Org and project come from the API key. A `project_id` in the document that names a different project is rejected.
3. Every label's `row_id` is a dataset row, and every `evaluator_id` is an evaluator in the same document. At most one label per arm, row, and evaluator.
4. A detector must have `issue_labels`.
5. `grade_source` is `gold_verified`, `provisional_consensus`, `single_judge`, or `human_feedback`. Anything else, and `gold_verified` without `reviewed_by`, is stored as `single_judge` and returned in `warnings`.
6. A row's `session_id` that belongs to another project in the organization is rejected. A session that was never ingested is stored as given.
7. Limits per request: 20 arms, 50 evaluators, 5,000 rows, 100,000 labels, 8,000,000 bytes, 64 KiB for a prompt or a row body, 256 characters for an id.
8. The request body is plain JSON. Gzip or any other `Content-Encoding` is refused with 415.

### Example: one complete run

Two models on two rows, one detector and one rubric. The checker accepts it.

```json
{
  "schema_version": 1,
  "idempotency_key": "refunds-eval+3f2c1ab+0",
  "source": "ci",
  "runner_name": "custom",
  "runner_version": "1.0.0",
  "git_sha": "3f2c1ab",
  "ran_at": "2026-10-03T00:00:00.000Z",
  "content_mode": "full",
  "dataset": {
    "name": "refunds",
    "rows": [
      { "id": "row-1", "body": { "input": "Can I get a refund for order 1182?" } },
      { "id": "row-2", "body": { "input": "My package never arrived." } }
    ]
  },
  "evaluators": [
    { "id": "wrong-refund-policy", "source": "custom", "kind": "detector", "issue_labels": [true] },
    { "id": "helpfulness", "source": "custom", "kind": "rubric", "score_min": 1, "score_max": 5 }
  ],
  "arms": [
    {
      "name": "gpt-4.1",
      "provider": "openai",
      "model_id": "gpt-4.1",
      "prompt_version": "v12",
      "baseline": true,
      "labels": [
        { "row_id": "row-1", "evaluator_id": "wrong-refund-policy", "value": false, "grade_source": "single_judge" },
        { "row_id": "row-2", "evaluator_id": "wrong-refund-policy", "value": true, "grade_source": "single_judge" },
        { "row_id": "row-1", "evaluator_id": "helpfulness", "value": 4, "grade_source": "single_judge", "latency_ms": 1840 }
      ]
    },
    {
      "name": "claude-sonnet",
      "provider": "anthropic",
      "model_id": "claude-sonnet",
      "prompt_version": "v12",
      "labels": [
        { "row_id": "row-1", "evaluator_id": "wrong-refund-policy", "value": false, "grade_source": "single_judge" },
        { "row_id": "row-2", "evaluator_id": "wrong-refund-policy", "value": false, "grade_source": "single_judge" },
        { "row_id": "row-1", "evaluator_id": "helpfulness", "value": 5, "grade_source": "single_judge", "latency_ms": 2210 }
      ]
    }
  ]
}
```

Row 2 has no `helpfulness` label on either arm, so it is left out of that comparison rather than counted.

### Braintrust adapter

`braintrustExperimentsToDocument` maps Braintrust experiments, one per model, to the document. Score names become evaluators. A null score is left out. Pass `issueLabels` for each score whose value means an issue; the other scores become rubrics. Add `score_min` and `score_max` to those rubrics yourself if you know them.

```ts
import { braintrustExperimentsToDocument, reportOfflineEval } from '@amplitude/ai';

const document = braintrustExperimentsToDocument({
  datasetName: 'refunds',
  gitSha: process.env.GITHUB_SHA,
  idempotencyKey: `${experimentId}+${process.env.GITHUB_SHA}`,
  issueLabels: { 'refund-error': [1] },
  experiments: [
    { id: 'exp-a', name: 'gpt-4.1', model: 'gpt-4.1', baseline: true, rows },
    { id: 'exp-b', name: 'claude', model: 'claude-sonnet', rows: otherRows },
  ],
});
await reportOfflineEval(document);
```

`rows` are the experiment's rows: `id`, `input`, `expected`, `scores`, and `metrics.start` and `metrics.end` (Unix seconds, used for `latency_ms`). The Braintrust log-forwarding guide ([braintrust.md](./braintrust.md)) stays the path for production conversations.

LangSmith, Langfuse, MLflow, and warehouse exports use the same document. Build it in the runner you already have, check it, and post it.

### HTTP API

```
POST   https://developer-api.amplitude.com/v1/agent-analytics/offline-eval-results
DELETE https://developer-api.amplitude.com/v1/agent-analytics/offline-eval-results/{idempotency_key}
Authorization: Basic base64(project_api_key:secret_key)
Content-Type: application/json
```

EU projects use `https://developer-api.eu.amplitude.com`. An unknown key and a bad secret return the same 401.

The response to a POST:

```json
{
  "result_id": "…",
  "replayed": false,
  "group_id": null,
  "counts": { "arms": 2, "rows": 2, "labels": 6 },
  "warnings": []
}
```

The same key with the same document returns the existing `result_id` and `replayed: true`. A different document under that key returns 409. The run commits whole or not at all, and a rejected request does not use up the key. The idempotency hash covers the document as sent, so changing only the prompt text is still a conflict.

DELETE removes the run with its arms, labels, and dataset rows. It returns 409, and keeps the run, if something else still references one of its arms.

| Status | Meaning | Retry |
|---|---|---|
| 400 | `error_code` is `invalid_document` (with `validation_errors`, one `field` and `code` each), `project_mismatch`, `foreign_session`, or `unknown_gold_dataset` | No |
| 401 | Missing or wrong API key or secret key | No |
| 403 | `operation_not_enabled`: Amplitude has turned off uploads for the organization | No |
| 409 | The idempotency key already holds a different document | No |
| 411 | No `Content-Length` | No |
| 413 | The body is over 8 MB; split it into chunks | No |
| 415 | The body was compressed | No |
| 429 | Rate limited; honor `Retry-After` | Yes, at most three times |
| 503 | Temporarily unavailable; honor `Retry-After` | Yes, at most three times |

### Large runs

A typical bake-off is about 1 MB. For a larger run, send several uncompressed requests, each under 8 MB, that share a `group_id`, with `chunk_index` and `chunk_count` set. Each chunk carries every arm for its slice of rows, and each chunk has its own `idempotency_key` (for example `experiment+sha+chunkIndex`).

### Rate limits

Per IP, 30 requests per minute. Per project, 20 requests and 80 MB per minute, and 500 requests and 2 GB per day. Per organization, 60 requests and 240 MB per minute. Two uploads in flight per project. A CI job that uploads one run per merge stays far inside these.

### Privacy

`content_mode: "metadata"` drops `prompt_text` and every row `body` before storage; ids, labels, costs, and latencies are kept. The secret key is used to authenticate this request only and is never logged or stored.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 403 `operation_not_enabled` | Uploads are turned off for the organization | Contact Amplitude support |
| 400, `validation_errors` has `detector_polarity_required` | A detector has no `issue_labels` | Ask the user which values are issues, or make it a classifier |
| 400, `validation_errors` has `unknown_row` or `unknown_evaluator` | A label points at a row or evaluator not in the document | Include every row and evaluator the labels use |
| 400, `validation_errors` has `multiple_baselines` | More than one arm has `baseline: true` | Mark one |
| 400 `unknown_gold_dataset` | `gold_dataset_id` names a dataset that does not exist | Remove it, or create the gold dataset first |
| 400 `foreign_session` | A row's `session_id` belongs to another project | Remove it from that row |
| 409 on a CI retry | The run changed under the same key | Include the git sha and chunk index in the key |
| `warnings` lists `grade_source` | A grade source was downgraded to `single_judge` | Use one of the four values, and `reviewed_by` with `gold_verified` |
| No winner for an evaluator | It has no `issue_labels` | Expected; value counts are shown instead |

### More

- [Integrations index](./README.md)
- [`check-offline-eval.mjs`](./check-offline-eval.mjs): checks a document before it is posted. No dependencies.
- [Python SDK](https://pypi.org/project/amplitude-ai/): `report_offline_eval` takes the same document.
