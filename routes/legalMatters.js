/**
 * Legal Matters (Dossiers) — routes for the Legal Studio workspace.
 *
 * A matter is stored as a notebook with type='legal_matter', so sources,
 * chat, versions and export are reused verbatim via the existing
 * /api/notebooks/:id/* routes. This router only adds what's legal-specific:
 *   - matter CRUD that forces the type + a settings.legal case-metadata block
 *   - a research proxy that drives the Dutch legal tools for the UI's research
 *     panel (no LLM in the loop — straight to the public gov endpoints)
 *   - the verified Table of Authorities (bronnenlijst) CRUD
 *
 * Gated by use_notebooks (a matter IS a notebook) + the dutch_legal_sources
 * beta feature. Ownership isolation is enforced by notebookStore's user_id
 * checks on every query.
 */

const express = require('express');
const router = express.Router();

const notebookStore = require('../stores/notebookStore');
const legalCitationStore = require('../stores/legalCitationStore');
const kbStore = require('../stores/knowledgeBases');
const { executeTool } = require('../core/toolDispatcher');
const { verifyText } = require('../core/legalCitationVerifier');
const { requirePermission } = require('../auth');
const { requireCapability } = require('../core/entitlements');

const MATTER_TYPE = 'legal_matter';

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

router.use(requireAuth);
router.use(requirePermission('use_notebooks'));
router.use(requireCapability('dutch_legal_sources'));

// Guard: confirm the notebook exists, belongs to the user, AND is a legal
// matter (so notebook ids of other types can't be driven through these routes).
async function loadMatter(req, res) {
    const userId = req.session.user.id;
    const nb = await notebookStore.getNotebook(req.params.id, userId);
    if (!nb || nb.type !== MATTER_TYPE) {
        res.status(404).json({ error: 'Matter not found' });
        return null;
    }
    return nb;
}

// Whitelisted case-metadata fields kept under settings.legal.
const LEGAL_FIELDS = ['clientName', 'clientRef', 'wederpartij', 'rechtsgebied', 'instantie', 'zaaknummer', 'parketnummer', 'fase', 'status', 'docType'];
const CITATION_MODES = new Set(['flag', 'strict_formal']);

function buildLegalSettings(body, prev = {}) {
    const legal = { ...prev };
    for (const f of LEGAL_FIELDS) {
        if (body[f] !== undefined) legal[f] = body[f] === null ? null : String(body[f]).slice(0, 500);
    }
    if (body.citationMode !== undefined) {
        legal.citationMode = CITATION_MODES.has(body.citationMode) ? body.citationMode : 'flag';
    }
    if (body.deadlines !== undefined && Array.isArray(body.deadlines)) {
        legal.deadlines = body.deadlines.slice(0, 50).map(d => ({
            label: String(d.label || 'Deadline').slice(0, 120),
            date: d.date || null,
            kind: String(d.kind || 'algemeen').slice(0, 40),
        })).filter(d => d.date);
    } else if (body.deadline !== undefined) {
        // Convenience: a single deadline date from the create form.
        legal.deadlines = body.deadline ? [{ label: 'Deadline', date: body.deadline, kind: 'algemeen' }] : [];
    }
    return legal;
}

// ── Matter CRUD ─────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, instructions } = req.body;
        const legal = buildLegalSettings(req.body, { citationMode: 'flag' });
        const matter = await notebookStore.createNotebook({
            userId,
            name: name || 'Nieuw dossier',
            description,
            instructions,
            settings: { legal },
            type: MATTER_TYPE,
        });
        res.json({ success: true, matter });
    } catch (err) {
        console.error('[LegalMatters] Create failed:', err);
        res.status(500).json({ error: 'Failed to create matter' });
    }
});

router.get('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const matters = await notebookStore.getNotebooks(userId, { type: MATTER_TYPE });
        res.json({ matters });
    } catch (err) {
        console.error('[LegalMatters] List failed:', err);
        res.status(500).json({ error: 'Failed to list matters' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const matter = await loadMatter(req, res);
        if (!matter) return;
        await notebookStore.timeoutStuckSources(matter.id).catch(() => {});
        const sources = await notebookStore.getSources(matter.id);
        const citations = await legalCitationStore.listCitations(matter.id).catch(() => []);
        res.json({ matter, sources, citations });
    } catch (err) {
        console.error('[LegalMatters] Get failed:', err);
        res.status(500).json({ error: 'Failed to get matter' });
    }
});

router.patch('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const updates = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.instructions !== undefined) updates.instructions = req.body.instructions;
        // Merge legal metadata into the existing settings block.
        const touchesLegal = ['citationMode', 'deadline', 'deadlines', ...LEGAL_FIELDS].some(k => req.body[k] !== undefined);
        if (touchesLegal) {
            updates.settings = { ...(matter.settings || {}), legal: buildLegalSettings(req.body, matter.settings?.legal || {}) };
        }
        const ok = await notebookStore.updateNotebook(matter.id, userId, updates);
        if (!ok) return res.status(404).json({ error: 'Matter not found' });
        const refreshed = await notebookStore.getNotebook(matter.id, userId);
        res.json({ success: true, matter: refreshed });
    } catch (err) {
        console.error('[LegalMatters] Update failed:', err);
        res.status(500).json({ error: 'Failed to update matter' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const result = await notebookStore.deleteNotebook(matter.id, userId);
        if (!result) return res.status(404).json({ error: 'Matter not found' });
        // Clean up the matter's own auto-created KB(s). The shared system
        // statute KB is never in this list, so it's safe.
        for (const kbId of (result.knowledgeBaseIds || [])) {
            try { await kbStore.deleteKB(kbId); } catch (e) { console.warn(`[LegalMatters] KB cleanup ${kbId}:`, e.message); }
        }
        // Drop the dossier's persisted chat history so a deleted matter leaves
        // no orphaned conversation.
        try { await require('../stores/notebookConversationStore').deleteForNotebook(matter.id); } catch (e) {
            console.warn('[LegalMatters] Conversation cleanup failed:', e.message);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[LegalMatters] Delete failed:', err);
        res.status(500).json({ error: 'Failed to delete matter' });
    }
});

// ── Legal research proxy ────────────────────────────────────────────
// The UI research panel drives the Dutch legal tools directly (no chat).
// Body: { bron, args }. `args` is the tool-specific argument object the
// frontend assembles (rechtsgebied/instantie/from/to/query/max_results…).

const SEARCH_TOOL = {
    rechtspraak: 'rechtspraak_search',
    eurlex: 'eurlex_search',
    tuchtrecht: 'tuchtrecht_search',
    kamerstukken: 'kamerstukken_search',
    bekendmakingen: 'bekendmakingen_search',
};
const GET_TOOL = {
    rechtspraak: 'rechtspraak_get',
    eurlex: 'eurlex_get',
    tuchtrecht: 'tuchtrecht_get',
    kamerstukken: 'kamerstuk_get',
    bekendmakingen: 'bekendmaking_get',
};
const GET_ID_KEY = {
    rechtspraak: 'ecli',
    eurlex: 'celex',
    tuchtrecht: 'identifier',
    kamerstukken: 'id',
    bekendmakingen: 'identifier',
};

router.post('/:id/research', async (req, res) => {
    try {
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const bron = String(req.body.bron || 'rechtspraak');
        const toolName = SEARCH_TOOL[bron];
        if (!toolName) return res.status(400).json({ error: `Unknown source: ${bron}` });
        const args = (req.body.args && typeof req.body.args === 'object') ? req.body.args : {};
        const result = await executeTool(toolName, args, { userId: req.session.user.id, session: req.session });
        res.json({ bron, result });
    } catch (err) {
        console.error('[LegalMatters] Research failed:', err);
        res.status(500).json({ error: 'Research failed' });
    }
});

router.post('/:id/fetch', async (req, res) => {
    try {
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const bron = String(req.body.bron || 'rechtspraak');
        const toolName = GET_TOOL[bron];
        const idKey = GET_ID_KEY[bron];
        if (!toolName) return res.status(400).json({ error: `Unknown source: ${bron}` });
        const identifier = req.body.identifier;
        if (!identifier) return res.status(400).json({ error: 'identifier is required' });
        const args = { [idKey]: identifier };
        if (req.body.language) args.language = req.body.language; // eurlex_get accepts a language override
        const result = await executeTool(toolName, args, { userId: req.session.user.id, session: req.session });
        res.json({ bron, result });
    } catch (err) {
        console.error('[LegalMatters] Fetch failed:', err);
        res.status(500).json({ error: 'Fetch failed' });
    }
});

// ── Table of Authorities (bronnenlijst) ─────────────────────────────

router.get('/:id/citations', async (req, res) => {
    try {
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const citations = await legalCitationStore.listCitations(matter.id, { verifiedOnly: req.query.verified === '1' });
        res.json({ citations });
    } catch (err) {
        console.error('[LegalMatters] List citations failed:', err);
        res.status(500).json({ error: 'Failed to list citations' });
    }
});

router.post('/:id/citations', async (req, res) => {
    try {
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const { kind, identifier, title, pinpoint, url, verified, verificationMethod, sourceId, metadata } = req.body;
        if (!kind) return res.status(400).json({ error: 'kind is required' });
        const citation = await legalCitationStore.upsertCitation({
            notebookId: matter.id, kind, identifier, title, pinpoint, url,
            verified: !!verified, verificationMethod: verificationMethod || (verified ? 'manual' : null),
            sourceId, metadata,
        });
        res.json({ success: true, citation });
    } catch (err) {
        console.error('[LegalMatters] Add citation failed:', err);
        res.status(500).json({ error: 'Failed to add citation' });
    }
});

router.delete('/:id/citations/:cid', async (req, res) => {
    try {
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const ok = await legalCitationStore.deleteCitation(req.params.cid, matter.id);
        if (!ok) return res.status(404).json({ error: 'Citation not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[LegalMatters] Delete citation failed:', err);
        res.status(500).json({ error: 'Failed to delete citation' });
    }
});

// Verify every citation in the draft (or a supplied text). Persists each
// outcome into the bronnenlijst and returns a {verified, notFound, unverified}
// report plus the refreshed authority list. Never edits the draft itself.
router.post('/:id/citations/verify', async (req, res) => {
    try {
        const matter = await loadMatter(req, res);
        if (!matter) return;
        const text = typeof req.body.text === 'string' ? req.body.text : (matter.documentContent || '');
        const report = await verifyText(text, { notebookId: matter.id });
        const citations = await legalCitationStore.listCitations(matter.id);
        res.json({ success: true, report, citations });
    } catch (err) {
        console.error('[LegalMatters] Verify citations failed:', err);
        res.status(500).json({ error: 'Citation verification failed' });
    }
});

module.exports = router;
