import { MAX_ARTIFACT_HTML_LENGTH, prepareHtml, validateHtml } from './core/artifact-html.js';
import { MAX_SERIALIZED_LENGTH } from './core/constants.js';
import {
  PrivacyConfig,
  type PrivacyConfigOptions,
  REDACTED_CONTENT_PLACEHOLDER,
  sanitizeStructuredContent,
} from './core/privacy.js';

export type ArtifactPrivacyConfig = PrivacyConfig | PrivacyConfigOptions;
/** Validate static HTML without applying redaction. Throws for unsupported content. */
export const validateArtifactHtml = validateHtml;
const MAX_INPUT_LENGTH = 256 * 1024;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;
const MAX_JSON_DEPTH = 4;
type RecordValue = Record<string, unknown>;
type Prepared = { value: unknown; artifact: boolean };

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: string): unknown {
  if (
    value.length > MAX_INPUT_LENGTH ||
    !['{', '[', '"'].includes(value.trimStart()[0] ?? '') ||
    new TextEncoder().encode(value).length > MAX_INPUT_LENGTH
  )
    return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function markedJson(value: string): boolean {
  if (!['{', '[', '"'].includes(value.trimStart()[0] ?? '')) return false;
  return (
    value.includes('$agent_artifact') ||
    // Undecodable JSON with Unicode escapes can conceal a marker through escape-of-escape layers.
    value.includes('\\u') ||
    value.length > MAX_INPUT_LENGTH ||
    new TextEncoder().encode(value).length > MAX_INPUT_LENGTH
  );
}

function containsArtifact(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH)
    throw new Error('Artifact traversal exceeds bounds');
  if (record(value)) {
    if (Object.hasOwn(value, '$agent_artifact')) return true;
    return Object.values(value).some((v) => containsArtifact(v, depth + 1, budget));
  }
  if (Array.isArray(value)) return value.some((v) => containsArtifact(v, depth + 1, budget));
  if (typeof value === 'string') {
    const parsed = jsonValue(value);
    if (parsed !== undefined && parsed !== value)
      return containsArtifact(parsed, depth + 1, budget);
    if (markedJson(value)) return true;
  }
  return false;
}

function resolved(config?: ArtifactPrivacyConfig): PrivacyConfig {
  return config instanceof PrivacyConfig ? config : new PrivacyConfig(config);
}

function fullContent(pc: PrivacyConfig): boolean {
  return (pc.contentMode ?? (pc.privacyMode ? 'metadata_only' : 'full')) === 'full';
}

function prepare(
  value: unknown,
  pc: PrivacyConfig,
  strip = false,
  alreadySanitized = false,
): Prepared {
  let nodes = 0;
  const ancestors = new Set<object>();
  const redact = (text: string): string => {
    const result = sanitizeStructuredContent(text, pc.redactPii, pc);
    if (typeof result !== 'string') throw new Error('Artifact redaction must return text');
    return result;
  };
  const redactArtifact = (text: string): string => {
    const result = redact(text);
    if (result === REDACTED_CONTENT_PLACEHOLDER && text !== result)
      throw new Error('Artifact redaction failed closed');
    return result;
  };
  function walk(input: unknown, depth = 0, jsonDepth = 0): Prepared {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH)
      throw new Error('Artifact traversal exceeds bounds');
    if (typeof input === 'string') {
      const parsed = jsonValue(input);
      if (parsed !== undefined && containsArtifact(parsed)) {
        if (jsonDepth >= MAX_JSON_DEPTH) return { value: undefined, artifact: true };
        const result = walk(parsed, depth + 1, jsonDepth + 1);
        return {
          value: result.value === undefined ? undefined : JSON.stringify(result.value),
          artifact: true,
        };
      }
      // A truncated/malformed serialized envelope cannot safely fall back to raw markup.
      if (parsed === undefined && markedJson(input)) return { value: undefined, artifact: true };
      return { value: alreadySanitized ? input : redact(input), artifact: false };
    }
    if (!input || typeof input !== 'object') return { value: input, artifact: false };
    if (ancestors.has(input)) throw new Error('Artifact traversal contains a cycle');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const results = input.map((item) => walk(item, depth + 1, jsonDepth));
        return {
          value: results.filter((r) => r.value !== undefined).map((r) => r.value),
          artifact: results.some((r) => r.artifact),
        };
      }
      const source = input as RecordValue;
      let artifact = false;
      let omitted = false;
      const entries: [string, unknown][] = [];
      for (const [key, entry] of Object.entries(source)) {
        if (
          key === '$agent_artifact' &&
          (strip || !record(entry) || typeof entry.type !== 'string')
        ) {
          artifact = true;
          omitted = true;
        } else if (key === '$agent_artifact' && record(entry) && entry.type === 'html') {
          artifact = true;
          try {
            if (strip) throw new Error('Artifact exceeds output bound');
            if (
              entry.v !== 1 ||
              typeof entry.title !== 'string' ||
              !entry.title.trim() ||
              entry.title.length > 200 ||
              !record(entry.payload) ||
              typeof entry.payload.html !== 'string' ||
              entry.payload.html.length > MAX_ARTIFACT_HTML_LENGTH
            )
              throw new Error('Invalid HTML envelope');
            const html = prepareHtml(entry.payload.html, redactArtifact);
            // Protocol tags are not customer prose; redact metadata once, without re-sanitizing HTML.
            const payload = Object.fromEntries(
              Object.entries(entry.payload)
                .filter(([k]) => k !== 'html')
                .map(([k, v]) => [k, walk(v, depth + 1, jsonDepth).value]),
            );
            const body = Object.fromEntries(
              Object.entries(entry)
                .filter(([k]) => !['v', 'type', 'payload', 'title'].includes(k))
                .map(([k, v]) => [k, walk(v, depth + 1, jsonDepth).value]),
            );
            body.title = redactArtifact(entry.title);
            if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)
              throw new Error('Invalid redacted title');
            entries.push([key, { ...body, v: 1, type: 'html', payload: { ...payload, html } }]);
          } catch {
            omitted = true;
          }
        } else if (
          key === 'type' &&
          entry === 'artifact' &&
          Object.hasOwn(source, '$agent_artifact')
        ) {
          entries.push([key, entry]);
        } else {
          artifact ||= key === '$agent_artifact';
          const child = walk(entry, depth + 1, jsonDepth);
          artifact ||= child.artifact;
          if (child.value !== undefined) entries.push([key, child.value]);
        }
      }
      if (omitted && (source.type === 'artifact' || !entries.length))
        return { value: undefined, artifact: true };
      return { value: Object.fromEntries(entries), artifact };
    } finally {
      ancestors.delete(input);
    }
  }
  return walk(value);
}

/**
 * Prepare a content channel for transport without initializing an SDK client.
 * Applies the ordinary privacy chain once, plus bounded static-HTML protection for
 * `$agent_artifact` v1 HTML envelopes, including JSON-serialized envelopes.
 * Unsupported optional artifacts are omitted. `undefined` means omit the channel.
 * This is not a general artifact schema validator or a browser-layout privacy guarantee.
 */
export function prepareArtifactContent(
  value: unknown,
  config?: ArtifactPrivacyConfig,
): unknown | undefined {
  const pc = resolved(config);
  if (!fullContent(pc)) return undefined;
  try {
    if (!containsArtifact(value)) return sanitizeStructuredContent(value, pc.redactPii, pc);
    const input = typeof value === 'string' ? value : JSON.stringify(value);
    const overInputLimit =
      input.length > MAX_INPUT_LENGTH || new TextEncoder().encode(input).length > MAX_INPUT_LENGTH;
    const result = prepare(value, pc, overInputLimit);
    if (result.value === undefined) return undefined;
    const serialized =
      typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    if (
      result.artifact &&
      (serialized.length > MAX_SERIALIZED_LENGTH ||
        new TextEncoder().encode(serialized).length > MAX_INPUT_LENGTH)
    )
      return prepare(result.value, pc, true, true).value;
    return result.value;
  } catch {
    return undefined;
  }
}

/** Prepare one envelope, with HTML-specific checks. This does not validate other artifact schemas. */
export function prepareArtifact(
  envelope: unknown,
  config?: ArtifactPrivacyConfig,
): RecordValue | undefined {
  if (!record(envelope) || !Object.hasOwn(envelope, '$agent_artifact')) return undefined;
  const result = prepareArtifactContent(envelope, config);
  return record(result) && Object.hasOwn(result, '$agent_artifact') ? result : undefined;
}
