export type TranslateTextArgs = {
  text: string;
  sourceLocale: string;
  targetLocale: string;
  /** Shared translator guidance; never part of the text to translate. */
  context?: string;
};

export type TranslateFailure = {
  ok: false;
  error: string;
  unavailable?: boolean;
  /** Set when the caller tells the user something specific, e.g. how to add credit. */
  code?: "unauthorized" | "payment-required";
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

/** Fails as a whole if any text of the batch failed. */
export type TranslateBatchResult =
  | { ok: true; translatedTexts: Record<string, string> }
  | TranslateFailure;

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
