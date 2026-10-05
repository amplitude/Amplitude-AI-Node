# Offline eval runs + Amplitude Agent Analytics: run upload

**Amplitude Agent Analytics can store an offline eval run (a model bake-off over a fixed dataset) in your project, from any eval runner, over one authenticated HTTP call.**

Give this page to your coding agent. The schema is [`offline-eval-document.schema.json`](./offline-eval-document.schema.json) and the checker is [`check-offline-eval.mjs`](./check-offline-eval.mjs). From those three, the agent can finish in the repository that already runs the eval. No package install.

Last verified: 2026-10-03. This is an Amplitude-authored guide. Braintrust, LangSmith, Langfuse, and MLflow are trademarks of their owners; this guide is not affiliated with or endorsed by them. Corrections are welcome as a pull request.

---

## Part 1: Overview

### What this is

An offline eval run is the dataset, the prompt, the models and their versions, and one arm of labels per model. Your eval runner (Braintrust experiments, LangSmith or Langfuse datasets, MLflow, a notebook, a results file) already produces it. This guide turns that run into one JSON document and posts it to your Amplitude project after the change that produced it has deployed.

```text
pull request eval gates the merge
  -> committed mapper writes run.json for that commit
  -> merge, then deploy
  -> check-offline-eval.mjs
  -> curl POST the file whose git_sha is the deployed commit
  -> stored in the project, compared pairwise against the baseline arm
```

Amplitude does not poll the runner and does not add a schedule. The pull-request workflow you already have runs the eval and blocks the merge when the gate fails. The post is a later step on the workflow that deploys that commit. A failing gate is not stored.

**This is not conversation ingest.** An offline run is not an agent conversation. Do not send it as `[Agent]` events, and do not send `[Agent] Session Record` or `[Agent] Evaluator Result` for it. Production conversations keep arriving through the SDK, OTLP, a warehouse import, or one of the log-forwarding guides in this directory. If you also forward Braintrust, LangSmith, or Langfuse logs, keep doing that; this upload is only the bake-off.

### What you get

- The run stored in your project, keyed by an idempotency key you choose. A retry of the same document returns the stored run. A different document under that key is rejected.
- Per evaluator, a pairwise comparison of every arm against the baseline arm, on the rows both arms scored. A missing label is never counted as a pass.
- A winner only for evaluators whose issue values you name (`issue_labels`). Other evaluators show value counts, and rubric scores show a mean without treating higher as better.
- An optional `session_id` on a row, stored exactly as you send it. The upload does not check that the session exists. Comparisons are keyed by `row_id`.

### What your run must already contain

- **A stable row id** for every dataset row, the same across arms. Labels join on it.
- **One label per row, evaluator, and arm**, with the value the evaluator produced. Scores that were not computed are left out, not sent as zero or false.
- **Which values are issues**, for every detector. The upload does not guess polarity from an evaluator's name.

### What you need before starting

1. The Amplitude project's API key and secret key (Settings, Projects, General). The secret key is only for this call; never put it in client code or on the analytics client.
2. The project's data center: US or EU.

### Effort

Usually a few hours: map the runner's output once, check it, and add the post to the deploy workflow. After that, one CI variable turns the post on or off. The coding agent procedure below does most of the work.

---

## Part 2: Coding agent procedure

**If you are a coding agent, start here and follow the phases in order.** Everything you need is on this page. Use the exact field names shown; the document schema rejects unknown fields. Do not install `@amplitude/ai` or `amplitude-ai` to post. The post is `curl`.

### Pick your harness

| Harness | Where one finished run lives | CI hook, when they already have one |
|---|---|---|
| Braintrust experiments | One experiment per arm. The job that just ran the eval has the rows. | `braintrustdata/eval-action` stays the pull-request gate |
| LangSmith experiments | One experiment per arm. Example id is the row. | The workflow that already calls `evaluate` |
| Langfuse dataset runs | One dataset run per arm. Dataset item id is the row. | `langfuse/experiment-action` stays the pull-request gate |
| A results file or a bespoke runner | One real results file or table extract | `promptfoo eval -o`, `deepeval test run`, or their own script |

If the eval is only a button in a vendor UI and no job in this repository runs it, stop. There is nothing to extend.

### Do not guess

Stop and ask the user for these. Never infer them from names, from a score name, or from the previous CI run:

1. **The issue values of each detector.** For each evaluator that flags a problem, which values mean "this row has the issue" (for example `[true]`, `[1]`, or `["refusal"]`). This sets `issue_labels`. An evaluator without them is uploaded as a `classifier` or `rubric`, and no winner is shown for it.
2. **The baseline arm.** Which model or prompt the others are compared against. Exactly one, named once. A previous CI run is not the baseline. Without one, the first arm by name is the baseline. The comparison uses that name. `baseline: true` on an arm means the customer marked it.
3. **Rubric bounds.** For each rubric, the user names `score_min` and `score_max`. Without both, the comparison shows value counts and no mean.
4. **Whether a row names a production session.** Set `dataset.rows[].session_id` only when the user says that row came from one. The upload stores the id and does not check that the session exists.
5. **A gold dataset.** Set `dataset.gold_dataset_id` only when the user names a gold dataset that already exists in this project. The upload never creates one. A dataset in another project is `unknown_gold_dataset`.
6. **Whether prompt text and row bodies may leave their environment.** If not, use `content_mode: "metadata"`; the server drops them before storage.
7. **Who reviewed the labels.** Use `grade_source: "gold_verified"` only with a `reviewed_by`; otherwise the label is stored as `single_judge`.

### Harness field maps

Field names below come from public docs and were not checked against a live account. Copy the map and the example, and only fill what the sample actually has. A missing score stays missing. Do not add document fields.

The mapping becomes a script committed in the repository, in whatever language that repository already uses. The confirmed answers are constants in that script. The script writes `run.json.tmp` and renames it to `run.json` only when the document is complete. `ran_at` is the experiment's created time. `git_sha` is the commit being evaluated. `idempotency_key` is the experiment id, that git sha, the slice (`smoke` or `full`, or the dataset version), and the chunk index. A GitHub run id changes on every re-run, so it stays out of the key. A sample file produced once in chat is not the integration.

**Braintrust.** One experiment is one arm. Dataset row id is `row_id`. Score names are evaluators. Null scores are omitted. `metrics.start` and `metrics.end` are Unix seconds and become `latency_ms`. Experiment created time is `ran_at`. Once the rows are in hand, `braintrustExperimentsToDocument` does this mapping. The function does not call Braintrust. The agent still obtains the rows.

```json
{ "id": "row-1", "input": "Can I get a refund?", "scores": { "refund-error": 1 }, "metrics": { "start": 1727913600, "end": 1727913601.84 } }
```

becomes a label `{ "row_id": "row-1", "evaluator_id": "refund-error", "value": 1, "latency_ms": 1840 }` on the arm named by that experiment. `issueLabels` for `refund-error` makes that evaluator a detector. Any other score becomes a rubric.

**LangSmith.** One experiment is one arm. Example id is `row_id`. Feedback keys are evaluators. Example inputs and reference outputs are the row body.

```json
{ "id": "ex-1", "inputs": { "question": "Can I get a refund?" }, "reference_outputs": { "answer": "Yes, within 30 days." }, "feedback": { "refund-error": 1 } }
```

becomes row `ex-1` with that body, and a label `{ "row_id": "ex-1", "evaluator_id": "refund-error", "value": 1 }`.

**Langfuse.** One dataset run is one arm. Dataset item id is `row_id`. Scores on the linked trace are evaluators. The dataset version goes into the idempotency key's slice.

```json
{ "datasetItemId": "item-1", "input": "Can I get a refund?", "expectedOutput": "Yes, within 30 days.", "scores": [{ "name": "refund-error", "value": 1 }] }
```

becomes row `item-1` and a label `{ "row_id": "item-1", "evaluator_id": "refund-error", "value": 1 }`.

**A results file.** Same target. Read one real file. Promptfoo's `results.json` and DeepEval's test output are this path. Propose source field to document field from the sample. Use null when the runner did not record it.

### Phase 1: Detect

Find out and print:

- Which harness, and where one finished run's output is.
- The workflow file that gates pull requests, the workflow that deploys the default branch, and the CI language.
- Whether `AMPLITUDE_API_KEY` and `AMPLITUDE_SECRET_KEY` exist as CI secrets. Never hard-code them. Whether the repository variable `AMPLITUDE_OFFLINE_EVAL_UPLOAD` exists.
- The project's data center (US or EU).
- Whether prompt text may leave their environment.
- The size of a typical run: rows, arms, and evaluators.

If there is no sample run, stop. If the eval never leaves a vendor UI, stop.

**PAUSE.** Show the findings and ask the user to confirm them, plus the do-not-guess answers.

### Phase 2: Map

Copy that harness's field map. Build the document for one real run. Show the mapping and the first rows. For a bespoke file, show source field to document field and use null where the runner recorded nothing.

- **Dataset.** One `dataset.rows[]` entry per row, with its stable `id`. Put the input, and the expected output if any, in `body`.
- **Evaluators.** One entry per evaluator: `kind` is `detector` when it flags an issue (with `issue_labels`), `classifier` when it returns one of a fixed set of values, `rubric` when it returns a score (set `score_min` and `score_max` when known). `source` is `custom` unless the evaluator is one of Amplitude's built-in evaluators, then `ootb`. The server stores every evaluator as `custom`; an `ootb` one keeps the built-in id in `maps_to_evaluator_id` and comes back with warning `evaluator_source_downgraded`.
- **Arms.** One per model or prompt variant, with `model_id`, `provider`, `model_version`, `prompt_version`, and `prompt_text` when known. Mark exactly one `baseline: true`.
- **Labels.** One per row, evaluator, and arm: `row_id`, `evaluator_id`, `value`, `grade_source`, and optionally `cost_usd` and `latency_ms`.

**PAUSE.** Show the user the mapping and the first rows.

### Phase 3: Check

Run the checker and fix every line it prints before any post:

```bash
curl -sSLO https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/check-offline-eval.mjs
node check-offline-eval.mjs run.json
```

### Phase 4: Gate, then post after deploy

Commit the mapper on the workflow that already gates pull requests. That job writes `run.json` and does not call Amplitude. `braintrustdata/eval-action` or `langfuse/experiment-action`, when present, stays the gate and can still comment on a failing pull request.

On the workflow that deploys the default branch, after the deploy succeeds, post the file whose `git_sha` is the deployed commit. Choose the file in this order:

1. A `run.json` already produced in this workflow for this checkout, when its `git_sha` equals the deployed commit.
2. A saved artifact whose `git_sha` equals the deployed commit.
3. Otherwise run the mapper on this checkout. A merge commit that differs from the pull-request head takes this path. The pull-request file is not posted in its place.

Refuse to post when `git_sha` in the file differs from the deployed commit. When the repository has no deploy workflow, this step is the last step of the push to the default branch, after the eval passed. That merge commit is the ship signal.

`AMPLITUDE_OFFLINE_EVAL_UPLOAD` is a repository variable set to `true` or `false`. Unset is off. The mapper stays in the gate either way. `false` leaves the gate and the deploy unchanged and skips the post. `true` posts on the next shipped run. Turning it on does not upload older ships.

```yaml
- name: Upload the shipped offline eval
  if: success() && vars.AMPLITUDE_OFFLINE_EVAL_UPLOAD == 'true'
  env:
    AMPLITUDE_API_KEY: ${{ secrets.AMPLITUDE_API_KEY }}
    AMPLITUDE_SECRET_KEY: ${{ secrets.AMPLITUDE_SECRET_KEY }}
    # EU projects: https://developer-api.eu.amplitude.com/v1/agent-analytics/offline-eval-results
    AMPLITUDE_OFFLINE_EVAL_URL: https://developer-api.amplitude.com/v1/agent-analytics/offline-eval-results
    DEPLOYED_SHA: ${{ github.sha }}
  run: bash post-offline-eval.sh
```

GitLab CI and Buildkite use the same variable and the same script, on the deploy stage, after that stage succeeds. `DEPLOYED_SHA` is the commit that deployed.

`post-offline-eval.sh` checks the sha, runs the checker when `node` is on the path, and posts. A runner with only `curl` skips the local checker and treats a 400 body as the check. The script prints `result_id`, `replayed`, and the warning count. It does not print the secret, a verbose trace, or `run.json`. Do not run it under `bash -x`.

```bash
#!/bin/sh
set -eu
file="${1:-run.json}"
deployed="${DEPLOYED_SHA:?}"
read_sha() {
  if command -v node >/dev/null 2>&1; then
    node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(d.git_sha||""))' "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("git_sha",""), end="")' "$1"
  else
    echo "need node or python3 to read git_sha" >&2
    exit 1
  fi
}
if [ -f "$file" ] && [ "$(read_sha "$file")" = "$deployed" ]; then
  :
elif [ -f run-from-artifact.json ] && [ "$(read_sha run-from-artifact.json)" = "$deployed" ]; then
  file=run-from-artifact.json
else
  # Replace this line with the committed mapper. It writes run.json for this checkout.
  map-offline-eval "$deployed"
  file=run.json
fi
if [ "$(read_sha "$file")" != "$deployed" ]; then
  echo "refusing to post $file: git_sha is not $deployed" >&2
  exit 1
fi
bytes=$(wc -c < "$file" | tr -d ' ')
if [ "$bytes" -gt 8000000 ]; then
  echo "run.json is over 8 MB; split into chunks that share a group_id" >&2
  exit 1
fi
if command -v node >/dev/null 2>&1; then
  curl -fsSL -o check-offline-eval.mjs https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/check-offline-eval.mjs
  node check-offline-eval.mjs "$file"
fi
attempt=0
delay=2
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  body=$(mktemp)
  status=$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
    --max-redirs 0 \
    --header 'Content-Type: application/json' \
    --user "${AMPLITUDE_API_KEY}:${AMPLITUDE_SECRET_KEY}" \
    --data-binary @"$file" \
    "$AMPLITUDE_OFFLINE_EVAL_URL")
  if [ "$status" = "200" ]; then
    if command -v node >/dev/null 2>&1; then
      node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(r.result_id, r.replayed, (r.warnings||[]).length)' "$body"
    else
      echo "posted HTTP 200"
    fi
    rm -f "$body"
    exit 0
  fi
  if [ "$status" = "429" ] || [ "$status" = "503" ]; then
    rm -f "$body"
    sleep "$delay"
    delay=$((delay * 2))
    continue
  fi
  echo "upload failed HTTP $status" >&2
  rm -f "$body"
  exit 1
done
echo "upload failed after retries" >&2
exit 1
```

Plain `curl` exits 0 on a 409. This script treats only HTTP 200 as success, retries 429 and 503, and fails on 400, 401, 403, 409, and 413. `replayed: true` is success. A redeploy of the same commit replays when the document is identical, including `ran_at` and row order.

### Phase 5: Verify and ship

1. With the variable set to `true`, deploy one passing change. The response has `result_id`, `replayed: false`, the stored `counts`, and any `warnings`. Show them to the user.
2. Redeploy that same commit and confirm `replayed: true` with the same `result_id`.
3. Confirm with the user that `counts` matches the runner: arms, rows, and labels.
4. Leave the mapper on the gate and the script on the deploy workflow. Set the variable to `false` to stop posting without removing either.

---

## Reference

### Rules

1. `schema_version` is `1`. The full JSON Schema is [`offline-eval-document.schema.json`](./offline-eval-document.schema.json).
2. Org and project come from the API key. A `project_id` in the document that names a different project is rejected.
3. Every label's `row_id` is a dataset row, and every `evaluator_id` is an evaluator in the same document. At most one label per arm, row, and evaluator.
4. A detector must have `issue_labels`.
5. `grade_source` is `gold_verified`, `provisional_consensus`, `single_judge`, or `human_feedback`. Anything else, and `gold_verified` without `reviewed_by`, is stored as `single_judge` and returned in `warnings`.
6. A row's `session_id` is stored as given. The upload does not look the session up, in this project or any other. The run query and the disagreement page return `rowId`, and the comparison is keyed by `row_id`. The stored label also carries `session_id` when the row named one. The same session id on two rows of one document is rejected.
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
  ranAt: experimentCreatedAt,
  idempotencyKey: `${experimentId}+${process.env.GITHUB_SHA}`,
  issueLabels: { 'refund-error': [1] },
  experiments: [
    { id: 'exp-a', name: 'gpt-4.1', model: 'gpt-4.1', baseline: true, rows },
    { id: 'exp-b', name: 'claude', model: 'claude-sonnet', rows: otherRows },
  ],
});
await reportOfflineEval(document);
```

Pass a stable `ranAt`, such as the experiment's created time. The adapter otherwise sets `ran_at` to the current time, and `ran_at` is part of the document the idempotency hash covers, so a retry would not replay. A retry replays only when the rest of the document is identical too, including row order. The function does not call Braintrust. The CI post in Part 2 uses `curl` and does not install this package. Use the adapter only when the job already imports `@amplitude/ai`.

`rows` are the experiment's rows: `id`, `input`, `expected`, `scores`, and `metrics.start` and `metrics.end` (Unix seconds, used for `latency_ms`). The Braintrust log-forwarding guide ([braintrust.md](./braintrust.md)) stays the path for production conversations.

LangSmith, Langfuse, MLflow, and a results file use the same document. The harness field maps in Part 2 are the shapes to copy. `report_offline_eval` in the Python SDK takes the same document when that job already installed `amplitude-ai`.

### HTTP API

```
POST   https://developer-api.amplitude.com/v1/agent-analytics/offline-eval-results
DELETE https://developer-api.amplitude.com/v1/agent-analytics/offline-eval-results?idempotency_key={idempotency_key}
Authorization: Basic base64(project_api_key:secret_key)
Content-Type: application/json
```

A key with no `/` can also be deleted at `DELETE /v1/agent-analytics/offline-eval-results/{idempotency_key}`. A key that contains `/` has to use the query form. Percent-encode the query value.

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

DELETE `/v1/agent-analytics/offline-eval-results?idempotency_key=` removes that one request, including a key that contains `/`. For a chunked run that is one chunk. `deleteOfflineEvalRun` removes every chunk of the run. A 409 `result_in_use` leaves the targeted row in place.

| Status | Meaning | Retry |
|---|---|---|
| 400 | `error_code` is `invalid_document` (with `validation_errors`, one `field` and `code` each), `project_mismatch`, or `unknown_gold_dataset` | No |
| 401 | Missing or wrong API key or secret key | No |
| 403 | `operation_not_enabled`: Amplitude has turned off uploads for the organization | No |
| 409 | The idempotency key already holds a different document (`idempotency_conflict`), is already used by an Amplitude-written result (`idempotency_key_in_use`), or a chunk disagrees with its group or the group is already full (`group_conflict`) | No |
| 411 | No `Content-Length` | No |
| 413 | The body is over 8 MB; split it into chunks | No |
| 415 | The body was compressed | No |
| 429 | Rate limited; honor `Retry-After` | Yes, at most three times |
| 503 | Temporarily unavailable; honor `Retry-After` | Yes, at most three times |

### Large runs

A typical bake-off is about 1 MB. For a larger run, send several uncompressed requests, each under 8 MB, that share a `group_id`, with `chunk_index` and `chunk_count` set. Each chunk carries every arm for its slice of rows, and each chunk has its own `idempotency_key` (for example `experiment+sha+chunkIndex`). Repeat the same arms, baseline, evaluators, `chunk_count`, dataset name, and source on every chunk. A `metadata` chunk still sends the same `prompt_text`: the text is dropped after the prompt hash is taken, and a missing prompt is a different hash. A `chunk_index` greater than or equal to `chunk_count` is 400 `chunk_out_of_range`, including on the first request. 409 `group_conflict` is the group already holding `chunk_count` chunks, or a later chunk that repeats a row id, a session id, or a chunk index, or that disagrees with the chunks already stored.

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
| 400 `unknown_gold_dataset` | `gold_dataset_id` is missing, has no project, or belongs to another project | Remove it, or create the gold dataset in this project first |
| 400, `validation_errors` has `chunk_out_of_range` | `chunk_index` is greater than or equal to `chunk_count` | Use an index from 0 up to, but not including, `chunk_count` |
| 409 on a CI retry | The run changed under the same key, or `ran_at` was the current time | Include the git sha and chunk index in the key, and send a stable `ran_at` |
| 409 `idempotency_key_in_use` | That key is already used by an Amplitude-written result | Choose another idempotency key. This upload does not replace or delete that result |
| 409 `group_conflict` | A chunk is not the same bake-off as the chunks already stored: arms, baseline, evaluators, chunk count, dataset name, source, a repeated row id, session id, or chunk index, or the group already holds `chunk_count` chunks | Repeat the same arm identity, including prompt text, on every chunk, and give each chunk its own rows, session ids, and chunk index |
| `warnings` lists `grade_source` | A grade source was downgraded to `single_judge` | Use one of the four values, and `reviewed_by` with `gold_verified` |
| No winner for an evaluator | It has no `issue_labels` | Expected; value counts are shown instead |

### More

- [Integrations index](./README.md)
- [`check-offline-eval.mjs`](./check-offline-eval.mjs): checks a document before it is posted. No dependencies.
- [Python SDK](https://pypi.org/project/amplitude-ai/): `report_offline_eval` takes the same document.
