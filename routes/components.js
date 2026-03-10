const express = require('express');
const fs = require('fs');
const path = require('path');
const componentManager = require('../core/componentManager');

const router = express.Router();
const COMPONENTS_DIR = path.resolve(__dirname, '../../components');

// List all components
router.get('/', (req, res) => {
    res.json(componentManager.getComponents());
});

// Create a new component
router.post('/', async (req, res) => {
    try {
        const { id, name, description, category, inputs, outputs, code, dependencies, agentEnabled, directChatEnabled } = req.body;

        if (!id || !id.match(/^[a-z0-9-]+$/)) {
            return res.status(400).json({ error: 'Invalid component ID. Use lowercase letters, numbers, and hyphens only.' });
        }

        const componentDir = path.join(COMPONENTS_DIR, id);
        if (fs.existsSync(componentDir)) {
            return res.status(400).json({ error: 'Component with this ID already exists.' });
        }

        // Create component directory
        fs.mkdirSync(componentDir, { recursive: true });

        // Create component.json
        const componentJson = {
            name: name || id,
            description: description || '',
            category: category || 'Custom',
            inputs: inputs || {},
            outputs: outputs || { result: 'any' },
            agentEnabled: agentEnabled !== undefined ? agentEnabled : true,
            directChatEnabled: directChatEnabled === true
        };
        fs.writeFileSync(path.join(componentDir, 'component.json'), JSON.stringify(componentJson, null, 2));

        // Create package.json
        const packageJson = {
            name: id,
            version: '1.0.0',
            dependencies: dependencies || {}
        };
        fs.writeFileSync(path.join(componentDir, 'package.json'), JSON.stringify(packageJson, null, 2));

        // Create index.js
        const defaultCode = code || `// ${name || id} Component
// Reads JSON input from stdin, outputs JSON to stdout

let inputData = '';
process.stdin.on('data', chunk => {
    inputData += chunk;
});

process.stdin.on('end', () => {
    try {
        const inputs = JSON.parse(inputData);
        
        // Your component logic here
        const result = {
            message: 'Hello from ${name || id}!',
            receivedInputs: inputs
        };
        
        console.log(JSON.stringify(result));
    } catch (e) {
        process.stderr.write(e.message);
        process.exit(1);
    }
});`;
        fs.writeFileSync(path.join(componentDir, 'index.js'), defaultCode);

        // Install only this new component
        await componentManager.installComponent(id);

        res.json({ success: true, id, message: 'Component created successfully' });
    } catch (error) {
        console.error('Failed to create component:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get a specific component's full details
router.get('/:id', (req, res) => {
    try {
        const componentDir = path.join(COMPONENTS_DIR, req.params.id);
        if (!fs.existsSync(componentDir)) {
            return res.status(404).json({ error: 'Component not found' });
        }

        const componentJson = JSON.parse(fs.readFileSync(path.join(componentDir, 'component.json'), 'utf8'));
        const packageJson = JSON.parse(fs.readFileSync(path.join(componentDir, 'package.json'), 'utf8'));
        const code = fs.readFileSync(path.join(componentDir, 'index.js'), 'utf8');

        // Redact secure input defaults before sending to client
        if (componentJson.inputs) {
            for (const [key, value] of Object.entries(componentJson.inputs)) {
                if (typeof value === 'object' && value.secure && value.default) {
                    value.default = '';  // Clear the actual value
                    value._hasStoredValue = true;  // Signal to client that a value exists
                }
            }
        }

        res.json({
            id: req.params.id,
            ...componentJson,
            dependencies: packageJson.dependencies || {},
            code
        });
    } catch (error) {
        console.error('Failed to get component:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update a component
router.put('/:id', async (req, res) => {
    try {
        const componentDir = path.join(COMPONENTS_DIR, req.params.id);
        if (!fs.existsSync(componentDir)) {
            return res.status(404).json({ error: 'Component not found' });
        }

        const { name, description, category, inputs, outputs, code, dependencies, aiContext, sampleOutput, agentEnabled, directChatEnabled } = req.body;

        // Update component.json
        const componentJsonPath = path.join(componentDir, 'component.json');
        const existingComponent = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));

        // Preserve secure input defaults if client sends empty placeholder
        let mergedInputs = inputs;
        if (inputs !== undefined && existingComponent.inputs) {
            mergedInputs = { ...inputs };
            for (const [key, value] of Object.entries(mergedInputs)) {
                if (typeof value === 'object' && value.secure && value._hasStoredValue && !value.default) {
                    // Client sent placeholder - preserve existing stored value
                    const existingInput = existingComponent.inputs[key];
                    if (typeof existingInput === 'object' && existingInput.default) {
                        value.default = existingInput.default;
                    }
                }
                // Clean up internal flag before saving
                if (typeof value === 'object') {
                    delete value._hasStoredValue;
                }
            }
        }

        const updatedComponent = {
            ...existingComponent,
            name: name !== undefined ? name : existingComponent.name,
            description: description !== undefined ? description : existingComponent.description,
            category: category !== undefined ? category : existingComponent.category,
            inputs: mergedInputs !== undefined ? mergedInputs : existingComponent.inputs,
            outputs: outputs !== undefined ? outputs : existingComponent.outputs,
            aiContext: aiContext !== undefined ? aiContext : existingComponent.aiContext,
            sampleOutput: sampleOutput !== undefined ? sampleOutput : existingComponent.sampleOutput,
            agentEnabled: agentEnabled !== undefined ? agentEnabled : existingComponent.agentEnabled,
            directChatEnabled: directChatEnabled !== undefined ? directChatEnabled : existingComponent.directChatEnabled
        };
        fs.writeFileSync(componentJsonPath, JSON.stringify(updatedComponent, null, 2));

        // Update package.json if dependencies changed
        if (dependencies !== undefined) {
            const packageJsonPath = path.join(componentDir, 'package.json');
            const existingPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            existingPackage.dependencies = dependencies;
            fs.writeFileSync(packageJsonPath, JSON.stringify(existingPackage, null, 2));
        }

        // Update code
        if (code !== undefined) {
            fs.writeFileSync(path.join(componentDir, 'index.js'), code);
        }

        // Reinstall only this component if dependencies changed
        if (dependencies !== undefined) {
            await componentManager.installComponent(req.params.id);
        } else {
            // Just reload the definition
            componentManager.reloadComponent(req.params.id);
        }

        res.json({ success: true, message: 'Component updated successfully' });
    } catch (error) {
        console.error('Failed to update component:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a component
router.delete('/:id', (req, res) => {
    try {
        const componentDir = path.join(COMPONENTS_DIR, req.params.id);
        if (!fs.existsSync(componentDir)) {
            return res.status(404).json({ error: 'Component not found' });
        }

        // Remove directory recursively
        fs.rmSync(componentDir, { recursive: true, force: true });

        // Remove from memory
        componentManager.removeComponent(req.params.id);

        res.json({ success: true, message: 'Component deleted successfully' });
    } catch (error) {
        console.error('Failed to delete component:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
