const { getProviders, addProvider, updateProvider, deleteProvider, setDefaultProvider, getModelsForProvider, invalidateModelCache } = require('../../core/aiAgent');

const router = require('express').Router();

// Middleware
function requireAuth(req, res, next) {
    next();
}

// GET /ai/providers
router.get('/providers', requireAuth, async (req, res) => {
    try {
        const providerData = await getProviders();
        const maskedProviders = providerData.providers.map(p => ({
            ...p,
            apiKey: p.apiKey ? '••••' + p.apiKey.slice(-4) : '',
            serviceAccountKey: p.serviceAccountKey ? '••••(configured)' : '',
        }));
        res.json({
            providers: maskedProviders,
            defaultProvider: providerData.defaultProvider
        });
    } catch (e) {
        console.error('Failed to get providers:', e);
        res.status(500).json({ error: 'Failed to fetch providers' });
    }
});

// POST /ai/providers
router.post('/providers', requireAuth, async (req, res) => {
    try {
        const { name, type, url, model, apiKey, project, location, apiVersion } = req.body;
        if (!name || (!url && type !== 'google-vertex' && type !== 'azure')) {
            return res.status(400).json({ error: 'Name and URL are required' });
        }
        const provider = await addProvider({ name, type, url: url || (type === 'azure' ? '' : 'vertex-ai'), model, apiKey, project, location, apiVersion });
        if (provider) {
            invalidateModelCache(); // Clear all cache since new provider added
            res.status(201).json({
                ...provider,
                apiKey: provider.apiKey ? '••••' + provider.apiKey.slice(-4) : ''
            });
        } else {
            res.status(500).json({ error: 'Failed to add provider' });
        }
    } catch (e) {
        console.error('Failed to add provider:', e);
        res.status(500).json({ error: 'Failed to add provider' });
    }
});

// PUT /ai/providers/:id
router.put('/providers/:id', requireAuth, async (req, res) => {
    try {
        const { name, type, url, model, apiKey, project, location, apiVersion } = req.body;
        const success = await updateProvider(req.params.id, { name, type, url, model, apiKey, project, location, apiVersion });
        if (success) {
            invalidateModelCache(req.params.id); // Invalidate this provider's cache
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Provider not found' });
        }
    } catch (e) {
        console.error('Failed to update provider:', e);
        res.status(500).json({ error: 'Failed to update provider' });
    }
});

// DELETE /ai/providers/:id
router.delete('/providers/:id', requireAuth, async (req, res) => {
    try {
        const success = await deleteProvider(req.params.id);
        if (success) {
            invalidateModelCache(req.params.id); // Remove from cache
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Provider not found' });
        }
    } catch (e) {
        console.error('Failed to delete provider:', e);
        res.status(500).json({ error: 'Failed to delete provider' });
    }
});

// PUT /ai/providers/:id/default
router.put('/providers/:id/default', requireAuth, async (req, res) => {
    try {
        const success = await setDefaultProvider(req.params.id);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Provider not found' });
        }
    } catch (e) {
        console.error('Failed to set default provider:', e);
        res.status(500).json({ error: 'Failed to set default provider' });
    }
});

// GET /ai/providers/:id/models — uses cached getModelsForProvider (60s TTL)
router.get('/providers/:id/models', requireAuth, async (req, res) => {
    try {
        const providerData = await getProviders();
        const provider = providerData.providers.find(p => p.id === req.params.id);

        if (!provider) {
            return res.status(404).json({ error: 'Provider not found' });
        }

        const forceRefresh = req.query.refresh === 'true';
        const models = await getModelsForProvider(provider.id, forceRefresh);
        console.log(`[Models] Returning ${models.length} models for ${provider.name}${forceRefresh ? ' (forced refresh)' : ''}`);

        res.json({ models, providerId: provider.id, providerName: provider.name });
    } catch (e) {
        console.error('Failed to fetch provider models:', e);
        res.status(500).json({ error: e.message, models: [] });
    }
});

module.exports = router;
