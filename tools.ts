import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { refreshAccessToken } from "./oauth.js";

const BASE_URL =
  "https://api.agentsandbox.co";

const MAX_OUTPUT_CHARS = 50_000;

type ToolCtx = {
  config?: OpenClawConfig;
  agentDir?: string;
};

async function getToken(ctx: ToolCtx): Promise<string> {
  // 0. Check env var (declared in provider's envVars)
  const envKey = process.env.SANDBOX_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  const profileId = Object.entries(ctx.config?.auth?.profiles ?? {}).find(
    ([, profile]) => profile?.provider === "agentsandbox",
  )?.[0];

  if (!profileId) {
    throw new Error(
      "No auth profile for agentsandbox. Tell the user to run `openclaw models auth login --provider agentsandbox` in their terminal, or set the SANDBOX_API_KEY environment variable. Do NOT attempt the OAuth flow in this conversation — it requires a separate CLI command.",
    );
  }
  if (!ctx.agentDir) {
    throw new Error("agentDir missing; tool must run in an agent context.");
  }

  const authPath = path.join(ctx.agentDir, "auth-profiles.json");
  const store = JSON.parse(await fs.readFile(authPath, "utf8")) as {
    profiles?: Record<
      string,
      {
        type?: string;
        access?: string;
        refresh?: string;
        expires?: number;
        key?: string;
        email?: string;
        provider?: string;
      }
    >;
  };

  const cred = store.profiles?.[profileId];
  if (!cred) {
    throw new Error(
      `Missing credential for profile ${profileId}. Tell the user to run \`openclaw models auth login --provider agentsandbox\` in their terminal to re-authenticate. Do NOT attempt the OAuth flow in this conversation.`,
    );
  }

  // 1. Prefer permanent API key
  if (cred.key) {
    return cred.key;
  }

  // 2. Use access token if not expired (5-minute buffer)
  const bufferMs = 5 * 60 * 1000;
  if (cred.access && cred.expires && Date.now() < cred.expires - bufferMs) {
    return cred.access;
  }

  // 3. Refresh token
  if (cred.refresh) {
    const refreshed = await refreshAccessToken(cred.refresh);
    // Write rotated tokens back to credential store
    cred.access = refreshed.accessToken;
    cred.refresh = refreshed.refreshToken;
    cred.expires = refreshed.expiresAt;
    await fs.writeFile(authPath, JSON.stringify(store, null, 2), "utf8");
    return refreshed.accessToken;
  }

  throw new Error(
    "All tokens expired and no refresh token available. Tell the user to run `openclaw models auth login --provider agentsandbox` in their terminal to re-authenticate. Do NOT attempt the OAuth flow in this conversation.",
  );
}

async function apiRequest(
  method: string,
  endpoint: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, init);
  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${method} ${endpoint} failed (${res.status}): ${errText}`);
  }

  // Handle empty responses (e.g. 204 No Content)
  if (res.status === 204) return {};

  if (contentType.includes("application/json")) {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  return res.text();
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n... [truncated — ${text.length} chars total]`
  );
}

async function apiUploadFile(
  endpoint: string,
  token: string,
  fileData: string, // base64 encoded
  filename: string,
): Promise<unknown> {
  // Validate base64 format
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(fileData)) {
    throw new Error("Invalid base64 encoding in file_data");
  }

  const buffer = Buffer.from(fileData, "base64");
  const blob = new Blob([buffer]);

  const formData = new FormData();
  formData.append("file", blob, filename);

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      // Do NOT set Content-Type — fetch sets it with boundary automatically
    },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API POST ${endpoint} failed (${res.status}): ${errText}`);
  }

  // Handle empty responses (e.g. 204 No Content)
  if (res.status === 204) return {};

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  return res.text();
}

export function createTools(ctx: ToolCtx) {
  return [
    // ── sandbox_execute ──────────────────────────────────────────
    {
      name: "sandbox_execute",
      label: "Execute Code in Sandbox",
      description:
        "Execute Python or Bash code in a sandboxed environment. Returns stdout, stderr, return code, and any output files.",
      parameters: Type.Object({
        language: Type.Unsafe<"python" | "bash">({
          type: "string",
          enum: ["python", "bash"],
          description: "Language to execute",
        }),
        code: Type.String({ description: "Code to run" }),
        session_id: Type.Optional(
          Type.String({
            description:
              "Reuse a persistent session. Omit for a one-shot sandbox.",
          }),
        ),
        env_vars: Type.Optional(
          Type.Unsafe<Record<string, string>>({
            type: "object",
            description: "Environment variables to inject",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: {
          language: "python" | "bash";
          code: string;
          session_id?: string;
          env_vars?: Record<string, string>;
        },
      ) {
        const token = await getToken(ctx);
        const body: Record<string, unknown> = {
          language: params.language,
          code: params.code,
        };
        if (params.session_id) body.session_id = params.session_id;
        if (params.env_vars) body.env_vars = params.env_vars;

        const data = (await apiRequest("POST", "/v1/execute", token, body)) as {
          session_id?: string;
          stdout?: string;
          stderr?: string;
          return_code?: number;
          files?: { file_id: string; filename: string }[];
        };

        const parts: string[] = [];
        if (data.stdout) parts.push(`stdout:\n${data.stdout}`);
        if (data.stderr) parts.push(`stderr:\n${data.stderr}`);
        parts.push(`return_code: ${data.return_code ?? "unknown"}`);
        if (data.session_id) parts.push(`session_id: ${data.session_id}`);
        if (data.files?.length) {
          parts.push(
            `files:\n${data.files.map((f) => `  ${f.filename} (${f.file_id})`).join("\n")}`,
          );
        }

        return {
          content: [{ type: "text" as const, text: truncate(parts.join("\n\n")) }],
          details: {
            ok: data.return_code === 0,
            language: params.language,
            return_code: data.return_code,
            session_id: data.session_id,
            files: data.files,
          },
        };
      },
    },

    // ── sandbox_create_session ───────────────────────────────────
    {
      name: "sandbox_create_session",
      label: "Create Sandbox Session",
      description:
        "Create a persistent sandbox session. Use the returned session_id with sandbox_execute to preserve filesystem state and installed packages across executions.",
      parameters: Type.Object({
        env_vars: Type.Optional(
          Type.Unsafe<Record<string, string>>({
            type: "object",
            description: "Environment variables to inject into the session",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { env_vars?: Record<string, string> },
      ) {
        const token = await getToken(ctx);
        const body: Record<string, unknown> = {};
        if (params.env_vars) body.env_vars = params.env_vars;

        const data = await apiRequest("POST", "/v1/sessions", token, body);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
          details: { ok: true, ...(data as object) },
        };
      },
    },

    // ── sandbox_list_sessions ────────────────────────────────────
    {
      name: "sandbox_list_sessions",
      label: "List Sandbox Sessions",
      description: "List all active sandbox sessions.",
      parameters: Type.Object({}),
      async execute() {
        const token = await getToken(ctx);
        const data = await apiRequest("GET", "/v1/sessions", token);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
          details: { ok: true, ...(data as object) },
        };
      },
    },

    // ── sandbox_destroy_session ──────────────────────────────────
    {
      name: "sandbox_destroy_session",
      label: "Destroy Sandbox Session",
      description:
        "Destroy a sandbox session and terminate its sandbox. The session_id will no longer be usable.",
      parameters: Type.Object({
        session_id: Type.String({
          description: "ID of the session to destroy",
        }),
      }),
      async execute(_id: string, params: { session_id: string }) {
        const token = await getToken(ctx);
        const endpoint = `/v1/sessions/${encodeURIComponent(params.session_id)}`;
        const maxAttempts = 3;
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const data = await apiRequest("DELETE", endpoint, token);
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(data, null, 2) },
              ],
              details: { ok: true, session_id: params.session_id, ...(data as object) },
            };
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            // 404 means the session is already gone — treat as success
            if (lastError.message.includes("(404)")) {
              return {
                content: [
                  { type: "text" as const, text: "Session destroyed (already absent)." },
                ],
                details: { ok: true, session_id: params.session_id, already_gone: true },
              };
            }

            // Only retry on transient errors (5xx, 429, network/parse issues)
            const statusMatch = lastError.message.match(/\((\d{3})\)/);
            const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            const isRetryable = status >= 500 || status === 429 || !statusMatch;
            if (!isRetryable || attempt === maxAttempts) throw lastError;

            await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
          }
        }
        throw lastError;
      },
    },

    // ── sandbox_download_file ────────────────────────────────────
    {
      name: "sandbox_download_file",
      label: "Download Sandbox File",
      description:
        "Download an output file produced by a sandbox execution. Use the file_id from the sandbox_execute response.",
      parameters: Type.Object({
        file_id: Type.String({
          description: "ID of the file to download",
        }),
      }),
      async execute(_id: string, params: { file_id: string }) {
        const token = await getToken(ctx);
        const data = await apiRequest(
          "GET",
          `/v1/files/${encodeURIComponent(params.file_id)}`,
          token,
        );
        const text =
          typeof data === "string" ? data : JSON.stringify(data, null, 2);
        return {
          content: [{ type: "text" as const, text: truncate(text) }],
          details: { ok: true, file_id: params.file_id },
        };
      },
    },

    // ── sandbox_get_session ─────────────────────────────────────
    {
      name: "sandbox_get_session",
      label: "Get Sandbox Session",
      description:
        "Get details of a specific sandbox session by its ID.",
      parameters: Type.Object({
        session_id: Type.String({
          description: "ID of the session to retrieve",
        }),
      }),
      async execute(_id: string, params: { session_id: string }) {
        const token = await getToken(ctx);
        const data = await apiRequest(
          "GET",
          `/v1/sessions/${encodeURIComponent(params.session_id)}`,
          token,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
          details: { ok: true, session_id: params.session_id, ...(data as object) },
        };
      },
    },

    // ── sandbox_list_files ──────────────────────────────────────
    {
      name: "sandbox_list_files",
      label: "List Sandbox Files",
      description:
        "List files owned by the authenticated user.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Maximum number of files to return (1-100, default 50)",
            minimum: 1,
            maximum: 100,
          }),
        ),
        offset: Type.Optional(
          Type.Number({
            description: "Number of files to skip (default 0)",
            minimum: 0,
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { limit?: number; offset?: number },
      ) {
        const token = await getToken(ctx);
        const queryParams = new URLSearchParams();
        if (params.limit !== undefined) {
          queryParams.set("limit", String(params.limit));
        }
        if (params.offset !== undefined) {
          queryParams.set("offset", String(params.offset));
        }
        const queryString = queryParams.toString();
        const endpoint = `/v1/files${queryString ? `?${queryString}` : ""}`;

        const data = await apiRequest("GET", endpoint, token);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
          details: { ok: true, ...(data as object) },
        };
      },
    },

    // ── sandbox_upload_file ─────────────────────────────────────
    {
      name: "sandbox_upload_file",
      label: "Upload File to Sandbox",
      description:
        "Upload a file to the sandbox. Optionally inject it into a specific session.",
      parameters: Type.Object({
        file_data: Type.String({
          description: "Base64-encoded file content",
        }),
        filename: Type.String({
          description: "Name of the file to upload",
        }),
        session_id: Type.Optional(
          Type.String({
            description: "Session ID to inject the file into",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { file_data: string; filename: string; session_id?: string },
      ) {
        const token = await getToken(ctx);
        const queryParams = new URLSearchParams();
        if (params.session_id) {
          queryParams.set("session_id", params.session_id);
        }
        const queryString = queryParams.toString();
        const endpoint = `/v1/files${queryString ? `?${queryString}` : ""}`;

        const data = await apiUploadFile(
          endpoint,
          token,
          params.file_data,
          params.filename,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
          details: { ok: true, filename: params.filename, ...(data as object) },
        };
      },
    },

    // ── sandbox_delete_file ─────────────────────────────────────
    {
      name: "sandbox_delete_file",
      label: "Delete Sandbox File",
      description:
        "Delete a file from the sandbox by its ID.",
      parameters: Type.Object({
        file_id: Type.String({
          description: "ID of the file to delete",
        }),
      }),
      async execute(_id: string, params: { file_id: string }) {
        const token = await getToken(ctx);
        const endpoint = `/v1/files/${encodeURIComponent(params.file_id)}`;
        const maxAttempts = 3;
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const data = await apiRequest("DELETE", endpoint, token);
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(data, null, 2) },
              ],
              details: { ok: true, file_id: params.file_id, ...(data as object) },
            };
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            // 404 means the file is already gone — treat as success
            if (lastError.message.includes("(404)")) {
              return {
                content: [
                  { type: "text" as const, text: "File deleted (already absent)." },
                ],
                details: { ok: true, file_id: params.file_id, already_gone: true },
              };
            }

            // Only retry on transient errors (5xx, 429, network/parse issues)
            const statusMatch = lastError.message.match(/\((\d{3})\)/);
            const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            const isRetryable = status >= 500 || status === 429 || !statusMatch;
            if (!isRetryable || attempt === maxAttempts) throw lastError;

            await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
          }
        }
        throw lastError;
      },
    },

    // ── sandbox_get_execution ───────────────────────────────────
    {
      name: "sandbox_get_execution",
      label: "Get Execution Details",
      description:
        "Get details of a specific code execution including the code that was run and its output.",
      parameters: Type.Object({
        execution_id: Type.String({
          description: "UUID of the execution to retrieve",
        }),
      }),
      async execute(_id: string, params: { execution_id: string }) {
        const token = await getToken(ctx);
        const data = (await apiRequest(
          "GET",
          `/v1/executions/${encodeURIComponent(params.execution_id)}`,
          token,
        )) as {
          execution_id?: string;
          stdout?: string;
          stderr?: string;
          return_code?: number;
          status?: string;
        };

        const parts: string[] = [];
        if (data.status) parts.push(`status: ${data.status}`);
        if (data.stdout) parts.push(`stdout:\n${data.stdout}`);
        if (data.stderr) parts.push(`stderr:\n${data.stderr}`);
        if (data.return_code !== undefined) {
          parts.push(`return_code: ${data.return_code}`);
        }

        return {
          content: [{ type: "text" as const, text: truncate(parts.join("\n\n")) }],
          details: {
            ok: true,
            execution_id: params.execution_id,
            ...data,
          },
        };
      },
    },
  ];
}
