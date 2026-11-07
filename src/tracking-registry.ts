import type { AmplitudeAI } from './client.js';
import { getActiveContext } from './context.js';

const _byTransport = new WeakMap<object, AmplitudeAI>();

/** @internal Called by the AmplitudeAI constructor. */
export function registerTrackingClient(ai: AmplitudeAI, transport: unknown): void {
  if (transport != null && typeof transport === 'object') {
    _byTransport.set(transport, ai);
  }
}

/**
 * @internal Pick the AmplitudeAI that should record a patched provider call:
 * the one that owns the active session, falling back to the patch owner.
 */
export function resolveTrackingAI(owner: AmplitudeAI): AmplitudeAI {
  const transport = getActiveContext()?.amplitude;
  if (transport == null || typeof transport !== 'object') return owner;
  return _byTransport.get(transport) ?? owner;
}
