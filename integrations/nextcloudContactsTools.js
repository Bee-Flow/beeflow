/**
 * Nextcloud Contacts Tools — CardDAV CRUD over /remote.php/dav/addressbooks/users/<uid>/.
 *
 * Auth + base-URL handled by ./nextcloudClient (Bearer when the user logged in
 * via Nextcloud OAuth, app-password Basic otherwise).
 *
 * Hand-written vCard 3.0 serialiser/parser. Same rationale as the calendar
 * module: contacts are simple enough that pulling in a full RFC-6350 lib
 * isn't justified for the field set we expose.
 */

const crypto = require('crypto');
const ncClient = require('./nextcloudClient');

const PROPFIND_ADDRESSBOOKS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <card:supported-address-data/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`;

const ADDRESSBOOK_QUERY = `<?xml version="1.0" encoding="utf-8" ?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <card:address-data/>
  </d:prop>
</card:addressbook-query>`;

const NEXTCLOUD_CONTACTS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_list_addressbooks',
            description: 'List the user\'s Nextcloud address books.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_list',
            description: 'List contacts from a Nextcloud address book.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string', description: 'Address book slug (from list_addressbooks). Defaults to "contacts".' },
                    limit: { type: 'integer', description: 'Maximum number of contacts (default 200, max 1000).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_search',
            description: 'Search contacts by case-insensitive substring match against name, email, phone, organisation. Searches all address books unless one is specified.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search term (case-insensitive substring).' },
                    addressbook: { type: 'string', description: 'Optional address book slug to limit search.' },
                    limit: { type: 'integer', description: 'Max results (default 50, max 200).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_get',
            description: 'Get a single contact by its uid.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string', description: 'Address book slug.' },
                    uid: { type: 'string', description: 'Contact UID (from list/search).' }
                },
                required: ['addressbook', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_create',
            description: 'Create a new contact. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string', description: 'Address book slug (e.g. "contacts").' },
                    fullName: { type: 'string', description: 'Full / display name (required).' },
                    firstName: { type: 'string' },
                    lastName: { type: 'string' },
                    emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses.' },
                    phones: { type: 'array', items: { type: 'string' }, description: 'Phone numbers.' },
                    organization: { type: 'string', description: 'Organisation / company.' },
                    title: { type: 'string', description: 'Job title.' },
                    notes: { type: 'string' }
                },
                required: ['addressbook', 'fullName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_update',
            description: 'Update fields on an existing contact. Only provided fields are changed; omitted fields are preserved. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string' },
                    uid: { type: 'string' },
                    fullName: { type: 'string' },
                    firstName: { type: 'string' },
                    lastName: { type: 'string' },
                    emails: { type: 'array', items: { type: 'string' } },
                    phones: { type: 'array', items: { type: 'string' } },
                    organization: { type: 'string' },
                    title: { type: 'string' },
                    notes: { type: 'string' }
                },
                required: ['addressbook', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_delete',
            description: 'Delete a contact. Always confirm with the user before calling this.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string' },
                    uid: { type: 'string' }
                },
                required: ['addressbook', 'uid']
            }
        }
    }
];

// ─── vCard helpers ──────────────────────────────────────────────────

function escapeVCard(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
}

function unescapeVCard(text) {
    return String(text || '')
        .replace(/\\n/g, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
}

function unfoldVCard(text) {
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseVCard(block) {
    const lines = unfoldVCard(block).split(/\r?\n/);
    const contact = {
        uid: null, fullName: null, firstName: null, lastName: null,
        emails: [], phones: [], organization: null, title: null, notes: null, raw: block,
    };
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const left = line.slice(0, colon);
        const value = line.slice(colon + 1);
        const [name] = left.split(';');
        switch (name.toUpperCase()) {
            case 'UID': contact.uid = value; break;
            case 'FN': contact.fullName = unescapeVCard(value); break;
            case 'N': {
                const parts = value.split(';');
                contact.lastName = unescapeVCard(parts[0] || '');
                contact.firstName = unescapeVCard(parts[1] || '');
                break;
            }
            case 'EMAIL': contact.emails.push(unescapeVCard(value)); break;
            case 'TEL': contact.phones.push(unescapeVCard(value)); break;
            case 'ORG': contact.organization = unescapeVCard((value.split(';')[0] || '')); break;
            case 'TITLE': contact.title = unescapeVCard(value); break;
            case 'NOTE': contact.notes = unescapeVCard(value); break;
        }
    }
    return contact;
}

function buildVCard(c) {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    lines.push(`UID:${c.uid}`);
    lines.push(`FN:${escapeVCard(c.fullName)}`);
    lines.push(`N:${escapeVCard(c.lastName || '')};${escapeVCard(c.firstName || '')};;;`);
    if (Array.isArray(c.emails)) {
        c.emails.filter(Boolean).forEach((e, i) => lines.push(`EMAIL;TYPE=INTERNET${i === 0 ? ',PREF' : ''}:${escapeVCard(e)}`));
    }
    if (Array.isArray(c.phones)) {
        c.phones.filter(Boolean).forEach((p, i) => lines.push(`TEL;TYPE=CELL${i === 0 ? ',PREF' : ''}:${escapeVCard(p)}`));
    }
    if (c.organization) lines.push(`ORG:${escapeVCard(c.organization)}`);
    if (c.title) lines.push(`TITLE:${escapeVCard(c.title)}`);
    if (c.notes) lines.push(`NOTE:${escapeVCard(c.notes)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
}

// ─── DAV helpers ──────────────────────────────────────────────────

function addressbooksRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/addressbooks/users/${encodeURIComponent(uid)}`;
}

function contactHref(baseUrl, uid, book, contactUid) {
    return `${addressbooksRoot(baseUrl, uid)}/${encodeURIComponent(book)}/${encodeURIComponent(contactUid)}.vcf`;
}

function parsePropfindAddressbooks(xml, uid) {
    const books = [];
    const respRegex = /<d:response[\s>][\s\S]*?<\/d:response>/g;
    const matches = xml.match(respRegex) || [];
    const root = `/remote.php/dav/addressbooks/users/${decodeURIComponent(uid)}`;
    for (const block of matches) {
        // Only entries that say so via card:addressbook resourcetype.
        if (!/<card:addressbook\s*\/?>/i.test(block)) continue;
        const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
        if (!href) continue;
        const decoded = decodeURIComponent(href);
        if (decoded.replace(/\/+$/, '') === root) continue;
        const slug = decoded.replace(/\/+$/, '').split('/').pop();
        const displayname = (block.match(/<d:displayname>([^<]*)<\/d:displayname>/) || [])[1] || slug;
        books.push({ slug, displayName: unescapeVCard(displayname), href });
    }
    return books;
}

function parseAddressbookMultiStatus(xml) {
    const out = [];
    const respRegex = /<d:response[\s>][\s\S]*?<\/d:response>/g;
    const matches = xml.match(respRegex) || [];
    for (const block of matches) {
        const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
        const etag = (block.match(/<d:getetag>([^<]+)<\/d:getetag>/) || [])[1];
        const card = (block.match(/<card:address-data[^>]*>([\s\S]*?)<\/card:address-data>/) || [])[1];
        if (href && card) {
            out.push({
                href: decodeURIComponent(href),
                etag,
                cardData: card.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
            });
        }
    }
    return out;
}

// ─── Tool execution ──────────────────────────────────────────────

async function executeNextcloudContactsTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError, uid } = ctx;
    const root = addressbooksRoot(baseUrl, uid);

    switch (toolName) {
        case 'nextcloud_contacts_list_addressbooks': {
            const res = await ncFetch(`${root}/`, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body: PROPFIND_ADDRESSBOOKS,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Address book list failed (${res.status})` };
            const xml = await res.text();
            const addressbooks = parsePropfindAddressbooks(xml, uid);
            return { count: addressbooks.length, addressbooks };
        }

        case 'nextcloud_contacts_list': {
            const book = args.addressbook || 'contacts';
            const limit = Math.min(Math.max(args.limit || 200, 1), 1000);
            const res = await ncFetch(`${root}/${encodeURIComponent(book)}/`, {
                method: 'REPORT',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body: ADDRESSBOOK_QUERY,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Address book not found: ${book}` };
            if (!res.ok) return { error: `Contacts list failed (${res.status})` };
            const xml = await res.text();
            const items = parseAddressbookMultiStatus(xml);
            const contacts = items.slice(0, limit).map(it => ({ ...parseVCard(it.cardData), etag: it.etag, href: it.href, addressbook: book }));
            return { addressbook: book, count: contacts.length, contacts };
        }

        case 'nextcloud_contacts_search': {
            const q = String(args.query || '').toLowerCase().trim();
            if (!q) return { error: 'query is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);

            let books = args.addressbook ? [args.addressbook] : null;
            if (!books) {
                const listRes = await ncFetch(`${root}/`, {
                    method: 'PROPFIND',
                    headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body: PROPFIND_ADDRESSBOOKS,
                });
                if (listRes.status === 401) return { error: authError };
                if (!listRes.ok) return { error: `Failed to enumerate address books (${listRes.status})` };
                books = parsePropfindAddressbooks(await listRes.text(), uid).map(b => b.slug);
            }

            const matches = [];
            for (const book of books) {
                const res = await ncFetch(`${root}/${encodeURIComponent(book)}/`, {
                    method: 'REPORT',
                    headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body: ADDRESSBOOK_QUERY,
                });
                if (!res.ok) continue;
                const items = parseAddressbookMultiStatus(await res.text());
                for (const it of items) {
                    const c = parseVCard(it.cardData);
                    const haystack = [
                        c.fullName, c.firstName, c.lastName, c.organization, c.title, c.notes,
                        ...(c.emails || []), ...(c.phones || [])
                    ].join(' ').toLowerCase();
                    if (haystack.includes(q)) {
                        matches.push({ ...c, etag: it.etag, href: it.href, addressbook: book });
                        if (matches.length >= limit) break;
                    }
                }
                if (matches.length >= limit) break;
            }
            return { query: args.query, count: matches.length, contacts: matches };
        }

        case 'nextcloud_contacts_get': {
            if (!args.addressbook || !args.uid) return { error: 'addressbook and uid are required' };
            const res = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), {});
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Contact not found: ${args.uid}` };
            if (!res.ok) return { error: `Contact fetch failed (${res.status})` };
            const text = await res.text();
            const contact = parseVCard(text);
            return { ...contact, etag: res.headers.get('etag'), addressbook: args.addressbook };
        }

        case 'nextcloud_contacts_create': {
            if (!args.addressbook || !args.fullName) return { error: 'addressbook and fullName are required' };
            const contactUid = `${crypto.randomBytes(8).toString('hex')}-${Date.now()}@beeflow`;
            const vcard = buildVCard({ uid: contactUid, ...args });
            const res = await ncFetch(contactHref(baseUrl, uid, args.addressbook, contactUid), {
                method: 'PUT',
                headers: { 'Content-Type': 'text/vcard; charset=utf-8', 'If-None-Match': '*' },
                body: vcard,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Address book not found: ${args.addressbook}` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                const body = await res.text().catch(() => '');
                return { error: `Contact create failed (${res.status}): ${body.slice(0, 200)}` };
            }
            return { success: true, addressbook: args.addressbook, uid: contactUid, etag: res.headers.get('etag') };
        }

        case 'nextcloud_contacts_update': {
            if (!args.addressbook || !args.uid) return { error: 'addressbook and uid are required' };
            const getRes = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), {});
            if (getRes.status === 401) return { error: authError };
            if (getRes.status === 404) return { error: `Contact not found: ${args.uid}` };
            if (!getRes.ok) return { error: `Could not load contact for update (${getRes.status})` };
            const currentEtag = getRes.headers.get('etag');
            const current = parseVCard(await getRes.text());

            const merged = {
                uid: args.uid,
                fullName: args.fullName !== undefined ? args.fullName : current.fullName,
                firstName: args.firstName !== undefined ? args.firstName : current.firstName,
                lastName: args.lastName !== undefined ? args.lastName : current.lastName,
                emails: args.emails !== undefined ? args.emails : current.emails,
                phones: args.phones !== undefined ? args.phones : current.phones,
                organization: args.organization !== undefined ? args.organization : current.organization,
                title: args.title !== undefined ? args.title : current.title,
                notes: args.notes !== undefined ? args.notes : current.notes,
            };
            const vcard = buildVCard(merged);
            const putRes = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'text/vcard; charset=utf-8',
                    ...(currentEtag ? { 'If-Match': currentEtag } : {}),
                },
                body: vcard,
            });
            if (putRes.status === 401) return { error: authError };
            if (putRes.status === 412) return { error: 'Contact was modified by another client; refetch and retry.' };
            if (!putRes.ok && putRes.status !== 204) {
                const body = await putRes.text().catch(() => '');
                return { error: `Contact update failed (${putRes.status}): ${body.slice(0, 200)}` };
            }
            return { success: true, addressbook: args.addressbook, uid: args.uid, etag: putRes.headers.get('etag') };
        }

        case 'nextcloud_contacts_delete': {
            if (!args.addressbook || !args.uid) return { error: 'addressbook and uid are required' };
            const res = await ncFetch(contactHref(baseUrl, uid, args.addressbook, args.uid), { method: 'DELETE' });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Contact not found: ${args.uid}` };
            if (!res.ok && res.status !== 204) return { error: `Contact delete failed (${res.status})` };
            return { success: true, addressbook: args.addressbook, uid: args.uid };
        }

        default:
            return { error: `Unknown Nextcloud contacts tool: ${toolName}` };
    }
}

function isNextcloudContactsTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_contacts_');
}

module.exports = {
    NEXTCLOUD_CONTACTS_TOOLS,
    executeNextcloudContactsTool,
    isNextcloudContactsTool,
};
