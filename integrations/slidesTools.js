/**
 * Google Slides Tools — Built-in tools for AI to read, create and edit presentations
 * 
 * Injected into the LLM tool set when the user is logged in with Google,
 * allowing the AI to list, read, create, and modify Google Slides presentations.
 * Uses both the Drive API (for listing/searching) and the Slides API (for content).
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const SLIDES_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'slides_list_presentations',
            description: 'List or search the user\'s Google Slides presentations. Returns presentation titles, IDs, last modified dates, and owners. Use this when the user asks about their presentations, slide decks, or pitch decks. You can search by keyword to find specific presentations by title.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Optional search keyword to filter presentations by title. Leave empty to list recent presentations.'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results (1-30, default 10)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_get_presentation',
            description: 'Get the full content of a Google Slides presentation by its ID. Returns the title, number of slides, and the text content of every slide (including titles, subtitles, body text, speaker notes, and table contents). Use this after slides_list_presentations to read a specific presentation. Useful for summarizing decks, extracting key points, reviewing content, or preparing talking points.',
            parameters: {
                type: 'object',
                properties: {
                    presentationId: {
                        type: 'string',
                        description: 'The presentation ID from slides_list_presentations results'
                    }
                },
                required: ['presentationId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_create_presentation',
            description: `Create a new, professionally styled Google Slides presentation. You MUST choose a theme that fits the topic — pick colors, fonts, and style yourself.

THEME GUIDELINES — pick colors that match the subject:
• Technology/AI → dark backgrounds (#1a1a2e), electric blue (#4d8bff) or cyan accents
• Business/Finance → dark navy (#0d1b2a) or white (#ffffff) background, gold (#d4a843) or teal accents
• Nature/Environment → dark green (#0a2a1b) or white, green (#2ecc71) accents
• Creative/Design → gradient-ready darks (#1c1c3a), purple (#9b59b6) or pink (#e74c8c) accents
• Education/Science → clean white (#ffffff) bg, blue (#3498db) text, orange (#e67e22) accents
• Health/Medical → white or light blue (#f0f8ff) bg, teal (#1abc9c) accents
• History → warm parchment (#f5e6cc) or dark (#2c1810), amber (#d4a843) accents

Use dark backgrounds with light text for maximum visual impact. Always pick a Google Font for headings (e.g. Montserrat, Poppins, Playfair Display, Raleway, Oswald) and a readable font for body (e.g. Open Sans, Roboto, Lato, Source Sans Pro).

Each slide can optionally have a backgroundImageUrl — use this for title slides or section headers to add visual impact. The image should be a direct URL to a publicly accessible image.`,
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Presentation title'
                    },
                    slides: {
                        type: 'string',
                        description: 'JSON array of slide objects. Each slide: {"title":"...", "body":"...", "backgroundImageUrl":"optional URL to background image for this slide"}'
                    },
                    theme: {
                        type: 'string',
                        description: `JSON object defining the visual theme. YOU MUST provide this. Example:
{"bgColor":"#1e1e2e","accentColor":"#5588ff","titleColor":"#ffffff","bodyColor":"#d9d9e6","titleFont":"Montserrat","bodyFont":"Open Sans","titleFontSize":28,"bodyFontSize":16}

Fields:
- bgColor: slide background hex color (e.g. "#1e1e2e" for dark, "#ffffff" for light)
- accentColor: accent bar/decoration hex color
- titleColor: title text hex color
- bodyColor: body text hex color
- titleFont: Google Font name for titles (e.g. "Montserrat", "Poppins", "Playfair Display")
- bodyFont: Google Font name for body text (e.g. "Open Sans", "Roboto", "Lato")
- titleFontSize: title size in points (default: 28, use 36 for title slide)
- bodyFontSize: body text size in points (default: 16)`
                    }
                },
                required: ['title', 'slides', 'theme']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_add_slide',
            description: 'Add a new slide to an existing Google Slides presentation. The slide can include a title and body text. Use slides_get_presentation first to understand the presentation structure before adding slides.',
            parameters: {
                type: 'object',
                properties: {
                    presentationId: {
                        type: 'string',
                        description: 'The presentation ID from slides_list_presentations results'
                    },
                    title: {
                        type: 'string',
                        description: 'Slide title text'
                    },
                    body: {
                        type: 'string',
                        description: 'Slide body text (supports line breaks with \\n for bullet points)'
                    },
                    insertAtIndex: {
                        type: 'integer',
                        description: 'Optional: position to insert the slide (0-based). Omit to add at the end.'
                    }
                },
                required: ['presentationId', 'title']
            }
        }
    }
];

// ─── Slides Client ─────────────────────────────────────────────

async function createSlidesClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: session?.refreshToken
    });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        session.save?.();
    });

    return {
        slides: google.slides({ version: 'v1', auth: oauth2Client }),
        drive: google.drive({ version: 'v3', auth: oauth2Client }),
    };
}

// ─── Text Extraction ───────────────────────────────────────────

/**
 * Extract all text from a slide's page elements.
 * Handles text boxes, shapes, tables, and grouped elements.
 */
function extractSlideText(slide) {
    const texts = [];

    function extractFromElement(element) {
        // Text in shapes/text boxes
        if (element.shape?.text?.textElements) {
            const runs = element.shape.text.textElements
                .filter(te => te.textRun?.content)
                .map(te => te.textRun.content);
            if (runs.length > 0) {
                texts.push(runs.join('').trim());
            }
        }

        // Text in tables
        if (element.table) {
            for (const row of (element.table.tableRows || [])) {
                for (const cell of (row.tableCells || [])) {
                    if (cell.text?.textElements) {
                        const runs = cell.text.textElements
                            .filter(te => te.textRun?.content)
                            .map(te => te.textRun.content);
                        if (runs.length > 0) {
                            texts.push(runs.join('').trim());
                        }
                    }
                }
            }
        }

        // Recurse into groups
        if (element.elementGroup?.children) {
            for (const child of element.elementGroup.children) {
                extractFromElement(child);
            }
        }
    }

    for (const element of (slide.pageElements || [])) {
        extractFromElement(element);
    }

    return texts.filter(t => t.length > 0);
}

/**
 * Extract speaker notes from a slide.
 */
function extractNotes(slide) {
    const notesPage = slide.slideProperties?.notesPage;
    if (!notesPage?.pageElements) return '';

    const notes = [];
    for (const element of notesPage.pageElements) {
        if (element.shape?.text?.textElements) {
            const runs = element.shape.text.textElements
                .filter(te => te.textRun?.content)
                .map(te => te.textRun.content);
            if (runs.length > 0) {
                const text = runs.join('').trim();
                // Skip the auto-generated placeholder text
                if (text && text !== 'Click to add speaker notes') {
                    notes.push(text);
                }
            }
        }
    }
    return notes.join('\n').trim();
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeSlidesTool(toolName, args, session) {
    const { slides, drive } = await createSlidesClient(session);

    if (toolName === 'slides_list_presentations') {
        const maxResults = Math.min(Math.max(parseInt(args.maxResults) || 10, 1), 30);
        const query = args.query || '';

        // Use Drive API to find presentations
        let q = "mimeType='application/vnd.google-apps.presentation' and trashed=false";
        if (query) {
            q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
        }

        console.log(`[Slides] Listing presentations${query ? `: "${query}"` : ''}`);

        const response = await drive.files.list({
            q,
            fields: 'files(id,name,modifiedTime,owners,webViewLink)',
            pageSize: maxResults,
            orderBy: 'modifiedTime desc',
        });

        const files = (response.data.files || []).map(f => ({
            id: f.id,
            title: f.name,
            lastModified: f.modifiedTime,
            owner: f.owners?.[0]?.displayName || f.owners?.[0]?.emailAddress || null,
            link: f.webViewLink,
        }));

        return {
            results: files,
            count: files.length,
            message: files.length > 0
                ? `Found ${files.length} presentation(s)${query ? ` matching "${query}"` : ''}.`
                : `No presentations found${query ? ` matching "${query}"` : ''}.`,
        };

    } else if (toolName === 'slides_get_presentation') {
        const { presentationId } = args;
        if (!presentationId) return { error: 'presentationId is required' };

        console.log(`[Slides] Getting presentation: ${presentationId}`);

        const response = await slides.presentations.get({
            presentationId,
        });

        const presentation = response.data;
        const slideData = (presentation.slides || []).map((slide, index) => {
            const textContent = extractSlideText(slide);
            const notes = extractNotes(slide);

            return {
                slideNumber: index + 1,
                objectId: slide.objectId,
                content: textContent,
                notes: notes || null,
            };
        });

        // Truncate if very large
        const fullText = JSON.stringify(slideData);
        const MAX_CHARS = 80000;

        return {
            id: presentation.presentationId,
            title: presentation.title,
            slideCount: slideData.length,
            slides: fullText.length > MAX_CHARS
                ? slideData.slice(0, 30) // Limit to 30 slides if too large
                : slideData,
            truncated: fullText.length > MAX_CHARS,
            link: `https://docs.google.com/presentation/d/${presentationId}/edit`,
            message: `Presentation "${presentation.title}" has ${slideData.length} slide(s).`,
        };

    } else if (toolName === 'slides_create_presentation') {
        const { title } = args;
        if (!title) return { error: 'title is required' };

        let slidesData;
        try {
            slidesData = JSON.parse(args.slides || '[]');
        } catch (e) {
            return { error: 'slides must be a valid JSON array of {title, body} objects' };
        }

        console.log(`[Slides] Creating presentation: "${title}" with ${slidesData.length} slide(s)`);

        // Step 1: Create empty presentation
        const createResponse = await slides.presentations.create({
            requestBody: { title },
        });

        const presentationId = createResponse.data.presentationId;
        const firstSlideId = createResponse.data.slides?.[0]?.objectId;
        const pageWidth = createResponse.data.pageSize?.width?.magnitude || 9144000;
        const pageHeight = createResponse.data.pageSize?.height?.magnitude || 5143500;

        // Parse theme from AI
        let theme = {};
        try {
            theme = JSON.parse(args.theme || '{}');
        } catch (e) { /* use defaults */ }

        const hexToRgb = (hex) => {
            hex = (hex || '').replace('#', '');
            if (hex.length !== 6) return { red: 0.12, green: 0.12, blue: 0.18 };
            return {
                red: parseInt(hex.substring(0, 2), 16) / 255,
                green: parseInt(hex.substring(2, 4), 16) / 255,
                blue: parseInt(hex.substring(4, 6), 16) / 255,
            };
        };

        const colors = {
            bgSlide: hexToRgb(theme.bgColor || '#1e1e2e'),
            accent: hexToRgb(theme.accentColor || '#5588ff'),
            titleText: hexToRgb(theme.titleColor || '#ffffff'),
            bodyText: hexToRgb(theme.bodyColor || '#d9d9e6'),
        };
        const fonts = {
            title: theme.titleFont || 'Montserrat',
            body: theme.bodyFont || 'Open Sans',
            titleSize: parseInt(theme.titleFontSize) || 28,
            bodySize: parseInt(theme.bodyFontSize) || 16,
        };

        // Step 2: Build batch update requests
        const requests = [];

        // Delete the default blank first slide
        if (firstSlideId && slidesData.length > 0) {
            requests.push({ deleteObject: { objectId: firstSlideId } });
        }

        for (let i = 0; i < slidesData.length; i++) {
            const slideObj = slidesData[i];
            const slideId = `slide_${i}`;
            const titleId = `title_${i}`;
            const bodyId = `body_${i}`;
            const accentBarId = `accent_${i}`;

            // Create slide with BLANK layout (we'll add our own elements)
            requests.push({
                createSlide: {
                    objectId: slideId,
                    insertionIndex: i,
                    slideLayoutReference: {
                        predefinedLayout: 'BLANK',
                    },
                },
            });

            // Set background — image or solid color
            if (slideObj.backgroundImageUrl) {
                requests.push({
                    updatePageProperties: {
                        objectId: slideId,
                        pageProperties: {
                            pageBackgroundFill: {
                                stretchedPictureFill: {
                                    contentUrl: slideObj.backgroundImageUrl,
                                },
                            },
                        },
                        fields: 'pageBackgroundFill',
                    },
                });
            } else {
                requests.push({
                    updatePageProperties: {
                        objectId: slideId,
                        pageProperties: {
                            pageBackgroundFill: {
                                solidFill: {
                                    color: { rgbColor: colors.bgSlide },
                                },
                            },
                        },
                        fields: 'pageBackgroundFill',
                    },
                });
            }

            // Add accent bar at the top
            requests.push({
                createShape: {
                    objectId: accentBarId,
                    shapeType: 'RECTANGLE',
                    elementProperties: {
                        pageObjectId: slideId,
                        size: {
                            width: { magnitude: pageWidth, unit: 'EMU' },
                            height: { magnitude: 120000, unit: 'EMU' },
                        },
                        transform: {
                            scaleX: 1, scaleY: 1,
                            translateX: 0, translateY: 0,
                            unit: 'EMU',
                        },
                    },
                },
            });

            requests.push({
                updateShapeProperties: {
                    objectId: accentBarId,
                    shapeProperties: {
                        shapeBackgroundFill: {
                            solidFill: { color: { rgbColor: colors.accent } },
                        },
                        outline: { propertyState: 'NOT_RENDERED' },
                    },
                    fields: 'shapeBackgroundFill,outline',
                },
            });

            // Add title text box
            requests.push({
                createShape: {
                    objectId: titleId,
                    shapeType: 'TEXT_BOX',
                    elementProperties: {
                        pageObjectId: slideId,
                        size: {
                            width: { magnitude: pageWidth - 1200000, unit: 'EMU' },
                            height: { magnitude: 800000, unit: 'EMU' },
                        },
                        transform: {
                            scaleX: 1, scaleY: 1,
                            translateX: 600000, translateY: 400000,
                            unit: 'EMU',
                        },
                    },
                },
            });

            if (slideObj.title) {
                requests.push({
                    insertText: { objectId: titleId, text: slideObj.title },
                });

                requests.push({
                    updateTextStyle: {
                        objectId: titleId,
                        style: {
                            foregroundColor: { opaqueColor: { rgbColor: colors.titleText } },
                            fontFamily: fonts.title,
                            fontSize: { magnitude: i === 0 ? fonts.titleSize + 8 : fonts.titleSize, unit: 'PT' },
                            bold: true,
                        },
                        textRange: { type: 'ALL' },
                        fields: 'foregroundColor,fontFamily,fontSize,bold',
                    },
                });
            }

            // Add body text box
            requests.push({
                createShape: {
                    objectId: bodyId,
                    shapeType: 'TEXT_BOX',
                    elementProperties: {
                        pageObjectId: slideId,
                        size: {
                            width: { magnitude: pageWidth - 1200000, unit: 'EMU' },
                            height: { magnitude: pageHeight - 1800000, unit: 'EMU' },
                        },
                        transform: {
                            scaleX: 1, scaleY: 1,
                            translateX: 600000, translateY: 1400000,
                            unit: 'EMU',
                        },
                    },
                },
            });

            if (slideObj.body) {
                requests.push({
                    insertText: { objectId: bodyId, text: slideObj.body },
                });

                requests.push({
                    updateTextStyle: {
                        objectId: bodyId,
                        style: {
                            foregroundColor: { opaqueColor: { rgbColor: colors.bodyText } },
                            fontFamily: fonts.body,
                            fontSize: { magnitude: fonts.bodySize, unit: 'PT' },
                        },
                        textRange: { type: 'ALL' },
                        fields: 'foregroundColor,fontFamily,fontSize',
                    },
                });
            }
        }

        if (requests.length > 0) {
            await slides.presentations.batchUpdate({
                presentationId,
                requestBody: { requests },
            });
        }

        return {
            id: presentationId,
            title,
            slideCount: slidesData.length,
            link: `https://docs.google.com/presentation/d/${presentationId}/edit`,
            message: `Presentation "${title}" created with ${slidesData.length} styled slide(s).`,
        };

    } else if (toolName === 'slides_add_slide') {
        const { presentationId, title: slideTitle, body, insertAtIndex } = args;
        if (!presentationId) return { error: 'presentationId is required' };

        console.log(`[Slides] Adding slide to ${presentationId}: "${slideTitle || '(untitled)'}"`);

        // Get current presentation to determine insertion index and page size
        const current = await slides.presentations.get({ presentationId });
        const slideCount = current.data.slides?.length || 0;
        const index = insertAtIndex !== undefined
            ? Math.min(Math.max(0, insertAtIndex), slideCount)
            : slideCount;

        const pageWidth = current.data.pageSize?.width?.magnitude || 9144000;
        const pageHeight = current.data.pageSize?.height?.magnitude || 5143500;

        const ts = Date.now();
        const slideId = `added_slide_${ts}`;
        const titleId = `added_title_${ts}`;
        const bodyId = `added_body_${ts}`;
        const accentBarId = `added_accent_${ts}`;

        // Check if existing slides have dark backgrounds (match existing style)
        const existingSlide = current.data.slides?.[0];
        const existingBg = existingSlide?.slideProperties?.notesPage ? null : null; // simplified

        const colors = {
            bgSlide: { red: 0.12, green: 0.12, blue: 0.18 },
            accent: { red: 0.33, green: 0.53, blue: 1.0 },
            titleText: { red: 1.0, green: 1.0, blue: 1.0 },
            bodyText: { red: 0.85, green: 0.85, blue: 0.9 },
        };

        const requests = [
            {
                createSlide: {
                    objectId: slideId,
                    insertionIndex: index,
                    slideLayoutReference: { predefinedLayout: 'BLANK' },
                },
            },
            {
                updatePageProperties: {
                    objectId: slideId,
                    pageProperties: {
                        pageBackgroundFill: {
                            solidFill: { color: { rgbColor: colors.bgSlide } },
                        },
                    },
                    fields: 'pageBackgroundFill',
                },
            },
            {
                createShape: {
                    objectId: accentBarId,
                    shapeType: 'RECTANGLE',
                    elementProperties: {
                        pageObjectId: slideId,
                        size: {
                            width: { magnitude: pageWidth, unit: 'EMU' },
                            height: { magnitude: 120000, unit: 'EMU' },
                        },
                        transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'EMU' },
                    },
                },
            },
            {
                updateShapeProperties: {
                    objectId: accentBarId,
                    shapeProperties: {
                        shapeBackgroundFill: { solidFill: { color: { rgbColor: colors.accent } } },
                        outline: { propertyState: 'NOT_RENDERED' },
                    },
                    fields: 'shapeBackgroundFill,outline',
                },
            },
            {
                createShape: {
                    objectId: titleId,
                    shapeType: 'TEXT_BOX',
                    elementProperties: {
                        pageObjectId: slideId,
                        size: {
                            width: { magnitude: pageWidth - 1200000, unit: 'EMU' },
                            height: { magnitude: 800000, unit: 'EMU' },
                        },
                        transform: { scaleX: 1, scaleY: 1, translateX: 600000, translateY: 400000, unit: 'EMU' },
                    },
                },
            },
        ];

        if (slideTitle) {
            requests.push(
                { insertText: { objectId: titleId, text: slideTitle } },
                {
                    updateTextStyle: {
                        objectId: titleId,
                        style: {
                            foregroundColor: { opaqueColor: { rgbColor: colors.titleText } },
                            fontFamily: 'Montserrat',
                            fontSize: { magnitude: 28, unit: 'PT' },
                            bold: true,
                        },
                        textRange: { type: 'ALL' },
                        fields: 'foregroundColor,fontFamily,fontSize,bold',
                    },
                }
            );
        }

        requests.push({
            createShape: {
                objectId: bodyId,
                shapeType: 'TEXT_BOX',
                elementProperties: {
                    pageObjectId: slideId,
                    size: {
                        width: { magnitude: pageWidth - 1200000, unit: 'EMU' },
                        height: { magnitude: pageHeight - 1800000, unit: 'EMU' },
                    },
                    transform: { scaleX: 1, scaleY: 1, translateX: 600000, translateY: 1400000, unit: 'EMU' },
                },
            },
        });

        if (body) {
            requests.push(
                { insertText: { objectId: bodyId, text: body } },
                {
                    updateTextStyle: {
                        objectId: bodyId,
                        style: {
                            foregroundColor: { opaqueColor: { rgbColor: colors.bodyText } },
                            fontFamily: 'Open Sans',
                            fontSize: { magnitude: 16, unit: 'PT' },
                        },
                        textRange: { type: 'ALL' },
                        fields: 'foregroundColor,fontFamily,fontSize',
                    },
                }
            );
        }

        await slides.presentations.batchUpdate({
            presentationId,
            requestBody: { requests },
        });

        return {
            slideId,
            position: index + 1,
            title: slideTitle || '(untitled)',
            message: `Styled slide "${slideTitle || '(untitled)'}" added at position ${index + 1}.`,
        };

    } else {
        throw new Error(`Unknown Slides tool: ${toolName}`);
    }
}

function isSlidesTool(toolName) {
    return [
        'slides_list_presentations',
        'slides_get_presentation',
        'slides_create_presentation',
        'slides_add_slide',
    ].includes(toolName);
}

module.exports = {
    SLIDES_TOOLS,
    executeSlidesTool,
    isSlidesTool,
};
