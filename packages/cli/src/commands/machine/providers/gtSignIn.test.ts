import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { UserAuthError } from "@generaltranslation/auth";
import type { ProjectSettings } from "@inlang/sdk";
import { log } from "../../../utilities/log.js";
import {
  readGtCredentials,
  shareGtProjectId,
  signInToGt,
  type GtAccount,
} from "./gtSignIn.js";

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
// What sign-in saves, and what gt writes in a folder without a framework.
const ENV_LOCAL = `GT_PROJECT_ID=prj_1\nGT_DEV_API_KEY=${API_KEY}\n`;

const settings = {
  baseLocale: "en",
  locales: ["en", "de"],
} as ProjectSettings;

type Request = { method: string; path: string; body: any; auth: string | null };

/**
 * A fake General Translation API: organizations in pages of `pageSize`, and
 * projects and keys made on request. `fail` answers one path with an error.
 */
function fakeApi(
  options: {
    orgs?: Array<{ id: string; name: string }>;
    pageSize?: number;
    fail?: { path: string; status: number; body: object };
  } = {},
) {
  const { orgs = [{ id: "org_1", name: "Emails" }], pageSize = 50 } = options;
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    requests.push({
      method: request.method,
      path: url.pathname,
      body: text ? JSON.parse(text) : undefined,
      auth: request.headers.get("authorization"),
    });
    const json = (status: number, body: object) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (options.fail?.path === url.pathname)
      return json(options.fail.status, options.fail.body);
    if (url.pathname === "/v2/orgs") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + pageSize;
      return json(200, {
        items: orgs.slice(start, end),
        nextCursor: end < orgs.length ? String(end) : null,
      });
    }
    const project = /^\/v2\/orgs\/([^/]+)\/projects$/.exec(url.pathname);
    if (project) {
      return json(201, {
        id: "prj_new",
        name: JSON.parse(text).name,
        orgId: project[1],
        defaultLocale: "en",
        currentLocales: [],
        autoApprove: false,
        cdnEnabled: false,
      });
    }
    if (/^\/v2\/projects\/[^/]+\/api-keys$/.test(url.pathname)) {
      return json(201, {
        id: "key_1",
        name: JSON.parse(text).name,
        key: API_KEY,
      });
    }
    return json(404, { error: "Not found", code: "not_found" });
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

/** An API error for `path`, as for an organization at its project limit. */
const projectLimit = (path: string) => ({
  path,
  status: 403,
  body: {
    error: "The organization reached its project limit",
    code: "project_limit_reached",
  },
});

/**
 * A `GtAccount` on the fake API; `signedIn` is whether gt has a stored
 * sign-in, and `getAccessToken` replaces the sign-in's tokens.
 */
function fakeAccount(
  api = fakeApi(),
  options: {
    signedIn?: boolean;
    login?: GtAccount["login"];
    getAccessToken?: () => Promise<string>;
  } = {},
) {
  const login = vi.fn<GtAccount["login"]>(options.login ?? (async () => {}));
  const account: GtAccount = {
    hasLogin: async () => options.signedIn ?? false,
    login,
    userTokenProvider: {
      getAccessToken: options.getAccessToken ?? (async () => "user-token"),
      refreshAccessToken: async () => undefined,
    },
    fetch: api.fetch,
  };
  return { account, login, requests: api.requests };
}

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
  test("pairs the key with the project ID of its prefix", async () => {
    const dir = tree({
      ".env.local":
        "VITE_GT_PROJECT_ID=prj_vite\nGT_API_KEY=server-key\nGT_PROJECT_ID=prj_server\n",
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "server-key",
      projectId: "prj_server",
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

  test("reads values in backticks, as gt does", async () => {
    const dir = tree({
      ".env.local": "GT_PROJECT_ID=`prj_1`\nGT_DEV_API_KEY=`key`\n",
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "key",
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

  test("rethrows a read error other than a missing file", async () => {
    const dir = tree();
    fs.mkdirSync(nodePath.join(dir, ".env.local"));
    await expect(readGtCredentials({ env: {}, dir })).rejects.toThrow("EISDIR");
  });
});

/** `signInToGt` with no environment, on a fake account. */
function signIn(
  args: Pick<SignInArgs, "dir" | "account"> & Partial<SignInArgs>,
) {
  return signInToGt({ settings, env: {}, ...args });
}

const read = (dir: string, file: string) =>
  fs.readFileSync(nodePath.join(dir, file), "utf8");

describe("shareGtProjectId", () => {
  test("adds the project ID to a gt.config.json without one", async () => {
    const dir = tree({
      ".env.local": ENV_LOCAL,
      "gt.config.json": '{"defaultLocale":"en"}',
    });
    expect(await shareGtProjectId(dir)).toBe(true);
    expect(JSON.parse(read(dir, "gt.config.json"))).toEqual({
      defaultLocale: "en",
      projectId: "prj_1",
    });
  });

  test("leaves a gt.config.json that isn't JSON alone", async () => {
    const dir = tree({ ".env.local": ENV_LOCAL, "gt.config.json": "{" });
    expect(await shareGtProjectId(dir)).toBe(false);
    expect(read(dir, "gt.config.json")).toBe("{");
  });

  test("shares no project ID from .env, which may be shared already", async () => {
    const dir = tree({ ".env": ENV_LOCAL });
    expect(await shareGtProjectId(dir)).toBe(false);
    expect(fs.existsSync(nodePath.join(dir, "gt.config.json"))).toBe(false);
  });
});

describe("signInToGt", () => {
  test("signs in, creates a project in the only organization and saves a key that may only translate", async () => {
    const output = captureLog();
    const dir = tree();
    const gt = fakeAccount();
    expect(await signIn({ dir, account: gt.account })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_new",
    });
    expect(gt.login).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api.gtx.dev" }),
    );
    expect(gt.requests).toEqual([
      {
        method: "GET",
        path: "/v2/orgs",
        body: undefined,
        auth: "Bearer user-token",
      },
      {
        method: "POST",
        path: "/v2/orgs/org_1/projects",
        body: { name: nodePath.basename(dir), defaultLocale: "en" },
        auth: "Bearer user-token",
      },
      {
        method: "POST",
        path: "/v2/projects/prj_new/api-keys",
        body: {
          name: "Development key (inlang machine translate)",
          permissions: ["project:translations:generate"],
        },
        auth: "Bearer user-token",
      },
    ]);
    expect(read(dir, ".env.local")).toBe(
      `GT_PROJECT_ID=prj_new\nGT_DEV_API_KEY=${API_KEY}\n`,
    );
    expect(output()).not.toContain(API_KEY);
  });

  test("doesn't sign in again while gt's sign-in is valid", async () => {
    captureLog();
    const gt = fakeAccount(fakeApi(), { signedIn: true });
    await signIn({ dir: tree(), account: gt.account });
    expect(gt.login).not.toHaveBeenCalled();
  });

  test("says what it waits for before each request", async () => {
    const output = captureLog();
    const api = fakeApi();
    const logBeforeRequest: string[] = [];
    const gt = fakeAccount({
      ...api,
      fetch: async (input, init) => {
        logBeforeRequest.push(output());
        return api.fetch(input, init);
      },
    });
    await signIn({ dir: tree(), account: gt.account });
    const last = (log: string | undefined) => log?.split("\n").at(-1);
    expect(logBeforeRequest.map(last)).toEqual([
      "Loading your General Translation organizations...",
      "Creating the General Translation project...",
      "Creating a General Translation API key...",
    ]);
  });

  test("signs in again when gt's sign-in can no longer be refreshed", async () => {
    captureLog();
    let expired = true;
    const gt = fakeAccount(fakeApi(), {
      signedIn: true,
      login: async () => {
        expired = false;
      },
      getAccessToken: async () => {
        if (expired) {
          throw new UserAuthError("oauth", "Could not refresh your login");
        }
        return "user-token";
      },
    });
    expect(await signIn({ dir: tree(), account: gt.account })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_new",
    });
    expect(gt.login).toHaveBeenCalledOnce();
  });

  test("passes on an error reading gt's sign-in other than a sign-in error", async () => {
    captureLog();
    const gt = fakeAccount(fakeApi(), {
      signedIn: true,
      getAccessToken: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    await expect(signIn({ dir: tree(), account: gt.account })).rejects.toThrow(
      "EACCES",
    );
    expect(gt.login).not.toHaveBeenCalled();
  });

  test("prints the sign-in URL in case the browser doesn't open", async () => {
    const output = captureLog();
    const gt = fakeAccount(fakeApi(), {
      login: async (options) =>
        options?.onAuthorizationUrl?.("https://auth.example/authorize"),
    });
    await signIn({ dir: tree(), account: gt.account });
    expect(output()).toContain("https://auth.example/authorize");
  });

  test("says how to sign in when the browser can't reach this machine", async () => {
    const output = captureLog();
    const gt = fakeAccount(fakeApi(), {
      login: async (options) =>
        options?.onAuthorizationUrl?.("https://auth.example/authorize"),
    });
    await signIn({ dir: tree(), account: gt.account });
    expect(output()).toContain(
      "press Ctrl+C, run `npx gt login --no-browser`, then run this again.",
    );
  });

  test.each([
    [
      "the URL with the code",
      {
        userCode: "ABCD",
        verificationUri: "https://auth.example/device",
        verificationUriComplete: "https://auth.example/device?code=ABCD",
      },
      ["https://auth.example/device?code=ABCD"],
    ],
    [
      "the URL and the code",
      { userCode: "ABCD", verificationUri: "https://auth.example/device" },
      ["https://auth.example/device", "enter the code ABCD"],
    ],
  ])(
    "prints %s to sign in without a browser",
    async (_, deviceCode, expected) => {
      const output = captureLog();
      const gt = fakeAccount(fakeApi(), {
        login: async (options) => options?.onDeviceCode?.(deviceCode),
      });
      await signIn({ dir: tree(), account: gt.account });
      for (const text of expected) expect(output()).toContain(text);
    },
  );

  test("saves the key in a new .env.local that only the user can read", async () => {
    captureLog();
    const dir = tree();
    await signIn({ dir, account: fakeAccount().account });
    expect(fs.statSync(nodePath.join(dir, ".env.local")).mode & 0o777).toBe(
      0o600,
    );
  });

  test("adds the key below the lines already in .env.local", async () => {
    captureLog();
    const dir = tree({ ".env.local": "OTHER=1" });
    await signIn({ dir, account: fakeAccount().account });
    expect(read(dir, ".env.local")).toBe(
      `OTHER=1\nGT_PROJECT_ID=prj_new\nGT_DEV_API_KEY=${API_KEY}\n`,
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
    const gt = fakeAccount();
    expect(
      await signIn({ dir: tree(files), env, account: gt.account }),
    ).toEqual({
      apiKey: API_KEY,
      projectId: "prj_1",
    });
    expect(gt.requests.map((request) => request.path)).toEqual([
      "/v2/projects/prj_1/api-keys",
    ]);
  });

  test("adds a .gitignore rule for .env.local in a git work tree", async () => {
    captureLog();
    const dir = gitTree({ ".gitignore": "node_modules" });
    await signIn({ dir, account: fakeAccount().account });
    expect(read(dir, ".gitignore")).toBe("node_modules\n.env.local\n");
  });

  test("adds the rule again where a later .gitignore line un-ignores .env.local", async () => {
    captureLog();
    const dir = gitTree({ ".gitignore": ".env.local\n!.env.local\n" });
    await signIn({ dir, account: fakeAccount().account });
    expect(read(dir, ".gitignore")).toBe(
      ".env.local\n!.env.local\n.env.local\n",
    );
  });

  test("adds the rule again outside git where a later .gitignore line un-ignores .env.local, so a later git init ignores it", async () => {
    captureLog();
    vi.stubEnv("GIT_CONFIG_GLOBAL", nodePath.join(tree(), "none"));
    vi.stubEnv("XDG_CONFIG_HOME", tree());
    const dir = tree({ ".gitignore": ".env.local\n!.env.local\n" });
    await signIn({ dir, account: fakeAccount().account });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", ".env.local"], { cwd: dir }),
    ).not.toThrow();
  });

  test("leaves .gitignore alone when it ignores .env.local already", async () => {
    captureLog();
    const dir = gitTree({ ".gitignore": ".env*\n" });
    await signIn({ dir, account: fakeAccount().account });
    expect(read(dir, ".gitignore")).toBe(".env*\n");
  });

  test("signs in without git", async () => {
    captureLog();
    vi.stubEnv("PATH", tree());
    const dir = tree();
    expect(await signIn({ dir, account: fakeAccount().account })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_new",
    });
    // Outside a work tree too, or a later `git init` would commit the key.
    expect(read(dir, ".gitignore")).toBe(".env.local\n");
  });

  test("refuses a .env.local that git tracks before signing in", async () => {
    captureLog();
    const dir = gitTree({ ".env.local": "OTHER=1\n" });
    execFileSync("git", ["add", ".env.local"], { cwd: dir });
    const gt = fakeAccount();
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      ".env.local is tracked by git",
    );
    expect(gt.login).not.toHaveBeenCalled();
  });

  test("refuses a symlinked .env.local before signing in", async () => {
    captureLog();
    const dir = gitTree({
      "tracked.env": "OTHER=1\n",
      ".gitignore": ".env.local\n",
    });
    fs.symlinkSync("tracked.env", nodePath.join(dir, ".env.local"));
    const gt = fakeAccount();
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      ".env.local is a symbolic link",
    );
    expect(gt.login).not.toHaveBeenCalled();
    expect(read(dir, "tracked.env")).toBe("OTHER=1\n");
  });

  test("refuses a symlinked .gitignore before signing in, which git doesn't read", async () => {
    captureLog();
    const dir = gitTree({ "shared.gitignore": "node_modules\n" });
    fs.symlinkSync("shared.gitignore", nodePath.join(dir, ".gitignore"));
    const gt = fakeAccount();
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      ".gitignore is a symbolic link",
    );
    expect(gt.login).not.toHaveBeenCalled();
    expect(read(dir, "shared.gitignore")).toBe("node_modules\n");
    expect(fs.existsSync(nodePath.join(dir, ".env.local"))).toBe(false);
  });

  test("accepts a symlinked .gitignore when git ignores .env.local otherwise", async () => {
    captureLog();
    const dir = gitTree({ "shared.gitignore": "node_modules\n" });
    fs.symlinkSync("shared.gitignore", nodePath.join(dir, ".gitignore"));
    fs.appendFileSync(nodePath.join(dir, ".git/info/exclude"), ".env.local\n");
    await signIn({ dir, account: fakeAccount().account });
    expect(read(dir, ".env.local")).toContain(API_KEY);
    expect(read(dir, "shared.gitignore")).toBe("node_modules\n");
  });

  test.each([
    ["isn't JSON", "{", "expected valid JSON"],
    ["isn't an object", "[]", "expected a JSON object"],
    ["has an empty project ID", '{"projectId":" "}', "projectId must be"],
  ])(
    "refuses a gt.config.json that %s before signing in, rather than create another project",
    async (_, config, message) => {
      captureLog();
      const gt = fakeAccount();
      await expect(
        signIn({
          dir: tree({ "gt.config.json": config }),
          account: gt.account,
        }),
      ).rejects.toThrow(message);
      expect(gt.login).not.toHaveBeenCalled();
    },
  );

  test("asks for the organization, from every page, when the account has several", async () => {
    captureLog();
    const orgs = [
      { id: "org_1", name: "Emails" },
      { id: "org_2", name: "Acme (EU)" },
      { id: "org_3", name: "Third" },
    ];
    const gt = fakeAccount(fakeApi({ orgs, pageSize: 2 }));
    const { prompts, prompt } = fakePrompt("org_3");
    await signIn({ dir: tree(), prompt, account: gt.account });
    expect(prompts).toEqual([
      [
        "Which General Translation organization should the project belong to?",
        {
          type: "select",
          options: orgs.map((org) => ({ label: org.name, value: org.id })),
          cancel: "undefined",
        },
      ],
    ]);
    expect(gt.requests.map((request) => request.path)).toContain(
      "/v2/orgs/org_3/projects",
    );
  });

  test("creates and saves nothing when the organization question is cancelled", async () => {
    captureLog();
    const dir = tree();
    const orgs = [
      { id: "org_1", name: "Emails" },
      { id: "org_2", name: "Acme" },
    ];
    const gt = fakeAccount(fakeApi({ orgs }));
    expect(
      await signIn({
        dir,
        prompt: fakePrompt(undefined).prompt,
        account: gt.account,
      }),
    ).toBeUndefined();
    expect(gt.requests.map((request) => request.path)).toEqual(["/v2/orgs"]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("says where to create an organization when the account has none", async () => {
    captureLog();
    const gt = fakeAccount(fakeApi({ orgs: [] }));
    await expect(signIn({ dir: tree(), account: gt.account })).rejects.toThrow(
      "Your General Translation account has no organization. Create one at https://dash.generaltranslation.com, then run again.",
    );
  });

  test("says why the project couldn't be created, and saves nothing", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeAccount(
      fakeApi({ fail: projectLimit("/v2/orgs/org_1/projects") }),
    );
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      "Couldn't create the General Translation project: The organization reached its project limit",
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("keeps a new project's ID when its key couldn't be made, and makes the key for it on the next run", async () => {
    captureLog();
    const dir = tree();
    const failing = fakeAccount(
      fakeApi({ fail: projectLimit("/v2/projects/prj_new/api-keys") }),
    );
    await expect(signIn({ dir, account: failing.account })).rejects.toThrow(
      "Couldn't create a General Translation API key for project prj_new: The organization reached its project limit",
    );
    expect(read(dir, ".env.local")).toBe("GT_PROJECT_ID=prj_new\n");

    const gt = fakeAccount();
    await signIn({ dir, account: gt.account });
    expect(gt.requests.map((request) => request.path)).toEqual([
      "/v2/projects/prj_new/api-keys",
    ]);
    expect(read(dir, ".env.local")).toBe(
      `GT_PROJECT_ID=prj_new\nGT_DEV_API_KEY=${API_KEY}\n`,
    );
  });

  test("doesn't repeat a project ID the .env files have already", async () => {
    captureLog();
    const dir = tree({ ".env": "GT_PROJECT_ID=prj_1\n" });
    expect(await signIn({ dir, account: fakeAccount().account })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_1",
    });
    expect(read(dir, ".env.local")).toBe(`GT_DEV_API_KEY=${API_KEY}\n`);
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_1",
    });
  });

  test("passes on a failed sign-in, and saves nothing", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeAccount(fakeApi(), {
      login: async () => {
        throw new Error("gt Error: Sign in was denied in the browser");
      },
    });
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      "Sign in was denied in the browser",
    );
    expect(gt.requests).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  describe("without interactive", () => {
    test("resolves nothing without a sign-in, before checking .env.local", async () => {
      captureLog();
      const dir = gitTree({ ".env.local": "OTHER=1\n" });
      execFileSync("git", ["add", ".env.local"], { cwd: dir });
      const gt = fakeAccount();
      expect(
        await signIn({ dir, interactive: false, account: gt.account }),
      ).toBeUndefined();
      expect(gt.login).not.toHaveBeenCalled();
      expect(gt.requests).toEqual([]);
    });

    test("makes the key with gt's sign-in", async () => {
      captureLog();
      const dir = tree();
      const gt = fakeAccount(fakeApi(), { signedIn: true });
      expect(
        await signIn({ dir, interactive: false, account: gt.account }),
      ).toEqual({ apiKey: API_KEY, projectId: "prj_new" });
      expect(read(dir, ".env.local")).toBe(
        `GT_PROJECT_ID=prj_new\nGT_DEV_API_KEY=${API_KEY}\n`,
      );
    });

    test("fails instead of asking for the organization, and creates nothing", async () => {
      captureLog();
      const dir = tree();
      const orgs = [
        { id: "org_1", name: "Emails" },
        { id: "org_2", name: "Acme" },
      ];
      const gt = fakeAccount(fakeApi({ orgs }), { signedIn: true });
      const { prompts, prompt } = fakePrompt("org_1");
      await expect(
        signIn({ dir, interactive: false, prompt, account: gt.account }),
      ).rejects.toThrow(
        "Your General Translation account has several organizations. Run this command in a terminal to choose one, or set GT_PROJECT_ID to a project from https://dash.generaltranslation.com.",
      );
      expect(prompts).toEqual([]);
      expect(gt.requests.map((request) => request.path)).toEqual(["/v2/orgs"]);
      expect(fs.readdirSync(dir)).toEqual([]);
    });
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
    const orgs = [
      { id: "org_1", name: "Emails" },
      { id: "org_2", name: "Acme" },
    ];
    const gt = fakeAccount(fakeApi({ orgs }));
    expect(
      await signInToGt({ dir: tree(), settings, env: {}, account: gt.account }),
    ).toBeUndefined();
    expect(prompt).toHaveBeenCalledWith(
      "Which General Translation organization should the project belong to?",
      expect.objectContaining({ type: "select" }),
    );
  });
});
