/**
 * Terminal Agent — Container Manager
 * 
 * Manages Docker container lifecycle for terminal agent conversations.
 * Each conversation gets its own isolated container.
 * Containers are auto-removed after 60 minutes of inactivity.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOCKER_IMAGE = 'terminal-agent-env';
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;     // check every 5 minutes

// In-memory container tracking
// Map<containerKey, { containerId, lastActivity, agentId }>
const activeContainers = new Map();

let cleanupTimer = null;

// ─── Container Lifecycle ─────────────────────────────────────────

/**
 * Get or create a Docker container for a conversation/key.
 * @param {string} containerKey - Unique key (conversationId or swarm-<swarmId>)
 * @param {string} agentId - The terminal agent ID (for logging)
 * @returns {string} containerId
 */
async function getOrCreateContainer(containerKey, agentId) {
    // Return existing if alive
    const existing = activeContainers.get(containerKey);
    if (existing) {
        // Verify container is still running
        try {
            const status = execSync(`docker inspect -f '{{.State.Running}}' ${existing.containerId}`, { encoding: 'utf-8', timeout: 5000 }).trim();
            if (status === 'true') {
                existing.lastActivity = Date.now();
                return existing.containerId;
            }
        } catch (e) {
            // Container is gone — remove from map and recreate
            activeContainers.delete(containerKey);
        }
    }

    // Create a new container
    const containerName = `terminal-agent-${containerKey.substring(0, 12).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;

    // Remove any stale container with same name
    try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'pipe', timeout: 10000 });
    } catch (e) { /* doesn't exist, fine */ }

    console.log(`[ContainerManager] Creating container: ${containerName} (key=${containerKey}, agent=${agentId})`);

    const containerId = execSync(
        `docker run -d --name ${containerName} --label terminal-agent=true --label container-key=${containerKey} ${DOCKER_IMAGE}`,
        { encoding: 'utf-8', timeout: 30000 }
    ).trim();

    activeContainers.set(containerKey, {
        containerId,
        containerName,
        lastActivity: Date.now(),
        agentId
    });

    console.log(`[ContainerManager] Container created: ${containerId.substring(0, 12)} (${containerName})`);
    return containerId;
}

/**
 * Execute a command inside a container.
 * Returns { stdout, stderr, exitCode }.
 * Streams stdout chunks via onOutput callback if provided.
 */
function execInContainer(containerKey, command, opts = {}) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    const { cwd = '/workspace', timeout = 60000, signal, onOutput } = opts;

    return new Promise((resolve, reject) => {
        const args = ['exec', '-w', cwd, entry.containerId, 'bash', '-c', command];
        const proc = spawn('docker', args, {
            timeout,
            signal: signal || undefined
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            if (onOutput) onOutput('stdout', chunk);
        });

        proc.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
        });

        proc.on('close', (code) => {
            resolve({ stdout, stderr, exitCode: code });
        });

        proc.on('error', (err) => {
            resolve({ stdout: '', stderr: err.message, exitCode: 1 });
        });
    });
}

/**
 * Execute a Python command inside a container.
 */
function execPythonInContainer(containerKey, code, opts = {}) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    const { cwd = '/workspace', timeout = 60000, signal, onOutput } = opts;

    return new Promise((resolve) => {
        const args = ['exec', '-w', cwd, entry.containerId, 'python', '-c', code];
        const proc = spawn('docker', args, {
            timeout,
            signal: signal || undefined
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            if (onOutput) onOutput('stdout', chunk);
        });

        proc.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
        });

        proc.on('close', (code) => {
            resolve({ stdout, stderr, exitCode: code });
        });

        proc.on('error', (err) => {
            resolve({ stdout: '', stderr: err.message, exitCode: 1 });
        });
    });
}

/**
 * Write a file inside a container by piping content via docker exec.
 */
async function writeFileInContainer(containerKey, filePath, content) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    // Ensure parent directory exists, then write via heredoc
    const dir = path.dirname(filePath);

    return new Promise((resolve) => {
        const proc = spawn('docker', ['exec', '-i', entry.containerId, 'bash', '-c', `mkdir -p "${dir}" && cat > "${filePath}"`], {
            timeout: 15000
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true });
            } else {
                resolve({ success: false, error: stderr });
            }
        });

        proc.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });

        proc.stdin.write(content);
        proc.stdin.end();
    });
}

/**
 * Read a file from inside a container.
 */
async function readFileInContainer(containerKey, filePath, maxLines = 200) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    const cmd = maxLines ? `head -n ${maxLines} "${filePath}"` : `cat "${filePath}"`;
    const result = await execInContainer(containerKey, cmd);

    if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Failed to read file: ${filePath}`);
    }
    return result.stdout;
}

/**
 * Copy a file from a container to the host filesystem.
 * Used for file downloads.
 */
function copyFromContainer(containerKey, containerPath, hostPath) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    // Ensure host directory exists
    const hostDir = path.dirname(hostPath);
    if (!fs.existsSync(hostDir)) {
        fs.mkdirSync(hostDir, { recursive: true });
    }

    execSync(`docker cp ${entry.containerId}:${containerPath} "${hostPath}"`, { timeout: 30000 });
    return hostPath;
}

/**
 * Copy a file from the host filesystem into a container.
 * Used for pre-loading agent files into /workspace.
 */
function copyToContainer(containerKey, hostPath, containerPath) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    execSync(`docker cp "${hostPath}" ${entry.containerId}:${containerPath}`, { timeout: 30000 });
}

/**
 * List files in a container directory.
 */
async function listFilesInContainer(containerKey, dirPath = '/workspace') {
    const result = await execInContainer(containerKey, `find "${dirPath}" -maxdepth 3 -type f 2>/dev/null | head -100`);
    if (result.exitCode !== 0) return [];
    return result.stdout.trim().split('\n').filter(Boolean);
}

/**
 * Snapshot workspace files (for file-change detection).
 * Returns Map<relativePath, mtimeMs>
 */
async function snapshotWorkspace(containerKey, dirPath = '/workspace') {
    const result = await execInContainer(containerKey, `find "${dirPath}" -maxdepth 3 -type f -printf '%T@ %p\\n' 2>/dev/null | head -500`);
    const files = new Map();
    if (result.exitCode === 0 && result.stdout.trim()) {
        for (const line of result.stdout.trim().split('\n')) {
            const spaceIdx = line.indexOf(' ');
            if (spaceIdx > 0) {
                const mtime = parseFloat(line.substring(0, spaceIdx));
                const filePath = line.substring(spaceIdx + 1);
                files.set(filePath, mtime);
            }
        }
    }
    return files;
}

/**
 * Touch activity for a container key (extend its lifetime).
 */
function touchActivity(containerKey) {
    const entry = activeContainers.get(containerKey);
    if (entry) {
        entry.lastActivity = Date.now();
    }
}

// ─── Cleanup ─────────────────────────────────────────────────────

/**
 * Start the periodic cleanup timer.
 */
function startCleanupTimer() {
    if (cleanupTimer) return;

    console.log(`[ContainerManager] Starting cleanup timer (interval=${CLEANUP_INTERVAL_MS / 1000}s, timeout=${INACTIVITY_TIMEOUT_MS / 60000}min)`);

    cleanupTimer = setInterval(() => {
        const now = Date.now();
        const toRemove = [];

        for (const [key, entry] of activeContainers) {
            const idleMs = now - entry.lastActivity;
            if (idleMs > INACTIVITY_TIMEOUT_MS) {
                toRemove.push(key);
            }
        }

        for (const key of toRemove) {
            const entry = activeContainers.get(key);
            console.log(`[ContainerManager] Removing idle container: ${entry.containerName} (idle ${Math.round((now - entry.lastActivity) / 60000)}min)`);
            try {
                execSync(`docker rm -f ${entry.containerId}`, { stdio: 'pipe', timeout: 15000 });
            } catch (e) {
                console.error(`[ContainerManager] Failed to remove container ${entry.containerName}:`, e.message);
            }
            activeContainers.delete(key);
        }

        if (toRemove.length > 0) {
            console.log(`[ContainerManager] Cleanup: removed ${toRemove.length} idle container(s). Active: ${activeContainers.size}`);
        }
    }, CLEANUP_INTERVAL_MS);

    // Don't keep the process alive just for cleanup
    cleanupTimer.unref();
}

/**
 * Remove ALL active containers (called on server shutdown).
 */
function shutdownAll() {
    console.log(`[ContainerManager] Shutting down — removing ${activeContainers.size} container(s)...`);

    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }

    for (const [key, entry] of activeContainers) {
        try {
            execSync(`docker rm -f ${entry.containerId}`, { stdio: 'pipe', timeout: 10000 });
            console.log(`[ContainerManager] Removed: ${entry.containerName}`);
        } catch (e) {
            console.error(`[ContainerManager] Failed to remove ${entry.containerName}:`, e.message);
        }
    }

    activeContainers.clear();
}

/**
 * Ensure the Docker image is built. Called on server startup.
 */
function ensureDockerImage() {
    try {
        const images = execSync(`docker images -q ${DOCKER_IMAGE}`, { encoding: 'utf-8', timeout: 10000 }).trim();
        if (images) {
            console.log(`[ContainerManager] Docker image '${DOCKER_IMAGE}' already exists`);
            return;
        }
    } catch (e) { /* continue to build */ }

    console.log(`[ContainerManager] Building Docker image '${DOCKER_IMAGE}'...`);
    const dockerfilePath = path.join(__dirname, 'Dockerfile.terminal-agent');
    execSync(`docker build -t ${DOCKER_IMAGE} -f "${dockerfilePath}" "${path.dirname(dockerfilePath)}"`, {
        stdio: 'inherit',
        timeout: 120000
    });
    console.log(`[ContainerManager] Docker image '${DOCKER_IMAGE}' built successfully`);
}

/**
 * Get the number of active containers (for monitoring).
 */
function getActiveCount() {
    return activeContainers.size;
}

/**
 * Get details about active containers.
 */
function getActiveContainers() {
    const result = [];
    for (const [key, entry] of activeContainers) {
        result.push({
            key,
            containerId: entry.containerId.substring(0, 12),
            containerName: entry.containerName,
            agentId: entry.agentId,
            idleMinutes: Math.round((Date.now() - entry.lastActivity) / 60000)
        });
    }
    return result;
}

module.exports = {
    getOrCreateContainer,
    execInContainer,
    execPythonInContainer,
    writeFileInContainer,
    readFileInContainer,
    copyFromContainer,
    copyToContainer,
    listFilesInContainer,
    snapshotWorkspace,
    touchActivity,
    startCleanupTimer,
    shutdownAll,
    ensureDockerImage,
    getActiveCount,
    getActiveContainers
};
