/**
 * Regex Generator Tools — Built-in tools for AI to create regex rules & collections
 * 
 * These tools are injected into the LLM tool set for the Regex Generator system agent,
 * allowing the AI to list, add, and test regex patterns for the guardrails system.
 */

const { getAIConfig, saveAIConfig } = require('../core/aiAgent');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const REGEX_GENERATOR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'regex_list_rules',
            description: 'List all existing regex guardrail rules and collections. Use this first to see what rules already exist before adding new ones.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'regex_add_rules',
            description: 'Add one or more regex rules to the guardrails system. Each rule has a name and a JavaScript-compatible regex pattern. Rules are used to detect sensitive data like IBANs, passport numbers, credit cards, etc.',
            parameters: {
                type: 'object',
                properties: {
                    rules: {
                        type: 'array',
                        description: 'Array of rules to add',
                        items: {
                            type: 'object',
                            properties: {
                                name: {
                                    type: 'string',
                                    description: 'Human-readable name for the rule, e.g. "Dutch IBAN" or "NL Passport Number"'
                                },
                                pattern: {
                                    type: 'string',
                                    description: 'JavaScript-compatible regex pattern string (without delimiters). E.g. "NL\\d{2}[A-Z]{4}\\d{10}" for Dutch IBAN'
                                }
                            },
                            required: ['name', 'pattern']
                        }
                    }
                },
                required: ['rules']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'regex_add_collection',
            description: 'Create or update a collection of regex rules. If a collection with the same name already exists, the specified rules will be merged into it. Collections group related rules together. Always reuse the same collection name - do NOT create variants like Updated or Complete.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name for the collection, e.g. "Dutch PII Detection"'
                    },
                    ruleNames: {
                        type: 'array',
                        description: 'Names of existing rules to include in this collection',
                        items: { type: 'string' }
                    }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'regex_test_pattern',
            description: 'Test a regex pattern against sample text to verify it matches correctly. Use this to validate patterns before adding them.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'Regex pattern to test'
                    },
                    testText: {
                        type: 'string',
                        description: 'Sample text to test the pattern against'
                    }
                },
                required: ['pattern', 'testText']
            }
        }
    }
];

// ─── Tool Execution ────────────────────────────────────────────

async function getRegexConfig() {
    const aiConfig = await getAIConfig();
    return aiConfig.regexGuardrails || { rules: [], collections: [] };
}

async function saveRegexConfig(regexGuardrails) {
    const aiConfig = await getAIConfig();
    await saveAIConfig({ ...aiConfig, regexGuardrails });
}

/**
 * Strip common variant suffixes from collection names so
 * "Dutch PII Detection (Updated)" matches "Dutch PII Detection".
 */
function normalizeCollectionName(name) {
    return name
        .replace(/\s*\((?:updated|complete|final|v\d+|new|revised|full)\)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function executeRegexGeneratorTool(toolName, args) {
    switch (toolName) {
        case 'regex_list_rules': {
            const config = await getRegexConfig();
            const rules = config.rules || [];
            const collections = config.collections || [];
            return {
                rules: rules.map(r => ({ id: r.id, name: r.name, pattern: r.pattern })),
                collections: collections.map(c => ({
                    id: c.id,
                    name: c.name,
                    ruleCount: c.ruleIds?.length || 0,
                    ruleNames: (c.ruleIds || []).map(rid => {
                        const rule = rules.find(r => r.id === rid);
                        return rule ? rule.name : rid;
                    })
                })),
                totalRules: rules.length,
                totalCollections: collections.length
            };
        }

        case 'regex_add_rules': {
            const { rules: newRules } = args;
            if (!newRules || !Array.isArray(newRules) || newRules.length === 0) {
                return { error: 'No rules provided' };
            }

            const config = await getRegexConfig();
            if (!config.rules) config.rules = [];

            const added = [];
            const skipped = [];
            for (const rule of newRules) {
                // Validate the pattern
                try {
                    new RegExp(rule.pattern);
                } catch (e) {
                    skipped.push({ name: rule.name, reason: `Invalid regex: ${e.message}` });
                    continue;
                }

                // Check for duplicate names
                if (config.rules.find(r => r.name.toLowerCase() === rule.name.toLowerCase())) {
                    skipped.push({ name: rule.name, reason: 'Rule with this name already exists' });
                    continue;
                }

                const newRule = {
                    id: 'r' + Date.now() + Math.random().toString(36).substr(2, 4),
                    name: rule.name,
                    pattern: rule.pattern
                };
                config.rules.push(newRule);
                added.push({ id: newRule.id, name: newRule.name, pattern: newRule.pattern });
            }

            await saveRegexConfig(config);
            return {
                success: true,
                added,
                skipped,
                totalRules: config.rules.length
            };
        }

        case 'regex_add_collection': {
            const { name, ruleNames } = args;
            if (!name) return { error: 'Collection name is required' };

            const config = await getRegexConfig();
            if (!config.collections) config.collections = [];

            // Resolve rule names to IDs
            const ruleIds = [];
            const notFound = [];
            if (ruleNames && Array.isArray(ruleNames)) {
                for (const rName of ruleNames) {
                    const rule = (config.rules || []).find(r => r.name.toLowerCase() === rName.toLowerCase());
                    if (rule) {
                        ruleIds.push(rule.id);
                    } else {
                        notFound.push(rName);
                    }
                }
            }

            // Normalize name: strip suffixes like (Updated), (Complete), (v2), etc.
            const normalizedName = normalizeCollectionName(name);

            // Find existing collection by normalized name match
            const existing = config.collections.find(c =>
                normalizeCollectionName(c.name) === normalizedName
            );

            if (existing) {
                const merged = new Set([...(existing.ruleIds || []), ...ruleIds]);
                existing.ruleIds = [...merged];
                await saveRegexConfig(config);
                return {
                    success: true,
                    updated: true,
                    collection: { id: existing.id, name: existing.name, ruleCount: existing.ruleIds.length },
                    notFound: notFound.length > 0 ? notFound : undefined
                };
            }

            // Use the normalized name for new collections to prevent future variants
            const newCollection = {
                id: 'c' + Date.now() + Math.random().toString(36).substr(2, 4),
                name: normalizedName || name,
                ruleIds
            };
            config.collections.push(newCollection);
            await saveRegexConfig(config);

            return {
                success: true,
                collection: { id: newCollection.id, name: newCollection.name, ruleCount: ruleIds.length },
                notFound: notFound.length > 0 ? notFound : undefined
            };
        }

        case 'regex_test_pattern': {
            const { pattern, testText } = args;
            if (!pattern || !testText) return { error: 'Both pattern and testText are required' };

            try {
                const regex = new RegExp(pattern, 'gi');
                const matches = [];
                let match;
                while ((match = regex.exec(testText)) !== null) {
                    matches.push({ match: match[0], index: match.index });
                    if (matches.length >= 20) break; // Safety limit
                }
                return {
                    pattern,
                    testText,
                    matchCount: matches.length,
                    matches,
                    isValid: true
                };
            } catch (e) {
                return { error: `Invalid regex pattern: ${e.message}`, isValid: false };
            }
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

/**
 * Deduplicate collections after AI generation.
 * Merges collections with the same normalized name, keeping the first and
 * combining all ruleIds.
 */
async function deduplicateCollections() {
    const config = await getRegexConfig();
    if (!config.collections || config.collections.length <= 1) return;

    const seen = new Map(); // normalizedName -> index in deduped array
    const deduped = [];

    for (const col of config.collections) {
        const norm = normalizeCollectionName(col.name);
        if (seen.has(norm)) {
            // Merge ruleIds into existing
            const existing = deduped[seen.get(norm)];
            const merged = new Set([...(existing.ruleIds || []), ...(col.ruleIds || [])]);
            existing.ruleIds = [...merged];
        } else {
            seen.set(norm, deduped.length);
            // Also normalize the stored name
            deduped.push({ ...col, name: norm || col.name });
        }
    }

    if (deduped.length < config.collections.length) {
        config.collections = deduped;
        await saveRegexConfig(config);
        console.log(`[RegexGenerator] Deduplicated collections: ${config.collections.length} remaining`);
    }
}

function isRegexGeneratorTool(toolName) {
    return REGEX_GENERATOR_TOOLS.some(t => t.function.name === toolName);
}

module.exports = {
    REGEX_GENERATOR_TOOLS,
    executeRegexGeneratorTool,
    isRegexGeneratorTool,
    deduplicateCollections,
};

