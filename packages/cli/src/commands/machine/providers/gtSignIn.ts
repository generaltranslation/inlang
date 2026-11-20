import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import {
  createApiClient,
  createProject,
  createProjectApiKey,
  listOrgs,
  paginate,
  ProjectApiKeyPermission,
  type UserTokenProvider,
} from "@generaltranslation/api";
import {
  createUserTokenProvider,
  hasLogin,
  login,
} from "@generaltranslation/auth";
import type { ProjectSettings } from "@inlang/sdk";
import { log } from "../../../utilities/log.js";

// The API the translate provider calls too. Passed to the sign-in, which
// otherwise follows GT_API_URL, so a gt developer's setting can't sign this
// CLI in to another API than the one it translates with.
const GT_API_URL = "https://api.gtx.dev";
const GT_DASHBOARD_URL = "https://dash.generaltranslation.com";
const KEY_NAME = "Development key (inlang machine translate)";
// The API's limit, in UTF-16 code units.
const MAX_PROJECT_NAME_LENGTH = 64;

type GtCredentials = { apiKey: string; projectId?: string };

type Prompt = (
  message: string,
  options: NonNullable<Parameters<typeof log.prompt>[1]>,
) => Promise<unknown>;

/**
 * General Translation credentials from `env`, else from `dir`'s `.env` and
 * `.env.local`, the files gt itself loads (`.env.local` overrides `.env`).
 * Key and project ID come from the same source, so a key from `env` is never
 * paired with a project ID from a file.
 *
 * `gt init` names the variables after the framework: `GT_API_KEY` for
 * Next.js, `<prefix>GT_DEV_API_KEY` (e.g. `VITE_`) otherwise, and the project
 * ID `<prefix>GT_PROJECT_ID` with the key's prefix.
 */
export async function readGtCredentials(args: {
  env: Record<string, string | undefined>;
  dir: string;
}): Promise<GtCredentials | undefined> {
  return (
    findCredentials(args.env) ?? findCredentials(await readEnvFiles(args.dir))
  );
}

/** The key's prefix is group 1. */
const API_KEY = /^(?:GT_API_KEY|((?:\w*_)?)GT_DEV_API_KEY)$/;
const PROJECT_ID = /(^|_)GT_PROJECT_ID$/;

function findVariable(
  variables: Record<string, string | undefined>,
  name: RegExp,
): string | undefined {
  return Object.entries(variables).find(
    ([key, value]) => name.test(key) && value,
  )?.[1];
}

function findCredentials(
  variables: Record<string, string | undefined>,
): GtCredentials | undefined {
  for (const [name, apiKey] of Object.entries(variables)) {
    const match = API_KEY.exec(name);
    if (!match || !apiKey) continue;
    // A project ID of another prefix belongs to another key, such as the
    // server's `GT_PROJECT_ID` next to a client's `VITE_GT_DEV_API_KEY`.
    return {
      apiKey,
      projectId: variables[`${match[1] ?? ""}GT_PROJECT_ID`] || undefined,
    };
  }
  return undefined;
}

async function readEnvFiles(dir: string): Promise<Record<string, string>> {
  const variables: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    const content = await fs
      .readFile(nodePath.join(dir, file), "utf8")
      .catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    Object.assign(variables, parseEnvFile(content));
  }
  return variables;
}

function parseEnvFile(content: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/.exec(
        line,
      );
    if (match) variables[match[1]!] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return variables;
}

/** The sign-in and the user's API client; tests replace them. */
export type GtAccount = {
  hasLogin: () => Promise<boolean>;
  login: (options: Parameters<typeof login>[0]) => Promise<void>;
  userTokenProvider: UserTokenProvider;
  fetch?: typeof fetch;
};

// consola's methods read `this`.
const warn = (message: string) => log.warn(message);

const defaultAccount: GtAccount = {
  hasLogin: () => hasLogin({ baseUrl: GT_API_URL, onWarning: warn }),
  login,
  // Reads the sign-in only when a request needs it.
  userTokenProvider: createUserTokenProvider({
    baseUrl: GT_API_URL,
    onWarning: warn,
  }),
};

/**
 * Signs the user in to General Translation, unless a `gt` sign-in on this
 * machine is still valid, and makes a key for the project `dir`'s .env files,
 * gt.config.json or `env` name, creating one in the user's organization
 * otherwise. The key may only translate. It and its project ID are appended
 * to `dir/.env.local`, and the key is never printed. It may ask for an
 * organization, so call it only in an interactive terminal. Resolves
 * `undefined` if the user cancels that.
 *
 * `.env.local` gets a `.gitignore` rule unless git ignores it already, and a
 * tracked or symlinked `.env.local` fails before the sign-in.
 */
export async function signInToGt(args: {
  dir: string;
  settings: ProjectSettings;
  env: Record<string, string | undefined>;
  prompt?: Prompt;
  account?: GtAccount;
}): Promise<GtCredentials | undefined> {
  const {
    dir,
    settings,
    env,
    // consola's prompt reads `this`.
    prompt = (message, options) => log.prompt(message, options),
    account = defaultAccount,
  } = args;
  if (
    (await git(dir, "ls-files", "--error-unmatch", "--", ".env.local")) === 0
  ) {
    throw new Error(
      "Can't save the General Translation key: .env.local is tracked by git. Untrack it with `git rm --cached .env.local`, then run again.",
    );
  }
  // The key is appended through a symlink, so an ignored .env.local could
  // still write it to a tracked file.
  const envLocal = await fs
    .lstat(nodePath.join(dir, ".env.local"))
    .catch(() => undefined);
  if (envLocal?.isSymbolicLink()) {
    throw new Error(
      "Can't save the General Translation key: .env.local is a symbolic link. Replace it with a regular file, then run again.",
    );
  }

  const config = await fs
    .readFile(nodePath.join(dir, "gt.config.json"), "utf8")
    .catch(() => undefined);
  // One in .env or .env.local comes first: the key is saved next to it, and
  // readGtCredentials pairs a key with the project ID from the same source.
  let projectId: string | undefined =
    findVariable(await readEnvFiles(dir), PROJECT_ID) ||
    parseJson(config ?? "")?.projectId ||
    findVariable(env, PROJECT_ID);

  if (!(await account.hasLogin())) {
    await account.login({
      baseUrl: GT_API_URL,
      onWarning: warn,
      onAuthorizationUrl: (url) =>
        log.log(
          `Opening your browser to sign in to General Translation. If it doesn't open, visit:\n${url}`,
        ),
      // Over SSH, or where no browser can be opened.
      onDeviceCode: ({ userCode, verificationUri, verificationUriComplete }) =>
        log.log(
          verificationUriComplete
            ? `Sign in to General Translation in your browser: ${verificationUriComplete}`
            : `Sign in to General Translation in your browser: ${verificationUri}\nThen enter the code ${userCode}.`,
        ),
    });
  }
  const client = createApiClient({
    baseUrl: GT_API_URL,
    userTokenProvider: account.userTokenProvider,
    ...(account.fetch ? { fetch: account.fetch } : {}),
  });

  let createdProject = false;
  if (!projectId) {
    const orgs = [];
    for await (const org of paginate(listOrgs, { client })) orgs.push(org);
    if (orgs.length === 0) {
      throw new Error(
        `Your General Translation account has no organization. Create one at ${GT_DASHBOARD_URL}, then run again.`,
      );
    }
    const orgId =
      orgs.length === 1
        ? orgs[0]!.id
        : await prompt(
            "Which General Translation organization should the project belong to?",
            {
              type: "select",
              options: orgs.map((org) => ({ label: org.name, value: org.id })),
              cancel: "undefined",
            },
          );
    if (typeof orgId !== "string") return undefined;
    const { data } = await createProject({
      client,
      path: { orgId },
      body: {
        name: projectName(dir),
        defaultLocale: settings.baseLocale,
      },
      throwOnError: true,
    }).catch((error: Error) => {
      throw new Error(
        `Couldn't create the General Translation project: ${error.message}`,
      );
    });
    projectId = data.id;
    createdProject = true;
  }
  const { data: key } = await createProjectApiKey({
    client,
    path: { projectId },
    body: {
      name: KEY_NAME,
      permissions: [ProjectApiKeyPermission["PROJECT:TRANSLATIONS:GENERATE"]],
    },
    throwOnError: true,
  }).catch((error: Error) => {
    throw new Error(
      `Couldn't create a General Translation API key for project ${projectId}: ${error.message}`,
    );
  });

  // Exit code 0: ignored. Outside a work tree the rule is added too, or a
  // later `git init` would commit the key.
  const ignored =
    (await git(dir, "check-ignore", "-q", "--", ".env.local")) === 0;
  if (!ignored) {
    await appendToFile(nodePath.join(dir, ".gitignore"), ".env.local\n");
  }
  await appendToFile(
    nodePath.join(dir, ".env.local"),
    `GT_PROJECT_ID=${projectId}\nGT_DEV_API_KEY=${key.key}\n`,
    { mode: 0o600 },
  );
  log.success(
    [
      ...(createdProject ? ["Created the General Translation project."] : []),
      "Saved the API key to .env.local.",
      ...(ignored ? [] : ["Added .env.local to .gitignore."]),
    ].join("\n"),
  );
  return { apiKey: key.key, projectId };
}

/**
 * The folder's name, as the project's, cut to the API's length at a whole
 * character.
 */
function projectName(dir: string): string {
  let name = nodePath.basename(nodePath.resolve(dir));
  while (name.length > MAX_PROJECT_NAME_LENGTH) {
    name = [...name].slice(0, -1).join("");
  }
  return name;
}

/** git's exit code; null without git, where the folder is no work tree. */
function git(dir: string, ...args: string[]): Promise<number | null> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd: dir }, (error) =>
      resolve(!error ? 0 : typeof error.code === "number" ? error.code : null),
    ),
  );
}

/** Appends `text` to `file` on a new line, creating the file if needed. */
async function appendToFile(
  file: string,
  text: string,
  options?: { mode: number },
): Promise<void> {
  const content = await fs.readFile(file, "utf8").catch(() => "");
  const separator = content && !content.endsWith("\n") ? "\n" : "";
  await fs.appendFile(file, separator + text, options);
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
