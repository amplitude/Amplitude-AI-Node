/**
 * TenantHandle — multi-tenant helper that pre-binds a customerOrgId to agents.
 *
 * @example
 * ```typescript
 * const tenant = ai.tenant('org-123');
 * const agent = tenant.agent('support-bot');
 * ```
 */

import type { BoundAgent } from './bound-agent.js';
import type { AmplitudeAI } from './client.js';

export class TenantHandle {
  private _ai: AmplitudeAI;
  private _customerOrgId: string;
  private _groups: Record<string, unknown> | null;
  private _env: string | null;

  constructor(
    ai: AmplitudeAI,
    opts: {
      customerOrgId: string;
      groups?: Record<string, unknown> | null;
      env?: string | null;
    },
  ) {
    this._ai = ai;
    this._customerOrgId = opts.customerOrgId;
    this._groups = opts.groups ?? null;
    this._env = opts.env ?? null;
  }

  agent(
    agentId: string,
    opts: {
      userId?: string | null;
      parentAgentId?: string | null;
      customerOrgId?: string | null;
      agentVersion?: string | null;
      context?: Record<string, unknown> | null;
      env?: string | null;
      sessionId?: string | null;
      traceId?: string | null;
      groups?: Record<string, unknown> | null;
    } = {},
  ): BoundAgent {
    if (!('customerOrgId' in opts)) opts.customerOrgId = this._customerOrgId;
    if (this._groups != null && !('groups' in opts)) opts.groups = this._groups;
    if (this._env != null && !('env' in opts)) opts.env = this._env;
    return this._ai.agent(agentId, opts);
  }
}
