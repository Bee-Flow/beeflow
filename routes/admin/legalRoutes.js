/**
 * Admin Legal Routes — platform admin manages the legal documents at runtime.
 *
 * Lets a platform admin edit a document's English content, publish a new version
 * (which triggers user re-consent + stales translations), set which docs are
 * mandatory + their scope, manage the optional-consent catalog (marketing), and
 * view the consent_acceptances audit ledger.
 *
 * Overrides are stored via legalStore (configStore-backed); the code defaults
 * (disk markdown + static meta) remain the seed/fallback. Mounted at /api/legal.
 */

const express = require('express');
const router = express.Router();

const legalStore = require('../../legal/legalStore');
const legalDocs = require('../../i18n/defaults/legalDocs');
const documentRegistry = require('../../legal/documentRegistry');
const userStore = require('../../stores/userStore');
const languageStore = require('../../stores/languageStore');
const { hasPermission } = require('../../auth/permissions');

// ── Middleware (mirrors languageRoutes.requireAdmin) ─────────────
async function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    const userId = req.session.user?.id;
    if (userId && await hasPermission(userId, 'all', req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

function publicDoc(def) {
    return {
        docId: def.docId,
        title: def.title,
        version: def.version,
        lastUpdated: def.lastUpdated,
        route: def.route,
        requiresConsent: def.requiresConsent,
        scope: def.scope,
        hasOverride: !!def.hasOverride,
    };
}

// ── Documents ────────────────────────────────────────────────────

// GET /api/legal/admin/docs — list all docs (effective meta + translation status)
router.get('/admin/docs', requireAdmin, async (req, res) => {
    try {
        const all = legalDocs.getAllLegalDefaults();
        const docs = legalDocs.LEGAL_DOC_IDS.map(id => publicDoc(all[id]));
        // Per-locale translation coverage (best-effort; English is authoritative).
        let locales = [];
        try { locales = await languageStore.getAvailableLocales(); } catch (_) { /* ignore */ }
        res.json({ docs, optional: documentRegistry.optionalConsents(), locales });
    } catch (err) {
        console.error('[LegalAdmin] list error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/legal/admin/docs/:docId — full effective doc incl. English markdown
router.get('/admin/docs/:docId', requireAdmin, async (req, res) => {
    try {
        const def = legalDocs.getLegalDefault(req.params.docId);
        if (!def) return res.status(404).json({ error: 'Unknown document' });
        res.json({ ...publicDoc(def), markdown: def.markdown });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/legal/admin/docs/:docId — save override; optionally publish new version
// body: { markdown?, requiresConsent?, scope?, lastUpdated?, bumpVersion? }
router.put('/admin/docs/:docId', requireAdmin, async (req, res) => {
    try {
        const { docId } = req.params;
        const current = legalDocs.getLegalDefault(docId);
        if (!current) return res.status(404).json({ error: 'Unknown document' });

        const { markdown, requiresConsent, scope, lastUpdated, bumpVersion } = req.body || {};
        const patch = {};
        if (typeof markdown === 'string') {
            // Refuse to persist a blank body — that would only happen by accident
            // (e.g. saving before the editor finished loading) and a blank legal
            // document is never intended. Use Revert to restore the seed text.
            if (!markdown.trim()) {
                return res.status(400).json({ error: 'The document body is empty — refusing to save a blank legal document. Use "Revert to default" to restore the original text.' });
            }
            patch.markdownEn = markdown;
        }
        if (typeof requiresConsent === 'boolean') patch.requiresConsent = requiresConsent;
        if (typeof scope === 'string' && ['both', 'b2b', 'b2c'].includes(scope)) patch.scope = scope;
        if (typeof lastUpdated === 'string' && lastUpdated.trim()) patch.lastUpdated = lastUpdated.trim();
        if (bumpVersion) patch.version = Number(current.version || 1) + 1;

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'Nothing to update' });
        }

        await legalStore.setDocOverride(docId, patch);
        const updated = legalDocs.getLegalDefault(docId);
        console.log(`[LegalAdmin] ${docId} updated by ${req.session.user?.id}${bumpVersion ? ` → v${updated.version} (re-consent)` : ''}`);
        res.json({ success: true, doc: { ...publicDoc(updated), markdown: updated.markdown } });
    } catch (err) {
        console.error('[LegalAdmin] update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/legal/admin/docs/:docId/revert — drop the override (back to code default)
router.post('/admin/docs/:docId/revert', requireAdmin, async (req, res) => {
    try {
        const { docId } = req.params;
        if (!legalDocs.getLegalDefault(docId)) return res.status(404).json({ error: 'Unknown document' });
        await legalStore.clearDocOverride(docId);
        const def = legalDocs.getLegalDefault(docId);
        res.json({ success: true, doc: { ...publicDoc(def), markdown: def.markdown } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Optional (marketing) consents ────────────────────────────────

// GET /api/legal/admin/optional-consents
router.get('/admin/optional-consents', requireAdmin, async (req, res) => {
    try {
        res.json({ consents: documentRegistry.optionalConsents() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/legal/admin/optional-consents — { consents: [{id, version, category, enabled, labelKey}] }
router.put('/admin/optional-consents', requireAdmin, async (req, res) => {
    try {
        const { consents } = req.body || {};
        if (!Array.isArray(consents)) return res.status(400).json({ error: 'consents array is required' });
        const clean = consents
            .filter(c => c && c.id)
            .map(c => ({
                id: String(c.id),
                version: Number(c.version) || 1,
                category: c.category || 'marketing',
                enabled: c.enabled !== false,
                labelKey: c.labelKey || undefined,
            }));
        await legalStore.setOptionalConsents(clean);
        res.json({ success: true, consents: documentRegistry.optionalConsents() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Acceptance audit (read-only) ─────────────────────────────────

// GET /api/legal/admin/acceptances?docId=&limit=&offset=
router.get('/admin/acceptances', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 100, 500);
        const offset = Number(req.query.offset) || 0;
        const docId = req.query.docId || null;
        const rows = await userStore.listConsentAcceptances({ docId, limit, offset });

        // Enrich with the organisation NAME (the ledger stores only organization_id)
        // so the audit reads as evidence. Batch-resolve distinct ids.
        const orgIds = [...new Set(rows.map(r => r.organization_id).filter(Boolean))];
        const orgNames = {};
        await Promise.all(orgIds.map(async (id) => {
            try { orgNames[id] = (await userStore.getOrganization(id))?.name || null; }
            catch (_) { orgNames[id] = null; }
        }));
        const enriched = rows.map(r => ({
            ...r,
            organization_name: r.organization_id ? (orgNames[r.organization_id] || null) : null,
        }));

        res.json({ acceptances: enriched, limit, offset });
    } catch (err) {
        console.error('[LegalAdmin] acceptances error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
