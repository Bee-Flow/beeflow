/**
 * Slides Document Tools
 * Provides AI tools for reading and manipulating slide deck content.
 *
 * Tools: slides_deck_read, slides_deck_write, slides_add, slides_update,
 *        slides_delete, slides_reorder, slides_add_source
 *
 * Operates on JSON slide arrays (not HTML like notebook tools).
 */

const { v4: uuidv4 } = require('uuid');

const SLIDES_DOC_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'slides_deck_read',
            description: 'Read all slides in the current deck as a JSON array. Each slide has: id, layout, elements (array of content blocks), notes (speaker notes), background, and transition. Use this BEFORE any modifications to see the current state.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_deck_write',
            description: 'Replace the ENTIRE slide deck with a new array of slides. Use this for full-deck generation or complete redesigns. WARNING: This replaces ALL slides. For partial changes, use slides_update, slides_add, or slides_delete instead.\n\nEach slide object must have:\n- id: unique string\n- layout: "title" | "content" | "two-column" | "image-full" | "blank" | "section"\n- elements: array of content blocks, each with:\n  - id: unique string\n  - type: "heading" | "text" | "list" | "image" | "code" | "shape"\n  - content: the text/HTML content or image URL\n  - position: { x, y, width, height } as percentages (0-100)\n  - style: { fontSize, fontWeight, color, textAlign, ... }\n- notes: speaker notes (plain text, optional)\n- background: CSS background override or null for theme default\n- transition: "fade" | "slide" | "none"',
            parameters: {
                type: 'object',
                properties: {
                    slides: {
                        type: 'array',
                        description: 'The complete array of slide objects to replace the deck with.',
                        items: {
                            type: 'object',
                            description: 'A slide object with id, layout, elements, notes, background, and transition fields.'
                        }
                    },
                    title: {
                        type: 'string',
                        description: 'Optional short description shown to the user (e.g. "10-slide market analysis").'
                    }
                },
                required: ['slides']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_add',
            description: 'Insert a new slide at a specific position in the deck. The slide will be inserted BEFORE the given position index (0-based). Use position -1 or omit to append at the end.',
            parameters: {
                type: 'object',
                properties: {
                    slide: {
                        type: 'object',
                        description: 'The slide object to insert (same structure as slides_deck_write). Must include layout and elements array.',
                        properties: {
                            id: { type: 'string', description: 'Unique slide ID (auto-generated if omitted).' },
                            layout: { type: 'string', description: 'Slide layout: title | content | two-column | image-full | blank | section' },
                            elements: {
                                type: 'array',
                                description: 'Array of content elements on the slide.',
                                items: {
                                    type: 'object',
                                    description: 'Element with id, type, content, position, and style.'
                                }
                            },
                            notes: { type: 'string', description: 'Speaker notes.' },
                            background: { type: 'string', description: 'CSS background override or null.' },
                            transition: { type: 'string', description: 'Transition type: fade | slide | none' }
                        }
                    },
                    position: {
                        type: 'integer',
                        description: 'Zero-based index to insert at. Use -1 or omit to append at the end.'
                    }
                },
                required: ['slide']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_update',
            description: 'Update a specific slide by its ID. You can update any fields: layout, elements, notes, background, transition. Only the provided fields are changed; others remain as-is.',
            parameters: {
                type: 'object',
                properties: {
                    slide_id: {
                        type: 'string',
                        description: 'The ID of the slide to update.'
                    },
                    updates: {
                        type: 'object',
                        description: 'An object with the fields to update on the slide. May include: layout (string), elements (array of element objects), notes (string), background (string), transition (string).',
                        properties: {
                            layout: { type: 'string', description: 'New layout.' },
                            elements: {
                                type: 'array',
                                description: 'New elements array.',
                                items: { type: 'object', description: 'Element with id, type, content, position, style.' }
                            },
                            notes: { type: 'string', description: 'New speaker notes.' },
                            background: { type: 'string', description: 'New background.' },
                            transition: { type: 'string', description: 'New transition.' }
                        }
                    }
                },
                required: ['slide_id', 'updates']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_delete',
            description: 'Remove a slide from the deck by its ID.',
            parameters: {
                type: 'object',
                properties: {
                    slide_id: {
                        type: 'string',
                        description: 'The ID of the slide to delete.'
                    }
                },
                required: ['slide_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_reorder',
            description: 'Reorder slides by providing the new order as an array of slide IDs.',
            parameters: {
                type: 'object',
                properties: {
                    order: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of slide IDs in the desired order. Must include all existing slide IDs.'
                    }
                },
                required: ['order']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_apply_theme',
            description: 'Change the visual theme of the entire deck. All slides re-render with the new palette, fonts, and default backgrounds.\n\nAvailable themes:\n- "corporate": Professional blue/white\n- "dark": Dark navy with purple accents\n- "creative": Pink/purple gradient\n- "minimal": Clean grey, ultra-simple\n- "gradient": Vivid multi-color\n- "academic": Warm amber/sepia\n- "tech": Neon cyan/green on near-black\n- "nature": Fresh greens\n\nAfter applying a theme, use slides_set_background for custom per-slide overrides.',
            parameters: {
                type: 'object',
                properties: {
                    theme: { type: 'string', description: 'Theme: corporate|dark|creative|minimal|gradient|academic|tech|nature' },
                    message: { type: 'string', description: 'Short confirmation message for the user.' }
                },
                required: ['theme']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_set_background',
            description: 'Set a custom CSS background on one or more slides, overriding the theme default.\n\nExamples:\n- Solid: "#1e293b"\n- Linear gradient: "linear-gradient(135deg, #6366f1 0%, #ec4899 100%)"\n- Radial: "radial-gradient(ellipse at 30% 30%, #6366f1 0%, #0f172a 70%)"\n- Mesh: "linear-gradient(45deg, #667eea 0%, #764ba2 100%)"\n- Semi-transparent: "rgba(15, 23, 42, 0.95)"\n\nUse ["all"] as slide_ids to update every slide.',
            parameters: {
                type: 'object',
                properties: {
                    slide_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Slide IDs to update. Use ["all"] for every slide.'
                    },
                    background: { type: 'string', description: 'CSS background value.' }
                },
                required: ['slide_ids', 'background']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_style_element',
            description: 'Apply advanced CSS styling to a specific element on a slide. Enables modern design:\n\n**Glassmorphism card:**\n  background: "rgba(255,255,255,0.08)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "16px"\n\n**Gradient heading:**\n  background: "linear-gradient(135deg, #6366f1, #ec4899)", WebkitBackgroundClip: "text (not supported, use color instead)"\n  Use color: "#6366f1" or textShadow: "0 0 20px rgba(99,102,241,0.5)"\n\n**Accent bar left:**\n  borderLeft: "5px solid #6366f1", paddingLeft: "16px"\n\n**Badge/pill:**\n  background: "#6366f1", borderRadius: "9999px", padding: "6px 20px", color: "#fff", fontWeight: "700"\n\n**Elevated card:**\n  background: "rgba(30,41,59,0.8)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)", borderRadius: "16px", padding: "20px"\n\n**Subtle separator:**\n  borderBottom: "1px solid rgba(255,255,255,0.15)", paddingBottom: "8px"\n\nAll CSS values are strings. Call slides_deck_read first to get element IDs.',
            parameters: {
                type: 'object',
                properties: {
                    slide_id: { type: 'string', description: 'ID of the slide.' },
                    element_id: { type: 'string', description: 'ID of the element to style.' },
                    style: {
                        type: 'object',
                        description: 'CSS style properties as key-value pairs.',
                        properties: {
                            fontSize: { type: 'string' }, fontWeight: { type: 'string' },
                            fontStyle: { type: 'string' }, fontFamily: { type: 'string' },
                            letterSpacing: { type: 'string' }, textTransform: { type: 'string' },
                            textDecoration: { type: 'string' }, textShadow: { type: 'string' },
                            textAlign: { type: 'string' }, lineHeight: { type: 'string' },
                            color: { type: 'string' }, background: { type: 'string' },
                            backgroundColor: { type: 'string' }, backgroundImage: { type: 'string' },
                            boxShadow: { type: 'string' }, border: { type: 'string' },
                            borderLeft: { type: 'string' }, borderBottom: { type: 'string' },
                            borderRadius: { type: 'string' }, backdropFilter: { type: 'string' },
                            padding: { type: 'string' }, opacity: { type: 'number' }, zIndex: { type: 'number' }
                        }
                    }
                },
                required: ['slide_id', 'element_id', 'style']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_add_shape',
            description: 'Add a decorative shape/overlay/badge element to a slide. Pure design elements:\n\n**Full-width gradient bar:** background: "linear-gradient(90deg, #6366f1, #ec4899)", h: 0.5%, w: 100%\n**Glass card overlay:** background: "rgba(255,255,255,0.06)", backdropFilter: "blur(10px)", borderRadius: "16px"\n**Corner accent circle:** background: "radial-gradient(circle, #6366f1 0%, transparent 70%)", borderRadius: "50%", opacity: 0.3\n**Pill badge:** content: "FEATURED", background: "#6366f1", borderRadius: "9999px", color: "#fff"\n**Vertical accent bar:** background: "#6366f1", w: 0.5%, h: 60%, borderRadius: "4px"\n\nShapes are positioned absolutely — use slide_id to target the right slide.',
            parameters: {
                type: 'object',
                properties: {
                    slide_id: { type: 'string', description: 'ID of slide to add shape to.' },
                    shape: {
                        type: 'object',
                        description: 'Shape element object.',
                        properties: {
                            id: { type: 'string' },
                            type: { type: 'string', description: 'Always "shape".' },
                            content: { type: 'string', description: 'Text content (empty for pure decoration).' },
                            position: {
                                type: 'object',
                                properties: {
                                    x: { type: 'number' }, y: { type: 'number' },
                                    width: { type: 'number' }, height: { type: 'number' }
                                }
                            },
                            style: {
                                type: 'object',
                                properties: {
                                    background: { type: 'string' }, backgroundColor: { type: 'string' },
                                    borderRadius: { type: 'string' }, border: { type: 'string' },
                                    boxShadow: { type: 'string' }, backdropFilter: { type: 'string' },
                                    opacity: { type: 'number' }, color: { type: 'string' },
                                    fontSize: { type: 'string' }, fontWeight: { type: 'string' },
                                    textAlign: { type: 'string' }, zIndex: { type: 'number' }
                                }
                            }
                        }
                    }
                },
                required: ['slide_id', 'shape']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'slides_add_image_split',
            description: 'Add a premium split-layout slide — the most visually impactful layout. The image zone fills one half of the slide with a designed gradient (or real image URL), while the text zone has a structured label → heading → subtitle → body hierarchy.\n\nUse this for:\n- Title/cover slides with brand imagery\n- Feature/product introduction slides\n- Team member profile slides\n- "Before vs After" or comparison slides\n\nExample imageZone backgrounds:\n- Bold yellow: "linear-gradient(135deg, #f5c418 0%, #e8832a 100%)"\n- Deep space: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #334155 100%)"\n- Vibrant: "linear-gradient(135deg, #6366f1 0%, #ec4899 100%)"\n- Tech: "linear-gradient(135deg, #22d3ee 0%, #10b981 100%)"',
            parameters: {
                type: 'object',
                properties: {
                    position: { type: 'number', description: '0-based index where to insert the slide.' },
                    side: { type: 'string', enum: ['left', 'right'], description: 'Which side the image appears on. "left" = image left, text right (most common for covers). "right" = text left, image right.' },
                    imageZone: {
                        type: 'object',
                        description: 'Configuration for the image zone.',
                        properties: {
                            background: { type: 'string', description: 'CSS background — use a gradient that fits the theme. E.g. "linear-gradient(135deg, #f5c418 0%, #e8832a 100%)"' },
                            imageUrl: { type: 'string', description: 'Optional: URL to a real image (from web search). If set, the image renders over the background gradient.' },
                            overlay: { type: 'string', description: 'Optional: CSS rgba overlay on top of the image for readability. E.g. "rgba(0,0,0,0.3)"' },
                            caption: { type: 'string', description: 'Optional: small caption shown at the bottom of the image zone.' },
                        },
                        required: ['background']
                    },
                    elements: {
                        type: 'array',
                        description: 'Content elements for the text zone, rendered as a vertical stack. Use zone: "content" or omit zone. Types: label (brand/category), heading (large), text (body), list (HTML ul/li), stat (big number + label), meta (small fine print), quote.',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                type: { type: 'string', enum: ['label', 'heading', 'text', 'list', 'stat', 'meta', 'quote'] },
                                content: { type: 'string', description: 'For label: brand name in CAPS. For heading: the main title. For list: HTML <ul><li>...</li></ul>. For stat: the number/value.' },
                                label: { type: 'string', description: 'For stat type: the descriptor below the number, e.g. "Monthly Revenue"' },
                                zone: { type: 'string', default: 'content' },
                                style: {
                                    type: 'object',
                                    properties: {
                                        fontSize: { type: 'string' }, fontWeight: { type: 'string' },
                                        color: { type: 'string' }, letterSpacing: { type: 'string' },
                                        marginBottom: { type: 'string' }, lineHeight: { type: 'string' },
                                        textShadow: { type: 'string' },
                                    }
                                }
                            },
                            required: ['type', 'content']
                        }
                    },
                    background: { type: 'string', description: 'CSS background for the text zone. E.g. "#111111" or "linear-gradient(160deg, #0f172a 0%, #1a1a2e 100%)"' },
                    notes: { type: 'string', description: 'Speaker notes for this slide.' },
                    transition: { type: 'string', default: 'slide' },
                },
                required: ['position', 'side', 'imageZone', 'elements']
            }
        }
    }
];

const SLIDES_ADD_SOURCE_TOOL = {
    type: 'function',
    function: {
        name: 'slides_add_source',
        description: 'Add content as a new source to the slide deck. Use this to save web search results, research findings, or any text content as a source for future reference and citation. The content will be indexed and available for generating slides.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'A short descriptive name for the source.'
                },
                content: {
                    type: 'string',
                    description: 'The full text content to add as a source.'
                }
            },
            required: ['name', 'content']
        }
    }
};

/**
 * Execute a slides document tool call.
 * @param {string} toolName
 * @param {object} args
 * @param {Array} slidesContent - current slides array (in-memory, from frontend)
 * @returns {object} result
 */
function executeSlidesDocTool(toolName, args, slidesContent) {
    const slides = Array.isArray(slidesContent) ? slidesContent : [];

    if (toolName === 'slides_deck_read') {
        if (slides.length === 0) {
            return { slides: [], message: 'The deck is currently empty (no slides).' };
        }
        return { slides, slideCount: slides.length };
    }

    if (toolName === 'slides_deck_write') {
        const newSlides = args.slides || [];
        const title = args.title || 'Slide Deck';

        // Ensure every slide and element has an ID
        const processed = newSlides.map(s => ({
            ...s,
            id: s.id || uuidv4(),
            elements: (s.elements || []).map(e => ({
                ...e,
                id: e.id || uuidv4(),
            })),
            notes: s.notes || '',
            background: s.background || null,
            transition: s.transition || 'fade',
        }));

        return {
            _action: 'slides_deck_update',
            slides: processed,
            title,
            message: `Deck updated: "${title}" (${processed.length} slides)`
        };
    }

    if (toolName === 'slides_add') {
        const slide = args.slide;
        if (!slide) return { error: 'slide object is required.' };

        const newSlide = {
            ...slide,
            id: slide.id || uuidv4(),
            elements: (slide.elements || []).map(e => ({ ...e, id: e.id || uuidv4() })),
            notes: slide.notes || '',
            background: slide.background || null,
            transition: slide.transition || 'fade',
        };

        const position = args.position ?? -1;
        const newSlides = [...slides];
        if (position < 0 || position >= newSlides.length) {
            newSlides.push(newSlide);
        } else {
            newSlides.splice(position, 0, newSlide);
        }

        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Slide added at position ${position < 0 ? newSlides.length : position + 1} of ${newSlides.length}`
        };
    }

    if (toolName === 'slides_update') {
        const { slide_id, updates } = args;
        if (!slide_id) return { error: 'slide_id is required.' };
        if (!updates) return { error: 'updates object is required.' };

        const idx = slides.findIndex(s => s.id === slide_id);
        if (idx === -1) return { error: `Slide "${slide_id}" not found. Use slides_deck_read to see current slide IDs.` };

        const newSlides = [...slides];
        newSlides[idx] = {
            ...newSlides[idx],
            ...updates,
            id: slide_id, // preserve ID
            elements: updates.elements
                ? updates.elements.map(e => ({ ...e, id: e.id || uuidv4() }))
                : newSlides[idx].elements,
        };

        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Slide ${idx + 1} updated.`
        };
    }

    if (toolName === 'slides_delete') {
        const { slide_id } = args;
        if (!slide_id) return { error: 'slide_id is required.' };

        const idx = slides.findIndex(s => s.id === slide_id);
        if (idx === -1) return { error: `Slide "${slide_id}" not found.` };

        const newSlides = slides.filter(s => s.id !== slide_id);
        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Slide ${idx + 1} deleted. ${newSlides.length} slides remaining.`
        };
    }

    if (toolName === 'slides_reorder') {
        const { order } = args;
        if (!Array.isArray(order)) return { error: 'order must be an array of slide IDs.' };

        const slideMap = new Map(slides.map(s => [s.id, s]));
        const newSlides = [];

        for (const id of order) {
            const slide = slideMap.get(id);
            if (!slide) return { error: `Slide ID "${id}" not found in current deck.` };
            newSlides.push(slide);
            slideMap.delete(id);
        }

        // Append any slides not in the order array at the end
        for (const remaining of slideMap.values()) {
            newSlides.push(remaining);
        }

        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Slides reordered. ${newSlides.length} slides total.`
        };
    }

    if (toolName === 'slides_apply_theme') {
        const { theme, message: userMessage } = args;
        if (!theme) return { error: 'theme is required.' };
        return {
            _action: 'slides_theme_update',
            theme,
            message: userMessage || `Theme changed to "${theme}".`
        };
    }

    if (toolName === 'slides_set_background') {
        const { slide_ids, background } = args;
        if (!Array.isArray(slide_ids) || !background) return { error: 'slide_ids (array) and background are required.' };

        const applyAll = slide_ids.includes('all');
        const newSlides = slides.map(s => {
            if (applyAll || slide_ids.includes(s.id)) {
                return { ...s, background };
            }
            return s;
        });

        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Background updated on ${applyAll ? 'all' : slide_ids.length} slide(s).`
        };
    }

    if (toolName === 'slides_style_element') {
        const { slide_id, element_id, style } = args;
        if (!slide_id) return { error: 'slide_id is required.' };
        if (!element_id) return { error: 'element_id is required.' };
        if (!style) return { error: 'style object is required.' };

        const idx = slides.findIndex(s => s.id === slide_id);
        if (idx === -1) return { error: `Slide "${slide_id}" not found.` };

        const newSlides = [...slides];
        const slide = newSlides[idx];
        const elIdx = (slide.elements || []).findIndex(e => e.id === element_id);
        if (elIdx === -1) return { error: `Element "${element_id}" not found on slide "${slide_id}".` };

        const newElements = [...slide.elements];
        newElements[elIdx] = {
            ...newElements[elIdx],
            style: { ...newElements[elIdx].style, ...style }
        };
        newSlides[idx] = { ...slide, elements: newElements };

        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Element styled on slide ${idx + 1}.`
        };
    }

    if (toolName === 'slides_add_shape') {
        const { slide_id, shape } = args;
        if (!slide_id) return { error: 'slide_id is required.' };
        if (!shape) return { error: 'shape object is required.' };

        const idx = slides.findIndex(s => s.id === slide_id);
        if (idx === -1) return { error: `Slide "${slide_id}" not found.` };

        const newShape = {
            ...shape,
            id: shape.id || uuidv4(),
            type: shape.type || 'shape',
            content: shape.content || '',
            elements: undefined,
        };

        const newSlides = [...slides];
        newSlides[idx] = {
            ...newSlides[idx],
            elements: [...(newSlides[idx].elements || []), newShape]
        };

        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Shape added to slide ${idx + 1}.`
        };
    }

    if (toolName === 'slides_add_image_split') {
        const { position = 0, side = 'left', imageZone, elements: rawElements = [], background, notes, transition = 'slide' } = args;
        if (!imageZone) return { error: 'imageZone is required.' };

        // Ensure each element has an ID and zone
        const elements = rawElements.map((el, i) => ({
            ...el,
            id: el.id || uuidv4(),
            zone: el.zone || 'content',
        }));

        const newSlide = {
            id: uuidv4(),
            layout: side === 'left' ? 'split-left' : 'split-right',
            imageZone: {
                background: imageZone.background || 'linear-gradient(135deg, #6366f1 0%, #ec4899 100%)',
                imageUrl: imageZone.imageUrl || null,
                overlay: imageZone.overlay || null,
                caption: imageZone.caption || null,
            },
            background: background || null,
            elements,
            notes: notes || '',
            transition,
        };

        const newSlides = [...slides];
        const insertAt = Math.max(0, Math.min(position, newSlides.length));
        newSlides.splice(insertAt, 0, newSlide);

        return {
            _action: 'slides_deck_update',
            slides: newSlides,
            message: `Split slide added at position ${insertAt + 1}. ${newSlides.length} slides total.`
        };
    }

    return { error: `Unknown slides tool: ${toolName}` };
}

module.exports = { SLIDES_DOC_TOOLS, SLIDES_ADD_SOURCE_TOOL, executeSlidesDocTool };
