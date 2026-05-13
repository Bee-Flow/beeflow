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
4. **Sign-offs**: when you sign a message on behalf of the user, you MUST use a person token from the list — do NOT write \`[jouw naam]\`, \`[je naam]\`, \`[your name]\`, \`[name]\`, \`[uw naam]\`, or any similar invented placeholder. To pick the right token, read the input carefully:
   • If the user is replying to an inbound message, the person addressed in the original greeting (e.g. "Beste [person_3]," / "Dear [person_3]," / "Hi [person_3]") is the user — use that same token to sign off.
   • If the user is forwarding or quoting their own draft and a person token appears in the existing signature, reuse that token.
   • Only if NO person token in the list can plausibly represent the user, omit the name line entirely (e.g. just "Met vriendelijke groet," with nothing after it). Do NOT fabricate a placeholder as a fallback.
5. Tokens are language-neutral. Keep them unchanged regardless of the language you respond in.
6. **DO NOT mention, explain, apologise for, or call attention to the tokenisation, anonymisation, redaction, placeholders, or privacy mechanism in your reply.** From the end user's perspective the tokens are real values — they see the un-tokenised text. Sentences like "the names have been anonymised", "I can't see the real names", "deze zijn vervangen door aanduidingen", "de werkelijke namen zijn niet zichtbaar", "[person_X] is een placeholder", "om privacy te beschermen" — these are FORBIDDEN. They confuse the user, who already sees the original names in the rendered output, and break the round-trip illusion. When summarising or answering questions about a document that contains tokens, simply use the tokens naturally inline ("Mw. [person_1] woont met haar partner [person_2] …") and let the un-tokeniser do its job silently. If the user explicitly asks WHY a name looks like \`[person_3]\`, you may briefly say "those are privacy placeholders for the real names" — only when asked.`;
}

module.exports = { buildTokenPreservationAddendum };
