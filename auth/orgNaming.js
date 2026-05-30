/**
 * Display-name helpers for auto-provisioned Nextcloud organisations.
 *
 * Shared between the connector bootstrap (names orgs at creation time) and the
 * userStore boot backfill (renames pre-existing generic "Nextcloud" orgs).
 * Kept in its own module so userStore and connectorBootstrap can both use it
 * without a circular require.
 */

// Hostname of a Nextcloud base URL, for display. https://nc.e380.net/ → nc.e380.net.
function ncHostFromUrl(ncBaseUrl) {
    try {
        return new URL(ncBaseUrl).host || null;
    } catch {
        return null;
    }
}

// Build a self-describing org name for an auto-provisioned Nextcloud org.
// Qualifies the instance's theming name with its host so the admin list can
// tell otherwise-identical "Nextcloud" orgs apart, e.g. "Nextcloud (nc.e380.net)".
// Skips the suffix when the name already carries the host (custom-themed instances).
function buildAutoOrgName(themingName, ncBaseUrl) {
    const base = (themingName || 'Nextcloud').trim() || 'Nextcloud';
    const host = ncHostFromUrl(ncBaseUrl);
    if (!host || base.toLowerCase().includes(host.toLowerCase())) return base;
    return `${base} (${host})`;
}

module.exports = { ncHostFromUrl, buildAutoOrgName };
