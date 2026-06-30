// Issued-certificate storage over configStore (no new DB table).
//
//   learning_certificate_user_${userId}        → { [certId]: IssuedCertRecord }
//   learning_cert_lookup_${sha256(verifyToken)} → { userId, certId }   (public, opt-in)
//
// The per-user record is the source of truth. The reverse lookup index is written
// ONLY when the owner opts the certificate public, so a private certificate has no
// resolvable /verify URL at all. We store the verifyToken HASH on the record, never
// the plaintext token (which is recomputable on demand from the HMAC secret).

const configStore = require('./configStore');

const userKey = (userId) => `learning_certificate_user_${userId}`;
const lookupKey = (hash) => `learning_cert_lookup_${hash}`;

async function getUserCertificates(userId) {
    const blob = await configStore.getConfig(userKey(userId));
    return (blob && typeof blob === 'object') ? blob : {};
}

async function getCertificate(userId, certId) {
    const all = await getUserCertificates(userId);
    return all[certId] || null;
}

// Idempotent upsert — preserves the original issuedAt when a record already exists.
async function saveCertificate(userId, certId, record) {
    const all = await getUserCertificates(userId);
    all[certId] = record;
    await configStore.setConfig(userKey(userId), all);
    return record;
}

async function setLookup(tokenHash, userId, certId) {
    await configStore.setConfig(lookupKey(tokenHash), { userId, certId });
}

async function clearLookup(tokenHash) {
    try { await configStore.setConfig(lookupKey(tokenHash), null); } catch (_) { /* best-effort */ }
}

async function resolveByTokenHash(tokenHash) {
    const ref = await configStore.getConfig(lookupKey(tokenHash));
    if (!ref || !ref.userId || !ref.certId) return null;
    const record = await getCertificate(ref.userId, ref.certId);
    return record || null;
}

module.exports = {
    getUserCertificates,
    getCertificate,
    saveCertificate,
    setLookup,
    clearLookup,
    resolveByTokenHash,
};
