/**
 * Azure AD Group Sync Service
 * 
 * Synchronizes groups assigned to the Azure AD enterprise app and their 
 * member users to BeeFlow's internal group/user management system.
 * 
 * Uses the Client Credentials flow (app-only access) with the Microsoft
 * Graph API to list groups and members without requiring a signed-in user.
 * 
 * Required Azure App Registration permissions (Application, not Delegated):
 *   - GroupMember.Read.All
 *   - User.Read.All  
 *   - Application.Read.All
 */

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { loadConfig } = require('../auth/permissions');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── In-memory periodic sync timers per org ──
const syncTimers = new Map();

// ═══════════════════════════════════════════════════════════
// ── Client Credentials Token ──────────────────────────────
// ═══════════════════════════════════════════════════════════

/**
 * Get an app-only access token using the client credentials flow.
 * This doesn't require a signed-in user — the app authenticates as itself.
 */
async function getClientCredentialsToken(clientId, clientSecret, tenantId) {
    const tokenUrl = `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: 'https://graph.microsoft.com/.default',
        }).toString(),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('[AzureGroupSync] Token acquisition failed:', errorText);
        let errorMsg = 'Failed to authenticate with Azure AD';
        try {
            const parsed = JSON.parse(errorText);
            errorMsg = parsed.error_description || parsed.error || errorMsg;
        } catch (_) {}
        throw new Error(errorMsg);
    }

    const data = await response.json();
    return data.access_token;
}

// ═══════════════════════════════════════════════════════════
// ── Graph API Helpers ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function graphGet(path, token) {
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `Graph API error: ${response.status}`;
        try {
            const parsed = JSON.parse(errorBody);
            errorMsg = parsed.error?.message || errorMsg;
        } catch (_) {}
        throw new Error(errorMsg);
    }

    return await response.json();
}

/**
 * Paginate through Graph API results that use @odata.nextLink
 */
async function graphGetAll(path, token) {
    const results = [];
    let url = path;
    while (url) {
        const data = await graphGet(url, token);
        if (data.value) results.push(...data.value);
        url = data['@odata.nextLink'] || null;
    }
    return results;
}

/**
 * Get the service principal's Object ID from the Application (Client) ID.
 * The Enterprise App has its own Object ID that differs from the App Registration's Client ID.
 */
async function getServicePrincipalId(token, clientId) {
    const data = await graphGet(
        `/servicePrincipals?$filter=appId eq '${clientId}'&$select=id,appId,displayName`,
        token
    );
    
    if (!data.value || data.value.length === 0) {
        throw new Error(`No service principal found for appId ${clientId}. Ensure the Enterprise App exists in your tenant.`);
    }

    const sp = data.value[0];
    console.log(`[AzureGroupSync] Resolved service principal: "${sp.displayName}" (objectId=${sp.id}, appId=${sp.appId})`);
    return sp.id;
}

/**
 * Get groups and users assigned to the enterprise app via the service principal.
 * Uses: GET /servicePrincipals/{objectId}/appRoleAssignedTo
 * Returns all assignments (groups AND directly assigned users).
 */
async function getAppRoleAssignments(token, clientId) {
    // Step 1: Resolve the service principal's Object ID
    const spObjectId = await getServicePrincipalId(token, clientId);

    // Step 2: Get assignments using the Object ID (not appId shorthand)
    const assignments = await graphGetAll(
        `/servicePrincipals/${spObjectId}/appRoleAssignedTo`,
        token
    );

    console.log(`[AzureGroupSync] Raw appRoleAssignedTo returned ${assignments.length} assignment(s):`);
    for (const a of assignments) {
        console.log(`  - principalType=${a.principalType}, principalDisplayName="${a.principalDisplayName}", principalId=${a.principalId}`);
    }

    return assignments;
}

/**
 * Get full group details (displayName, description, etc.)
 */
async function getGroupDetails(token, groupId) {
    return await graphGet(`/groups/${groupId}?$select=id,displayName,description,mail`, token);
}

/**
 * Get members of a group (users only — filters out nested groups/service principals)
 */
async function getGroupMembers(token, groupId) {
    const members = await graphGetAll(
        `/groups/${groupId}/members?$select=id,displayName,givenName,surname,mail,userPrincipalName`,
        token
    );

    // Return only user-type members
    return members.filter(m =>
        m['@odata.type'] === '#microsoft.graph.user' || !m['@odata.type']
    );
}

/**
 * Get a single user's details by their Azure Object ID
 */
async function getUserDetails(token, userId) {
    return await graphGet(`/users/${userId}?$select=id,displayName,givenName,surname,mail,userPrincipalName`, token);
}

// ═══════════════════════════════════════════════════════════
// ── Sync Settings ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

const DEFAULT_SYNC_SETTINGS = {
    destructiveSync: false,
    autoActivateUsers: true,
    periodicSync: false,
    syncIntervalHours: 6,
};

async function getSyncSettings(orgId) {
    const stored = await configStore.getConfig(`azure_group_sync_${orgId}`);
    return { ...DEFAULT_SYNC_SETTINGS, ...(stored || {}) };
}

async function setSyncSettings(orgId, settings) {
    const current = await getSyncSettings(orgId);
    const updated = { ...current, ...settings };
    await configStore.setConfig(`azure_group_sync_${orgId}`, updated);

    // Manage periodic sync timer
    if (updated.periodicSync) {
        startPeriodicSync(orgId, updated.syncIntervalHours);
    } else {
        stopPeriodicSync(orgId);
    }

    return updated;
}

// ═══════════════════════════════════════════════════════════
// ── Sync Status ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function getSyncStatus(orgId) {
    return await configStore.getConfig(`azure_group_sync_status_${orgId}`) || {
        lastSyncAt: null,
        lastSyncResult: null,
        syncedGroups: 0,
        syncedUsers: 0,
        errors: [],
    };
}

async function setSyncStatus(orgId, status) {
    await configStore.setConfig(`azure_group_sync_status_${orgId}`, status);
}

// ═══════════════════════════════════════════════════════════
// ── Main Sync Orchestrator ────────────────────────────────
// ═══════════════════════════════════════════════════════════

/**
 * Synchronize Azure AD groups and their members to BeeFlow.
 * 
 * @param {string} orgId - BeeFlow organization ID
 * @returns {{ ok: boolean, synced: { groups: number, users: number }, details: string[], errors: string[] }}
 */
async function syncAzureGroupsToOrg(orgId) {
    const details = [];
    const errors = [];

    try {
        // 1. Load Microsoft SSO config
        const authConfig = await loadConfig();
        const msProvider = authConfig.providers?.microsoft || {};

        if (!msProvider.clientId || !msProvider.clientSecret) {
            throw new Error('Microsoft SSO is not configured — set Client ID and Client Secret first');
        }

        const tenantId = msProvider.tenantId || 'common';

        // 2. Load sync settings
        const settings = await getSyncSettings(orgId);

        // 3. Get app-only access token
        details.push('Authenticating with Azure AD...');
        const token = await getClientCredentialsToken(msProvider.clientId, msProvider.clientSecret, tenantId);
        details.push('✓ Authenticated successfully');

        // 4. Get all assignments (groups + direct users) from the enterprise app
        details.push('Fetching assignments from the enterprise app...');
        const allAssignments = await getAppRoleAssignments(token, msProvider.clientId);

        const groupAssignments = allAssignments.filter(a => a.principalType === 'Group');
        const directUserAssignments = allAssignments.filter(a => a.principalType === 'User');
        details.push(`✓ Found ${groupAssignments.length} group(s) and ${directUserAssignments.length} direct user(s) assigned to the app`);

        if (allAssignments.length === 0) {
            details.push('No groups or users assigned to the enterprise app — nothing to sync');
            const status = {
                lastSyncAt: new Date().toISOString(),
                lastSyncResult: 'success',
                syncedGroups: 0,
                syncedUsers: 0,
                errors: [],
            };
            await setSyncStatus(orgId, status);
            return { ok: true, synced: { groups: 0, users: 0 }, details, errors };
        }

        let syncedGroupCount = 0;
        let syncedUserCount = 0;
        const azureGroupIds = new Set();
        const azureUserIds = new Set();

        // 5. Process each group assignment
        for (const assignment of groupAssignments) {
            const azureGroupId = assignment.principalId;
            azureGroupIds.add(azureGroupId);

            try {
                // Use the name from the assignment itself (no extra API call needed)
                let groupName = assignment.principalDisplayName || `Azure Group ${azureGroupId.substring(0, 8)}`;
                let groupDescription = '';

                // Try to get richer details if we have Group.Read.All permission
                try {
                    const groupInfo = await getGroupDetails(token, azureGroupId);
                    groupName = groupInfo.displayName || groupName;
                    groupDescription = groupInfo.description || '';
                } catch (detailErr) {
                    console.log(`[AzureGroupSync] Could not fetch group details (using assignment name): ${detailErr.message}`);
                }

                details.push(`Processing group: "${groupName}" (${azureGroupId})`);

                // Check if group already exists in BeeFlow
                let beeflowGroup = await userStore.getGroupByAzureId(azureGroupId);
                const groupSlug = `azure-${groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;

                if (beeflowGroup) {
                    // Update existing group
                    await userStore.updateGroup(beeflowGroup.id, {
                        name: groupName,
                        description: groupDescription,
                        lastSyncedAt: new Date().toISOString(),
                    });
                    details.push(`  ↻ Updated existing group "${groupName}"`);
                } else {
                    // Create new group
                    const created = await userStore.createGroup({
                        id: groupSlug,
                        organizationId: orgId,
                        name: groupName,
                        description: groupDescription,
                        permissions: ['read', 'chat'],
                        roles: [],
                        azureGroupId,
                        source: 'azure',
                        lastSyncedAt: new Date().toISOString(),
                    });

                    if (created) {
                        details.push(`  + Created new group "${groupName}"`);
                    } else {
                        // Slug conflict — try with timestamp suffix
                        const altSlug = `${groupSlug}-${Date.now().toString(36)}`;
                        await userStore.createGroup({
                            id: altSlug,
                            organizationId: orgId,
                            name: groupName,
                            description: groupDescription,
                            permissions: ['read', 'chat'],
                            roles: [],
                            azureGroupId,
                            source: 'azure',
                            lastSyncedAt: new Date().toISOString(),
                        });
                        details.push(`  + Created new group "${groupName}" (as ${altSlug})`);
                    }

                    beeflowGroup = await userStore.getGroupByAzureId(azureGroupId);
                }

                syncedGroupCount++;

                // 6. Process group members (requires GroupMember.Read.All)
                try {
                    const members = await getGroupMembers(token, azureGroupId);
                    details.push(`  Found ${members.length} member(s) in "${groupName}"`);

                    for (const member of members) {
                        const azureUserId = member.id;
                        azureUserIds.add(azureUserId);

                        try {
                            const email = member.mail || member.userPrincipalName || '';
                            const displayName = member.displayName || email.split('@')[0] || 'Azure User';
                            const firstName = member.givenName || '';
                            const lastName = member.surname || '';

                            // Check if user already exists
                            let beeflowUser = await userStore.getUserByAzureId(azureUserId);

                            if (!beeflowUser && email) {
                                beeflowUser = await userStore.getUserByEmail(email);
                            }

                            if (beeflowUser) {
                                let groups = Array.isArray(beeflowUser.groups) ? beeflowUser.groups : [];
                                try { if (typeof groups === 'string') groups = JSON.parse(groups); } catch (_) { groups = []; }

                                if (beeflowGroup && !groups.includes(beeflowGroup.id)) {
                                    groups.push(beeflowGroup.id);
                                    await userStore.updateUser(beeflowUser.id, {
                                        groups,
                                        azureUserId: azureUserId,
                                    });
                                    details.push(`    ↻ Added "${displayName}" to group`);
                                } else {
                                    if (!beeflowUser.azureUserId) {
                                        await userStore.updateUser(beeflowUser.id, { azureUserId });
                                    }
                                }
                            } else if (email) {
                                const userId = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '');
                                const userStatus = settings.autoActivateUsers ? 'active' : 'pending';

                                const newUser = {
                                    id: userId || `azure-${azureUserId.substring(0, 8)}`,
                                    username: userId || email,
                                    displayName,
                                    firstName,
                                    lastName,
                                    email,
                                    role: 'user',
                                    groups: beeflowGroup ? [beeflowGroup.id] : [],
                                    orgRole: '',
                                    organizationId: orgId,
                                    status: userStatus,
                                    azureUserId,
                                    passwordHash: '',
                                };

                                const r1 = await userStore.createUserWithSeatCheck(newUser, { strict: false });
                                if (r1.created) {
                                    details.push(`    + Created user "${displayName}" (${email}) [${userStatus}]`);
                                    syncedUserCount++;
                                } else if (r1.reason === 'seat_cap') {
                                    console.warn(`[AzureGroupSync] seat.cap.skipped org=${orgId} azure_user=${azureUserId} current=${r1.current} max=${r1.max}`);
                                    details.push(`    ⚠ Skipped "${displayName}" — seat cap reached (${r1.current}/${r1.max})`);
                                } else {
                                    newUser.id = `${userId}-${Date.now().toString(36)}`;
                                    const r2 = await userStore.createUserWithSeatCheck(newUser, { strict: false });
                                    if (r2.created) {
                                        details.push(`    + Created user "${displayName}" (${email}) as ${newUser.id} [${userStatus}]`);
                                        syncedUserCount++;
                                    } else if (r2.reason === 'seat_cap') {
                                        details.push(`    ⚠ Skipped "${displayName}" — seat cap reached`);
                                    } else {
                                        errors.push(`Failed to create user "${displayName}" — ID conflict`);
                                    }
                                }
                            } else {
                                errors.push(`Skipped member ${azureUserId} — no email address`);
                            }
                        } catch (memberErr) {
                            console.error('[AzureGroupSync] Member error:', memberErr);
                            errors.push(`Error processing member ${member.id}: ${memberErr.message}`);
                        }
                    }
                } catch (membersErr) {
                    console.log(`[AzureGroupSync] Could not fetch group members (need GroupMember.Read.All): ${membersErr.message}`);
                    details.push(`  ⚠ Could not fetch members — grant GroupMember.Read.All permission to sync users`);
                }
            } catch (groupErr) {
                console.error('[AzureGroupSync] Group error:', groupErr);
                errors.push(`Error processing group ${azureGroupId}: ${groupErr.message}`);
            }
        }

        // 6b. Process directly-assigned users (not in a group)
        if (directUserAssignments.length > 0) {
            details.push(`Processing ${directUserAssignments.length} directly-assigned user(s)...`);
            for (const assignment of directUserAssignments) {
                const azureUserId = assignment.principalId;
                azureUserIds.add(azureUserId);

                try {
                    // Try to get full user details; fall back to assignment data
                    let email = '';
                    let displayName = assignment.principalDisplayName || 'Azure User';
                    let firstName = '';
                    let lastName = '';

                    try {
                        const userInfo = await getUserDetails(token, azureUserId);
                        email = userInfo.mail || userInfo.userPrincipalName || '';
                        displayName = userInfo.displayName || displayName;
                        firstName = userInfo.givenName || '';
                        lastName = userInfo.surname || '';
                    } catch (detailErr) {
                        console.log(`[AzureGroupSync] Could not fetch user details for "${displayName}" (need User.Read.All): ${detailErr.message}`);
                        details.push(`  ⚠ Could not fetch details for "${displayName}" — grant User.Read.All to sync user email/info`);
                        continue; // Can't create user without email
                    }

                    // Check if user already exists in BeeFlow
                    let beeflowUser = await userStore.getUserByAzureId(azureUserId);
                    if (!beeflowUser && email) {
                        beeflowUser = await userStore.getUserByEmail(email);
                    }

                    if (beeflowUser) {
                        if (!beeflowUser.azureUserId) {
                            await userStore.updateUser(beeflowUser.id, { azureUserId });
                        }
                        details.push(`  ↻ Direct user "${displayName}" already exists`);
                    } else if (email) {
                        const userId = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '');
                        const userStatus = settings.autoActivateUsers ? 'active' : 'pending';

                        const newUser = {
                            id: userId || `azure-${azureUserId.substring(0, 8)}`,
                            username: userId || email,
                            displayName,
                            firstName,
                            lastName,
                            email,
                            role: 'user',
                            groups: [],
                            orgRole: '',
                            organizationId: orgId,
                            status: userStatus,
                            azureUserId,
                            passwordHash: '',
                        };

                        const r1 = await userStore.createUserWithSeatCheck(newUser, { strict: false });
                        if (r1.created) {
                            details.push(`  + Created direct user "${displayName}" (${email}) [${userStatus}]`);
                            syncedUserCount++;
                        } else if (r1.reason === 'seat_cap') {
                            console.warn(`[AzureGroupSync] seat.cap.skipped org=${orgId} azure_user=${azureUserId} current=${r1.current} max=${r1.max}`);
                            details.push(`  ⚠ Skipped direct user "${displayName}" — seat cap reached (${r1.current}/${r1.max})`);
                        } else {
                            newUser.id = `${userId}-${Date.now().toString(36)}`;
                            const r2 = await userStore.createUserWithSeatCheck(newUser, { strict: false });
                            if (r2.created) {
                                details.push(`  + Created direct user "${displayName}" (${email}) as ${newUser.id} [${userStatus}]`);
                                syncedUserCount++;
                            } else if (r2.reason === 'seat_cap') {
                                details.push(`  ⚠ Skipped direct user "${displayName}" — seat cap reached`);
                            }
                        }
                    } else {
                        details.push(`  ⚠ Skipped "${displayName}" — no email available`);
                    }
                } catch (userErr) {
                    console.error('[AzureGroupSync] Direct user error:', userErr);
                    errors.push(`Error processing direct user ${assignment.principalDisplayName}: ${userErr.message}`);
                }
            }
        }

        // 7. Destructive sync: remove groups/users no longer in Azure
        if (settings.destructiveSync) {
            details.push('Running destructive sync cleanup...');

            // Remove groups that were synced from Azure but are no longer assigned
            const allGroups = await userStore.getAllGroups();
            const azureManagedGroups = allGroups.filter(g => g.source === 'azure' && g.organizationId === orgId);

            for (const group of azureManagedGroups) {
                if (group.azureGroupId && !azureGroupIds.has(group.azureGroupId)) {
                    await userStore.deleteGroup(group.id);
                    details.push(`  ✗ Removed group "${group.name}" (no longer assigned in Azure)`);
                }
            }

            // Remove users from Azure-managed groups if they're no longer members
            // (This is more conservative — we only remove group membership, not the user)
            const allUsers = await userStore.getAllUsers();
            for (const user of allUsers) {
                if (user.azureUserId && !azureUserIds.has(user.azureUserId) && user.organizationId === orgId) {
                    // Remove from Azure-managed groups only
                    let groups = Array.isArray(user.groups) ? user.groups : [];
                    try { if (typeof groups === 'string') groups = JSON.parse(groups); } catch (_) { groups = []; }

                    const cleanedGroups = groups.filter(gid => {
                        const group = azureManagedGroups.find(g => g.id === gid);
                        return !group; // Keep non-Azure groups
                    });

                    if (cleanedGroups.length !== groups.length) {
                        await userStore.updateUser(user.id, { groups: cleanedGroups });
                        details.push(`  ↻ Removed "${user.displayName}" from Azure-managed groups`);
                    }
                }
            }
        }

        // 8. Save sync status
        const status = {
            lastSyncAt: new Date().toISOString(),
            lastSyncResult: errors.length > 0 ? 'partial' : 'success',
            syncedGroups: syncedGroupCount,
            syncedUsers: syncedUserCount,
            errors: errors.slice(0, 10), // Limit stored errors
        };
        await setSyncStatus(orgId, status);

        details.push(`\nSync complete: ${syncedGroupCount} group(s), ${syncedUserCount} new user(s)`);
        if (errors.length > 0) {
            details.push(`${errors.length} error(s) occurred`);
            console.error('[AzureGroupSync] Sync errors:', errors);
        }
        console.log(`[AzureGroupSync] Sync finished for org ${orgId}: ${syncedGroupCount} group(s), ${syncedUserCount} user(s), ${errors.length} error(s)`);

        return { ok: true, synced: { groups: syncedGroupCount, users: syncedUserCount }, details, errors };

    } catch (err) {
        console.error('[AzureGroupSync] Sync failed:', err.message);
        errors.push(err.message);

        const status = {
            lastSyncAt: new Date().toISOString(),
            lastSyncResult: 'error',
            syncedGroups: 0,
            syncedUsers: 0,
            errors: [err.message],
        };
        await setSyncStatus(orgId, status);

        return { ok: false, synced: { groups: 0, users: 0 }, details, errors };
    }
}

// ═══════════════════════════════════════════════════════════
// ── Periodic Sync ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function startPeriodicSync(orgId, intervalHours = 6) {
    stopPeriodicSync(orgId);

    const intervalMs = intervalHours * 60 * 60 * 1000;
    console.log(`[AzureGroupSync] Starting periodic sync for org "${orgId}" every ${intervalHours}h`);

    const timer = setInterval(async () => {
        try {
            console.log(`[AzureGroupSync] Periodic sync triggered for org "${orgId}"`);
            await syncAzureGroupsToOrg(orgId);
        } catch (err) {
            console.error(`[AzureGroupSync] Periodic sync failed for org "${orgId}":`, err.message);
        }
    }, intervalMs);

    syncTimers.set(orgId, timer);
}

function stopPeriodicSync(orgId) {
    const existing = syncTimers.get(orgId);
    if (existing) {
        clearInterval(existing);
        syncTimers.delete(orgId);
        console.log(`[AzureGroupSync] Stopped periodic sync for org "${orgId}"`);
    }
}

/**
 * Initialize periodic syncs for all orgs that have it enabled.
 * Called once at server startup. If a sync is overdue (lastSync + interval
 * is in the past), it fires immediately before starting the regular timer.
 */
async function initPeriodicSyncs() {
    try {
        const orgs = await userStore.getAllOrganizations();
        for (const org of orgs) {
            const settings = await getSyncSettings(org.id);
            if (settings.periodicSync) {
                startPeriodicSync(org.id, settings.syncIntervalHours);

                // Check if sync is overdue and trigger immediately
                const status = await getSyncStatus(org.id);
                if (status.lastSyncAt) {
                    const nextSyncDue = new Date(status.lastSyncAt).getTime() + settings.syncIntervalHours * 60 * 60 * 1000;
                    if (Date.now() > nextSyncDue) {
                        console.log(`[AzureGroupSync] Sync overdue for org "${org.id}" — triggering immediate sync`);
                        syncAzureGroupsToOrg(org.id).catch(err =>
                            console.error(`[AzureGroupSync] Overdue sync failed for org "${org.id}":`, err.message)
                        );
                    }
                }
            }
        }
    } catch (err) {
        console.error('[AzureGroupSync] Failed to initialize periodic syncs:', err.message);
    }
}

// Auto-initialize periodic syncs after a brief delay (allows DB to be ready)
setTimeout(() => initPeriodicSyncs(), 5000);

/**
 * Sync a single user's Azure group memberships on login.
 *
 * Called when a user authenticates via Microsoft SSO. Ensures the user's
 * BeeFlow group list always reflects their current Azure AD enterprise app
 * group assignments without waiting for a periodic sync.
 *
 * Errors are swallowed — login must never be blocked by a sync failure.
 *
 * @param {string} beeflowUserId - BeeFlow user ID
 * @param {string} azureUserId   - Azure AD object ID for the user
 * @param {string} orgId         - BeeFlow organisation ID
 */
async function syncUserGroupsOnLogin(beeflowUserId, azureUserId, orgId) {
    if (!beeflowUserId || !azureUserId || !orgId) return;
    try {
        const authConfig = await loadConfig();
        const msProvider = authConfig.providers?.microsoft || {};
        if (!msProvider.clientId || !msProvider.clientSecret) return;

        const tenantId = msProvider.tenantId || 'common';
        const token = await getClientCredentialsToken(msProvider.clientId, msProvider.clientSecret, tenantId);

        // Load Azure-sourced groups for this org
        const allGroups = await userStore.getAllGroups();
        const azureGroups = allGroups.filter(g => g.source === 'azure' && g.organizationId === orgId && g.azureGroupId);
        if (azureGroups.length === 0) return;

        const currentUser = await userStore.getUser(beeflowUserId);
        if (!currentUser) return;

        let userGroups = Array.isArray(currentUser.groups)
            ? [...currentUser.groups]
            : (() => { try { return JSON.parse(currentUser.groups || '[]'); } catch (_) { return []; } })();

        let changed = false;

        for (const azureGroup of azureGroups) {
            try {
                const members = await getGroupMembers(token, azureGroup.azureGroupId);
                const isMember = members.some(m => m.id === azureUserId);

                if (isMember && !userGroups.includes(azureGroup.id)) {
                    userGroups.push(azureGroup.id);
                    changed = true;
                    console.log(`[AzureGroupSync/Login] Added "${beeflowUserId}" to group "${azureGroup.name}"`);
                } else if (!isMember && userGroups.includes(azureGroup.id)) {
                    userGroups = userGroups.filter(g => g !== azureGroup.id);
                    changed = true;
                    console.log(`[AzureGroupSync/Login] Removed "${beeflowUserId}" from group "${azureGroup.name}" (no longer in Azure AD)`);
                }
            } catch (_) {
                // GroupMember.Read.All not granted — skip silently
            }
        }

        if (changed) {
            await userStore.updateUser(beeflowUserId, { groups: userGroups });
            console.log(`[AzureGroupSync/Login] Group memberships updated for user "${beeflowUserId}"`);
        }
    } catch (err) {
        // Never block login due to sync errors
        console.warn(`[AzureGroupSync/Login] Non-fatal error for user "${beeflowUserId}":`, err.message);
    }
}

module.exports = {
    syncAzureGroupsToOrg,
    syncUserGroupsOnLogin,
    getSyncSettings,
    setSyncSettings,
    getSyncStatus,
    startPeriodicSync,
    stopPeriodicSync,
};
