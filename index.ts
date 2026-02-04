import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { runOAuthFlow, refreshAccessToken } from "./oauth.js";
import { createTools } from "./tools.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin: any = {
  id: "openclaw-agentsandbox",
  name: "Agent Sandbox",
  description: "Execute Python and Bash code in a sandboxed environment via the Agent Sandbox API",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // 1. Auth provider — OAuth with Google Sign-In (PKCE)
    api.registerProvider({
      id: "agentsandbox",
      label: "Agent Sandbox",
      docsPath: "/providers/agentsandbox",
      aliases: ["sandbox"],
      envVars: ["SANDBOX_API_KEY"],
      async refreshOAuth(cred: any) {
        const refreshed = await refreshAccessToken(cred.refresh);
        return {
          ...cred,
          access: refreshed.accessToken,
          refresh: refreshed.refreshToken,
          expires: refreshed.expiresAt,
        };
      },
      auth: [
        {
          id: "oauth",
          label: "Google Sign-In",
          hint: "Authorize via Google in your browser",
          kind: "oauth",
          run: async (ctx) => {
            const spin = ctx.prompter.progress("Starting OAuth…");

            // If re-authenticating, preserve existing API key
            const existingProfileId = Object.entries(
              api.config?.auth?.profiles ?? {},
            ).find(([, p]) => p?.provider === "agentsandbox")?.[0];

            let existingKey: string | undefined;
            if (existingProfileId) {
              const agentDir =
                process.env.OPENCLAW_AGENT_DIR ??
                process.env.PI_CODING_AGENT_DIR;
              if (agentDir) {
                try {
                  const fs = await import("node:fs/promises");
                  const path = await import("node:path");
                  const authPath = path.join(agentDir, "auth-profiles.json");
                  const store = JSON.parse(
                    await fs.readFile(authPath, "utf8"),
                  ) as {
                    profiles?: Record<string, { key?: string }>;
                  };
                  existingKey =
                    store.profiles?.[existingProfileId]?.key ?? undefined;
                } catch {
                  // No existing store — first auth
                }
              }
            }

            const result = await runOAuthFlow({
              isRemote: ctx.isRemote,
              openUrl: ctx.openUrl,
              prompt: async (msg) =>
                String(await ctx.prompter.text({ message: msg })),
            });
            spin.stop("Authorized");

            // Use newly returned apiKey, or preserve existing one, or create one
            let key = result.apiKey ?? existingKey ?? undefined;

            if (!key) {
              // No permanent API key yet — create one via the API
              try {
                const createRes = await fetch(
                  "https://api.agentsandbox.co/v1/api-keys",
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${result.accessToken}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ name: "openclaw-plugin" }),
                  },
                );
                if (createRes.ok) {
                  const created = (await createRes.json()) as {
                    key_value?: string;
                  };
                  if (created.key_value) {
                    key = created.key_value;
                  }
                }
              } catch {
                // Non-fatal — tokens still work, just no permanent key
              }
            }

            return {
              profiles: [
                {
                  profileId: `agentsandbox:${result.email ?? "default"}`,
                  credential: {
                    type: "oauth",
                    provider: "agentsandbox",
                    access: result.accessToken,
                    refresh: result.refreshToken,
                    expires: result.expiresAt,
                    email: result.email,
                    ...(key ? { key } : {}),
                  },
                },
              ],
            };
          },
        },
      ],
    });

    // 2. Register all sandbox tools
    api.registerTool((ctx) => createTools(ctx), {
      names: [
        "sandbox_execute",
        "sandbox_create_session",
        "sandbox_list_sessions",
        "sandbox_destroy_session",
        "sandbox_inject_files",
        "sandbox_download_file",
        "sandbox_get_session",
        "sandbox_list_files",
        "sandbox_upload_file",
        "sandbox_delete_file",
        "sandbox_get_execution",
      ],
    });
  },
};

export default plugin;
