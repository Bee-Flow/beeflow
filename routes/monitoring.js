/**
 * Monitoring API — REST endpoints for dashboards, panels & visual query builder
 *
 * All data is scoped to the user's organisation. No SQL exposed to users.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/permissions');
const store = require('../stores/monitoringStore');

router.use(requireAuth);

// Helper: get the user's primary org
function getOrg(req) {
    const orgs = req.session.user?.organizations || [];
    return orgs[0] || req.session.user?.id;
}

// ── Dashboards ──────────────────────────────────────────

router.get('/dashboards', async (req, res) => {
    try {
        res.json(await store.getDashboards(getOrg(req)));
    } catch (err) {
        console.error('[Monitoring] List dashboards:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/dashboards', async (req, res) => {
    try {
        const d = await store.createDashboard(req.session.user.id, getOrg(req), req.body.name);
        res.status(201).json(d);
    } catch (err) {
        console.error('[Monitoring] Create dashboard:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/dashboards/:id', async (req, res) => {
    try {
        const d = await store.getDashboardWithPanels(req.params.id, getOrg(req));
        if (!d) return res.status(404).json({ error: 'Not found' });
        res.json(d);
    } catch (err) {
        console.error('[Monitoring] Get dashboard:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.put('/dashboards/:id', async (req, res) => {
    try {
        const d = await store.updateDashboard(req.params.id, getOrg(req), req.body);
        if (!d) return res.status(404).json({ error: 'Not found' });
        res.json(d);
    } catch (err) {
        console.error('[Monitoring] Update dashboard:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/dashboards/:id', async (req, res) => {
    try {
        const ok = await store.deleteDashboard(req.params.id, getOrg(req));
        if (!ok) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Monitoring] Delete dashboard:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.put('/dashboards/:id/layout', async (req, res) => {
    try {
        const { positions } = req.body;
        if (!Array.isArray(positions)) return res.status(400).json({ error: 'positions array required' });
        await store.updateLayout(req.params.id, getOrg(req), positions);
        res.json({ success: true });
    } catch (err) {
        console.error('[Monitoring] Update layout:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Panels ──────────────────────────────────────────────

router.post('/panels', async (req, res) => {
    try {
        const { dashboardId, ...data } = req.body;
        if (!dashboardId) return res.status(400).json({ error: 'dashboardId required' });
        const p = await store.createPanel(dashboardId, getOrg(req), data);
        res.status(201).json(p);
    } catch (err) {
        console.error('[Monitoring] Create panel:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.put('/panels/:id', async (req, res) => {
    try {
        const p = await store.updatePanel(req.params.id, getOrg(req), req.body);
        if (!p) return res.status(404).json({ error: 'Not found' });
        res.json(p);
    } catch (err) {
        console.error('[Monitoring] Update panel:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/panels/:id', async (req, res) => {
    try {
        const ok = await store.deletePanel(req.params.id, getOrg(req));
        if (!ok) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Monitoring] Delete panel:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Execute panel query (using stored query_config)
router.post('/panels/:id/execute', async (req, res) => {
    try {
        const orgId = getOrg(req);
        const { rows } = await store.monitoringPool.query(
            `SELECT p.* FROM panels p JOIN dashboards d ON p.dashboard_id = d.id
             WHERE p.id = $1 AND d.organization_id = $2`, [req.params.id, orgId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Panel not found' });
        const panel = rows[0];
        const queryConfig = panel.query_config;
        if (!queryConfig?.table) return res.status(400).json({ error: 'No query configured' });
        const result = await store.executeQueryConfig(orgId, queryConfig, req.session?.encryptionKey);
        res.json(result);
    } catch (err) {
        console.error('[Monitoring] Execute query:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Visual Query Builder ────────────────────────────────

// Preview a visual query config
router.post('/query/build', async (req, res) => {
    try {
        const result = await store.executeQueryConfig(getOrg(req), req.body, req.session?.encryptionKey);
        res.json(result);
    } catch (err) {
        console.error('[Monitoring] Build query:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Available Tables with columns ───────────────────────

router.get('/tables', async (req, res) => {
    try {
        const orgId = getOrg(req);
        const tables = await store.getAvailableTables(orgId);
        const importTables = tables.filter(t => t.source === 'import');
        console.log(`[Monitoring] Tables for org=${orgId}: total=${tables.length}, imports=${importTables.length}`, importTables.map(t => t.displayName));
        res.json(tables);
    } catch (err) {
        console.error('[Monitoring] List tables:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Custom Tables ───────────────────────────────────────

router.post('/custom-tables', async (req, res) => {
    try {
        const { displayName, columns } = req.body;
        if (!displayName || !columns?.length) return res.status(400).json({ error: 'displayName and columns required' });
        const t = await store.createCustomTable(getOrg(req), req.session.user.id, displayName, columns);
        res.status(201).json(t);
    } catch (err) {
        console.error('[Monitoring] Create custom table:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/custom-tables/:id', async (req, res) => {
    try {
        const ok = await store.deleteCustomTable(req.params.id, getOrg(req));
        if (!ok) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Monitoring] Delete custom table:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Data Imports ────────────────────────────────────────

const importStore = require('../stores/importStore');
const scriptExecutor = require('../integrations/scriptExecutor');
const { getAdapter } = require('../core/providers');
const { getProviderForModel } = require('../core/aiAgent');
const configStore = require('../stores/configStore');
const { buildToolSet, routeToolCall, truncateToolResult } = require('../integrations/crossAppTaskScanner');

// Available app sources
router.get('/imports/sources', (req, res) => {
    res.json(importStore.APP_SOURCES);
});

// List imports for org
router.get('/imports', async (req, res) => {
    try {
        res.json(await importStore.getImports(getOrg(req)));
    } catch (err) {
        console.error('[Monitoring] List imports:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Create import config (+ create target table)
router.post('/imports', async (req, res) => {
    try {
        const orgId = getOrg(req);
        const { name, description, appSource, importScript, columns } = req.body;
        if (!name || !appSource) return res.status(400).json({ error: 'name and appSource required' });

        // Create the target table for encrypted data
        const colDefs = (columns || []).map(c => ({ name: c.name, type: 'text' }));
        const tableName = await importStore.createImportTable(orgId, colDefs, name);

        const config = await importStore.createImport(orgId, req.session.user.id, {
            name, description, appSource, importScript: importScript || '',
            targetTable: tableName,
            columnMapping: columns || [],
        });
        res.status(201).json(config);
    } catch (err) {
        console.error('[Monitoring] Create import:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Update import config
router.put('/imports/:id', async (req, res) => {
    try {
        const updated = await importStore.updateImport(req.params.id, getOrg(req), req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (err) {
        console.error('[Monitoring] Update import:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete import config (+ drops data table)
router.delete('/imports/:id', async (req, res) => {
    try {
        const ok = await importStore.deleteImport(req.params.id, getOrg(req));
        if (!ok) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Monitoring] Delete import:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Run import manually
router.post('/imports/:id/run', async (req, res) => {
    try {
        const result = await importStore.runImport(req.params.id, req.session, scriptExecutor);
        res.json(result);
    } catch (err) {
        console.error('[Monitoring] Run import:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// AI: Generate import script from description — uses tool calls to explore data first
router.post('/imports/generate-script', async (req, res) => {
    try {
        const { appSource, description, tier = 'auto' } = req.body;
        if (!appSource || !description) return res.status(400).json({ error: 'appSource and description required' });

        // Resolve tier to model
        const tiers = configStore.getConfig('chat_model_tiers') || {};
        let modelId;
        if (tier && tier !== 'auto' && tiers[tier]?.modelId) {
            modelId = tiers[tier].modelId;
        } else {
            modelId = tiers.fast?.modelId || tiers.thinking?.modelId;
        }
        if (!modelId) return res.status(400).json({ error: 'No model configured. Configure chat model tiers in AI settings.' });

        const providerConfig = await getProviderForModel(modelId);
        const apiKey = providerConfig.apiKey;
        const apiUrl = (providerConfig.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(providerConfig.providerType, apiUrl);

        // Build tool set for the selected app (same tools as cross-app scanner)
        const userId = req.session.user?.id;
        const { tools, appSummary } = buildToolSet(req.session, userId, [appSource]);
        const scanCtx = { session: req.session, userId };

        const toolDocs = getToolDocs(appSource);

        // Phase 1: Explore user data with tool calls (2 rounds max)
        const explorePrompt = `You are a data import assistant. The user wants to import data from ${appSource}.

USER REQUEST: "${description}"

Use the available tools to explore the user's data. Search for the data they described.
- For Gmail: search for relevant emails, look at a few to understand the data structure
- For Calendar: list events to understand patterns  
- For Drive: search for relevant files
- For Sheets: look at spreadsheet structure

After exploring, summarize what you found in a SHORT paragraph.`;

        let messages = [
            { role: 'system', content: explorePrompt },
            { role: 'user', content: description },
        ];

        // Tool-calling loop (same pattern as crossAppTaskScanner.runPhase)
        let explorationSummary = '';
        const maxRounds = 2;
        for (let round = 0; round < maxRounds; round++) {
            let result;
            try {
                result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                    maxTokens: 4096, temperature: 0.3,
                    tools: tools.length > 0 ? tools : undefined,
                    toolChoice: tools.length > 0 ? 'auto' : undefined,
                });
            } catch (err) {
                console.error('[Monitoring] AI explore error:', err.message);
                break;
            }

            if (result.toolCalls?.length > 0) {
                messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

                const toolResults = await Promise.all(result.toolCalls.map(async (tc) => {
                    const toolName = tc.function?.name || tc.name;
                    let toolArgs = {};
                    try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { }
                    console.log(`[Monitoring] Import explore tool: ${toolName}`, toolArgs);

                    let toolResult;
                    try { toolResult = await routeToolCall(toolName, toolArgs, scanCtx); }
                    catch (err) { toolResult = { error: err.message }; }

                    return { role: 'tool', tool_call_id: tc.id, content: truncateToolResult(toolResult) };
                }));
                messages.push(...toolResults);
                continue;
            }

            // AI responded with text — exploration complete
            explorationSummary = result.content || '';
            break;
        }

        // Phase 2: Generate the import script based on exploration
        const generatePrompt = `Based on your exploration of the user's ${appSource} data, generate a data import script.

${explorationSummary ? `DATA EXPLORATION RESULTS:\n${explorationSummary}\n` : ''}
USER REQUEST: "${description}"

## Available ctx tools for the script:
${toolDocs}

## Script format:
\`\`\`javascript
async function run(ctx) {
    // Use ctx tools to fetch data
    // Return { rows: [{...}, {...}] }
}
\`\`\`

## CRITICAL RULES:
1. Return { rows: [...] } with flat objects (no nesting)
2. Column names MUST be snake_case (e.g. sender_email, response_time, message_id)
3. Do NOT include email body content — only headers/metadata
4. Handle errors gracefully with try/catch
5. Use ctx.ledger.filterNew(items) to skip already-imported items
6. After processing each item, call ctx.ledger.markProcessed(itemId)

## Output Format (ONLY valid JSON, no explanation):
{
  "script": "async function run(ctx) { ... }",
  "columns": [{ "name": "snake_case_name", "label": "Display Label", "type": "text|number|date" }],
  "suggestedName": "Short import name"
}`;

        const genResult = await adapter.chat(apiKey, apiUrl, modelId, [
            { role: 'system', content: generatePrompt },
            { role: 'user', content: 'Generate the import script now.' },
        ], { temperature: 0.3, max_tokens: 4000 });

        // Parse LLM response
        const content = genResult.message?.content || genResult.content || '';
        let parsed;
        try {
            const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
            parsed = JSON.parse(jsonMatch[1].trim());
        } catch (e) {
            try { parsed = JSON.parse(content); }
            catch (e2) { return res.status(500).json({ error: 'AI returned invalid JSON', raw: content }); }
        }

        res.json({
            script: parsed.script || '',
            columns: parsed.columns || [],
            suggestedName: parsed.suggestedName || `${appSource} Import`,
        });
    } catch (err) {
        console.error('[Monitoring] Generate script:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Tool documentation per app source — mirrors CTX_API_BY_APP from crossAppTaskScanner.js
const CTX_API_DOCS = {
    gmail: [
        'ctx.gmail.search(query, maxResults?) → [{id, from, subject, date, snippet}]',
        'ctx.gmail.read(messageId) → {from, subject, body, date, attachments: [{filename, mimeType, size, attachmentId}]}',
        'ctx.gmail.getAttachment(messageId, attachmentId) → {data (base64), size}',
    ],
    calendar: [
        'ctx.calendar.listEvents(daysAhead?, maxResults?) → events',
        'ctx.calendar.searchEvents(query, daysAhead?) → events',
    ],
    drive: [
        'ctx.drive.search(query, maxResults?) → [{id, name, mimeType, ...}]',
        'ctx.drive.listFiles(folderId) → [{id, name, mimeType, ...}]',
        'ctx.drive.getFile(fileId) → file metadata',
    ],
    sheets: [
        'ctx.sheets.getValues(spreadsheetId, range) → [[cell values]]',
    ],
    docs: [
        'ctx.docs.read(documentId) → string (document text content)',
    ],
    youtrack: [
        'ctx.youtrack.createIssue({projectId, summary, description})',
    ],
    fireflies: [
        'ctx.fireflies.listTranscripts(limit?) → transcripts',
        'ctx.fireflies.getSummary(transcriptId) → summary',
    ],
};

const LEDGER_DOCS = [
    'ctx.ledger.filterNew(items, idField?) → filters out already-processed items',
    'ctx.ledger.hasProcessed(itemId) → boolean',
    'ctx.ledger.markProcessed(itemId, action) → record item as done',
];

function getToolDocs(appSource) {
    const appDocs = CTX_API_DOCS[appSource];
    if (!appDocs) return 'No tools documented for this source.';
    return [...appDocs, '', '// Dedup helpers:', ...LEDGER_DOCS].map(l => `- ${l}`).join('\n');
}

module.exports = router;

