/**
 * Terminal Agent — Command Validation & Sandboxing
 * 
 * Validates commands against a blocklist and enforces path sandboxing
 * to prevent dangerous operations.
 */

const path = require('path');

// Default blocked patterns — always blocked regardless of config
const ALWAYS_BLOCKED = [
    /rm\s+(-[a-z]*f[a-z]*\s+)?\/\s*$/i,     // rm -rf /
    /mkfs/i,                                    // filesystem formatting
    /dd\s+if=/i,                                // raw disk write
    /:\(\)\{.*\|.*&\}.*;.*:/,                   // fork bomb
    /shutdown/i,
    /reboot/i,
    /halt/i,
    /poweroff/i,
    /init\s+[06]/i,
    /systemctl\s+(poweroff|reboot|halt)/i,
    /chmod\s+(-[rR]\s+)?[0-7]*\s+\//i,         // chmod on root
    /chown\s+(-[rR]\s+)?.*\s+\//i,             // chown on root
];

/**
 * Validate a command against blocklists.
 * @param {string} command - The command to validate
 * @param {string[]} blockedCommands - Additional blocked command patterns from config
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateCommand(command, blockedCommands = []) {
    if (!command || typeof command !== 'string') {
        return { allowed: false, reason: 'Empty or invalid command' };
    }

    const trimmed = command.trim();

    // Check always-blocked patterns
    for (const pattern of ALWAYS_BLOCKED) {
        if (pattern.test(trimmed)) {
            return { allowed: false, reason: `Blocked: dangerous command pattern detected` };
        }
    }

    // Check user-configured blocked commands
    for (const blocked of blockedCommands) {
        if (typeof blocked === 'string' && trimmed.toLowerCase().includes(blocked.toLowerCase())) {
            return { allowed: false, reason: `Blocked: command matches blocklist entry "${blocked}"` };
        }
    }

    return { allowed: true };
}

/**
 * Resolve a file path within the sandbox.
 * If sandboxMode is enabled, ensures the path stays within the working directory.
 * @param {string} filePath - The requested file path
 * @param {string} workingDirectory - The sandbox root
 * @param {boolean} sandboxMode - Whether to enforce sandboxing
 * @returns {{ resolvedPath: string, allowed: boolean, reason?: string }}
 */
function resolveSandboxedPath(filePath, workingDirectory, sandboxMode = true) {
    if (!filePath) {
        return { resolvedPath: '', allowed: false, reason: 'Empty file path' };
    }

    // Resolve the path
    const resolved = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(workingDirectory || process.cwd(), filePath);

    // If sandbox mode is off, allow anything
    if (!sandboxMode || !workingDirectory) {
        return { resolvedPath: resolved, allowed: true };
    }

    // Ensure the resolved path is within the working directory
    const normalizedWork = path.resolve(workingDirectory);
    if (!resolved.startsWith(normalizedWork + path.sep) && resolved !== normalizedWork) {
        return {
            resolvedPath: resolved,
            allowed: false,
            reason: `Path "${filePath}" resolves outside the sandbox directory`
        };
    }

    return { resolvedPath: resolved, allowed: true };
}

module.exports = {
    validateCommand,
    resolveSandboxedPath
};
