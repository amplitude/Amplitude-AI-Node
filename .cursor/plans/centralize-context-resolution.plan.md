# Centralize Context Resolution in JS SDK

## Problem

The JS SDK has multiple bugs caused by scattered context resolution:
- `applySessionContext()` is called 2-4 times per API request (should be 1)
- Turn IDs double-increment because `nextTurnId()` is called as a side effect each time
- Only 6 of 13 context fields are forwarded from provider wrappers to `_trackFn()`
- Azure OpenAI drops `amplitudeOverrides` entirely
- Error paths track fewer context fields than success paths
- Streaming tool call deltas are not merged by index
- Anthropic cost calculation potentially double-counts tokens
- Bedrock streaming omits cache tokens from cost calculation
- Gemini streaming duplicates tool calls

The Python SDK avoids all these by centralizing context resolution in `track_completion()` / `create_streaming_tracker()`, called exactly once per request. Provider wrappers never call `_apply_session_context()` themselves.

## Architecture

The refactor has two groups:
- **Group A**: Centralize context resolution (structural fix for bugs 1, 7, 8, 10, 11)
- **Group B**: Fix data correctness bugs (bugs 2, 9, 14, 15)

## Group A: Centralize Context Resolution

### A1. Make `_track()` a pure passthrough

**File:** [`src/providers/base.ts`](src/providers/base.ts)

Remove `applySessionContext()` from `_track()`. It becomes a simple bridge to `trackAiMessage()`:

```typescript
protected _track(opts: Omit<TrackAiMessageOptions, 'amplitude'>): string {
    return trackAiMessage({
      ...opts,
      amplitude: this._amplitude,
      privacyConfig: opts.privacyConfig ?? this._privacyConfig,
    });
  }
```

### A2. Fix `applySessionContext()` turnId side effect

**File:** [`src/providers/base.ts`](src/providers/base.ts)

Only call `ctx.nextTurnId()` when the turnId is actually needed:

```typescript
// Before (always increments counter):
const turnId = ctx.nextTurnId();
if (turnId != null && result.turnId == null) result.turnId = turnId;

// After (only increments when needed):
if (result.turnId == null) {
  const turnId = ctx.nextTurnId();
  if (turnId != null) result.turnId = turnId;
}
```

### A3. Provider wrappers pass ALL resolved context fields to `_trackFn()`

**Files:** [`src/providers/openai.ts`](src/providers/openai.ts), [`src/providers/anthropic.ts`](src/providers/anthropic.ts), [`src/providers/mistral.ts`](src/providers/mistral.ts)

Extract a helper to spread all context fields from `ctx` into tracking calls:

```typescript
// In base.ts, add a helper:
function contextFields(ctx: ProviderTrackOptions): Record<string, unknown> {
  return {
    userId: ctx.userId ?? 'unknown',
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    turnId: ctx.turnId ?? undefined,
    agentId: ctx.agentId,
    parentAgentId: ctx.parentAgentId,
    customerOrgId: ctx.customerOrgId,
    agentVersion: ctx.agentVersion,
    context: ctx.context,
    env: ctx.env,
    groups: ctx.groups,
    eventProperties: ctx.eventProperties,
  };
}
```

Then every `_trackFn()` call becomes:
```typescript
this._trackFn({
  ...contextFields(ctx),
  modelName,
  provider: this._providerName,
  responseContent: ...,
  latencyMs,
  // ...metrics
});
```

This replaces the current pattern of manually listing 6 fields in each call.

### A4. Fix error paths to use same context fields

**Files:** [`src/providers/openai.ts`](src/providers/openai.ts), [`src/providers/anthropic.ts`](src/providers/anthropic.ts), [`src/providers/mistral.ts`](src/providers/mistral.ts), [`src/providers/gemini.ts`](src/providers/gemini.ts), [`src/providers/bedrock.ts`](src/providers/bedrock.ts)

Error tracking calls currently pass a subset of fields. Use the same `contextFields(ctx)` helper:

```typescript
// Before:
this._trackFn({
  userId: ctx.userId ?? 'unknown',
  modelName: ...,
  provider: this._providerName,
  responseContent: '',
  latencyMs,
  sessionId: ctx.sessionId,
  traceId: ctx.traceId,
  agentId: ctx.agentId,
  env: ctx.env,
  isError: true,
  errorMessage: ...,
});

// After:
this._trackFn({
  ...contextFields(ctx),
  modelName: ...,
  provider: this._providerName,
  responseContent: '',
  latencyMs,
  isError: true,
  errorMessage: ...,
});
```

### A5. Fix Azure OpenAI to forward `amplitudeOverrides`

**File:** [`src/providers/azure-openai.ts`](src/providers/azure-openai.ts)

```typescript
// Before:
create: (params: Record<string, unknown>): Promise<unknown> =>
  wrappedCompletions.create(params),

// After:
create: (params: Record<string, unknown>, overrides?: ProviderTrackOptions): Promise<unknown> =>
  wrappedCompletions.create(params, overrides),
```

Same for `parse`.

### A6. Fix Gemini/Bedrock streaming to not re-resolve context

**Files:** [`src/providers/gemini.ts`](src/providers/gemini.ts), [`src/providers/bedrock.ts`](src/providers/bedrock.ts)

Remove the `applySessionContext()` call inside `_wrapStream()` / `_wrapConverseStream()`. Instead, pass the already-resolved `ctx` from the parent method (same as OpenAI/Anthropic already do):

```typescript
// Before (in generateContentStream):
const ctx = applySessionContext();  // 1st call
return this._wrapStream(model, params, stream, finalResponse);

// Inside _wrapStream:
const ctx = applySessionContext();  // redundant 2nd call

// After:
const ctx = applySessionContext();  // only call
return this._wrapStream(model, params, stream, finalResponse, ctx);

// Inside _wrapStream:
// Use the passed-in ctx, no applySessionContext() call
```

### A7. Update `SimpleStreamingTracker.finalize()` to pass all context fields

**File:** [`src/providers/base.ts`](src/providers/base.ts)

Use `contextFields()` helper in `finalize()` as well.

## Group B: Fix Data Correctness Bugs

### B1. Fix streaming tool call accumulation (Bug 2)

**Files:** [`src/providers/openai.ts`](src/providers/openai.ts), [`src/providers/mistral.ts`](src/providers/mistral.ts)

Port the Python SDK's index-based accumulation logic. OpenAI streams tool call deltas with an `index` field. The accumulator should:
1. When a delta has `id` + `function.name`: initialize a new entry at that index
2. When a delta has only `function.arguments`: append to the existing entry at that index

```typescript
// In _wrapStream, replace:
if (Array.isArray(deltaToolCalls)) {
  for (const call of deltaToolCalls) {
    accumulator.addToolCall(call);
  }
}

// With index-based accumulation:
if (Array.isArray(deltaToolCalls)) {
  for (const call of deltaToolCalls) {
    const idx = call.index as number | undefined;
    const id = call.id as string | undefined;
    const fn = call.function as Record<string, unknown> | undefined;
    const name = fn?.name as string | undefined;
    const args = fn?.arguments as string | undefined;

    if (id && name != null && idx != null) {
      // New tool call at this index
      accumulator.setToolCallAt(idx, { type: 'function', id, function: { name, arguments: args ?? '' } });
    } else if (args && idx != null) {
      // Append arguments to existing tool call
      accumulator.appendToolCallArgs(idx, args);
    }
  }
}
```

This requires adding `setToolCallAt()` and `appendToolCallArgs()` to `StreamingAccumulator` in [`src/utils/streaming.ts`](src/utils/streaming.ts).

### B2. Fix Anthropic cost token normalization (Bug 9)

**File:** [`src/providers/anthropic.ts`](src/providers/anthropic.ts)

Follow the Python SDK's approach: pass the normalized total as `inputTokens` to `calculateCost()`, but verify that `calculateCost()` treats cache tokens as subsets (not additive). Check [`src/utils/costs.ts`](src/utils/costs.ts) to confirm the contract. If `calculateCost()` adds cache tokens on top, change it to match Python's "subsets" contract. If it already treats them as subsets, the Anthropic normalization is correct.

### B3. Fix Bedrock streaming cost calculation (Bug 14)

**File:** [`src/providers/bedrock.ts`](src/providers/bedrock.ts)

Pass cache tokens to `calculateCost()` in the streaming path, matching the non-streaming path:

```typescript
// In _wrapConverseStream finally block:
costUsd = calculateCost({
  modelName,
  inputTokens: state.inputTokens,
  outputTokens: state.outputTokens,
  cacheReadInputTokens: state.cacheReadTokens ?? 0,
  cacheCreationInputTokens: state.cacheCreationTokens ?? 0,
});
```

### B4. Fix Gemini streaming tool call duplication (Bug 15)

**File:** [`src/providers/gemini.ts`](src/providers/gemini.ts)

Only extract tool calls from stream chunks OR from `finalResponse`, not both. Since `finalResponse` has the complete data, prefer it and skip chunk-level tool call extraction. OR: only extract from `finalResponse` if no tool calls were accumulated from chunks.

## Files Changed (estimated)

| File | Changes |
|------|---------|
| `src/providers/base.ts` | A1, A2, A3 (helper), A7 |
| `src/providers/openai.ts` | A3, A4, B1 |
| `src/providers/anthropic.ts` | A3, A4, B2 |
| `src/providers/mistral.ts` | A3, A4, B1 |
| `src/providers/gemini.ts` | A3, A4, A6, B4 |
| `src/providers/bedrock.ts` | A3, A4, A6, B3 |
| `src/providers/azure-openai.ts` | A5 |
| `src/utils/streaming.ts` | B1 (new methods) |
| `src/utils/costs.ts` | B2 (verify contract) |
| `src/types.ts` | Already done (agentVersion, context, eventProperties) |

## Testing

- All 954 existing tests must pass
- Verify turn IDs increment by 1 (not 2) in provider wrapper tests
- Verify streaming tool calls are properly merged in OpenAI tests
- Run lint (ESLint + Biome)
