import { DIALECTS } from './dialects.mjs';
import { renderSample } from './formats.mjs';
import { renderTail } from './tail.mjs';

/** Full runnable query for a message format: sample source, Stage 1, Stage 2. */
export function renderMessageQuery(format, dialectId, { source } = {}) {
  const d = DIALECTS[dialectId];
  if (!d) throw new Error(`unknown dialect ${dialectId}`);
  const sourceBody = source ?? renderSample(d, format.sourceColumns, format.sampleRows);
  return `WITH
-- Stage 1a: source rows. This sample makes the query run as-is.
-- Replace the body with: SELECT * FROM <your table>
source AS (
${sourceBody}
),
-- Stage 1b (${format.id}): normalize into canonical message rows.
${format.ctes ? `${format.ctes(d)},\n` : ''}canonical AS (
${format.normalize(d)}
),
${renderTail(d)}`;
}
