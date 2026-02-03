import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runOAuthFlow, refreshAccessToken } from "./oauth.js";

// ─── Mock crypto ────────────────────────────────────────────────────────────

vi.mock("node:crypto", () => {
  const verifierBytes = Buffer.from("a".repeat(32));
  const stateBytes = Buffer.from("b".repeat(16));
  let callCount = 0;

  return {
    default: {
      randomBytes: vi.fn((size: number) => {
        callCount++;
        // First call is verifier (32 bytes), second is state (16 bytes)
        return callCount % 2 === 1 ? verifierBytes : stateBytes;
      }),
      createHash: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        digest: vi.fn().mockReturnValue("mock-challenge"),
      })),
    },
  };
});

// ─── Mock http server ───────────────────────────────────────────────────────

vi.mock("node:http", () => ({
  default: {
    createServer: vi.fn(),
  },
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("oauth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── refreshAccessToken ────────────────────────────────────────────────

  describe("refreshAccessToken", () => {
    it("exchanges refresh token for new tokens", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const before = Date.now();
      const result = await refreshAccessToken("old-refresh");
      const after = Date.now();

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.agentsandbox.co/oauth/token");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe(
        "application/x-www-form-urlencoded",
      );

      // Verify the body params
      const body = new URLSearchParams(init.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");

      expect(result.accessToken).toBe("new-access");
      expect(result.refreshToken).toBe("new-refresh");
      expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600000);
      expect(result.expiresAt).toBeLessThanOrEqual(after + 3600000);
    });

    it("throws on failed refresh", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: vi.fn().mockResolvedValue("invalid_grant"),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(refreshAccessToken("bad-token")).rejects.toThrow(
        "Token refresh failed (401): invalid_grant",
      );
    });
  });

  // ── runOAuthFlow ──────────────────────────────────────────────────────

  describe("runOAuthFlow", () => {
    it("uses remote flow when isRemote is true", async () => {
      // Mock the token exchange
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          email: "user@test.com",
          api_key: "ak-1",
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi
        .fn()
        .mockResolvedValue("http://localhost:51199/callback?code=auth-code-123&state=" + Buffer.from("b".repeat(16)).toString("hex"));
      const openUrlMock = vi.fn();

      const result = await runOAuthFlow({
        isRemote: true,
        openUrl: openUrlMock,
        prompt: promptMock,
      });

      // Should have prompted the user
      expect(promptMock).toHaveBeenCalledOnce();
      expect(promptMock.mock.calls[0][0]).toContain("Open this URL");
      // Should NOT have tried to open URL in browser
      expect(openUrlMock).not.toHaveBeenCalled();

      expect(result.accessToken).toBe("at-1");
      expect(result.refreshToken).toBe("rt-1");
      expect(result.email).toBe("user@test.com");
      expect(result.apiKey).toBe("ak-1");
    });

    it("handles raw code input in remote flow", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "at-2",
          refresh_token: "rt-2",
          expires_in: 3600,
          email: null,
          api_key: null,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi.fn().mockResolvedValue("raw-code-456");

      const result = await runOAuthFlow({
        isRemote: true,
        openUrl: vi.fn(),
        prompt: promptMock,
      });

      // Should exchange the raw code
      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(body.get("code")).toBe("raw-code-456");

      expect(result.accessToken).toBe("at-2");
      expect(result.apiKey).toBeNull();
    });

    it("rejects on state mismatch in remote flow", async () => {
      const promptMock = vi
        .fn()
        .mockResolvedValue(
          "http://localhost:51199/callback?code=code&state=wrong-state",
        );

      await expect(
        runOAuthFlow({
          isRemote: true,
          openUrl: vi.fn(),
          prompt: promptMock,
        }),
      ).rejects.toThrow("OAuth state mismatch");
    });

    it("sends correct params in code exchange", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          email: "e@t.com",
          api_key: null,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi.fn().mockResolvedValue("the-code");

      await runOAuthFlow({
        isRemote: true,
        openUrl: vi.fn(),
        prompt: promptMock,
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.agentsandbox.co/oauth/token");
      expect(init.method).toBe("POST");

      const body = new URLSearchParams(init.body);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("redirect_uri")).toBe("http://localhost:51199/callback");
      expect(body.get("client_id")).toBe("openclaw-plugin-client");
      expect(body.get("code_verifier")).toBeTruthy();
    });

    it("throws on failed code exchange", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue("invalid_code"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi.fn().mockResolvedValue("bad-code");

      await expect(
        runOAuthFlow({
          isRemote: true,
          openUrl: vi.fn(),
          prompt: promptMock,
        }),
      ).rejects.toThrow("Token exchange failed (400): invalid_code");
    });

    it("falls back to prompt when local callback fails", async () => {
      // Mock http.createServer to simulate a failure
      const http = await import("node:http");
      (http.default.createServer as ReturnType<typeof vi.fn>).mockImplementation(
        () => ({
          listen: (_port: number, cb: () => void) => {
            // Don't call cb — just simulate server that never gets a request
          },
          close: vi.fn(),
        }),
      );

      // Actually, the local flow uses listenForCallback which creates a promise
      // that would hang. The implementation catches errors and falls back.
      // Let's test by making createServer throw
      (http.default.createServer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("EADDRINUSE");
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "at-fallback",
          refresh_token: "rt-fallback",
          expires_in: 3600,
          email: "fb@test.com",
          api_key: null,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi.fn().mockResolvedValue("fallback-code");

      const result = await runOAuthFlow({
        isRemote: false,
        openUrl: vi.fn(),
        prompt: promptMock,
      });

      // Should have fallen back to prompt
      expect(promptMock).toHaveBeenCalledOnce();
      expect(promptMock.mock.calls[0][0]).toContain("Local callback failed");
      expect(result.accessToken).toBe("at-fallback");
    });
  });

  // ── parseCallbackInput (tested through runOAuthFlow) ──────────────────

  describe("parseCallbackInput (via runOAuthFlow remote)", () => {
    it("parses a full URL with code and state", async () => {
      const state = Buffer.from("b".repeat(16)).toString("hex");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          email: null,
          api_key: null,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi
        .fn()
        .mockResolvedValue(
          `http://localhost:51199/callback?code=my-code&state=${state}`,
        );

      await runOAuthFlow({
        isRemote: true,
        openUrl: vi.fn(),
        prompt: promptMock,
      });

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(body.get("code")).toBe("my-code");
    });

    it("handles URL without state param", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          email: null,
          api_key: null,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi
        .fn()
        .mockResolvedValue("http://localhost:51199/callback?code=code-only");

      // No state in URL → no mismatch check → should succeed
      const result = await runOAuthFlow({
        isRemote: true,
        openUrl: vi.fn(),
        prompt: promptMock,
      });

      expect(result.accessToken).toBe("at");
    });

    it("treats plain text as raw code", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          email: null,
          api_key: null,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const promptMock = vi.fn().mockResolvedValue("  just-a-code  ");

      await runOAuthFlow({
        isRemote: true,
        openUrl: vi.fn(),
        prompt: promptMock,
      });

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(body.get("code")).toBe("just-a-code");
    });
  });
});
