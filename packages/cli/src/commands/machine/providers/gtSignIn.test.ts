import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { UserAuthError } from "@generaltranslation/auth";
import type { ProjectSettings } from "@inlang/sdk";
import { log } from "../../../utilities/log.js";
import {
  findGtProjectId,
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
 * A fake General Translation API: the user's organizations and projects in
 * pages of `pageSize`, and projects and keys made on request. `fail` answers
 * one path with an error.
 */
function fakeApi(
  options: {
    orgs?: Array<{ id: string; name: string }>;
    projects?: Array<{
      id: string;
      name: string;
      orgId: string;
      orgName: string;
    }>;
    pageSize?: number;
    fail?: { path: string; status: number; body: object };
  } = {},
) {
  const {
    orgs = [{ id: "org_1", name: "Emails" }],
    projects = [],
    pageSize = 50,
  } = options;
  const page = (items: unknown[]) => {
    const start = Number(new URL(lastUrl).searchParams.get("cursor") ?? 0);
    const end = start + pageSize;
    return {
      items: items.slice(start, end),
      nextCursor: end < items.length ? String(end) : null,
    };
  };
  let lastUrl = "";
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    lastUrl = request.url;
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
    if (url.pathname === "/v2/orgs") return json(200, page(orgs));
    if (url.pathname === "/v2/projects") return json(200, page(projects));
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
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
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
      source: ".env.local or .env",
    });
  });

  test("prefers the environment over .env.local", async () => {
    const dir = tree({ ".env.local": ENV_LOCAL });
    expect(
      await readGtCredentials({
        env: { GT_API_KEY: "env-key", GT_PROJECT_ID: "prj_env" },
        dir,
      }),
    ).toEqual({
      apiKey: "env-key",
      projectId: "prj_env",
      source: "the environment",
    });
  });

  test("reads .env, which .env.local overrides, as gt does", async () => {
    const dir = tree({
      ".env": "VITE_GT_PROJECT_ID=prj_env_file\nVITE_GT_DEV_API_KEY=old\n",
      ".env.local": "VITE_GT_DEV_API_KEY=new\n",
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "new",
      projectId: "prj_env_file",
      source: ".env.local or .env",
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
      source: ".env.local or .env",
    });
  });

  test("reads values in backticks, as gt does", async () => {
    const dir = tree({
      ".env.local": "GT_PROJECT_ID=`prj_1`\nGT_DEV_API_KEY=`key`\n",
    });
    expect(await readGtCredentials({ env: {}, dir })).toEqual({
      apiKey: "key",
      projectId: "prj_1",
      source: ".env.local or .env",
    });
  });

  test("skips an empty key", async () => {
    expect(
      await readGtCredentials({
        env: { GT_API_KEY: "", VITE_GT_DEV_API_KEY: "key" },
        dir: tree(),
      }),
    ).toEqual({
      apiKey: "key",
      projectId: undefined,
      source: "the environment",
    });
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
  /** The key and project ID in ENV_LOCAL. */
  const KEY = { apiKey: API_KEY, projectId: "prj_1" };

  test("after a sign-in for the project an ignored .env names, a clean checkout still uses that project", async () => {
    captureLog();
    const dir = gitTree({
      ".gitignore": ".env\n.env.local\n",
      ".env": "GT_PROJECT_ID=prj_1\n",
    });
    const credentials = await signIn({ dir, account: fakeAccount().account });
    expect(await shareGtProjectId(dir, credentials!)).toBe(true);

    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd });
    git(dir, "add", "-A");
    git(
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "init",
    );
    const clone = nodePath.join(tree(), "clone");
    git(dir, "clone", "-q", dir, clone);
    expect(await findGtProjectId(clone, {})).toBe("prj_1");
  });

  test("adds the project ID to a gt.config.json without one", async () => {
    const dir = tree({
      ".env.local": ENV_LOCAL,
      "gt.config.json": '{"defaultLocale":"en"}',
    });
    expect(await shareGtProjectId(dir, KEY)).toBe(true);
    expect(JSON.parse(read(dir, "gt.config.json"))).toEqual({
      defaultLocale: "en",
      projectId: "prj_1",
    });
  });

  test("leaves a gt.config.json that isn't JSON alone", async () => {
    const dir = tree({ ".env.local": ENV_LOCAL, "gt.config.json": "{" });
    expect(await shareGtProjectId(dir, KEY)).toBe(false);
    expect(read(dir, "gt.config.json")).toBe("{");
  });

  test("shares no project ID unless the key in use is the one in .env.local", async () => {
    const dir = tree({ ".env.local": ENV_LOCAL });
    for (const inUse of [
      { apiKey: "gtx-other", projectId: "prj_1" },
      { apiKey: API_KEY, projectId: "prj_other" },
      { apiKey: API_KEY },
    ]) {
      expect(await shareGtProjectId(dir, inUse)).toBe(false);
    }
    expect(fs.existsSync(nodePath.join(dir, "gt.config.json"))).toBe(false);
  });

  test("shares no project ID from .env, which may be shared already", async () => {
    const dir = tree({ ".env": ENV_LOCAL });
    expect(await shareGtProjectId(dir, KEY)).toBe(false);
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
        path: "/v2/projects",
        body: undefined,
        auth: "Bearer user-token",
      },
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

  test.each([
    [
      403,
      "If you are a member of its organization, ask a project admin for project:api_keys:write. If you aren't, ask to be invited",
    ],
    [404, "If you aren't a member of its organization, ask to be invited"],
  ])(
    "says how to get access when the key for a shared project fails with %i",
    async (status, advice) => {
      captureLog();
      const gt = fakeAccount(
        fakeApi({
          fail: {
            path: "/v2/projects/prj_team/api-keys",
            status,
            body: { error: "Forbidden", code: "forbidden" },
          },
        }),
      );
      await expect(
        signIn({
          dir: tree({ "gt.config.json": '{"projectId":"prj_team"}' }),
          account: gt.account,
        }),
      ).rejects.toThrow(
        `Couldn't create a General Translation API key for project prj_team: Forbidden. ${advice}, or remove the project ID from gt.config.json and the .env files to create your own project, then run again.`,
      );
    },
  );

  const teamProjects = [
    { id: "prj_a", name: "Website", orgId: "org_1", orgName: "Emails" },
    { id: "prj_b", name: "App", orgId: "org_2", orgName: "Acme" },
    { id: "prj_c", name: "Docs", orgId: "org_2", orgName: "Acme" },
  ];

  test("asks which of the user's projects to use, from every page, and makes the key for it", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeAccount(fakeApi({ projects: teamProjects, pageSize: 2 }));
    const { prompts, prompt } = fakePrompt("prj_c");
    expect(await signIn({ dir, prompt, account: gt.account })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_c",
    });
    expect(prompts).toEqual([
      [
        "Which General Translation project should this inlang project use?",
        {
          type: "select",
          options: [
            { label: "Website", value: "prj_a", hint: "Emails" },
            { label: "App", value: "prj_b", hint: "Acme" },
            { label: "Docs", value: "prj_c", hint: "Acme" },
            { label: "Create a new project", value: "" },
          ],
          cancel: "undefined",
        },
      ],
    ]);
    expect(gt.requests.map((request) => request.path)).toEqual([
      "/v2/projects",
      "/v2/projects",
      "/v2/projects/prj_c/api-keys",
    ]);
    expect(read(dir, ".env.local")).toBe(
      `GT_PROJECT_ID=prj_c\nGT_DEV_API_KEY=${API_KEY}\n`,
    );
  });

  test("creates a project when the user chooses to, asking for the organization only then", async () => {
    captureLog();
    const gt = fakeAccount(
      fakeApi({
        projects: teamProjects,
        orgs: [
          { id: "org_1", name: "Emails" },
          { id: "org_2", name: "Acme" },
        ],
      }),
    );
    const answers = ["", "org_2"];
    const prompts: string[] = [];
    await signIn({
      dir: tree(),
      prompt: async (message) => {
        prompts.push(message);
        return answers.shift();
      },
      account: gt.account,
    });
    expect(prompts).toEqual([
      "Which General Translation project should this inlang project use?",
      "Which General Translation organization should the project belong to?",
    ]);
    expect(gt.requests.map((request) => request.path)).toContain(
      "/v2/orgs/org_2/projects",
    );
  });

  test("creates and saves nothing when the project question is cancelled", async () => {
    captureLog();
    const dir = tree();
    const gt = fakeAccount(fakeApi({ projects: teamProjects }));
    expect(
      await signIn({
        dir,
        prompt: fakePrompt(undefined).prompt,
        account: gt.account,
      }),
    ).toBeUndefined();
    expect(gt.requests.map((request) => request.path)).toEqual([
      "/v2/projects",
    ]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("passes noBrowser to the sign-in", async () => {
    captureLog();
    const gt = fakeAccount();
    await signIn({ dir: tree(), noBrowser: true, account: gt.account });
    expect(gt.login).toHaveBeenCalledWith(
      expect.objectContaining({ noBrowser: true }),
    );
  });

  test("doesn't sign in again while gt's sign-in is valid", async () => {
    captureLog();
    const gt = fakeAccount(fakeApi(), { signedIn: true });
    await signIn({ dir: tree(), account: gt.account });
    expect(gt.login).not.toHaveBeenCalled();
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
      "gt.config.json, without its spaces",
      { "gt.config.json": '{"projectId":" prj_1 "}' },
      {},
    ],
    [
      ".env.local, before .env and the environment",
      {
        ".env.local": "GT_PROJECT_ID=prj_1\n",
        ".env": "VITE_GT_PROJECT_ID=prj_other\n",
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
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
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

  test.each([["/.env.local\n"], [".env.local  \n"]])(
    "outside git, leaves a .gitignore whose last line is %j alone",
    async (gitignore) => {
      captureLog();
      vi.stubEnv("PATH", tree());
      const dir = tree({ ".gitignore": gitignore });
      await signIn({ dir, account: fakeAccount().account });
      expect(read(dir, ".gitignore")).toBe(gitignore);
    },
  );

  test("refuses a .env.local that can't be written before signing in", async () => {
    captureLog();
    const dir = tree({ ".env.local": "OTHER=1\n" });
    fs.chmodSync(nodePath.join(dir, ".env.local"), 0o444);
    const gt = fakeAccount();
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      "Can't save the General Translation key: .env.local can't be written. Make it writable, then run again.",
    );
    expect(gt.login).not.toHaveBeenCalled();
  });

  test("signs in with a read-only .gitignore that already ignores .env.local", async () => {
    captureLog();
    const dir = gitTree({ ".gitignore": ".env*\n" });
    fs.chmodSync(nodePath.join(dir, ".gitignore"), 0o444);
    try {
      expect(await signIn({ dir, account: fakeAccount().account })).toEqual({
        apiKey: API_KEY,
        projectId: "prj_new",
      });
      expect(read(dir, ".gitignore")).toBe(".env*\n");
    } finally {
      fs.chmodSync(nodePath.join(dir, ".gitignore"), 0o644);
    }
  });

  test("refuses a read-only .gitignore that needs a rule for .env.local before signing in", async () => {
    captureLog();
    const dir = gitTree({ ".gitignore": "node_modules\n" });
    fs.chmodSync(nodePath.join(dir, ".gitignore"), 0o444);
    const gt = fakeAccount();
    try {
      await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
        "Can't save the General Translation key: .gitignore can't be written. Make it writable, then run again.",
      );
      expect(gt.login).not.toHaveBeenCalled();
    } finally {
      fs.chmodSync(nodePath.join(dir, ".gitignore"), 0o644);
    }
  });

  test("refuses a .gitignore that is a folder before signing in", async () => {
    captureLog();
    const dir = tree();
    fs.mkdirSync(nodePath.join(dir, ".gitignore"));
    const gt = fakeAccount();
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      ".gitignore isn't a file. Replace it with a regular file, then run again.",
    );
    expect(gt.login).not.toHaveBeenCalled();
  });

  test("refuses a folder that can't be written before signing in", async () => {
    captureLog();
    const dir = tree();
    fs.chmodSync(dir, 0o555);
    const gt = fakeAccount();
    try {
      await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
        `${dir} can't be written. Make it writable, then run again.`,
      );
      expect(gt.login).not.toHaveBeenCalled();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
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

  test.each([
    ["the repository's folder", ""],
    ["a folder in the repository", "app"],
  ])("refuses before signing in without git in %s", async (_, subfolder) => {
    captureLog();
    vi.stubEnv("PATH", tree());
    const root = tree({ ".env.local": "OTHER=1\n" });
    fs.mkdirSync(nodePath.join(root, ".git"));
    const dir = nodePath.join(root, subfolder);
    fs.mkdirSync(dir, { recursive: true });
    const gt = fakeAccount();
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      "Can't save the General Translation key: git isn't installed, so whether git tracks .env.local in this repository can't be checked. Install git, then run again.",
    );
    expect(gt.login).not.toHaveBeenCalled();
  });

  test("refuses before signing in when git fails in the repository", async () => {
    captureLog();
    const dir = gitTree({ ".env.local": "OTHER=1\n" });
    execFileSync("git", ["add", ".env.local"], { cwd: dir });
    // Like "detected dubious ownership": git fails for any command.
    fs.appendFileSync(nodePath.join(dir, ".git", "config"), "[core\n");
    const gt = fakeAccount();
    await expect(signIn({ dir, account: gt.account })).rejects.toThrow(
      "git can't tell whether it tracks .env.local (fatal: bad config line",
    );
    expect(gt.login).not.toHaveBeenCalled();
    expect(read(dir, ".env.local")).toBe("OTHER=1\n");
  });

  test.each([
    [".env.local or .env", { ".env.local": "GT_PROJECT_ID=prj_local\n" }, {}],
    ["the environment", {}, { GT_PROJECT_ID: "prj_local" }],
  ])(
    "refuses before signing in when %s names another project than gt.config.json",
    async (where, files, env) => {
      captureLog();
      const gt = fakeAccount();
      await expect(
        signIn({
          dir: tree({
            ...files,
            "gt.config.json": '{"projectId":"prj_config"}',
          }),
          env,
          account: gt.account,
        }),
      ).rejects.toThrow(
        `Project ID mismatch: gt.config.json uses prj_config, but ${where} uses prj_local. Use the same project ID in both, then run again.`,
      );
      expect(gt.login).not.toHaveBeenCalled();
    },
  );

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
    expect(gt.requests.map((request) => request.path)).toEqual([
      "/v2/projects",
      "/v2/orgs",
    ]);
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
    const error = await signIn({ dir, account: failing.account }).catch(
      (error) => error,
    );
    // No hint to ask for access: the project is the user's own.
    expect(error.message).toBe(
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

  test.each([
    [
      "doesn't repeat the project ID in .env.local",
      { ".env.local": "GT_PROJECT_ID=prj_1\n" },
      `GT_PROJECT_ID=prj_1\nGT_DEV_API_KEY=${API_KEY}\n`,
    ],
    [
      "saves the project ID next to the key when only .env names it",
      { ".env": "GT_PROJECT_ID=prj_1\n" },
      `GT_PROJECT_ID=prj_1\nGT_DEV_API_KEY=${API_KEY}\n`,
    ],
  ])("%s", async (_, files, envLocal) => {
    captureLog();
    const dir = tree(files);
    expect(await signIn({ dir, account: fakeAccount().account })).toEqual({
      apiKey: API_KEY,
      projectId: "prj_1",
    });
    expect(read(dir, ".env.local")).toBe(envLocal);
  });

  test.each([
    ["oauth", "Sign in was denied in the browser", "Run `gt login` again"],
    ["login_required", "You are not signed in", "Run `gt login` to sign in"],
  ] as const)(
    "passes on a failed sign-in (%s), saves nothing, and says to run this command again instead of `gt login`",
    async (code, whatHappened, fix) => {
      captureLog();
      const dir = tree();
      const gt = fakeAccount(fakeApi(), {
        login: async () => {
          throw new UserAuthError(code, whatHappened, fix);
        },
      });
      const error = await signIn({ dir, account: gt.account }).catch(
        (error) => error,
      );
      expect(error.message).toBe(
        `${whatHappened}. Run this command again to sign in.`,
      );
      expect(error.cause).toBeInstanceOf(UserAuthError);
      expect(gt.requests).toEqual([]);
      expect(fs.readdirSync(dir)).toEqual([]);
    },
  );

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

    test("with login, signs in with a code and makes the key", async () => {
      captureLog();
      const dir = tree();
      const gt = fakeAccount();
      expect(
        await signIn({
          dir,
          interactive: false,
          login: true,
          noBrowser: true,
          account: gt.account,
        }),
      ).toEqual({ apiKey: API_KEY, projectId: "prj_new" });
      expect(gt.login).toHaveBeenCalledWith(
        expect.objectContaining({ noBrowser: true }),
      );
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

    test("fails instead of asking which project, and creates nothing", async () => {
      captureLog();
      const dir = tree();
      const gt = fakeAccount(
        fakeApi({
          projects: [
            { id: "prj_a", name: "Website", orgId: "org_1", orgName: "Emails" },
          ],
        }),
        { signedIn: true },
      );
      const { prompts, prompt } = fakePrompt("prj_a");
      await expect(
        signIn({ dir, interactive: false, prompt, account: gt.account }),
      ).rejects.toThrow(
        "Your General Translation account has projects. Run this command in a terminal to choose one or create another, or set GT_PROJECT_ID to one of them from https://dash.generaltranslation.com.",
      );
      expect(prompts).toEqual([]);
      expect(gt.requests.map((request) => request.path)).toEqual([
        "/v2/projects",
      ]);
      expect(fs.readdirSync(dir)).toEqual([]);
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
      expect(gt.requests.map((request) => request.path)).toEqual([
        "/v2/projects",
        "/v2/orgs",
      ]);
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
