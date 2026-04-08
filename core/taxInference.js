/**
 * Tax Inference Engine
 *
 * Extracts invoice metadata from email headers, filenames, and snippets
 * so the AI can skip expensive OCR when the context is already sufficient.
 *
 * Also provides deduplication helpers for already-gathered sources.
 */

// ── Common vendor patterns (Dutch/EU SaaS & utilities) ──────────────
const KNOWN_VENDORS = [
    // SaaS / Tech
    { pattern: /github/i, vendor: 'GitHub' },
    { pattern: /atlassian|jira|confluence|bitbucket/i, vendor: 'Atlassian' },
    { pattern: /google\s*(cloud|workspace|ads)/i, vendor: 'Google' },
    { pattern: /microsoft|azure|office\s*365/i, vendor: 'Microsoft' },
    { pattern: /amazon\s*web\s*services|aws/i, vendor: 'AWS' },
    { pattern: /digitalocean/i, vendor: 'DigitalOcean' },
    { pattern: /scaleway/i, vendor: 'Scaleway' },
    { pattern: /hetzner/i, vendor: 'Hetzner' },
    { pattern: /vercel/i, vendor: 'Vercel' },
    { pattern: /netlify/i, vendor: 'Netlify' },
    { pattern: /stripe/i, vendor: 'Stripe' },
    { pattern: /mollie/i, vendor: 'Mollie' },
    { pattern: /slack/i, vendor: 'Slack' },
    { pattern: /notion/i, vendor: 'Notion' },
    { pattern: /figma/i, vendor: 'Figma' },
    { pattern: /adobe/i, vendor: 'Adobe' },
    { pattern: /canva/i, vendor: 'Canva' },
    { pattern: /dropbox/i, vendor: 'Dropbox' },
    { pattern: /zoom\b/i, vendor: 'Zoom' },
    { pattern: /openai/i, vendor: 'OpenAI' },
    { pattern: /anthropic/i, vendor: 'Anthropic' },
    { pattern: /spotify/i, vendor: 'Spotify' },
    { pattern: /apple/i, vendor: 'Apple' },
    // Dutch services
    { pattern: /transip/i, vendor: 'TransIP' },
    { pattern: /kpn/i, vendor: 'KPN' },
    { pattern: /ziggo/i, vendor: 'Ziggo' },
    { pattern: /t[\s-]?mobile/i, vendor: 'T-Mobile' },
    { pattern: /vodafone/i, vendor: 'Vodafone' },
    { pattern: /bol\.com/i, vendor: 'Bol.com' },
    { pattern: /coolblue/i, vendor: 'Coolblue' },
    { pattern: /exact\s*online/i, vendor: 'Exact Online' },
    { pattern: /visma/i, vendor: 'Visma' },
    { pattern: /moneybird/i, vendor: 'Moneybird' },
    { pattern: /e-boekhouden/i, vendor: 'e-Boekhouden' },
    { pattern: /hostnet/i, vendor: 'Hostnet' },
    { pattern: /antagonist/i, vendor: 'Antagonist' },
    { pattern: /mijndomein/i, vendor: 'Mijndomein' },
    { pattern: /ns\.nl|nederlandse\s*spoorwegen/i, vendor: 'NS' },
    { pattern: /movemove/i, vendor: 'MoveMove' },
    { pattern: /greenwheels/i, vendor: 'Greenwheels' },
    // Utilities / Insurance
    { pattern: /vattenfall/i, vendor: 'Vattenfall' },
    { pattern: /eneco/i, vendor: 'Eneco' },
    { pattern: /essent/i, vendor: 'Essent' },
    { pattern: /centraal\s*beheer/i, vendor: 'Centraal Beheer' },
    { pattern: /nationale[\s-]?nederlanden/i, vendor: 'Nationale-Nederlanden' },
];

// ── Amount extraction patterns ──────────────────────────────────────

const AMOUNT_PATTERNS = [
    // €XX.XX or €XX,XX (with optional thousands separator)
    /€\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/,
    // EUR XX.XX
    /EUR\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/i,
    // "totaal: €XX" / "total: €XX" / "bedrag: €XX"
    /(?:totaa?l|total|bedrag|amount|subtotal)\s*[:=]?\s*€?\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/i,
];

// ── Invoice number patterns ─────────────────────────────────────────

const INVOICE_NUMBER_PATTERNS = [
    // "Factuur 12345" / "Invoice #12345" / "Factuurnummer: 12345" — must start with digit
    /(?:factuur(?:nummer)?|invoice|inv|receipt)\s*[#:.\s-]*(\d[\w-]{2,})/i,
    // "INV-2026-001" style (standalone)
    /\b(INV-\d[\w-]+)\b/i,
    // Filename patterns: Factuur-2026-001.pdf — must start with digit
    /(?:factuur|invoice|inv)[_\s-]+(\d[\w-]+)/i,
];

// ── Invoice keyword detection ───────────────────────────────────────

const INVOICE_KEYWORDS = [
    /factuur/i, /invoice/i, /rekening/i, /receipt/i,
    /betaling/i, /payment/i, /creditnota/i, /credit\s*note/i,
    /aanmaning/i, /herinnering/i, /debet/i,
];

const NON_INVOICE_KEYWORDS = [
    /belastingdienst/i, /aangifte/i, /aanslag/i,
    /newsletter/i, /nieuwsbrief/i, /marketing/i,
    /welcome/i, /welkom/i, /verify/i, /confirm/i,
    /password/i, /wachtwoord/i,
];

/**
 * Parse a Dutch/EU amount string to a number.
 * Handles both "1.234,56" (Dutch) and "1,234.56" (English) formats.
 */
function parseAmount(amountStr) {
    if (!amountStr) return null;
    let cleaned = amountStr.replace(/\s/g, '');
    // Dutch format: 1.234,56 → detect by comma before last 2 digits at end
    if (/,\d{2}$/.test(cleaned) && /\.\d{3}/.test(cleaned)) {
        cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (/,\d{2}$/.test(cleaned)) {
        cleaned = cleaned.replace(',', '.');
    }
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : Math.round(num * 100) / 100;
}

/**
 * Infer invoice metadata from email headers + filename.
 *
 * @param {Object} opts
 * @param {string} opts.subject   - Email subject line
 * @param {string} opts.from      - Sender email/name
 * @param {string} opts.date      - Email date string
 * @param {string} opts.snippet   - Email snippet (first ~100 chars)
 * @param {string} opts.filename  - Attachment filename (if any)
 * @returns {Object} Inferred metadata + confidence + needsOCR flag
 */
function inferInvoiceMetadata({ subject = '', from = '', date = '', snippet = '', filename = '' }) {
    const combined = `${subject} ${from} ${snippet} ${filename}`;
    const result = {
        vendor: null,
        invoiceNumber: null,
        amount: null,
        isInvoice: false,
        isTaxDocument: false,
        confidence: 0,    // 0-1: how confident we are about the data
        needsOCR: true,   // whether the AI should still read the PDF
        reasons: [],      // human-readable reasons for the decision
    };

    // ── Vendor detection ────────────────────────────────────────
    for (const { pattern, vendor } of KNOWN_VENDORS) {
        if (pattern.test(from) || pattern.test(subject)) {
            result.vendor = vendor;
            result.confidence += 0.2;
            result.reasons.push(`Known vendor: ${vendor}`);
            break;
        }
    }

    // ── Invoice keyword detection ───────────────────────────────
    const hasInvoiceKeyword = INVOICE_KEYWORDS.some(p => p.test(subject) || p.test(filename));
    const hasNonInvoiceKeyword = NON_INVOICE_KEYWORDS.some(p => p.test(combined));

    if (hasInvoiceKeyword && !hasNonInvoiceKeyword) {
        result.isInvoice = true;
        result.confidence += 0.25;
        result.reasons.push('Invoice keyword in subject/filename');
    }

    // Tax document detection (Belastingdienst etc.)
    if (/belastingdienst|aangifte|aanslag|toeslagen/i.test(combined)) {
        result.isTaxDocument = true;
        result.isInvoice = false;
        result.confidence += 0.3;
        result.reasons.push('Tax authority document');
    }

    // ── Invoice number extraction ───────────────────────────────
    for (const pattern of INVOICE_NUMBER_PATTERNS) {
        const match = (subject + ' ' + filename).match(pattern);
        if (match) {
            result.invoiceNumber = match[1].trim();
            result.confidence += 0.15;
            result.reasons.push(`Invoice number: ${result.invoiceNumber}`);
            break;
        }
    }

    // ── Amount extraction ───────────────────────────────────────
    for (const pattern of AMOUNT_PATTERNS) {
        const match = (subject + ' ' + snippet).match(pattern);
        if (match) {
            const amount = parseAmount(match[1]);
            if (amount !== null && amount > 0 && amount < 1000000) {
                result.amount = amount;
                result.confidence += 0.2;
                result.reasons.push(`Amount: €${amount.toFixed(2)}`);
                break;
            }
        }
    }

    // ── Decide if OCR is needed ─────────────────────────────────
    // OCR is NOT needed when we have enough context from email metadata
    if (result.isInvoice && result.vendor && result.amount) {
        // We know it's an invoice, who sent it, and the amount
        result.needsOCR = false;
        result.confidence = Math.min(result.confidence + 0.1, 1.0);
        result.reasons.push('✅ OCR skipped — sufficient metadata from email');
    } else if (result.isInvoice && result.vendor && result.invoiceNumber) {
        // We know vendor + invoice number but missing amount
        // Light confidence — we might want the amount from the PDF
        result.needsOCR = true;
        result.reasons.push('⚠️ OCR recommended — amount missing');
    } else if (result.isTaxDocument) {
        // Tax documents: always read for full context
        result.needsOCR = true;
        result.reasons.push('📋 Tax document — OCR recommended for full context');
    } else if (!result.isInvoice && !result.vendor) {
        // Unknown sender, unknown content — must read
        result.needsOCR = true;
        result.reasons.push('❓ Unknown document — OCR required');
    }

    // Parse date to ISO
    if (date) {
        try {
            const parsed = new Date(date);
            if (!isNaN(parsed.getTime())) {
                result.emailDate = parsed.toISOString().split('T')[0];
            }
        } catch (_) {}
    }

    result.confidence = Math.min(Math.round(result.confidence * 100) / 100, 1.0);
    return result;
}

/**
 * Build a deduplication fingerprint for a source.
 * Used to check if a document has already been gathered.
 */
function buildSourceFingerprint(metadata) {
    if (metadata?.emailMessageId) return `gmail:${metadata.emailMessageId}`;
    if (metadata?.driveFileId) return `drive:${metadata.driveFileId}`;
    if (metadata?.vendor && metadata?.invoiceNumber) {
        return `inv:${metadata.vendor}:${metadata.invoiceNumber}`.toLowerCase();
    }
    return null;
}

/**
 * Check if any existing source matches the given fingerprint.
 *
 * @param {Array} existingSources - Array of source objects with metadata
 * @param {Object} newMetadata    - Metadata of the document to check
 * @returns {boolean} true if already exists
 */
function isDuplicate(existingSources, newMetadata) {
    const newFp = buildSourceFingerprint(newMetadata);
    if (!newFp) return false;

    for (const source of existingSources) {
        const existingFp = buildSourceFingerprint(source.metadata || {});
        if (existingFp && existingFp === newFp) return true;
    }
    return false;
}

/**
 * Build a compact summary of already-gathered sources for the system prompt.
 * This tells the AI what's already been processed so it doesn't re-process.
 *
 * @param {Array} sources - Array of notebook source objects
 * @returns {string} Human-readable dedup list
 */
function buildGatheredSummary(sources) {
    if (!sources || sources.length === 0) return '';

    const lines = [];
    for (const source of sources) {
        const meta = source.metadata || {};
        const parts = [];
        if (meta.emailMessageId) parts.push(`Gmail:${meta.emailMessageId.substring(0, 8)}…`);
        if (meta.driveFileId) parts.push(`Drive:${meta.driveFileId.substring(0, 8)}…`);
        if (meta.vendor) parts.push(meta.vendor);
        if (meta.invoiceNumber) parts.push(`#${meta.invoiceNumber}`);
        if (meta.amount) parts.push(`€${meta.amount.toFixed(2)}`);
        if (meta.invoiceDate) parts.push(meta.invoiceDate);

        const label = parts.length > 0
            ? parts.join(' · ')
            : source.name;
        lines.push(`- ${label}`);
    }

    return `\n[ALREADY GATHERED — DO NOT RE-PROCESS]\n${lines.join('\n')}\nTotal: ${sources.length} sources. Skip any document matching the IDs above.\n`;
}

module.exports = {
    inferInvoiceMetadata,
    buildSourceFingerprint,
    isDuplicate,
    buildGatheredSummary,
    parseAmount,
    KNOWN_VENDORS,
};
