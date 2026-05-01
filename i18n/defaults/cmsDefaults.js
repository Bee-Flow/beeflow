/**
 * CMS Defaults — fallback content for the public product website.
 *
 * This is the schema-of-record for CMS content. Every section has an
 * `enabled` flag so admins can toggle individual sections from the panel.
 * Effective content is computed as a deep merge of:
 *   CMS_DEFAULTS  ←  cms_content_{defaultLocale}  ←  cms_content_{requestedLocale}
 *
 * Image fields hold either a full URL or a RustFS storage key under the
 * `cms/` prefix. The public marketing site resolves keys via /api/cms/asset/:key.
 */

const CMS_DEFAULTS = {
    header: {
        enabled: true,
        logoText: 'Bee Flow',
        navLinks: [
            { label: 'Features',     href: '#features' },
            { label: 'How it works', href: '#steps' },
            { label: 'Security',     href: '#security' },
            { label: 'Integrations', href: '#integrations' },
        ],
        loginLabel: 'Log in',
        ctaLabel: 'Get started',
        ctaHref: '/app',
    },

    hero: {
        enabled: true,
        eyebrow: 'AI for your team',
        badge: { text: 'Now in beta', icon: 'Sparkles' },
        titleParts: [
            { text: 'AI that understands ',   gradient: false },
            { text: 'your business',          gradient: true  },
        ],
        lead: 'Bee Flow connects to your tools, learns your workflows, and helps your team move faster — without leaving any data behind.',
        primaryCta:   { label: 'Get started',   href: '/app' },
        secondaryCta: { label: 'Watch the demo', href: '#features' },
        mockup: {
            chatBubbles: [
                { role: 'user', text: 'Summarise yesterday\'s support tickets.' },
                { role: 'ai',   text: 'Reviewed 23 tickets — 4 unresolved, 2 high-priority. Want me to draft replies?' },
            ],
        },
    },

    socialProof: {
        enabled: true,
        eyebrow: 'Trusted by teams at',
        logos: [
            { src: '', alt: 'Customer 1' },
            { src: '', alt: 'Customer 2' },
            { src: '', alt: 'Customer 3' },
            { src: '', alt: 'Customer 4' },
            { src: '', alt: 'Customer 5' },
        ],
    },

    features: {
        enabled: true,
        eyebrow: 'Why Bee Flow',
        title: 'Built for the way your team actually works',
        lead: '',
        items: [
            {
                icon: 'Plug',
                title: 'Connects everywhere',
                body: 'Native integrations with the tools your team already uses — no glue code, no brittle scripts.',
                techTag: '',
            },
            {
                icon: 'Brain',
                title: 'Learns from your data',
                body: 'Build a private knowledge base from your documents, tickets, and conversations. Searched and cited in every answer.',
                techTag: '',
            },
            {
                icon: 'ShieldCheck',
                title: 'Enterprise-grade security',
                body: 'On-prem deployment, end-to-end encryption, audit trails, and PII redaction by default.',
                techTag: '',
            },
        ],
    },

    steps: {
        enabled: true,
        eyebrow: 'How it works',
        title: 'From zero to deployed in three steps',
        lead: '',
        items: [
            {
                number: '1',
                title: 'Connect your tools',
                body:  'Plug in email, calendar, ticketing, docs, and code — Bee Flow handles the auth.',
                example: '',
            },
            {
                number: '2',
                title: 'Train on your knowledge',
                body:  'Point it at your docs and chat history. The model learns what your team means by "ASAP".',
                example: '',
            },
            {
                number: '3',
                title: 'Ship work, not prompts',
                body:  'Agents handle triage, drafting, and follow-up while your team focuses on the hard parts.',
                example: '',
            },
        ],
    },

    security: {
        enabled: true,
        eyebrow: 'Security',
        title: 'Your data, your rules',
        lead: '',
        cards: [
            {
                icon: 'Lock',
                title: 'End-to-end encryption',
                summary: 'Every message and document is encrypted in transit and at rest.',
                details: [
                    'AES-256 at rest, TLS 1.3 in transit',
                    'Per-org encryption keys',
                    'Zero-knowledge mode for sensitive workspaces',
                ],
            },
            {
                icon: 'Server',
                title: 'On-prem or private cloud',
                summary: 'Deploy where your data lives. No SaaS lock-in, no third-party LLM exposure.',
                details: [
                    'Docker Compose, Kubernetes, or bare metal',
                    'Bring-your-own LLM (OpenAI, Mistral, local)',
                    'Air-gapped deployments supported',
                ],
            },
        ],
    },

    integrations: {
        enabled: true,
        eyebrow: 'Integrations',
        title: 'Works with your stack',
        lead: '',
        categories: [
            {
                heading: 'Communication',
                items: [
                    { icon: 'Mail',          label: 'Email / SMTP' },
                    { icon: 'MessageSquare', label: 'Slack' },
                    { icon: 'Phone',         label: 'WhatsApp' },
                ],
            },
            {
                heading: 'Productivity',
                items: [
                    { icon: 'Calendar',  label: 'Calendar' },
                    { icon: 'FileText',  label: 'Docs' },
                    { icon: 'Folder',    label: 'Drive' },
                ],
            },
        ],
    },

    architecture: {
        enabled: true,
        eyebrow: 'Architecture',
        title: 'A clean stack you can audit',
        lead: '',
        layers: [
            { label: 'Frontend', tags: ['React', 'Vite', 'Tailwind'] },
            { label: 'Backend',  tags: ['Node.js', 'PostgreSQL', 'Redis'] },
            { label: 'AI',       tags: ['OpenAI', 'Mistral', 'Local LLMs'] },
            { label: 'Storage',  tags: ['RustFS', 'S3-compatible'] },
        ],
    },

    techStats: {
        enabled: true,
        eyebrow: 'By the numbers',
        title: '',
        stats: [
            { number: '99.9%', label: 'Uptime SLA' },
            { number: '<200ms', label: 'p95 latency' },
            { number: '40+',   label: 'Native integrations' },
            { number: '24/7',  label: 'Support' },
        ],
    },

    cta: {
        enabled: true,
        title: 'Ready to put your data to work?',
        lead:  'Spin up a private deployment in minutes. No credit card required.',
        button: { label: 'Get started', href: '/app' },
    },

    footer: {
        enabled: true,
        brand: {
            logoText: 'Bee Flow',
            blurb: 'AI that understands your business — deployed on your infrastructure.',
        },
        columns: [
            {
                heading: 'Product',
                links: [
                    { label: 'Features',     href: '#features' },
                    { label: 'Security',     href: '#security' },
                    { label: 'Integrations', href: '#integrations' },
                ],
            },
            {
                heading: 'Company',
                links: [
                    { label: 'About',   href: '#' },
                    { label: 'Contact', href: '#' },
                ],
            },
            {
                heading: 'Legal',
                links: [
                    { label: 'Privacy', href: '#' },
                    { label: 'Terms',   href: '#' },
                ],
            },
        ],
        socials: [],
        copyright: '© Bee Flow. All rights reserved.',
    },
};

// Section IDs in canonical render order. The marketing site iterates this list.
const SECTION_ORDER = [
    'header', 'hero', 'socialProof', 'features', 'steps',
    'security', 'integrations', 'architecture', 'techStats', 'cta', 'footer',
];

module.exports = { CMS_DEFAULTS, SECTION_ORDER };
