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
    ["Machine translation is powered by General Translation. Sign up for free"],
  ]);
  // consola otherwise resolves a cancelled confirm with `initial`, a yes.
  expect(prompt.mock.calls).toEqual([
    [
      "Use General Translation for this project?",
      { type: "confirm", initial: true, cancel: "undefined" },
    ],
  ]);
  expect(signIn).toHaveBeenCalledWith({ dir, settings, env });
  expect((await firstRequest(provider)).headers).toMatchObject({
    Authorization: "Bearer gt-signed-in-key",
    "gt-project-id": "prj_new",
  });
});

// Windows needs an npx.cmd.
test.skipIf(process.platform === "win32")(
  "doesn't ask a user who is signed in to gt to sign up",
  async () => {
    const calls = fakeNpx(0);
    const notice = vi.spyOn(log, "log").mockImplementation(() => undefined);
    vi.spyOn(log, "prompt").mockResolvedValue(undefined as never);
    await resolve({ interactive: true }).catch(() => undefined);
    expect(calls()).toEqual(["--yes gt@2.28.3 whoami"]);
    expect(notice.mock.calls).toEqual([
      ["Machine translation is powered by General Translation."],
    ]);
  },
);

test("counts gt as signed out when npx can't be started", async () => {
  vi.stubEnv("PATH", nodePath.join(projectIn().dir, "no-npx"));
  const notice = vi.spyOn(log, "log").mockImplementation(() => undefined);
  vi.spyOn(log, "prompt").mockResolvedValue(undefined as never);
  await resolve({ interactive: true }).catch(() => undefined);
  expect(notice.mock.calls).toEqual([
    ["Machine translation is powered by General Translation. Sign up for free"],
  ]);
});

test("fails fast without credentials outside an interactive terminal", async () => {
  const { dir, projectPath } = projectIn({}, "bob's app");
  await expect(resolve({ projectPath })).rejects.toThrowError(
    new MachineTranslateError(
      [
        "Machine translation needs a General Translation API key.",
        "- CI: set GT_API_KEY and GT_PROJECT_ID from your project at https://dash.generaltranslation.com.",
        `- Agents: have the user sign in with \`npx --yes gt@2.28.3 login --no-browser\`, then run \`(d=$(mktemp -d) && cd "$d" && npx --yes gt@2.28.3 init --json --no-react-setup --dev-credentials --default-locale en --locales de --file-patterns 'json=./messages/[locale].json' --create-project --project-name 'bob'\\''s app' && { echo; cat .env.local; } >> '${nodePath.dirname(dir)}/bob'\\''s app/.env.local')\` to save a development key to .env.local, check that git ignores .env.local, and run this command again.`,
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
        env: { GT_PROJECT_ID: "prj_known" },
        projectPath: "./project.inlang",
      }),
    ).rejects.toThrow(
      `then run \`(d=$(mktemp -d) && cd "$d" && npx --yes gt@2.28.3 init --json --no-react-setup --dev-credentials --default-locale en --locales de --file-patterns 'json=./messages/[locale].json' --project-id prj_known && { echo; cat .env.local; } >> ${process.cwd()}/.env.local)\` to save`,
    );
  } finally {
    process.chdir(cwd);
  }
});

test("answering no uses the community service", async () => {
  vi.spyOn(log, "log").mockImplementation(() => undefined);
  vi.spyOn(log, "prompt").mockResolvedValue(false);
  const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const provider = await resolve({ interactive: true });
  expect(warn.mock.calls).toEqual([[COMMUNITY_WARNING]]);
  expect((await firstRequest(provider)).url).toMatch(
    /^https:\/\/translate\.demosjarco\.dev\//,
  );
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
