/**
 * Internal utilities — not part of the public API surface.
 *
 * Exported via @amplitude/ai/internals for advanced use cases only.
 * These may change without notice between minor versions.
 */

// Provider internals
export {
  BaseAIProvider,
  SimpleStreamingTracker,
  applySessionContext,
} from './providers/base.js';
export type { ProviderTrackOptions } from './providers/base.js';

// Cost calculation internals
export { stripProviderPrefix, inferProvider } from './utils/costs.js';

// Streaming
export { StreamingAccumulator } from './utils/streaming.js';

// Tracking function types
export type {
  TrackUserMessageOptions,
  TrackAiMessageOptions,
  TrackToolCallOptions,
  TrackConversationOptions,
  TrackEmbeddingOptions,
  TrackSpanOptions,
  TrackSessionEndOptions,
  TrackSessionEnrichmentOptions,
  TrackScoreOptions,
} from './core/tracking.js';
