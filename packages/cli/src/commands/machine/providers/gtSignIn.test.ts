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
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "inlang-gt-test-"));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    fs.writeFileSync(nodePath.join(root, path), content);
  }
  return root;
}

const API_KEY = "gtx-dev-secret-123";
// What gt writes in a folder without a framework.
const ENV_LOCAL = `GT_PROJECT_ID=prj_1\nGT_DEV_API_KEY=${API_KEY}\n`;

const settings = {
  baseLocale: "en",
  locales: ["en", "de"],
} as ProjectSettings;

const authorizationRequired = {
  type: "authorization_required",
  userCode: "ABCD1234",
  verificationUri: "https://dash.generaltranslation.com/signin/device",
  verificationUriComplete:
    "https://dash.generaltranslation.com/signin/device?user_code=ABCD1234",
};
const needsOrg = {
  type: "result",
  command: "init",
  outcome: "failed",
  completedSteps: [],
  error:
    "gt Error: Setup needs these options: --org-id. Accessible organizations for --org-id:\n  - Emails (org_abc123)\n  - Acme (EU) (org_def456)",
  missingOptions: ["--org-id"],
};
const success = {
  type: "result",
  command: "init",
  outcome: "success",
  completedSteps: [
    "created project prj_1",
    "created a development key",
    "saved development credentials to .env.local",
  ],
};

type GtRun = {
  events: object[];
  files?: Record<string, string>;
  stderr?: string;
};

/**
 * A fake `npx gt init` that plays one `GtRun` per call and records argv and
 * the files in the folder it runs in.
 */
function fakeGt(...runs: GtRun[]) {
  const calls: string[][] = [];
  const folders: Array<{ cwd: string; files: string[] }> = [];
  const run: NonNullable<SignInArgs["run"]> = async (
    command,
    args,
    { cwd, onStdoutLine },
  ) => {
    calls.push([command, ...args]);
    folders.push({ cwd, files: fs.readdirSync(cwd) });
    const { events, files = {}, stderr = "" } = runs[calls.length - 1]!;
    for (const [path, content] of Object.entries(files)) {
      fs.writeFileSync(nodePath.join(cwd, path), content);
    }
    for (const event of events) onStdoutLine(JSON.stringify(event));
    return { code: 0, stderr };
  };
  return { calls, folders, run };
}

const signedIn: GtRun = {
  events: [authorizationRequired, success],
  files: { ".env.local": ENV_LOCAL, "gt.config.json": "{}" },
  stderr: "Visit: https://dash.generaltranslation.com/signin/device\n",
};

/** Answers prompts in order and records them. */
function fakePrompt(answer: unknown) {
  const prompts: Array<Parameters<NonNullable<SignInArgs["prompt"]>>> = [];
  const prompt: NonNullable<SignInArgs["prompt"]> = async (...args) => {
    prompts.push(args);
    return answer;
  };
  return { prompts, prompt };
}

/** A git work tree with `files`, shielded from the user's git config. */
function gitTree(files: Record<string, string> = {}): string {
  vi.stubEnv("GIT_CONFIG_GLOBAL", nodePath.join(tree(), "none"));
  vi.stubEnv("XDG_CONFIG_HOME", tree());
  const dir = tree(files);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** A folder with only git, to put on PATH. */
function binWithGit(): string {
  const bin = tree();
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(git, nodePath.join(bin, "git"));
  return bin;
}

/** Everything the CLI prints, joined: every consola log type. */
function captureLog(): () => string {
  const lines: unknown[][] = [];
  for (const type of Object.keys(log.options.types)) {
    vi.spyOn(log, type as "log").mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
  }
  return () => lines.map((args) => args.join(" ")).join("\n");
}

describe("readGtCredentials", () => {
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

  test("never pairs the environment's key with a file's project ID", async () => {
    const dir = tree({ ".env.local": "VITE_GT_PROJECT_ID=prj_1\n" });
    expect(
      await readGtCredentials({ env: { GT_API_KEY: "env-key" }, dir }),
    ).toEqual({ apiKey: "env-key", projectId: undefined });
  });

  test("reads .env, which .env.local overrides, as gt does", async () => {
    const dir = tree({
      ".env": "VITE_GT_PROJECT_ID=prj_env_file\nVITE_GT_DEV_API_KEY=old\n",
      ".env.local": "VITE_GT_DEV_API_KEY=new\n",
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "new",
      projectId: "prj_env_file",
    });
  });

  test("handles quotes, comments, export and CRLF", async () => {
    const dir = tree({
      ".env.local": [
        "# VITE_GT_DEV_API_KEY=commented-out",
        `export VITE_GT_DEV_API_KEY="key # not a comment" # a comment`,
        "VITE_GT_PROJECT_ID='prj_1'",
        "OTHER=value # VITE_GT_PROJECT_ID=prj_2",
      ].join("\r\n"),
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "key # not a comment",
      projectId: "prj_1",
    });
  });

  test("skips an empty key", async () => {
    expect(
      await readGtCredentials({
        env: { GT_API_KEY: "", VITE_GT_DEV_API_KEY: "key" },
        dir: tree(),
      }),
    ).toEqual({ apiKey: "key", projectId: undefined });
  });

  test("returns undefined for a project ID without a key", async () => {
    const dir = tree({ ".env.local": "VITE_GT_PROJECT_ID=prj_1\n" });
    expect(await readGtCredentials({ env: {}, dir })).toBeUndefined();
  });

  test("rethrows a read error other than a missing file", async () => {
    const dir = tree();
    fs.mkdirSync(nodePath.join(dir, ".env.local"));
    await expect(readGtCredentials({ env: {}, dir })).rejects.toThrow("EISDIR");
  });
});

/** `signInToGt` with no environment and no browser. */
function signIn(args: Pick<SignInArgs, "dir" | "run"> & Partial<SignInArgs>) {
  return signInToGt({
    settings,
    env: {},
    openUrl: () => {},
    ...args,
  });
}

describe("signInToGt", () => {
  test("runs gt init with the project's locales in an empty folder", async () => {
    captureLog();
    // gt would add itself to this package.json and install it.
    const dir = tree({ "package.json": "{}" });
    const gt = fakeGt(signedIn);
    await signIn({
      dir,
      settings: {
        baseLocale: "en",
        locales: ["de", "en", "fr"],
      } as ProjectSettings,
      run: gt.run,
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
        "json=./messages/[locale].json",
        "--create-project",
        "--project-name",
        nodePath.basename(dir),
      ],
    ]);
    expect(gt.folders[0]!.files).toEqual([]);
    // It held a copy of the key.
    expect(fs.existsSync(gt.folders[0]!.cwd)).toBe(false);
  });

  test("signs in, prints the sign-in URL and returns the saved key", async () => {
    const output = captureLog();
    const dir = tree();

    const credentials = await signIn({ dir, run: fakeGt(signedIn).run });

    expect(credentials).toEqual({ apiKey: API_KEY, projectId: "prj_1" });
    expect(output()).toContain(
      `Sign in to General Translation in your browser: ${authorizationRequired.verificationUriComplete}`,
    );
    expect(output()).not.toContain(API_KEY);
    // gt's own log stays out of the terminal when it succeeds.
    expect(output()).not.toContain("Visit:");
  });

  test.skipIf(process.platform === "win32")(
    "saves the key to a new .env.local that only the user can read",
    async () => {
      captureLog();
      const dir = tree();
      await signIn({ dir, run: fakeGt(signedIn).run });
      const envLocal = nodePath.join(dir, ".env.local");
      expect(fs.readFileSync(envLocal, "utf8")).toBe(ENV_LOCAL);
      expect(fs.statSync(envLocal).mode & 0o777).toBe(0o600);
    },
  );

  test("adds the key below the lines already in .env.local", async () => {
    captureLog();
    const dir = tree({ ".env.local": "OTHER=1" });
    await signIn({ dir, run: fakeGt(signedIn).run });
    expect(fs.readFileSync(nodePath.join(dir, ".env.local"), "utf8")).toBe(
      `OTHER=1\n${ENV_LOCAL}`,
    );
  });

  test.each([
    ["gt.config.json", { "gt.config.json": '{"projectId":"prj_1"}' }, {}],
    ["the environment", {}, { VITE_GT_PROJECT_ID: "prj_1" }],
    [
      ".env.local, before gt.config.json and the environment",
      {
        ".env.local": "VITE_GT_PROJECT_ID=prj_1\n",
        "gt.config.json": '{"projectId":"prj_other"}',
      },
      { GT_PROJECT_ID: "prj_env" },
    ],
  ])("makes the key for the project ID in %s", async (_, files, env) => {
    captureLog();
    const gt = fakeGt(signedIn);
    await signIn({ dir: tree(files), env, run: gt.run });
    expect(gt.calls[0]!.slice(-2)).toEqual(["--project-id", "prj_1"]);
  });

  test("adds a .gitignore rule for .env.local in a git work tree", async () => {
    captureLog();
    const dir = gitTree({ ".gitignore": "node_modules" });
    await signIn({ dir, run: fakeGt(signedIn).run });
    expect(fs.readFileSync(nodePath.join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules\n.env.local\n",
    );
  });

  test("leaves .gitignore alone when it ignores .env.local already", async () => {
    captureLog();
    const dir = gitTree({ ".gitignore": ".env*\n" });
    await signIn({ dir, run: fakeGt(signedIn).run });
    expect(fs.readFileSync(nodePath.join(dir, ".gitignore"), "utf8")).toBe(
      ".env*\n",
    );
  });

  test("adds a .gitignore rule outside a git work tree too", async () => {
    captureLog();
    const dir = tree();
    await signIn({ dir, run: fakeGt(signedIn).run });
    expect(fs.readFileSync(nodePath.join(dir, ".gitignore"), "utf8")).toBe(
      ".env.local\n",
    );
  });

  test("signs in without git", async () => {
    captureLog();
    vi.stubEnv("PATH", tree());
    const dir = tree();
    expect(await signIn({ dir, run: fakeGt(signedIn).run })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_1",
    });
    expect(fs.readFileSync(nodePath.join(dir, ".gitignore"), "utf8")).toBe(
      ".env.local\n",
    );
  });

  test("says what it created and saved", async () => {
    const output = captureLog();
    const dir = tree();
    await signIn({ dir, run: fakeGt(signedIn).run });
    expect(output()).toContain(
      [
        `Created the General Translation project "${nodePath.basename(dir)}" and saved a development key for it to .env.local.`,
        "Added .env.local to .gitignore.",
      ].join("\n"),
    );
  });

  test("says only that it saved a key when it created no project", async () => {
    const output = captureLog();
    const dir = gitTree({ ".gitignore": ".env.local\n" });
    await signIn({
      dir,
      env: { GT_PROJECT_ID: "prj_1" },
      run: fakeGt({
        ...signedIn,
        events: [
          { ...success, completedSteps: success.completedSteps.slice(1) },
        ],
      }).run,
    });
    expect(output()).toContain(
      "Saved a General Translation development key to .env.local.",
    );
    expect(output()).not.toContain("Created");
    expect(output()).not.toContain(".gitignore");
  });

  test("refuses a .env.local that git tracks before signing in", async () => {
    captureLog();
    const dir = gitTree({ ".env.local": "OTHER=1\n" });
    execFileSync("git", ["add", ".env.local"], { cwd: dir });
    const gt = fakeGt(signedIn);
    await expect(signIn({ dir, run: gt.run })).rejects.toThrow(
      "Can't save the General Translation key: .env.local is tracked by git. Untrack it with `git rm --cached .env.local`, then run again.",
    );
    expect(gt.calls).toEqual([]);
  });

  test("asks for the organization when gt needs one and reruns with it", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeGt(
      {
        events: [authorizationRequired, needsOrg],
        files: { "gt.config.json": "{}" },
      },
      { events: [success], files: { ".env.local": ENV_LOCAL } },
    );
    const { prompts, prompt } = fakePrompt("org_def456");

    const credentials = await signIn({ dir, run: gt.run, prompt });

    expect(credentials).toEqual({ apiKey: API_KEY, projectId: "prj_1" });
    expect(prompts[0]![1]).toMatchObject({
      type: "select",
      options: [
        { label: "Emails", value: "org_abc123" },
        { label: "Acme (EU)", value: "org_def456" },
      ],
    });
    expect(gt.calls[1]).toEqual([...gt.calls[0]!, "--org-id", "org_def456"]);
  });

  test("returns undefined when the user cancels the organization prompt", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeGt({
      events: [needsOrg],
      files: { "gt.config.json": "{}" },
    });
    expect(
      await signIn({
        dir,
        run: gt.run,
        prompt: fakePrompt(undefined).prompt,
      }),
    ).toBeUndefined();
    expect(gt.calls).toHaveLength(1);
  });

  test("throws gt's error, shows the tail of its log and removes gt's folder", async () => {
    const output = captureLog();
    const dir = tree();
    const gtLog = Array.from({ length: 25 }, (_, i) => `gt log line ${i + 1}`);
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
      files: { "gt.config.json": "{}" },
      stderr: gtLog.join("\n") + "\n",
    });
    const error: Error = await signIn({ dir, run: gt.run }).catch(
      (error) => error,
    );
    expect(error.message).toContain("gt Error: Project quota reached.");
    expect(error.message).toContain("gt log line 6\n");
    expect(error.message).toContain("gt log line 25");
    expect(error.message).not.toContain("gt log line 5\n");
    expect(output()).not.toContain("gt log line");
    expect(fs.existsSync(gt.folders[0]!.cwd)).toBe(false);
  });

  test("throws when gt exits without a result", async () => {
    captureLog();
    const gt = fakeGt({ events: [], stderr: "npm error 404 Not Found\n" });
    await expect(signIn({ dir: tree(), run: gt.run })).rejects.toThrow(
      "npm error 404 Not Found",
    );
  });

  test("throws when gt succeeds without saving a key", async () => {
    captureLog();
    const gt = fakeGt({ events: [success] });
    await expect(signIn({ dir: tree(), run: gt.run })).rejects.toThrow(
      "gt init finished without saving a General Translation key to .env.local.",
    );
  });

  test("asks with the CLI's prompt by default", async () => {
    captureLog();
    // Under consola's prompt, which reads `this.options`.
    const prompt = vi
      .spyOn(
        log.options as { prompt: (message: string) => Promise<unknown> },
        "prompt",
      )
      .mockResolvedValue(undefined);
    const gt = fakeGt({
      events: [needsOrg],
      files: { "gt.config.json": "{}" },
    });
    expect(await signIn({ dir: tree(), run: gt.run })).toBeUndefined();
    expect(prompt).toHaveBeenCalledWith(
      "Which General Translation organization should the project belong to?",
      expect.objectContaining({ type: "select" }),
    );
  });
});

// The default runner and opener, against fakes on PATH. Windows needs .cmd
// files.
describe.skipIf(process.platform === "win32")("signInToGt's defaults", () => {
  test("prints the sign-in URL while gt is still running", async () => {
    const dir = tree();
    const urlSeen = nodePath.join(tree(), "url-seen");
    const bin = tree({
      // Waits until the URL was printed, as gt waits for the browser sign-in.
      npx: `#!${process.execPath}
const fs = require("node:fs");
// stdin is closed, so gt can't wait on a prompt.
const stdin = fs.readFileSync(0, "utf8");
console.log("npm warn exec The following package was not found and will be installed: gt@2.28.3");
console.log(JSON.stringify(${JSON.stringify(authorizationRequired)}));
const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  const seen = fs.existsSync(${JSON.stringify(urlSeen)}) && stdin === "";
  if (!seen && Date.now() < deadline) return;
  clearInterval(timer);
  if (seen) fs.writeFileSync(".env.local", "GT_DEV_API_KEY=key\\n");
  console.log(JSON.stringify(seen
    ? { type: "result", outcome: "success" }
    : { type: "result", outcome: "failed", error: "The URL wasn't printed while gt ran, or stdin was open." }));
}, 10);
`,
    });
    fs.chmodSync(nodePath.join(bin, "npx"), 0o755);
    vi.stubEnv("PATH", `${bin}${nodePath.delimiter}${process.env.PATH}`);
    vi.spyOn(log, "log").mockImplementation((message: unknown) => {
      if (String(message).includes("in your browser")) {
        fs.writeFileSync(urlSeen, "");
      }
    });
    expect(
      await signInToGt({
        dir,
        settings,
        env: {},
        openUrl: () => {},
      }),
    ).toEqual({ apiKey: "key", projectId: undefined });
  });

  test("rejects when npx can't be started", async () => {
    captureLog();
    vi.stubEnv("PATH", binWithGit());
    await expect(
      signInToGt({
        dir: tree(),
        settings,
        env: {},
      }),
    ).rejects.toThrow("spawn npx ENOENT");
  });

  test("opens the sign-in URL with the platform's opener", async () => {
    captureLog();
    const opened = nodePath.join(tree(), "argv.json");
    const opener = `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(opened)}, JSON.stringify(process.argv.slice(2)));
`;
    const bin = tree({ open: opener, "xdg-open": opener });
    for (const name of ["open", "xdg-open"]) {
      fs.chmodSync(nodePath.join(bin, name), 0o755);
    }
    vi.stubEnv("PATH", `${bin}${nodePath.delimiter}${process.env.PATH}`);
    await signInToGt({
      dir: tree(),
      settings,
      env: {},
      run: fakeGt(signedIn).run,
    });
    await vi.waitFor(() =>
      expect(JSON.parse(fs.readFileSync(opened, "utf8"))).toEqual([
        authorizationRequired.verificationUriComplete,
      ]),
    );
  });

  test("still signs in when no opener can be started", async () => {
    captureLog();
    vi.stubEnv("PATH", binWithGit());
    expect(
      await signInToGt({
        dir: tree(),
        settings,
        env: {},
        run: fakeGt(signedIn).run,
      }),
    ).toEqual({ apiKey: API_KEY, projectId: "prj_1" });
  });
});
