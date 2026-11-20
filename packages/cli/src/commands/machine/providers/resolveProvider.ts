import nodePath from "node:path";
import type { ProjectSettings } from "@inlang/sdk";
import { version } from "../../../../package.json";
import { log } from "../../../utilities/log.js";
import { createDeepLTranslateProvider } from "./deepl.js";
import { createGoogleTranslateProvider } from "./google.js";
import { createDemosjarcoTranslateProvider } from "./demosjarco.js";
import { createGtTranslateProvider, GT_DASHBOARD_URL } from "./gt.js";
import {
  appendToEnvLocal,
  envLocalProblem,
  findGtProjectId,
  readEnvFiles,
  readGtCredentials,
  shareGtProjectId,
  signInToGt,
} from "./gtSignIn.js";
import { createOpenAITranslateProvider } from "./openai.js";
import type {
  AnyMachineTranslateProvider,
  MachineTranslateProvider,
} from "./types.js";

export const PROVIDER_ENV = "INLANG_MACHINE_TRANSLATE_PROVIDER";
export const GOOGLE_API_KEY_ENV = "INLANG_GOOGLE_TRANSLATE_API_KEY";
export const DEEPL_API_KEY_ENV = "INLANG_DEEPL_API_KEY";
export const OPENAI_API_KEY_ENV = "INLANG_OPENAI_API_KEY";
export const OPENAI_MODEL_ENV = "INLANG_OPENAI_MODEL";
export const OPENAI_REASONING_EFFORT_ENV = "INLANG_OPENAI_REASONING_EFFORT";
export const DEMOSJARCO_MODEL_ENV = "DEMOSJARCO_TRANSLATE_MODEL";
export const DEMOSJARCO_ZDR_ENV = "DEMOSJARCO_TRANSLATE_ZDR";

export type MachineTranslateProviderName =
  | "google"
  | "deepl"
  | "openai"
  | "gt"
  | "demosjarco";

const BYOK_URL = "https://inlang.com/m/2qj2w8pu/app-inlang-cli/byok";
export const GT_SETUP_URL =
  "https://inlang.com/m/2qj2w8pu/app-inlang-cli#machine-translate";
const DEEPL_DOCS_URL =
  "https://developers.deepl.com/docs/getting-started/quickstart";

/**
 * An error whose message is for the user as is: the command prints it
 * without a stack trace. When translations failed or were rejected,
 * `translated` translations came back intact and were added to the project.
 */
export class MachineTranslateError extends Error {
  override name = "MachineTranslateError";
  constructor(
    message: string,
    readonly translated = 0,
  ) {
    super(message);
  }
}

type Env = Record<string, string | undefined>;

/**
 * Determines which provider to use.
 *
 * When `INLANG_MACHINE_TRANSLATE_PROVIDER` is set, that provider is used. When
 * it is unset, an already-configured BYOK provider (Google, DeepL or OpenAI)
 * is used if its API key is present; otherwise General Translation.
 */
function resolveMachineTranslateProviderName(
  env: Env,
): MachineTranslateProviderName {
  const rawProvider = env[PROVIDER_ENV]?.trim();

  if (rawProvider && rawProvider.length > 0) {
    const providerName = rawProvider.toLowerCase();
    if (
      providerName !== "google" &&
      providerName !== "deepl" &&
      providerName !== "openai" &&
      providerName !== "gt" &&
      providerName !== "demosjarco"
    ) {
      throw new Error(
        [
          `Unsupported ${PROVIDER_ENV} value: "${env[PROVIDER_ENV]}".`,
          "Supported values: google, deepl, openai, gt, demosjarco.",
        ].join("\n"),
      );
    }
    return providerName;
  }

  // No provider configured: prefer a BYOK provider whose key is already set.
  if (env[GOOGLE_API_KEY_ENV]) {
    return "google";
  }
  if (env[DEEPL_API_KEY_ENV]) {
    return "deepl";
  }
  if (env[OPENAI_API_KEY_ENV]) {
    return "openai";
  }
  return "gt";
}

export async function resolveMachineTranslateProvider(args: {
  env: Env;
  /** The project.inlang path. General Translation credentials, and a choice of community translation, are read from and saved to the folder that contains it. */
  projectPath: string;
  settings: ProjectSettings;
  /** Whether the user can be asked to sign in. */
  interactive: boolean;
  /** Sign in with a code instead of a browser on this machine. */
  noBrowser?: boolean;
  signIn?: typeof signInToGt;
}): Promise<AnyMachineTranslateProvider> {
  const dir = nodePath.dirname(nodePath.resolve(args.projectPath));
  const fileEnv = await readEnvFiles(dir);
  const env = { ...fileEnv, ...args.env };
  // Preserve explicit providers and BYOK keys in the shell ahead of saved
  // preferences. Otherwise all providers read the same project env files.
  const environmentSelectsProvider =
    args.env[PROVIDER_ENV]?.trim() ||
    [GOOGLE_API_KEY_ENV, DEEPL_API_KEY_ENV, OPENAI_API_KEY_ENV].some(
      (key) => args.env[key],
    );
  env[PROVIDER_ENV] = args.env[PROVIDER_ENV]?.trim() || fileEnv[PROVIDER_ENV];
  const providerName = resolveMachineTranslateProviderName(
    environmentSelectsProvider ? args.env : env,
  );
  if (providerName !== "gt") {
    const provider = resolveNamedProvider(providerName, env);
    if (providerName === "demosjarco" && !environmentSelectsProvider) {
      log.info(
        `You chose this service in .env or .env.local. To be asked about General Translation again, remove ${PROVIDER_ENV} from it.`,
      );
    }
    return provider;
  }

  // Keep GT keys paired with project IDs from the same source.
  let credentials = await readGtCredentials({ env: args.env, dir });
  if (!credentials) {
    if (!args.interactive) {
      // Keyless automation keeps the community service it used before GT was
      // the default. A project that chose GT, by name or with a project ID (a
      // committed gt.config.json), fails instead: a missing CI secret, as in a
      // pull request from a fork, must not send its text to another service.
      if (!env[PROVIDER_ENV]?.trim() && !(await findGtProjectId(dir, env))) {
        log.info(
          `No translation provider configured. Using the community service. General Translation setup for CI and coding agents: ${GT_SETUP_URL}. To use this service without this message, set ${PROVIDER_ENV}=demosjarco.`,
        );
        return createCommunityProvider(env);
      }
      // A `gt` sign-in on this machine still makes a key, without asking.
      credentials = await (args.signIn ?? signInToGt)({
        dir,
        settings: args.settings,
        env,
        interactive: false,
      }).catch((error: Error) => {
        throw new MachineTranslateError(error.message);
      });
      if (!credentials) throw await missingGtKeyError(dir);
    } else {
      // consola otherwise resolves a cancelled prompt with `initial`, a sign-in.
      const choice = await log.prompt(
        "Which translation provider should this project use?",
        {
          type: "select",
          options: [
            { value: "gt", label: "General Translation (recommended)" },
            { value: "community", label: "Community translation service" },
            { value: "other", label: "Other" },
          ],
          initial: "gt",
          cancel: "undefined",
        },
      );
      if (choice === "other") {
        // Nothing is saved: the provider set up from the docs is used without asking.
        throw new MachineTranslateError(
          `To use another translation provider, see ${BYOK_URL}, then run this command again.`,
        );
      }
      if (choice === "community") {
        const provider = createCommunityProvider(env);
        const addedIgnoreRule = await appendToEnvLocal({
          dir,
          text: `${PROVIDER_ENV}=demosjarco\n`,
        });
        log.info(
          [
            `Saved your choice to .env.local. To be asked again, remove ${PROVIDER_ENV} from it.`,
            ...(addedIgnoreRule ? ["Added .env.local to .gitignore."] : []),
          ].join("\n"),
        );
        return provider;
      }
      if (choice === "gt") {
        credentials = await (args.signIn ?? signInToGt)({
          dir,
          settings: args.settings,
          env,
          noBrowser: args.noBrowser,
        }).catch((error: Error) => {
          // Its errors are for the user, so they print without a stack trace.
          throw new MachineTranslateError(error.message);
        });
      }
      if (!credentials) {
        throw new MachineTranslateError(
          `No translation provider. Run again to sign in to General Translation, or bring your own key: ${BYOK_URL}`,
        );
      }
    }
  }
  if (await shareGtProjectId(dir)) {
    log.info(
      "Saved the General Translation project ID to gt.config.json. Commit it so teammates use the same project.",
    );
  }
  return createGtTranslateProvider({
    ...credentials,
    userAgent: `inlang-cli/${version}`,
  });
}

/** CI and agents that chose GT, without a `gt` sign-in, are told how to get a key. */
async function missingGtKeyError(dir: string): Promise<MachineTranslateError> {
  // Sign-in saves the key to .env.local, so it is held back where sign-in
  // would refuse to save it.
  const problem = await envLocalProblem(dir);
  return new MachineTranslateError(
    [
      "Machine translation needs a General Translation API key.",
      "- In a terminal: run this command directly to sign in. It can't ask through a task runner that captures its output or with CI set. Over SSH, open the printed sign-in URL in your browser.",
      `- CI: set GT_API_KEY and GT_PROJECT_ID from your project at ${GT_DASHBOARD_URL}.`,
      problem
        ? `- Agents: a development key can't be saved: ${problem}, then run this command again.`
        : "- Agents: have the user run this command in their terminal, or sign in with `npx gt login --no-browser`, then run this command again. Signed in, it saves a development key to .env.local.",
      `- Or use the community-operated service: set ${PROVIDER_ENV}=demosjarco.`,
      `- Or bring your own key: ${BYOK_URL}`,
    ].join("\n"),
  );
}

function createCommunityProvider(env: Env): MachineTranslateProvider {
  // Names the service once per run, without arguing against a choice the
  // user made; a run that fell back to it says why separately.
  log.info(
    "Translating with the community-operated service at translate.demosjarco.dev, which inlang doesn't operate.",
  );
  // Scoped to the free service only: opt in to Zero Data Retention upstream.
  const zdr = env[DEMOSJARCO_ZDR_ENV]?.trim().toLowerCase() === "true";
  return createDemosjarcoTranslateProvider(env[DEMOSJARCO_MODEL_ENV], zdr);
}

function resolveNamedProvider(
  providerName: Exclude<MachineTranslateProviderName, "gt">,
  env: Env,
): MachineTranslateProvider {
  if (providerName === "demosjarco") return createCommunityProvider(env);

  if (providerName === "deepl") {
    const apiKey = env[DEEPL_API_KEY_ENV];
    if (!apiKey) {
      throw new Error(
        [
          `${DEEPL_API_KEY_ENV} must be set to use machine translate with DeepL.`,
          "Create your own DeepL API key and export it before running this command.",
          `See ${DEEPL_DOCS_URL}`,
          `See ${BYOK_URL}`,
        ].join("\n"),
      );
    }
    return createDeepLTranslateProvider(apiKey);
  }

  if (providerName === "openai") {
    const apiKey = env[OPENAI_API_KEY_ENV];
    if (!apiKey) {
      throw new Error(
        [
          `${OPENAI_API_KEY_ENV} must be set to use machine translate with OpenAI.`,
          "Create an OpenAI API key and export it before running this command.",
          `See ${BYOK_URL}`,
        ].join("\n"),
      );
    }
    return createOpenAITranslateProvider(
      apiKey,
      env[OPENAI_MODEL_ENV]?.trim() || undefined,
      env[OPENAI_REASONING_EFFORT_ENV]?.trim() || undefined,
    );
  }

  const apiKey = env[GOOGLE_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      [
        `${GOOGLE_API_KEY_ENV} must be set to use machine translate.`,
        "Create your own Google Cloud Translation API key and export it before running this command.",
        `See ${BYOK_URL}`,
      ].join("\n"),
    );
  }
  return createGoogleTranslateProvider(apiKey);
}
