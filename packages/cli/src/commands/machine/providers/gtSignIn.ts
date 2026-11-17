import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { createInterface } from "node:readline";
import type { ProjectSettings } from "@inlang/sdk";
import { log } from "../../../utilities/log.js";

// Pinned because this module parses `gt init --json`'s flags and events, which
// a new gt release may change. Bump only after rechecking both.
const GT_CLI = "gt@2.28.3";
const GT_LOG_TAIL_LINES = 20;
// gt requires a file pattern even though its file workflow isn't used.
const GT_FILE_PATTERN = "json=./messages/[locale].json";

type GtCredentials = { apiKey: string; projectId?: string };

/**
 * Runs `command` and resolves with its stderr when it exits. Each stdout line
 * is passed to `onStdoutLine` as it arrives.
 */
type RunProcess = (
  command: string,
  args: string[],
  options: { cwd: string; onStdoutLine: (line: string) => void },
) => Promise<{ stderr: string }>;

type Prompt = (
  message: string,
  options: NonNullable<Parameters<typeof log.prompt>[1]>,
) => Promise<unknown>;

type InitResult = {
  type: "result";
  outcome: "success" | "failed";
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
 * Next.js, `<prefix>GT_DEV_API_KEY` (e.g. `VITE_`) otherwise.
 */
export async function readGtCredentials(args: {
  env: Record<string, string | undefined>;
  dir: string;
}): Promise<GtCredentials | undefined> {
  return (
    findCredentials(args.env) ?? findCredentials(await readEnvFiles(args.dir))
  );
}

const API_KEY = /^GT_API_KEY$|(^|_)GT_DEV_API_KEY$/;
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
  const apiKey = findVariable(variables, API_KEY);
  if (!apiKey) return undefined;
  return { apiKey, projectId: findVariable(variables, PROJECT_ID) };
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

/**
 * Signs the user in to General Translation with `gt init --json`, which
 * creates a project (unless gt.config.json or the environment names one) and
 * saves a development key for it to `dir/.env.local`. Asks first, so call it
 * only in an interactive terminal. Resolves `undefined` if the user declines.
 *
 * gt itself appends a `.gitignore` rule for an unignored `.env.local` and
 * refuses a tracked one (gt's `packages/cli/src/utils/credentials.ts`).
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
  const confirmed = await prompt("Sign in to General Translation?", {
    type: "confirm",
    initial: true,
    cancel: "undefined",
  });
  if (!confirmed) return undefined;

  const configPath = nodePath.join(dir, "gt.config.json");
  const config = await fs.readFile(configPath, "utf8").catch(() => undefined);
  // gt refuses --create-project when it already has a project ID, from
  // gt.config.json or the environment, and then makes a key for that project.
  const hasProject =
    parseJson(config ?? "")?.projectId ||
    findVariable({ ...(await readEnvFiles(dir)), ...env }, PROJECT_ID) !==
      undefined;
  const initArgs = [
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
    ...(hasProject
      ? []
      : [
          "--create-project",
          "--project-name",
          nodePath.basename(nodePath.resolve(dir)),
        ]),
  ];
  const init = async (extraArgs: string[]) => {
    let result: InitResult | undefined;
    const { stderr } = await run("npx", [...initArgs, ...extraArgs], {
      cwd: dir,
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
  } finally {
    // gt init writes its file workflow into gt.config.json, which isn't used.
    await (config === undefined
      ? fs.rm(configPath, { force: true })
      : fs.writeFile(configPath, config));
  }

  const credentials = await readGtCredentials({ env: {}, dir });
  if (!credentials) {
    throw new Error(
      "gt init finished without saving a General Translation key to .env.local.",
    );
  }
  return credentials;
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
    child.once("close", () => resolve({ stderr }));
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
