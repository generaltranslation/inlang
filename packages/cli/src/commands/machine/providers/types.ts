export type TranslateTextArgs = {
  text: string;
  sourceLocale: string;
  targetLocale: string;
  /** Shared translator guidance; never part of the text to translate. */
  context?: string;
  /**
   * Aborts when the run stops: a provider that queues or retries requests
   * sends none after it, and returns a failure with `stopped`.
   */
  signal?: AbortSignal;
};

export type TranslateFailure = {
  ok: false;
  error: string;
  /** Text failures leave other requests worth trying; omitted scope means provider-wide. */
  scope?: "text" | "provider";
  /** A 429: the request wasn't processed, so it may be sent again. */
  rateLimited?: boolean;
  /** How long the provider asked to wait before sending it again. */
  retryAfterMs?: number;
  /** Not sent, as the run stopped (see `TranslateTextArgs.signal`). */
  stopped?: boolean;
};

export type TranslateTextResult =
  | { ok: true; translatedText: string }
  | TranslateFailure;

export type TranslateBatchArgs = {
  sourceLocale: string;
  targetLocale: string;
  /** The texts to translate, by a key unique in the batch. */
  texts: Record<string, { text: string; context?: string }>;
};

/** Fails if any text of the batch failed, with the texts it did translate. */
export type TranslateBatchResult =
  | { ok: true; translatedTexts: Record<string, string> }
  | (TranslateFailure & { translatedTexts?: Record<string, string> });

export type MachineTranslateProvider = {
  /** Whether this provider uses translator guidance. */
  supportsContext?: boolean;
  translateText: (args: TranslateTextArgs) => Promise<TranslateTextResult>;
};

/** A provider whose API translates many texts of one locale pair per request. */
export type BatchMachineTranslateProvider = {
  /** Whether this provider uses translator guidance. */
  supportsContext?: boolean;
  translateBatch: (args: TranslateBatchArgs) => Promise<TranslateBatchResult>;
};

export type AnyMachineTranslateProvider =
  | MachineTranslateProvider
  | BatchMachineTranslateProvider;
