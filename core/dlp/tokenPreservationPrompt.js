const MAX_TOKENS_SHOWN = 30;

function buildTokenPreservationAddendum(tokenMap) {
    if (!tokenMap) return '';
    const keys = tokenMap instanceof Map
        ? Array.from(tokenMap.keys())
        : Object.keys(tokenMap);
    if (keys.length === 0) return '';

    const shown = keys.slice(0, MAX_TOKENS_SHOWN);
    const overflow = keys.length - shown.length;
    const list = shown.map(k => '`' + k + '`').join(', ')
        + (overflow > 0 ? `, … (+${overflow} more)` : '');

    return `\n\n[PII TOKEN PRESERVATION — CRITICAL]
The user's message contains bracketed placeholders such as \`[name_1]\`, \`[email_1]\`, \`[phone_2]\`. These are NOT literal text — they stand in for real personal data that has been redacted before reaching you. A downstream system replaces each token with its original value before the user sees your reply.

Tokens currently in scope for this conversation: ${list}.

Rules (override any default phrasing habits, in any language):
1. When you need to refer to one of these entities (greeting, salutation, signature, recipient name, contact email, etc.), reuse the EXACT token verbatim — same brackets, same underscore-number suffix. e.g. write "Beste [name_1]," / "Dear [name_1]," — never "Dear recipient", "Dear [name]", "[your name]", "[je naam]", or a guessed real name.
2. Never invent new bracketed placeholders. Do not output \`[name]\`, \`[your name]\`, \`[je naam]\`, \`[recipient]\`, \`[email]\`, \`[phone]\`, etc. Only the exact tokens listed above are valid.
3. Never decode, guess, or reconstruct the real value behind a token. Treat each token as opaque.
4. If you sign off on behalf of the user and no token represents the user's own name, leave the signature open (e.g. "Met vriendelijke groet,") — do not fabricate a placeholder.
5. Tokens are language-neutral. Keep them unchanged regardless of the language you respond in.`;
}

module.exports = { buildTokenPreservationAddendum };
