const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const COMPONENTS_DIR = path.resolve(__dirname, '../../components');

let components = [];

async function initialize() {
    components = []; // Reset on re-initialize
    console.log(`Scanning components in ${COMPONENTS_DIR}...`);
    if (!fs.existsSync(COMPONENTS_DIR)) {
        fs.mkdirSync(COMPONENTS_DIR);
    }

    const entries = fs.readdirSync(COMPONENTS_DIR, { withFileTypes: true });
    const installPromises = [];

    // First pass: load all component definitions
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const componentPath = path.join(COMPONENTS_DIR, entry.name);
            const packageJsonPath = path.join(componentPath, 'package.json');
            const componentJsonPath = path.join(componentPath, 'component.json');

            if (fs.existsSync(packageJsonPath) && fs.existsSync(componentJsonPath)) {
                // Load definition
                try {
                    const definition = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));
                    components.push({
                        id: entry.name,
                        path: componentPath,
                        definition: definition
                    });
                } catch (e) {
                    console.error(`Error loading definition for ${entry.name}:`, e);
                }
            }
        }
    }

    console.log(`Found ${components.length} components, installing dependencies...`);

    // Second pass: install all dependencies in parallel
    for (const component of components) {
        const installPromise = new Promise((resolve) => {
            exec('npm install --silent', { cwd: component.path }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Failed to install deps for ${component.id}:`, stderr);
                }
                resolve();
            });
        });
        installPromises.push(installPromise);
    }

    // Wait for all installations to complete
    await Promise.all(installPromises);
    console.log(`Initialized ${components.length} components.`);
}

function getComponents() {
    return components;
}

function getComponentPath(id) {
    const comp = components.find(c => c.id === id);
    return comp ? comp.path : null;
}

function removeComponent(id) {
    components = components.filter(c => c.id !== id);
}

// Install and add a single new component (for creation)
async function installComponent(id) {
    const componentPath = path.join(COMPONENTS_DIR, id);
    const componentJsonPath = path.join(componentPath, 'component.json');
    const packageJsonPath = path.join(componentPath, 'package.json');

    if (!fs.existsSync(componentJsonPath) || !fs.existsSync(packageJsonPath)) {
        throw new Error(`Component ${id} missing required files`);
    }

    // Load definition
    const definition = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));

    // Install dependencies
    console.log(`Installing dependencies for ${id}...`);
    await new Promise((resolve) => {
        exec('npm install --silent', { cwd: componentPath }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Failed to install deps for ${id}:`, stderr);
            }
            resolve();
        });
    });

    // Remove existing entry if any
    components = components.filter(c => c.id !== id);

    // Add to components list
    components.push({
        id: id,
        path: componentPath,
        definition: definition
    });

    console.log(`Component ${id} installed successfully.`);
}

// Reload a single component's definition (no reinstall of deps)
function reloadComponent(id) {
    const componentPath = path.join(COMPONENTS_DIR, id);
    const componentJsonPath = path.join(componentPath, 'component.json');

    if (!fs.existsSync(componentJsonPath)) {
        throw new Error(`Component ${id} not found`);
    }

    const definition = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));

    // Find and update existing component
    const index = components.findIndex(c => c.id === id);
    if (index >= 0) {
        components[index].definition = definition;
    } else {
        components.push({
            id: id,
            path: componentPath,
            definition: definition
        });
    }
}

// Reload all component definitions without reinstalling deps
function reloadAll() {
    const entries = fs.readdirSync(COMPONENTS_DIR, { withFileTypes: true });
    components = [];

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const componentPath = path.join(COMPONENTS_DIR, entry.name);
            const packageJsonPath = path.join(componentPath, 'package.json');
            const componentJsonPath = path.join(componentPath, 'component.json');

            if (fs.existsSync(packageJsonPath) && fs.existsSync(componentJsonPath)) {
                try {
                    const definition = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));
                    components.push({
                        id: entry.name,
                        path: componentPath,
                        definition: definition
                    });
                } catch (e) {
                    console.error(`Error loading definition for ${entry.name}:`, e);
                }
            }
        }
    }
    console.log(`Reloaded ${components.length} component definitions.`);
}

// Update a component's files (for AI modification)
async function updateComponent(id, files) {
    const componentPath = path.join(COMPONENTS_DIR, id);

    if (!fs.existsSync(componentPath)) {
        throw new Error(`Component ${id} not found`);
    }

    console.log(`[ComponentManager] Updating component ${id} with ${Object.keys(files).length} files`);

    for (const [filename, content] of Object.entries(files)) {
        const filePath = path.join(componentPath, filename);

        // Security check: prevent directory traversal
        if (!filePath.startsWith(componentPath)) {
            console.warn(`[ComponentManager] Security warning: Attempt to write outside component dir: ${filePath}`);
            continue;
        }

        // If it's a JSON file, ensure it's valid JSON
        if (filename.endsWith('.json') && typeof content === 'string') {
            try {
                // Formatting
                const json = JSON.parse(content);
                fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
            } catch (e) {
                console.warn(`[ComponentManager] Invalid JSON for ${filename}, writing as string`, e);
                fs.writeFileSync(filePath, content, 'utf8');
            }
        } else {
            fs.writeFileSync(filePath, content, 'utf8');
        }
    }

    // If package.json changed, reinstall deps
    if (files['package.json']) {
        console.log(`[ComponentManager] package.json modified, reinstalling dependencies for ${id}...`);
        await new Promise((resolve) => {
            exec('npm install --silent', { cwd: componentPath }, (error, stdout, stderr) => {
                if (error) console.error(`Failed to install deps for ${id}:`, stderr);
                resolve();
            });
        });
    }

    // Reload definition in memory
    reloadComponent(id);

    return { success: true, message: `Component ${id} updated` };
}

// Read all files for a component (for AI analysis)
function readComponentFiles(id) {
    const componentPath = path.join(COMPONENTS_DIR, id);
    if (!fs.existsSync(componentPath)) {
        throw new Error(`Component ${id} not found`);
    }

    const files = {};

    function readDir(dir, relativeRoot = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const relPath = path.join(relativeRoot, entry.name);

            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                readDir(path.join(dir, entry.name), relPath);
            } else {
                // Only text files we care about
                if (/\.(js|json|css|html|md|txt)$/.test(entry.name)) {
                    files[relPath] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
                }
            }
        }
    }

    readDir(componentPath);
    return files;
}

module.exports = {
    initialize,
    getComponents,
    getComponentPath,
    removeComponent,
    installComponent,
    reloadComponent,
    reloadAll,
    updateComponent,
    readComponentFiles
};
