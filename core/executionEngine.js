const { fork, spawn } = require('child_process');
const path = require('path');
const componentManager = require('./componentManager');
const watcherStateStore = require('../stores/watcherStateStore');

async function executeWorkflow(workflow, userAuth = {}) {
    console.log('Executing workflow with', workflow.nodes.length, 'nodes');

    const executionResults = {}; // nodeId -> output

    // 1. Build Dependency Graph
    const adjList = {};
    const inDegree = {};
    workflow.nodes.forEach(node => {
        adjList[node.id] = [];
        inDegree[node.id] = 0;
    });

    workflow.edges.forEach(edge => {
        if (adjList[edge.source]) {
            adjList[edge.source].push(edge.target);
            inDegree[edge.target] = (inDegree[edge.target] || 0) + 1;
        }
    });

    // 2. Queue of ready nodes
    const queue = workflow.nodes.filter(node => inDegree[node.id] === 0);
    const sortedNodes = [];

    while (queue.length > 0) {
        const node = queue.shift();
        sortedNodes.push(node);

        if (adjList[node.id]) {
            adjList[node.id].forEach(neighbor => {
                inDegree[neighbor]--;
                if (inDegree[neighbor] === 0) {
                    const neighborNode = workflow.nodes.find(n => n.id === neighbor);
                    queue.push(neighborNode);
                }
            });
        }
    }

    if (sortedNodes.length !== workflow.nodes.length) {
        throw new Error('Cycle detected or disconnected nodes in workflow');
    }

    // 3. Execute in order
    for (const node of sortedNodes) {
        // For 'custom' type nodes, use componentId from data; otherwise use node.type
        const componentId = (node.type === 'custom' || node.type === 'default')
            ? (node.data?.componentId || node.type)
            : node.type;

        console.log(`Running node ${node.id} (${componentId})...`);
        const componentPath = componentManager.getComponentPath(componentId);

        if (!componentPath) {
            console.warn(`Component ${componentId} not found, skipping execution.`);
            executionResults[node.id] = {};
            continue;
        }

        // Prepare Inputs - start with static values from node configuration
        // Check both 'inputs' and 'inputValues' for compatibility
        const inputs = { ...(node.data.inputs || {}), ...(node.data.inputValues || {}) };

        // Inject user auth info for components that need it
        if (userAuth.accessToken) {
            inputs._accessToken = userAuth.accessToken;
        }
        if (userAuth.nextcloudUrl) {
            inputs._nextcloudUrl = userAuth.nextcloudUrl;
        }
        if (userAuth.appPasswordUsername) {
            inputs._appPasswordUsername = userAuth.appPasswordUsername;
        }
        if (userAuth.appPassword) {
            inputs._appPassword = userAuth.appPassword;
        }

        // Find incoming edges to this node and map connected values
        const incomingEdges = workflow.edges.filter(e => e.target === node.id);
        incomingEdges.forEach(edge => {
            const sourceResult = executionResults[edge.source];
            if (!sourceResult) return;

            // Parse handle IDs to determine field mapping
            // sourceHandle format: "output-{fieldName}-{type}" or "output-{fieldName}" or null
            // targetHandle format: "input-{fieldName}-{type}" or "input-{fieldName}" or null
            const sourceHandle = edge.sourceHandle || '';
            const targetHandle = edge.targetHandle || '';

            // Extract field names from handles (handle format: prefix-fieldName or prefix-fieldName-type)
            const extractFieldName = (handleId, prefix) => {
                if (!handleId.startsWith(prefix + '-')) return null;
                const withoutPrefix = handleId.slice(prefix.length + 1); // Remove "output-" or "input-"
                // If there's a type suffix, remove it (fieldName-type -> fieldName)
                const parts = withoutPrefix.split('-');
                if (parts.length >= 2) {
                    // Last part might be type, rest is field name
                    // Check if last part looks like a type (normalize parameterized types like array<object> to array)
                    const knownTypes = ['string', 'number', 'boolean', 'object', 'array', 'any', 'json'];
                    const lastPart = parts[parts.length - 1];
                    const normalizedType = lastPart.includes('<') ? lastPart.split('<')[0] : lastPart;
                    if (knownTypes.includes(normalizedType)) {
                        return parts.slice(0, -1).join('-');
                    }
                }
                return withoutPrefix;
            };

            // Helper to get value at nested path (e.g., "result.files")
            const getValueAtPath = (obj, path) => {
                if (!path) return obj;
                const parts = path.split('.');
                let current = obj;
                for (const part of parts) {
                    if (current === null || current === undefined) return undefined;
                    current = current[part];
                }
                return current;
            };

            const sourceField = extractFieldName(sourceHandle, 'output');
            const targetField = extractFieldName(targetHandle, 'input');

            if (sourceField && targetField) {
                // Specific field-to-field mapping - support nested paths
                let sourceValue = getValueAtPath(sourceResult, sourceField);
                if (sourceValue !== undefined) {
                    inputs[targetField] = sourceValue;
                } else if (sourceResult.value !== undefined) {
                    // Fallback: check for 'value' field (common for Manual Input)
                    inputs[targetField] = sourceResult.value;
                }
            } else if (sourceField) {
                // Source specific, target generic - use source field value
                let sourceValue = getValueAtPath(sourceResult, sourceField);
                if (sourceValue !== undefined) {
                    Object.assign(inputs, { [sourceField]: sourceValue });
                }
            } else if (targetField) {
                // Source generic, target specific - try to get first value or 'value'
                if (sourceResult.value !== undefined) {
                    inputs[targetField] = sourceResult.value;
                } else {
                    // Use first key from result
                    const firstKey = Object.keys(sourceResult)[0];
                    if (firstKey) {
                        inputs[targetField] = sourceResult[firstKey];
                    }
                }
            } else {
                // Both generic - merge all outputs into inputs
                Object.assign(inputs, sourceResult);
            }
        });

        console.log(`Node ${node.id} inputs:`, inputs);

        // Run Component
        try {
            let output = await runComponent(componentPath, inputs);

            // Special handling for watcher trigger - also execute the watch component
            if (componentId === 'trigger-watcher' && output?.result?.config?.componentId) {
                const watchComponentId = output.result.config.componentId;
                const watchInputs = { ...(output.result.config.componentInputs || {}) };

                // Create unique watcher ID based on component and inputs
                const watcherId = `${node.id}_${watchComponentId}_${JSON.stringify(watchInputs)}`;

                // Add auth to watch component inputs
                if (userAuth.accessToken) watchInputs._accessToken = userAuth.accessToken;
                if (userAuth.nextcloudUrl) watchInputs._nextcloudUrl = userAuth.nextcloudUrl;
                if (userAuth.appPasswordUsername) watchInputs._appPasswordUsername = userAuth.appPasswordUsername;
                if (userAuth.appPassword) watchInputs._appPassword = userAuth.appPassword;

                const watchComponentPath = componentManager.getComponentPath(watchComponentId);
                if (watchComponentPath) {
                    try {
                        const watchResult = await runComponent(watchComponentPath, watchInputs);
                        // Extract items from watch result
                        let currentItems = [];
                        if (watchResult?.result) {
                            if (Array.isArray(watchResult.result)) {
                                currentItems = watchResult.result;
                            } else if (Array.isArray(watchResult.result.files)) {
                                currentItems = watchResult.result.files;
                            } else if (Array.isArray(watchResult.result.items)) {
                                currentItems = watchResult.result.items;
                            } else if (Array.isArray(watchResult.result.events)) {
                                currentItems = watchResult.result.events;
                            } else if (Array.isArray(watchResult.result.contacts)) {
                                currentItems = watchResult.result.contacts;
                            } else if (Array.isArray(watchResult.result.tasks)) {
                                currentItems = watchResult.result.tasks;
                            }
                        }

                        // Get previous state from SQLite
                        const prevState = watcherStateStore.getWatcherState(watcherId);
                        const prevItems = prevState?.items || {};
                        const previousItems = Object.values(prevItems).map(p => p.data);

                        // Detect changes
                        const getId = (item) => item.id || item.filename || item.href || item.name || JSON.stringify(item);
                        const getModified = (item) => item.lastmod || item.modified || item.updatedAt || item.mtime;

                        const changes = { added: [], modified: [], removed: [] };
                        const currentItemMap = {};

                        currentItems.forEach(item => {
                            const itemId = getId(item);
                            currentItemMap[itemId] = {
                                modified: getModified(item),
                                data: item
                            };

                            if (!prevItems[itemId]) {
                                changes.added.push(item);
                            } else if (prevItems[itemId].modified !== getModified(item)) {
                                changes.modified.push(item);
                            }
                        });

                        // Check for removed items
                        Object.keys(prevItems).forEach(itemId => {
                            if (!currentItemMap[itemId]) {
                                changes.removed.push(prevItems[itemId].data);
                            }
                        });

                        // Save current state to SQLite for next comparison
                        watcherStateStore.saveWatcherState(watcherId, currentItemMap);

                        // Update output with actual data
                        output.result.currentItems = currentItems;
                        output.result.previousItems = previousItems;
                        output.result.addedItems = changes.added;
                        output.result.modifiedItems = changes.modified;
                        output.result.removedItems = changes.removed;
                        output.result.hasChanges = changes.added.length > 0 || changes.modified.length > 0 || changes.removed.length > 0;
                        output.result.watchComponentResult = watchResult.result;
                    } catch (watchErr) {
                        console.error('Failed to execute watch component:', watchErr);
                        output.result.watchError = watchErr.message;
                    }
                }
            }

            executionResults[node.id] = output;
            console.log(`Node ${node.id} finished with output:`, output);
        } catch (err) {
            console.error(`Node ${node.id} failed:`, err);
            throw err;
        }
    }

    return executionResults;
}

function runComponent(componentPath, inputs) {
    return new Promise((resolve, reject) => {
        const entryFile = path.join(componentPath, 'index.js');

        // We use 'spawn' to run a separate node process.
        // We pass inputs via STDIN JSON string.
        const child = spawn('node', [entryFile], {
            cwd: componentPath, // FORCE CWD to component folder for node_modules resolution
            env: process.env
        });

        let stdoutData = '';
        let stderrData = '';

        child.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Component exited with code ${code}: ${stderrData}`));
            }
            try {
                // Attempt to parse last line as JSON output? 
                // Or expect entire stdout to be JSON?
                // Rule: Component MUST output a JSON string as the last line or purely JSON.
                // Let's try parsing the whole output first, if fail, try finding JSON.
                const jsonOutput = JSON.parse(stdoutData.trim());
                resolve(jsonOutput);
            } catch (e) {
                console.error("Failed to parse output:", stdoutData);
                reject(new Error(`Invalid JSON output from component: ${e.message}`));
            }
        });

        // Write inputs
        child.stdin.write(JSON.stringify(inputs));
        child.stdin.end();
    });
}

module.exports = {
    executeWorkflow
};
