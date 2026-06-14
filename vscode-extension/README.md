# Agent Smith Coding VS Code Extension

VS Code chat UI for the local Agent Smith Coding FastAgent assistant.

## What It Does

- Adds an `Agent Smith` Activity Bar icon.
- Shows a persistent `Chat` view with a prompt textarea.
- Shows a thinking indicator immediately after each prompt while the local model
  and MCP tools start.
- Shows real FastAgent MCP/tool events in Live Activity by tailing
  `fastagent.jsonl`: tool started/completed, responsible agent/server, failure
  state, and model token completion summaries.
- Shows terminal validation details from a workspace-specific terminal JSONL
  log: command, working directory, exit code, and a short stdout/stderr summary.
- Shows controlled workflow phase details in Live Activity: task input and
  output for planner, coder, terminal, and evaluator.
- Runs a post-workflow evaluator using `pydantic-evals` when available, with
  deterministic fallback rules, to catch missing validation commands, generic
  answers, terminal misuse, failed validation, and raw tool-call markup.
- Shows a visible planner fallback with subtasks and delegation when the local
  planner model executes MCP activity but returns no final text.
- Keeps elapsed-time waiting text in the top status line instead of adding
  repeated timer spam to Live Activity.
- Keeps planner/coder/terminal orchestration transparent for normal users.
- Uses a single-pass workflow: planner plans once, coder implements once, and
  terminal validates one command once. Failed validation is reported instead of
  feeding agents back into an automatic loop.
- Adds a square Stop button next to Send to terminate a stuck local agent run.
- Lets you choose separate local open-source models for Coding and Browser.
  Coding defaults to `qwen3-coder:30b`; Browser defaults to `qwen3.5:latest`.
- Sends each prompt to the Python FastAgent app.
- Uses the active VS Code workspace as `MCP_FILESYSTEM_ROOT`, so the agent works
  on the project you opened.
- Adds a best-effort workspace snapshot to every prompt before MCP execution,
  so the model starts with the current project structure and relevant file
  contents instead of asking what kind of project is open.
- Passes that memory file as `MCP_MEMORY_FILE_PATH`, so every opened project has
  its own remembered decisions, constraints, and important changes.
- Treats Memory MCP as context only. Old prompts, old plans, and remembered
  next steps are not active work; the latest chat prompt is the only active
  task.
- Gives the backend Browser MCP access, so the coding agent can consult current
  external docs and package metadata when local context is not enough.
- Instructs the Coder to infer the detected technology stack, create/update
  focused tests for new functionality using that stack's conventions, and use
  Browser MCP when it is unsure how to test or validate the project.
- Gives the backend Terminal MCP access, so the terminal agent can run the one
  validation command selected by the Coder and report stdout/stderr.
- Stops after the single workflow pass when an implementation prompt receives a
  non-actionable answer such as "Would you like me to create it?" instead of
  applied file changes. Generic "what type of project is this?" answers are
  reported as failures because the workspace is already known.
- Streams process output into the chat and mirrors raw logs to the `Agent Smith
  Coding` output channel.
- Keeps the last 200 chat messages in VS Code workspace storage, so switching
  away from the chat view and coming back does not lose the conversation.

The extension uses `resources/agent-smith-activity.svg` for the Activity Bar
because VS Code masks those icons as theme-colored monochrome shapes. The richer
`resources/agent.png` image is still used in the extension manifest and inside
the chat header.

## Development

```bash
npm install
npm run compile
```

Open this `vscode-extension` folder in VS Code and press `F5`.

VS Code should launch `Run Agent Smith Coding Extension`. The Extension
Development Host opens the parent project folder so the chat can operate on the
actual project, not only on the extension folder.

In the new Extension Development Host:

1. Click the `Agent Smith` icon in the Activity Bar.
2. Open the `Chat` view.
3. Choose Coding and Browser models.
4. Write a prompt and press `Send`.

Use `Cmd+Enter` or `Ctrl+Enter` from the textarea to send.

## Settings

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

Leave `pythonPath` empty for auto-detection. The extension tries:

1. `/Users/politrons/development/agent_smith_coding/.venv/bin/python`
2. `/opt/homebrew/bin/python3.14`
3. `python3`

`targetWorkspace` is optional. Leave it empty to use the project currently open
in VS Code. Set it to an absolute folder path when you want the agent to work on
a different project.

`defaultAgent` is intentionally internal. The normal chat UI exposes model
selection, not the planner/coder/terminal implementation details.

`defaultCodingModel` controls the Coding selector. `defaultBrowserModel`
controls the Browser selector and follows the `Dive-into-Python` Browser MCP
POC default, `qwen3.5:latest`. The per-agent model settings are optional escape
hatches.

`accentColor` and `chatFontFamily` let you customize the Matrix-inspired chat
look without editing TypeScript. Example:

```json
{
  "agentSmithCoding.accentColor": "#7c5cff",
  "agentSmithCoding.chatFontFamily": "JetBrains Mono, Menlo, monospace"
}
```

## Commands

- `Agent Smith Coding: Open Chat`
- `Agent Smith Coding: Clear Chat`
- `Agent Smith Coding: Ask Browser`
- `Agent Smith Coding: Ask Workflow`
- `Agent Smith Coding: Ask Coder`
- `Agent Smith Coding: Ask Filesystem`
- `Agent Smith Coding: Ask Memory`
- `Agent Smith Coding: Ask Planner`
- `Agent Smith Coding: Ask Terminal`

## Install In Any Local VS Code Project

Build a local VSIX package:

```bash
cd /Users/politrons/development/agent_smith_coding/vscode-extension
npm install
npm run compile
npx vsce package
```

Install it in VS Code:

```bash
code --install-extension agent-smith-coding-0.1.26.vsix
```

Then open any project folder in VS Code. The `Agent Smith` Activity Bar icon
appears there too. The extension still needs the local Python backend from this
repo, so keep these settings pointing to the backend install:

```json
{
  "agentSmithCoding.projectPath": "/Users/politrons/development/agent_smith_coding",
  "agentSmithCoding.pythonPath": "/Users/politrons/development/agent_smith_coding/.venv/bin/python",
  "agentSmithCoding.targetWorkspace": ""
}
```

Leave `targetWorkspace` empty to make the agent work on the currently opened
project.
