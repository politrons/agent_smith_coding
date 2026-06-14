"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const output = vscode.window.createOutputChannel("Agent Smith Coding");
function activate(context) {
    const provider = new ChatViewProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider), vscode.commands.registerCommand("agentSmithCoding.openChat", () => vscode.commands.executeCommand("workbench.view.extension.agentSmithCoding")), vscode.commands.registerCommand("agentSmithCoding.clearChat", () => provider.clear()), vscode.commands.registerCommand("agentSmithCoding.stop", () => provider.stopCurrentRun()), vscode.commands.registerCommand("agentSmithCoding.askBrowser", () => provider.askFromInput("browser")), vscode.commands.registerCommand("agentSmithCoding.askWorkflow", () => provider.askFromInput("coding_workflow")), vscode.commands.registerCommand("agentSmithCoding.askCoder", () => provider.askFromInput("coder")), vscode.commands.registerCommand("agentSmithCoding.askFilesystem", () => provider.askFromInput("filesystem")), vscode.commands.registerCommand("agentSmithCoding.askMemory", () => provider.askFromInput("memory")), vscode.commands.registerCommand("agentSmithCoding.askPlanner", () => provider.askFromInput("planner")), vscode.commands.registerCommand("agentSmithCoding.askTerminal", () => provider.askFromInput("terminal")), vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refreshWorkspace()), output);
}
function deactivate() { }
class ChatViewProvider {
    context;
    static viewType = "agentSmithCoding.chat";
    static storageKey = "agentSmithCoding.chat.messages";
    view;
    messages = [];
    busy = false;
    stopRequested = false;
    currentProcess;
    ollamaModelsCache;
    constructor(context) {
        this.context = context;
        this.messages = this.loadMessages();
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        if (!this.busy) {
            this.messages = this.loadMessages();
        }
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };
        webviewView.webview.html = this.renderHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message));
        setTimeout(() => this.postState(), 0);
    }
    clear() {
        this.messages = [];
        this.saveMessages();
        this.postState();
    }
    refreshWorkspace() {
        this.postState();
    }
    async askFromInput(agent) {
        await vscode.commands.executeCommand("workbench.view.extension.agentSmithCoding");
        const prompt = await vscode.window.showInputBox({
            prompt: `Ask ${agent}`,
            ignoreFocusOut: true
        });
        if (prompt) {
            await this.runAgent(agent, prompt);
        }
    }
    async handleWebviewMessage(message) {
        if (message.type === "clear") {
            this.clear();
            return;
        }
        if (message.type === "stop") {
            this.stopCurrentRun();
            return;
        }
        if (message.type !== "prompt" || !message.prompt) {
            return;
        }
        await this.runAgent(this.defaultAgent(), message.prompt, message.codingModel ?? message.model, message.browserModel);
    }
    async runAgent(agent, prompt, requestedCodingModel, requestedBrowserModel) {
        if (this.busy) {
            this.addMessage("system", "The agent is still running. Wait for the current answer to finish.");
            return;
        }
        const settings = this.readSettings(requestedCodingModel, requestedBrowserModel);
        this.ensureMemoryDirectory(settings);
        this.busy = true;
        this.stopRequested = false;
        this.addMessage("user", prompt, agent);
        const assistantIndex = this.messages.push({
            role: "assistant",
            agent,
            model: `coding ${settings.codingModel}`,
            content: "",
            pending: true,
            status: "Agent planner working...",
            logs: [
                `coding_workflow: prompt received`,
                `workspace: ${settings.targetWorkspace}`,
                `runtime: local FastAgent process starting`,
                `workspace snapshot: captured before sending prompt`,
                `activity: monitoring FastAgent MCP/tool events from fastagent.jsonl`,
                `activity: monitoring terminal command output from workspace terminal log`,
                `model routing: coding=${settings.codingModel}, browser=${settings.browserModel}`
            ]
        }) - 1;
        this.postState();
        output.appendLine(`> ${agent} · coding=${settings.codingModel} browser=${settings.browserModel} [${settings.targetWorkspace}]`);
        output.appendLine(`python: ${settings.pythonPath}`);
        output.appendLine(`memory: ${settings.memoryFilePath}`);
        if (settings.warnings.length > 0) {
            output.appendLine(`warnings: ${settings.warnings.join(" | ")}`);
        }
        output.appendLine(`models: memory=${settings.memoryModel}, planner=${settings.plannerModel}, filesystem=${settings.filesystemModel}, browser=${settings.browserModel}, coder=${settings.coderModel}`);
        output.appendLine(prompt);
        if (agent === "coding_workflow") {
            await this.runControlledWorkflow(prompt, settings, assistantIndex);
            return;
        }
        const agentPrompt = this.buildWorkspaceAwarePrompt(prompt, settings);
        let stderr = "";
        const args = [
            "-m",
            "open_agent_coding.app",
            "--agent",
            agent,
            "--model",
            this.toFastAgentModel(settings.codingModel),
            "--message",
            agentPrompt,
            "--quiet"
        ];
        const child = (0, child_process_1.spawn)(settings.pythonPath, args, {
            cwd: settings.projectPath,
            detached: true,
            env: {
                ...process.env,
                MCP_FILESYSTEM_ROOT: settings.targetWorkspace,
                MCP_MEMORY_FILE_PATH: settings.memoryFilePath,
                AGENT_SMITH_TOOL_MODEL: this.toFastAgentModel(settings.browserModel),
                AGENT_SMITH_MEMORY_MODEL: this.toFastAgentModel(settings.memoryModel),
                AGENT_SMITH_PLANNER_MODEL: this.toFastAgentModel(settings.plannerModel),
                AGENT_SMITH_FILESYSTEM_MODEL: this.toFastAgentModel(settings.filesystemModel),
                AGENT_SMITH_BROWSER_MODEL: this.toFastAgentModel(settings.browserModel),
                AGENT_SMITH_CODER_MODEL: this.toFastAgentModel(settings.coderModel),
                FAST_AGENT_RETRIES: "0",
                MCP_TERMINAL_ROOT: settings.targetWorkspace,
                MCP_TERMINAL_TIMEOUT_SECONDS: "120",
                AGENT_SMITH_TERMINAL_LOG: this.terminalLogPath(settings),
                PYTHONPATH: this.mergePythonPath(settings.projectPath)
            }
        });
        this.currentProcess = child;
        let sawStdout = false;
        let sawFastAgentEvent = false;
        const startedAt = Date.now();
        let lastProcessOutputAt = startedAt;
        let logTail = this.createFastAgentLogTail(settings);
        let terminalLogTail = this.createTerminalLogTail(settings);
        const logPoller = setInterval(() => {
            logTail = this.pollFastAgentLog(logTail, settings, assistantIndex, () => {
                sawFastAgentEvent = true;
            });
            terminalLogTail = this.pollTerminalLog(terminalLogTail, settings, assistantIndex, () => {
                sawFastAgentEvent = true;
            });
        }, 1000);
        const heartbeat = setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
            const silentSeconds = Math.floor((Date.now() - lastProcessOutputAt) / 1000);
            const phase = this.phaseForElapsed(prompt, elapsedSeconds);
            const outputState = sawFastAgentEvent
                ? `waiting for next FastAgent event; last process output ${silentSeconds}s ago`
                : sawStdout
                    ? `waiting for FastAgent tool events; last process output ${silentSeconds}s ago`
                    : "waiting for first FastAgent/Ollama output";
            const extra = elapsedSeconds >= 60 ? " Local models can be slow on large prompts." : "";
            this.updateRuntimeStatus(assistantIndex, `Agent ${phase} working... ${elapsedSeconds}s. ${outputState}.${extra}`);
        }, 15000);
        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            lastProcessOutputAt = Date.now();
            output.append(text);
            if (!sawStdout) {
                sawStdout = true;
                this.appendRuntimeLog(assistantIndex, "assistant: receiving response", "Receiving the agent response...");
            }
            const attemptedToolCall = this.unexecutedToolCallName(text);
            if (attemptedToolCall) {
                this.appendRuntimeLog(assistantIndex, `model: emitted unexecuted MCP tool markup for ${attemptedToolCall}`, this.statusForToolCall(attemptedToolCall));
            }
            this.messages[assistantIndex].content += text;
            this.postState();
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            lastProcessOutputAt = Date.now();
            stderr += text;
            output.append(text);
            this.appendRuntimeLog(assistantIndex, this.logLineFromProcessOutput(text), this.statusFromStderr(text, settings.codingModel));
        });
        child.on("error", (error) => {
            clearInterval(logPoller);
            clearInterval(heartbeat);
            this.messages[assistantIndex].content = `Failed to start Agent Smith Coding: ${error.message}`;
            this.messages[assistantIndex].pending = false;
            this.messages[assistantIndex].status = undefined;
            this.appendRuntimeLog(assistantIndex, `runtime: failed to start process`);
            this.busy = false;
            this.stopRequested = false;
            this.currentProcess = undefined;
            this.postState();
        });
        child.on("close", async (code) => {
            logTail = this.pollFastAgentLog(logTail, settings, assistantIndex, () => {
                sawFastAgentEvent = true;
            });
            terminalLogTail = this.pollTerminalLog(terminalLogTail, settings, assistantIndex, () => {
                sawFastAgentEvent = true;
            });
            clearInterval(logPoller);
            clearInterval(heartbeat);
            const content = this.messages[assistantIndex].content.trim();
            try {
                if (this.stopRequested) {
                    this.messages[assistantIndex].content = [
                        content,
                        "Stopped by user."
                    ].filter(Boolean).join("\n\n");
                    this.appendRuntimeLog(assistantIndex, "runtime: stopped by user");
                }
                else if (code !== 0) {
                    this.messages[assistantIndex].content = [
                        content,
                        `Process exited with code ${code ?? "unknown"}.`,
                        stderr.trim()
                    ].filter(Boolean).join("\n\n");
                }
                else if (!content) {
                    this.messages[assistantIndex].content = "The agent finished without returning output.";
                }
                else if (this.containsUnexecutedToolCall(content)) {
                    const attemptedToolCall = this.unexecutedToolCallName(content);
                    this.messages[assistantIndex].content = [
                        "The local model returned an unexecuted tool call instead of a final answer. Agent Smith stopped after the single workflow pass instead of retrying automatically.",
                        attemptedToolCall ? `Detected attempted tool call: ${attemptedToolCall}` : undefined,
                        `Agent Smith used coding model ${settings.codingModel} and browser/tool model ${settings.browserModel}. If this repeats, try a coding model with stronger tool-call support.`,
                        "Use the Output panel named Agent Smith Coding to inspect the raw process log.",
                        "Original raw response:",
                        content
                    ].filter(Boolean).join("\n\n");
                    this.appendRuntimeLog(assistantIndex, "runtime: unexecuted tool-call markup detected; stopped after one workflow pass");
                }
                else if (this.containsProviderInternalError(content)) {
                    this.messages[assistantIndex].content = [
                        "The local model failed with an internal provider/tool-call syntax error. Agent Smith stopped after the single workflow pass instead of retrying automatically.",
                        "Use the Output panel named Agent Smith Coding to inspect the raw process log.",
                        "Original raw response:",
                        content
                    ].filter(Boolean).join("\n\n");
                    this.appendRuntimeLog(assistantIndex, "runtime: provider/internal model error detected; stopped after one workflow pass");
                }
                else if (this.shouldRetryNonActionableAnswer(prompt, content)) {
                    this.messages[assistantIndex].content = [
                        "The local model answered with analysis or optional next steps instead of applying the requested change. Agent Smith stopped after the single workflow pass instead of retrying automatically.",
                        "Original raw response:",
                        content
                    ].filter(Boolean).join("\n\n");
                    this.appendRuntimeLog(assistantIndex, "runtime: non-actionable implementation answer detected; stopped after one workflow pass");
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.messages[assistantIndex].content = [
                    content,
                    `Post-processing failed: ${message}`
                ].filter(Boolean).join("\n\n");
            }
            this.messages[assistantIndex].pending = false;
            this.messages[assistantIndex].status = undefined;
            this.appendRuntimeLog(assistantIndex, `runtime: finished with code ${code ?? "unknown"}`);
            this.busy = false;
            this.stopRequested = false;
            this.currentProcess = undefined;
            this.postState();
            output.appendLine(`\n[agent-smith-coding exited with code ${code ?? "unknown"}]`);
        });
    }
    stopCurrentRun() {
        if (!this.busy) {
            return;
        }
        this.stopRequested = true;
        const assistantIndex = this.lastPendingAssistantIndex();
        if (assistantIndex >= 0) {
            this.appendRuntimeLog(assistantIndex, "runtime: stop requested by user", "Stopping agent...");
        }
        if (this.currentProcess && this.currentProcess.exitCode === null && this.currentProcess.signalCode === null) {
            const processToKill = this.currentProcess;
            const terminated = this.killProcessTree(processToKill, "SIGTERM");
            if (assistantIndex >= 0) {
                this.appendRuntimeLog(assistantIndex, terminated
                    ? `runtime: sent SIGTERM to agent process group ${processToKill.pid ?? "unknown"}`
                    : `runtime: sent SIGTERM to agent process ${processToKill.pid ?? "unknown"}`);
            }
            setTimeout(() => {
                if (this.stopRequested && processToKill.exitCode === null && processToKill.signalCode === null) {
                    const killed = this.killProcessTree(processToKill, "SIGKILL");
                    if (assistantIndex >= 0) {
                        this.appendRuntimeLog(assistantIndex, killed
                            ? `runtime: sent SIGKILL to agent process group ${processToKill.pid ?? "unknown"}`
                            : `runtime: sent SIGKILL to agent process ${processToKill.pid ?? "unknown"}`);
                    }
                }
            }, 2500);
        }
        else if (assistantIndex >= 0) {
            this.appendRuntimeLog(assistantIndex, "runtime: stop requested while no agent subprocess was active; workflow will stop before next phase");
        }
        this.postState();
    }
    killProcessTree(child, signal) {
        const pid = child.pid;
        if (!pid) {
            return false;
        }
        if (process.platform !== "win32") {
            try {
                process.kill(-pid, signal);
                return true;
            }
            catch {
                // Fall through to direct child kill below.
            }
        }
        try {
            child.kill(signal);
        }
        catch {
            return false;
        }
        return false;
    }
    lastPendingAssistantIndex() {
        for (let index = this.messages.length - 1; index >= 0; index -= 1) {
            const message = this.messages[index];
            if (message.role === "assistant" && message.pending) {
                return index;
            }
        }
        return -1;
    }
    async runControlledWorkflow(prompt, settings, assistantIndex) {
        try {
            const plannerPrompt = this.buildPlannerPhasePrompt(prompt, settings);
            const planner = await this.runAgentPhase("planner", "Plan the latest user request once. Produce subtasks, delegation, risks, and validation guidance only.", plannerPrompt, settings, assistantIndex, `User prompt: ${prompt}`);
            let plannerForWorkflow = planner;
            if (this.shouldUsePlannerFallback(planner)) {
                plannerForWorkflow = {
                    ...planner,
                    content: this.buildPlannerFallbackOutput(prompt, settings, planner.failureReason),
                    failed: false,
                    failureReason: undefined
                };
                this.appendPlannerFallbackLogs(assistantIndex, prompt, settings, planner.failureReason);
            }
            this.appendPhaseOutputToContent(assistantIndex, "Planner", plannerForWorkflow);
            if (this.stopRequested) {
                this.stopControlledWorkflow(assistantIndex, "planner", plannerForWorkflow);
                return;
            }
            if (plannerForWorkflow.failed) {
                await this.evaluateAndAppendRun(prompt, settings, assistantIndex, plannerForWorkflow);
                this.stopControlledWorkflow(assistantIndex, "planner", plannerForWorkflow);
                return;
            }
            const coderPrompt = this.buildCoderPhasePrompt(prompt, settings, plannerForWorkflow.content);
            const coder = await this.runAgentPhase("coder", "Implement the planner output once. Inspect files, edit when needed, and finish with one validation command.", coderPrompt, settings, assistantIndex, `User prompt: ${prompt}\nPlanner output:\n${this.clipForChat(plannerForWorkflow.content, 2500)}`);
            this.appendPhaseOutputToContent(assistantIndex, "Coder", coder);
            if (this.stopRequested) {
                this.stopControlledWorkflow(assistantIndex, "coder", coder);
                return;
            }
            if (coder.failed) {
                await this.evaluateAndAppendRun(prompt, settings, assistantIndex, plannerForWorkflow, coder);
                this.stopControlledWorkflow(assistantIndex, "coder", coder);
                return;
            }
            const terminal = this.shouldSkipTerminalPhase(coder.content)
                ? this.buildSkippedTerminalResult(coder.content)
                : await this.runAgentPhase("terminal", "Run the single validation command from coder once and report command, cwd, exit code, timeout, stdout, and stderr.", this.buildTerminalPhasePrompt(prompt, settings, plannerForWorkflow.content, coder.content), settings, assistantIndex, `User prompt: ${prompt}\nCoder output:\n${this.clipForChat(coder.content, 2500)}`);
            if (this.shouldSkipTerminalPhase(coder.content)) {
                this.appendRuntimeLog(assistantIndex, "agent terminal skipped: coder reported validation command unavailable", "Agent terminal skipped.");
            }
            this.appendPhaseOutputToContent(assistantIndex, "Terminal", terminal);
            if (this.stopRequested) {
                this.stopControlledWorkflow(assistantIndex, "terminal", terminal);
                return;
            }
            const evaluation = await this.evaluateAndAppendRun(prompt, settings, assistantIndex, plannerForWorkflow, coder, terminal);
            if (this.stopRequested) {
                this.stopControlledWorkflow(assistantIndex, "evaluator", evaluation);
                return;
            }
            if (evaluation.failed) {
                this.stopControlledWorkflow(assistantIndex, "evaluator", evaluation);
                return;
            }
            if (terminal.failed) {
                this.stopControlledWorkflow(assistantIndex, "terminal", terminal);
                return;
            }
            this.appendRuntimeLog(assistantIndex, "workflow: planner, coder, and terminal completed one controlled pass", "Workflow completed.");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messages[assistantIndex].content = [
                this.messages[assistantIndex].content.trim(),
                `Workflow failed before completing the controlled pass: ${message}`
            ].filter(Boolean).join("\n\n");
            this.appendRuntimeLog(assistantIndex, `workflow: failed - ${message}`);
        }
        finally {
            this.messages[assistantIndex].pending = false;
            this.messages[assistantIndex].status = undefined;
            this.busy = false;
            this.stopRequested = false;
            this.currentProcess = undefined;
            this.postState();
            output.appendLine("\n[agent-smith-controlled-workflow finished]");
        }
    }
    runAgentPhase(phaseAgent, taskDescription, phasePrompt, settings, assistantIndex, logInput) {
        this.appendRuntimeLog(assistantIndex, `agent ${phaseAgent} task input: ${taskDescription} Input summary: ${this.summarizeForLog(logInput ?? phasePrompt, 1200)}`, `Agent ${this.humanAgentName(phaseAgent)} working...`);
        const args = [
            "-m",
            "open_agent_coding.app",
            "--agent",
            phaseAgent,
            "--model",
            this.toFastAgentModel(this.modelForAgent(phaseAgent, settings)),
            "--message",
            phasePrompt,
            "--quiet"
        ];
        return new Promise((resolve) => {
            let content = "";
            let stderr = "";
            let settled = false;
            let sawStdout = false;
            let sawFastAgentEvent = false;
            const phaseTerminalEvents = [];
            const startedAt = Date.now();
            let lastProcessOutputAt = startedAt;
            let logTail = this.createFastAgentLogTail(settings);
            let terminalLogTail = this.createTerminalLogTail(settings);
            const child = (0, child_process_1.spawn)(settings.pythonPath, args, {
                cwd: settings.projectPath,
                detached: true,
                env: {
                    ...process.env,
                    MCP_FILESYSTEM_ROOT: settings.targetWorkspace,
                    MCP_MEMORY_FILE_PATH: settings.memoryFilePath,
                    AGENT_SMITH_TOOL_MODEL: this.toFastAgentModel(settings.browserModel),
                    AGENT_SMITH_MEMORY_MODEL: this.toFastAgentModel(settings.memoryModel),
                    AGENT_SMITH_PLANNER_MODEL: this.toFastAgentModel(settings.plannerModel),
                    AGENT_SMITH_FILESYSTEM_MODEL: this.toFastAgentModel(settings.filesystemModel),
                    AGENT_SMITH_BROWSER_MODEL: this.toFastAgentModel(settings.browserModel),
                    AGENT_SMITH_CODER_MODEL: this.toFastAgentModel(settings.coderModel),
                    FAST_AGENT_RETRIES: "0",
                    MCP_TERMINAL_ROOT: settings.targetWorkspace,
                    MCP_TERMINAL_TIMEOUT_SECONDS: "120",
                    AGENT_SMITH_TERMINAL_LOG: this.terminalLogPath(settings),
                    PYTHONPATH: this.mergePythonPath(settings.projectPath)
                }
            });
            this.currentProcess = child;
            const logPoller = setInterval(() => {
                logTail = this.pollFastAgentLog(logTail, settings, assistantIndex, () => {
                    sawFastAgentEvent = true;
                });
                terminalLogTail = this.pollTerminalLog(terminalLogTail, settings, assistantIndex, () => {
                    sawFastAgentEvent = true;
                }, (event) => phaseTerminalEvents.push(event.line));
            }, 1000);
            const heartbeat = setInterval(() => {
                const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
                const silentSeconds = Math.floor((Date.now() - lastProcessOutputAt) / 1000);
                const outputState = sawFastAgentEvent
                    ? `waiting for next ${phaseAgent} event; last process output ${silentSeconds}s ago`
                    : sawStdout
                        ? `waiting for ${phaseAgent} MCP events; last process output ${silentSeconds}s ago`
                        : `waiting for first ${phaseAgent}/Ollama output`;
                const extra = elapsedSeconds >= 60 ? " Local models can be slow on large prompts." : "";
                this.updateRuntimeStatus(assistantIndex, `Agent ${this.humanAgentName(phaseAgent)} working... ${elapsedSeconds}s. ${outputState}.${extra}`);
            }, 15000);
            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                logTail = this.pollFastAgentLog(logTail, settings, assistantIndex, () => {
                    sawFastAgentEvent = true;
                });
                terminalLogTail = this.pollTerminalLog(terminalLogTail, settings, assistantIndex, () => {
                    sawFastAgentEvent = true;
                }, (event) => phaseTerminalEvents.push(event.line));
                clearInterval(logPoller);
                clearInterval(heartbeat);
                this.currentProcess = undefined;
                this.appendRuntimeLog(assistantIndex, result.failed
                    ? `agent ${phaseAgent} output: failed - ${result.failureReason ?? "unknown failure"} ${this.summarizeForLog(result.content || result.stderr, 900)}`
                    : `agent ${phaseAgent} output: ${this.summarizeForLog(result.content, 1200)}`, result.failed ? `Agent ${this.humanAgentName(phaseAgent)} failed.` : `Agent ${this.humanAgentName(phaseAgent)} finished.`);
                resolve(result);
            };
            child.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                lastProcessOutputAt = Date.now();
                sawStdout = true;
                output.append(text);
                content += text;
                const attemptedToolCall = this.unexecutedToolCallName(text);
                if (attemptedToolCall) {
                    this.appendRuntimeLog(assistantIndex, `agent ${phaseAgent}: emitted unexecuted MCP tool markup for ${attemptedToolCall}`, this.statusForToolCall(attemptedToolCall));
                }
            });
            child.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                lastProcessOutputAt = Date.now();
                stderr += text;
                output.append(text);
                this.appendRuntimeLog(assistantIndex, this.logLineFromProcessOutput(text), this.statusFromStderr(text, this.modelForAgent(phaseAgent, settings)));
            });
            child.on("error", (error) => {
                finish({
                    agent: phaseAgent,
                    content,
                    stderr,
                    code: null,
                    failed: true,
                    failureReason: `failed to start process: ${error.message}`
                });
            });
            child.on("close", (code) => {
                const trimmedContent = content.trim();
                const trimmedStderr = stderr.trim();
                const effectiveContent = phaseAgent === "terminal" && !trimmedContent && phaseTerminalEvents.length > 0
                    ? phaseTerminalEvents.join("\n")
                    : trimmedContent;
                const failureReason = this.phaseFailureReason(code, effectiveContent, trimmedStderr, phaseAgent);
                finish({
                    agent: phaseAgent,
                    content: effectiveContent,
                    stderr: trimmedStderr,
                    code,
                    failed: Boolean(failureReason),
                    failureReason
                });
            });
        });
    }
    async evaluateAndAppendRun(prompt, settings, assistantIndex, planner, coder, terminal) {
        const evaluation = await this.runEvaluatorPhase(prompt, settings, assistantIndex, planner, coder, terminal);
        this.appendPhaseOutputToContent(assistantIndex, "Evaluator", evaluation);
        return evaluation;
    }
    runEvaluatorPhase(prompt, settings, assistantIndex, planner, coder, terminal) {
        this.appendRuntimeLog(assistantIndex, "agent evaluator task input: validate planner, coder, terminal, and MCP activity outputs", "Agent evaluator working...");
        const payload = {
            prompt,
            workspace: settings.targetWorkspace,
            planner,
            coder: coder ?? this.emptyPhaseResult("coder"),
            terminal: terminal ?? this.emptyPhaseResult("terminal"),
            logs: this.messages[assistantIndex]?.logs ?? []
        };
        return new Promise((resolve) => {
            let stdout = "";
            let stderr = "";
            let settled = false;
            const child = (0, child_process_1.spawn)(settings.pythonPath, ["-m", "open_agent_coding.agent_run_evaluator", "--stdin"], {
                cwd: settings.projectPath,
                detached: true,
                env: {
                    ...process.env,
                    PYTHONPATH: this.mergePythonPath(settings.projectPath)
                }
            });
            this.currentProcess = child;
            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.currentProcess = undefined;
                this.appendRuntimeLog(assistantIndex, result.failed
                    ? `agent evaluator output: failed - ${result.failureReason ?? "unknown failure"} ${this.summarizeForLog(result.content || result.stderr, 900)}`
                    : `agent evaluator output: ${this.summarizeForLog(result.content, 1200)}`, result.failed ? "Agent evaluator failed." : "Agent evaluator finished.");
                resolve(result);
            };
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk) => {
                const text = chunk.toString();
                stderr += text;
                output.append(text);
            });
            child.on("error", (error) => {
                finish({
                    agent: "evaluator",
                    content: "",
                    stderr,
                    code: null,
                    failed: true,
                    failureReason: `failed to start evaluator: ${error.message}`
                });
            });
            child.on("close", (code) => {
                const parsed = this.parseEvaluatorOutput(stdout);
                const content = parsed.markdown || stdout.trim() || stderr.trim() || "<no output>";
                const failed = code !== 0 || parsed.passed === false;
                finish({
                    agent: "evaluator",
                    content,
                    stderr: stderr.trim(),
                    code,
                    failed,
                    failureReason: failed
                        ? parsed.summary || `evaluator exited with code ${code ?? "unknown"}`
                        : undefined
                });
            });
            child.stdin.end(JSON.stringify(payload));
        });
    }
    emptyPhaseResult(agent) {
        return {
            agent,
            content: "",
            stderr: "",
            code: null,
            failed: true,
            failureReason: "phase did not run"
        };
    }
    parseEvaluatorOutput(stdout) {
        try {
            const parsed = JSON.parse(stdout.trim());
            if (!parsed || typeof parsed !== "object") {
                return {};
            }
            return {
                passed: typeof parsed.passed === "boolean" ? parsed.passed : undefined,
                markdown: typeof parsed.markdown === "string" ? parsed.markdown : undefined,
                summary: typeof parsed.summary === "string" ? parsed.summary : undefined
            };
        }
        catch {
            return {};
        }
    }
    stopControlledWorkflow(assistantIndex, phaseAgent, result) {
        this.messages[assistantIndex].content = [
            this.messages[assistantIndex].content.trim(),
            `Workflow stopped after ${phaseAgent}.`,
            `Reason: ${result.failureReason ?? "unknown failure"}`
        ].filter(Boolean).join("\n\n");
        this.appendRuntimeLog(assistantIndex, `workflow: stopped after ${phaseAgent} - ${result.failureReason ?? "unknown failure"}`, `Workflow stopped after ${this.humanAgentName(phaseAgent)}.`);
    }
    appendPhaseOutputToContent(assistantIndex, title, result) {
        const outputText = result.content || result.stderr || "<no output>";
        const section = [
            `### ${title} output`,
            result.failed ? `Status: failed (${result.failureReason ?? "unknown failure"})` : "Status: completed",
            "",
            this.clipForChat(outputText, 6000)
        ].join("\n");
        this.messages[assistantIndex].content = [
            this.messages[assistantIndex].content.trim(),
            section
        ].filter(Boolean).join("\n\n");
        this.postState();
    }
    phaseFailureReason(code, content, stderr, phaseAgent) {
        if (this.stopRequested) {
            return "stopped by user";
        }
        if (code !== 0) {
            return `process exited with code ${code ?? "unknown"}`;
        }
        if (!content && !stderr) {
            return "agent finished without output";
        }
        const combined = [content, stderr].filter(Boolean).join("\n");
        if (this.containsUnexecutedToolCall(combined)) {
            const attemptedToolCall = this.unexecutedToolCallName(combined);
            return attemptedToolCall
                ? `model emitted unexecuted tool-call markup for ${attemptedToolCall}`
                : "model emitted unexecuted tool-call markup";
        }
        if (this.containsProviderInternalError(combined)) {
            return `provider/internal model error in ${phaseAgent}; the selected model may not be reliable with MCP tool calls`;
        }
        if (phaseAgent === "coder" && this.isNonActionableAnswer(content)) {
            return "coder returned a non-actionable answer";
        }
        if (phaseAgent === "terminal" && this.terminalOutputLooksFailed(content)) {
            return "terminal validation command failed";
        }
        return undefined;
    }
    shouldSkipTerminalPhase(coderOutput) {
        return /Validation command\s*:\s*unavailable/i.test(coderOutput);
    }
    buildSkippedTerminalResult(coderOutput) {
        const reasonMatch = coderOutput.match(/Validation command\s*:\s*unavailable\s*-?\s*(.*)$/im);
        const reason = reasonMatch?.[1]?.trim() || "coder reported validation unavailable";
        return {
            agent: "terminal",
            content: `Terminal skipped. Reason: ${reason}`,
            stderr: "",
            code: 0,
            failed: false
        };
    }
    shouldUsePlannerFallback(result) {
        return result.agent === "planner" &&
            result.failed &&
            !this.stopRequested &&
            !result.content.trim() &&
            /finished without output/i.test(result.failureReason ?? "");
    }
    buildPlannerFallbackOutput(prompt, settings, reason) {
        const implementation = this.isImplementationPrompt(prompt);
        const needsBrowser = this.promptLikelyNeedsBrowser(prompt);
        const validationExpectation = implementation
            ? "Terminal should run the single compile/test/build validation command that coder produces for the detected stack."
            : "Terminal validation is not needed for a read-only explanation unless coder identifies a safe validation command.";
        return [
            "Planner fallback output",
            `Fallback reason: ${reason ?? "planner returned no final text after MCP activity"}`,
            "",
            `Original request: ${prompt}`,
            "",
            "Goal:",
            implementation
                ? "Apply the latest user request inside the active VS Code workspace only."
                : "Answer the latest user request from the active VS Code workspace context.",
            "",
            "Sequential thinking fallback subtasks:",
            `1. Treat the active workspace as the project: ${settings.targetWorkspace}`,
            "2. Load workspace memory only as durable project context, not as queued tasks.",
            "3. Inspect the current filesystem before answering or editing.",
            implementation
                ? "4. Implement the requested change with the smallest coherent file edits."
                : "4. Read the relevant README/project files and explain what the project does.",
            needsBrowser
                ? "5. Use Browser MCP if local context is not enough or current external documentation is required."
                : "5. Browser MCP is optional and should be skipped unless local context is insufficient.",
            implementation
                ? "6. Produce one validation command for Terminal."
                : "6. State that validation is not required for this read-only request unless coder finds a useful command.",
            "",
            "Delegation map:",
            "- memory: read durable context for this workspace; write back only completed, stable facts.",
            "- filesystem: list the root and read relevant README, build markers, and source files.",
            needsBrowser
                ? "- browser: research official or primary sources if dependency/API/framework knowledge is required."
                : "- browser: not required unless coder cannot answer from current files.",
            "- coder: execute the request once using current files and latest prompt only.",
            `- terminal: ${validationExpectation}`,
            "",
            "Coder task:",
            implementation
                ? "Inspect the active workspace, implement the requested change, summarize changed files, and finish with exactly one validation command."
                : "Inspect the active workspace, read README/project files relevant to the question, explain the project, and finish with validation unavailable because this is read-only.",
            "",
            "Stop conditions:",
            "- Stop if required filesystem operations do not execute.",
            "- Stop if the selected local model emits unexecuted tool-call markup.",
            "- Stop after one coder pass and one terminal pass; do not create an agent feedback loop."
        ].join("\n");
    }
    appendPlannerFallbackLogs(assistantIndex, prompt, settings, reason) {
        const implementation = this.isImplementationPrompt(prompt);
        const needsBrowser = this.promptLikelyNeedsBrowser(prompt);
        this.appendRuntimeLog(assistantIndex, `agent planner fallback: planner produced no final text (${reason ?? "unknown reason"}); generated visible single-pass delegation`, "Agent planner fallback generated.");
        this.appendRuntimeLog(assistantIndex, [
            "agent sequential thinking output:",
            `subtask 1 inspect active workspace ${settings.targetWorkspace}`,
            "subtask 2 load memory as context only",
            implementation ? "subtask 3 implement latest prompt once" : "subtask 3 answer from README/current files",
            needsBrowser ? "subtask 4 browser research if current docs are needed" : "subtask 4 browser not needed unless local context is insufficient"
        ].join(" | "), "Agent planner finished.");
        this.appendRuntimeLog(assistantIndex, implementation
            ? "agent coder task input: inspect files, apply latest requested change, update memory with completed facts, return one validation command"
            : "agent coder task input: inspect files, read README/project markers, answer latest question, skip edits, return read-only validation note", "Agent coder queued.");
        this.appendRuntimeLog(assistantIndex, implementation
            ? "agent terminal task input: run the single validation command produced by coder once"
            : "agent terminal task input: skip command unless coder provides a safe read-only validation command", "Agent terminal queued.");
    }
    isNonActionableAnswer(content) {
        const lower = content.toLowerCase();
        const asksForPermission = /would you like me to|do you want me to|should i|shall i|quieres que|te gustaria que|te gustaría que|deseas que|puedo crear|puedo hacerlo|quieres continuar/.test(lower);
        const asksForWorkspaceBasics = /qu[eé] tipo de proyecto|what type of project|tell me more about your project|conocer mejor tu proyecto|podr[ií]as decirme|could you tell me|provide more details|proporcionar m[aá]s informaci[oó]n|necesito m[aá]s informaci[oó]n/.test(lower);
        const genericIdeGreeting = /soy tu asistente ide local|i am your local ide assistant|i'm your local ide assistant|estoy aqu[ií] para ayudarte/.test(lower);
        const recommendationOnly = /could be enhanced|could be improved|you could enhance|recommendations|recomendaciones|podr[ií]a mejorarse|se podr[ií]a mejorar|podr[ií]as mejorar|no additional dependency installation is needed|no se necesita instalar/i.test(content);
        const changeEvidence = /\b(created|updated|modified|changed|wrote|added|moved|deleted|creado|actualizado|modificado|cambiado|escrito|añadido|agregado|movido|borrado|eliminado)\b|changed files|files changed|archivos modificados|he creado|he actualizado|he modificado|se ha creado|se ha actualizado|se ha modificado/i.test(content);
        return !changeEvidence && (asksForPermission || asksForWorkspaceBasics || genericIdeGreeting || recommendationOnly);
    }
    terminalOutputLooksFailed(content) {
        return /\b(exit[_\s-]*code|exited)\s*[:=]?\s*(?:[1-9][0-9]*|unknown)\b|timed out|tests?\s+failed|compilation failed|build failed|command not found|rejected inspection command|error:/i.test(content);
    }
    modelForAgent(agent, settings) {
        if (agent === "coder" || agent === "coding_workflow") {
            return settings.coderModel;
        }
        if (agent === "planner") {
            return settings.plannerModel;
        }
        if (agent === "filesystem") {
            return settings.filesystemModel;
        }
        if (agent === "memory") {
            return settings.memoryModel;
        }
        return settings.browserModel;
    }
    buildCoderPhasePrompt(prompt, settings, plannerOutput) {
        return [
            this.buildWorkspaceAwarePrompt(prompt, settings),
            "",
            "Planner output for this single workflow pass:",
            plannerOutput || "<planner returned no output>",
            "",
            "Coder phase task:",
            "- Execute the coding phase once.",
            "- Use Filesystem MCP for current files and edits.",
            "- Use Browser MCP only when external documentation or package metadata is needed.",
            "- Do not call terminal tools.",
            "- End with exactly one validation command line for Terminal.",
            "- The validation command must be a compile, test, build, lint, or equivalent project validation command. Do not use ls, cat, find, grep, rg, sed, head, tail, pwd, or other inspection commands as validation."
        ].join("\n");
    }
    buildPlannerPhasePrompt(prompt, settings) {
        return [
            "Agent Smith Coding planner phase:",
            `- Active VS Code workspace: ${settings.targetWorkspace}`,
            `- Filesystem MCP root: ${settings.targetWorkspace}`,
            `- Workspace memory file: ${settings.memoryFilePath}`,
            `- Planner model: ${settings.plannerModel}`,
            "",
            "Planner responsibility:",
            "- Read Memory MCP as context only.",
            "- Use Sequential Thinking MCP once to decompose the latest user request.",
            "- Do not inspect files, edit files, browse, or run commands.",
            "- Produce a concise plan for coder and one validation handoff for terminal.",
            "- The latest user prompt below is the only active task.",
            "- Treat references such as this project, este proyecto, repo, aqui, aquí, workspace, and el workspace as the active VS Code workspace above.",
            "",
            "Output format:",
            "1. Goal",
            "2. Coder task",
            "3. Browser research needed, if any",
            "4. Expected validation command type for terminal",
            "5. Stop conditions or blockers",
            "",
            "User prompt:",
            prompt
        ].join("\n");
    }
    buildTerminalPhasePrompt(prompt, settings, plannerOutput, coderOutput) {
        return [
            "Agent Smith Coding terminal phase:",
            `- Active VS Code workspace: ${settings.targetWorkspace}`,
            `- Terminal MCP root: ${settings.targetWorkspace}`,
            `- Terminal model: ${settings.browserModel}`,
            "",
            "Strict terminal boundary:",
            "- This phase is validation only.",
            "- Do not inspect workspace files with terminal commands.",
            "- Do not run ls, cat, find, grep, rg, sed, awk, head, tail, pwd, tree, or similar inspection commands.",
            "- Do not edit files.",
            "- Do not ask coder to retry.",
            "- Do not create an automatic repair loop.",
            "- Run at most one compile/test/build/lint validation command.",
            "- If coder did not provide an exact validation command, report that blocker instead of probing the filesystem.",
            "",
            "Planner output:",
            plannerOutput || "<planner returned no output>",
            "",
            "Coder output:",
            coderOutput || "<coder returned no output>",
            "",
            "Terminal phase task:",
            "- Read the coder output.",
            "- If it contains a line starting with \"Validation command:\", run that exact command once with Terminal MCP.",
            "- If the coder says validation is unavailable or not needed, report that and do not run a command.",
            "- If the validation command is missing, report: validation command missing from coder output.",
            "- Return command, cwd, exit code, timeout state, and useful stdout/stderr.",
            "",
            "Original user prompt for context only:",
            prompt
        ].join("\n");
    }
    summarizeForLog(text, maxChars) {
        const compact = text.replace(/\s+/g, " ").trim();
        if (!compact) {
            return "<empty>";
        }
        return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
    }
    clipForChat(text, maxChars) {
        if (text.length <= maxChars) {
            return text;
        }
        return `${text.slice(0, maxChars)}\n\n...[truncated]`;
    }
    addMessage(role, content, agent) {
        this.messages.push({ role, content, agent });
        this.postState();
    }
    appendRuntimeLog(index, line, status) {
        const message = this.messages[index];
        if (!message) {
            return;
        }
        const cleanLine = line.replace(/\s+/g, " ").trim();
        if (!cleanLine) {
            return;
        }
        const logs = message.logs ?? [];
        if (logs[logs.length - 1] !== cleanLine) {
            message.logs = [...logs, cleanLine].slice(-80);
        }
        if (status && message.pending) {
            message.status = status;
        }
        this.postState();
    }
    updateRuntimeStatus(index, status) {
        const message = this.messages[index];
        if (!message || !message.pending) {
            return;
        }
        message.status = status;
        this.postState();
    }
    createFastAgentLogTail(settings) {
        const logPath = this.fastAgentLogPath(settings);
        try {
            return { offset: (0, fs_1.existsSync)(logPath) ? (0, fs_1.statSync)(logPath).size : 0, carry: "" };
        }
        catch {
            return { offset: 0, carry: "" };
        }
    }
    pollFastAgentLog(tail, settings, assistantIndex, onEvent) {
        const logPath = this.fastAgentLogPath(settings);
        if (!(0, fs_1.existsSync)(logPath)) {
            return tail;
        }
        try {
            const buffer = (0, fs_1.readFileSync)(logPath);
            const nextOffset = buffer.length;
            const start = tail.offset <= nextOffset ? tail.offset : 0;
            if (nextOffset <= start) {
                return tail;
            }
            const text = tail.carry + buffer.subarray(start).toString("utf8");
            const lines = text.split(/\r?\n/);
            const carry = text.endsWith("\n") || text.endsWith("\r") ? "" : lines.pop() ?? "";
            for (const line of lines) {
                const event = this.formatFastAgentLogLine(line);
                if (!event) {
                    continue;
                }
                onEvent?.();
                this.appendRuntimeLog(assistantIndex, event.line, event.status);
            }
            return { offset: nextOffset, carry };
        }
        catch {
            return tail;
        }
    }
    fastAgentLogPath(settings) {
        return (0, path_1.join)(settings.projectPath, "fastagent.jsonl");
    }
    createTerminalLogTail(settings) {
        const logPath = this.terminalLogPath(settings);
        try {
            return { offset: (0, fs_1.existsSync)(logPath) ? (0, fs_1.statSync)(logPath).size : 0, carry: "" };
        }
        catch {
            return { offset: 0, carry: "" };
        }
    }
    pollTerminalLog(tail, settings, assistantIndex, onEvent, onFormattedEvent) {
        const logPath = this.terminalLogPath(settings);
        if (!(0, fs_1.existsSync)(logPath)) {
            return tail;
        }
        try {
            const buffer = (0, fs_1.readFileSync)(logPath);
            const nextOffset = buffer.length;
            const start = tail.offset <= nextOffset ? tail.offset : 0;
            if (nextOffset <= start) {
                return tail;
            }
            const text = tail.carry + buffer.subarray(start).toString("utf8");
            const lines = text.split(/\r?\n/);
            const carry = text.endsWith("\n") || text.endsWith("\r") ? "" : lines.pop() ?? "";
            for (const line of lines) {
                const event = this.formatTerminalLogLine(line);
                if (!event) {
                    continue;
                }
                onEvent?.();
                onFormattedEvent?.(event);
                this.appendRuntimeLog(assistantIndex, event.line, event.status);
            }
            return { offset: nextOffset, carry };
        }
        catch {
            return tail;
        }
    }
    terminalLogPath(settings) {
        return settings.memoryFilePath.replace(/\.jsonl$/i, ".terminal.jsonl");
    }
    formatTerminalLogLine(line) {
        if (!line.trim()) {
            return undefined;
        }
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            return undefined;
        }
        const command = this.terminalCommandText(entry.command);
        const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
        if (entry.event === "start") {
            return {
                line: `agent terminal working: ${command} started${cwd ? ` in ${cwd}` : ""}`,
                status: `Agent terminal working: running ${command}...`
            };
        }
        if (entry.event === "finish") {
            const timedOut = Boolean(entry.timed_out);
            const exitText = timedOut ? "timed out" : `exited ${entry.exit_code ?? "unknown"}`;
            const output = this.terminalOutputSummary(entry.output);
            return {
                line: [`agent terminal finished: ${command} ${exitText}`, output ? `output: ${output}` : ""].filter(Boolean).join(" | "),
                status: timedOut || entry.exit_code !== 0
                    ? `Agent terminal finished with failure: ${command}`
                    : `Agent terminal finished successfully: ${command}`
            };
        }
        return undefined;
    }
    terminalCommandText(value) {
        if (Array.isArray(value)) {
            return value.map((part) => String(part)).join(" ").trim();
        }
        return typeof value === "string" ? value : "command";
    }
    terminalOutputSummary(value) {
        if (typeof value !== "string") {
            return "";
        }
        const lines = value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 6);
        const compact = lines.join(" | ").replace(/\s+/g, " ").trim();
        return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
    }
    formatFastAgentLogLine(line) {
        if (!line.trim()) {
            return undefined;
        }
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            return undefined;
        }
        const message = String(entry.message ?? "");
        const data = entry.data?.data ?? {};
        const namespaceAgent = this.agentFromNamespace(entry.namespace);
        const agent = this.humanAgentName(data.agent_name) || namespaceAgent;
        const server = this.humanAgentName(data.server_name);
        const tool = this.humanToolName(data.tool_name);
        const status = this.statusForFastAgentEvent(data.agent_name, data.server_name, data.tool_name);
        if (message === "Requesting tool call" && tool) {
            const owner = server || agent || "mcp";
            return {
                line: `agent ${owner} working: ${tool} started`,
                status
            };
        }
        if (message === "Tool call completed" && tool) {
            const owner = server || agent || "mcp";
            const state = data.tool_state ? String(data.tool_state) : "completed";
            return {
                line: `agent ${owner} finished: ${tool} ${state}`,
                status: state === "failed" ? `Agent ${owner} tool failed...` : status
            };
        }
        const streamMatch = message.match(/^Streaming complete - Model: ([^,]+), Input tokens: ([0-9]+), Output tokens: ([0-9]+)/);
        if (streamMatch) {
            const owner = agent || "model";
            return {
                line: `agent ${owner} model response complete: ${streamMatch[2]} input tokens, ${streamMatch[3]} output tokens`,
                status: `Agent ${owner} working...`
            };
        }
        if (message.includes("Provider error") || message.includes("timed out")) {
            return {
                line: message,
                status: "Local model provider is retrying..."
            };
        }
        return undefined;
    }
    agentFromNamespace(value) {
        const namespace = typeof value === "string" ? value : "";
        const match = namespace.match(/\.llm_[^.]+\.([^.]+)$/) ?? namespace.match(/\.mcp_aggregator\.([^.]+)$/);
        return match?.[1] ? this.humanAgentName(match[1]) : "";
    }
    humanAgentName(value) {
        const raw = typeof value === "string" ? value : "";
        const normalized = raw.replace(/^filesystem$/, "file system").replace(/_/g, " ").trim();
        return normalized;
    }
    humanToolName(value) {
        const raw = typeof value === "string" ? value : "";
        return raw
            .replace(/^[a-zA-Z0-9_-]+__/, "")
            .replace(/_/g, " ")
            .trim();
    }
    statusForFastAgentEvent(agentName, serverName, toolName) {
        const combined = [agentName, serverName, toolName].filter(Boolean).join(" ").toLowerCase();
        if (combined.includes("browser") || combined.includes("playwright")) {
            return "Agent browser working...";
        }
        if (combined.includes("filesystem") || combined.includes("file system") || combined.includes("file_")) {
            return "Agent file system working...";
        }
        if (combined.includes("memory")) {
            return "Agent memory working...";
        }
        if (combined.includes("terminal") || combined.includes("run command") || combined.includes("run_command")) {
            return "Agent terminal working...";
        }
        if (combined.includes("planner") || combined.includes("sequential")) {
            return "Agent planner working...";
        }
        if (combined.includes("coder") || combined.includes("coding")) {
            return "Agent coder working...";
        }
        return "Agent working...";
    }
    containsUnexecutedToolCall(content) {
        return this.unexecutedToolCallName(content) !== undefined ||
            /<\/tool_call>|"tool_calls"\s*:|"function_call"\s*:/.test(content);
    }
    containsProviderInternalError(content) {
        return /I hit an internal error while calling the model|generic request failed|XML syntax error|api_error/i.test(content);
    }
    unexecutedToolCallName(content) {
        const xmlLike = content.match(/<function=([a-zA-Z0-9_.:-]+)>/);
        if (xmlLike?.[1]) {
            return xmlLike[1];
        }
        const jsonName = content.match(/"name"\s*:\s*"([a-zA-Z0-9_.:-]+)"/);
        if (jsonName?.[1] && /"tool_calls"\s*:|"function_call"\s*:/.test(content)) {
            return jsonName[1];
        }
        return undefined;
    }
    postState() {
        this.saveMessages();
        this.view?.webview.postMessage({
            type: "state",
            messages: this.messages,
            busy: this.busy,
            defaultAgent: this.defaultAgent(),
            workspace: this.readSettings().targetWorkspace,
            extensionVersion: this.extensionVersion(),
            defaultCodingModel: this.defaultCodingModel(),
            defaultBrowserModel: this.defaultBrowserModel(),
            codingModelOptions: this.codingModelOptions(),
            browserModelOptions: this.browserModelOptions()
        });
    }
    loadMessages() {
        const stored = this.loadMessagesFromStorageFile() ??
            this.context.workspaceState.get(ChatViewProvider.storageKey);
        if (!Array.isArray(stored)) {
            return [];
        }
        return stored
            .filter((item) => {
            if (!item || typeof item !== "object") {
                return false;
            }
            const candidate = item;
            return ((candidate.role === "user" ||
                candidate.role === "assistant" ||
                candidate.role === "system") &&
                typeof candidate.content === "string" &&
                (candidate.model === undefined || typeof candidate.model === "string") &&
                (candidate.status === undefined || typeof candidate.status === "string") &&
                (candidate.logs === undefined ||
                    (Array.isArray(candidate.logs) &&
                        candidate.logs.every((line) => typeof line === "string"))) &&
                (candidate.agent === undefined ||
                    candidate.agent === "coding_workflow" ||
                    candidate.agent === "coder" ||
                    candidate.agent === "evaluator" ||
                    candidate.agent === "filesystem" ||
                    candidate.agent === "memory" ||
                    candidate.agent === "browser" ||
                    candidate.agent === "planner" ||
                    candidate.agent === "terminal"));
        })
            .map((message) => ({ ...message, pending: false, status: undefined }))
            .slice(-200);
    }
    saveMessages() {
        const history = this.messages.slice(-200);
        void this.context.workspaceState.update(ChatViewProvider.storageKey, history);
        this.saveMessagesToStorageFile(history);
    }
    loadMessagesFromStorageFile() {
        const path = this.storageFilePath();
        if (!path || !(0, fs_1.existsSync)(path)) {
            return undefined;
        }
        try {
            return JSON.parse((0, fs_1.readFileSync)(path, "utf8"));
        }
        catch {
            return undefined;
        }
    }
    saveMessagesToStorageFile(messages) {
        const path = this.storageFilePath();
        if (!path) {
            return;
        }
        try {
            (0, fs_1.mkdirSync)((0, path_1.dirname)(path), { recursive: true });
            (0, fs_1.writeFileSync)(path, JSON.stringify(messages), "utf8");
        }
        catch {
            // Workspace memento remains the primary store if filesystem storage is unavailable.
        }
    }
    storageFilePath() {
        const root = this.context.storageUri ?? this.context.globalStorageUri;
        return root ? (0, path_1.join)(root.fsPath, "chat-history.json") : undefined;
    }
    defaultAgent() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("defaultAgent");
        return configured ?? "coding_workflow";
    }
    extensionVersion() {
        const version = this.context.extension.packageJSON.version;
        return typeof version === "string" && version.trim() ? version.trim() : "unknown";
    }
    readSettings(requestedCodingModel, requestedBrowserModel) {
        const config = vscode.workspace.getConfiguration("agentSmithCoding");
        const projectPath = config.get("projectPath") ?? "/Users/politrons/development/agent_smith_coding";
        const targetWorkspace = config.get("targetWorkspace")?.trim();
        const activeWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const resolvedPython = this.resolvePythonPath(projectPath, config.get("pythonPath"));
        const resolvedWorkspace = targetWorkspace || activeWorkspace || projectPath;
        const warnings = [...resolvedPython.warnings];
        const installedModels = this.installedOllamaModels(warnings);
        const codingModel = this.normalizeModel(requestedCodingModel || config.get("coderModel") || this.defaultCodingModel());
        const browserModel = this.normalizeModel(requestedBrowserModel || config.get("browserModel") || this.defaultBrowserModel());
        const memoryModel = this.configuredAgentModel(config, "memoryModel", browserModel);
        const plannerModel = this.configuredAgentModel(config, "plannerModel", browserModel);
        const filesystemModel = this.configuredAgentModel(config, "filesystemModel", browserModel);
        const coderModel = this.configuredAgentModel(config, "coderModel", codingModel);
        this.warnIfOllamaModelMissing("coding", coderModel, installedModels, warnings);
        this.warnIfOllamaModelMissing("browser", browserModel, installedModels, warnings);
        return {
            pythonPath: resolvedPython.pythonPath,
            projectPath,
            targetWorkspace: resolvedWorkspace,
            memoryFilePath: this.memoryFilePathForWorkspace(resolvedWorkspace),
            model: coderModel,
            codingModel: coderModel,
            memoryModel,
            plannerModel,
            filesystemModel,
            browserModel,
            coderModel,
            warnings
        };
    }
    ensureMemoryDirectory(settings) {
        try {
            (0, fs_1.mkdirSync)((0, path_1.dirname)(settings.memoryFilePath), { recursive: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            settings.warnings.push(`Could not create workspace memory directory: ${message}`);
        }
    }
    buildWorkspaceAwarePrompt(prompt, settings, includeSnapshot = true) {
        const sections = [
            "Agent Smith Coding request metadata:",
            `- Active VS Code workspace: ${settings.targetWorkspace}`,
            `- Filesystem MCP root: ${settings.targetWorkspace}`,
            `- Workspace memory file: ${settings.memoryFilePath}`,
            `- Coding model: ${settings.codingModel}`,
            `- Browser model: ${settings.browserModel}`,
            `- Agent model mapping: planner=${settings.plannerModel}, filesystem=${settings.filesystemModel}, browser=${settings.browserModel}, coder=${settings.coderModel}`,
            "",
            "Current request boundary:",
            "- The latest User prompt at the end of this message is the only active task.",
            "- Memory MCP, chat history, previous prompts, previous plans, and the workspace snapshot are context only.",
            "- Do not execute old prompts, old planned tasks, old suggestions, or remembered next steps unless the latest User prompt explicitly asks for them again.",
            "- If memory or old chat conflicts with the latest User prompt or current workspace files, the latest User prompt and current files win.",
            "",
            "Single-pass agent workflow:",
            "- Planner is read-only. It decides the current task and delegation plan once; it does not edit files, browse, or run commands.",
            "- Coder executes the implementation phase once with Filesystem, Memory, and Browser access.",
            "- Coder must not run terminal validation directly. Coder must finish implementation with one exact validation command for Terminal.",
            "- Terminal runs that one validation command once and reports the command, cwd, exit code, timeout state, and useful stdout/stderr.",
            "- If any phase cannot complete its responsibility, stop and report the blocker. Do not delegate back and forth between agents.",
            "",
            "Workspace interpretation:",
            "- Interpret references such as \"this project\", \"este proyecto\", \"this repo\", \"este repo\", \"aqui\", \"aquí\", \"the workspace\", and \"el workspace\" as the active VS Code workspace above.",
            "- Before planning or coding, read Memory MCP for this workspace as project-state context only. Memory is useful context, but it can be stale.",
            "- Always use Filesystem MCP inside the active workspace to inspect current files before explaining, planning implementation, or editing.",
            "- Do not ask the user what kind of project this is when the active workspace exists. Infer the project type from project/build markers, README files, and source directories.",
            "- Before editing code, read the current source files that will be touched. Any file you create, move, or modify must be based on the actual workspace contents.",
            "",
            "Mandatory preflight for every prompt:",
            "1. Load Memory MCP context for this workspace.",
            "2. Inspect the active workspace with Filesystem MCP: list the root and read relevant project markers and source files.",
            "3. Build a short mental model of the project structure before answering.",
            "4. If implementing, apply the file changes through Filesystem MCP and then provide one exact validation command for Terminal.",
            "5. If explaining, base the explanation on Memory plus the current files, not on generic assumptions.",
            "",
            "Routing rules for English and Spanish prompts:",
            "- If the user asks to create, make, convert, add, update, change, implement, fix, migrate, scaffold, generate, write, move, or delete files, route the work to the Filesystem/Coder path and apply the requested changes.",
            "- Spanish equivalents such as haz, crea, crear, convierte, convertir, mete, añade, agrega, instala, usa, utiliza, controla, maneja, reemplaza, sustituye, refactoriza, modifica, cambia, actualiza, implementa, arregla, migra, genera, escribe, mueve, or borra are also implementation requests.",
            "- Natural-language requests such as \"me gustaría que\", \"quiero que\", \"necesito que\", \"puedes\", \"podrías\", \"I want you to\", \"I need you to\", \"can you\", or \"could you\" are implementation requests when paired with edit/install/use/replace/refactor/handle verbs.",
            "- Do not answer implementation requests with optional next steps or \"Would you like me to...\" / \"Quieres que...\". Execute the requested change unless required information is missing or the operation is destructive.",
            "- Use Browser MCP when the task depends on current external documentation, package metadata, dependency coordinates, framework setup, public APIs, release notes, or anything likely to have changed.",
            "- For build-system or dependency-manager changes, infer the target ecosystem from the workspace and user request, then update the canonical build/dependency files for that ecosystem. Do not rely on hardcoded technology-specific instructions.",
            "- For new or changed functionality, infer the project's testing approach from the workspace and create/update focused tests using the standard conventions for the detected technology stack.",
            "- The possible languages, frameworks, build systems, and test frameworks are unbounded. If you are not sure how to test or validate the detected stack, use Browser MCP to research official documentation or primary sources before editing.",
            "- Coder must end implementation responses with exactly one line in this format: Validation command: command=<executable>; args=<JSON array>; cwd=<relative cwd>",
            "- If no safe validation command exists, write: Validation command: unavailable - <reason>",
            "- For read-only explanations or analysis tasks with no file changes, write: Validation command: unavailable - read-only request; no validation needed",
            "- Terminal MCP executes the detected compile/test/build validation command once. If it fails, report the failure and stdout/stderr; do not start an automatic repair loop.",
            "- A workflow is only fully validated when Terminal MCP has run the command successfully. If validation fails, report the exact blocker for the next user prompt.",
            "- After meaningful inspections, decisions, or edits, store concise durable observations in Memory MCP for this workspace. Store completed project state, not a backlog of future tasks. Do not store secrets or sensitive personal data.",
            "- Never print raw function-call or tool-call markup such as <function=...> as the final answer. If a tool call was needed but did not execute, say that plainly.",
            ""
        ];
        if (includeSnapshot) {
            sections.push("VS Code workspace snapshot before MCP execution:", "Use this as starting context and verify with Filesystem MCP before editing. It exists specifically to avoid generic answers such as asking what type of project is open.", this.buildWorkspaceSnapshot(settings.targetWorkspace, 180, 24, 32_000), "");
        }
        sections.push("User prompt:", prompt);
        return sections.join("\n");
    }
    buildWorkspaceSnapshot(workspacePath, maxFiles = 180, maxImportantFiles = 24, maxContentChars = 32_000) {
        if (!(0, fs_1.existsSync)(workspacePath)) {
            return `Workspace snapshot unavailable. Path does not exist: ${workspacePath}`;
        }
        const files = this.collectWorkspaceFiles(workspacePath, maxFiles);
        const sections = [
            "Workspace snapshot:",
            `Root: ${workspacePath}`,
            "Files:",
            ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- <empty or unreadable workspace>"])
        ];
        const importantFiles = files.filter((file) => this.isImportantSnapshotFile(file)).slice(0, maxImportantFiles);
        let remainingChars = maxContentChars;
        for (const file of importantFiles) {
            if (remainingChars <= 0) {
                break;
            }
            const absolutePath = (0, path_1.join)(workspacePath, file);
            try {
                const content = (0, fs_1.readFileSync)(absolutePath, "utf8");
                if (content.includes("\u0000")) {
                    continue;
                }
                const clipped = content.length > 4000 ? `${content.slice(0, 4000)}\n...[truncated]` : content;
                if (clipped.length > remainingChars) {
                    continue;
                }
                sections.push("", `--- ${file} ---`, clipped);
                remainingChars -= clipped.length;
            }
            catch {
                // Snapshot context is best-effort; unreadable files are still listed above.
            }
        }
        return sections.join("\n");
    }
    collectWorkspaceFiles(workspacePath, maxFiles = 180) {
        const files = [];
        const visit = (directory, depth) => {
            if (depth > 7 || files.length >= maxFiles) {
                return;
            }
            let entries;
            try {
                entries = (0, fs_1.readdirSync)(directory, { withFileTypes: true })
                    .sort((left, right) => left.name.localeCompare(right.name));
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (files.length >= maxFiles || this.shouldSkipSnapshotEntry(entry.name)) {
                    continue;
                }
                const absolutePath = (0, path_1.join)(directory, entry.name);
                const relativePath = (0, path_1.relative)(workspacePath, absolutePath);
                if (entry.isDirectory()) {
                    visit(absolutePath, depth + 1);
                    continue;
                }
                if (!entry.isFile() || this.shouldSkipSnapshotFile(relativePath)) {
                    continue;
                }
                try {
                    if ((0, fs_1.statSync)(absolutePath).size > 512_000) {
                        continue;
                    }
                }
                catch {
                    continue;
                }
                files.push(relativePath);
            }
        };
        visit(workspacePath, 0);
        return files;
    }
    shouldSkipSnapshotEntry(name) {
        return new Set([
            ".git",
            ".hg",
            ".svn",
            ".venv",
            "venv",
            "env",
            "node_modules",
            "dist",
            "build",
            "out",
            "target",
            ".next",
            ".gradle",
            ".idea",
            ".pytest_cache",
            ".mypy_cache",
            ".cache",
            "__pycache__",
            "coverage"
        ]).has(name);
    }
    shouldSkipSnapshotFile(path) {
        return /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|tar|gz|tgz|jar|class|pyc|pyo|so|dylib|dll|vsix)$/i.test(path);
    }
    isImportantSnapshotFile(path) {
        const name = (0, path_1.basename)(path).toLowerCase();
        const rootFiles = new Set([
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
            "gradle.properties",
            "package.json",
            "pyproject.toml",
            "requirements.txt",
            "readme.md",
            "fast-agent.yaml",
            "tsconfig.json"
        ]);
        return rootFiles.has(name) || /^src\//.test(path) || /^app\//.test(path);
    }
    memoryFilePathForWorkspace(workspacePath) {
        const root = this.context.globalStorageUri ?? this.context.storageUri;
        const storageRoot = root?.fsPath ?? (0, path_1.join)(workspacePath, ".agent-smith-coding");
        const normalized = workspacePath.trim() || "default-workspace";
        const hash = (0, crypto_1.createHash)("sha256").update(normalized).digest("hex").slice(0, 16);
        const slug = this.slugifyWorkspaceName((0, path_1.basename)(normalized) || "workspace");
        return (0, path_1.join)(storageRoot, "workspace-memory", `${slug}-${hash}.jsonl`);
    }
    slugifyWorkspaceName(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
    }
    defaultCodingModel() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("defaultCodingModel");
        const legacyConfigured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("defaultModel");
        return this.normalizeModel(configured || legacyConfigured || "qwen3-coder:30b");
    }
    defaultBrowserModel() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("defaultBrowserModel");
        return this.normalizeModel(configured || this.preferredToolModel());
    }
    codingModelOptions() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("codingModelOptions");
        const fallback = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("modelOptions");
        const defaults = [
            "qwen3-coder:30b",
            "qwen3.5:latest",
            "gpt-oss:20b",
            "llama3.1:8b",
            "gemma4:31b",
            "qwen2.5-coder:32b"
        ];
        const options = (configured && configured.length > 0 ? configured : fallback && fallback.length > 0 ? fallback : defaults)
            .map((model) => this.normalizeModel(model))
            .filter(Boolean);
        return Array.from(new Set([this.defaultCodingModel(), ...options]));
    }
    browserModelOptions() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("browserModelOptions");
        const fallback = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("modelOptions");
        const defaults = [
            "qwen3.5:latest",
            "gpt-oss:20b",
            "llama3.1:8b",
            "qwen3-coder:30b",
            "gemma4:31b",
            "qwen2.5-coder:32b"
        ];
        const options = (configured && configured.length > 0 ? configured : fallback && fallback.length > 0 ? fallback : defaults)
            .map((model) => this.normalizeModel(model))
            .filter(Boolean);
        return Array.from(new Set([this.defaultBrowserModel(), ...options]));
    }
    configuredAgentModel(config, key, fallback) {
        return this.normalizeModel(config.get(key) || fallback);
    }
    installedOllamaModels(warnings) {
        const now = Date.now();
        if (this.ollamaModelsCache && now - this.ollamaModelsCache.checkedAt < 30_000) {
            if (this.ollamaModelsCache.error) {
                warnings.push(this.ollamaModelsCache.error);
            }
            return this.ollamaModelsCache.models;
        }
        try {
            const outputText = (0, child_process_1.execFileSync)("ollama", ["list"], {
                encoding: "utf8",
                timeout: 2500
            });
            const models = outputText
                .split(/\r?\n/)
                .slice(1)
                .map((line) => line.trim().split(/\s+/)[0])
                .filter((model) => Boolean(model) && model !== "NAME")
                .map((model) => this.normalizeModel(model));
            this.ollamaModelsCache = { checkedAt: now, models };
            return models;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const warning = `Could not inspect local Ollama models. Agent Smith will try ${this.preferredToolModel()} and, if missing, you should run: ollama pull ${this.preferredToolModel()}. Details: ${message}`;
            warnings.push(warning);
            this.ollamaModelsCache = { checkedAt: now, models: [], error: warning };
            return [];
        }
    }
    preferredToolModel() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("toolModel");
        return this.normalizeModel(configured || "qwen3.5:latest");
    }
    warnIfOllamaModelMissing(label, model, installedModels, warnings) {
        if (installedModels.length > 0 && !installedModels.includes(model)) {
            warnings.push(`Ollama model for ${label} is not installed: ${model}. Install it with: ollama pull ${model}`);
        }
    }
    normalizeModel(model) {
        return model.replace(/^generic\./, "").trim();
    }
    toFastAgentModel(model) {
        const normalized = this.normalizeModel(model);
        return normalized.startsWith("generic.") ? normalized : `generic.${normalized}`;
    }
    promptLikelyNeedsBrowser(prompt) {
        return /\b(browser|internet|web|docs?|documentation|official|latest|current|version|versions|dependency|dependencies|dependencia|dependencias|package|packages|library|libraries|release|api|framework|plugin|coordinate|coordinates|registry|repository|repositorio)\b/i.test(prompt);
    }
    phaseForElapsed(prompt, elapsedSeconds) {
        if (elapsedSeconds < 15) {
            return "planner";
        }
        if (elapsedSeconds < 30) {
            return "file system";
        }
        if (this.promptLikelyNeedsBrowser(prompt) && elapsedSeconds < 60) {
            return "browser";
        }
        return "coder";
    }
    isImplementationPrompt(prompt) {
        const actionVerb = /\b(haz|hacer|crea|crear|convierte|convertir|mete|a(?:ñ|n)ade|agrega|instala|instalar|usa|usar|utiliza|utilizar|controla|controlar|maneja|manejar|reemplaza|reemplazar|sustituye|sustituir|refactoriza|refactorizar|modifica|cambia|actualiza|implementa|arregla|corrige|migra|genera|escribe|mueve|borra|create|make|convert|add|update|change|modify|implement|fix|migrate|scaffold|generate|write|move|delete|install|use|replace|refactor|handle)\b/i;
        const naturalRequest = /\b(me gustar[ií]a que|quiero que|necesito que|puedes|podr[ií]as|please|i want you to|i need you to|can you|could you)\b/i;
        return actionVerb.test(prompt) || (naturalRequest.test(prompt) && actionVerb.test(prompt));
    }
    shouldRetryNonActionableAnswer(prompt, content) {
        if (!this.isImplementationPrompt(prompt) || !content.trim()) {
            return false;
        }
        const lower = content.toLowerCase();
        const asksForPermission = /would you like me to|do you want me to|should i|shall i|quieres que|te gustaria que|te gustaría que|deseas que|quieres que lo|puedo crear|puedo hacerlo|quieres continuar/.test(lower);
        const optionalNextSteps = /next steps|siguientes pasos|would you like|opciones|1\.\s+\*\*|2\.\s+\*\*/.test(lower);
        const analysisOnly = /project overview|current state|current implementation|estado actual|resumen del proyecto|implementaci[oó]n actual/.test(lower);
        const asksForWorkspaceBasics = /qu[eé] tipo de proyecto|what type of project|tell me more about your project|conocer mejor tu proyecto|podr[ií]as decirme|could you tell me|provide more details|proporcionar m[aá]s informaci[oó]n|necesito m[aá]s informaci[oó]n/.test(lower);
        const genericIdeGreeting = /soy tu asistente ide local|i am your local ide assistant|i'm your local ide assistant|estoy aqu[ií] para ayudarte/.test(lower);
        const changeEvidence = /\b(created|updated|modified|changed|wrote|added|moved|deleted|creado|actualizado|modificado|cambiado|escrito|añadido|agregado|movido|borrado|eliminado)\b|changed files|files changed|archivos modificados|he creado|he actualizado|he modificado|se ha creado|se ha actualizado|se ha modificado/i.test(content);
        return !changeEvidence && (asksForPermission ||
            optionalNextSteps ||
            analysisOnly ||
            asksForWorkspaceBasics ||
            genericIdeGreeting);
    }
    statusForToolCall(toolName) {
        const lower = toolName.toLowerCase();
        if (lower.includes("browser") || lower.includes("playwright")) {
            return "Agent browser working...";
        }
        if (lower.includes("filesystem") || lower.includes("file_system") || lower.includes("file-system")) {
            return "Agent file system working...";
        }
        if (lower.includes("sequential") || lower.includes("thinking") || lower.includes("planner")) {
            return "Agent planner working...";
        }
        if (lower.includes("memory")) {
            return "Agent memory working...";
        }
        if (lower.includes("terminal") || lower.includes("run_command") || lower.includes("command")) {
            return "Agent terminal working...";
        }
        return "Agent working...";
    }
    statusFromStderr(text, model) {
        const lower = text.toLowerCase();
        if (lower.includes("browser") || lower.includes("playwright")) {
            return "Agent browser working...";
        }
        if (lower.includes("filesystem") || lower.includes("file system")) {
            return "Agent file system working...";
        }
        if (lower.includes("sequential") || lower.includes("planner")) {
            return "Agent planner working...";
        }
        if (lower.includes("coder") || lower.includes("coding")) {
            return "Agent coder working...";
        }
        if (lower.includes("memory")) {
            return "Agent memory working...";
        }
        if (lower.includes("terminal") || lower.includes("run_command")) {
            return "Agent terminal working...";
        }
        if (lower.includes("retrying")) {
            return `Waiting on ${model}. The local model timed out once and FastAgent is retrying...`;
        }
        if (lower.includes("provider error") || lower.includes("timed out")) {
            return `Waiting for ${model}. Local Ollama models can take a while to warm up...`;
        }
        if (lower.includes("mcp")) {
            return "Preparing MCP tools and project context...";
        }
        return `Thinking with ${model}...`;
    }
    logLineFromProcessOutput(text) {
        const compact = text.replace(/\s+/g, " ").trim();
        const lower = compact.toLowerCase();
        if (!compact) {
            return "";
        }
        if (lower.includes("sequential") || lower.includes("planner")) {
            return "agent planner working: sequential thinking activity detected";
        }
        if (lower.includes("memory")) {
            return "agent memory working: project context activity detected";
        }
        if (lower.includes("browser") || lower.includes("playwright")) {
            return "agent browser working: web research activity detected";
        }
        if (lower.includes("filesystem") || lower.includes("file system")) {
            return "agent file system working: file operation activity detected";
        }
        if (lower.includes("coder") || lower.includes("coding")) {
            return "agent coder working: implementation activity detected";
        }
        if (lower.includes("terminal") || lower.includes("run_command")) {
            return "agent terminal working: command execution activity detected";
        }
        if (lower.includes("retrying")) {
            return compact;
        }
        if (lower.includes("provider error") || lower.includes("timed out")) {
            return compact;
        }
        if (lower.includes("mcp")) {
            return `mcp: ${compact}`;
        }
        return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
    }
    resolvePythonPath(projectPath, configuredPythonPath) {
        const warnings = [];
        const configured = configuredPythonPath?.trim();
        if (configured) {
            if (!(0, path_1.isAbsolute)(configured) || (0, fs_1.existsSync)(configured)) {
                return { pythonPath: configured, warnings };
            }
            warnings.push(`Configured Python does not exist: ${configured}`);
        }
        const projectVenvPython = (0, path_1.join)(projectPath, ".venv", "bin", "python");
        const candidates = [
            projectVenvPython,
            "/opt/homebrew/bin/python3.14",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3"
        ];
        for (const candidate of candidates) {
            if ((0, fs_1.existsSync)(candidate)) {
                if (candidate !== projectVenvPython) {
                    warnings.push([
                        `Project virtualenv not found: ${projectVenvPython}`,
                        `Using fallback Python: ${candidate}`,
                        "If the agent exits with ModuleNotFoundError, run the root setup:",
                        "cd /Users/politrons/development/agent_smith_coding",
                        "/opt/homebrew/bin/python3.14 -m venv .venv",
                        ". .venv/bin/activate",
                        "pip install -U pip",
                        "pip install -e .",
                        "npm install"
                    ].join("\n"));
                }
                return { pythonPath: candidate, warnings };
            }
        }
        warnings.push([
            `Project virtualenv not found: ${projectVenvPython}`,
            "No absolute Python candidate was found. Trying python3 from PATH."
        ].join("\n"));
        return { pythonPath: "python3", warnings };
    }
    mergePythonPath(projectPath) {
        const sourcePath = `${projectPath}/src`;
        const current = process.env.PYTHONPATH;
        return current ? `${sourcePath}:${current}` : sourcePath;
    }
    accentColor() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("accentColor");
        if (configured && /^#[0-9a-fA-F]{6}$/.test(configured.trim())) {
            return configured.trim();
        }
        return "#00ff66";
    }
    chatFontFamily() {
        const configured = vscode.workspace
            .getConfiguration("agentSmithCoding")
            .get("chatFontFamily");
        const value = configured?.trim() ?? "";
        if (!value || /[;{}<>]/.test(value)) {
            return "";
        }
        return value;
    }
    renderHtml(webview) {
        const nonce = makeNonce();
        const accentColor = this.accentColor();
        const chatFontFamily = this.chatFontFamily();
        const agentIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", "agent.png"));
        const initialState = JSON.stringify({
            messages: this.messages,
            busy: this.busy,
            defaultAgent: this.defaultAgent(),
            workspace: this.readSettings().targetWorkspace,
            extensionVersion: this.extensionVersion(),
            defaultCodingModel: this.defaultCodingModel(),
            defaultBrowserModel: this.defaultBrowserModel(),
            codingModelOptions: this.codingModelOptions(),
            browserModelOptions: this.browserModelOptions()
        }).replace(/</g, "\\u003c");
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Agent Smith Coding v${this.extensionVersion()}</title>
  <style>
    :root {
      color-scheme: light dark;
      --open-agent-accent: ${accentColor};
      --open-agent-accent-soft: color-mix(in srgb, ${accentColor} 16%, transparent);
      --open-agent-font: ${chatFontFamily || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"};
      --matrix-bg: #020604;
      --matrix-panel: color-mix(in srgb, #03150a 88%, var(--vscode-editor-background) 12%);
      --matrix-panel-soft: color-mix(in srgb, #062011 72%, transparent);
      --matrix-border: color-mix(in srgb, var(--open-agent-accent) 34%, #0c3f21 66%);
      --matrix-text: color-mix(in srgb, var(--open-agent-accent) 42%, var(--vscode-foreground) 58%);
      --matrix-muted: color-mix(in srgb, var(--open-agent-accent) 50%, var(--vscode-descriptionForeground) 50%);
      --matrix-shadow: 0 0 16px color-mix(in srgb, var(--open-agent-accent) 22%, transparent);
    }

    body {
      margin: 0;
      padding: 0;
      color: var(--matrix-text);
      background:
        linear-gradient(180deg, rgba(0, 255, 102, 0.05), transparent 24%),
        radial-gradient(circle at 16% 0%, var(--open-agent-accent-soft), transparent 30%),
        radial-gradient(circle at 100% 12%, rgba(111, 255, 177, 0.08), transparent 24%),
        var(--matrix-bg);
      font-family: var(--open-agent-font);
      font-size: var(--vscode-font-size);
      overflow: hidden;
      text-shadow: 0 0 7px color-mix(in srgb, var(--open-agent-accent) 20%, transparent);
    }

    .root {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 0;
      background:
        linear-gradient(90deg, rgba(0, 255, 102, 0.035) 1px, transparent 1px),
        linear-gradient(180deg, rgba(0, 255, 102, 0.028) 1px, transparent 1px);
      background-size: 22px 22px;
    }

    .matrix-rain {
      position: fixed;
      inset: -25% 0 0 0;
      z-index: 0;
      pointer-events: none;
      color: var(--open-agent-accent);
      font-family: var(--open-agent-font);
      font-size: 10px;
      line-height: 1.35;
      letter-spacing: 0.16em;
      opacity: 0.075;
      white-space: pre;
      filter: blur(0.2px);
      animation: matrixRain 26s linear infinite;
    }

    @keyframes matrixRain {
      from { transform: translate3d(0, -6%, 0); }
      to { transform: translate3d(0, 16%, 0); }
    }

    .header {
      display: grid;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--matrix-border);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--open-agent-accent) 12%, #03150a 88%), rgba(2, 10, 5, 0.88)),
        var(--matrix-panel);
      box-shadow: var(--matrix-shadow);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 650;
      color: var(--open-agent-accent);
      letter-spacing: 0.03em;
    }

    .brand-version {
      color: var(--matrix-muted);
      border: 1px solid var(--matrix-border);
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
      background: rgba(1, 18, 8, 0.74);
      box-shadow: inset 0 0 10px rgba(0, 255, 102, 0.08);
    }

    .brand-icon {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      object-fit: cover;
      border: 1px solid var(--matrix-border);
      box-shadow: 0 0 20px color-mix(in srgb, var(--open-agent-accent) 48%, transparent);
      flex: 0 0 auto;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    label {
      color: var(--matrix-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    select,
    textarea,
    button {
      font: inherit;
    }

    select {
      min-width: 0;
      flex: 1;
      color: var(--open-agent-accent);
      background: rgba(1, 18, 8, 0.92);
      border: 1px solid var(--matrix-border);
      border-radius: 4px;
      padding: 4px 6px;
      box-shadow: inset 0 0 12px rgba(0, 255, 102, 0.08);
    }

    .workspace {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--matrix-muted);
      font-size: 12px;
    }

    .messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .message {
      border: 1px solid var(--matrix-border);
      border-radius: 6px;
      padding: 8px;
      background:
        linear-gradient(180deg, rgba(0, 255, 102, 0.045), rgba(0, 0, 0, 0.14)),
        color-mix(in srgb, var(--matrix-panel) 90%, var(--vscode-editor-background) 10%);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      box-shadow: inset 0 0 16px rgba(0, 255, 102, 0.035);
    }

    .message.user {
      border-color: color-mix(in srgb, var(--open-agent-accent) 58%, #ffffff 8%);
      background:
        linear-gradient(90deg, rgba(0, 255, 102, 0.12), rgba(0, 0, 0, 0.08)),
        color-mix(in srgb, #03210f 82%, var(--vscode-input-background) 18%);
    }

    .message.system {
      color: var(--matrix-muted);
      background: transparent;
    }

    .meta {
      margin-bottom: 6px;
      color: var(--open-agent-accent);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .thinking {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--open-agent-accent);
      white-space: normal;
    }

    .activity-log {
      margin-top: 8px;
      padding: 8px;
      border-radius: 5px;
      color: var(--matrix-muted);
      border: 1px solid color-mix(in srgb, var(--open-agent-accent) 20%, transparent);
      background: rgba(0, 14, 5, 0.72);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
    }

    .activity-title {
      margin-bottom: 4px;
      color: var(--open-agent-accent);
      font-family: var(--open-agent-font);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .spinner {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 2px solid color-mix(in srgb, var(--open-agent-accent) 18%, transparent);
      border-top-color: var(--open-agent-accent);
      box-shadow: 0 0 12px color-mix(in srgb, var(--open-agent-accent) 34%, transparent);
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }

    .dots::after {
      content: "";
      animation: dots 1.2s steps(4, end) infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @keyframes dots {
      0% { content: ""; }
      25% { content: "."; }
      50% { content: ".."; }
      75% { content: "..."; }
      100% { content: ""; }
    }

    .empty {
      color: var(--matrix-muted);
      line-height: 1.4;
      padding: 16px 4px;
    }

    .composer {
      display: grid;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--matrix-border);
      background:
        linear-gradient(0deg, color-mix(in srgb, var(--open-agent-accent) 10%, #03150a 90%), rgba(2, 10, 5, 0.9)),
        var(--matrix-panel);
      box-shadow: 0 -8px 18px rgba(0, 255, 102, 0.045);
    }

    textarea {
      width: 100%;
      min-height: 88px;
      resize: vertical;
      box-sizing: border-box;
      color: var(--open-agent-accent);
      background: rgba(0, 12, 4, 0.92);
      border: 1px solid var(--matrix-border);
      border-radius: 5px;
      padding: 8px;
      caret-color: var(--open-agent-accent);
      box-shadow: inset 0 0 18px rgba(0, 255, 102, 0.08);
    }

    textarea::placeholder {
      color: color-mix(in srgb, var(--open-agent-accent) 46%, transparent);
    }

    button {
      border: 0;
      border-radius: 4px;
      padding: 7px 10px;
      color: #001607;
      background: linear-gradient(135deg, var(--open-agent-accent), #b6ffd1);
      cursor: pointer;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      box-shadow: 0 0 14px color-mix(in srgb, var(--open-agent-accent) 30%, transparent);
    }

    button:hover {
      background: linear-gradient(135deg, #b6ffd1, var(--open-agent-accent));
    }

    button.secondary {
      color: var(--open-agent-accent);
      border: 1px solid var(--matrix-border);
      background: rgba(0, 20, 7, 0.85);
    }

    button.secondary:hover {
      color: #001607;
      background: var(--open-agent-accent);
    }

    button.stop-button {
      width: 34px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 34px;
      padding: 0;
      color: #001607;
      border: 1px solid color-mix(in srgb, var(--open-agent-accent) 78%, #b6ffd1 22%);
      background: linear-gradient(135deg, #00ff66, #9dffc2);
      box-shadow:
        0 0 16px color-mix(in srgb, var(--open-agent-accent) 48%, transparent),
        inset 0 0 8px rgba(255, 255, 255, 0.22);
    }

    button.stop-button:hover:not(:disabled) {
      color: #001607;
      background: linear-gradient(135deg, #b6ffd1, var(--open-agent-accent));
      box-shadow:
        0 0 22px color-mix(in srgb, var(--open-agent-accent) 70%, transparent),
        inset 0 0 10px rgba(255, 255, 255, 0.28);
    }

    .stop-symbol {
      width: 11px;
      height: 11px;
      display: block;
      border-radius: 2px;
      background: currentColor;
    }

    button:disabled,
    textarea:disabled,
    select:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="matrix-rain" aria-hidden="true">01001011 00110101 ASC MCP MEMORY WORKSPACE 10110100 01001101
11010010 01101001 FASTAGENT CODER FILESYSTEM 00101101 10101010
00110110 10100101 PLANNER SEQUENTIAL THINKING 01010110 10010011
10101001 01110100 LOCAL MODEL OLLAMA AGENT 11001010 00110101
01011010 10010110 WORKSPACE MEMORY JSONL 01101001 10101100
11100100 01001101 READ GRAPH SEARCH NODES 10010010 01010101
00101101 11001010 PROJECT CONTEXT FILE PATCH 01010101 10110010
10010110 00101101 PYTHON TYPESCRIPT VS CODE 10100101 01011010</div>
  <div class="root">
    <div class="header">
      <div class="brand">
        <img class="brand-icon" src="${agentIconUri}" alt="">
        <div>Agent Smith Coding</div>
        <span class="brand-version" id="extensionVersion">v${this.extensionVersion()}</span>
      </div>
      <div class="row">
        <label for="codingModel">Coding</label>
        <select id="codingModel"></select>
      </div>
      <div class="row">
        <label for="browserModel">Browser</label>
        <select id="browserModel"></select>
        <button class="secondary" id="clear" title="Clear chat">Clear</button>
      </div>
      <div class="workspace" id="workspace"></div>
    </div>

    <div class="messages" id="messages"></div>

    <form class="composer" id="form">
      <textarea id="prompt" placeholder="Ask Agent Smith to inspect, edit, explain, or plan work for this project."></textarea>
      <div class="row">
        <button id="send" type="submit">Send</button>
        <button class="stop-button" id="stop" type="button" title="Stop current agent run" aria-label="Stop current agent run">
          <span class="stop-symbol" aria-hidden="true"></span>
        </button>
        <span class="workspace" id="status"></span>
      </div>
    </form>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = vscode.getState() || ${initialState};

    const codingModel = document.getElementById("codingModel");
    const browserModel = document.getElementById("browserModel");
    const clear = document.getElementById("clear");
    const form = document.getElementById("form");
    const messages = document.getElementById("messages");
    const prompt = document.getElementById("prompt");
    const send = document.getElementById("send");
    const stop = document.getElementById("stop");
    const status = document.getElementById("status");
    const workspace = document.getElementById("workspace");
    const extensionVersion = document.getElementById("extensionVersion");

    renderModelOptions();

    window.addEventListener("message", (event) => {
      if (event.data.type === "state") {
        state = event.data;
        render();
      }
    });

    clear.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text || state.busy) {
        return;
      }
      vscode.postMessage({
        type: "prompt",
        codingModel: codingModel.value,
        browserModel: browserModel.value,
        prompt: text
      });
      prompt.value = "";
    });

    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        form.requestSubmit();
      }
    });

    function render() {
      vscode.setState(state);
      messages.innerHTML = "";
      workspace.textContent = "Workspace: " + (state.workspace || "not set");
      extensionVersion.textContent = "v" + (state.extensionVersion || "unknown");
      status.textContent = state.busy ? "Agent working..." : "Ready";
      send.disabled = state.busy;
      stop.disabled = !state.busy;
      prompt.disabled = state.busy;
      codingModel.disabled = state.busy;
      browserModel.disabled = state.busy;
      renderModelOptions();

      if (!state.messages || state.messages.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Open a project folder, choose coding and browser models, and send a prompt. The active workspace becomes the project root for Agent Smith.";
        messages.appendChild(empty);
        return;
      }

      for (const message of state.messages) {
        const item = document.createElement("div");
        item.className = "message " + message.role;

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = message.role + (message.model ? " · " + message.model : "");

        const content = document.createElement("div");
        if (message.pending) {
          const thinking = document.createElement("div");
          thinking.className = "thinking";
          const spinner = document.createElement("span");
          spinner.className = "spinner";
          const text = document.createElement("span");
          text.className = "dots";
          text.textContent = message.status || "Thinking";
          thinking.appendChild(spinner);
          thinking.appendChild(text);
          content.appendChild(thinking);
        } else {
          content.textContent = message.content || "";
        }

        if (message.logs && message.logs.length > 0) {
          const log = document.createElement("div");
          log.className = "activity-log";
          const title = document.createElement("div");
          title.className = "activity-title";
          title.textContent = message.pending ? "Live activity" : "Activity";
          const body = document.createElement("div");
          body.textContent = message.logs.slice(-12).map((entry) => "• " + entry).join("\\n");
          log.appendChild(title);
          log.appendChild(body);
          content.appendChild(log);
        }

        if (message.pending && message.content) {
          const existing = document.createElement("div");
          existing.style.marginTop = "8px";
          existing.textContent = message.content;
          content.appendChild(existing);
        }

        item.appendChild(meta);
        item.appendChild(content);
        messages.appendChild(item);
      }

      messages.scrollTop = messages.scrollHeight;
    }

    function renderModelOptions() {
      renderOptions(
        codingModel,
        state.codingModelOptions || state.modelOptions || [],
        state.defaultCodingModel || state.defaultModel || "qwen3-coder:30b"
      );
      renderOptions(
        browserModel,
        state.browserModelOptions || state.modelOptions || [],
        state.defaultBrowserModel || "qwen3.5:latest"
      );
    }

    function renderOptions(select, options, defaultValue) {
      const normalizedOptions = options && options.length > 0 ? options : [defaultValue];
      const selected = select.value || defaultValue;
      select.innerHTML = "";
      for (const option of normalizedOptions) {
        const item = document.createElement("option");
        item.value = option;
        item.textContent = option === defaultValue ? option + " (default)" : option;
        select.appendChild(item);
      }
      select.value = normalizedOptions.includes(selected) ? selected : normalizedOptions[0];
    }

    render();
  </script>
</body>
</html>`;
    }
}
function makeNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let i = 0; i < 32; i += 1) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
//# sourceMappingURL=extension.js.map