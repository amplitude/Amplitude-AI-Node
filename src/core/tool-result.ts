/**
 * Validation for `[Agent] Result ID` / `[Agent] Result Type`.
 *
 * Shared by `tool()` and the OTel mapper. The Python SDK and the nova OTLP
 * receiver apply the same rules; `test/fixtures/tool-result-cases.json` pins
 * them.
 */

import { getLogger } from '../utils/logger.js';
import { PROP_RESULT_ID, PROP_RESULT_TYPE } from './constants.js';

export const RESULT_ID_MAX_LENGTH = 512;
// ASCII whitespace only: Python, JavaScript, and Java disagree on Unicode
// whitespace, and the three runtimes must accept exactly the same IDs.
const _RESULT_ID_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
const _RESULT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** What a successful tool created, returned by the `tool()` `result` hook. */
export interface ToolResult {
  id: string | number;
  type?: string | null;
}

function _isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function _resultId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.replace(_RESULT_ID_TRIM, '');
    const length = [...trimmed].length;
    return length > 0 && length <= RESULT_ID_MAX_LENGTH ? trimmed : null;
  }
  return null;
}

/** `[Agent] Result ID` / `[Agent] Result Type` for a `{ id, type }` object, or `{}`. */
export function sanitizeToolResult(
  result: unknown,
  toolName = '',
): Record<string, string> {
  if (!_isPlainRecord(result)) {
    if (result != null) {
      getLogger().debug(
        `Tool '${toolName}': tool result must be a plain { id, type } object; dropped`,
      );
    }
    return {};
  }
  const record = result;
  const resultId = _resultId(record.id);
  if (resultId == null) {
    getLogger().debug(`Tool '${toolName}': tool result has no valid 'id'; dropped`);
    return {};
  }
  const clean: Record<string, string> = { [PROP_RESULT_ID]: resultId };
  const resultType = record.type;
  if (resultType != null) {
    if (typeof resultType === 'string' && _RESULT_TYPE_PATTERN.test(resultType)) {
      clean[PROP_RESULT_TYPE] = resultType;
    } else {
      getLogger().debug(
        `Tool '${toolName}': tool result 'type' must match [a-z][a-z0-9_]*; dropped`,
      );
    }
  }
  return clean;
}

/** `eventProperties` can't set the SDK-managed Result ID / Result Type. */
export function withoutResultProps(
  props: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (props == null || (!(PROP_RESULT_ID in props) && !(PROP_RESULT_TYPE in props))) {
    return props;
  }
  const { [PROP_RESULT_ID]: _id, [PROP_RESULT_TYPE]: _type, ...rest } = props;
  return rest;
}
