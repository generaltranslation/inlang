import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { createInterface } from "node:readline";
import type { ProjectSettings } from "@inlang/sdk";
import { log } from "../../../utilities/log.js";

// Pinned because this module parses `gt init --json`'s flags and events, which
// a new gt release may change. Bump only after rechecking both.
export const GT_CLI = "gt@2.28.3";
const GT_LOG_TAIL_LINES = 20;
// gt requires a file pattern even though its file workflow isn't used.
const GT_FILE_PATTERN = "json=./messages/[locale].json";

type GtCredentials = { apiKey: string; projectId?: string };

/**
 * Runs `command` and resolves with its exit code and stderr when it exits.
 * Each stdout line is passed to `onStdoutLine` as it arrives.
 */
type RunProcess = (
  command: string,
  args: string[],
  options: { cwd: string; onStdoutLine: (line: string) => void },
) => Promise<{ code: number | null; stderr: string }>;

type Prompt = (
  message: string,
  options: NonNullable<Parameters<typeof log.prompt>[1]>,
) => Promise<unknown>;

type InitResult = {
  type: "result";
  outcome: "success" | "failed";
  completedSteps?: string[];
  error?: string;
  missingOptions?: string[];
};

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

export async function readEnvFiles(
  dir: string,
): Promise<Record<string, string>> {
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

/**
 * Signs the user in to General Translation with `gt init --json`, which
 * creates a project (unless `dir`'s gt.config.json, .env files or the
 * environment name one) and makes a development key for it, then appends the
 * key to `dir/.env.local`. It may ask for an organization, so call it only in
 * an interactive terminal. Resolves `undefined` if the user cancels that.
 *
 * `.env.local` gets a `.gitignore` rule unless git ignores it already, and a
 * tracked `.env.local` fails before the sign-in.
 */
export async function signInToGt(args: {
  dir: string;
  settings: ProjectSettings;
  env: Record<string, string | undefined>;
  run?: RunProcess;
  prompt?: Prompt;
  openUrl?: (url: string) => void;
}): Promise<GtCredentials | undefined> {
  const {
    dir,
    settings,
    env,
    run = runProcess,
    // consola's prompt reads `this`.
    prompt = (message, options) => log.prompt(message, options),
    openUrl = openInBrowser,
  } = args;
  if (
    (await git(dir, "ls-files", "--error-unmatch", "--", ".env.local")).code ===
    0
  ) {
    throw new Error(
      "Can't save the General Translation key: .env.local is tracked by git. Untrack it with `git rm --cached .env.local`, then run again.",
    );
  }

  const initArgs = await gtInitArgs({ dir, settings, env });
  // gt init adds gt to a package.json in its folder and installs it, which
  // can't be turned off, so it runs in an empty one.
  const cwd = await fs.mkdtemp(nodePath.join(os.tmpdir(), "inlang-gt-"));
  const init = async (extraArgs: string[]) => {
    let result: InitResult | undefined;
    const { stderr } = await run("npx", [...initArgs, ...extraArgs], {
      cwd,
      onStdoutLine: (line) => {
        const event = parseJson(line);
        if (event?.type === "authorization_required") {
          log.log(
            `Sign in to General Translation in your browser: ${event.verificationUriComplete}`,
          );
          // `gt init --json` only prints the URL, it never opens a browser.
          openUrl(event.verificationUriComplete);
        } else if (event?.type === "result") {
          result = event;
        }
      },
    });
    return { result, stderr };
  };

  try {
    let { result, stderr } = await init([]);
    const orgs = result?.missingOptions?.includes("--org-id")
      ? parseOrgs(result.error ?? "")
      : [];
    if (orgs.length > 0) {
      const orgId = await prompt(
        "Which General Translation organization should the project belong to?",
        {
          type: "select",
          options: orgs.map((org) => ({ label: org.name, value: org.id })),
          cancel: "undefined",
        },
      );
      if (typeof orgId !== "string") return undefined;
      // The sign-in is stored by now, so the rerun doesn't ask again.
      ({ result, stderr } = await init(["--org-id", orgId]));
    }
    if (result?.outcome !== "success") {
      const tail = stderr
        .trimEnd()
        .split("\n")
        .slice(-GT_LOG_TAIL_LINES)
        .join("\n");
      throw new Error(
        [
          `General Translation sign-in failed: ${result?.error ?? "gt init exited without a result."}`,
          ...(tail ? ["", "gt's log:", tail] : []),
        ].join("\n"),
      );
    }

    const credentials = await readGtCredentials({ env: {}, dir: cwd });
    if (!credentials) {
      throw new Error(
        "gt init finished without saving a General Translation key to .env.local.",
      );
    }
    const addedIgnoreRule = await appendToEnvLocal(
      dir,
      await fs.readFile(nodePath.join(cwd, ".env.local"), "utf8"),
    );
    log.success(
      [
        ...(result.completedSteps?.some((step) =>
          step.startsWith("created project "),
        )
          ? ["Created the General Translation project."]
          : []),
        "Saved the API key to .env.local.",
        ...(addedIgnoreRule ? ["Added .env.local to .gitignore."] : []),
      ].join("\n"),
    );
    return credentials;
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Appends `text` to `dir/.env.local`, which only the user can read if it is
 * new, and resolves whether it added a `.gitignore` rule for the file first.
 * It does unless git ignores the file: outside a work tree too, or a later
 * `git init` would commit it.
 */
export async function appendToEnvLocal(
  dir: string,
  text: string,
): Promise<boolean> {
  const gitignore = nodePath.join(dir, ".gitignore");
  const { code } = await git(dir, "check-ignore", "-q", "--", ".env.local");
  // 0: ignored, 1: not. Otherwise git can't tell, as outside a work tree:
  // only a rule that ends .gitignore holds whatever comes before it, such as
  // a `!.env.local`.
  const lastLine = (await fs.readFile(gitignore, "utf8").catch(() => ""))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .at(-1);
  const ignored =
    // git drops trailing spaces, but not tabs, and keeps leading spaces
    code === 0 || (code !== 1 && lastLine?.replace(/ +$/, "") === ".env.local");
  if (!ignored) {
    await appendToFile(gitignore, ".env.local\n");
  }
  await appendToFile(nodePath.join(dir, ".env.local"), text, { mode: 0o600 });
  return !ignored;
}

/**
 * Copies the project ID of the key in `dir/.env.local` to gt.config.json, unless that
 * names a project or isn't a JSON object, and resolves whether it did.
 * .env.local isn't shared, so a teammate's sign-in would otherwise create
 * another project.
 */
export async function shareGtProjectId(dir: string): Promise<boolean> {
  const envLocal = await fs
    .readFile(nodePath.join(dir, ".env.local"), "utf8")
    .catch(() => "");
  const projectId = findCredentials(parseEnvFile(envLocal))?.projectId;
  if (!projectId) return false;
  const path = nodePath.join(dir, "gt.config.json");
  const text = await fs.readFile(path, "utf8").catch(() => undefined);
  const config = text === undefined ? {} : parseJson(text);
  if (
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config) ||
    config.projectId
  ) {
    return false;
  }
  await fs.writeFile(
    path,
    `${JSON.stringify({ ...config, projectId }, null, 2)}\n`,
  );
  return true;
}

function git(dir: string, ...args: string[]) {
  return (
    runProcess("git", args, { cwd: dir, onStdoutLine: () => {} })
      // Without git, the folder is no work tree.
      .catch(() => ({ code: null }))
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

/**
 * `npx`'s arguments to run `gt init` in an empty folder: it signs in, creates a
 * project unless `dir`'s gt.config.json, .env files or the environment name
 * one, and saves a development key for it to the folder's .env.local.
 */
export async function gtInitArgs(args: {
  dir: string;
  settings: ProjectSettings;
  env: Record<string, string | undefined>;
}): Promise<string[]> {
  const { dir, settings, env } = args;
  const config = await fs
    .readFile(nodePath.join(dir, "gt.config.json"), "utf8")
    .catch(() => undefined);
  // gt runs in an empty folder, so it doesn't see this folder's project ID.
  // One in .env or .env.local comes first: the key is saved next to it, and
  // readGtCredentials pairs a key with the project ID from the same source.
  const projectId =
    findVariable(await readEnvFiles(dir), PROJECT_ID) ||
    parseJson(config ?? "")?.projectId ||
    findVariable(env, PROJECT_ID);
  return [
    "--yes",
    GT_CLI,
    "init",
    "--json",
    "--no-react-setup",
    "--dev-credentials",
    "--default-locale",
    settings.baseLocale,
    "--locales",
    ...settings.locales.filter((locale) => locale !== settings.baseLocale),
    "--file-patterns",
    GT_FILE_PATTERN,
    ...(projectId
      ? ["--project-id", projectId]
      : [
          "--create-project",
          "--project-name",
          nodePath.basename(nodePath.resolve(dir)),
        ]),
  ];
}

/** gt lists the organizations only as text: `  - Emails (org_abc123)`. */
function parseOrgs(error: string): Array<{ name: string; id: string }> {
  return [...error.matchAll(/^\s*-\s+(.+?)\s+\(([^()\s]+)\)\s*$/gm)].map(
    ([, name, id]) => ({ name: name!, id: id! }),
  );
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const runProcess: RunProcess = (command, args, { cwd, onStdoutLine }) =>
  new Promise((resolve, reject) => {
    // npx is npx.cmd on Windows, which Node starts only through a shell. The
    // shell gets one command line with each argument quoted (a directory name
    // can have spaces); args next to a shell are deprecated (DEP0190).
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? [command, ...args.map((arg) => `"${arg}"`)].join(" ") : command,
      windows ? [] : args,
      {
        cwd,
        // stdin is closed so gt can never wait on a prompt; with --json it
        // reports missing input as a result event instead.
        stdio: ["ignore", "pipe", "pipe"],
        shell: windows,
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    createInterface({ input: child.stdout }).on("line", onStdoutLine);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });

/** Best effort: the printed URL is the fallback, so failures are ignored. */
function openInBrowser(url: string): void {
  // On Windows, `start` takes its first quoted argument as the window title,
  // and the quotes around the URL keep cmd from splitting it at a `&`.
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', `"${url}"`]]
        : ["xdg-open", [url]];
  spawn(command, args, {
    detached: true,
    stdio: "ignore",
    // Ignored outside Windows; there it keeps Node from escaping the quotes.
    windowsVerbatimArguments: true,
  })
    .on("error", () => {})
    .unref();
}
