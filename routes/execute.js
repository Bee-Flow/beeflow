const express = require('express');
const fs = require('fs');
const path = require('path');
const executionEngine = require('../core/executionEngine');
const componentManager = require('../core/componentManager');

const router = express.Router();

const { getUserAuth } = require('../utils/routeHelpers');

// Execute a workflow
router.post('/execute', async (req, res) => {
    const { workflow, workflowId, workflowName } = req.body;
    const userAuth = await getUserAuth(req);
    const userId = req.session?.user?.id || 'anonymous';
    const workflowStore = require('../stores/workflowStore');

    // Create execution record (include workflow structure for visual replay)
    let executionId = null;
    if (workflowId && userId !== 'anonymous') {
        const execution = workflowStore.createExecution(workflowId, workflowName || 'Workflow', userId, 'manual', workflow);
        executionId = execution.id;
    }

    try {
        const result = await executionEngine.executeWorkflow(workflow, userAuth);

        // Complete execution record
        if (executionId) {
            const nodesExecuted = Object.keys(result).length;
            workflowStore.completeExecution(executionId, 'success', nodesExecuted, result);
        }

        res.json({ success: true, result, executionId });
    } catch (error) {
        console.error('Execution failed:', error);

        // Log failed execution
        if (executionId) {
            workflowStore.completeExecution(executionId, 'failed', 0, null, error.message);
        }

        res.status(500).json({ success: false, error: error.message });
    }
});

// Test a single component with sample inputs
router.post('/test-component', async (req, res) => {
    const { componentId, inputs } = req.body;

    if (!componentId) {
        return res.status(400).json({ error: 'componentId is required' });
    }

    const components = componentManager.getComponents();
    const component = components.find(c => c.id === componentId);

    if (!component) {
        return res.status(404).json({ error: `Component '${componentId}' not found` });
    }

    const userAuth = await getUserAuth(req);

    const testWorkflow = {
        nodes: [{
            id: 'test-node',
            type: 'custom',
            data: {
                componentId: componentId,
                inputValues: inputs || {}
            }
        }],
        edges: []
    };

    try {
        const result = await executionEngine.executeWorkflow(testWorkflow, userAuth);
        const nodeResult = result['test-node'];
        res.json(nodeResult || { output: 'No output' });
    } catch (error) {
        console.error('Component test failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Execute a workflow as a subworkflow (called by another workflow or agent)
router.post('/subworkflow/:workflowId', async (req, res) => {
    const { workflowId } = req.params;
    const { inputData, callerId } = req.body;
    const userAuth = await getUserAuth(req);
    const userId = req.session?.user?.id || 'anonymous';
    const workflowStore = require('../stores/workflowStore');

    try {
        // Get the target workflow
        const workflow = workflowStore.getWorkflow(workflowId, userId);
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        // Check if workflow has a subworkflow trigger
        const hasTrigger = workflow.nodes?.some(n =>
            n.type === 'trigger-subworkflow' ||
            n.data?.componentId === 'trigger-subworkflow'
        );

        if (!hasTrigger) {
            return res.status(400).json({
                error: 'Workflow does not have a Subworkflow Trigger component'
            });
        }

        // Inject trigger metadata into the first trigger node
        const workflowCopy = JSON.parse(JSON.stringify(workflow));
        const triggerNode = workflowCopy.nodes.find(n =>
            n.type === 'trigger-subworkflow' ||
            n.data?.componentId === 'trigger-subworkflow'
        );

        if (triggerNode) {
            triggerNode.data = triggerNode.data || {};
            triggerNode.data.inputValues = {
                ...(triggerNode.data.inputValues || {}),
                inputData: inputData || {},
                _triggerType: 'subworkflow',
                _callerId: callerId || 'api'
            };
        }

        // Create execution record
        let executionId = null;
        if (userId !== 'anonymous') {
            const execution = workflowStore.createExecution(
                workflowId,
                workflow.name || 'Subworkflow',
                userId,
                'subworkflow',
                workflowCopy
            );
            executionId = execution.id;
        }

        // Execute the workflow
        const result = await executionEngine.executeWorkflow(workflowCopy, userAuth);

        // Log completion
        if (executionId) {
            const nodesExecuted = Object.keys(result).length;
            workflowStore.completeExecution(executionId, 'success', nodesExecuted, result);
        }

        res.json({ success: true, result, executionId });
    } catch (error) {
        console.error('Subworkflow execution failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
