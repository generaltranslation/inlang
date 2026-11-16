import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { ProjectSettings } from "@inlang/sdk";
import { log } from "../../../utilities/log.js";
import { readGtCredentials, signInToGt } from "./gtSignIn.js";

type SignInArgs = Parameters<typeof signInToGt>[0];

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function tree(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "inlang-gt-"));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    fs.writeFileSync(nodePath.join(root, path), content);
  }
  return root;
}

const API_KEY = "gtx-dev-secret-123";
const ENV_LOCAL = `VITE_GT_PROJECT_ID=prj_1\nVITE_GT_DEV_API_KEY=${API_KEY}\n`;

const settings = {
  baseLocale: "en",
  locales: ["en", "de"],
  "plugin.inlang.messageFormat": { pathPattern: "./messages/{locale}.json" },
} as ProjectSettings;

const authorizationRequired = {
  type: "authorization_required",
  userCode: "ABCD1234",
  verificationUri: "https://dash.generaltranslation.com/signin/device",
  verificationUriComplete:
    "https://dash.generaltranslation.com/signin/device?user_code=ABCD1234",
};
const success = {
  type: "result",
  command: "init",
  outcome: "success",
  completedSteps: ["created gt.config.json"],
};

type GtRun = {
  events: object[];
  files?: Record<string, string>;
  stderr?: string;
};

/** A fake `npx gt init` that plays one `GtRun` per call and records argv. */
function fakeGt(...runs: GtRun[]) {
  const calls: string[][] = [];
  const run: NonNullable<SignInArgs["run"]> = async (
    command,
    args,
    { cwd, onStdoutLine },
  ) => {
    calls.push([command, ...args]);
    const { events, files = {}, stderr = "" } = runs[calls.length - 1]!;
    for (const [path, content] of Object.entries(files)) {
      fs.writeFileSync(nodePath.join(cwd, path), content);
    }
    for (const event of events) onStdoutLine(JSON.stringify(event));
    return { stderr };
  };
  return { calls, run };
}

const signedIn: GtRun = {
  events: [authorizationRequired, success],
  files: { ".env.local": ENV_LOCAL, "gt.config.json": "{}" },
  stderr: "Visit: https://dash.generaltranslation.com/signin/device\n",
};

/** Answers prompts in order and records them. */
function fakePrompt(...answers: unknown[]) {
  const prompts: Array<Parameters<NonNullable<SignInArgs["prompt"]>>> = [];
  const prompt: NonNullable<SignInArgs["prompt"]> = async (...args) => {
    prompts.push(args);
    return answers[prompts.length - 1];
  };
  return { prompts, prompt };
}

/** Everything the CLI prints, joined. */
function captureLog(): () => string {
  const lines: unknown[][] = [];
  for (const type of ["log", "info", "warn", "error", "success"] as const) {
    vi.spyOn(log, type).mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
  }
  return () => lines.map((args) => args.join(" ")).join("\n");
}

describe("readGtCredentials", () => {
  test("reads a framework-prefixed development key", async () => {
    const dir = tree({ ".env.local": ENV_LOCAL });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_1",
    });
  });

  test("reads an unprefixed development key", async () => {
    const dir = tree({
      ".env.local": "GT_PROJECT_ID=prj_1\nGT_DEV_API_KEY=key\n",
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "key",
      projectId: "prj_1",
    });
  });

  test("reads Next.js's GT_API_KEY", async () => {
    const dir = tree({ ".env.local": "GT_PROJECT_ID=prj_1\nGT_API_KEY=key\n" });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "key",
      projectId: "prj_1",
    });
  });

  test("prefers the environment over .env.local", async () => {
    const dir = tree({ ".env.local": ENV_LOCAL });
    expect(
      await readGtCredentials({
        env: { GT_API_KEY: "env-key", GT_PROJECT_ID: "prj_env" },
        dir,
      }),
    ).toEqual({ apiKey: "env-key", projectId: "prj_env" });
  });

  test("handles quotes, comments and export", async () => {
    const dir = tree({
      ".env.local": [
        "# VITE_GT_DEV_API_KEY=commented-out",
        `export VITE_GT_DEV_API_KEY="key # not a comment" # a comment`,
        "VITE_GT_PROJECT_ID='prj_1'",
        "OTHER=value # VITE_GT_PROJECT_ID=prj_2",
      ].join("\n"),
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "key # not a comment",
      projectId: "prj_1",
    });
  });

  test("returns undefined without a key or .env.local", async () => {
    expect(await readGtCredentials({ env: {}, dir: tree() })).toBeUndefined();
    const dir = tree({ ".env.local": "VITE_GT_PROJECT_ID=prj_1\n" });
    expect(await readGtCredentials({ env: {}, dir })).toBeUndefined();
  });
});

describe("signInToGt", () => {
  test("runs gt init with the project's locales, pattern and name", async () => {
    captureLog();
    const dir = tree({ "package.json": JSON.stringify({ name: "my-app" }) });
    const gt = fakeGt(signedIn);
    await signInToGt({
      dir,
      settings: {
        baseLocale: "en",
        locales: ["de", "en", "fr"],
        "plugin.other": { enabled: true },
        "plugin.inlang.i18next": {
          pathPattern: [
            "./locales/{languageTag}/common.json",
            "./locales/{languageTag}/other.json",
          ],
        },
      } as ProjectSettings,
      run: gt.run,
      prompt: fakePrompt(true).prompt,
    });
    expect(gt.calls).toEqual([
      [
        "npx",
        "--yes",
        "gt@2.28.3",
        "init",
        "--json",
        "--no-react-setup",
        "--dev-credentials",
        "--default-locale",
        "en",
        "--locales",
        "de",
        "fr",
        "--file-patterns",
        "json=./locales/[locale]/common.json",
        "--create-project",
        "--project-name",
        "my-app",
      ],
    ]);
  });

  test("falls back to Paraglide's pattern and the directory's name", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeGt(signedIn);
    await signInToGt({
      dir,
      settings: { baseLocale: "en", locales: ["en", "de"] } as ProjectSettings,
      run: gt.run,
      prompt: fakePrompt(true).prompt,
    });
    const argv = gt.calls[0]!;
    expect(argv[argv.indexOf("--file-patterns") + 1]).toBe(
      "json=./messages/[locale].json",
    );
    expect(argv[argv.indexOf("--project-name") + 1]).toBe(
      nodePath.basename(dir),
    );
  });

  test("signs in, prints the sign-in URL and returns the saved key", async () => {
    const output = captureLog();
    vi.stubEnv("GT_API_KEY", "stale-key");
    const dir = tree();
    const gt = fakeGt(signedIn);
    const { prompts, prompt } = fakePrompt(true);

    const credentials = await signInToGt({
      dir,
      settings,
      run: gt.run,
      prompt,
    });

    expect(credentials).toEqual({ apiKey: API_KEY, projectId: "prj_1" });
    expect(prompts).toHaveLength(1);
    expect(output()).toContain(
      [
        "Machine translation is powered by General Translation.",
        "Sign up and add a card to get $10 of free translation credit. Or bring your own key: https://inlang.com/m/2qj2w8pu/app-inlang-cli/byok",
      ].join("\n"),
    );
    expect(output()).toContain(
      `Sign in to General Translation in your browser: ${authorizationRequired.verificationUriComplete}`,
    );
    expect(output()).not.toContain(API_KEY);
    // gt's own log stays out of the terminal when it succeeds.
    expect(output()).not.toContain("Visit:");
    expect(fs.existsSync(nodePath.join(dir, "gt.config.json"))).toBe(false);
  });

  test("keeps a gt.config.json that existed before", async () => {
    captureLog();
    const dir = tree({ "gt.config.json": '{"own":true}' });
    await signInToGt({
      dir,
      settings,
      run: fakeGt(signedIn).run,
      prompt: fakePrompt(true).prompt,
    });
    expect(fs.readFileSync(nodePath.join(dir, "gt.config.json"), "utf8")).toBe(
      "{}",
    );
  });

  test("asks for the organization when gt needs one and reruns with it", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeGt(
      {
        events: [
          authorizationRequired,
          {
            type: "result",
            command: "init",
            outcome: "failed",
            completedSteps: [],
            error:
              "gt Error: Setup needs these options: --org-id. Accessible organizations for --org-id:\n  - Emails (org_abc123)\n  - Acme (EU) (org_def456)",
            missingOptions: ["--org-id"],
          },
        ],
        files: { "gt.config.json": "{}" },
      },
      { events: [success], files: { ".env.local": ENV_LOCAL } },
    );
    const { prompts, prompt } = fakePrompt(true, "org_def456");

    const credentials = await signInToGt({
      dir,
      settings,
      run: gt.run,
      prompt,
    });

    expect(credentials).toEqual({ apiKey: API_KEY, projectId: "prj_1" });
    expect(prompts[1]![1]).toMatchObject({
      type: "select",
      options: [
        { label: "Emails", value: "org_abc123" },
        { label: "Acme (EU)", value: "org_def456" },
      ],
    });
    expect(gt.calls).toHaveLength(2);
    expect(gt.calls[1]).toEqual([...gt.calls[0]!, "--org-id", "org_def456"]);
    expect(fs.existsSync(nodePath.join(dir, "gt.config.json"))).toBe(false);
  });

  test("throws gt's error and shows the tail of its log", async () => {
    const output = captureLog();
    const dir = tree();
    const gt = fakeGt({
      events: [
        {
          type: "result",
          command: "init",
          outcome: "failed",
          completedSteps: [],
          error: "gt Error: Project quota reached.",
        },
      ],
      stderr: "Creating project...\nRequest failed with 403\n",
    });
    const promise = signInToGt({
      dir,
      settings,
      run: gt.run,
      prompt: fakePrompt(true).prompt,
    });
    await expect(promise).rejects.toThrow("gt Error: Project quota reached.");
    await expect(promise).rejects.toThrow("Request failed with 403");
    expect(output()).not.toContain("Creating project");
  });

  test("throws when gt exits without a result", async () => {
    captureLog();
    const gt = fakeGt({ events: [], stderr: "npm error 404 Not Found\n" });
    await expect(
      signInToGt({
        dir: tree(),
        settings,
        run: gt.run,
        prompt: fakePrompt(true).prompt,
      }),
    ).rejects.toThrow("npm error 404 Not Found");
  });

  test("throws when gt succeeds without saving a key", async () => {
    captureLog();
    const gt = fakeGt({ events: [success] });
    await expect(
      signInToGt({
        dir: tree(),
        settings,
        run: gt.run,
        prompt: fakePrompt(true).prompt,
      }),
    ).rejects.toThrow(".env.local has no General Translation key");
  });

  test("warns when .env.local isn't gitignored", async () => {
    const output = captureLog();
    const dir = tree();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await signInToGt({
      dir,
      settings,
      run: fakeGt(signedIn).run,
      prompt: fakePrompt(true).prompt,
    });
    expect(output()).toContain(
      ".env.local isn't in .gitignore. It holds your General Translation key; add it before you commit.",
    );
  });

  test("doesn't warn when .env.local is gitignored or there's no repository", async () => {
    const output = captureLog();
    const ignored = tree({ ".gitignore": "*.local\n" });
    execFileSync("git", ["init", "-q"], { cwd: ignored });
    for (const dir of [ignored, tree()]) {
      await signInToGt({
        dir,
        settings,
        run: fakeGt(signedIn).run,
        prompt: fakePrompt(true).prompt,
      });
    }
    expect(output()).not.toContain(".gitignore");
  });

  test("doesn't run gt when the user declines", async () => {
    captureLog();
    const gt = fakeGt();
    expect(
      await signInToGt({
        dir: tree(),
        settings,
        run: gt.run,
        prompt: fakePrompt(false).prompt,
      }),
    ).toBeUndefined();
    expect(gt.calls).toEqual([]);
  });
});
