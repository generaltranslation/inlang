import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ProjectSettings } from "@inlang/sdk";
import { log } from "../../../utilities/log.js";

// Pinned because this module parses `gt init --json`'s flags and events, which
// a new gt release may change. Bump only after rechecking both.
const GT_CLI = "gt@2.28.3";

// resolveProvider.ts's BYOK_URL; it isn't exported.
const BYOK_URL = "https://inlang.com/m/2qj2w8pu/app-inlang-cli/byok";

export type GtCredentials = { apiKey: string; projectId?: string };

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
 * General Translation credentials from `env`, else from `dir/.env.local`.
 * Key and project ID come from the same source, so a key is never paired with
 * another project's ID.
 *
 * `gt init` names the variables after the framework: `GT_API_KEY` for
 * Next.js, `<prefix>GT_DEV_API_KEY` (e.g. `VITE_`) otherwise.
 */
export async function readGtCredentials(args: {
  env: Record<string, string | undefined>;
  dir: string;
}): Promise<GtCredentials | undefined> {
  const fromEnv = findCredentials(args.env);
  if (fromEnv) return fromEnv;
  const content = await fs
    .readFile(nodePath.join(args.dir, ".env.local"), "utf8")
    .catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  return content === undefined
    ? undefined
    : findCredentials(parseEnvFile(content));
}

function findCredentials(
  variables: Record<string, string | undefined>,
): GtCredentials | undefined {
  const value = (matches: (name: string) => boolean) =>
    Object.entries(variables).find(
      ([name, value]) => matches(name) && value,
    )?.[1];
  const apiKey = value(
    (name) => name === "GT_API_KEY" || /(^|_)GT_DEV_API_KEY$/.test(name),
  );
  if (!apiKey) return undefined;
  return {
    apiKey,
    projectId: value((name) => /(^|_)GT_PROJECT_ID$/.test(name)),
  };
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
 * creates a project and saves a development key to `dir/.env.local`. Asks
 * first, so call it only in an interactive terminal. Resolves `undefined`
 * if the user declines.
 */
export async function signInToGt(args: {
  dir: string;
  settings: ProjectSettings;
  run?: RunProcess;
  prompt?: Prompt;
}): Promise<GtCredentials | undefined> {
  const { dir, settings, run = runProcess, prompt = log.prompt } = args;
  log.log(
    [
      "Machine translation is powered by General Translation.",
      `Sign up and add a card to get $10 of free translation credit. Or bring your own key: ${BYOK_URL}`,
    ].join("\n"),
  );
  const confirmed = await prompt("Sign in to General Translation?", {
    type: "confirm",
    initial: true,
    cancel: "undefined",
  });
  if (!confirmed) return undefined;

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
    // gt requires a file pattern even though its file workflow isn't used.
    "--file-patterns",
    `json=${messageFilePattern(settings)}`,
    "--create-project",
    "--project-name",
    await projectName(dir),
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
        } else if (event?.type === "result") {
          result = event;
        }
      },
    });
    return { result, stderr };
  };

  const configPath = nodePath.join(dir, "gt.config.json");
  const hadConfig = await fs.access(configPath).then(
    () => true,
    () => false,
  );
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
      const tail = stderr.trimEnd().split("\n").slice(-20).join("\n");
      throw new Error(
        [
          `General Translation sign-in failed: ${result?.error ?? "gt init exited without a result."}`,
          ...(tail ? ["", "gt's log:", tail] : []),
        ].join("\n"),
      );
    }
  } finally {
    // GT's file workflow isn't used; a leftover config would invite a second
    // translation path (`gt translate`).
    if (!hadConfig) await fs.rm(configPath, { force: true });
  }

  // Only the file: a stale key in the environment must not shadow the new one.
  const credentials = await readGtCredentials({ env: {}, dir });
  if (!credentials) {
    throw new Error(
      "General Translation sign-in succeeded, but .env.local has no General Translation key.",
    );
  }
  const gitignored = await promisify(execFile)(
    "git",
    ["check-ignore", "-q", ".env.local"],
    { cwd: dir },
  ).then(
    () => 0,
    (error: { code?: unknown }) => error.code,
  );
  // 1 is "not ignored"; anything else (no repository, no git) isn't ours to judge.
  if (gitignored === 1) {
    log.warn(
      ".env.local isn't in .gitignore. It holds your General Translation key; add it before you commit.",
    );
  }
  return credentials;
}

/**
 * The first plugin's message file pattern in gt's `[locale]` syntax, else
 * Paraglide's default.
 */
function messageFilePattern(settings: ProjectSettings): string {
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith("plugin.")) continue;
    const pathPattern = value?.pathPattern;
    const pattern = Array.isArray(pathPattern) ? pathPattern[0] : pathPattern;
    if (typeof pattern === "string") {
      return pattern.replace(/\{(locale|languageTag)\}/g, "[locale]");
    }
  }
  return "./messages/[locale].json";
}

async function projectName(dir: string): Promise<string> {
  const packageJson = await fs
    .readFile(nodePath.join(dir, "package.json"), "utf8")
    .then(parseJson, () => undefined);
  return typeof packageJson?.name === "string" && packageJson.name
    ? packageJson.name
    : nodePath.basename(nodePath.resolve(dir));
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
    // stdin is closed so gt can never wait on a prompt; with --json it
    // reports missing input as a result event instead.
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    createInterface({ input: child.stdout }).on("line", onStdoutLine);
    child.once("error", reject);
    child.once("close", () => resolve({ stderr }));
  });
