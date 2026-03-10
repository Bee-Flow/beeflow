/**
 * Security Agent — Container Manager
 * 
 * Manages Docker container lifecycle for security agent conversations.
 * Uses a dedicated Docker image with Nuclei pre-installed.
 * Each conversation gets its own isolated container.
 * 
 * Mirrors terminal/containerManager.js but uses a security-specific image.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOCKER_IMAGE = 'security-agent-env';
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes (scans can be long)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// In-memory container tracking
const activeContainers = new Map();
let cleanupTimer = null;

// ─── Container Lifecycle ─────────────────────────────────────────

async function getOrCreateContainer(containerKey, agentId) {
    const existing = activeContainers.get(containerKey);
    if (existing) {
        try {
            const status = execSync(`docker inspect -f '{{.State.Running}}' ${existing.containerId}`, { encoding: 'utf-8', timeout: 5000 }).trim();
            if (status === 'true') {
                existing.lastActivity = Date.now();
                return existing.containerId;
            }
        } catch (e) {
            activeContainers.delete(containerKey);
        }
    }

    const containerName = `security-agent-${containerKey.substring(0, 12).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;

    try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'pipe', timeout: 10000 });
    } catch (e) { /* doesn't exist */ }

    console.log(`[SecurityContainerManager] Creating container: ${containerName} (key=${containerKey}, agent=${agentId})`);

    const containerId = execSync(
        `docker run -d --network host --name ${containerName} --label security-agent=true --label container-key=${containerKey} ${DOCKER_IMAGE}`,
        { encoding: 'utf-8', timeout: 30000 }
    ).trim();

    activeContainers.set(containerKey, {
        containerId,
        containerName,
        lastActivity: Date.now(),
        agentId
    });

    console.log(`[SecurityContainerManager] Container created: ${containerId.substring(0, 12)} (${containerName})`);
    return containerId;
}

function execInContainer(containerKey, command, opts = {}) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    const { cwd = '/workspace', timeout = 120000, signal, onOutput } = opts;

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

async function writeFileInContainer(containerKey, filePath, content) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();
    const dir = path.dirname(filePath);

    return new Promise((resolve) => {
        const proc = spawn('docker', ['exec', '-i', entry.containerId, 'bash', '-c', `mkdir -p "${dir}" && cat > "${filePath}"`], {
            timeout: 15000
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) resolve({ success: true });
            else resolve({ success: false, error: stderr });
        });

        proc.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });

        proc.stdin.write(content);
        proc.stdin.end();
    });
}

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

function copyFromContainer(containerKey, containerPath, hostPath) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    const hostDir = path.dirname(hostPath);
    if (!fs.existsSync(hostDir)) {
        fs.mkdirSync(hostDir, { recursive: true });
    }

    execSync(`docker cp ${entry.containerId}:${containerPath} "${hostPath}"`, { timeout: 30000 });
    return hostPath;
}

function copyToContainer(containerKey, hostPath, containerPath) {
    const entry = activeContainers.get(containerKey);
    if (!entry) throw new Error(`No container found for key: ${containerKey}`);

    entry.lastActivity = Date.now();

    execSync(`docker cp "${hostPath}" ${entry.containerId}:${containerPath}`, { timeout: 30000 });
}

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

function touchActivity(containerKey) {
    const entry = activeContainers.get(containerKey);
    if (entry) entry.lastActivity = Date.now();
}

// ─── Cleanup ─────────────────────────────────────────────────────

function startCleanupTimer() {
    if (cleanupTimer) return;

    console.log(`[SecurityContainerManager] Starting cleanup timer (interval=${CLEANUP_INTERVAL_MS / 1000}s, timeout=${INACTIVITY_TIMEOUT_MS / 60000}min)`);

    cleanupTimer = setInterval(() => {
        const now = Date.now();
        const toRemove = [];

        for (const [key, entry] of activeContainers) {
            if (now - entry.lastActivity > INACTIVITY_TIMEOUT_MS) {
                toRemove.push(key);
            }
        }

        for (const key of toRemove) {
            const entry = activeContainers.get(key);
            console.log(`[SecurityContainerManager] Removing idle container: ${entry.containerName}`);
            try {
                execSync(`docker rm -f ${entry.containerId}`, { stdio: 'pipe', timeout: 15000 });
            } catch (e) {
                console.error(`[SecurityContainerManager] Failed to remove container:`, e.message);
            }
            activeContainers.delete(key);
        }

        if (toRemove.length > 0) {
            console.log(`[SecurityContainerManager] Cleanup: removed ${toRemove.length} idle container(s). Active: ${activeContainers.size}`);
        }
    }, CLEANUP_INTERVAL_MS);

    cleanupTimer.unref();
}

function shutdownAll() {
    console.log(`[SecurityContainerManager] Shutting down — removing ${activeContainers.size} container(s)...`);

    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }

    for (const [key, entry] of activeContainers) {
        try {
            execSync(`docker rm -f ${entry.containerId}`, { stdio: 'pipe', timeout: 10000 });
            console.log(`[SecurityContainerManager] Removed: ${entry.containerName}`);
        } catch (e) {
            console.error(`[SecurityContainerManager] Failed to remove ${entry.containerName}:`, e.message);
        }
    }

    activeContainers.clear();
}

function ensureDockerImage() {
    try {
        const images = execSync(`docker images -q ${DOCKER_IMAGE}`, { encoding: 'utf-8', timeout: 10000 }).trim();
        if (images) {
            console.log(`[SecurityContainerManager] Docker image '${DOCKER_IMAGE}' already exists`);
            return;
        }
    } catch (e) { /* continue to build */ }

    console.log(`[SecurityContainerManager] Building Docker image '${DOCKER_IMAGE}'...`);
    const dockerfilePath = path.join(__dirname, 'Dockerfile.security-agent');
    execSync(`docker build -t ${DOCKER_IMAGE} -f "${dockerfilePath}" "${path.dirname(dockerfilePath)}"`, {
        stdio: 'inherit',
        timeout: 300000 // 5 min — Go + Nuclei install can be slow
    });
    console.log(`[SecurityContainerManager] Docker image '${DOCKER_IMAGE}' built successfully`);
}

function getActiveCount() {
    return activeContainers.size;
}

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
    writeFileInContainer,
    readFileInContainer,
    copyFromContainer,
    copyToContainer,
    snapshotWorkspace,
    touchActivity,
    startCleanupTimer,
    shutdownAll,
    ensureDockerImage,
    getActiveCount,
    getActiveContainers
};
