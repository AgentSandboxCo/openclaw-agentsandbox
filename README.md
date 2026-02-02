# openclaw-agentsandbox

An OpenClaw plugin that lets your bot execute Python and Bash code in a sandboxed environment via the [Agent Sandbox](https://agentsandbox.co) API.

## Installation

```bash
openclaw plugins install @agentsandbox/openclaw-agentsandbox
```

Or install from a local clone for development:

```bash
git clone https://github.com/AgentSandboxCo/openclaw-agentsandbox.git
openclaw plugins install -l ./openclaw-agentsandbox
```

## Authentication

After installation, authenticate with your Google account:

```bash
openclaw models auth login --provider agentsandbox
```

This opens a browser for Google Sign-In. Once approved, the plugin stores your credentials and handles token refresh automatically.

For headless/remote environments (SSH, containers), the plugin falls back to a manual flow where you open the URL yourself and paste the redirect URL back.

## Tools

Once authenticated, your bot has access to these tools:

### `sandbox_execute`

Execute Python or Bash code in a sandboxed environment.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `language` | `"python"` or `"bash"` | Yes | Language to execute |
| `code` | string | Yes | Code to run |
| `session_id` | string | No | Reuse a persistent session. Omit for a one-shot sandbox. |
| `env_vars` | object | No | Environment variables to inject |

Returns stdout, stderr, return code, and any output files.

### `sandbox_create_session`

Create a persistent sandbox session. Filesystem state and installed packages are preserved across executions within the same session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `env_vars` | object | No | Environment variables to inject |

### `sandbox_list_sessions`

List all active sandbox sessions.

### `sandbox_destroy_session`

Destroy a sandbox session and terminate its container.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | Yes | ID of the session to destroy |

### `sandbox_download_file`

Download an output file produced by a sandbox execution.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_id` | string | Yes | ID of the file (from `sandbox_execute` response) |

## Usage Examples

Ask your bot to run code and it will use the sandbox tools automatically:

- "Run a Python script that generates a fibonacci sequence up to 100"
- "Install pandas and analyze this CSV data"
- "Create a session and set up a project with multiple files"

## Development

```bash
git clone https://github.com/AgentSandboxCo/openclaw-agentsandbox.git
cd openclaw-agentsandbox
npm install
openclaw plugins install -l .
```

## License

MIT
