/**
 * Pipeline Phase 3+4: Build, Test, and Deploy
 * Builder generates component code, assembles files, auto-tests with retries, then deploys.
 */

const path = require('path');
const fs = require('fs');
const { callLLM, extractComponentFromResponse } = require('../llmHelpers');
const { executeComponentTool } = require('../toolHelpers');
const { runResearchWorker } = require('./research');
const componentManager = require('../../core/componentManager');

/**
 * Run the builder worker to generate component code.
 */
async function runBuilder(plan, researchBrief, userMessage, config, onEvent) {
    const builderConfig = config.workers.builder;
    const startTime = Date.now();
    onEvent('worker_start', { worker: 'builder', name: '🔨 Builder' });

    const { SYSTEM_PROMPT } = require('../../core/aiAgent');
    const systemPrompt = `${SYSTEM_PROMPT}

## SWARM CONTEXT
You are the Builder in a multi-agent swarm. Specialist workers have already researched everything.
Their findings are below. Your ONLY job is to generate the complete component JSON code block.
Do NOT search, do NOT test, do NOT call any tools. Just output the component code.

## AI AGENT TOOL COMPATIBILITY
This component WILL be used as an AI agent tool. This means:
- "description" becomes the tool description the AI reads to decide when to use it — make it clear, specific, and action-oriented (e.g. "Send a notification message via Slack webhook" not "Slack component")
- Each input "description" becomes the parameter description — explain what value the AI should pass, including format and examples
- Always include "success" (boolean) and "error" (string) in outputs so the AI agent can detect and handle failures
- On error, output JSON with { "success": false, "error": "descriptive message" } via stdout — never just crash with process.exit(1) without output
- Use sensible defaults for optional inputs so the AI doesn't need to specify everything

${researchBrief}

## OUTPUT RULES
1. Output a SINGLE json code block containing the complete component JSON
2. Component ID: ${plan.componentId}
3. Component name: ${plan.componentName}
4. Category: ${plan.category || 'Custom'}
5. Use the research above for inputs, outputs, auth strategy, and API details
6. Include ALL credential inputs with "secure": true directly in the component schema
7. DO NOT ask questions — use the research to decide
8. DO NOT output json-form — embed credentials as component inputs
9. The "description" field MUST be a clear one-sentence summary of what the component does
10. Every input MUST have a descriptive "description" field explaining what value to pass`;

    const data = await callLLM({
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        model: builderConfig.model,
        temperature: builderConfig.temperature,
        maxTokens: builderConfig.maxTokens
    });

    const assistantMsg = data.choices[0].message;
    const finalContent = assistantMsg.content || '';

    const component = extractComponentFromResponse(finalContent);
    if (component) {
        console.log(`[Swarm] Builder produced component: ${component.id}`);
    } else {
        console.warn('[Swarm] Builder did not produce a valid component JSON');
    }

    // Check for json-form (credential collection fallback)
    let formData = null;
    const formMatch = finalContent.match(/```json-form\s*\n([\s\S]*?)\n```/);
    if (formMatch) {
        try { formData = JSON.parse(formMatch[1]); } catch { }
    }

    const elapsed = Date.now() - startTime;
    onEvent('worker_done', { worker: 'builder', name: '🔨 Builder', elapsed });
    console.log(`[Swarm] Builder done in ${elapsed}ms`);

    return { component, message: finalContent, toolCalls: [], form: formData, elapsed };
}

/**
 * Assemble component files to disk (component.json, index.js, package.json + npm install).
 */
async function assembleComponentFiles(component, onEvent) {
    if (!component || !component.id || !component.code) {
        console.warn('[Swarm] No valid component to assemble');
        return null;
    }

    onEvent('assemble_start', { componentId: component.id, name: component.name });
    console.log(`[Swarm] Assembling component: ${component.id}`);

    const COMPONENTS_DIR = path.resolve(__dirname, '..', '..', '..', 'components');
    const componentDir = path.join(COMPONENTS_DIR, component.id);

    try {
        if (!fs.existsSync(componentDir)) {
            fs.mkdirSync(componentDir, { recursive: true });
        }

        const componentJson = {
            name: component.name || component.id,
            description: component.description || '',
            category: component.category || 'Custom',
            inputs: component.inputs || {},
            outputs: component.outputs || {}
        };
        fs.writeFileSync(path.join(componentDir, 'component.json'), JSON.stringify(componentJson, null, 2));

        const codeContent = typeof component.code === 'string' ? component.code : JSON.stringify(component.code, null, 2);
        fs.writeFileSync(path.join(componentDir, 'index.js'), codeContent);

        const packageJson = {
            name: component.id,
            version: '1.0.0',
            dependencies: component.dependencies || {}
        };
        fs.writeFileSync(path.join(componentDir, 'package.json'), JSON.stringify(packageJson, null, 2));

        if (component.dependencies && Object.keys(component.dependencies).length > 0) {
            const { execSync } = require('child_process');
            execSync('npm install --production', { cwd: componentDir, timeout: 30000 });
        }

        onEvent('assemble_done', { componentId: component.id, success: true });
        console.log(`[Swarm] Component ${component.id} assembled successfully`);

        return component;
    } catch (error) {
        console.error(`[Swarm] Assembly failed for ${component.id}:`, error.message);
        onEvent('assemble_error', { componentId: component.id, error: error.message });
        return null;
    }
}

/**
 * Phase 3 (Build+Test) and Phase 4 (Deploy) — complete build/test/deploy cycle.
 * Runs builder, assembles, auto-tests with retries, then reinitializes component manager.
 */
async function buildTestDeploy(session, config, onEvent) {
    const { plan, researchBrief, userMessage, startTime, credentials } = session;

    // ── Phase 3: Build + Test ─────────────────────────────────
    onEvent('phase_start', { phase: 3, name: 'Build + Test', message: 'Generating component code...' });

    const maxRetries = 2;
    let component = null;
    let builderMessage = '';
    let lastError = null;
    let lastComponentCode = null;
    let qaTestInputs = {};

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let builderUserMessage = userMessage;
        if (credentials) {
            builderUserMessage += `\n\nIMPORTANT: The user has provided credentials. Use these values as defaults:\n${JSON.stringify(credentials, null, 2)}`;
        }
        if (lastError && attempt > 0) {
            builderUserMessage += `\n\n⚠️ PREVIOUS ATTEMPT FAILED (attempt ${attempt}/${maxRetries}):\n${lastError}`;
            if (lastComponentCode) {
                builderUserMessage += `\n\n## Previous Component Code (fix this)\n\`\`\`javascript\n${lastComponentCode}\n\`\`\``;
            }
            builderUserMessage += `\n\nFix the issue in the component code above. The test inputs were:\n${JSON.stringify(qaTestInputs, null, 2)}`;
            onEvent('build_retry', { attempt, maxRetries, error: lastError });
        }

        const builderResult = await runBuilder(plan, researchBrief, builderUserMessage, config, onEvent);
        builderMessage = builderResult.message;

        if (!builderResult.component) {
            lastError = 'Builder did not produce a valid component JSON';
            console.warn(`[Swarm] Build attempt ${attempt + 1} failed: no component`);
            continue;
        }

        // Assemble to disk
        const assembled = await assembleComponentFiles(builderResult.component, onEvent);
        if (!assembled) {
            lastError = 'Failed to write component files to disk';
            continue;
        }

        // Register the new component so executeComponentTool can find it
        await componentManager.installComponent(assembled.id);

        // Save component code for potential retry context
        try {
            const COMPONENTS_DIR = path.resolve(__dirname, '..', '..', '..', 'components');
            lastComponentCode = fs.readFileSync(path.join(COMPONENTS_DIR, assembled.id, 'index.js'), 'utf-8');
        } catch { lastComponentCode = null; }

        // Run QA worker once (first attempt only)
        if (attempt === 0) {
            const qaConfig = config.workers.qa;
            if (qaConfig?.enabled !== false) {
                const qaContext = {
                    userMessage,
                    plan,
                    priorResearch: `## Research Brief\n${researchBrief}\n\n## Component ID\n${assembled.id}`
                };
                const qaResult = await runResearchWorker('qa', qaConfig, qaContext, onEvent);
                if (qaResult?.success && qaResult.result?.sampleInputs) {
                    qaTestInputs = qaResult.result.sampleInputs;
                }
            }
        }

        // Auto-test
        onEvent('test_start', { componentId: assembled.id });
        try {
            const testResult = await executeComponentTool(assembled.id, qaTestInputs, {}, null);
            const success = !testResult?.error;
            onEvent('test_result', { componentId: assembled.id, success, result: testResult });

            if (success) {
                component = assembled;
                console.log(`[Swarm] Test PASSED: ${assembled.id}`);
                break;
            } else {
                lastError = `Test failed with inputs ${JSON.stringify(qaTestInputs)}: ${JSON.stringify(testResult?.error || testResult)}`;
                console.warn(`[Swarm] Test FAILED (attempt ${attempt + 1}): ${lastError}`);
            }
        } catch (testErr) {
            lastError = `Test error with inputs ${JSON.stringify(qaTestInputs)}: ${testErr.message}`;
            onEvent('test_result', { componentId: assembled.id, success: false, error: testErr.message });
            console.warn(`[Swarm] Test error (attempt ${attempt + 1}): ${testErr.message}`);
        }
    }

    onEvent('phase_done', {
        phase: 3, name: 'Build + Test', success: !!component, elapsed: Date.now() - startTime,
        outcome: component
            ? `Component "${component.id}" built and tested successfully`
            : `Build failed after ${maxRetries + 1} attempts: ${lastError || 'unknown error'}`
    });

    // ── Phase 4: Deploy ────────────────────────────────────────
    onEvent('phase_start', { phase: 4, name: 'Deploy', message: 'Finalizing component...' });
    // Final reload to ensure all components are synced
    componentManager.reloadAll();

    const totalElapsed = Date.now() - startTime;
    onEvent('phase_done', {
        phase: 4, name: 'Deploy', componentId: component?.id || plan.componentId, elapsed: totalElapsed,
        outcome: component
            ? `Component "${component.id}" deployed and ready to use`
            : `Deployment skipped — no valid component produced`
    });
    onEvent('done', {
        componentId: component?.id || plan.componentId,
        totalElapsed,
        success: !!component
    });

    return {
        component,
        builderMessage,
        totalElapsed,
        success: !!component
    };
}

module.exports = {
    runBuilder,
    assembleComponentFiles,
    buildTestDeploy
};
