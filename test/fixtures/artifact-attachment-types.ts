// Compile-only public API examples; this module is never executed.
import type { AmplitudeAI } from '../../src/index.js';

declare const ai: AmplitudeAI;
const agent = ai.agent('reporter', { userId: 'user' });
agent.trackUserMessage('Report', {
  attachments: [
    {
      type: 'artifact',
      $agent_artifact: {
        v: 1,
        type: 'html',
        title: 'Report',
        payload: { html: '<p>Approved content</p>' },
      },
    },
  ],
});
agent.trackAiMessage('Report', 'model', 'provider', 10, {
  attachments: [
    {
      type: 'artifact',
      $agent_artifact: {
        v: 1,
        type: 'html',
        title: 'Report',
        payload: { html: '<p>Approved content</p>' },
      },
    },
  ],
});
