type UnknownRecord = Record<string, unknown>;

export interface ProviderResponse<T = unknown> {
  data: T;
  headerRequestId?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers == null || typeof headers !== 'object') return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    return nonEmptyString(
      (get as (this: unknown, key: string) => unknown).call(headers, name),
    );
  }
  const record = headers as UnknownRecord;
  return nonEmptyString(record[name] ?? record[name.toLowerCase()]);
}

export function extractHeaderRequestId(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const record = value as UnknownRecord;
  const containers = [
    record,
    record.response,
    record.httpResponse,
    record.http_response,
    record._response,
  ];
  for (const container of containers) {
    if (container == null || typeof container !== 'object') continue;
    const headers = (container as UnknownRecord).headers;
    const fireworksId = headerValue(headers, 'x-fireworks-request-id');
    if (fireworksId) return fireworksId;
    const requestId = headerValue(headers, 'x-request-id');
    if (requestId) return requestId;
  }
  return nonEmptyString(record._request_id ?? record.request_id);
}

export function extractBodyResponseId(
  value: unknown,
  nestedResponseFirst = false,
): string | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const record = value as UnknownRecord;
  const nested = record.response;
  if (nestedResponseFirst && nested != null && typeof nested === 'object') {
    const nestedId = nonEmptyString((nested as UnknownRecord).id);
    if (nestedId) return nestedId;
  }
  return nonEmptyString(record.id);
}

export function extractProviderRequestId(
  body: unknown,
  headerSource?: unknown,
): string | undefined {
  return (
    extractBodyResponseId(body, true) ??
    nonEmptyString(headerSource) ??
    extractHeaderRequestId(headerSource) ??
    extractHeaderRequestId(body)
  );
}

/**
 * Preserve the SDK's normal data return while exposing raw response headers.
 * OpenAI APIPromise supports withResponse() across the supported v4-v6 range.
 */
export async function resolveProviderResponse<T>(
  result: PromiseLike<T>,
): Promise<ProviderResponse<T>> {
  const withResponse = (result as unknown as { withResponse?: unknown })
    .withResponse;
  if (typeof withResponse === 'function') {
    const wrapped = (await (
      withResponse as (this: unknown) => Promise<unknown>
    ).call(result)) as UnknownRecord;
    return {
      data: wrapped.data as T,
      headerRequestId: extractHeaderRequestId(wrapped),
    };
  }
  const data = await result;
  return {
    data,
    headerRequestId: extractHeaderRequestId(data),
  };
}
