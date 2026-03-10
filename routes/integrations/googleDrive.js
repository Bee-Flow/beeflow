/**
 * Google Drive Integration Routes
 * 
 * Provides endpoints for browsing and exporting Google Drive files
 * (Docs, Sheets, Slides) for use as chat attachments.
 * 
 * Uses the official `googleapis` SDK with per-user OAuth2 tokens.
 */

const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { loadConfig } = require('../../auth/permissions');

// MIME types for Google Workspace files
const WORKSPACE_MIME_TYPES = {
    'application/vnd.google-apps.document': { name: 'Google Doc', icon: '📄', exportMime: 'text/plain' },
    'application/vnd.google-apps.spreadsheet': { name: 'Google Sheet', icon: '📊', exportMime: 'text/csv' },
    'application/vnd.google-apps.presentation': { name: 'Google Slides', icon: '📽️', exportMime: 'text/plain' },
};

const WORKSPACE_QUERY = Object.keys(WORKSPACE_MIME_TYPES)
    .map(m => `mimeType='${m}'`)
    .join(' or ');

/**
 * Create an authenticated Google Drive client from session tokens.
 */
async function createDriveClient(req) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured. Set up Google SSO in Admin → Security.');
    }

    const accessToken = req.session?.accessToken;
    const refreshToken = req.session?.refreshToken;

    if (!accessToken) {
        throw new Error('NOT_CONNECTED');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken
    });

    // Auto-refresh handler: update session when tokens refresh
    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) {
            req.session.accessToken = tokens.access_token;
        }
        if (tokens.refresh_token) {
            req.session.refreshToken = tokens.refresh_token;
        }
        req.session.save?.();
    });

    return google.drive({ version: 'v3', auth: oauth2Client });
}

// ─── Status Check ────────────────────────────────────────────────

router.get('/status', async (req, res) => {
    const isConnected = !!(req.session?.accessToken && req.session?.oauthProvider === 'google');
    const config = await loadConfig();
    const isConfigured = !!(config.providers?.google?.clientId && config.providers?.google?.clientSecret);

    console.log('[GoogleDrive] Status check — hasAccessToken:', !!req.session?.accessToken, 'oauthProvider:', req.session?.oauthProvider, 'connected:', isConnected);

    res.json({
        connected: isConnected,
        configured: isConfigured,
        user: isConnected ? req.session.user : null,
    });
});

// ─── List / Search Files ─────────────────────────────────────────

router.get('/files', async (req, res) => {
    try {
        const drive = await createDriveClient(req);
        const { query, pageToken, pageSize = 20 } = req.query;

        // Build the query
        let q = `(${WORKSPACE_QUERY}) and trashed=false`;
        if (query) {
            q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
        }

        const response = await drive.files.list({
            q,
            pageSize: Math.min(parseInt(pageSize) || 20, 50),
            pageToken: pageToken || undefined,
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, iconLink, owners, size)',
            orderBy: 'modifiedTime desc',
        });

        const files = (response.data.files || []).map(f => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            type: WORKSPACE_MIME_TYPES[f.mimeType]?.name || 'File',
            icon: WORKSPACE_MIME_TYPES[f.mimeType]?.icon || '📄',
            modifiedTime: f.modifiedTime,
            owner: f.owners?.[0]?.displayName || '',
        }));

        res.json({
            files,
            nextPageToken: response.data.nextPageToken || null,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Google Drive', code: 'NOT_CONNECTED' });
        }
        console.error('[GoogleDrive] List files error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Export File Content ─────────────────────────────────────────

router.get('/export/:fileId', async (req, res) => {
    try {
        const drive = await createDriveClient(req);
        const { fileId } = req.params;

        // Get file metadata first
        const meta = await drive.files.get({
            fileId,
            fields: 'id, name, mimeType',
        });

        const mimeType = meta.data.mimeType;
        const exportConfig = WORKSPACE_MIME_TYPES[mimeType];

        if (!exportConfig) {
            return res.status(400).json({ error: `Unsupported file type: ${mimeType}` });
        }

        // Export the file content
        const exported = await drive.files.export({
            fileId,
            mimeType: exportConfig.exportMime,
        }, { responseType: 'text' });

        const content = typeof exported.data === 'string'
            ? exported.data
            : JSON.stringify(exported.data);

        // Truncate very large files
        const MAX_CHARS = 100000; // ~100k chars
        const truncated = content.length > MAX_CHARS;
        const finalContent = truncated
            ? content.substring(0, MAX_CHARS) + '\n\n[... truncated, file too large ...]'
            : content;

        res.json({
            id: meta.data.id,
            name: meta.data.name,
            mimeType: mimeType,
            type: exportConfig.name,
            content: finalContent,
            truncated,
            charCount: content.length,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Google Drive', code: 'NOT_CONNECTED' });
        }
        console.error('[GoogleDrive] Export error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
