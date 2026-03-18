export class AmplitudeAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmplitudeAIError';
  }
}

export class ConfigurationError extends AmplitudeAIError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class TrackingError extends AmplitudeAIError {
  constructor(message: string) {
    super(message);
    this.name = 'TrackingError';
  }
}

export class ProviderError extends AmplitudeAIError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ValidationError extends AmplitudeAIError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
