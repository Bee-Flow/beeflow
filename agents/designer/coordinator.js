/**
 * Multi-Agent Swarm Component Designer
 *
 * 5-Phase pipeline coordinator:
 *   Phase 0: Clarify — ask targeted questions before research
 *   Phase 1: Research — orchestrate + phased workers + synthesize
 *   Phase 2: User Questions — pause for credentials if auth worker detected them
 *   Phase 3: Build + Test — builder generates code, assemble, auto-test with retries
 *   Phase 4: Deploy — reinitialize component manager, finalize
 *
 * Pipeline logic is split across pipeline/ modules:
 *   pipeline/llmHelpers.js      — LLM call, JSON extraction
 *   pipeline/toolHelpers.js     — tool definitions, execution
 *   pipeline/evaluation.js      — orchestrator phase evaluation
 *   pipeline/phases/clarify.js  — Phase 0
 *   pipeline/phases/research.js — Phase 1
 *   pipeline/phases/credentials.js — Phase 2
 *   pipeline/phases/build.js    — Phase 3+4
 */

const agentStore = require('../../stores/agentStore');

// ─── Pipeline Phase Modules ──────────────────────────────────────────────
const { callLLM, extractJSON, extractComponentFromResponse } = require('../../pipeline/llmHelpers');
const { getSearchTools, executeToolCalls } = require('../../pipeline/toolHelpers');
const { askOrchestratorEvaluation } = require('../../pipeline/evaluation');
const { runOrchestrator, runClarifier } = require('../../pipeline/phases/clarify');
const { runResearchWorker, synthesizeResearch } = require('../../pipeline/phases/research');
const { detectAndBuildCredentials, credentialChat: _credentialChat } = require('../../pipeline/phases/credentials');
const { buildTestDeploy } = require('../../pipeline/phases/build');

// ─── Default Configuration ──────────────────────────────────────────────

const DEFAULT_CONFIG = {
    orchestrator: {
        model: null,
        temperature: 0.3,
        maxTokens: 2000,
        systemPrompt: null
    },
    workers: {
        requirements: {
            enabled: true, name: '📋 Requirements', icon: '📋', color: '#8b5cf6',
            description: 'Extracts requirements, constraints, and acceptance criteria',
            model: null, temperature: 0.3, maxTokens: 2000, phase: 'research',
            systemPrompt: `You are a Requirements Analyst for a component pipeline. Analyze the user's request and extract structured requirements.

Respond with ONLY a JSON object in this exact format:
{
  "requirements": ["requirement 1", "requirement 2"],
  "acceptanceCriteria": ["criterion 1", "criterion 2"],
  "edgeCases": ["edge case 1", "edge case 2"],
  "constraints": ["constraint 1"],
  "validationRules": ["rule 1"]
}

Be thorough — identify functional requirements, error handling needs, input validation, and edge cases.`
        },
        auth: {
            enabled: true, name: '🔑 Auth', icon: '🔑', color: '#ef4444',
            description: 'Designs credential strategy and collection form',
            model: null, temperature: 0.3, maxTokens: 3000, phase: 'research',
            useTools: true,
            systemPrompt: `You are an Authentication Analyst for a component pipeline. Determine what authentication the component needs.

If you have search tools available, use them FIRST to research the service's authentication methods.

Respond with ONLY a JSON object in this exact format:
{
  "authMethod": "api_key|oauth2|basic|token|none",
  "credentials": [
    { "name": "fieldName", "label": "Human Label", "type": "string", "required": true, "secure": true, "description": "What this credential is", "hint": "Step-by-step how to get it" }
  ],
  "formFields": [],
  "documentationUrl": "https://...",
  "notes": "Any important auth notes"
}

Set authMethod to "none" if the component doesn't need external authentication (e.g. pure utility/transform components).`
        },
        schema: {
            enabled: true, name: '📐 Schema', icon: '📐', color: '#06b6d4',
            description: 'Defines input/output schema and validation rules',
            model: null, temperature: 0.3, maxTokens: 2000, phase: 'research',
            systemPrompt: `You are a Schema Designer for a component pipeline. Define the input/output schema for the component.

Respond with ONLY a JSON object in this exact format:
{
  "inputs": {
    "fieldName": { "type": "string|number|boolean|object|array", "label": "Human Label", "description": "What this input does", "required": true, "default": null }
  },
  "outputs": {
    "fieldName": { "type": "string|number|boolean|object|array", "description": "What this output contains" }
  },
  "validationRules": ["rule 1"]
}

Include ALL credential inputs (marked with "secure": true), configuration inputs, and data inputs.
Always include "success" (boolean) and "error" (string) in outputs.`
        },
        api: {
            enabled: true, name: '🌐 API', icon: '🌐', color: '#f59e0b',
            description: 'Plans API integration, endpoints, and error handling',
            model: null, temperature: 0.3, maxTokens: 3000, phase: 'research',
            useTools: true,
            systemPrompt: `You are an API Research Analyst for a component pipeline. Research the APIs and protocols needed for this component.

If you have search tools available, use them FIRST to find official API documentation.

Respond with ONLY a JSON object in this exact format:
{
  "baseUrl": "https://api.example.com",
  "endpoints": [
    { "method": "POST", "path": "/endpoint", "description": "What it does", "headers": {}, "bodyFormat": "json", "responseFormat": "json" }
  ],
  "errorCodes": { "400": "Bad request", "401": "Unauthorized" },
  "rateLimits": "any known rate limits",
  "sdkRecommendation": "npm package name if applicable",
  "notes": "Implementation notes"
}

For non-HTTP components (e.g. SMTP, database), describe the protocol, ports, and connection details instead.`
        },
        builder: {
            enabled: true, name: '🔨 Builder', icon: '🔨', color: '#10b981',
            description: 'Generates the component code with full tool access',
            model: null, temperature: 0.7, maxTokens: 8000, phase: 'build',
            systemPrompt: null
        },
        qa: {
            enabled: true, name: '🧪 QA', icon: '🧪', color: '#ec4899',
            description: 'Defines test cases and sample inputs',
            model: null, temperature: 0.3, maxTokens: 2000, phase: 'research',
            systemPrompt: `You are a QA Engineer for a component pipeline. Define test cases and realistic sample inputs.

Respond with ONLY a JSON object in this exact format:
{
  "testCases": [
    { "name": "test name", "description": "what it tests", "expectedBehavior": "what should happen" }
  ],
  "sampleInputs": {
    "fieldName": "realistic test value"
  },
  "edgeCaseTests": [
    { "name": "edge case", "input": {}, "expectedBehavior": "what should happen" }
  ]
}

IMPORTANT: sampleInputs should contain REALISTIC but SAFE test values. For credentials, use obvious placeholder values like "test-api-key". For email fields use "test@example.com". Never use real credentials.`
        },
        credentials: {
            enabled: true, name: '🔑 Credentials Guide', icon: '🔑', color: '#f59e0b',
            description: 'Researches how to obtain required credentials and generates a form with instructions',
            model: null, temperature: 0.4, maxTokens: 4000, phase: 'credentials',
            useTools: true,
            systemPrompt: `You are a Credentials Guide for a component pipeline. Research how to obtain the required credentials and create a user-friendly form.

If you have search tools available, use them FIRST to find official setup instructions.

Respond with ONLY a JSON object in this exact format:
{
  "title": "Setup Title",
  "instructions": "Brief setup instructions in markdown",
  "fields": [
    { "name": "fieldName", "label": "Human Label", "type": "text|password|url", "required": true, "placeholder": "example value", "description": "What this is", "hint": "Step-by-step how to get this value with exact URLs" }
  ],
  "helpLinks": [
    { "label": "Link text", "url": "https://..." }
  ],
  "notes": "Any important notes"
}`
        },
        clarify: {
            enabled: true, name: '❓ Clarify', icon: '❓', color: '#3b82f6',
            description: 'Asks targeted clarification questions before research begins',
            model: null, temperature: 0.3, maxTokens: 1500, phase: 'clarify',
            useTools: true,
            systemPrompt: `You are a Clarification Agent for a component pipeline. Analyze the user's request and determine if important details are missing that would significantly impact the component design.

Ask questions ONLY when the request is genuinely ambiguous and the answer would change the implementation. For example:
- "Create an email sender" → ASK which provider/protocol (Gmail SMTP? SendGrid API? Generic SMTP?)
- "Create a Slack notifier" → DON'T ASK, it's clear enough (Slack webhook)
- "Create a database component" → ASK which database (PostgreSQL? MySQL? MongoDB?)
- "Create a weather API component" → DON'T ASK, can use a standard weather API

Respond with ONLY a JSON object in this exact format:
{
  "needed": true,
  "questions": [
    "Specific question 1?",
    "Specific question 2?"
  ],
  "reasoning": "Brief explanation of why clarification is needed"
}

If the request is clear enough to proceed, respond with:
{ "needed": false, "questions": [], "reasoning": "Request is clear enough" }

Keep questions to 1-3 maximum. Be concise and specific.`
        }
    },
    pipeline: {
        workerTimeout: 180000,
        maxRetries: 3,
        autoTest: true,
        skipFormForSimpleComponents: true,
        builderMaxIterations: 15
    }
};

// ─── Config Management ──────────────────────────────────────────────────

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
            && target[key] && typeof target[key] === 'object') {
            result[key] = deepMerge(target[key], source[key]);
        } else if (source[key] !== null && source[key] !== undefined) {
            // Only override if the DB value is actually set (not null)
            result[key] = source[key];
        }
    }
    return result;
}

async function loadConfig() {
    try {
        const dbConfig = await agentStore.getSwarmConfig();
        if (dbConfig) return deepMerge(DEFAULT_CONFIG, dbConfig);
    } catch (e) {
        console.warn('[Swarm] Failed to load config from DB, using defaults:', e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(config) { agentStore.saveSwarmConfig(config); }
function getConfig() { return loadConfig(); }
function updateConfig(updates) {
    const current = loadConfig();
    const merged = deepMerge(current, updates);
    saveConfig(merged);
    return merged;
}

// ─── Main Orchestrator Class ─────────────────────────────────────────────

class MultiAgentDesigner {
    constructor() {
        this.sessionData = new Map();
    }

    /**
     * Phase 0: Analyze + Clarify
     */
    async startSwarm(sessionId, userMessage, onEvent) {
        const config = loadConfig();
        const startTime = Date.now();

        this.sessionData.set(sessionId, {
            userMessage, startTime,
            plan: null, researchOutputs: null, researchBrief: null,
            builderResult: null, credentials: null, clarificationAnswers: null
        });

        try {
            onEvent('phase_start', { phase: 0, name: 'Analyze', message: 'Understanding your request...' });

            const plan = await runOrchestrator(userMessage, config, onEvent);
            const session = this.sessionData.get(sessionId);
            session.plan = plan;

            // Run clarifier
            const clarifyResult = await runClarifier(userMessage, plan, config, onEvent);
            if (clarifyResult) {
                const questions = clarifyResult.questions;
                onEvent('needs_clarification', { questions });
                onEvent('phase_done', {
                    phase: 0, name: 'Analyze',
                    elapsed: Date.now() - startTime,
                    outcome: `${questions.length} clarification question(s) for user`
                });

                session.clarificationQuestions = questions;

                return {
                    phase: 0,
                    needsClarification: true,
                    questions,
                    plan,
                    elapsed: Date.now() - startTime
                };
            }

            onEvent('phase_done', {
                phase: 0, name: 'Analyze',
                elapsed: Date.now() - startTime,
                skipped: true,
                outcome: 'No clarification needed — proceeding'
            });

            return await this._doResearchAndCredentials(sessionId, onEvent);

        } catch (error) {
            console.error('[Swarm] Pipeline error:', error);
            onEvent('error', { error: error.message });
            throw error;
        }
    }

    /**
     * Phase 0 completion: User submitted clarification answers
     */
    async submitClarification(sessionId, answers, onEvent) {
        const session = this.sessionData.get(sessionId);
        if (!session) throw new Error('No active session. Start the swarm first.');

        session.clarificationAnswers = answers;

        const answerSummary = Object.entries(answers)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join('\n');
        session.enrichedUserMessage = `${session.userMessage}\n\n## User Clarifications\n${answerSummary}`;

        return await this._doResearchAndCredentials(sessionId, onEvent);
    }

    /**
     * Phase 1 (Research) + Phase 2 (Credentials)
     */
    async _doResearchAndCredentials(sessionId, onEvent) {
        const config = loadConfig();
        const session = this.sessionData.get(sessionId);
        const startTime = session.startTime;
        const userMessage = session.enrichedUserMessage || session.userMessage;
        const plan = session.plan;

        try {
            // ── Phase 1: Research ──────────────────────────────────────
            onEvent('phase_start', { phase: 1, name: 'Research', message: 'Researching...' });

            const researchWorkerKeys = (plan.activeResearchWorkers || []).filter(k => k !== 'qa');
            const context = { userMessage, plan };
            const timeout = config.pipeline.workerTimeout || 30000;

            const workerPromises = researchWorkerKeys
                .filter(k => config.workers[k]?.enabled !== false)
                .map(workerKey => {
                    const workerConfig = config.workers[workerKey];
                    return Promise.race([
                        runResearchWorker(workerKey, workerConfig, context, onEvent),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`Worker ${workerKey} timed out`)), timeout)
                        )
                    ]).catch(err => ({
                        worker: workerKey, result: null, elapsed: timeout,
                        success: false, error: err.message
                    }));
                });

            const researchOutputs = await Promise.all(workerPromises);
            session.researchOutputs = researchOutputs;

            const researchBrief = synthesizeResearch(plan, researchOutputs);
            session.researchBrief = researchBrief;
            onEvent('orchestrator_synthesize', {
                message: 'Research complete. Synthesizing brief for builder...',
                researchResults: researchOutputs.filter(w => w.success).length
            });

            const authOutput = researchOutputs.find(w => w.worker === 'auth' && w.success);
            const successWorkers = researchOutputs.filter(w => w.success).map(w => w.worker);
            const failedWorkers = researchOutputs.filter(w => !w.success).map(w => w.worker);
            onEvent('phase_done', {
                phase: 1, name: 'Research', elapsed: Date.now() - startTime,
                outcome: `${successWorkers.length} workers completed: ${successWorkers.join(', ')}` +
                    (failedWorkers.length ? ` | ${failedWorkers.length} failed: ${failedWorkers.join(', ')}` : ''),
                authMethod: authOutput?.result?.authMethod || 'none'
            });

            // ── Orchestrator evaluates Phase 1 ─────────────────────────
            const researchSummary = researchOutputs.map(w => ({
                worker: w.worker, success: w.success,
                result: w.success ? w.result : { error: w.error }
            }));
            const researchEval = await askOrchestratorEvaluation('research', researchSummary, config, onEvent);

            if (researchEval.decision === 'retry' && researchEval.followUp?.targetWorker) {
                const retryKey = researchEval.followUp.targetWorker;
                const retryConfig = config.workers[retryKey];
                if (retryConfig && retryConfig.enabled !== false) {
                    console.log(`[Swarm] Orchestrator requested retry for '${retryKey}': ${researchEval.followUp.question}`);
                    const retryContext = {
                        userMessage, plan,
                        priorResearch: `## Orchestrator Follow-Up\n${researchEval.followUp.question}\n\n## Previous Research Results\n${JSON.stringify(researchSummary, null, 2)}`
                    };
                    const retryResult = await runResearchWorker(retryKey, retryConfig, retryContext, onEvent);
                    const idx = researchOutputs.findIndex(w => w.worker === retryKey);
                    if (idx >= 0) researchOutputs[idx] = retryResult;
                    else researchOutputs.push(retryResult);

                    session.researchBrief = synthesizeResearch(plan, researchOutputs);
                    session.researchOutputs = researchOutputs;
                }
            }

            // ── Phase 2: Credentials ──────────────────────────────────
            onEvent('phase_start', { phase: 2, name: 'User Questions', message: 'Checking authentication requirements...' });

            console.log('[Swarm] authOutput:', authOutput ? JSON.stringify({
                worker: authOutput.worker, success: authOutput.success,
                resultKeys: authOutput.result ? Object.keys(authOutput.result) : null,
                authMethod: authOutput.result?.authMethod,
                credCount: (authOutput.result?.credentials || authOutput.result?.formFields || []).length
            }) : 'null');

            const credentialResult = await detectAndBuildCredentials(authOutput, userMessage, plan, config, onEvent);

            if (credentialResult) {
                session.credentialContext = credentialResult.credentialContext;

                return {
                    phase: 2,
                    needsCredentials: true,
                    message: credentialResult.formMessage,
                    credentialFields: credentialResult.credentialFields,
                    authMethod: credentialResult.authMethod,
                    plan,
                    workerResults: researchOutputs.map(w => ({ worker: w.worker, success: w.success, elapsed: w.elapsed })),
                    elapsed: Date.now() - startTime
                };
            }

            // No credentials needed
            onEvent('phase_done', {
                phase: 2, name: 'User Questions', elapsed: Date.now() - startTime,
                skipped: true,
                outcome: 'No credentials required — skipping'
            });

            return await this._buildTestDeploy(sessionId, onEvent);

        } catch (error) {
            console.error('[Swarm] Pipeline error:', error);
            onEvent('error', { error: error.message });
            throw error;
        }
    }

    /**
     * Phase 2 completion: User submitted credentials
     */
    async submitCredentials(sessionId, credentials, onEvent) {
        const session = this.sessionData.get(sessionId);
        if (!session) throw new Error('No active session. Start the swarm first.');

        session.credentials = credentials;
        onEvent('phase_done', { phase: 2, name: 'User Questions', message: 'Credentials received.' });

        session.researchBrief += `\n\n## Provided Credentials\nThe user has provided these credentials. Embed them as default values for the credential inputs:\n${JSON.stringify(credentials, null, 2)}`;

        return await this._buildTestDeploy(sessionId, onEvent);
    }

    /**
     * Phase 2 follow-up: credential chat
     */
    async credentialChat(sessionId, userQuestion) {
        const session = this.sessionData.get(sessionId);
        if (!session) throw new Error('No active session. Start the swarm first.');

        return _credentialChat(session, userQuestion);
    }

    /**
     * Phase 3+4: Build, Test, Deploy
     */
    async _buildTestDeploy(sessionId, onEvent) {
        const config = loadConfig();
        const session = this.sessionData.get(sessionId);

        const result = await buildTestDeploy(session, config, onEvent);

        this.sessionData.delete(sessionId);

        return {
            phase: 'complete',
            success: result.success,
            componentId: result.component?.id || session.plan.componentId,
            component: result.component,
            plan: session.plan,
            message: result.builderMessage,
            workerResults: (session.researchOutputs || []).map(w => ({ worker: w.worker, success: w.success, elapsed: w.elapsed })),
            totalElapsed: result.totalElapsed
        };
    }

    clearSession(sessionId) { this.sessionData.delete(sessionId); }
    hasSession(sessionId) { return this.sessionData.has(sessionId); }
    getSession(sessionId) { return this.sessionData.get(sessionId); }
}

const designer = new MultiAgentDesigner();

module.exports = {
    MultiAgentDesigner,
    designer,
    getConfig,
    updateConfig,
    loadConfig,
    saveConfig,
    DEFAULT_CONFIG,
    // Shared utilities for other swarm modules
    callLLM,
    getSearchTools,
    executeToolCalls,
    extractJSON
};
