import { afterEach, test, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { ProjectSettings } from "@inlang/sdk";
import { version } from "../../../../package.json";
import { log } from "../../../utilities/log.js";
import {
  MachineTranslateError,
  OPENAI_REASONING_EFFORT_ENV,
  resolveMachineTranslateProvider,
} from "./resolveProvider.js";
import type { AnyMachineTranslateProvider } from "./types.js";

const BYOK_URL = "https://inlang.com/m/2qj2w8pu/app-inlang-cli/byok";
const COMMUNITY_NOTICE =
  "Translating with the community-operated service at translate.demosjarco.dev, which inlang doesn't operate.";

type ResolveArgs = Parameters<typeof resolveMachineTranslateProvider>[0];

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

/** A folder with `files`, and the path of a project.inlang in it. */
function projectIn(files: Record<string, string> = {}, folder = "app") {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "inlang-provider-"));
  directories.push(root);
  const dir = nodePath.join(root, folder);
  fs.mkdirSync(dir);
  for (const [path, content] of Object.entries(files))
    fs.writeFileSync(nodePath.join(dir, path), content);
  return { dir, projectPath: nodePath.join(dir, "project.inlang") };
}

const settings = { baseLocale: "en", locales: ["en", "de"] } as ProjectSettings;

const unexpectedSignIn = async () => {
  throw new Error("signIn must not be called");
};

/** No `gt` sign-in on this machine: outside a terminal, sign-in makes no key. */
const signedOut: NonNullable<ResolveArgs["signIn"]> = async ({
  interactive,
}) => {
  if (interactive === false) return undefined;
  throw new Error("signIn must not be called");
};

function resolve(args: Partial<ResolveArgs>) {
  return resolveMachineTranslateProvider({
    env: {},
    projectPath: projectIn().projectPath,
    settings,
    interactive: false,
    signIn: signedOut,
    ...args,
  });
}

/** The URL and headers of the provider's first request. */
async function firstRequest(provider: AnyMachineTranslateProvider) {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 400 }));
  const args = { sourceLocale: "en", targetLocale: "de" };
  if ("translateBatch" in provider)
    await provider.translateBatch({ ...args, texts: { 0: { text: "Hi" } } });
  else await provider.translateText({ ...args, text: "Hi" });
  const [url, init] = fetch.mock.calls[0]!;
  return {
    url: String(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body,
  };
}

test("uses google when its key is set and no provider is configured", async () => {
  const provider = await resolve({
    env: { INLANG_GOOGLE_TRANSLATE_API_KEY: "google-key" },
  });
  expect((await firstRequest(provider)).url).toMatch(
    /^https:\/\/translation\.googleapis\.com\//,
  );
});

test("uses openai when its key is set and no provider is configured", async () => {
  const provider = await resolve({
    env: { INLANG_OPENAI_API_KEY: "openai-key" },
  });
  expect((await firstRequest(provider)).url).toMatch(
    /^https:\/\/api\.openai\.com\//,
  );
});

test.each([
  ["INLANG_GOOGLE_TRANSLATE_API_KEY", "translation.googleapis.com"],
  ["INLANG_DEEPL_API_KEY", "api.deepl.com"],
  ["INLANG_OPENAI_API_KEY", "api.openai.com"],
])(
  "uses %s from the project's env files without signing in",
  async (key, host) => {
    const { projectPath } = projectIn({ ".env.local": `${key}=file-key\n` });
    const provider = await resolve({ projectPath });
    expect(new URL((await firstRequest(provider)).url).hostname).toBe(host);
  },
);

test("reads explicit providers from env files, with .env.local and then the shell taking precedence", async () => {
  const { projectPath } = projectIn({
    ".env":
      "INLANG_MACHINE_TRANSLATE_PROVIDER=google\nINLANG_GOOGLE_TRANSLATE_API_KEY=google-key\n",
    ".env.local":
      "INLANG_MACHINE_TRANSLATE_PROVIDER=deepl\nINLANG_DEEPL_API_KEY=local-key\n",
  });
  const local = await resolve({ projectPath });
  expect((await firstRequest(local)).headers).toMatchObject({
    Authorization: "DeepL-Auth-Key local-key",
  });
  vi.restoreAllMocks();
  const shell = await resolve({
    projectPath,
    env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "google" },
  });
  expect(new URL((await firstRequest(shell)).url).hostname).toBe(
    "translation.googleapis.com",
  );
});

test("the shell's key overrides the same provider's file key without mutating the shell", async () => {
  const { projectPath } = projectIn({
    ".env.local": "INLANG_DEEPL_API_KEY=local-key\n",
  });
  const env = { INLANG_DEEPL_API_KEY: "shell-key" };
  const provider = await resolve({ projectPath, env });
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "DeepL-Auth-Key shell-key",
  });
  expect(env).toEqual({ INLANG_DEEPL_API_KEY: "shell-key" });
});

test("an explicit GT provider in .env.local never falls back without credentials", async () => {
  const { projectPath } = projectIn({
    ".env.local": "INLANG_MACHINE_TRANSLATE_PROVIDER=gt\n",
  });
  await expect(resolve({ projectPath })).rejects.toThrow(
    "Machine translation needs a General Translation API key.",
  );
});

test("provider options in .env.local configure the request too", async () => {
  const { projectPath } = projectIn({
    ".env.local":
      "INLANG_OPENAI_API_KEY=file-key\nINLANG_OPENAI_MODEL=gpt-file-model\n",
  });
  const provider = await resolve({ projectPath });
  const { body } = await firstRequest(provider);
  expect(JSON.parse(body as string).model).toBe("gpt-file-model");
});

test("an invalid file provider fails instead of falling back", async () => {
  const { projectPath } = projectIn({
    ".env.local": "INLANG_MACHINE_TRANSLATE_PROVIDER=unknown\n",
  });
  await expect(resolve({ projectPath })).rejects.toThrow(
    "Unsupported INLANG_MACHINE_TRANSLATE_PROVIDER",
  );
});

test("GT credentials still pair a shell key only with the shell's project ID", async () => {
  const { projectPath } = projectIn({
    ".env.local": "GT_API_KEY=local-key\nGT_PROJECT_ID=local-project\n",
  });
  const provider = await resolve({
    projectPath,
    env: { GT_API_KEY: "shell-key" },
  });
  const { headers } = await firstRequest(provider);
  expect(headers.Authorization).toBe("Bearer shell-key");
  expect(headers).not.toHaveProperty("gt-project-id");
});

test("a bring-your-own key beats a General Translation key", async () => {
  const provider = await resolve({
    env: { INLANG_DEEPL_API_KEY: "deepl-key", GT_API_KEY: "gt-env-key" },
    projectPath: projectIn({ ".env.local": "GT_API_KEY=gt-local-key\n" })
      .projectPath,
  });
  expect((await firstRequest(provider)).url).toMatch(/deepl\.com\//);
});

test("uses General Translation with the key from the environment", async () => {
  const provider = await resolve({
    env: { GT_API_KEY: "gt-env-key", GT_PROJECT_ID: "prj_env" },
  });
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "Bearer gt-env-key",
    "gt-project-id": "prj_env",
  });
});

test("uses General Translation with the key in .env.local next to project.inlang", async () => {
  const { projectPath } = projectIn({
    ".env.local": "GT_PROJECT_ID=prj_local\nGT_API_KEY=gt-local-key\n",
  });
  const provider = await resolve({ projectPath, interactive: true });
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "Bearer gt-local-key",
    "gt-project-id": "prj_local",
  });
});

test("an explicit gt beats a bring-your-own key", async () => {
  const provider = await resolve({
    env: {
      INLANG_MACHINE_TRANSLATE_PROVIDER: "gt",
      INLANG_GOOGLE_TRANSLATE_API_KEY: "google-key",
      GT_API_KEY: "gt-env-key",
    },
  });
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "Bearer gt-env-key",
  });
});

test("identifies the CLI in the user agent", async () => {
  const provider = await resolve({ env: { GT_API_KEY: "gt-env-key" } });
  expect((await firstRequest(provider)).headers["User-Agent"]).toBe(
    `inlang-cli/${version}`,
  );
});

test("signs in to General Translation in an interactive terminal without credentials", async () => {
  const prompt = vi.spyOn(log, "prompt").mockResolvedValue("gt");
  const { dir, projectPath } = projectIn();
  const env = {};
  const signIn = vi.fn(async () => ({
    apiKey: "gt-signed-in-key",
    projectId: "prj_new",
  }));
  const provider = await resolve({
    env,
    projectPath,
    interactive: true,
    signIn,
  });
  // consola otherwise resolves a cancelled prompt with `initial`, a sign-in.
  expect(prompt.mock.calls).toEqual([
    [
      "Which translation provider should this project use?",
      {
        type: "select",
        options: [
          { value: "gt", label: "General Translation (recommended)" },
          { value: "community", label: "Community translation service" },
          { value: "other", label: "Other" },
        ],
        initial: "gt",
        cancel: "undefined",
      },
    ],
  ]);
  expect(signIn).toHaveBeenCalledWith({ dir, settings, env });
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "Bearer gt-signed-in-key",
    "gt-project-id": "prj_new",
  });
});

test.each([undefined, "  "])(
  "unconfigured noninteractive runs use the community service without saving a preference (%j)",
  async (selection) => {
    const { dir, projectPath } = projectIn();
    const prompt = vi.spyOn(log, "prompt");
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const provider = await resolve({
      projectPath,
      env: { INLANG_MACHINE_TRANSLATE_PROVIDER: selection },
    });
    expect((await firstRequest(provider)).url).toMatch(
      /^https:\/\/translate\.demosjarco\.dev\//,
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "No translation provider configured. Using the community service. General Translation setup for CI and coding agents: https://inlang.com/m/2qj2w8pu/app-inlang-cli#machine-translate. To use this service without this message, set INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco.",
    );
  },
);

// A missing CI secret, as in a pull request from a fork, must not send the
// text of a project that chose General Translation to another service.
test("a project with a GT project ID fails without a key outside an interactive terminal", async () => {
  const { projectPath } = projectIn({
    "gt.config.json": `{"projectId":"prj_shared"}`,
  });
  await expect(resolve({ projectPath })).rejects.toThrow(
    /^Machine translation needs a General Translation API key\./,
  );
});

test.each(['{"projectId":"prj_shared",}', "null", '{"projectId":"  "}'])(
  "invalid GT configuration never selects a fallback (%s)",
  async (config) => {
    const { projectPath } = projectIn({ "gt.config.json": config });
    await expect(resolve({ projectPath })).rejects.toThrow(
      /Invalid General Translation config/,
    );
  },
);

test("an unreadable GT configuration is not treated as missing", async () => {
  const { dir, projectPath } = projectIn();
  fs.mkdirSync(nodePath.join(dir, "gt.config.json"));
  await expect(resolve({ projectPath })).rejects.toMatchObject({
    code: "EISDIR",
  });
});

test("a dot project path finds the same adjacent GT configuration and credentials as an absolute path", async () => {
  const { dir, projectPath } = projectIn({
    "gt.config.json": '{"projectId":"prj_shared"}',
  });
  fs.mkdirSync(projectPath);
  const cwd = process.cwd();
  process.chdir(projectPath);
  try {
    for (const selectedPath of [projectPath, "."]) {
      await expect(resolve({ projectPath: selectedPath })).rejects.toThrow(
        "Machine translation needs a General Translation API key.",
      );
    }
    fs.writeFileSync(
      nodePath.join(dir, ".env.local"),
      "GT_API_KEY=gt-local-key\nGT_PROJECT_ID=prj_shared\n",
    );
    for (const selectedPath of [projectPath, "."]) {
      const provider = await resolve({ projectPath: selectedPath });
      expect((await firstRequest(provider)).headers).toMatchObject({
        Authorization: "Bearer gt-local-key",
        "gt-project-id": "prj_shared",
      });
    }
  } finally {
    process.chdir(cwd);
  }
});

test("an explicit GT provider fails without credentials outside an interactive terminal", async () => {
  const { projectPath } = projectIn({}, "bob's app");
  await expect(
    resolve({ projectPath, env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "gt" } }),
  ).rejects.toThrowError(
    new MachineTranslateError(
      [
        "Machine translation needs a General Translation API key.",
        "- In a terminal: run this command directly to sign in. It can't ask through a task runner that captures its output or with CI set. Over SSH, open the printed sign-in URL in your browser.",
        "- CI: set GT_API_KEY and GT_PROJECT_ID from your project at https://dash.generaltranslation.com.",
        "- Agents: have the user run this command in their terminal, or sign in with `npx gt login --no-browser`, then run this command again. Signed in, it saves a development key to .env.local.",
        "- Or use the community-operated service: set INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco.",
        `- Or bring your own key: ${BYOK_URL}`,
      ].join("\n"),
    ),
  );
});

test.each([
  {
    name: "tracked by git",
    setUp: (dir: string) => {
      fs.writeFileSync(nodePath.join(dir, ".env.local"), "PUBLIC=1\n");
      execFileSync("git", ["add", "-f", ".env.local"], { cwd: dir });
    },
    problem:
      ".env.local is tracked by git. Untrack it with `git rm --cached .env.local`",
  },
  {
    name: "a symlink",
    setUp: (dir: string) => {
      fs.writeFileSync(nodePath.join(dir, "shared.env"), "PUBLIC=1\n");
      fs.symlinkSync("shared.env", nodePath.join(dir, ".env.local"));
    },
    problem: ".env.local is a symbolic link. Replace it with a regular file",
  },
])(
  "agents hear why no key can be saved to a .env.local $name",
  async ({ setUp, problem }) => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", nodePath.join(os.tmpdir(), "none"));
    const { dir, projectPath } = projectIn({ ".gitignore": ".env.local\n" });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    setUp(dir);
    const error = await resolve({
      projectPath,
      env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "gt" },
    }).catch((error) => error);
    expect(error.message.split("\n")).toContain(
      `- Agents: a development key can't be saved: ${problem}, then run this command again.`,
    );
    expect(error.message).not.toContain("gt login");
  },
);

test("choosing community translation uses that service and saves the choice", async () => {
  vi.spyOn(log, "prompt").mockResolvedValue("community");
  const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
  const { dir, projectPath } = projectIn({ ".env.local": "OTHER=1\n" });
  const provider = await resolve({ projectPath, interactive: true });
  expect((await firstRequest(provider)).url).toMatch(
    /^https:\/\/translate\.demosjarco\.dev\//,
  );
  expect(fs.readFileSync(nodePath.join(dir, ".env.local"), "utf8")).toBe(
    "OTHER=1\nINLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco\n",
  );
  // Outside a git work tree, so the rule is added.
  expect(info.mock.calls).toEqual([
    [COMMUNITY_NOTICE],
    [
      "Saved your choice to .env.local. To be asked again, remove INLANG_MACHINE_TRANSLATE_PROVIDER from it.\nAdded .env.local to .gitignore.",
    ],
  ]);
});

test("choosing other links to the provider setup, and saves nothing", async () => {
  vi.spyOn(log, "prompt").mockResolvedValue("other");
  const { dir, projectPath } = projectIn();
  await expect(
    resolve({ projectPath, interactive: true, signIn: unexpectedSignIn }),
  ).rejects.toThrowError(
    new MachineTranslateError(
      `To use another translation provider, see ${BYOK_URL}, then run this command again.`,
    ),
  );
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("uses the choice saved in .env.local without asking, and says where it is", async () => {
  const prompt = vi.spyOn(log, "prompt");
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
  const provider = await resolve({
    // an empty provider setting is no setting
    env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "" },
    projectPath: projectIn({
      ".env.local": "INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco\n",
    }).projectPath,
    interactive: true,
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(info.mock.calls).toEqual([
    [COMMUNITY_NOTICE],
    [
      "You chose this service in .env or .env.local. To be asked about General Translation again, remove INLANG_MACHINE_TRANSLATE_PROVIDER from it.",
    ],
  ]);
  expect((await firstRequest(provider)).url).toMatch(
    /^https:\/\/translate\.demosjarco\.dev\//,
  );
});

test("a bring-your-own key beats the choice saved in .env.local", async () => {
  const provider = await resolve({
    env: { INLANG_DEEPL_API_KEY: "deepl-key" },
    projectPath: projectIn({
      ".env.local": "INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco\n",
    }).projectPath,
  });
  expect((await firstRequest(provider)).url).toMatch(/deepl\.com\//);
});

test("the environment's provider beats the choice saved in .env.local", async () => {
  const provider = await resolve({
    env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "gt", GT_API_KEY: "gt-env-key" },
    projectPath: projectIn({
      ".env.local": "INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco\n",
    }).projectPath,
  });
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "Bearer gt-env-key",
  });
});

test("shares the project ID from .env.local in gt.config.json, once", async () => {
  const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
  const { dir, projectPath } = projectIn({
    ".env.local": "GT_PROJECT_ID=prj_local\nGT_API_KEY=gt-local-key\n",
  });
  await resolve({ projectPath });
  await resolve({ projectPath });
  expect(fs.readFileSync(nodePath.join(dir, "gt.config.json"), "utf8")).toBe(
    '{\n  "projectId": "prj_local"\n}\n',
  );
  expect(info.mock.calls).toEqual([
    [
      "Saved the General Translation project ID to gt.config.json. Commit it so teammates use the same project.",
    ],
  ]);
});

test("outside an interactive terminal, a `gt` sign-in makes the key without asking", async () => {
  const { dir, projectPath } = projectIn();
  const signIn = vi.fn<NonNullable<ResolveArgs["signIn"]>>(async () => {
    fs.writeFileSync(
      nodePath.join(dir, ".env.local"),
      "GT_PROJECT_ID=prj_1\nGT_DEV_API_KEY=gtx-dev\n",
    );
    return { apiKey: "gtx-dev", projectId: "prj_1" };
  });
  const provider = await resolve({
    projectPath,
    env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "gt" },
    signIn,
  });
  expect(signIn).toHaveBeenCalledWith(
    expect.objectContaining({ dir, interactive: false }),
  );
  expect((await firstRequest(provider)).headers["Authorization"]).toBe(
    "Bearer gtx-dev",
  );
  expect(
    JSON.parse(fs.readFileSync(nodePath.join(dir, "gt.config.json"), "utf8")),
  ).toEqual({
    projectId: "prj_1",
  });
});

test("a failed sign-in outside an interactive terminal is a MachineTranslateError too", async () => {
  const error = await resolve({
    env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "gt" },
    signIn: async () => {
      throw new Error(
        "Your General Translation account has several organizations.",
      );
    },
  }).catch((error) => error);
  expect(error).toBeInstanceOf(MachineTranslateError);
  expect(error.message).toBe(
    "Your General Translation account has several organizations.",
  );
});

test("a failed sign-in is a MachineTranslateError, which prints without a stack trace", async () => {
  vi.spyOn(log, "prompt").mockResolvedValue("gt");
  const error = await resolve({
    interactive: true,
    signIn: async () => {
      throw new Error("General Translation sign-in failed: quota reached.");
    },
  }).catch((error) => error);
  expect(error).toBeInstanceOf(MachineTranslateError);
  expect(error.message).toBe(
    "General Translation sign-in failed: quota reached.",
  );
});

test("uses the community service when it is selected, and only names it", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
  const provider = await resolve({
    env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "demosjarco" },
  });
  expect(info.mock.calls).toEqual([[COMMUNITY_NOTICE]]);
  expect(warn).not.toHaveBeenCalled();
  expect((await firstRequest(provider)).url).toMatch(
    /^https:\/\/translate\.demosjarco\.dev\//,
  );
});

test("requires INLANG_GOOGLE_TRANSLATE_API_KEY for google provider", async () => {
  await expect(
    resolve({ env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "google" } }),
  ).rejects.toThrow("INLANG_GOOGLE_TRANSLATE_API_KEY must be set");
});

test("requires INLANG_DEEPL_API_KEY for deepl provider", async () => {
  await expect(
    resolve({ env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "deepl" } }),
  ).rejects.toThrow("INLANG_DEEPL_API_KEY must be set");
});

test("requires INLANG_OPENAI_API_KEY for openai provider", async () => {
  await expect(
    resolve({ env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "openai" } }),
  ).rejects.toThrow("INLANG_OPENAI_API_KEY must be set");
});

test("uses OpenAI model and reasoning effort from the environment", async () => {
  const provider = await resolve({
    env: {
      INLANG_MACHINE_TRANSLATE_PROVIDER: "openai",
      INLANG_OPENAI_API_KEY: "openai-key",
      INLANG_OPENAI_MODEL: "gpt-custom",
      [OPENAI_REASONING_EFFORT_ENV]: "medium",
    },
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hallo Welt" }],
        },
      ],
    }),
  );
  if (!("translateText" in provider)) throw new Error("Expected OpenAI");

  await provider.translateText({
    text: "Hello World",
    sourceLocale: "en",
    targetLocale: "de",
  });

  const request = fetch.mock.calls[0]?.[1];
  if (!request) {
    throw new Error("Expected an OpenAI API request");
  }
  expect(JSON.parse(String(request.body))).toMatchObject({
    model: "gpt-custom",
    reasoning: { effort: "medium" },
  });
});

test("rejects unsupported provider values", async () => {
  await expect(
    resolve({ env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "azure" } }),
  ).rejects.toThrow(
    'Unsupported INLANG_MACHINE_TRANSLATE_PROVIDER value: "azure"',
  );
});
