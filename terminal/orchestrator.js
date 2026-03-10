/**
 * Terminal Agent Runtime — Orchestrator
 * 
 * Core agentic loop: LLM → tool call → execute → observe → repeat
 * Each conversation runs inside its own Docker container, managed by containerManager.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const terminalAgentStore = require('../stores/terminalAgentStore');
const usageStore = require('../stores/usageStore');
const { processSystemPrompt } = require('../core/promptUtils');
const { TERMINAL_TOOLS } = require('./tools');
const { validateCommand } = require('./sandbox');
const containerManager = require('./containerManager');
const { SEQUENTIAL_THINKING_TOOL, executeSequentialThinking } = require('../core/sequentialThinkingTool');
const { runPreThinking } = require('../core/preThinking');
const { parseDocument, isSupportedDocument } = require('../core/documentParser');

const DEFAULT_SYSTEM_PROMPT = require('fs').readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf-8');

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Execute a terminal agent task with an agentic tool loop.
 * 
 * @param {string} agentId
 * @param {string} userMessage
 * @param {object} userAuth
 * @param {function} onEvent - SSE callback (type, data)
 * @param {AbortSignal} signal
 * @param {Array} conversationHistory - previous messages [{role, content}]
 * @param {object} options - additional options
 * @param {string} options.conversationId - conversation ID (used to key the container)
 * @param {string} options.containerKey - override container key (e.g. for swarm shared workspace)
 * @returns {{ result: string, actionsExecuted: number }}
 */
async function executeTerminalTask(agentId, userMessage, userAuth, onEvent = () => { }, signal = null, conversationHistory = [], options = {}) {
    const agentConfig = terminalAgentStore.getTerminalAgent(agentId);
    if (!agentConfig) throw new Error(`Terminal agent not found: ${agentId}`);

    const config = agentConfig.config || {};
    const maxIterations = config.maxIterations || 30;
    const timeout = config.timeout || 60000;
    const blockedCommands = config.blockedCommands || [];

    // Derive container key: explicit containerKey > conversationId > agentId fallback
    const containerKey = options.containerKey || options.conversationId || agentId;

    // Resolve model
    const globalConfig = await getAIConfig();
    const modelToUse = agentConfig.model || globalConfig.model;
    const providerConfig = await getProviderForModel(modelToUse);

    let apiUrl = (providerConfig.url || '').replace(/\/$/, '');
    if (!apiUrl.endsWith('/v1')) {
        apiUrl = `${apiUrl}/v1`;
    }
    const apiKey = providerConfig.apiKey;

    console.log(`[TerminalAgent] Starting task for agent ${agentId} with model ${modelToUse}`);
    onEvent('terminal_status', { status: 'initializing', message: 'Setting up container environment...' });

    // Get or create the Docker container for this conversation
    const containerId = await containerManager.getOrCreateContainer(containerKey, agentId);

    // Pre-load attached files into the container
    const filesDir = path.join(__dirname, '..', 'data', 'terminal-agent-files', agentId);
    let preloadedFiles = [];
    if (fs.existsSync(filesDir)) {
        const files = fs.readdirSync(filesDir);
        for (const file of files) {
            const hostPath = path.join(filesDir, file);
            try {
                containerManager.copyToContainer(containerKey, hostPath, `/workspace/${file}`);
                const stat = fs.statSync(hostPath);
                preloadedFiles.push({ name: file, size: stat.size });
                console.log(`[TerminalAgent] Pre-loaded file: ${file} (${stat.size} bytes)`);
            } catch (err) {
                console.error(`[TerminalAgent] Failed to pre-load file ${file}:`, err.message);
            }
        }
    }

    onEvent('terminal_status', { status: 'ready', message: 'Container environment ready' });

    // Build system prompt
    let systemPrompt = agentConfig.system_prompt || DEFAULT_SYSTEM_PROMPT;
    try { systemPrompt = processSystemPrompt(systemPrompt); } catch (e) { /* ignore */ }

    // Add environment context
    systemPrompt += `\n\n## Environment Info\n- Working directory: /workspace\n- Container ID: ${containerId.substring(0, 12)}\n- Python: pre-installed (use python or python3)\n- Platform: linux (Docker container)`;

    // Notify agent about pre-loaded files
    if (preloadedFiles.length > 0) {
        systemPrompt += `\n\n## Pre-loaded Files\nThe following files have been pre-loaded into /workspace:\n`;
        for (const f of preloadedFiles) {
            systemPrompt += `- ${f.name} (${(f.size / 1024).toFixed(1)} KB)\n`;
        }
        systemPrompt += `\nYou can read, process, or use these files directly. They are already available in your working directory.`;
    }

    // Build conversation messages with history
    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    // Inject conversation history so the agent has context of previous turns
    if (conversationHistory && conversationHistory.length > 0) {
        for (const msg of conversationHistory) {
            if (msg.role === 'user' || msg.role === 'assistant') {
                messages.push({ role: msg.role, content: msg.content || '' });
            }
        }
    }

    // Add the current user message
    messages.push({ role: 'user', content: userMessage });

    let actionsExecuted = 0;
    let finalResult = '';

    // Build tool list — optionally include sequential thinking
    let agentTools = agentConfig.config?.sequentialThinkingEnabled
        ? [...TERMINAL_TOOLS, SEQUENTIAL_THINKING_TOOL]
        : [...TERMINAL_TOOLS];

    // ─── Pre-thinking with separate model ───
    const thinkingModel = config.sequentialThinkingModel;
    if (thinkingModel && config.sequentialThinkingEnabled) {
        try {
            const sessionId = `terminal-${agentId}-${containerKey}-pre`;
            const { context } = await runPreThinking(thinkingModel, messages.slice(1), sessionId, onEvent, signal, systemPrompt);
            if (context) {
                // Inject reasoning context into system prompt
                messages[0].content += context;
                // Remove sequentialthinking from tool list to avoid double-thinking
                agentTools = agentTools.filter(t => t.function?.name !== 'sequentialthinking');
            }
        } catch (err) {
            console.error('[TerminalAgent PreThinking] Error:', err.message);
        }
    }

    // ─── Agentic Loop ─────────────────────────────────────────
    for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (signal?.aborted) {
            console.log('[TerminalAgent] Aborted by client');
            break;
        }

        // Call LLM
        const startTime = Date.now();
        const llmResult = await callLLM(apiUrl, apiKey, modelToUse, messages, agentTools, signal);

        // Log usage
        if (llmResult.usage) {
            usageStore.logUsage({
                user_id: 'system',
                agent_id: agentId,
                agent_name: agentConfig.name,
                agent_type: 'terminal',
                model: modelToUse,
                prompt_tokens: llmResult.usage.prompt_tokens || 0,
                completion_tokens: llmResult.usage.completion_tokens || 0,
                total_tokens: llmResult.usage.total_tokens || 0,
                source: 'terminal_agent',
                duration_ms: Date.now() - startTime,
                organization_id: agentConfig.organization_id || null
            });
        }

        const choice = llmResult.choices?.[0];
        if (!choice) {
            console.warn('[TerminalAgent] No choice in LLM response');
            break;
        }

        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        // If the LLM produced text content, stream it
        if (assistantMsg.content) {
            finalResult = assistantMsg.content;
            onEvent('content', { text: assistantMsg.content });
        }

        // If no tool calls — the LLM is done
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
            break;
        }

        // Execute tool calls
        for (const toolCall of assistantMsg.tool_calls) {
            if (signal?.aborted) break;

            const fnName = toolCall.function.name;
            let args;
            try {
                args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                const errResult = `Error: Invalid JSON arguments for ${fnName}`;
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: errResult });
                onEvent('terminal_output', { type: 'error', content: errResult });
                continue;
            }

            console.log(`[TerminalAgent] Tool call: ${fnName}`, args);

            // ─── Handle sequentialthinking OUTSIDE the terminal ───
            if (fnName === 'sequentialthinking') {
                onEvent('tool_start', { name: 'sequentialthinking', args });
                const thinkResult = executeSequentialThinking(args, `terminal-${containerKey}`);
                onEvent('tool_end', { name: 'sequentialthinking', result: thinkResult });
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: thinkResult });
                continue; // Skip terminal execution path entirely
            }

            onEvent('terminal_command', { tool: fnName, args });

            let result;
            // Snapshot workspace files before execution (for file-creating tools)
            let filesBefore = null;
            if (fnName === 'python_exec' || fnName === 'run_command') {
                try {
                    filesBefore = await containerManager.snapshotWorkspace(containerKey);
                } catch (e) { /* container might be starting */ }
            }

            try {
                result = await executeTool(fnName, args, {
                    agentId,
                    containerKey,
                    timeout,
                    blockedCommands,
                    onEvent,
                    signal
                });
                actionsExecuted++;
            } catch (err) {
                result = `Error: ${err.message}`;
            }

            // Detect new or modified files created by python_exec or run_command
            if (filesBefore !== null && !result.startsWith('Error:')) {
                try {
                    const filesAfter = await containerManager.snapshotWorkspace(containerKey);
                    for (const [filePath, mtime] of filesAfter) {
                        const prevMtime = filesBefore.get(filePath);
                        // Emit if file is new OR was modified
                        if (prevMtime === undefined || mtime > prevMtime) {
                            const name = path.basename(filePath);
                            const relativePath = filePath.startsWith('/workspace/') ? filePath.substring(11) : filePath;
                            onEvent('terminal_file', {
                                name,
                                path: relativePath,
                                size: 0, // size unknown from snapshot
                                agentId,
                                containerKey
                            });
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // Truncate very long outputs
            if (result.length > 10000) {
                result = result.slice(0, 10000) + '\n\n... [output truncated, showing first 10000 chars]';
            }

            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
            onEvent('terminal_output', {
                tool: fnName,
                content: result,
                success: !result.startsWith('Error:')
            });
        }
    }

    console.log(`[TerminalAgent] Task complete. Actions executed: ${actionsExecuted}`);
    return { result: finalResult, actionsExecuted };
}


// ─── Tool Execution ──────────────────────────────────────────────

async function executeTool(toolName, args, ctx) {
    switch (toolName) {
        case 'run_command':
            return await executeRunCommand(args.command, ctx);
        case 'python_exec':
            return await executePythonExec(args.code, args.description, ctx);
        case 'pip_install':
            return await executePipInstall(args.packages, ctx);
        case 'write_file':
            return await executeWriteFile(args.path, args.content, ctx);
        case 'read_file':
            return await executeReadFile(args.path, args.maxLines, ctx);
        case 'convert_document_to_text':
            return await executeConvertDocumentToText(args.path, ctx);
        default:
            return `Error: Unknown tool "${toolName}"`;
    }
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

async function executePythonExec(code, description, ctx) {
    const result = await containerManager.execPythonInContainer(ctx.containerKey, code, {
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

async function executePipInstall(packages, ctx) {
    const result = await containerManager.execInContainer(ctx.containerKey, `pip install ${packages}`, {
        cwd: '/workspace',
        timeout: ctx.timeout * 2, // pip can be slow
        signal: ctx.signal,
        onOutput: (type, chunk) => {
            ctx.onEvent('terminal_output', { type, content: chunk, streaming: true });
        }
    });

    const output = (result.stdout || '') + (result.stderr || '');
    if (result.exitCode === 0) {
        return `Successfully installed: ${packages}\n${output}`;
    } else {
        return `Error installing packages (exit code ${result.exitCode}):\n${output}`;
    }
}

async function executeWriteFile(filePath, content, ctx) {
    // Resolve path inside container — always relative to /workspace
    const resolvedPath = filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;

    try {
        const writeResult = await containerManager.writeFileInContainer(ctx.containerKey, resolvedPath, content);
        if (!writeResult.success) {
            return `Error writing file: ${writeResult.error}`;
        }

        // Emit file event so frontend can show download link
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

async function executeConvertDocumentToText(filePath, ctx) {
    const resolvedPath = filePath.startsWith('/') ? filePath : `/workspace/${filePath}`;
    const filename = path.basename(resolvedPath);

    // Give it a generic mimetype or let parser handle purely by extension
    if (!isSupportedDocument('', filename)) {
        return `Error: Unsupported document type for '${filename}'. Use supported formats: PDF, DOCX, XLSX, XLS, CSV.`;
    }

    // Temporary path on the host to copy the file to
    const tmpHostPath = path.join(os.tmpdir(), `term_doc_${crypto.randomBytes(8).toString('hex')}_${filename}`);

    try {
        ctx.onEvent('terminal_status', { status: 'busy', message: `Converting ${filename}...` });

        // 1. Copy file from container to host
        containerManager.copyFromContainer(ctx.containerKey, resolvedPath, tmpHostPath);

        // 2. Read the buffer
        const buffer = fs.readFileSync(tmpHostPath);

        // 3. Parse Document
        // Pass generic application/octet-stream and let parseDocument infer from filename
        const parsedText = await parseDocument(buffer, 'application/octet-stream', filename);

        if (parsedText.startsWith('[Document:') && parsedText.includes('failed to parse')) {
            throw new Error(parsedText);
        }

        // 4. Save to .txt file back in the workspace
        const parsedFilename = `${filename}.txt`;
        const parsedResolvedPath = `/workspace/${parsedFilename}`;

        const writeResult = await containerManager.writeFileInContainer(ctx.containerKey, parsedResolvedPath, parsedText);

        if (!writeResult.success) {
            throw new Error(`Failed to write converted text: ${writeResult.error}`);
        }

        // Emit file event for the newly created text file
        ctx.onEvent('terminal_file', {
            name: parsedFilename,
            path: parsedFilename,
            size: parsedText.length,
            agentId: ctx.agentId,
            containerKey: ctx.containerKey
        });

        ctx.onEvent('terminal_status', { status: 'ready', message: `Converted ${filename}` });

        return `Successfully converted ${filename} to plain text. The parsed text has been saved strictly to ${parsedResolvedPath} in the workspace. You can now use tools like python_exec or run_command (with head, tail, grep, etc.) on ${parsedResolvedPath} to analyze the contents without hitting output truncation limits.`;
    } catch (err) {
        ctx.onEvent('terminal_status', { status: 'ready', message: `Failed to convert ${filename}` });
        return `Error converting document: ${err.message}`;
    } finally {
        // Cleanup temp file
        if (fs.existsSync(tmpHostPath)) {
            try { fs.unlinkSync(tmpHostPath); } catch (e) { /* ignore */ }
        }
    }
}


// ─── LLM API Call ───────────────────────────────────────────────

async function callLLM(apiUrl, apiKey, model, messages, tools, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = {
        model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.2
    };

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal || undefined
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error ${response.status}: ${error}`);
    }

    return response.json();
}


module.exports = { executeTerminalTask, executeTool };
