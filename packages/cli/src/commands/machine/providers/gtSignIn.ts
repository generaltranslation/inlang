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
  UserAuthError,
} from "@generaltranslation/auth";
import type { ProjectSettings } from "@inlang/sdk";
import { parse as parseEnvFile } from "dotenv";
import { log } from "../../../utilities/log.js";
// The API the translate provider calls. Passed to the sign-in, which
// otherwise follows the GT_API_URL variable, so a gt developer's setting can't
// sign this CLI in to another API than the one it translates with.
import { GT_API_URL, GT_DASHBOARD_URL } from "./gt.js";

const KEY_NAME = "Development key (inlang machine translate)";

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
  return {
    ...(await readEnvFile(dir, ".env")),
    ...(await readEnvFile(dir, ".env.local")),
  };
}

async function readEnvFile(
  dir: string,
  file: string,
): Promise<Record<string, string>> {
  const content = await fs
    .readFile(nodePath.join(dir, file), "utf8")
    .catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  return parseEnvFile(content);
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
  const problem = await envLocalProblem(dir);
  if (problem) {
    throw new Error(
      `Can't save the General Translation key: ${problem}, then run again.`,
    );
  }
  let projectId = await findGtProjectId(dir, env);

  if (!(await isSignedIn(account))) {
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
  let addedIgnoreRule = false;
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
        name: nodePath.basename(nodePath.resolve(dir)),
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
    // Saved before the key is made: if that fails, the next run makes a key
    // for this project instead of creating another.
    addedIgnoreRule = await appendToEnvLocal({
      dir,
      text: `GT_PROJECT_ID=${projectId}\n`,
    });
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

  // The key's project ID is kept next to it in .env.local, which names this
  // project already after a failed key. One in .env alone doesn't count: the
  // project ID is shared from .env.local, and .env may change.
  const savedProjectId =
    parseEnvFile(
      await fs
        .readFile(nodePath.join(dir, ".env.local"), "utf8")
        .catch(() => ""),
    ).GT_PROJECT_ID === projectId;
  const addedIgnoreRuleWithKey = await appendToEnvLocal({
    dir,
    text: `${savedProjectId ? "" : `GT_PROJECT_ID=${projectId}\n`}GT_DEV_API_KEY=${key.key}\n`,
  });
  log.success(
    [
      ...(createdProject ? ["Created the General Translation project."] : []),
      "Saved the API key to .env.local.",
      ...(addedIgnoreRule || addedIgnoreRuleWithKey
        ? ["Added .env.local to .gitignore."]
        : []),
    ].join("\n"),
  );
  return { apiKey: key.key, projectId };
}

/**
 * Whether gt's stored sign-in can still make requests. One whose refresh
 * token expired or was revoked stays stored, and only a new sign-in replaces
 * it. A refresh that fails offline counts as signed out too: the new sign-in
 * then fails with its own error.
 */
async function isSignedIn(account: GtAccount): Promise<boolean> {
  if (!(await account.hasLogin())) return false;
  return account.userTokenProvider.getAccessToken().then(
    () => true,
    (error: unknown) => {
      if (error instanceof UserAuthError) return false;
      throw error;
    },
  );
}

/**
 * Why a key must not be saved to `dir/.env.local`, as the start of a
 * sentence that says how to fix it: git tracks it; it is a symlink, through
 * which an ignored .env.local could still write the key to a tracked file; or
 * git doesn't ignore it and can't be made to, as git doesn't read a symlinked
 * .gitignore.
 */
async function envLocalProblem(dir: string): Promise<string | undefined> {
  const tracked = await gitTracksEnvLocal(dir);
  if (typeof tracked === "string") {
    return `git can't tell whether it tracks .env.local (${tracked}). Fix that`;
  }
  if (tracked) {
    return ".env.local is tracked by git. Untrack it with `git rm --cached .env.local`";
  }
  const envLocal = await fs
    .lstat(nodePath.join(dir, ".env.local"))
    .catch(() => undefined);
  if (envLocal?.isSymbolicLink()) {
    return ".env.local is a symbolic link. Replace it with a regular file";
  }
  const gitignore = await fs
    .lstat(nodePath.join(dir, ".gitignore"))
    .catch(() => undefined);
  if (
    gitignore?.isSymbolicLink() &&
    !(await git(dir, "check-ignore", "-q", "--", ".env.local"))
  ) {
    return ".gitignore is a symbolic link, which git doesn't read, so it can't ignore .env.local. Replace it with a regular file";
  }
  return undefined;
}

/**
 * Appends `text` to `dir/.env.local`, which only the user can read if it is
 * new, and resolves whether it added a `.gitignore` rule for the file first.
 * It does unless git ignores the file: outside a work tree too, or a later
 * `git init` would commit it. There git can't tell, so `.env.local` as the
 * last line of `.gitignore` counts too: the rule this run added isn't added
 * again, while an earlier line, which a later one may undo, doesn't count.
 */
async function appendToEnvLocal(args: {
  dir: string;
  text: string;
}): Promise<boolean> {
  const gitignore = nodePath.join(args.dir, ".gitignore");
  const ignored =
    (await git(args.dir, "check-ignore", "-q", "--", ".env.local")) ||
    (await fs.readFile(gitignore, "utf8").catch(() => ""))
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .at(-1) === ".env.local";
  if (!ignored) {
    await appendToFile({ file: gitignore, text: ".env.local\n" });
  }
  await appendToFile({
    file: nodePath.join(args.dir, ".env.local"),
    text: args.text,
    mode: 0o600,
  });
  return !ignored;
}

/**
 * The General Translation project that `dir`'s .env files, gt.config.json or
 * the environment name. One in .env or .env.local comes first: a new key is
 * saved next to it, and readGtCredentials pairs a key with the project ID from
 * the same source. A missing gt.config.json is allowed; an unreadable or
 * invalid one throws, rather than a second project being created.
 */
async function findGtProjectId(
  dir: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const configPath = nodePath.join(dir, "gt.config.json");
  const text = await fs.readFile(configPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let projectId: string | undefined;
  if (text !== undefined) {
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid General Translation config at ${configPath}: expected valid JSON.`,
      );
    }
    if (
      typeof config !== "object" ||
      config === null ||
      Array.isArray(config)
    ) {
      throw new Error(
        `Invalid General Translation config at ${configPath}: expected a JSON object.`,
      );
    }
    if ("projectId" in config) {
      if (typeof config.projectId !== "string" || !config.projectId.trim()) {
        throw new Error(
          `Invalid General Translation config at ${configPath}: projectId must be a non-empty string.`,
        );
      }
      projectId = config.projectId;
    }
  }
  // .env.local overrides .env, as for the app.
  const fromEnvFiles =
    findVariable(await readEnvFile(dir, ".env.local"), PROJECT_ID) ||
    findVariable(await readEnvFile(dir, ".env"), PROJECT_ID);
  const fromEnv = findVariable(env, PROJECT_ID);
  // As gt does: a key for either project would be wrong for some of the
  // project's users.
  for (const [where, other] of [
    [".env.local or .env", fromEnvFiles],
    ["the environment", fromEnv],
  ] as const) {
    if (projectId && other && other !== projectId) {
      throw new Error(
        `Project ID mismatch: gt.config.json uses ${projectId}, but ${where} uses ${other}. Use the same project ID in both, then run again.`,
      );
    }
  }
  return fromEnvFiles || projectId || fromEnv;
}

/**
 * Whether git tracks `dir/.env.local`: false without git or outside a
 * repository, and git's error when it fails otherwise, as in a repository it
 * refuses for "dubious ownership".
 */
function gitTracksEnvLocal(dir: string): Promise<boolean | string> {
  return new Promise((resolve) =>
    execFile(
      "git",
      ["ls-files", "--error-unmatch", "--", ".env.local"],
      // English messages, for "not a git repository".
      { cwd: dir, env: { ...process.env, LC_ALL: "C" } },
      (error, _stdout, stderr) => {
        if (!error) return resolve(true);
        if (
          error.code === 1 ||
          error.code === "ENOENT" ||
          /not a git repository/.test(stderr)
        ) {
          return resolve(false);
        }
        resolve(stderr.trim().split("\n")[0] || error.message);
      },
    ),
  );
}

/** Whether git exits with 0; false without git, where the folder is no work tree. */
function git(dir: string, ...args: string[]): Promise<boolean> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd: dir }, (error) => resolve(!error)),
  );
}

/** Appends `text` to `file` on a new line, creating the file if needed. */
async function appendToFile({
  file,
  text,
  mode,
}: {
  file: string;
  text: string;
  /** Only for a new file. */
  mode?: number;
}): Promise<void> {
  const content = await fs.readFile(file, "utf8").catch(() => "");
  const separator = content && !content.endsWith("\n") ? "\n" : "";
  await fs.appendFile(file, separator + text, { mode });
}
