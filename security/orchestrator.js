/**
 * Security Agent Runtime — Multi-Phase Orchestrator
 * 
 * Executes security scans using a multi-phase pipeline:
 *   Phase 1: Recon       — Gemini 3.1 Pro Preview (nmap, DNS, service detection)
 *   Phase 2: Scan        — GPT-5.3 Codex (Nuclei vulnerability scanning)
 *   Phase 3: Analyze     — Mistral Large 3 (correlate findings, risk assessment)
 *   Phase 4: Report      — Claude Sonnet 4.6 (generate pentest report)
 * 
 * Orchestrator: Claude Opus 4.6 (planning, coordination, attack chain reasoning)
 * 
 * Each phase has a specialized worker that runs inside a shared Docker container.
 * A "Hive Mind" (shared memory) carries findings between phases.
 * 
 * Uses SDK-based provider adapters (same as directChat) for all LLM calls.
 */

const path = require('path');
const fs = require('fs');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const securityAgentStore = require('../stores/securityAgentStore');
const usageStore = require('../stores/usageStore');
const { processSystemPrompt } = require('../core/promptUtils');
const { SECURITY_TOOLS } = require('./tools');
const { validateCommand } = require('../terminal/sandbox');
const containerManager = require('./containerManager');
const { parseNucleiOutput, generateMarkdownReport } = require('./reportGenerator');
const HiveMind = require('../agents/swarm/hiveMind');
const { ORCHESTRATOR_MODEL, getDefaultPhases, getPhaseWorkerTools, generateOrchestratorPrompt } = require('./phases');

const DEFAULT_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf-8');


// ─── SDK-based LLM Call ─────────────────────────────────────────

/**
 * Call an LLM using the correct SDK adapter (Claude, OpenAI, Google, Mistral).
 * Returns normalized { content, toolCalls, usage }.
 */
async function callLLM(model, messages, tools, signal) {
    const providerConfig = await getProviderForModel(model);
    const adapter = getAdapter(providerConfig.providerType, providerConfig.url);
    const apiKey = providerConfig.apiKey;
    const apiUrl = providerConfig.url || '';

    console.log(`[SecurityAgent:LLM] ${adapter.name} → model: ${model}`);

    const options = {
        tools: tools && tools.length > 0 ? tools : undefined,
        tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        temperature: 0.2,
        max_tokens: 16384,
    };

    const result = await adapter.chat(apiKey, apiUrl, model, messages, options);
    return result;
}


// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Execute a security agent task with multi-phase pipeline.
 */
async function executeSecurityTask(agentId, userMessage, userAuth, onEvent = () => { }, signal = null, conversationHistory = [], options = {}) {
    const agentConfig = securityAgentStore.getSecurityAgent(agentId);
    if (!agentConfig) throw new Error(`Security agent not found: ${agentId}`);

    const config = agentConfig.config || {};
    const maxOrchestratorIterations = config.maxOrchestratorIterations || 20;
    const workerTimeout = config.timeout || 120000;
    const blockedCommands = config.blockedCommands || [];

    // Derive container key
    const containerKey = options.containerKey || options.conversationId || agentId;

    // Orchestrator uses Claude Opus 4.6
    const orchestratorModel = ORCHESTRATOR_MODEL;

    // Get phases (from agent config or defaults — each has a hardcoded model)
    const phases = (config.phases && config.phases.length > 0)
        ? config.phases
        : getDefaultPhases();

    console.log(`[SecurityAgent] Starting multi-phase task for agent ${agentId}`);
    console.log(`[SecurityAgent] Orchestrator: ${orchestratorModel}`);
    console.log(`[SecurityAgent] Phases: ${phases.filter(p => p.enabled !== false).map(p => `${p.name} (${p.worker.model})`).join(' → ')}`);
    onEvent('terminal_status', { status: 'initializing', message: 'Setting up security scanning environment...' });

    // Get or create the Docker container
    const containerId = await containerManager.getOrCreateContainer(containerKey, agentId);

    // Pre-load attached files into container
    const filesDir = path.join(__dirname, '..', 'data', 'security-agent-files', agentId);
    let preloadedFiles = [];
    if (fs.existsSync(filesDir)) {
        const files = fs.readdirSync(filesDir);
        for (const file of files) {
            const hostPath = path.join(filesDir, file);
            try {
                containerManager.copyToContainer(containerKey, hostPath, `/workspace/${file}`);
                const stat = fs.statSync(hostPath);
                preloadedFiles.push({ name: file, size: stat.size });
            } catch (err) {
                console.error(`[SecurityAgent] Failed to pre-load file ${file}:`, err.message);
            }
        }
    }

    onEvent('terminal_status', { status: 'ready', message: 'Security scanning environment ready' });

    // Create Hive Mind for shared context between phases
    const hiveMind = new HiveMind(`security-${agentId}`);

    // Build orchestrator system prompt
    const orchestratorPrompt = generateOrchestratorPrompt(agentConfig, phases);

    // Build orchestrator messages
    const messages = [
        { role: 'system', content: orchestratorPrompt }
    ];

    // Add conversation history
    if (conversationHistory && conversationHistory.length > 0) {
        for (const msg of conversationHistory) {
            if (msg.role === 'user' || msg.role === 'assistant') {
                messages.push({ role: msg.role, content: msg.content || '' });
            }
        }
    }

    messages.push({ role: 'user', content: userMessage });

    // Build orchestrator tools (one per phase worker)
    const orchestratorTools = getPhaseWorkerTools(phases);

    let totalActionsExecuted = 0;
    let finalResult = '';

    // ─── Orchestrator Loop ─────────────────────────────────────
    for (let iteration = 0; iteration < maxOrchestratorIterations; iteration++) {
        if (signal?.aborted) {
            console.log('[SecurityAgent] Aborted by client');
            break;
        }

        const startTime = Date.now();
        let llmResult;
        try {
            llmResult = await callLLM(orchestratorModel, messages, orchestratorTools, signal);
        } catch (err) {
            console.error(`[SecurityAgent] Orchestrator LLM error:`, err.message);
            onEvent('error', { message: `Orchestrator error: ${err.message}` });
            break;
        }

        // Log orchestrator usage
        if (llmResult.usage) {
            usageStore.logUsage({
                user_id: 'system',
                agent_id: agentId,
                agent_name: agentConfig.name,
                agent_type: 'security',
                model: orchestratorModel,
                prompt_tokens: llmResult.usage.prompt_tokens || llmResult.usage.input_tokens || 0,
                completion_tokens: llmResult.usage.completion_tokens || llmResult.usage.output_tokens || 0,
                total_tokens: (llmResult.usage.prompt_tokens || llmResult.usage.input_tokens || 0) + (llmResult.usage.completion_tokens || llmResult.usage.output_tokens || 0),
                source: 'security_orchestrator',
                duration_ms: Date.now() - startTime,
                organization_id: agentConfig.organization_id || null
            });
        }

        // Build assistant message for conversation history
        const assistantMsg = { role: 'assistant', content: llmResult.content || null };
        if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
            assistantMsg.tool_calls = llmResult.toolCalls;
        }
        messages.push(assistantMsg);

        // If the orchestrator has text content, stream it
        if (llmResult.content) {
            finalResult = llmResult.content;
            onEvent('content', { text: llmResult.content });
        }

        // No tool calls = orchestrator is done
        if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
            break;
        }

        // Execute worker tool calls
        for (const toolCall of llmResult.toolCalls) {
            if (signal?.aborted) break;

            const fnName = toolCall.function.name;
            let args;
            try {
                args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Error: Invalid JSON arguments' });
                continue;
            }

            // Find the matching phase
            const phase = phases.find(p => `worker_${p.worker.role}` === fnName);
            if (!phase) {
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error: Unknown worker ${fnName}` });
                continue;
            }

            console.log(`[SecurityAgent] Orchestrator calling: ${phase.worker.name} (${phase.name}) → model: ${phase.worker.model}`);
            onEvent('phase', { phase: phase.name, message: `Phase: ${phase.name}`, icon: phase.icon, color: phase.color });
            onEvent('worker_start', { worker: phase.worker.name, phase: phase.name, model: phase.worker.model });

            // Execute the worker's mini agentic loop
            const workerResult = await executeWorker(
                phase,
                args.instruction,
                {
                    agentId,
                    agentConfig,
                    containerKey,
                    timeout: workerTimeout,
                    blockedCommands,
                    config,
                    hiveMind,
                    onEvent,
                    signal,
                    preloadedFiles
                }
            );

            totalActionsExecuted += workerResult.actionsExecuted;

            // Write worker findings to Hive Mind
            hiveMind.addEntry(phase.name, phase.worker.name, workerResult.result);
            onEvent('brain_update', {
                phase: phase.name,
                worker: phase.worker.name,
                content: workerResult.result.slice(0, 200) + (workerResult.result.length > 200 ? '...' : ''),
                totalEntries: hiveMind.size
            });

            onEvent('worker_complete', {
                worker: phase.worker.name,
                phase: phase.name,
                result: workerResult.result.slice(0, 150) + '...'
            });

            // Return worker result to orchestrator
            const toolResult = `[${phase.worker.name} completed]\n\n${workerResult.result}`;
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });

            // If this is the report phase, the worker's output is the final result
            if (phase.id === 'report') {
                finalResult = workerResult.result;
            }
        }
    }

    console.log(`[SecurityAgent] Multi-phase task complete. Total actions: ${totalActionsExecuted}, Hive Mind entries: ${hiveMind.size}`);
    return { result: finalResult, actionsExecuted: totalActionsExecuted };
}


// ─── Worker Execution (Mini Agentic Loop) ───────────────────────

/**
 * Execute a phase worker's agentic loop inside the Docker container.
 * Each worker uses its own hardcoded model + specialized prompt.
 */
async function executeWorker(phase, instruction, ctx) {
    const worker = phase.worker;
    const maxIterations = worker.maxIterations || 10;
    const workerModel = worker.model;

    console.log(`[SecurityAgent:${worker.name}] Using model: ${workerModel}`);

    // Build worker system prompt
    let systemPrompt = worker.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    try { systemPrompt = processSystemPrompt(systemPrompt); } catch (e) { /* ignore */ }

    // Add environment context
    systemPrompt += `\n\n## Environment
- Working directory: /workspace
- Platform: linux (Docker container)
- Tools: nmap, curl, dig, whois, openssl, jq, python3 available`;

    if (ctx.config.defaultSeverity) {
        systemPrompt += `\n- Default severity filter: ${ctx.config.defaultSeverity}`;
    }
    if (ctx.config.rateLimitRps) {
        systemPrompt += `\n- Default rate limit: ${ctx.config.rateLimitRps} requests/second`;
    }

    // Inject Hive Mind context
    if (ctx.hiveMind && ctx.hiveMind.size > 0) {
        systemPrompt += '\n\n' + ctx.hiveMind.toPromptContext();
    }

    // Notify about pre-loaded files
    if (ctx.preloadedFiles && ctx.preloadedFiles.length > 0) {
        systemPrompt += `\n\n## Pre-loaded Files\n`;
        for (const f of ctx.preloadedFiles) {
            systemPrompt += `- ${f.name} (${(f.size / 1024).toFixed(1)} KB)\n`;
        }
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: instruction }
    ];

    let actionsExecuted = 0;
    let finalResult = '';

    // Worker agentic loop
    for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (ctx.signal?.aborted) break;

        const startTime = Date.now();
        let llmResult;
        try {
            llmResult = await callLLM(workerModel, messages, SECURITY_TOOLS, ctx.signal);
        } catch (err) {
            console.error(`[SecurityAgent:${worker.name}] LLM error:`, err.message);
            finalResult = `Worker error: ${err.message}`;
            break;
        }

        // Log worker usage
        if (llmResult.usage) {
            usageStore.logUsage({
                user_id: 'system',
                agent_id: ctx.agentId,
                agent_name: `${ctx.agentConfig.name} / ${worker.name}`,
                agent_type: 'security',
                model: workerModel,
                prompt_tokens: llmResult.usage.prompt_tokens || llmResult.usage.input_tokens || 0,
                completion_tokens: llmResult.usage.completion_tokens || llmResult.usage.output_tokens || 0,
                total_tokens: (llmResult.usage.prompt_tokens || llmResult.usage.input_tokens || 0) + (llmResult.usage.completion_tokens || llmResult.usage.output_tokens || 0),
                source: `security_worker_${phase.id}`,
                duration_ms: Date.now() - startTime,
                organization_id: ctx.agentConfig.organization_id || null
            });
        }

        // Build assistant message for conversation tracking
        const assistantMsg = { role: 'assistant', content: llmResult.content || null };
        if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
            assistantMsg.tool_calls = llmResult.toolCalls;
        }
        messages.push(assistantMsg);

        if (llmResult.content) {
            finalResult = llmResult.content;
            ctx.onEvent('content', { text: llmResult.content, worker: worker.name, phase: phase.name });
        }

        // No tool calls = worker is done
        if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
            break;
        }

        // Execute tool calls in the Docker container
        for (const toolCall of llmResult.toolCalls) {
            if (ctx.signal?.aborted) break;

            const fnName = toolCall.function.name;
            let args;
            try {
                args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error: Invalid JSON for ${fnName}` });
                ctx.onEvent('terminal_output', { type: 'error', content: `Error: Invalid JSON for ${fnName}` });
                continue;
            }

            console.log(`[SecurityAgent:${worker.name}] Tool call: ${fnName}`, args);
            ctx.onEvent('terminal_command', { tool: fnName, args, worker: worker.name, phase: phase.name });

            let result;
            // Snapshot workspace files before execution
            let filesBefore = null;
            if (fnName === 'nuclei_scan' || fnName === 'run_command') {
                try {
                    filesBefore = await containerManager.snapshotWorkspace(ctx.containerKey);
                } catch (e) { /* container might be starting */ }
            }

            try {
                result = await executeTool(fnName, args, {
                    agentId: ctx.agentId,
                    containerKey: ctx.containerKey,
                    timeout: ctx.timeout,
                    blockedCommands: ctx.blockedCommands,
                    config: ctx.config,
                    onEvent: ctx.onEvent,
                    signal: ctx.signal
                });
                actionsExecuted++;
            } catch (err) {
                result = `Error: ${err.message}`;
            }

            // Detect new files
            if (filesBefore !== null && !result.startsWith('Error:')) {
                try {
                    const filesAfter = await containerManager.snapshotWorkspace(ctx.containerKey);
                    for (const [filePath, mtime] of filesAfter) {
                        const prevMtime = filesBefore.get(filePath);
                        if (prevMtime === undefined || mtime > prevMtime) {
                            const name = path.basename(filePath);
                            const relativePath = filePath.startsWith('/workspace/') ? filePath.substring(11) : filePath;
                            ctx.onEvent('terminal_file', {
                                name,
                                path: relativePath,
                                size: 0,
                                agentId: ctx.agentId,
                                containerKey: ctx.containerKey
                            });
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // Truncate very long outputs
            if (result.length > 15000) {
                result = result.slice(0, 15000) + '\n\n... [output truncated, showing first 15000 chars]';
            }

            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
            ctx.onEvent('terminal_output', {
                tool: fnName,
                content: result,
                success: !result.startsWith('Error:'),
                worker: worker.name,
                phase: phase.name
            });
        }
    }

    return { result: finalResult, actionsExecuted };
}


// ─── Tool Execution ──────────────────────────────────────────────

async function executeTool(toolName, args, ctx) {
    switch (toolName) {
        case 'nuclei_scan':
            return await executeNucleiScan(args, ctx);
        case 'run_command':
            return await executeRunCommand(args.command, ctx);
        case 'generate_report':
            return await executeGenerateReport(args, ctx);
        case 'write_file':
            return await executeWriteFile(args.path, args.content, ctx);
        case 'read_file':
            return await executeReadFile(args.path, args.maxLines, ctx);
        default:
            return `Error: Unknown tool "${toolName}"`;
    }
}

async function executeNucleiScan(args, ctx) {
    const { target, templates, severity, rate_limit, extra_args } = args;

    if (!target) return 'Error: Target is required';

    const outputFile = `scan_${Date.now()}.json`;
    let cmd = `nuclei -u "${target}" -jsonl -o /workspace/${outputFile}`;

    if (severity) {
        cmd += ` -severity ${severity}`;
    } else if (ctx.config.defaultSeverity) {
        cmd += ` -severity ${ctx.config.defaultSeverity}`;
    }

    if (templates) {
        if (templates.startsWith('/') || templates.startsWith('-t')) {
            cmd += ` ${templates}`;
        } else {
            cmd += ` -tags ${templates}`;
        }
    } else if (ctx.config.defaultTemplates) {
        cmd += ` -tags ${ctx.config.defaultTemplates}`;
    }

    const rps = rate_limit || ctx.config.rateLimitRps || 50;
    cmd += ` -rate-limit ${rps}`;

    if (extra_args) {
        cmd += ` ${extra_args}`;
    }

    cmd += ' -silent';

    ctx.onEvent('terminal_status', { status: 'scanning', message: `Scanning ${target}...` });

    const scanTimeout = ctx.config.scanTimeout || 300000;
    const result = await containerManager.execInContainer(ctx.containerKey, cmd, {
        cwd: '/workspace',
        timeout: scanTimeout,
        signal: ctx.signal,
        onOutput: (type, chunk) => {
            ctx.onEvent('terminal_output', { type, content: chunk, streaming: true });
        }
    });

    ctx.onEvent('terminal_status', { status: 'ready', message: 'Scan complete' });

    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr) {
        const stderrLines = result.stderr.split('\n').filter(l => l.includes('[ERR]') || l.includes('Error'));
        if (stderrLines.length > 0) {
            output += (output ? '\n' : '') + `[stderr]: ${stderrLines.join('\n')}`;
        }
    }

    const checkResult = await containerManager.execInContainer(ctx.containerKey, `wc -l /workspace/${outputFile} 2>/dev/null || echo "0 /workspace/${outputFile}"`, {
        cwd: '/workspace',
        timeout: 5000
    });

    const lineCount = parseInt((checkResult.stdout || '0').trim().split(' ')[0]) || 0;

    if (lineCount > 0) {
        output += `\n\nScan complete. Found ${lineCount} result(s). Results saved to /workspace/${outputFile}\nUse generate_report with results_file="${outputFile}" to create a comprehensive report.`;
    } else {
        output += `\n\nScan complete. No vulnerabilities found for the selected templates and severity levels.\nResults file: /workspace/${outputFile}`;
    }

    if (result.exitCode !== 0 && result.exitCode !== null) {
        output += `\n[exit code: ${result.exitCode}]`;
    }

    return output || '(no output)';
}

async function executeRunCommand(command, ctx) {
    const validation = validateCommand(command, ctx.blockedCommands);
    if (!validation.allowed) {
        return `Error: ${validation.reason}`;
    }

    const result = await containerManager.execInContainer(ctx.containerKey, command, {
        cwd: '/workspace',
        timeout: ctx.timeout,
        signal: ctx.signal,
        onOutput: (type, chunk) => {
            ctx.onEvent('terminal_output', { type, content: chunk, streaming: true });
        }
    });

    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += (output ? '\n' : '') + `[stderr]: ${result.stderr}`;
    if (result.exitCode !== 0 && result.exitCode !== null) output += `\n[exit code: ${result.exitCode}]`;
    return output || '(no output)';
}

async function executeGenerateReport(args, ctx) {
    const { results_file, target, report_name } = args;
    const resolvedInput = results_file.startsWith('/') ? results_file : `/workspace/${results_file}`;
    const outputFile = report_name || 'security_report.md';
    const resolvedOutput = outputFile.startsWith('/') ? outputFile : `/workspace/${outputFile}`;

    try {
        const content = await containerManager.readFileInContainer(ctx.containerKey, resolvedInput, 10000);

        if (!content || !content.trim()) {
            return 'Error: Results file is empty. Run a scan first.';
        }

        const findings = parseNucleiOutput(content);
        const report = generateMarkdownReport(findings, target, {
            scanDate: new Date().toISOString()
        });

        const writeResult = await containerManager.writeFileInContainer(ctx.containerKey, resolvedOutput, report);
        if (!writeResult.success) {
            return `Error writing report: ${writeResult.error}`;
        }

        const relativePath = resolvedOutput.startsWith('/workspace/') ? resolvedOutput.substring(11) : resolvedOutput;
        ctx.onEvent('terminal_file', {
            name: path.basename(resolvedOutput),
            path: relativePath,
            size: report.length,
            agentId: ctx.agentId,
            containerKey: ctx.containerKey
        });

        return `Report generated successfully: ${resolvedOutput} (${report.length} bytes)\n\nSummary: ${findings.length} total findings.\n\nThe report has been saved to the workspace.`;
    } catch (err) {
        return `Error generating report: ${err.message}`;
    }
}

async function executeWriteFile(filePath, content, ctx) {
    const resolvedPath = filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;

    try {
        const writeResult = await containerManager.writeFileInContainer(ctx.containerKey, resolvedPath, content);
        if (!writeResult.success) {
            return `Error writing file: ${writeResult.error}`;
        }

        const relativePath = resolvedPath.startsWith('/workspace/') ? resolvedPath.substring(11) : resolvedPath;
        ctx.onEvent('terminal_file', {
            name: path.basename(resolvedPath),
            path: relativePath,
            size: content.length,
            agentId: ctx.agentId,
            containerKey: ctx.containerKey
        });

        return `File written successfully: ${resolvedPath} (${content.length} bytes)`;
    } catch (err) {
        return `Error writing file: ${err.message}`;
    }
}

async function executeReadFile(filePath, maxLines, ctx) {
    const resolvedPath = filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;

    try {
        const content = await containerManager.readFileInContainer(ctx.containerKey, resolvedPath, maxLines || 200);
        return content || '(empty file)';
    } catch (err) {
        return `Error reading file: ${err.message}`;
    }
}


module.exports = { executeSecurityTask, executeTool };
