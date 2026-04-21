/**
 * Ticket Source Providers — registry + canonical Ticket shape.
 *
 * Every non-email provider (Jira, ServiceNow, Zendesk, Freshservice, TopDesk)
 * lives in its own module and exports the TicketSourceProvider interface.
 * The sync engine dispatches to the registered provider based on
 * connection.provider.
 *
 * Email providers (gmail, outlook) stay on the existing specialised
 * code path in ticketAssistantSyncEngine.js — they predate this abstraction
 * and porting them is out of v1 scope.
 *
 * ──────────────────────────────────────────────────────────────
 * TicketSourceProvider interface (duck-typed — documented via JSDoc).
 *
 * Each provider module exports these members:
 *
 *   id: string                       — provider identifier ('jira' | 'zendesk' | ...)
 *   defaultAuthMethod: string        — 'api_token' | 'basic' | 'oauth'
 *
 *   async completeAuth(params) → {
 *     tokens,                        — credential blob to encrypt & store
 *     accountIdentifier,             — email or login, shown in UI
 *     displayName,                   — human-friendly name
 *     providerConfig,                — per-provider JSONB (URLs, keys, tables)
 *   }
 *     - Called during POST /connections. Must validate credentials by
 *       hitting an identity endpoint. Throws on invalid auth.
 *
 *   async ensureFreshTokens(connection) → { ok:true }
 *                                   | { ok:false, needsReauth?: true, retryAfterMs? }
 *     - No-op for api_token / basic. For OAuth, refreshes tokens if needed
 *       and calls store.updateTokens(...) to persist.
 *
 *   listTickets(connection, { since, cursor, max }) → AsyncIterable<RawTicket>
 *     - Yields raw ticket records. Handles pagination internally. `since`
 *       is an ISO-8601 timestamp (first sync baseline); `cursor` is the
 *       provider-specific opaque cursor from the last tick.
 *
 *   async fetchComments(connection, ticketId) → Array<{author_role, at, body_markdown}>
 *   async fetchAttachments(connection, ticketId) → Array<Attachment>
 *
 *   normalize(rawTicket, comments, attachments) → NormalizedTicket
 *     - Synchronous. Converts provider-native shape into the canonical
 *       NormalizedTicket shape. See below.
 *
 *   describeCursor(connection) → string
 *     - Human-readable "last synced through X" for the UI.
 *
 * ──────────────────────────────────────────────────────────────
 * NormalizedTicket shape (canonical internal format).
 *
 * {
 *   source_system: 'jira'|'servicenow'|'zendesk'|'freshservice'|'topdesk',
 *   source_id:     string,
 *   source_uri:    string,                 // canonical URL to the ticket
 *   project_key?:  string,
 *   itil_type?:    'incident'|'problem'|'change'|'service_request',
 *   subject:       string,
 *   body_markdown: string,                 // initial description, clean markdown
 *   comments: [{ author_role:'agent'|'requester'|'system', at:ISO, body_markdown }],
 *   resolution?: { body_markdown, resolved_at:ISO, by_role:'agent' },
 *   priority?:     'low'|'medium'|'high'|'urgent',
 *   status:        string,                 // provider-native status text
 *   status_bucket: 'open'|'pending'|'resolved'|'closed',
 *   category?:     string,
 *   tags:          string[],
 *   attachments:   Array<Attachment>,      // fetchBlob closures, not inline bytes
 *   created_at:    ISO,
 *   updated_at:    ISO,
 *   resolved_at?:  ISO,
 *   raw_meta?:     object,                 // extras for observability/debugging
 * }
 *
 * Attachment shape:
 *   { filename, mime, size, fetchBlob: async () => Buffer }
 */

const providers = {
    jira:         require('./jira'),
    freshservice: require('./freshservice'),
    topdesk:      require('./topdesk'),
    zendesk:      require('./zendesk'),
    servicenow:   require('./servicenow'),
};

function getProvider(providerId) {
    return providers[providerId] || null;
}

function isTicketProvider(providerId) {
    return Boolean(providers[providerId]);
}

function listProviders() {
    return Object.values(providers).map(p => ({
        id: p.id,
        defaultAuthMethod: p.defaultAuthMethod,
    }));
}

module.exports = {
    getProvider,
    isTicketProvider,
    listProviders,
};
