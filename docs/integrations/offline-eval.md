# Upload an offline eval run

An offline eval run is the dataset, the prompt, the model and its versions, and one arm of labels per model. It is not an agent conversation. Do not send it as `[Agent]` events, and do not send `[Agent] Session Record` or `[Agent] Evaluator Result`. Conversation ingest stays the transcript. This upload is the bake-off.

The document is `offline-eval-document.schema.json` in this directory. Check it before a CI job posts it:

```bash
node docs/integrations/check-offline-eval.mjs run.json
```

## Post it

```ts
import { reportOfflineEval } from '@amplitude/ai';

await reportOfflineEval(document, { serverZone: 'US' });
```

`AMPLITUDE_API_KEY` and `AMPLITUDE_SECRET_KEY` are read when the arguments are omitted. The secret is the project secret key. EU projects use `serverZone: 'EU'`, which posts to `https://developer-api.eu.amplitude.com`. The call retries 429 and 503 at most three times. 400, 401, 403, 409, and 413 are not retried.

Use the experiment id, the git sha, and the chunk index as `idempotency_key`. The same key and the same document returns the existing result. A different document for that key is a 409.

Name `dataset.gold_dataset_id` only when that gold dataset already exists. Set `dataset.rows[].session_id` only when the row is a production session. A detector must include `issue_labels`. The upload does not guess which values are the bad ones.

## Braintrust experiments

The log-forwarding guide stays the conversation path. An experiment bake-off uses this document instead. `braintrustExperimentsToDocument` maps one experiment per model. Score names become evaluators. A null score is omitted. Pass `issueLabels` for a score whose value is an issue. Other scores are stored as rubrics, and a higher number is not treated as better.

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

LangSmith, Langfuse, MLflow, and a warehouse export use the same document. Build the JSON in the runner you already have, check it, and post it. A second adapter is not required until a runner's field names block you.
