/**
 * CrewAI integration — stub for TypeScript.
 *
 * CrewAI is a Python-only framework. This module is a placeholder
 * to maintain API parity with the Python SDK. It will throw an
 * informative error if someone tries to use it.
 */

import { ProviderError } from '../exceptions.js';

export class AmplitudeCrewAIHooks {
  constructor() {
    throw new ProviderError(
      'CrewAI is a Python-only framework. The @amplitude/ai CrewAI integration ' +
        'is not available in Node.js. Use the LangChain or OpenTelemetry integration instead.',
    );
  }
}
