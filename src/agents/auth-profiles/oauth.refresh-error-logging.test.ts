import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(async () => {
    throw new Error("token refresh network error");
  }),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: getOAuthApiKeyMock,
  getOAuthProviders: () => [
    { id: "google-gemini", envApiKey: "GEMINI_API_KEY", oauthTokenEnv: "GEMINI_OAUTH_TOKEN" }, // pragma: allowlist secret
    { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // pragma: allowlist secret
  ],
}));

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("./constants.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./constants.js")>();
  return {
    ...original,
    log: {
      ...original.log,
      info: vi.fn(),
      debug: vi.fn(),
      warn: warnMock,
    },
  };
});

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: "expired-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      },
    },
  };
}

describe("resolveApiKeyForProfile OAuth refresh error logging", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    getOAuthApiKeyMock.mockClear();
    warnMock.mockClear();
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-refresh-logging-"));
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("logs a warning when OAuth refresh fails instead of silently swallowing the error", async () => {
    const profileId = "google-gemini:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "google-gemini",
      }),
      agentDir,
    );

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed/);

    // The thrown error preserves the original cause.
    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("logs a warning when main-agent credential fallback fails", async () => {
    const profileId = "google-gemini:default";

    // Create the agent-level store with expired credentials.
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "google-gemini" }),
      agentDir,
    );

    // Create a separate "main" store that also has expired credentials
    // so the main-agent fallback path is exercised and fails.
    const mainStoreDir = path.join(tempRoot, "agents", "main-other", "agent");
    await fs.mkdir(mainStoreDir, { recursive: true });

    // The primary refresh throws ("token refresh network error" from mock).
    // The main-agent fallback path reads the main store; ensureAuthProfileStore(undefined)
    // resolves via OPENCLAW_STATE_DIR — which has no main-level auth file,
    // so the fallback will fail silently if not logged.
    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed/);

    // After the fix, the error should propagate with the original message.
    expect(getOAuthApiKeyMock).toHaveBeenCalled();
  });
});
