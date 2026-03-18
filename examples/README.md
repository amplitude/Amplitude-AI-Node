# Examples

These examples demonstrate the `@amplitude/ai` event model using `MockAmplitudeAI`
(no API keys or LLM provider SDKs required). They are also used as smoke tests in CI.

| File                       | Pattern demonstrated                           |
| -------------------------- | ---------------------------------------------- |
| `zero-code.ts`             | Event model for zero-code patching             |
| `wrap-openai.ts`           | Event model for wrapping a provider client     |
| `multi-agent.ts`           | Multi-agent hierarchy with parent/child agents |
| `framework-integration.ts` | BoundAgent + Session lifecycle                 |

## Running

```bash
pnpm --filter @amplitude/ai test -- test/examples-smoke.test.ts
```

## Real integration examples

For runnable examples that call real LLM APIs, see the code blocks in the
[README](../README.md) under each integration tier (Zero-code, Wrap, Full Control).
Those require `OPENAI_API_KEY` or the relevant provider credentials.
