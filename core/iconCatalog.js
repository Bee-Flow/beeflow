/**
 * Icon Catalog — the canonical list of icons that can be customised via
 * the Appearance panel. Frontend mirrors this in components/icons/catalog.js
 * (kept in sync manually). Used by:
 *   - GET /api/icons/catalog            (frontend bootstraps from this)
 *   - POST /api/icons/:id/bulk-generate (knows which icons to render)
 */

const ICON_CATEGORIES = [
    {
        name: 'Navigation & Core',
        keys: ['Home', 'Settings', 'Bot', 'User', 'MessageSquare', 'Database', 'LayoutDashboard', 'Shield', 'Globe', 'Terminal', 'Monitor', 'CreditCard', 'Activity', 'Box', 'Briefcase', 'Layers', 'Grid', 'Package', 'Cpu'],
    },
    {
        name: 'Actions',
        keys: ['Plus', 'Trash2', 'Pencil', 'Check', 'X', 'Search', 'Filter', 'Download', 'Upload', 'Share2', 'Save', 'Copy', 'RefreshCw', 'Play', 'Square', 'ChevronDown', 'ChevronRight', 'MoreVertical', 'MoreHorizontal'],
    },
    {
        name: 'Status & Indicators',
        keys: ['AlertCircle', 'AlertTriangle', 'CheckCircle2', 'XCircle', 'Info', 'HelpCircle', 'Lock', 'Unlock', 'Eye', 'EyeOff', 'Clock', 'Star', 'Heart', 'Link', 'Wifi'],
    },
];

const ALL_ICON_KEYS = ICON_CATEGORIES.flatMap(c => c.keys);

module.exports = { ICON_CATEGORIES, ALL_ICON_KEYS };
