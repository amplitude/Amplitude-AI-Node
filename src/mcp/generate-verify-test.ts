import type { ScanResult } from './scan-project.js';

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function generateVerifyTest(scanResult: ScanResult): string {
  const lines: string[] = [];

  lines.push(
    "import { describe, it, expect } from 'vitest';",
    "import { MockAmplitudeAI } from '@amplitude/ai/testing';",
    '',
    "describe('Amplitude AI verification', () => {",
  );

  for (const agent of scanResult.agents) {
    const eid = escapeStr(agent.inferred_id);
    lines.push(
      `  it('${eid} emits correct event sequence', () => {`,
      '    const mock = new MockAmplitudeAI();',
      `    const agent = mock.agent('${eid}');`,
      "    const session = agent.session({ userId: 'verify-user', sessionId: 'verify-session' });",
      '    session.runSync((s) => {',
      "      s.trackUserMessage('test message');",
      '    });',
      '    const events = mock.getEvents();',
      '    expect(events.length).toBeGreaterThanOrEqual(2);',
      `    mock.assertEventTracked('[Agent] User Message', { '[Agent] Agent ID': '${eid}' });`,
      "    mock.assertSessionClosed('verify-session');",
      '  });',
      '',
    );
  }

  const shouldEmitMultiAgentTests =
    (scanResult.is_multi_agent || scanResult.multi_agent_signals.length > 0) &&
    scanResult.agents.length >= 2;

  if (shouldEmitMultiAgentTests) {
    const parentAgent = scanResult.agents[0];
    const childAgent = scanResult.agents[1];

    if (parentAgent && childAgent) {
      const pid = escapeStr(parentAgent.inferred_id);
      const cid = escapeStr(childAgent.inferred_id);

      lines.push(
        "  it('multi-agent delegation via runAs', () => {",
        '    const mock = new MockAmplitudeAI();',
        `    const parent = mock.agent('${pid}');`,
        `    const child = parent.child('${cid}');`,
        "    const session = parent.session({ userId: 'verify-user', sessionId: 'verify-multi' });",
        '    session.runSync((s) => {',
        '      s.runAsSync(child, (cs) => {',
        "        cs.trackUserMessage('delegated task');",
        '      });',
        '    });',
        `    const childEvents = mock.eventsForAgent('${cid}');`,
        '    expect(childEvents.length).toBeGreaterThan(0);',
        "    expect(childEvents[0].event_properties?.['[Agent] Session ID']).toBe('verify-multi');",
        '  });',
        '',
      );

      const childAgents = scanResult.agents.slice(0, 2);
      lines.push(
        "  it('parallel fan-out shares session', async () => {",
        '    const mock = new MockAmplitudeAI();',
        `    const orchestrator = mock.agent('${pid}');`,
        '    const children = [',
      );
      for (const child of childAgents) {
        lines.push(
          `      orchestrator.child('${escapeStr(child.inferred_id)}'),`,
        );
      }
      lines.push(
        '    ];',
        "    const session = orchestrator.session({ userId: 'verify-user', sessionId: 'verify-parallel' });",
        '    await session.run(async (s) => {',
        '      await Promise.all(children.map((child) =>',
        '        s.runAs(child, async (cs) => {',
        "          cs.trackUserMessage('parallel task');",
        '        }),',
        '      ));',
        '    });',
        '    for (const child of children) {',
        '      const events = mock.eventsForAgent(child.agentId);',
        '      expect(events.length).toBeGreaterThan(0);',
        "      expect(events[0].event_properties?.['[Agent] Session ID']).toBe('verify-parallel');",
        '    }',
        '  });',
        '',
      );

      lines.push(
        "  it('tool calls inside runAs are attributed to child agent', () => {",
        '    const mock = new MockAmplitudeAI();',
        `    const parent = mock.agent('${pid}');`,
        `    const child = parent.child('${cid}');`,
        "    const session = parent.session({ userId: 'verify-user', sessionId: 'verify-tools' });",
        '    session.runSync((s) => {',
        '      s.runAsSync(child, (cs) => {',
        "        cs.trackToolCall('search_knowledge_base', 150, true);",
        '      });',
        '    });',
        "    const toolEvents = mock.getEvents().filter(e => e.event_type === '[Agent] Tool Call');",
        '    expect(toolEvents.length).toBe(1);',
        `    expect(toolEvents[0].event_properties?.['[Agent] Agent ID']).toBe('${cid}');`,
        `    expect(toolEvents[0].event_properties?.['[Agent] Parent Agent ID']).toBe('${pid}');`,
        '  });',
        '',
      );

      lines.push(
        "  it('runAs restores parent context after child throws', () => {",
        '    const mock = new MockAmplitudeAI();',
        `    const parent = mock.agent('${pid}');`,
        `    const faultyChild = parent.child('${cid}-faulty');`,
        "    const session = parent.session({ userId: 'verify-user', sessionId: 'verify-error' });",
        '    session.runSync((s) => {',
        '      try {',
        '        s.runAsSync(faultyChild, () => {',
        "          throw new Error('child failed');",
        '        });',
        '      } catch {',
        "        s.trackUserMessage('recovering from child failure');",
        '      }',
        '    });',
        `    const parentEvents = mock.eventsForAgent('${pid}');`,
        "    const recoveryMsg = parentEvents.find(e => e.event_type === '[Agent] User Message');",
        '    expect(recoveryMsg).toBeDefined();',
        `    expect(recoveryMsg?.event_properties?.['[Agent] Agent ID']).toBe('${pid}');`,
        '  });',
        '',
      );
    }
  }

  lines.push('});', '');

  return lines.join('\n');
}
