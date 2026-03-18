import { describe, expect, it } from 'vitest';
import {
  EvidenceQuote,
  MessageLabel,
  RubricScore,
  SessionEnrichments,
  TopicClassification,
} from '../../src/core/enrichments.js';

describe('MessageLabel', () => {
  it('serializes to dict without confidence', () => {
    const label = new MessageLabel({ key: 'sentiment', value: 'positive' });
    expect(label.toDict()).toEqual({ key: 'sentiment', value: 'positive' });
  });

  it('serializes to dict with confidence', () => {
    const label = new MessageLabel({
      key: 'topic',
      value: 'billing',
      confidence: 0.9,
    });
    expect(label.toDict()).toEqual({
      key: 'topic',
      value: 'billing',
      confidence: 0.9,
    });
  });
});

describe('EvidenceQuote', () => {
  it('serializes with role', () => {
    const quote = new EvidenceQuote({
      quote: 'test',
      turnIndex: 3,
      role: 'assistant',
    });
    expect(quote.toDict()).toEqual({
      quote: 'test',
      turn_index: 3,
      role: 'assistant',
    });
  });

  it('omits null role', () => {
    const quote = new EvidenceQuote({ quote: 'test', turnIndex: 0 });
    expect(quote.toDict()).toEqual({ quote: 'test', turn_index: 0 });
  });
});

describe('TopicClassification', () => {
  it('serializes single-select', () => {
    const tc = new TopicClassification({ l1: 'diagnostic' });
    expect(tc.toDict()).toEqual({ l1: 'diagnostic' });
  });

  it('serializes multi-select', () => {
    const tc = new TopicClassification({
      values: ['charts', 'cohorts'],
      primary: 'charts',
    });
    expect(tc.toDict()).toEqual({
      values: ['charts', 'cohorts'],
      primary: 'charts',
    });
  });
});

describe('RubricScore', () => {
  it('serializes with evidence', () => {
    const score = new RubricScore({
      name: 'task_completion',
      score: 0.85,
      rationale: 'Completed well',
      evidence: [
        new EvidenceQuote({ quote: 'Done!', turnIndex: 5, role: 'assistant' }),
      ],
    });
    const dict = score.toDict();
    expect(dict.name).toBe('task_completion');
    expect(dict.score).toBe(0.85);
    expect(dict.evidence).toHaveLength(1);
  });
});

describe('SessionEnrichments', () => {
  it('always includes boolean flags', () => {
    const enrichments = new SessionEnrichments();
    const dict = enrichments.toDict();
    expect(dict.has_task_failure).toBe(false);
    expect(dict.has_negative_feedback).toBe(false);
    expect(dict.has_data_quality_issues).toBe(false);
    expect(dict.has_technical_failure).toBe(false);
    expect(dict.schema_version).toBe('2.0');
  });

  it('serializes full enrichments', () => {
    const enrichments = new SessionEnrichments({
      topicClassifications: {
        intent: new TopicClassification({ l1: 'diagnostic' }),
      },
      rubrics: [new RubricScore({ name: 'quality', score: 0.9 })],
      overallOutcome: 'response_provided',
      qualityScore: 0.85,
    });
    const dict = enrichments.toDict();
    expect(dict.topic_classifications).toBeDefined();
    expect(dict.rubrics).toHaveLength(1);
    expect(dict.overall_outcome).toBe('response_provided');
    expect(dict.quality_score).toBe(0.85);
  });
});

// --------------------------------------------------------
// TopicClassification expanded tests
// --------------------------------------------------------

describe('TopicClassification expanded', () => {
  it('with l2 field (legacy)', (): void => {
    const tc = new TopicClassification({ l1: 'analytics', l2: 'retention' });
    const dict = tc.toDict();
    expect(dict.l1).toBe('analytics');
    expect(dict.l2).toBe('retention');
  });

  it('with subcategories field', (): void => {
    const tc = new TopicClassification({
      l1: 'analytics',
      subcategories: ['TREND_ANALYSIS', 'WRONG_EVENT'],
    });
    const dict = tc.toDict();
    expect(dict.l1).toBe('analytics');
    expect(dict.subcategories).toEqual(['TREND_ANALYSIS', 'WRONG_EVENT']);
    expect(dict.l2).toBeUndefined();
  });

  it('serializes both l2 and subcategories when both set', (): void => {
    const tc = new TopicClassification({
      l2: 'retention',
      subcategories: ['TREND_ANALYSIS'],
    });
    const dict = tc.toDict();
    expect(dict.l2).toBe('retention');
    expect(dict.subcategories).toEqual(['TREND_ANALYSIS']);
  });

  it('omits null subcategories from toDict', (): void => {
    const tc = new TopicClassification({ l1: 'support' });
    const dict = tc.toDict();
    expect(dict.subcategories).toBeUndefined();
  });

  it('with topicsCovered (multi-select)', (): void => {
    const tc = new TopicClassification({
      topicsCovered: ['charts', 'cohorts', 'funnels'],
    });
    const dict = tc.toDict();
    expect(dict.topics_covered).toEqual(['charts', 'cohorts', 'funnels']);
  });

  it('with outcomesByTopic', (): void => {
    const tc = new TopicClassification({
      outcomesByTopic: { billing: 'resolved', usage: 'unresolved' },
    });
    const dict = tc.toDict();
    expect(dict.outcomes_by_topic).toEqual({
      billing: 'resolved',
      usage: 'unresolved',
    });
  });

  it('omits null fields from toDict', (): void => {
    const tc = new TopicClassification({ l1: 'support' });
    const dict = tc.toDict();
    expect(dict.l1).toBe('support');
    expect(dict.l2).toBeUndefined();
    expect(dict.values).toBeUndefined();
    expect(dict.primary).toBeUndefined();
    expect(dict.topics_covered).toBeUndefined();
    expect(dict.outcomes_by_topic).toBeUndefined();
  });
});

// --------------------------------------------------------
// RubricScore expanded tests
// --------------------------------------------------------

describe('RubricScore expanded', () => {
  it('with rationale', (): void => {
    const score = new RubricScore({
      name: 'helpfulness',
      score: 0.7,
      rationale: 'Mostly helpful',
    });
    const dict = score.toDict();
    expect(dict.rationale).toBe('Mostly helpful');
  });

  it('with evidence quotes', (): void => {
    const score = new RubricScore({
      name: 'accuracy',
      score: 0.9,
      evidence: [
        new EvidenceQuote({
          quote: 'correct answer',
          turnIndex: 2,
          role: 'assistant',
        }),
        new EvidenceQuote({
          quote: 'confirmed by user',
          turnIndex: 3,
          role: 'user',
        }),
      ],
    });
    const dict = score.toDict();
    expect(dict.evidence).toHaveLength(2);
    expect(dict.evidence![0].quote).toBe('correct answer');
    expect(dict.evidence![1].role).toBe('user');
  });

  it('with improvement opportunities', (): void => {
    const score = new RubricScore({
      name: 'completeness',
      score: 0.5,
      improvementOpportunities: 'Could include more examples',
    });
    const dict = score.toDict();
    expect(dict.improvement_opportunities).toBe('Could include more examples');
  });

  it('minimal (name + score only)', (): void => {
    const score = new RubricScore({ name: 'speed', score: 1.0 });
    const dict = score.toDict();
    expect(dict.name).toBe('speed');
    expect(dict.score).toBe(1.0);
    expect(dict.rationale).toBeUndefined();
    expect(dict.evidence).toBeUndefined();
    expect(dict.improvement_opportunities).toBeUndefined();
  });
});

// --------------------------------------------------------
// EvidenceQuote expanded tests
// --------------------------------------------------------

describe('EvidenceQuote expanded', () => {
  it('with role', (): void => {
    const quote = new EvidenceQuote({
      quote: 'example text',
      turnIndex: 5,
      role: 'user',
    });
    const dict = quote.toDict();
    expect(dict.quote).toBe('example text');
    expect(dict.turn_index).toBe(5);
    expect(dict.role).toBe('user');
  });

  it('without role (omitted from dict)', (): void => {
    const quote = new EvidenceQuote({ quote: 'no role', turnIndex: 1 });
    const dict = quote.toDict();
    expect(dict.quote).toBe('no role');
    expect(dict.turn_index).toBe(1);
    expect('role' in dict).toBe(false);
  });
});

// --------------------------------------------------------
// SessionEnrichments expanded tests
// --------------------------------------------------------

describe('SessionEnrichments expanded', () => {
  it('with qualityScore', (): void => {
    const e = new SessionEnrichments({ qualityScore: 0.92 });
    expect(e.toDict().quality_score).toBe(0.92);
  });

  it('with sentimentScore', (): void => {
    const e = new SessionEnrichments({ sentimentScore: -0.3 });
    expect(e.toDict().sentiment_score).toBe(-0.3);
  });

  it('with taskFailureType and reason', (): void => {
    const e = new SessionEnrichments({
      taskFailureType: 'hallucination',
      taskFailureReason: 'Model provided incorrect data',
    });
    const dict = e.toDict();
    expect(dict.task_failure_type).toBe('hallucination');
    expect(dict.task_failure_reason).toBe('Model provided incorrect data');
  });

  it('with negativeFeedback', (): void => {
    const e = new SessionEnrichments({
      hasNegativeFeedback: true,
      negativeFeedbackPhrases: ['this is wrong', 'not helpful'],
    });
    const dict = e.toDict();
    expect(dict.has_negative_feedback).toBe(true);
    expect(dict.negative_feedback_phrases).toEqual([
      'this is wrong',
      'not helpful',
    ]);
  });

  it('with agentChain and rootAgentName', (): void => {
    const e = new SessionEnrichments({
      agentChain: ['orchestrator', 'researcher', 'writer'],
      rootAgentName: 'orchestrator',
    });
    const dict = e.toDict();
    expect(dict.agent_chain).toEqual(['orchestrator', 'researcher', 'writer']);
    expect(dict.root_agent_name).toBe('orchestrator');
  });

  it('with requestComplexity', (): void => {
    const e = new SessionEnrichments({ requestComplexity: 'high' });
    expect(e.toDict().request_complexity).toBe('high');
  });

  it('with messageLabels', (): void => {
    const e = new SessionEnrichments({
      messageLabels: {
        'msg-1': [
          new MessageLabel({
            key: 'sentiment',
            value: 'positive',
            confidence: 0.95,
          }),
        ],
        'msg-2': [new MessageLabel({ key: 'topic', value: 'billing' })],
      },
    });
    const dict = e.toDict();
    const ml = dict.message_labels as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(ml['msg-1']).toHaveLength(1);
    expect(ml['msg-1'][0].key).toBe('sentiment');
    expect(ml['msg-1'][0].confidence).toBe(0.95);
    expect(ml['msg-2']).toHaveLength(1);
    expect(ml['msg-2'][0].key).toBe('topic');
  });

  it('boolean flags default to false', (): void => {
    const e = new SessionEnrichments();
    expect(e.hasTaskFailure).toBe(false);
    expect(e.hasNegativeFeedback).toBe(false);
    expect(e.hasDataQualityIssues).toBe(false);
    expect(e.hasTechnicalFailure).toBe(false);
  });

  it('schemaVersion defaults to 2.0', (): void => {
    const e = new SessionEnrichments();
    expect(e.schemaVersion).toBe('2.0');
    expect(e.toDict().schema_version).toBe('2.0');
  });
});
