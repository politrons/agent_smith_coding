# Changelog

## 0.1.29

- Pass the packaged backend source path to every managed MCP subprocess.
- Prevent managed MCP servers from closing when `open_agent_coding` is not installed into the virtualenv.

## 0.1.28

- Prefer compatible Python commands before creating the managed backend virtualenv.
- Recreate managed virtualenvs created with unsupported Python versions.
- Report a concise Python version error before dependency installation starts.

## 0.1.27

- Packaged the Python backend inside the VSIX for normal installed-extension use.
- Added first-run backend bootstrap into VS Code global storage.
- Removed local checkout defaults from Marketplace settings and documentation.

## 0.1.26

- Renamed the Marketplace extension ID to `agent-smith-coding`.
- Renamed the VS Code command, view, and setting namespace to `agentSmithCoding`.
- Updated backend settings for the renamed project.
- Added Marketplace metadata, support information, and a smaller extension icon.

## 0.1.25

- Improved Stop handling so local agent process groups are terminated more reliably.
- Updated the Stop button styling in the chat composer.
