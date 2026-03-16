/**
 * OneDrive Routes — REST API for OneDrive integration UI
 * 
 * Mirror of googleDrive.js for Microsoft 365 users.
 * Provides endpoints for the frontend file picker and browsing.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { isMicrosoftConnected, graphFetch } = require('../../integrations/msGraphClient');

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    const isConnected = isMicrosoftConnected(req.session);
    console.log('[OneDrive] Status check — hasAccessToken:', !!req.session?.accessToken, 'oauthProvider:', req.session?.oauthProvider, 'connected:', isConnected);
    res.json({ connected: isConnected });
});

// ── List / Browse Files ─────────────────────────────────────────────────────
router.get('/files', requireAuth, async (req, res) => {
    if (!isMicrosoftConnected(req.session)) {
        return res.status(401).json({ error: 'Not connected to OneDrive' });
    }

    try {
        const { folderId, search, top = '25' } = req.query;
        const limit = Math.min(Math.max(parseInt(top) || 25, 1), 50);

        let path;
        if (search) {
            path = `/me/drive/root/search(q='${encodeURIComponent(search)}')?$top=${limit}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl`;
        } else if (folderId) {
            path = `/me/drive/items/${folderId}/children?$top=${limit}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl&$orderby=name`;
        } else {
            path = `/me/drive/root/children?$top=${limit}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl&$orderby=name`;
        }

        const data = await graphFetch(path, req.session);

        const items = (data.value || []).map(item => ({
            id: item.id,
            name: item.name,
            type: item.folder ? 'folder' : (item.file?.mimeType || 'file'),
            size: item.size || 0,
            lastModified: item.lastModifiedDateTime || '',
            createdBy: item.createdBy?.user?.displayName || '',
            webUrl: item.webUrl || '',
            isFolder: !!item.folder,
            childCount: item.folder?.childCount || 0,
        }));

        res.json({ items, total: items.length });

    } catch (err) {
        console.error('[OneDrive] Error listing files:', err.message);
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Microsoft session expired' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ── Get File Content / Download ─────────────────────────────────────────────
router.get('/export/:fileId', requireAuth, async (req, res) => {
    if (!isMicrosoftConnected(req.session)) {
        return res.status(401).json({ error: 'Not connected to OneDrive' });
    }

    try {
        const { fileId } = req.params;

        // Get file metadata with download URL
        const item = await graphFetch(
            `/me/drive/items/${fileId}?$select=id,name,file,size,@microsoft.graph.downloadUrl`,
            req.session
        );

        if (!item['@microsoft.graph.downloadUrl']) {
            return res.status(400).json({ error: 'No download URL available for this item' });
        }

        // For text-based files, download and return content
        const textMimeTypes = [
            'text/plain', 'text/csv', 'text/html', 'text/markdown',
            'application/json', 'application/xml',
            'application/javascript',
        ];

        const mimeType = item.file?.mimeType || '';
        const isText = textMimeTypes.some(t => mimeType.startsWith(t));

        if (isText && item.size < 500000) {
            // Download and return text content
            const contentResponse = await fetch(item['@microsoft.graph.downloadUrl']);
            const text = await contentResponse.text();
            return res.json({
                id: item.id,
                name: item.name,
                mimeType,
                content: text,
                size: item.size,
            });
        }

        // For other files, return the download URL
        res.json({
            id: item.id,
            name: item.name,
            mimeType,
            downloadUrl: item['@microsoft.graph.downloadUrl'],
            size: item.size,
            message: 'Use the downloadUrl to access the file content',
        });

    } catch (err) {
        console.error('[OneDrive] Error exporting file:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
