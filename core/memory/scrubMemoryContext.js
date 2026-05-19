/**
 * Scrub an assembled memory-context string of any PII the Azure detector can
 * find. This is the read-time guard against the "memory leak" class of bug:
 * a user mentions an IBAN in turn 1, the memory extractor stores the full
 * value, then turn 2's memory-retrieval injects that value into the system
 * prompt — bypassing the per-turn tokeniser entirely.
 *
 * Strategy: replace each detected span with a generic human-readable label
 * (`[User's IBAN]`, `[User's email]`, …) rather than a round-trip token. The
 * LLM still sees context ("the user has an IBAN") without ever learning the
 * value. No token-map → no restoration needed → no leak path.
 *
 * Intentionally fail-open: if the detector is unavailable or the config says
 * PII is disabled, we leave the memory untouched. This mirrors how the main
 * PII path behaves in guardrailsRunner — availability issues shouldn't brick
 * the whole chat surface.
 */

const CATEGORY_LABELS = {
    Email:                            "User's email address",
    PhoneNumber:                      'phone number',
    Person:                           'name',
    PersonType:                       'role',
    Address:                          'address',
    Age:                              'age',
    DateOfBirth:                      'date of birth',
    CreditCardNumber:                 'credit card number',
    BankAccountNumber:                'bank account number',
    InternationalBankingAccountNumber:'IBAN',
    ABARoutingNumber:                 'ABA routing number',
    SWIFTCode:                        'SWIFT code',
    USSocialSecurityNumber:           'SSN',
    PassportNumber:                   'passport number',
    DriversLicenseNumber:             'drivers licence number',
    NationalID:                       'national ID',
    IPAddress:                        'IP address',
    URL:                              'URL',
    Organization:                     'organisation',
    AzureCredentialKey:               'Azure credential',
};

function humaniseLabel(category) {
    return CATEGORY_LABELS[category] || 'sensitive value';
}

/**
 * @param {string} text
 * @param {object} orgShield
 * @returns {Promise<{ scrubbed: string, replacedCategories: string[] }>}
 */
async function scrubMemoryContext(text, orgShield = null) {
    if (!text || typeof text !== 'string') return { scrubbed: text || '', replacedCategories: [] };

    try {
        const { detectPii, ALL_PII_CATEGORY_IDS, DEFAULT_PII_CONFIDENCE_THRESHOLD } =
            require('../piiDetection');

        // Respect the org's category selection and threshold; fall back to
        // platform defaults. Deliberately lower the threshold slightly so we
        // err on the side of over-scrubbing stored memories — this is not an
        // outbound prompt gate, it's defence-in-depth against leakage.
        const enabledCategories = (orgShield?.piiDetectionCategories?.length
            ? orgShield.piiDetectionCategories
            : ALL_PII_CATEGORY_IDS) || null;
        const threshold = typeof orgShield?.piiDetectionConfidenceThreshold === 'number'
            ? Math.min(orgShield.piiDetectionConfidenceThreshold, 0.70)
            : (DEFAULT_PII_CONFIDENCE_THRESHOLD || 0.70);

        const result = await detectPii(text, enabledCategories, threshold);
        if (!result?.hasPii || !result.entities?.length) {
            return { scrubbed: text, replacedCategories: [] };
        }

        // Splice from the tail so byte offsets remain valid during replacement.
        const sorted = [...result.entities].sort((a, b) => b.offset - a.offset);
        let scrubbed = text;
        const seenCategories = new Set();
        for (const entity of sorted) {
            const label = humaniseLabel(entity.category);
            const replacement = `[${label}]`;
            if (typeof entity.offset === 'number' && entity.offset >= 0) {
                scrubbed = scrubbed.slice(0, entity.offset) + replacement + scrubbed.slice(entity.offset + entity.length);
            } else if (entity.text) {
                scrubbed = scrubbed.split(entity.text).join(replacement);
            }
            seenCategories.add(label);
        }

        return { scrubbed, replacedCategories: [...seenCategories] };
    } catch (err) {
        console.warn('[ScrubMemory] PII scrub skipped (fail-open):', err.message);
        return { scrubbed: text, replacedCategories: [] };
    }
}

module.exports = { scrubMemoryContext };
