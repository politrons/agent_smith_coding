# VS Code Integration Plan

This project is prepared for two VS Code integration levels.

## Level 1: Webview Chat With CLI Bridge

The `vscode-extension/` scaffold registers an Activity Bar container named
`Agent Smith` with a persistent chat view. Each prompt spawns:

```bash
python -m open_agent_coding.app --agent <agent> --message "<prompt>" --quiet
```

This is simple, testable, and works with the current FastAgent app. The
extension sets `MCP_FILESYSTEM_ROOT` to the active VS Code workspace folder, or
to `agentSmithCoding.targetWorkspace` when that setting is configured. It also
sets `MCP_MEMORY_FILE_PATH` to a deterministic JSONL file under VS Code global
extension storage, derived from the active workspace path. That gives each
opened project its own durable Memory MCP graph.
Chat messages are persisted in VS Code `workspaceState`, capped to the latest
200 messages, so the view can be recreated without losing the visible history.
The UI now hides the internal FastAgent agents and exposes only model selection;
the normal chat path always uses the `coding_workflow` single-pass chain:
planner, coder, then terminal. Planner is read-only; coder implements once with
Filesystem, Memory, and Browser MCP access; terminal runs one validation
command once. Memory is context only: old prompts, old plans, and remembered
next steps are not active tasks. The latest user prompt is the only active
task. The coder has direct Filesystem and Memory MCP access plus Browser MCP
access for current external documentation, dependency metadata, and public API
research. In the VS Code extension, the normal chat path launches planner,
coder, terminal, and evaluator as separate controlled phases so Live Activity can show the
task input and output of each agent. The evaluator uses `pydantic-evals` when
available, with deterministic fallback rules, to validate the completed run.
The chat tails FastAgent's `fastagent.jsonl` plus a
workspace-specific terminal JSONL log while the local process is running and
shows real MCP/tool events in Live Activity, including tool start/completion,
responsible agent/server, terminal command start/finish, exit code, stdout/stderr
summary, failure state, and model token completion summaries. Elapsed-time
waiting text stays in the top status line instead of filling Live Activity with
repeated timer logs. If an implementation prompt gets a non-actionable
analysis/confirmation answer instead of applied file changes, the workflow stops
and reports that failure instead of retrying automatically. The extension also
includes a best-effort workspace snapshot in each prompt so the model starts
with current project structure and important file contents before MCP tools
execute. Test creation remains
technology-agnostic: the Coder must infer the stack from the workspace, add
focused tests using that stack's conventions, use Browser MCP for unfamiliar
test or validation setup, and provide one chosen validation command for
Terminal MCP instead of relying on a hardcoded extension-side list of supported
project types. If validation fails, the workflow reports the blocker instead of
feeding the result back into another automatic coding loop.
The composer includes a square Stop button that terminates the active Python
agent process and prevents the controlled workflow from entering the next phase.

Development flow:

```bash
cd /Users/politrons/development/agent_smith_coding/vscode-extension
npm install
npm run compile
npx playwright install firefox
code .
```

Then press `F5` in VS Code and choose `Run Agent Smith Coding Extension` if VS
Code asks for a launch target. The included `.vscode/launch.json` opens the
parent project folder in the Extension Development Host.

Configure these VS Code settings if needed:

```json
{
  "agentSmithCoding.pythonPath": "",
  "agentSmithCoding.projectPath": "/Users/politrons/development/agent_smith_coding",
  "agentSmithCoding.targetWorkspace": "",
  "agentSmithCoding.defaultAgent": "coding_workflow",
  "agentSmithCoding.defaultModel": "qwen3-coder:30b",
  "agentSmithCoding.defaultCodingModel": "qwen3-coder:30b",
  "agentSmithCoding.defaultBrowserModel": "qwen3.5:latest",
  "agentSmithCoding.toolModel": "qwen3.5:latest",
  "agentSmithCoding.memoryModel": "",
  "agentSmithCoding.plannerModel": "",
  "agentSmithCoding.filesystemModel": "",
  "agentSmithCoding.browserModel": "",
  "agentSmithCoding.coderModel": "",
  "agentSmithCoding.modelOptions": [
    "qwen3-coder:30b",
    "qwen3.5:latest",
    "gpt-oss:20b",
    "llama3.1:8b",
    "gemma4:31b",
    "qwen2.5-coder:32b"
  ],
  "agentSmithCoding.accentColor": "#00ff66",
  "agentSmithCoding.chatFontFamily": ""
}
```

Leave `pythonPath` empty for auto-detection. Leave `targetWorkspace` empty for
normal installed-extension use. Set it to an absolute path when debugging
against a specific project folder.

## Level 2: Persistent ACP Server

FastAgent already supports ACP transport:

```bash
python -m open_agent_coding.app --transport acp
```

For a Codex-style IDE experience, evolve the extension to:

1. Spawn the Python process once with `--transport acp`.
2. Keep the process alive per VS Code workspace.
3. Implement an ACP client in the extension.
4. Stream responses into a WebView chat panel.
5. Surface file changes through VS Code's diff and approval UX.
6. Keep per-workspace chat sessions and cancellation controls.

This is the right path for a production Marketplace extension because it avoids
starting a new model and MCP server process for every prompt.

## Publish To Marketplace

There are two distribution paths.

### Local VSIX Install

Use this when you want to install the extension into any VS Code project on this
machine without publishing it publicly:

```bash
cd /Users/politrons/development/agent_smith_coding/vscode-extension
npm install
npm run compile
npx vsce package
code --install-extension agent-smith-coding-0.1.26.vsix
```

Then open any project folder. Keep `agentSmithCoding.projectPath` pointing to the
local backend checkout:

```json
{
  "agentSmithCoding.projectPath": "/Users/politrons/development/agent_smith_coding",
  "agentSmithCoding.pythonPath": "/Users/politrons/development/agent_smith_coding/.venv/bin/python",
  "agentSmithCoding.targetWorkspace": ""
}
```

With `targetWorkspace` empty, the extension uses the active VS Code project as
`MCP_FILESYSTEM_ROOT` and creates a separate Memory MCP JSONL file for that
workspace.

### Marketplace Publish

After the extension is functional:

```bash
cd /Users/politrons/development/agent_smith_coding/vscode-extension
npm install
npm run compile
npx vsce package
npx vsce publish
```

Before publishing:

- Create a Visual Studio Marketplace publisher.
- Add the real publisher id in `vscode-extension/package.json`.
- Add `repository`, `license`, a Marketplace icon, and final categories.
- Confirm the extension does not bundle secrets.
- Document Ollama, Python 3.13.5+, Node, and MCP dependency setup.
- Decide the backend distribution story:
  - short term: users install this extension and configure `projectPath` to a
    local backend checkout;
  - better: publish the Python backend as a package and add an extension command
    that bootstraps `.venv`, `pip install`, `npm install`, and Ollama checks;
  - best IDE experience: ship or download the backend automatically and talk to
    it through persistent ACP instead of one-shot CLI calls.

To publish the first time:

1. Create a publisher at https://marketplace.visualstudio.com/manage.
2. Generate an Azure DevOps Personal Access Token with Marketplace publish
   rights.
3. Run `npx vsce login <publisher>`.
4. Run `npx vsce publish`.
