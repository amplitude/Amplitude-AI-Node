// Transport adapters, not an HTML/privacy policy implementation.
// Supply the public @amplitude/ai/artifacts helper to retain supported HTML.
// Without it, HTML/unknown declarations are omitted; supported structured
// mappings and ordinary content keep their existing privacy behavior.

const OMIT = Symbol('omit');
const MAX_DEPTH = 20;
const MAX_VISITS = 10000;
const MAX_JSON_LENGTH = 256 * 1024;
const STRUCTURED_TYPES = new Set(['chart', 'table', 'summary', 'options']);

function inspect(value) {
  let visits = 0;
  let found = false;
  function walk(item, depth) {
    if (++visits > MAX_VISITS || depth > MAX_DEPTH) throw new Error('Content exceeds preparation limits');
    if (typeof item === 'string') {
      if (!/^[\s]*[\[{"]/.test(item)) return item;
      // JSON cannot manufacture the reserved ASCII key without its literal
      // spelling or a Unicode escape. Preserve provably ordinary strings,
      // including oversized/deep JSON, without changing their existing policy.
      if (!item.includes('$agent_artifact') && !item.includes('\\u')) return item;
      if (item.length > MAX_JSON_LENGTH) throw new Error('Content exceeds preparation limits');
      let parsed;
      try { parsed = JSON.parse(item); } catch {
        // Marker/Unicode-bearing malformed JSON cannot safely fall back to raw content.
        throw new Error('Malformed possible artifact JSON');
      }
      const before = found;
      const cleaned = walk(parsed, depth + 1);
      if (cleaned === OMIT) return OMIT;
      return found !== before || JSON.stringify(cleaned) !== JSON.stringify(parsed) ? JSON.stringify(cleaned) : item;
    }
    if (Array.isArray(item)) return item.map(child => walk(child, depth + 1)).filter(child => child !== OMIT);
    if (item && typeof item === 'object') {
      const result = {};
      const marked = Object.hasOwn(item, '$agent_artifact');
      if (marked) found = true;
      const declaration = item.$agent_artifact;
      const structured = marked && declaration && declaration.v === 1 && STRUCTURED_TYPES.has(declaration.type)
        && declaration.payload && typeof declaration.payload === 'object' && !Array.isArray(declaration.payload);
      for (const [key, child] of Object.entries(item)) {
        if (key === '$agent_artifact' && !structured) continue;
        const cleaned = walk(child, depth + 1);
        if (cleaned !== OMIT) Object.defineProperty(result, key, { value: cleaned, enumerable: true });
      }
      if (marked && !structured && (Object.keys(result).length === 0 || result.type === 'artifact')) {
        return OMIT;
      }
      return result;
    }
    return item;
  }
  try {
    const omitted = walk(value, 0);
    return { found, omitted: omitted === OMIT ? undefined : omitted, failed: false };
  } catch {
    return { found: true, omitted: undefined, failed: true };
  }
}

/** True for a recognized envelope, including serialized/nested JSON, or an unsafe marked structure. */
export function hasAgentArtifact(value) {
  return inspect(value).found;
}

/**
 * Prepare one content channel. The callback must be the public artifact helper
 * bound to your approved policy, not a string regex or identity callback.
 * Errors/unsupported values never fall back to the original artifact.
 */
export function prepareArtifactValue(value, prepareArtifacts) {
  const checked = inspect(value);
  if (checked.failed) return undefined;
  if (!checked.found) return value;
  if (typeof prepareArtifacts !== 'function') return checked.omitted;
  try {
    const result = prepareArtifacts(value);
    if (result && typeof result.then === 'function') return undefined;
    return result;
  } catch {
    return undefined;
  }
}

const CONTENT_PROPERTIES = new Set([
  '$llm_message', '[Agent] Tool Input', '[Agent] Tool Output', '[Agent] Attachments',
  '[Agent] Input State', '[Agent] Output State', '[Agent] System Prompt',
  '[Agent] Reasoning Content', '[Agent] Comment', '[Agent] Error Message', '[Agent] Stack Trace',
]);

/** Before HTTP/Batch JSON serialization or writing an S3 event file. No general PII policy is implied. */
/** @template {{ event_properties: Record<string, unknown> | string }} T
 * @param {T[]} events
 * @param {{prepareArtifacts?: (value: unknown) => unknown, redact?: (text: string) => string}} [options]
 * @returns {T[]}
 */
export function prepareAgentEvents(events, { prepareArtifacts, redact } = {}) {
  return events.map(event => {
    const serialized = typeof event.event_properties === 'string';
    let props = event.event_properties;
    if (serialized) {
      try {
        if (props.length > MAX_JSON_LENGTH) throw new Error('Oversized event properties');
        props = JSON.parse(props);
      } catch {
        throw new Error('Event properties must be valid bounded JSON before upload');
      }
    }
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Event properties must be an object');
    const prepared = { ...props };
    for (const key of CONTENT_PROPERTIES) {
      if (!Object.hasOwn(props, key)) continue;
      const input = props[key];
      const handledByHelper = hasAgentArtifact(input) && typeof prepareArtifacts === 'function';
      let value = prepareArtifactValue(input, prepareArtifacts);
      // The configured helper already prepared this content with its chosen policy.
      if (!handledByHelper && typeof redact === 'function') {
        if (typeof value === 'string') value = redact(value);
        else if (key === '$llm_message' && value && typeof value === 'object' && typeof value.text === 'string') {
          value = { ...value, text: redact(value.text) };
        }
      }
      if (value === undefined || (key === '$llm_message' && value && typeof value === 'object' && !Object.hasOwn(value, 'text'))) {
        delete prepared[key];
      } else prepared[key] = value;
    }
    return { ...event, event_properties: serialized ? JSON.stringify(prepared) : prepared };
  });
}

function decodeAny(value, depth = 0, budget = { visits: 0 }) {
  if (++budget.visits > MAX_VISITS || depth > MAX_DEPTH) throw new Error('Artifact AnyValue exceeds preparation limits');
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return value.boolValue;
  if ('intValue' in value) {
    const number = Number(value.intValue);
    if (!Number.isSafeInteger(number)) throw new Error('Artifact AnyValue integer exceeds safe precision');
    return number;
  }
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(child => decodeAny(child, depth + 1, budget));
  if ('kvlistValue' in value) return Object.fromEntries((value.kvlistValue.values ?? []).map(kv => [kv.key, decodeAny(kv.value, depth + 1, budget)]));
  throw new Error('Unsupported artifact AnyValue');
}

function encodeAny(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeAny) } };
  if (value && typeof value === 'object') return { kvlistValue: { values: Object.entries(value).map(([key, item]) => ({ key, value: encodeAny(item) })) } };
  throw new Error('Unsupported prepared AnyValue');
}

/** Prepare OTLP/JSON AnyValues before gzip, export, or upload; this is not a metadata-only/PII scrubber. */
export function prepareOtlpRequest(request, { prepareArtifacts } = {}) {
  function walk(item, depth = 0) {
    if (depth > 40) throw new Error('OTLP envelope exceeds preparation limits');
    if (Array.isArray(item)) return item.map(child => walk(child, depth + 1)).filter(child => child !== undefined);
    if (!item || typeof item !== 'object') return item;
    if (Object.hasOwn(item, 'stringValue')) {
      const value = prepareArtifactValue(item.stringValue, prepareArtifacts);
      return typeof value !== 'string' ? undefined : { ...item, stringValue: value };
    }
    if (Object.hasOwn(item, 'kvlistValue')) {
      const entries = item.kvlistValue.values ?? [];
      const marker = entries.find(entry => entry.key === '$agent_artifact');
      if (marker) {
        // Decode only the declaration, never unrelated int64/bytes siblings.
        // Their wire representation must survive without precision loss.
        const attachment = entries.some(entry => entry.key === 'type' && entry.value?.stringValue === 'artifact');
        let declaration;
        try {
          const value = prepareArtifactValue({ $agent_artifact: decodeAny(marker.value) }, prepareArtifacts);
          if (value && typeof value === 'object' && Object.hasOwn(value, '$agent_artifact')) declaration = encodeAny(value.$agent_artifact);
        } catch { /* Unsupported declaration is omitted, never sent raw. */ }
        if (!declaration && attachment) return undefined;
        const values = entries.flatMap(entry => {
          if (entry.key === '$agent_artifact') return declaration ? [{ ...entry, value: declaration }] : [];
          const prepared = walk(entry, depth + 1);
          return prepared === undefined ? [] : [prepared];
        });
        return values.length ? { ...item, kvlistValue: { ...item.kvlistValue, values } } : undefined;
      }
    }
    const output = {};
    for (const [key, value] of Object.entries(item)) {
      const prepared = walk(value, depth + 1);
      if (prepared === undefined && key === 'value' && Object.hasOwn(item, 'key')) return undefined;
      if (prepared !== undefined) Object.defineProperty(output, key, { value: prepared, enumerable: true });
    }
    return output;
  }
  return walk(request);
}
