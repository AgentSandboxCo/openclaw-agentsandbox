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
        "Execute Python or Bash code in a sandboxed environment. Returns stdout, stderr, return code, and any output files.\n\n" +
        "IMPORTANT: To save output files that are returned in the response, write them to the `/output` directory (e.g., `/output/result.png`). Files written elsewhere will not be captured.\n\n" +
        "If `file_ids` is provided, those files are copied to `/workspace` before execution and accessible at `/workspace/{filename}`.\n\n" +
        "Use `session_id` to run code in a persistent session where installed packages and filesystem changes persist across calls. Omit for stateless one-shot execution.\n\n" +
        "Common packages (numpy, pandas, matplotlib, requests, PIL, etc.) are pre-installed. Install additional packages with pip in your code.",
      parameters: Type.Object({
        language: Type.Unsafe<"python" | "bash">({
          type: "string",
          enum: ["python", "bash"],
          description: "Language to execute: 'python' for Python 3 code, 'bash' for shell commands",
        }),
        code: Type.String({ description: "The code to execute. For Python, this is run as a script. For Bash, commands are executed in a shell." }),
        session_id: Type.Optional(
          Type.String({
            description:
              "ID of a persistent session to run in (from sandbox_create_session). When provided, installed packages and filesystem changes persist. Omit for a one-shot sandbox that is destroyed after execution.",
          }),
        ),
        env_vars: Type.Optional(
          Type.Unsafe<Record<string, string>>({
            type: "object",
            description: "Environment variables to inject into the execution environment as key-value pairs (e.g., {\"API_KEY\": \"secret\"})",
          }),
        ),
        file_ids: Type.Optional(
          Type.Array(Type.String(), {
            description: "List of file IDs (from sandbox_upload_file or previous executions) to copy into /workspace before execution",
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
          file_ids?: string[];
        },
      ) {
        const token = await getToken(ctx);
        const body: Record<string, unknown> = {
          language: params.language,
          code: params.code,
        };
        if (params.session_id) body.session_id = params.session_id;
        if (params.env_vars) body.env_vars = params.env_vars;
        if (params.file_ids) body.file_ids = params.file_ids;

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
        "Create a persistent sandbox session. Use the returned session_id with sandbox_execute to preserve filesystem state and installed packages across executions.\n\n" +
        "Use sessions when you need to:\n" +
        "- Install packages once and run multiple scripts\n" +
        "- Build up state across multiple code executions\n" +
        "- Preserve files between runs\n\n" +
        "Sessions remain active until explicitly destroyed with sandbox_destroy_session. Destroy sessions when done to free resources.\n\n" +
        "For simple one-off executions, skip this and use sandbox_execute without a session_id instead.",
      parameters: Type.Object({
        env_vars: Type.Optional(
          Type.Unsafe<Record<string, string>>({
            type: "object",
            description: "Environment variables to inject into the session, available to all executions in this session (e.g., {\"API_KEY\": \"secret\"})",
          }),
        ),
        file_ids: Type.Optional(
          Type.Array(Type.String(), {
            description: "List of file IDs (from sandbox_upload_file) to copy into the session's /workspace directory when created",
          }),
        ),
      }),
      async execute(
        _id: string,
        params: { env_vars?: Record<string, string>; file_ids?: string[] },
      ) {
        const token = await getToken(ctx);
        const body: Record<string, unknown> = {};
        if (params.env_vars) body.env_vars = params.env_vars;
        if (params.file_ids) body.file_ids = params.file_ids;

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
      description:
        "List all active sandbox sessions owned by the authenticated user. Returns an array of session IDs.\n\n" +
        "Use this to find existing sessions you can reuse, or to check which sessions need to be cleaned up with sandbox_destroy_session.",
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
        "Destroy a sandbox session and terminate its underlying sandbox. The session_id will no longer be usable after this call.\n\n" +
        "Always destroy sessions when you're done with them to free resources. Any files written within the session (not to /output) will be lost.",
      parameters: Type.Object({
        session_id: Type.String({
          description: "ID of the session to destroy (from sandbox_create_session or sandbox_list_sessions)",
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

    // ── sandbox_inject_files ────────────────────────────────────
    {
      name: "sandbox_inject_files",
      label: "Inject Files into Session",
      description:
        "Copy previously uploaded files into a running session's /workspace directory. Files become accessible at `/workspace/{original_filename}` after injection.\n\n" +
        "Use this to add files to an existing session after it was created. For new sessions, prefer passing `file_ids` to sandbox_create_session instead.\n\n" +
        "Files must first be uploaded via sandbox_upload_file to get their file_ids.",
      parameters: Type.Object({
        session_id: Type.String({
          description: "ID of the running session to inject files into (from sandbox_create_session)",
        }),
        file_ids: Type.Array(Type.String(), {
          description: "List of file IDs to inject (from sandbox_upload_file or previous execution outputs). At least one file_id is required.",
          minItems: 1,
        }),
      }),
      async execute(
        _id: string,
        params: { session_id: string; file_ids: string[] },
      ) {
        const token = await getToken(ctx);
        const endpoint = `/v1/sessions/${encodeURIComponent(params.session_id)}/files`;
        const body = { file_ids: params.file_ids };

        await apiRequest("POST", endpoint, token, body);
        return {
          content: [
            { type: "text" as const, text: `Injected ${params.file_ids.length} file(s) into session ${params.session_id}` },
          ],
          details: { ok: true, session_id: params.session_id, file_ids: params.file_ids },
        };
      },
    },

    // ── sandbox_download_file ────────────────────────────────────
    {
      name: "sandbox_download_file",
      label: "Download Sandbox File",
      description:
        "Download the content of a file by its file_id. Returns the raw file content.\n\n" +
        "Use this to retrieve:\n" +
        "- Output files from sandbox_execute (files written to /output directory)\n" +
        "- Files uploaded via sandbox_upload_file\n\n" +
        "For text files, returns the text content directly. For binary files (images, etc.), returns the raw bytes. Large files may be truncated.",
      parameters: Type.Object({
        file_id: Type.String({
          description: "ID of the file to download (from sandbox_execute response or sandbox_upload_file)",
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
        "Check if a specific sandbox session exists and is still active. Returns session details if found.\n\n" +
        "Use this to verify a session is still running before executing code in it.",
      parameters: Type.Object({
        session_id: Type.String({
          description: "ID of the session to check (from sandbox_create_session or sandbox_list_sessions)",
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
        "List all files owned by the authenticated user. Includes both uploaded files (via sandbox_upload_file) and output files from sandbox executions.\n\n" +
        "Results are paginated. Each file entry includes file_id, filename, mime_type, size_bytes, and created_at timestamp.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Maximum number of files to return per page (1-100, default 50)",
            minimum: 1,
            maximum: 100,
          }),
        ),
        offset: Type.Optional(
          Type.Number({
            description: "Number of files to skip for pagination (default 0). Use with limit to page through results.",
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
        "Upload a file to cloud storage. Returns a file_id that can be used to inject the file into sandbox sessions.\n\n" +
        "To use this file in sandbox_execute, pass the returned file_id in the `file_ids` array parameter.\n\n" +
        "If `session_id` is provided, the file is also immediately copied to that session's /workspace directory.",
      parameters: Type.Object({
        file_data: Type.String({
          description: "Base64-encoded file content. Must be valid base64 with proper padding (=). For text files, encode the UTF-8 bytes. No line breaks in the base64 string.",
        }),
        filename: Type.String({
          description: "Name for the file (e.g., 'data.csv', 'script.py'). This name is used when the file is injected into /workspace.",
        }),
        session_id: Type.Optional(
          Type.String({
            description: "If provided, immediately inject the uploaded file into this session's /workspace directory in addition to storing it",
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
        "Permanently delete a file from cloud storage by its file_id. This removes both the stored file and its metadata.\n\n" +
        "Note: This does not remove copies of the file that were already injected into session /workspace directories.",
      parameters: Type.Object({
        file_id: Type.String({
          description: "ID of the file to delete (from sandbox_upload_file or sandbox_execute output)",
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
        "Retrieve a detailed log of a past code execution, including the original code, stdout, stderr, return code, execution duration, and output file count.\n\n" +
        "Use this to review or debug previous executions, or to retrieve execution details that may have been lost from context.",
      parameters: Type.Object({
        execution_id: Type.String({
          description: "UUID of the execution to retrieve. Execution IDs are returned in execution logs and can be found in the API response metadata.",
        }),
      }),
      async execute(_id: string, params: { execution_id: string }) {
        const token = await getToken(ctx);
        const data = (await apiRequest(
          "GET",
          `/v1/executions/${encodeURIComponent(params.execution_id)}`,
          token,
        )) as {
          id: string;
          endpoint?: string;
          method?: string;
          status_code?: number | null;
          duration_ms?: number | null;
          session_id?: string | null;
          language?: string | null;
          code?: string | null;
          stdout?: string | null;
          stderr?: string | null;
          return_code?: number | null;
          files_count?: number;
          error?: string | null;
          request_meta?: Record<string, unknown> | null;
          created_at?: string;
        };

        const parts: string[] = [];
        parts.push(`id: ${data.id}`);
        if (data.language) parts.push(`language: ${data.language}`);
        if (data.duration_ms !== undefined && data.duration_ms !== null) {
          parts.push(`duration_ms: ${data.duration_ms}`);
        }
        if (data.code) parts.push(`code:\n${data.code}`);
        if (data.stdout) parts.push(`stdout:\n${data.stdout}`);
        if (data.stderr) parts.push(`stderr:\n${data.stderr}`);
        if (data.return_code !== undefined && data.return_code !== null) {
          parts.push(`return_code: ${data.return_code}`);
        }
        if (data.files_count !== undefined) {
          parts.push(`files_count: ${data.files_count}`);
        }
        if (data.error) parts.push(`error: ${data.error}`);
        if (data.created_at) parts.push(`created_at: ${data.created_at}`);

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
