import nodePath from "node:path";
import type { ProjectSettings } from "@inlang/sdk";
import { version } from "../../../../package.json";
import { log } from "../../../utilities/log.js";
import { createDeepLTranslateProvider } from "./deepl.js";
import { createGoogleTranslateProvider } from "./google.js";
import { createDemosjarcoTranslateProvider } from "./demosjarco.js";
import { createGtTranslateProvider, GT_DASHBOARD_URL } from "./gt.js";
import {
  GT_CLI,
  appendToEnvLocal,
  findGtProjectId,
  gtInitArgs,
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
  /** The project.inlang path. General Translation credentials, and the choice made by answering No, are read from and saved to the folder that contains it. */
  projectPath: string;
  settings: ProjectSettings;
  /** Whether the user can be asked to sign in. */
  interactive: boolean;
  signIn?: typeof signInToGt;
}): Promise<AnyMachineTranslateProvider> {
  const { env } = args;
  const providerName = resolveMachineTranslateProviderName(env);
  if (providerName !== "gt") return resolveNamedProvider(providerName, env);

  const dir = nodePath.dirname(nodePath.resolve(args.projectPath));
  // Answering No saves the choice to .env.local. A provider or key in the
  // environment beats it.
  if (
    !(PROVIDER_ENV in env) &&
    (await readEnvFiles(dir))[PROVIDER_ENV] === "demosjarco"
  ) {
    const provider = createCommunityProvider(env);
    log.info(
      `You chose this service in .env.local. To be asked about General Translation again, remove ${PROVIDER_ENV} from it.`,
    );
    return provider;
  }
  let credentials = await readGtCredentials({ env, dir });
  if (!credentials) {
    if (!args.interactive) {
      // Keyless automation keeps the community service it used before GT was
      // the default. A project that chose GT, by name or with a project ID (a
      // committed gt.config.json), fails instead: a missing CI secret, as in a
      // pull request from a fork, must not send its text to another service.
      if (!env[PROVIDER_ENV]?.trim() && !(await findGtProjectId(dir, env))) {
        log.info(
          `No translation provider configured. Using the community service. To use General Translation, set GT_API_KEY and GT_PROJECT_ID from your project at ${GT_DASHBOARD_URL}. To use this service without this message, set ${PROVIDER_ENV}=demosjarco.`,
        );
        return createCommunityProvider(env);
      }
      throw await missingGtKeyError(dir, args.settings, env);
    }
    log.log(
      "Machine translation is powered by General Translation. Answer No to use the community translation service instead.",
    );
    // consola otherwise resolves a cancelled confirm with `initial`, a yes.
    const confirmed = await log.prompt(
      "Use General Translation for this project?",
      {
        type: "confirm",
        initial: true,
        cancel: "undefined",
      },
    );
    if (confirmed === false) {
      const provider = createCommunityProvider(env);
      const addedIgnoreRule = await appendToEnvLocal(
        dir,
        `${PROVIDER_ENV}=demosjarco\n`,
      );
      log.info(
        [
          `Saved your choice to .env.local. To be asked again, remove ${PROVIDER_ENV} from it.`,
          ...(addedIgnoreRule ? ["Added .env.local to .gitignore."] : []),
        ].join("\n"),
      );
      return provider;
    }
    if (confirmed) {
      credentials = await (args.signIn ?? signInToGt)({
        dir,
        settings: args.settings,
        env,
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

/** CI and agents that chose GT can't sign in here, so they are told how to get a key. */
async function missingGtKeyError(
  dir: string,
  settings: ProjectSettings,
  env: Env,
): Promise<MachineTranslateError> {
  const init = ["npx", ...(await gtInitArgs({ dir, settings, env }))]
    .map(shellQuote)
    .join(" ");
  const envLocal = shellQuote(nodePath.resolve(dir, ".env.local"));
  // gt init adds gt to a package.json in its folder, so it runs in an empty
  // one, and the .env.local it saves there is appended to the project's. The
  // subshell keeps the caller's working directory: an agent's shell keeps it
  // between commands, and this command must then run again from where it was.
  const command = `(d=$(mktemp -d) && cd "$d" && ${init} && { echo; cat .env.local; } >> ${envLocal})`;
  return new MachineTranslateError(
    [
      "Machine translation needs a General Translation API key.",
      "- In a terminal: run this command directly to sign in. It can't ask through a task runner that captures its output, with CI set, or on Linux without a display.",
      `- CI: set GT_API_KEY and GT_PROJECT_ID from your project at ${GT_DASHBOARD_URL}.`,
      `- Agents: have the user sign in with \`npx --yes ${GT_CLI} login --no-browser\`, then run \`${command}\` to save a development key to .env.local, check that git ignores .env.local, and run this command again.`,
      `- Or use the community-operated service: set ${PROVIDER_ENV}=demosjarco.`,
      `- Or bring your own key: ${BYOK_URL}`,
    ].join("\n"),
  );
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function createCommunityProvider(env: Env): MachineTranslateProvider {
  log.warn(
    [
      "Using the community-operated translation service at translate.demosjarco.dev. Stability is not guaranteed.",
      "This service is not owned, operated, or maintained by inlang.",
      `Provide your own API key for higher reliability and control: ${BYOK_URL}`,
    ].join("\n"),
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
