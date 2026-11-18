import { afterEach, beforeEach, test, expect, vi } from "vitest";
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
const COMMUNITY_WARNING = [
  "Using the community-operated translation service at translate.demosjarco.dev. Stability is not guaranteed.",
  "This service is not owned, operated, or maintained by inlang.",
  `Provide your own API key for higher reliability and control: ${BYOK_URL}`,
].join("\n");

type ResolveArgs = Parameters<typeof resolveMachineTranslateProvider>[0];

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * Puts a fake `npx` alone on PATH that exits with `code`, and returns the
 * argument lists it was called with.
 */
function fakeNpx(code: number): () => string[] {
  const bin = fs.mkdtempSync(nodePath.join(os.tmpdir(), "inlang-npx-"));
  directories.push(bin);
  const calls = nodePath.join(bin, "calls");
  fs.writeFileSync(
    nodePath.join(bin, "npx"),
    `#!/bin/sh\necho "$@" >> '${calls}'\nexit ${code}\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", bin);
  return () =>
    fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trimEnd().split("\n")
      : [];
}

// The sign-in check must never run the real gt: by default it finds a gt
// that isn't signed in.
let npxCalls: () => string[];
beforeEach(() => {
  npxCalls = fakeNpx(2);
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

function resolve(args: Partial<ResolveArgs>) {
  return resolveMachineTranslateProvider({
    env: {},
    projectPath: projectIn().projectPath,
    settings,
    interactive: false,
    signIn: unexpectedSignIn,
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
  expect(npxCalls()).toEqual([]);
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
  const notice = vi.spyOn(log, "log").mockImplementation(() => undefined);
  const prompt = vi.spyOn(log, "prompt").mockResolvedValue(true);
  const { dir, projectPath } = projectIn();
  const env = { HOME: "/home/user" };
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
  expect(notice.mock.calls).toEqual([
    [
      "Machine translation is powered by General Translation. Answer No to use the community translation service instead.",
    ],
  ]);
  // consola otherwise resolves a cancelled confirm with `initial`, a yes.
  expect(prompt.mock.calls).toEqual([
    [
      "Use General Translation for this project?",
      { type: "confirm", initial: true, cancel: "undefined" },
    ],
  ]);
  expect(signIn).toHaveBeenCalledWith({ dir, settings, env });
  // Nothing runs before the question.
  expect(npxCalls()).toEqual([]);
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "Bearer gt-signed-in-key",
    "gt-project-id": "prj_new",
  });
});

test.each([undefined, "", "  "])(
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
    expect(npxCalls()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "No translation provider configured. Using the community service. To use General Translation, set GT_API_KEY and GT_PROJECT_ID from your project at https://dash.generaltranslation.com. To use this service without this message, set INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco.",
    );
  },
);

// A missing CI secret, as in a pull request from a fork, must not send the
// text of a project that chose General Translation to another service.
test.each<{ files: Record<string, string>; env: Record<string, string> }>([
  { files: { "gt.config.json": `{"projectId":"prj_shared"}` }, env: {} },
  { files: { ".env": "GT_PROJECT_ID=prj_shared" }, env: {} },
  { files: {}, env: { GT_PROJECT_ID: "prj_shared" } },
])(
  "a project with a GT project ID fails without a key outside an interactive terminal (%o)",
  async ({ files, env }) => {
    const { projectPath } = projectIn(files);
    await expect(resolve({ projectPath, env })).rejects.toThrow(
      /^Machine translation needs a General Translation API key\.\n.*--project-id prj_shared/s,
    );
  },
);

test("an explicit GT provider fails without credentials outside an interactive terminal", async () => {
  const { dir, projectPath } = projectIn({}, "bob's app");
  await expect(
    resolve({ projectPath, env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "gt" } }),
  ).rejects.toThrowError(
    new MachineTranslateError(
      [
        "Machine translation needs a General Translation API key.",
        "- In a terminal: run this command directly to sign in. It can't ask through a task runner that captures its output, with CI set, or on Linux without a display.",
        "- CI: set GT_API_KEY and GT_PROJECT_ID from your project at https://dash.generaltranslation.com.",
        `- Agents: have the user sign in with \`npx --yes gt@2.28.3 login --no-browser\`, then run \`(d=$(mktemp -d) && cd "$d" && npx --yes gt@2.28.3 init --json --no-react-setup --dev-credentials --default-locale en --locales de --file-patterns 'json=./messages/[locale].json' --create-project --project-name 'bob'\\''s app' && { echo; cat .env.local; } >> '${nodePath.dirname(dir)}/bob'\\''s app/.env.local')\` to save a development key to .env.local, check that git ignores .env.local, and run this command again.`,
        "- Or use the community-operated service: set INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco.",
        `- Or bring your own key: ${BYOK_URL}`,
      ].join("\n"),
    ),
  );
  expect(npxCalls()).toEqual([]);
});

test("the gt init command for agents keeps a known project and saves the key next to a relative project.inlang", async () => {
  const { dir } = projectIn();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await expect(
      resolve({
        env: {
          INLANG_MACHINE_TRANSLATE_PROVIDER: "gt",
          GT_PROJECT_ID: "prj_known",
        },
        projectPath: "./project.inlang",
      }),
    ).rejects.toThrow(
      `then run \`(d=$(mktemp -d) && cd "$d" && npx --yes gt@2.28.3 init --json --no-react-setup --dev-credentials --default-locale en --locales de --file-patterns 'json=./messages/[locale].json' --project-id prj_known && { echo; cat .env.local; } >> ${process.cwd()}/.env.local)\` to save`,
    );
  } finally {
    process.chdir(cwd);
  }
});

test("answering no uses the community service and saves the choice", async () => {
  vi.spyOn(log, "log").mockImplementation(() => undefined);
  vi.spyOn(log, "prompt").mockResolvedValue(false);
  const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
  const { dir, projectPath } = projectIn({ ".env.local": "OTHER=1\n" });
  const provider = await resolve({ projectPath, interactive: true });
  expect(warn.mock.calls).toEqual([[COMMUNITY_WARNING]]);
  expect((await firstRequest(provider)).url).toMatch(
    /^https:\/\/translate\.demosjarco\.dev\//,
  );
  expect(fs.readFileSync(nodePath.join(dir, ".env.local"), "utf8")).toBe(
    "OTHER=1\nINLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco\n",
  );
  // Outside a git work tree, so the rule is added.
  expect(info.mock.calls).toEqual([
    [
      "Saved your choice to .env.local. To be asked again, remove INLANG_MACHINE_TRANSLATE_PROVIDER from it.\nAdded .env.local to .gitignore.",
    ],
  ]);
});

test("uses the choice saved in .env.local without asking, and says where it is", async () => {
  const prompt = vi.spyOn(log, "prompt");
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
  const provider = await resolve({
    projectPath: projectIn({
      ".env.local": "INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco\n",
    }).projectPath,
    interactive: true,
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(npxCalls()).toEqual([]);
  expect(info.mock.calls).toEqual([
    [
      "You chose this service in .env.local. To be asked about General Translation again, remove INLANG_MACHINE_TRANSLATE_PROVIDER from it.",
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

test("shares no project ID that only the environment has", async () => {
  const { dir } = projectIn();
  await resolve({
    env: { GT_API_KEY: "gt-env-key", GT_PROJECT_ID: "prj_env" },
    projectPath: nodePath.join(dir, "project.inlang"),
  });
  expect(fs.existsSync(nodePath.join(dir, "gt.config.json"))).toBe(false);
});

test("a failed sign-in is a MachineTranslateError, which prints without a stack trace", async () => {
  vi.spyOn(log, "log").mockImplementation(() => undefined);
  vi.spyOn(log, "prompt").mockResolvedValue(true);
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

test("uses the community service when it is selected, and warns", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const provider = await resolve({
    env: { INLANG_MACHINE_TRANSLATE_PROVIDER: "demosjarco" },
  });
  expect(warn.mock.calls).toEqual([[COMMUNITY_WARNING]]);
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
