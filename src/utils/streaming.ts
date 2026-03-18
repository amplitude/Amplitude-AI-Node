export interface StreamingAccumulatorState {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  finishReason: string | null;
  toolCalls: Array<Record<string, unknown>>;
  model: string | null;
  ttfbMs: number | null;
  isError: boolean;
  errorMessage: string | null;
}

export class StreamingAccumulator {
  content = '';
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  totalTokens: number | null = null;
  reasoningTokens: number | null = null;
  cacheReadTokens: number | null = null;
  cacheCreationTokens: number | null = null;
  finishReason: string | null = null;
  toolCalls: Array<Record<string, unknown>> = [];
  model: string | null = null;
  ttfbMs: number | null = null;
  isError = false;
  errorMessage: string | null = null;
  private _startTime: number;
  private _firstChunkReceived = false;

  constructor() {
    this._startTime = performance.now();
  }

  addContent(chunk: string): void {
    if (!this._firstChunkReceived) {
      this.ttfbMs = performance.now() - this._startTime;
      this._firstChunkReceived = true;
    }
    this.content += chunk;
  }

  /**
   * Set (overwrite) token usage fields. Only non-null values are written,
   * allowing incremental updates where different streaming events provide
   * different fields (e.g. Anthropic message_start vs message_delta).
   */
  setUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    if (usage.inputTokens != null) this.inputTokens = usage.inputTokens;
    if (usage.outputTokens != null) this.outputTokens = usage.outputTokens;
    if (usage.totalTokens != null) this.totalTokens = usage.totalTokens;
    if (usage.reasoningTokens != null)
      this.reasoningTokens = usage.reasoningTokens;
    if (usage.cacheReadTokens != null)
      this.cacheReadTokens = usage.cacheReadTokens;
    if (usage.cacheCreationTokens != null)
      this.cacheCreationTokens = usage.cacheCreationTokens;
  }

  addToolCall(toolCall: Record<string, unknown>): void {
    this.toolCalls.push(toolCall);
  }

  setError(message: string): void {
    this.isError = true;
    this.errorMessage = message;
  }

  getState(): StreamingAccumulatorState {
    return {
      content: this.content,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      finishReason: this.finishReason,
      toolCalls: this.toolCalls,
      model: this.model,
      ttfbMs: this.ttfbMs,
      isError: this.isError,
      errorMessage: this.errorMessage,
    };
  }

  get elapsedMs(): number {
    return performance.now() - this._startTime;
  }
}
