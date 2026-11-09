// Compile-only public API examples; this module is never executed.
import {
  type AgentContext,
  type AmplitudeAI,
  contextProperties,
  extractA2aMetadata,
  extractContext,
  injectA2aResponseMetadata,
  peerProperties,
} from '../../src/index.js';

declare const ai: AmplitudeAI;
declare const metadata: Record<string, unknown>;
declare const headers: Record<string, string | string[] | undefined>;

const agent = ai.agent('seller');
const inbound: AgentContext = extractA2aMetadata(metadata);

// The receiver snippet released docs showed; it must keep compiling.
agent.session({ ...extractContext(headers) });
agent.session({ context: inbound, userId: 'explicit-user' });

const reply: Record<string, unknown> = injectA2aResponseMetadata(metadata);
const peer: Record<string, string> = peerProperties(extractA2aMetadata(reply));
agent.trackToolCall('call_seller', 120, true, { peer: inbound, eventProperties: peer });
const joined: Record<string, string> = contextProperties({ context: inbound });
void joined;
