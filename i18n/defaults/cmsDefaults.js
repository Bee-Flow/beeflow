/**
 * CMS Defaults — schema-of-record for the website builder.
 *
 * Two tiers:
 *   SITE_DEFAULTS   site-wide chrome (header, footer) + empty nav scaffold
 *   BLOCK_DEFAULTS  per-block-type seed content; used by:
 *                     - cmsStore.makeBlock() for any server-side block creation
 *                     - the admin panel ALSO ships its own client-side
 *                       BLOCK_DEFAULTS in editors.jsx — keep the two in sync
 *
 * Link value object — used for every URL in the schema:
 *   { kind: 'page',     pageId, anchor? }
 *   { kind: 'external', url, newTab? }
 *   { kind: 'anchor',   anchor }
 *   { kind: 'app',      path }       // routes that hand off to the host SPA
 *
 * Image fields hold either a full URL or a RustFS storage key under cms/.
 * The public site resolves keys via /api/cms/asset/:key.
 */

// ── Site-wide defaults (header / footer) ─────────────────────────────
//
// Brand-neutral. A fresh site has empty nav and empty footer columns —
// the user fills them in once they've decided what their pages and
// anchors look like.

const SITE_DEFAULTS = {
    header: {
        enabled: true,
        logoText: 'My Website',
        loginLabel: '',
        ctaLabel: '',
        ctaLink: { kind: 'anchor', anchor: '' },
        nav: [],
    },
    footer: {
        enabled: true,
        brandText: 'My Website',
        blurb: '',
        columns: [],
        socials: [],
        copyright: '© My Website',
    },
};

// ── Per-block-type defaults ──────────────────────────────────────────
//
// Each entry is the `content` shape for a block of that type. `enabled`
// is a block-level flag (lifted out of content) and is set when a block
// is created, not stored here.
//
// Content is brand-neutral placeholder text. Any CTA links use
// { kind: 'anchor', anchor: '' } so newly-added buttons don't point at
// app routes the user hasn't created.

const BLOCK_DEFAULTS = {
    hero: {
        eyebrow: '',
        badge: { text: '', icon: '' },
        titleParts: [
            { text: 'Your headline here', gradient: false },
        ],
        lead: 'Describe your product or service',
        primaryCta:   { label: 'Get started', link: { kind: 'anchor', anchor: '' } },
        secondaryCta: { label: 'Learn more',  link: { kind: 'anchor', anchor: '' } },
        mockup: { chatBubbles: [] },
    },

    socialProof: {
        eyebrow: 'Add your client logos',
        logos: [],
    },

    // Generic flexible section. Every optional element (subheading, image,
    // cta) defaults to null and is toggled on by the editor when the user
    // adds it. CTA uses the Link union for page-picker support — same shape
    // as Hero/CTA blocks.
    content: {
        heading:           'Your heading here',
        subheading:        null,
        body:              'Add your content here.',
        image:             null,                       // { src, alt }
        cta:               null,                       // { label, link: { kind, ... } }
        imagePosition:     'below',                    // 'above' | 'below' | 'left' | 'right'
        textAlign:         'left',                     // 'left' | 'center' | 'right'
        backgroundVariant: 'default',                  // 'default' | 'surface' | 'primary' | 'dark'
    },

    // Media + Text — side-by-side layout with image OR video on one side
    // and copy on the other. Media is always rendered (placeholder when
    // src is empty); subheading and CTA are togglable optional pieces.
    'media-text': {
        heading:           'Your heading here',
        subheading:        null,
        body:              'Add your content here.',
        cta:               null,                       // { label, link: { kind, ... } }
        media: {
            kind: 'image',                              // 'image' | 'video'
            src:  '',                                   // image URL/asset key OR video embed URL
            alt:  '',                                   // image only
        },
        mediaPosition:     'left',                     // 'left' | 'right'
        mediaSize:         'half',                     // 'half' | 'third' | 'two-thirds'
        backgroundVariant: 'default',                  // 'default' | 'surface' | 'primary' | 'dark'
    },

    features: {
        eyebrow: 'Features',
        title: 'What we offer',
        lead: '',
        items: [
            { icon: 'Star',   title: 'Feature 1', body: 'Describe this feature', techTag: '' },
            { icon: 'Zap',    title: 'Feature 2', body: 'Describe this feature', techTag: '' },
            { icon: 'Shield', title: 'Feature 3', body: 'Describe this feature', techTag: '' },
        ],
    },

    steps: {
        eyebrow: '',
        title: 'How it works',
        lead: '',
        items: [
            { number: '1', title: 'Step 1', body: 'Describe what happens in this step', example: '' },
            { number: '2', title: 'Step 2', body: 'Describe what happens in this step', example: '' },
            { number: '3', title: 'Step 3', body: 'Describe what happens in this step', example: '' },
        ],
    },

    security: {
        eyebrow: '',
        title: 'Security',
        lead: '',
        cards: [
            { icon: 'Lock',        title: 'Data encryption', summary: 'Describe your encryption story', details: [] },
            { icon: 'KeyRound',    title: 'Access control',  summary: 'Describe your access controls',  details: [] },
            { icon: 'ShieldCheck', title: 'Compliance',      summary: 'Describe your compliance posture', details: [] },
        ],
    },

    integrations: {
        eyebrow: '',
        title: 'Integrations',
        lead: 'Add your integrations',
        categories: [],
    },

    architecture: {
        eyebrow: '',
        title: 'Architecture',
        lead: 'Describe your architecture',
        layers: [
            { label: 'Layer 1', tags: [] },
        ],
    },

    techStats: {
        eyebrow: '',
        title: 'Key numbers',
        stats: [
            { number: '100+', label: 'Customers' },
            { number: '99%',  label: 'Uptime' },
            { number: '24/7', label: 'Support' },
        ],
    },

    cta: {
        title: 'Ready to get started?',
        lead:  'Contact us today',
        button: { label: 'Get started', link: { kind: 'anchor', anchor: '' } },
    },

    // CTA Banner — louder Conversion block. Two layouts (centered vs split),
    // four background variants (defaulting to 'primary' for visual punch),
    // primary CTA always rendered, secondary CTA toggleable. Both CTAs use
    // the Link union for page-picker support.
    'cta-banner': {
        heading:           'Ready to get started?',
        subheading:        'Join thousands of teams already using the platform.',
        layout:            'centered',                  // 'centered' | 'split'
        backgroundVariant: 'primary',                   // 'default' | 'surface' | 'primary' | 'dark'
        primaryCta: {
            label: 'Get started',
            link: { kind: 'external', url: '', newTab: false },
        },
        secondaryCta:      null,                        // null | { label, link: { kind, ... } }
    },
};

// ── Block type catalogue (drives the "Add block" picker) ─────────────

const BLOCK_TYPES = [
    { type: 'hero',         label: 'Hero',           icon: 'Megaphone',   category: 'Above the fold' },
    { type: 'socialProof',  label: 'Social proof',   icon: 'Users',       category: 'Above the fold' },
    { type: 'content',      label: 'Content',        icon: 'Type',             category: 'Content' },
    { type: 'media-text',   label: 'Media + Text',   icon: 'LayoutPanelLeft',  category: 'Content' },
    { type: 'features',     label: 'Features',       icon: 'Sparkles',         category: 'Content' },
    { type: 'steps',        label: 'How it works',   icon: 'ListOrdered', category: 'Content' },
    { type: 'security',     label: 'Security',       icon: 'ShieldCheck', category: 'Content' },
    { type: 'integrations', label: 'Integrations',   icon: 'Plug',        category: 'Content' },
    { type: 'architecture', label: 'Architecture',   icon: 'Boxes',       category: 'Content' },
    { type: 'techStats',    label: 'Stats',          icon: 'BarChart3',   category: 'Content' },
    { type: 'cta',          label: 'Call to action', icon: 'Target',           category: 'Conversion' },
    { type: 'cta-banner',   label: 'CTA Banner',     icon: 'Rocket',           category: 'Conversion' },
];

const BLOCK_TYPE_IDS = BLOCK_TYPES.map(t => t.type);

// Reserved slugs that must never become a CMS page (they collide with
// real app routes). Lowercase, no leading slash.
const RESERVED_SLUGS = new Set([
    'app', 'api', 'admin', 'auth', 'login', 'logout', 'register', 'signup',
    'dashboard', 'settings', 'embed', 'oauth', 'callback',
]);

// ── Design system defaults ───────────────────────────────────────────
//
// Every site ships with these values on `site.design`. The admin panel
// edits them as a unit and pushes the result to the iframe via the
// existing `cms-preview` postMessage. The marketing renderer maps each
// field to a CSS custom property on `.marketing-root`:
//
//   colors.*       → --brand-{primary|secondary|accent|bg|surface|text|text-secondary}
//   fonts.heading  → --font-heading  (also drives the Google Fonts <link>)
//   fonts.body     → --font-body
//   radius         → --radius-base   (px)
//   theme          → toggles class .cms-theme-dark (palette stays user-controlled)
//
// `logo` and `favicon` are CMS asset keys (cms/<file>) or full URLs.

const DESIGN_DEFAULTS = {
    colors: {
        primary:       '#F5A623',  // CTA, links, brand accent
        secondary:     '#1F2937',  // dark contrast, headings background
        accent:        '#FFD166',  // tertiary highlight
        background:    '#FFFFFF',  // page bg
        surface:       '#F7F8FA',  // card / section bg
        textPrimary:   '#0F172A',
        textSecondary: '#475569',
    },
    fonts: {
        heading: 'Inter',
        body:    'Inter',
    },
    logo:     '',
    favicon:  '',
    radius:   12,
    theme:    'light',
    gradient: false,            // when true, --accent-gradient becomes a linear-gradient
};

module.exports = {
    SITE_DEFAULTS,
    BLOCK_DEFAULTS,
    BLOCK_TYPES,
    BLOCK_TYPE_IDS,
    RESERVED_SLUGS,
    DESIGN_DEFAULTS,
};
