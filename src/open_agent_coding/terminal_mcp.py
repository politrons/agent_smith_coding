import json
import os
import shlex
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastmcp import FastMCP


DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_MAX_OUTPUT_CHARS = 20_000
INSPECTION_COMMANDS = {
    "awk",
    "cat",
    "egrep",
    "fgrep",
    "file",
    "find",
    "grep",
    "head",
    "less",
    "ls",
    "more",
    "pwd",
    "rg",
    "sed",
    "stat",
    "tail",
    "tree",
    "wc",
}
SHELL_COMMANDS = {"bash", "sh", "zsh", "fish"}

mcp = FastMCP(
    "Agent Smith Terminal",
    instructions=(
        "Run validation, build, test, and lint commands inside the "
        "configured workspace root. Commands are executed without a shell by "
        "default and cannot leave the workspace root."
    ),
)


def workspace_root() -> Path:
    configured = os.environ.get("MCP_TERMINAL_ROOT") or os.environ.get("MCP_FILESYSTEM_ROOT")
    root = Path(configured or os.getcwd()).expanduser().resolve()
    return root


def resolve_cwd(cwd: str | None) -> Path:
    root = workspace_root()
    requested = root if not cwd else (root / cwd).resolve() if not Path(cwd).is_absolute() else Path(cwd).resolve()
    try:
        requested.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"cwd must stay inside workspace root: {root}") from exc
    if not requested.exists() or not requested.is_dir():
        raise ValueError(f"cwd does not exist or is not a directory: {requested}")
    return requested


def clip_output(output: str, max_chars: int) -> tuple[str, bool]:
    if len(output) <= max_chars:
        return output, False
    return output[-max_chars:], True


def write_terminal_event(event: dict[str, Any]) -> None:
    log_path = os.environ.get("AGENT_SMITH_TERMINAL_LOG")
    if not log_path:
        return

    record = {
        "timestamp": datetime.now(UTC).isoformat(),
        **event,
    }
    try:
        path = Path(log_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=True) + "\n")
    except OSError:
        return


def clean_env(extra_env: dict[str, str] | None) -> dict[str, str]:
    env = os.environ.copy()
    if not extra_env:
        return env
    for key, value in extra_env.items():
        if not key or any(ch in key for ch in "=\x00"):
            raise ValueError(f"invalid environment variable name: {key!r}")
        env[key] = value
    return env


def normalize_argv(command: str, args: list[str] | None) -> list[str]:
    """Accept either executable+args or a single shell-like command string."""
    if args:
        return [command, *args]
    try:
        parts = shlex.split(command)
    except ValueError:
        return [command]
    return parts or [command]


def is_inspection_command(argv: list[str]) -> bool:
    executable = Path(argv[0]).name.lower() if argv else ""
    if executable in INSPECTION_COMMANDS:
        return True
    if executable in SHELL_COMMANDS and len(argv) >= 3 and argv[1] in {"-c", "-lc"}:
        shell_payload = argv[2].strip().split(maxsplit=1)[0].lower() if argv[2].strip() else ""
        return shell_payload in INSPECTION_COMMANDS
    return False


@mcp.tool()
def run_command(
    command: str,
    args: list[str] | None = None,
    cwd: str | None = None,
    timeout_seconds: int | None = None,
    max_output_chars: int | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run a command inside the workspace and return exit code plus output.

    Use this only for compile/test/build/lint validation commands selected by
    the coder. Pass the executable as `command` and arguments as `args`, for
    example command="npm", args=["test"]. If a model sends a single string like
    "npm test", it is split safely without invoking a shell. Shell features such
    as pipes and redirects are intentionally unavailable.
    """

    if not command or "\x00" in command:
        raise ValueError("command must be a non-empty executable name")

    resolved_cwd = resolve_cwd(cwd)
    timeout = timeout_seconds or int(os.environ.get("MCP_TERMINAL_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))
    timeout = max(1, min(timeout, 600))
    max_chars = max_output_chars or DEFAULT_MAX_OUTPUT_CHARS
    max_chars = max(1000, min(max_chars, 100_000))
    argv = normalize_argv(command, args)
    if is_inspection_command(argv):
        output = (
            "Rejected inspection command. Terminal MCP only runs validation, "
            "build, test, and lint commands. Filesystem inspection belongs to "
            "the coder/filesystem phase."
        )
        write_terminal_event(
            {
                "event": "finish",
                "command": argv,
                "cwd": str(resolved_cwd),
                "exit_code": 64,
                "timed_out": False,
                "output": output,
                "output_truncated": False,
            }
        )
        return {
            "command": argv,
            "cwd": str(resolved_cwd),
            "exit_code": 64,
            "timed_out": False,
            "output": output,
            "output_truncated": False,
        }

    write_terminal_event(
        {
            "event": "start",
            "command": argv,
            "cwd": str(resolved_cwd),
            "timeout_seconds": timeout,
        }
    )

    try:
        completed = subprocess.run(
            argv,
            cwd=resolved_cwd,
            env=clean_env(env),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        combined = "\n".join(
            part for part in [completed.stdout, completed.stderr] if part
        )
        output, truncated = clip_output(combined, max_chars)
        write_terminal_event(
            {
                "event": "finish",
                "command": argv,
                "cwd": str(resolved_cwd),
                "exit_code": completed.returncode,
                "timed_out": False,
                "output": clip_output(output, 4000)[0],
                "output_truncated": truncated,
            }
        )
        return {
            "command": argv,
            "cwd": str(resolved_cwd),
            "exit_code": completed.returncode,
            "timed_out": False,
            "output": output,
            "output_truncated": truncated,
        }
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode(errors="replace")
        output, truncated = clip_output("\n".join(part for part in [stdout, stderr] if part), max_chars)
        write_terminal_event(
            {
                "event": "finish",
                "command": argv,
                "cwd": str(resolved_cwd),
                "exit_code": None,
                "timed_out": True,
                "output": clip_output(output, 4000)[0],
                "output_truncated": truncated,
            }
        )
        return {
            "command": argv,
            "cwd": str(resolved_cwd),
            "exit_code": None,
            "timed_out": True,
            "output": output,
            "output_truncated": truncated,
        }
    except FileNotFoundError as exc:
        output = f"Command not found: {command}. {exc}"
        write_terminal_event(
            {
                "event": "finish",
                "command": argv,
                "cwd": str(resolved_cwd),
                "exit_code": None,
                "timed_out": False,
                "output": output,
                "output_truncated": False,
            }
        )
        return {
            "command": argv,
            "cwd": str(resolved_cwd),
            "exit_code": None,
            "timed_out": False,
            "output": output,
            "output_truncated": False,
        }


def main() -> None:
    mcp.run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    main()
