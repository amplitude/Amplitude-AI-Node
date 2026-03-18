export interface MessageLabelData {
  key: string;
  value: string;
  confidence?: number;
}

export class MessageLabel {
  readonly key: string;
  readonly value: string;
  readonly confidence: number | null;

  constructor(options: { key: string; value: string; confidence?: number }) {
    this.key = options.key;
    this.value = options.value;
    this.confidence = options.confidence ?? null;
  }

  toDict(): MessageLabelData {
    const result: MessageLabelData = { key: this.key, value: this.value };
    if (this.confidence != null) {
      result.confidence = this.confidence;
    }
    return result;
  }
}

export interface EvidenceQuoteData {
  quote: string;
  turn_index: number;
  role?: string;
}

export class EvidenceQuote {
  readonly quote: string;
  readonly turnIndex: number;
  readonly role: string | null;

  constructor(options: { quote: string; turnIndex: number; role?: string }) {
    this.quote = options.quote;
    this.turnIndex = options.turnIndex;
    this.role = options.role ?? null;
  }

  toDict(): EvidenceQuoteData {
    const result: EvidenceQuoteData = {
      quote: this.quote,
      turn_index: this.turnIndex,
    };
    if (this.role != null) {
      result.role = this.role;
    }
    return result;
  }
}

export interface TopicClassificationData {
  l1?: string;
  values?: string[];
  primary?: string;
  /** @deprecated Use `subcategories` instead. */
  l2?: string;
  subcategories?: string[];
  topics_covered?: string[];
  outcomes_by_topic?: Record<string, string>;
}

export class TopicClassification {
  readonly l1: string | null;
  readonly values: string[] | null;
  readonly primary: string | null;
  /** @deprecated Use {@link subcategories} instead. */
  readonly l2: string | null;
  readonly subcategories: string[] | null;
  readonly topicsCovered: string[] | null;
  readonly outcomesByTopic: Record<string, string> | null;

  constructor(
    options: {
      l1?: string;
      values?: string[];
      primary?: string;
      /** @deprecated Use `subcategories` instead. */
      l2?: string;
      subcategories?: string[];
      topicsCovered?: string[];
      outcomesByTopic?: Record<string, string>;
    } = {},
  ) {
    this.l1 = options.l1 ?? null;
    this.values = options.values ?? null;
    this.primary = options.primary ?? null;
    this.l2 = options.l2 ?? null;
    this.subcategories = options.subcategories ?? null;
    this.topicsCovered = options.topicsCovered ?? null;
    this.outcomesByTopic = options.outcomesByTopic ?? null;
  }

  toDict(): TopicClassificationData {
    const result: TopicClassificationData = {};
    if (this.l1 != null) result.l1 = this.l1;
    if (this.values != null) result.values = this.values;
    if (this.primary != null) result.primary = this.primary;
    if (this.l2 != null) result.l2 = this.l2;
    if (this.subcategories != null) result.subcategories = this.subcategories;
    if (this.topicsCovered != null) result.topics_covered = this.topicsCovered;
    if (this.outcomesByTopic != null)
      result.outcomes_by_topic = this.outcomesByTopic;
    return result;
  }
}

export interface RubricScoreData {
  name: string;
  score: number;
  rationale?: string;
  evidence?: EvidenceQuoteData[];
  improvement_opportunities?: string;
}

export class RubricScore {
  readonly name: string;
  readonly score: number;
  readonly rationale: string | null;
  readonly evidence: EvidenceQuote[] | null;
  readonly improvementOpportunities: string | null;

  constructor(options: {
    name: string;
    score: number;
    rationale?: string;
    evidence?: EvidenceQuote[];
    improvementOpportunities?: string;
  }) {
    this.name = options.name;
    this.score = options.score;
    this.rationale = options.rationale ?? null;
    this.evidence = options.evidence ?? null;
    this.improvementOpportunities = options.improvementOpportunities ?? null;
  }

  toDict(): RubricScoreData {
    const result: RubricScoreData = { name: this.name, score: this.score };
    if (this.rationale != null) result.rationale = this.rationale;
    if (this.evidence != null)
      result.evidence = this.evidence.map((e) => e.toDict());
    if (this.improvementOpportunities != null)
      result.improvement_opportunities = this.improvementOpportunities;
    return result;
  }
}

export interface SessionEnrichmentsOptions {
  topicClassifications?: Record<string, TopicClassification>;
  rubrics?: RubricScore[];
  overallOutcome?: string;
  hasTaskFailure?: boolean;
  hasNegativeFeedback?: boolean;
  hasDataQualityIssues?: boolean;
  hasTechnicalFailure?: boolean;
  errorCategories?: string[];
  behavioralPatterns?: string[];
  customMetadata?: Record<string, unknown>;
  schemaVersion?: string;
  qualityScore?: number;
  sentimentScore?: number;
  taskFailureType?: string;
  taskFailureReason?: string;
  negativeFeedbackPhrases?: string[];
  dataQualityIssues?: string[];
  technicalErrorCount?: number;
  agentChain?: string[];
  rootAgentName?: string;
  requestComplexity?: string;
  messageLabels?: Record<string, MessageLabel[]>;
}

export class SessionEnrichments {
  readonly topicClassifications: Record<string, TopicClassification> | null;
  readonly rubrics: RubricScore[] | null;
  readonly overallOutcome: string | null;
  readonly hasTaskFailure: boolean;
  readonly hasNegativeFeedback: boolean;
  readonly hasDataQualityIssues: boolean;
  readonly hasTechnicalFailure: boolean;
  readonly errorCategories: string[] | null;
  readonly behavioralPatterns: string[] | null;
  readonly customMetadata: Record<string, unknown> | null;
  readonly schemaVersion: string;
  readonly qualityScore: number | null;
  readonly sentimentScore: number | null;
  readonly taskFailureType: string | null;
  readonly taskFailureReason: string | null;
  readonly negativeFeedbackPhrases: string[] | null;
  readonly dataQualityIssues: string[] | null;
  readonly technicalErrorCount: number | null;
  readonly agentChain: string[] | null;
  readonly rootAgentName: string | null;
  readonly requestComplexity: string | null;
  readonly messageLabels: Record<string, MessageLabel[]> | null;

  constructor(options: SessionEnrichmentsOptions = {}) {
    this.topicClassifications = options.topicClassifications ?? null;
    this.rubrics = options.rubrics ?? null;
    this.overallOutcome = options.overallOutcome ?? null;
    this.hasTaskFailure = options.hasTaskFailure ?? false;
    this.hasNegativeFeedback = options.hasNegativeFeedback ?? false;
    this.hasDataQualityIssues = options.hasDataQualityIssues ?? false;
    this.hasTechnicalFailure = options.hasTechnicalFailure ?? false;
    this.errorCategories = options.errorCategories ?? null;
    this.behavioralPatterns = options.behavioralPatterns ?? null;
    this.customMetadata = options.customMetadata ?? null;
    this.schemaVersion = options.schemaVersion ?? '2.0';
    this.qualityScore = options.qualityScore ?? null;
    this.sentimentScore = options.sentimentScore ?? null;
    this.taskFailureType = options.taskFailureType ?? null;
    this.taskFailureReason = options.taskFailureReason ?? null;
    this.negativeFeedbackPhrases = options.negativeFeedbackPhrases ?? null;
    this.dataQualityIssues = options.dataQualityIssues ?? null;
    this.technicalErrorCount = options.technicalErrorCount ?? null;
    this.agentChain = options.agentChain ?? null;
    this.rootAgentName = options.rootAgentName ?? null;
    this.requestComplexity = options.requestComplexity ?? null;
    this.messageLabels = options.messageLabels ?? null;
  }

  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (this.topicClassifications != null) {
      const tc: Record<string, TopicClassificationData> = {};
      for (const [name, classification] of Object.entries(
        this.topicClassifications,
      )) {
        tc[name] = classification.toDict();
      }
      result.topic_classifications = tc;
    }

    if (this.rubrics != null) {
      result.rubrics = this.rubrics.map((r) => r.toDict());
    }

    if (this.overallOutcome != null)
      result.overall_outcome = this.overallOutcome;

    // Boolean flags — always include
    result.has_task_failure = this.hasTaskFailure;
    result.has_negative_feedback = this.hasNegativeFeedback;
    result.has_data_quality_issues = this.hasDataQualityIssues;
    result.has_technical_failure = this.hasTechnicalFailure;

    if (this.errorCategories != null)
      result.error_categories = this.errorCategories;
    if (this.behavioralPatterns != null)
      result.behavioral_patterns = this.behavioralPatterns;
    if (this.customMetadata != null)
      result.custom_metadata = this.customMetadata;

    result.schema_version = this.schemaVersion;

    if (this.qualityScore != null) result.quality_score = this.qualityScore;
    if (this.sentimentScore != null)
      result.sentiment_score = this.sentimentScore;
    if (this.taskFailureType != null)
      result.task_failure_type = this.taskFailureType;
    if (this.taskFailureReason != null)
      result.task_failure_reason = this.taskFailureReason;
    if (this.negativeFeedbackPhrases != null)
      result.negative_feedback_phrases = this.negativeFeedbackPhrases;
    if (this.dataQualityIssues != null)
      result.data_quality_issues = this.dataQualityIssues;
    if (this.technicalErrorCount != null)
      result.technical_error_count = this.technicalErrorCount;
    if (this.agentChain != null) result.agent_chain = this.agentChain;
    if (this.rootAgentName != null) result.root_agent_name = this.rootAgentName;
    if (this.requestComplexity != null)
      result.request_complexity = this.requestComplexity;

    if (this.messageLabels != null) {
      const ml: Record<string, MessageLabelData[]> = {};
      for (const [mid, labels] of Object.entries(this.messageLabels)) {
        ml[mid] = labels.map((lbl) => lbl.toDict());
      }
      result.message_labels = ml;
    }

    return result;
  }
}
