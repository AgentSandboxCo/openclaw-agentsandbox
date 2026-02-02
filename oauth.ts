import http from "node:http";
import crypto from "node:crypto";

const BASE_URL =
  "https://agent-sandbox-api-870094711355.us-central1.run.app";
const CLIENT_ID = "openclaw-plugin-client";
const CALLBACK_PORT = 51199;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

export async function runOAuthFlow(opts: {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  prompt: (msg: string) => Promise<string>;
}) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  const authUrl =
    `${BASE_URL}/oauth/authorize?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "sandbox",
    });

  if (opts.isRemote) {
    const input = await opts.prompt(
      `Open this URL and paste the redirect URL (or code):\n${authUrl}`,
    );
    const parsed = parseCallbackInput(input);
    if (parsed.state && parsed.state !== state) {
      throw new Error("OAuth state mismatch");
    }
    return exchangeCode(parsed.code, verifier);
  }

  try {
    const parsed = await listenForCallback(authUrl, opts.openUrl);
    if (parsed.state && parsed.state !== state) {
      throw new Error("OAuth state mismatch");
    }
    return exchangeCode(parsed.code, verifier);
  } catch {
    const input = await opts.prompt(
      `Local callback failed. Paste the redirect URL (or code):\n${authUrl}`,
    );
    const parsed = parseCallbackInput(input);
    if (parsed.state && parsed.state !== state) {
      throw new Error("OAuth state mismatch");
    }
    return exchangeCode(parsed.code, verifier);
  }
}

async function listenForCallback(
  authUrl: string,
  openUrl: (url: string) => Promise<void>,
): Promise<{ code: string; state?: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? undefined;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Authorized. You can close this tab.</h1>");
      server.close();
      code
        ? resolve({ code, state })
        : reject(new Error("No code in callback"));
    });
    server.listen(CALLBACK_PORT, () => {
      void openUrl(authUrl);
    });
  });
}

function parseCallbackInput(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    if (!code) {
      throw new Error("Missing code parameter");
    }
    return { code, state };
  } catch {
    return { code: trimmed };
  }
}

async function exchangeCode(code: string, verifier: string) {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresAt: Date.now() + (data.expires_in as number) * 1000,
    email: data.email as string | undefined,
    apiKey: (data.api_key as string | null) ?? null,
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresAt: Date.now() + (data.expires_in as number) * 1000,
  };
}
