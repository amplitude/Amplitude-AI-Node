# Hosted agent platforms + Amplitude Agent Analytics

**Amplitude Agent Analytics can ingest conversations from hosted agent platforms over the Amplitude HTTP API, with no SDK required.**

If your customer-facing agent runs on a hosted platform, you do not instrument LLM calls yourself; the platform runs the agent. Instead, a small forwarder in your infrastructure takes each finished conversation from the platform, turns it into `[Agent]` events, and posts them to Amplitude. Each guide below is a complete recipe for one platform, written for both engineers and coding agents: hand a coding agent the page URL and it can build the forwarder.

| Platform | Guide | How conversations are extracted | Last verified |
|---|---|---|---|
| Sierra | [sierra.md](./sierra.md) | Post-conversation webhook or scheduled transcript export (format from your Sierra account team) | 2026-09-23 |
| Decagon | [decagon.md](./decagon.md) | Scheduled pull from the conversation export API | 2026-09-23 |

A machine-readable list of these guides is in [manifest.json](./manifest.json).

Every guide shares the same platform-neutral forwarder core, so the event contract, rules, and troubleshooting are identical across platforms; only the adapter that reads the platform's payload differs.

## For coding agents

Fetch the raw page for the platform and follow "Part 2: Coding agent procedure":

- Sierra: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/sierra.md`
- Decagon: `https://raw.githubusercontent.com/amplitude/Amplitude-AI-Node/main/docs/integrations/decagon.md`

## Your platform is not listed

The forwarder core on either page works for any platform that can give you a conversation transcript: write a `normalize` function for your platform's payload and reuse the rest. If you are running your own agent code rather than a hosted platform, use the Amplitude AI SDK instead ([Node](../../README.md), [Python](https://pypi.org/project/amplitude-ai/)).

## Maintenance

Owner: Amplitude Agent Analytics team. Vendor-specific details are reviewed quarterly and whenever a correction arrives; each page carries its last-verified date. These guides are Amplitude-authored; platform names are trademarks of their owners, and no affiliation or endorsement is implied. Corrections are welcome as pull requests.
