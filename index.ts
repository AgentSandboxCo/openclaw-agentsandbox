import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { runOAuthFlow } from "./oauth.js";
import { createTools } from "./tools.js";

export default {
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

            // Use newly returned apiKey, or preserve existing one
            const key = result.apiKey ?? existingKey ?? undefined;

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
        "sandbox_download_file",
      ],
    });
  },
};
