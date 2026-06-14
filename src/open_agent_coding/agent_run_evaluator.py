from __future__ import annotations

import argparse
import contextlib
import io
import json
import re
import sys
from dataclasses import asdict, dataclass
from typing import Any


try:
    from pydantic_evals import Case, Dataset
    from pydantic_evals.evaluators import Evaluator, EvaluatorContext

    PYDANTIC_EVALS_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - exercised when optional dep is absent
    Case = None  # type: ignore[assignment]
    Dataset = None  # type: ignore[assignment]
    Evaluator = object  # type: ignore[assignment,misc]
    EvaluatorContext = object  # type: ignore[assignment,misc]
    PYDANTIC_EVALS_IMPORT_ERROR = str(exc)


IMPLEMENTATION_RE = re.compile(
    r"\b("
    r"haz|hacer|crea|crear|convierte|convertir|mete|a(?:ñ|n)ade|agrega|"
    r"instala|instalar|usa|usar|utiliza|utilizar|controla|controlar|"
    r"maneja|manejar|reemplaza|reemplazar|sustituye|sustituir|"
    r"refactoriza|refactorizar|modifica|cambia|actualiza|implementa|"
    r"arregla|corrige|migra|genera|escribe|mueve|borra|create|make|"
    r"convert|add|update|change|modify|implement|fix|migrate|scaffold|"
    r"generate|write|move|delete|install|use|replace|refactor|handle"
    r")\b",
    re.IGNORECASE,
)
GENERIC_ANSWER_RE = re.compile(
    r"what type of project|qu[eé] tipo de proyecto|tell me more about your project|"
    r"conocer mejor tu proyecto|would you like me to|quieres que|soy tu asistente ide local"
    r"|could be enhanced|could be improved|you could enhance|recommendations|"
    r"recomendaciones|podr[ií]a mejorarse|se podr[ií]a mejorar|podr[ií]as mejorar|"
    r"no additional dependency installation is needed|no se necesita instalar",
    re.IGNORECASE,
)
TOOL_MARKUP_RE = re.compile(
    r"<function=|</tool_call>|\"tool_calls\"\s*:|\"function_call\"\s*:",
    re.IGNORECASE,
)
VALIDATION_COMMAND_RE = re.compile(r"Validation command\s*:", re.IGNORECASE)
VALIDATION_UNAVAILABLE_RE = re.compile(r"Validation command\s*:\s*unavailable", re.IGNORECASE)
TERMINAL_FAILURE_RE = re.compile(
    r"\b(exit[_\s-]*code|exited)\s*[:=]?\s*(?:[1-9][0-9]*|unknown)\b|"
    r"timed out|tests?\s+failed|compilation failed|build failed|"
    r"command not found|rejected inspection command|error:",
    re.IGNORECASE,
)
INSPECTION_TERMINAL_RE = re.compile(
    r"agent terminal (?:working|finished):\s*(?:ls|cat|find|grep|rg|sed|awk|head|tail|pwd|tree|wc)\b",
    re.IGNORECASE,
)


@dataclass
class RuleResult:
    name: str
    passed: bool
    score: float
    severity: str
    message: str


@dataclass
class EvaluationResult:
    passed: bool
    score: float
    engine: str
    pydantic_evals_available: bool
    summary: str
    rules: list[RuleResult]
    markdown: str


def text_at(payload: dict[str, Any], phase: str, key: str = "content") -> str:
    value = payload.get(phase, {})
    if not isinstance(value, dict):
        return ""
    result = value.get(key, "")
    return result if isinstance(result, str) else ""


def failed_at(payload: dict[str, Any], phase: str) -> bool:
    value = payload.get(phase, {})
    return bool(value.get("failed")) if isinstance(value, dict) else False


def is_implementation_prompt(prompt: str) -> bool:
    return bool(IMPLEMENTATION_RE.search(prompt))


def rule(name: str, passed: bool, message: str, severity: str = "error") -> RuleResult:
    return RuleResult(
        name=name,
        passed=passed,
        score=1.0 if passed else 0.0,
        severity=severity,
        message=message,
    )


def evaluate_rules(payload: dict[str, Any]) -> list[RuleResult]:
    prompt = str(payload.get("prompt") or "")
    planner = text_at(payload, "planner")
    coder = text_at(payload, "coder")
    terminal = text_at(payload, "terminal")
    all_output = "\n".join([planner, coder, terminal, "\n".join(payload.get("logs", []))])
    implementation = is_implementation_prompt(prompt)

    rules = [
        rule(
            "planner_output_present",
            bool(planner.strip()),
            "Planner produced an observable plan or fallback.",
        ),
        rule(
            "coder_output_present",
            bool(coder.strip()),
            "Coder produced an output for the active request.",
        ),
        rule(
            "coder_not_generic",
            not GENERIC_ANSWER_RE.search(coder),
            "Coder did not answer with a generic IDE greeting or workspace question.",
        ),
        rule(
            "no_unexecuted_tool_markup",
            not TOOL_MARKUP_RE.search(all_output),
            "No raw/unexecuted tool-call markup was exposed as final output.",
        ),
        rule(
            "validation_command_present",
            not implementation or (bool(VALIDATION_COMMAND_RE.search(coder)) and not VALIDATION_UNAVAILABLE_RE.search(coder)),
            "Implementation requests must end with a concrete Validation command, not unavailable.",
        ),
        rule(
            "terminal_output_present",
            not implementation or bool(terminal.strip()),
            "Implementation requests must include terminal validation output.",
        ),
        rule(
            "terminal_no_inspection_commands",
            not INSPECTION_TERMINAL_RE.search(all_output),
            "Terminal must not be used for filesystem inspection commands.",
        ),
        rule(
            "terminal_validation_success",
            not failed_at(payload, "terminal") and not TERMINAL_FAILURE_RE.search(terminal),
            "Terminal validation completed without a detected validation failure.",
        ),
    ]

    if not implementation:
        rules.append(
            rule(
                "read_only_validation_optional",
                True,
                "Read-only requests do not require terminal validation unless coder provides a safe command.",
                "warning",
            )
        )

    return rules


if PYDANTIC_EVALS_IMPORT_ERROR:
    AgentRunRulesEvaluator = None
else:

    class AgentRunRulesEvaluator(Evaluator[dict[str, Any], dict[str, Any]]):  # type: ignore[misc,valid-type]
        def evaluate(self, ctx: EvaluatorContext[dict[str, Any], dict[str, Any]]) -> float:  # type: ignore[override,valid-type]
            rules = evaluate_rules(ctx.output)
            return score_rules(rules)


def score_rules(rules: list[RuleResult]) -> float:
    blocking = [item for item in rules if item.severity == "error"]
    if not blocking:
        return 1.0
    return sum(item.score for item in blocking) / len(blocking)


def run_pydantic_evals(payload: dict[str, Any]) -> tuple[str, bool]:
    if PYDANTIC_EVALS_IMPORT_ERROR or Case is None or Dataset is None or AgentRunRulesEvaluator is None:
        return "deterministic-rules", False

    case = Case(name="agent_run", inputs=payload, expected_output=payload)
    dataset = Dataset(
        name="agent_smith_run_validation",
        cases=[case],
        evaluators=[AgentRunRulesEvaluator()],
    )
    with contextlib.redirect_stdout(io.StringIO()):
        dataset.evaluate_sync(lambda inputs: inputs)
    return "pydantic-evals", True


def format_markdown(result: EvaluationResult) -> str:
    icon = "passed" if result.passed else "failed"
    lines = [
        f"Evaluation: {icon}",
        f"Engine: {result.engine}",
        f"Score: {result.score:.2f}",
        "",
        "Rules:",
    ]
    for item in result.rules:
        mark = "PASS" if item.passed else "FAIL"
        lines.append(f"- {mark} {item.name}: {item.message}")
    return "\n".join(lines)


def evaluate_agent_run(payload: dict[str, Any]) -> EvaluationResult:
    try:
        engine, pydantic_available = run_pydantic_evals(payload)
    except Exception as exc:
        engine = f"deterministic-rules (pydantic-evals failed: {exc})"
        pydantic_available = False

    rules = evaluate_rules(payload)
    score = score_rules(rules)
    failures = [item for item in rules if item.severity == "error" and not item.passed]
    passed = not failures
    summary = "Agent run passed validation." if passed else f"Agent run failed {len(failures)} validation rule(s)."
    result = EvaluationResult(
        passed=passed,
        score=score,
        engine=engine,
        pydantic_evals_available=pydantic_available,
        summary=summary,
        rules=rules,
        markdown="",
    )
    result.markdown = format_markdown(result)
    return result


def read_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.stdin:
        raw = sys.stdin.read()
    else:
        with open(args.input_file, encoding="utf-8") as file:
            raw = file.read()
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("evaluation payload must be a JSON object")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate an Agent Smith Coding run.")
    parser.add_argument("--input-file", help="JSON file containing the agent run payload.")
    parser.add_argument("--stdin", action="store_true", help="Read JSON payload from stdin.")
    args = parser.parse_args()
    if not args.stdin and not args.input_file:
        parser.error("provide --stdin or --input-file")

    result = evaluate_agent_run(read_payload(args))
    print(json.dumps(asdict(result), ensure_ascii=True))


if __name__ == "__main__":
    main()
