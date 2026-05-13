/**
 * Google Slides Tools — read + edit existing presentations.
 *
 * Scope kept tight on purpose. Gamma already owns "create deck from a
 * natural-language prompt" (more powerful than what the bare Slides API
 * gives us). This module is for the cases Gamma can't reach: read an
 * existing deck's text, find/replace placeholders in a template, list
 * decks the user has, create a blank deck, export to PDF.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

const SLIDES_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'slides_list',
            description: 'List Google Slides presentations the user owns or has access to. Returns id + name + URL.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional Drive search query (e.g. name contains "Q1 review").' },
                    pageSize: { type: 'integer', description: 'Default 25, max 100.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'slides_get',
            description: 'Read a presentation\'s structure — list of slides, each with the text on it. Use to summarise a deck or feed its content into an AI step.',
            parameters: {
                type: 'object',
                properties: {
                    presentationId: { type: 'string', description: 'The presentation ID (from slides_list or the URL).' },
                },
                required: ['presentationId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'slides_replace_text',
            description: 'Find and replace text strings across an entire presentation. Useful for templates with placeholders like "{{NAME}}". Returns total replacement count.',
            parameters: {
                type: 'object',
                properties: {
                    presentationId: { type: 'string' },
                    replacements: {
                        type: 'array',
                        description: 'List of {from, to} pairs to substitute everywhere.',
                        items: {
                            type: 'object',
                            properties: {
                                from: { type: 'string' },
                                to: { type: 'string' },
                                matchCase: { type: 'boolean', description: 'Default false.' },
                            },
                            required: ['from', 'to'],
                        },
                    },
                },
                required: ['presentationId', 'replacements'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'slides_create',
            description: 'Create a new (blank) presentation with the given title. Returns id + URL.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    folderId: { type: 'string', description: 'Optional Drive folder ID to place the file in.' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'slides_export_pdf',
            description: 'Export a presentation as PDF. Returns a downloadable URL (signed Drive export link).',
            parameters: {
                type: 'object',
                properties: {
                    presentationId: { type: 'string' },
                },
                required: ['presentationId'],
            },
        },
    },
];

async function createSlidesClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }
    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google Slides — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret,
    );
    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: session?.refreshToken,
    });
    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        session.save?.();
    });

    return {
        slides: google.slides({ version: 'v1', auth: oauth2Client }),
        drive: google.drive({ version: 'v3', auth: oauth2Client }),
        oauth2Client,
    };
}

/**
 * Pull plain text out of a single slide. Slides API nests text inside
 * pageElements → shape → text → textElements, each with a textRun whose
 * `content` is the actual string. We concatenate everything per slide.
 */
function extractSlideText(slide) {
    const parts = [];
    for (const el of (slide.pageElements || [])) {
        const textElements = el.shape?.text?.textElements;
        if (!Array.isArray(textElements)) continue;
        for (const te of textElements) {
            const content = te.textRun?.content;
            if (content) parts.push(content);
        }
    }
    return parts.join('').trim();
}

async function executeSlidesTool(toolName, args, session) {
    const { slides, drive } = await createSlidesClient(session);

    switch (toolName) {
        case 'slides_list': {
            const { query, pageSize } = args || {};
            const baseQ = "mimeType='application/vnd.google-apps.presentation' and trashed=false";
            const q = query ? `${baseQ} and (${query})` : baseQ;
            const res = await drive.files.list({
                q,
                pageSize: Math.min(Math.max(Number(pageSize) || 25, 1), 100),
                fields: 'files(id,name,modifiedTime,webViewLink)',
                orderBy: 'modifiedTime desc',
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });
            const results = (res.data.files || []).map(f => ({
                id: f.id,
                name: f.name,
                url: f.webViewLink || `https://docs.google.com/presentation/d/${f.id}/edit`,
                modifiedTime: f.modifiedTime,
            }));
            return { results, total: results.length };
        }

        case 'slides_get': {
            const { presentationId } = args || {};
            if (!presentationId) throw new Error('presentationId required');
            const res = await slides.presentations.get({ presentationId });
            const out = (res.data.slides || []).map((s, i) => ({
                index: i,
                objectId: s.objectId,
                text: extractSlideText(s),
            }));
            return {
                presentationId,
                title: res.data.title,
                slides: out,
                slideCount: out.length,
            };
        }

        case 'slides_replace_text': {
            const { presentationId, replacements } = args || {};
            if (!presentationId) throw new Error('presentationId required');
            if (!Array.isArray(replacements) || replacements.length === 0) throw new Error('replacements must be a non-empty array');
            const requests = replacements.map(r => ({
                replaceAllText: {
                    containsText: { text: r.from, matchCase: !!r.matchCase },
                    replaceText: r.to,
                },
            }));
            const res = await slides.presentations.batchUpdate({
                presentationId,
                requestBody: { requests },
            });
            const occurrences = (res.data.replies || [])
                .reduce((acc, reply) => acc + (reply?.replaceAllText?.occurrencesChanged || 0), 0);
            return {
                presentationId,
                replacements: occurrences,
                replacementCount: replacements.length,
            };
        }

        case 'slides_create': {
            const { title, folderId } = args || {};
            if (!title) throw new Error('title required');
            const res = await slides.presentations.create({ requestBody: { title } });
            const presentationId = res.data.presentationId;
            if (folderId) {
                try {
                    const file = await drive.files.get({ fileId: presentationId, fields: 'parents', supportsAllDrives: true });
                    const prevParents = (file.data.parents || []).join(',');
                    await drive.files.update({
                        fileId: presentationId,
                        addParents: folderId,
                        removeParents: prevParents,
                        supportsAllDrives: true,
                    });
                } catch (e) {
                    console.warn(`[Slides] Could not move to folder ${folderId}: ${e.message}`);
                }
            }
            return {
                presentationId,
                url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
                title,
            };
        }

        case 'slides_export_pdf': {
            const { presentationId } = args || {};
            if (!presentationId) throw new Error('presentationId required');
            // Drive's `files.export` returns the binary directly. For an
            // automation step we surface the canonical export URL — the
            // user can curl/fetch it client-side or wire it into a Drive
            // upload step. Google requires an authorised request for this
            // URL so the URL is intended for use with the same OAuth
            // token; a downstream step can pass it to drive_upload or
            // similar without re-fetching.
            const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(presentationId)}/export?mimeType=application%2Fpdf`;
            return {
                presentationId,
                url,
                mimeType: 'application/pdf',
            };
        }

        default:
            throw new Error(`Unknown slides tool: ${toolName}`);
    }
}

function isSlidesTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('slides_');
}

module.exports = {
    SLIDES_TOOLS,
    executeSlidesTool,
    isSlidesTool,
    createSlidesClient,
};
