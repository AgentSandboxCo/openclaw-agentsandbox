import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTools } from "./tools.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal ToolCtx with env-var auth (simplest path). */
function ctxWithEnvKey(key = "test-api-key") {
  vi.stubEnv("SANDBOX_API_KEY", key);
  return { config: undefined, agentDir: undefined };
}

/** Build a ToolCtx that uses the credential-store path. */
function ctxWithProfile(overrides: {
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}) {
  vi.stubEnv("SANDBOX_API_KEY", "");

  const profileId = "agentsandbox:user@test.com";
  const config = {
    auth: {
      profiles: {
        [profileId]: { provider: "agentsandbox" },
      },
    },
  };

  // Write a temporary auth-profiles.json that getToken will read
  const store = {
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "agentsandbox",
        ...overrides,
      },
    },
  };

  const fs = vi.hoisted(() => ({
    readFile: vi.fn(),
    writeFile: vi.fn(),
  }));

  return { config, store, profileId, fs };
}

function mockFetchResponse(body: unknown, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: vi.fn().mockResolvedValue(
      typeof body === "string" ? body : JSON.stringify(body),
    ),
    json: vi.fn().mockResolvedValue(body),
  };
}

// ─── Mock node:fs/promises ──────────────────────────────────────────────────

const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: mockReadFile, writeFile: mockWriteFile },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

// ─── Mock oauth refresh ─────────────────────────────────────────────────────

const { mockRefreshAccessToken } = vi.hoisted(() => ({
  mockRefreshAccessToken: vi.fn(),
}));

vi.mock("./oauth.js", () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createTools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("SANDBOX_API_KEY", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns all 5 tools with correct names", () => {
    const tools = createTools({});
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "sandbox_execute",
      "sandbox_create_session",
      "sandbox_list_sessions",
      "sandbox_destroy_session",
      "sandbox_download_file",
    ]);
  });

  // ── getToken ────────────────────────────────────────────────────────────

  describe("getToken (via tool execute)", () => {
    it("uses SANDBOX_API_KEY env var when set", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "env-key-123");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ stdout: "hi", return_code: 0 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      await exec.execute("id", { language: "python", code: "print(1)" });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer env-key-123");
    });

    it("throws when no auth profile and no env key", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "");
      const tools = createTools({ config: undefined });
      const exec = tools.find((t) => t.name === "sandbox_list_sessions")!;

      await expect(exec.execute()).rejects.toThrow("No auth profile");
    });

    it("throws when agentDir is missing", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "");
      const config = {
        auth: {
          profiles: {
            "agentsandbox:user@test.com": { provider: "agentsandbox" },
          },
        },
      } as any;

      const tools = createTools({ config, agentDir: undefined });
      const exec = tools.find((t) => t.name === "sandbox_list_sessions")!;

      await expect(exec.execute()).rejects.toThrow("agentDir missing");
    });

    it("uses permanent API key from credential store", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "");
      const store = {
        profiles: {
          "agentsandbox:user@test.com": {
            type: "oauth",
            provider: "agentsandbox",
            key: "permanent-key-456",
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(store));

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse([]),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({
        config: {
          auth: {
            profiles: {
              "agentsandbox:user@test.com": { provider: "agentsandbox" },
            },
          },
        } as any,
        agentDir: "/tmp/agent",
      });
      const exec = tools.find((t) => t.name === "sandbox_list_sessions")!;
      await exec.execute();

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer permanent-key-456");
    });

    it("uses access token when not expired", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "");
      const store = {
        profiles: {
          "agentsandbox:user@test.com": {
            type: "oauth",
            provider: "agentsandbox",
            access: "access-token-789",
            expires: Date.now() + 60 * 60 * 1000, // 1 hour from now
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(store));

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({
        config: {
          auth: {
            profiles: {
              "agentsandbox:user@test.com": { provider: "agentsandbox" },
            },
          },
        } as any,
        agentDir: "/tmp/agent",
      });
      const exec = tools.find((t) => t.name === "sandbox_list_sessions")!;
      await exec.execute();

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer access-token-789");
    });

    it("refreshes token when access token is expired", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "");
      const store = {
        profiles: {
          "agentsandbox:user@test.com": {
            type: "oauth",
            provider: "agentsandbox",
            access: "old-access",
            refresh: "refresh-token-abc",
            expires: Date.now() - 1000, // already expired
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(store));
      mockWriteFile.mockResolvedValue(undefined);
      mockRefreshAccessToken.mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: Date.now() + 3600000,
      });

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({
        config: {
          auth: {
            profiles: {
              "agentsandbox:user@test.com": { provider: "agentsandbox" },
            },
          },
        } as any,
        agentDir: "/tmp/agent",
      });
      const exec = tools.find((t) => t.name === "sandbox_list_sessions")!;
      await exec.execute();

      expect(mockRefreshAccessToken).toHaveBeenCalledWith("refresh-token-abc");
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer new-access-token");
    });

    it("throws when all tokens expired and no refresh token", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "");
      const store = {
        profiles: {
          "agentsandbox:user@test.com": {
            type: "oauth",
            provider: "agentsandbox",
            access: "old-access",
            expires: Date.now() - 1000,
            // no refresh token
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(store));

      const tools = createTools({
        config: {
          auth: {
            profiles: {
              "agentsandbox:user@test.com": { provider: "agentsandbox" },
            },
          },
        } as any,
        agentDir: "/tmp/agent",
      });
      const exec = tools.find((t) => t.name === "sandbox_list_sessions")!;

      await expect(exec.execute()).rejects.toThrow("All tokens expired");
    });
  });

  // ── apiRequest (tested through tools) ───────────────────────────────────

  describe("apiRequest (via tool execute)", () => {
    it("throws on non-OK response", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue("Internal Server Error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_list_sessions")!;

      await expect(exec.execute()).rejects.toThrow(
        "API GET /v1/sessions failed (500)",
      );
    });

    it("handles 204 No Content", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers({ "content-type": "application/json" }),
        text: vi.fn().mockResolvedValue(""),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;
      const result = await destroy.execute("id", { session_id: "s1" });

      expect(result.details.ok).toBe(true);
    });

    it("handles empty JSON body with 200", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: vi.fn().mockResolvedValue(""),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const list = tools.find((t) => t.name === "sandbox_list_sessions")!;
      const result = await list.execute();

      // Should not throw — returns {} for empty JSON body
      expect(result.details.ok).toBe(true);
    });
  });

  // ── truncate ────────────────────────────────────────────────────────────

  describe("truncate (via sandbox_execute)", () => {
    it("does not truncate output under the limit", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const stdout = "a".repeat(100);
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ stdout, stderr: "", return_code: 0 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      const result = await exec.execute("id", {
        language: "python",
        code: "print('a'*100)",
      });

      expect(result.content[0].text).toContain(stdout);
      expect(result.content[0].text).not.toContain("truncated");
    });

    it("truncates output over 50,000 chars", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const stdout = "x".repeat(60_000);
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ stdout, stderr: "", return_code: 0 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      const result = await exec.execute("id", {
        language: "python",
        code: "print('x'*60000)",
      });

      expect(result.content[0].text).toContain("truncated");
    });
  });

  // ── sandbox_execute ─────────────────────────────────────────────────────

  describe("sandbox_execute", () => {
    it("sends correct request body for python execution", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          stdout: "hello\n",
          stderr: "",
          return_code: 0,
          session_id: "sess-1",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      await exec.execute("id", { language: "python", code: "print('hello')" });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.agentsandbox.co/v1/execute");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        language: "python",
        code: "print('hello')",
      });
    });

    it("includes session_id and env_vars when provided", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ stdout: "", stderr: "", return_code: 0 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      await exec.execute("id", {
        language: "bash",
        code: "echo $FOO",
        session_id: "s1",
        env_vars: { FOO: "bar" },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.session_id).toBe("s1");
      expect(body.env_vars).toEqual({ FOO: "bar" });
    });

    it("returns structured result with stdout, stderr, return_code", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          stdout: "output\n",
          stderr: "warning\n",
          return_code: 0,
          session_id: "s1",
          files: [{ file_id: "f1", filename: "result.csv" }],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      const result = await exec.execute("id", {
        language: "python",
        code: "pass",
      });

      expect(result.content[0].text).toContain("stdout:\noutput\n");
      expect(result.content[0].text).toContain("stderr:\nwarning\n");
      expect(result.content[0].text).toContain("return_code: 0");
      expect(result.content[0].text).toContain("session_id: s1");
      expect(result.content[0].text).toContain("result.csv (f1)");
      expect(result.details).toEqual({
        ok: true,
        language: "python",
        return_code: 0,
        session_id: "s1",
        files: [{ file_id: "f1", filename: "result.csv" }],
      });
    });

    it("sets details.ok to false when return_code is non-zero", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ stdout: "", stderr: "error", return_code: 1 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      const result = await exec.execute("id", {
        language: "python",
        code: "exit(1)",
      });

      expect(result.details.ok).toBe(false);
      expect(result.details.return_code).toBe(1);
    });

    it("handles missing stdout/stderr gracefully", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ return_code: 0 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const exec = tools.find((t) => t.name === "sandbox_execute")!;
      const result = await exec.execute("id", {
        language: "bash",
        code: "true",
      });

      expect(result.content[0].text).toContain("return_code: 0");
      expect(result.content[0].text).not.toContain("stdout:");
      expect(result.content[0].text).not.toContain("stderr:");
    });
  });

  // ── sandbox_create_session ──────────────────────────────────────────────

  describe("sandbox_create_session", () => {
    it("creates a session without env_vars", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const responseData = { session_id: "new-sess", status: "active" };
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse(responseData),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const create = tools.find((t) => t.name === "sandbox_create_session")!;
      const result = await create.execute("id", {});

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.agentsandbox.co/v1/sessions");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({});
      expect(result.details.ok).toBe(true);
      expect(result.details.session_id).toBe("new-sess");
    });

    it("passes env_vars when provided", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ session_id: "s2" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const create = tools.find((t) => t.name === "sandbox_create_session")!;
      await create.execute("id", { env_vars: { KEY: "val" } });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.env_vars).toEqual({ KEY: "val" });
    });
  });

  // ── sandbox_list_sessions ───────────────────────────────────────────────

  describe("sandbox_list_sessions", () => {
    it("returns session list", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const sessions = [
        { session_id: "s1", status: "active" },
        { session_id: "s2", status: "active" },
      ];
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse(sessions),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const list = tools.find((t) => t.name === "sandbox_list_sessions")!;
      const result = await list.execute();

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.agentsandbox.co/v1/sessions",
      );
      expect(fetchMock.mock.calls[0][1].method).toBe("GET");
      expect(result.details.ok).toBe(true);
      expect(result.content[0].text).toContain("s1");
      expect(result.content[0].text).toContain("s2");
    });
  });

  // ── sandbox_destroy_session ─────────────────────────────────────────────

  describe("sandbox_destroy_session", () => {
    it("destroys session successfully", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ status: "destroyed" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;
      const result = await destroy.execute("id", { session_id: "s1" });

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.agentsandbox.co/v1/sessions/s1",
      );
      expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
      expect(result.details.ok).toBe(true);
      expect(result.details.session_id).toBe("s1");
    });

    it("encodes session_id in URL", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ status: "destroyed" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;
      await destroy.execute("id", { session_id: "sess/with spaces" });

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.agentsandbox.co/v1/sessions/sess%2Fwith%20spaces",
      );
    });

    it("treats 404 as success (already gone)", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue("Not Found"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;
      const result = await destroy.execute("id", { session_id: "gone" });

      expect(result.details.ok).toBe(true);
      expect(result.details.already_gone).toBe(true);
      expect(result.content[0].text).toContain("already absent");
    });

    it("retries on 500 errors with exponential backoff", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");

      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers({ "content-type": "text/plain" }),
            text: vi.fn().mockResolvedValue("Server Error"),
          });
        }
        return Promise.resolve(
          mockFetchResponse({ status: "destroyed" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;
      const result = await destroy.execute("id", { session_id: "s1" });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.details.ok).toBe(true);
    });

    it("retries on 429 rate limit", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");

      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            headers: new Headers({ "content-type": "text/plain" }),
            text: vi.fn().mockResolvedValue("Rate limited"),
          });
        }
        return Promise.resolve(
          mockFetchResponse({ status: "destroyed" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;
      const result = await destroy.execute("id", { session_id: "s1" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.details.ok).toBe(true);
    });

    it("does not retry on 400 client error", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue("Bad Request"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;

      await expect(
        destroy.execute("id", { session_id: "s1" }),
      ).rejects.toThrow("(400)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry on 401 unauthorized", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue("Unauthorized"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;

      await expect(
        destroy.execute("id", { session_id: "s1" }),
      ).rejects.toThrow("(401)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws after max retries exhausted", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue("Bad Gateway"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const destroy = tools.find((t) => t.name === "sandbox_destroy_session")!;

      await expect(
        destroy.execute("id", { session_id: "s1" }),
      ).rejects.toThrow("(502)");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // ── sandbox_download_file ───────────────────────────────────────────────

  describe("sandbox_download_file", () => {
    it("downloads file and returns text content", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue("file content here"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const dl = tools.find((t) => t.name === "sandbox_download_file")!;
      const result = await dl.execute("id", { file_id: "f123" });

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.agentsandbox.co/v1/files/f123",
      );
      expect(result.content[0].text).toBe("file content here");
      expect(result.details).toEqual({ ok: true, file_id: "f123" });
    });

    it("downloads file and returns JSON content", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const jsonData = { data: [1, 2, 3] };
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse(jsonData),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const dl = tools.find((t) => t.name === "sandbox_download_file")!;
      const result = await dl.execute("id", { file_id: "f456" });

      expect(JSON.parse(result.content[0].text)).toEqual(jsonData);
    });

    it("encodes file_id in URL", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue("data"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const dl = tools.find((t) => t.name === "sandbox_download_file")!;
      await dl.execute("id", { file_id: "file/with spaces" });

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.agentsandbox.co/v1/files/file%2Fwith%20spaces",
      );
    });

    it("truncates large file content", async () => {
      vi.stubEnv("SANDBOX_API_KEY", "key");
      const largeContent = "y".repeat(60_000);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: vi.fn().mockResolvedValue(largeContent),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = createTools({});
      const dl = tools.find((t) => t.name === "sandbox_download_file")!;
      const result = await dl.execute("id", { file_id: "big" });

      expect(result.content[0].text).toContain("truncated");
      expect(result.content[0].text.length).toBeLessThan(largeContent.length);
    });
  });
});
