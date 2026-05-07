/**
 * Auth Module — Entry Point
 * 
 * Composes all auth sub-routers and re-exports middleware
 * for backward compatibility with existing imports.
 */

const express = require('express');
const router = express.Router();

const {
    requireAuth,
    requireAdmin,
    requirePermission,
    requirePluginAdmin,
    hasPermission,
    getUserPermissions,
    resolveUserOrgIds,
    requireOrgAdmin,
    invalidatePermissionCache,
    invalidateAllPermissionCaches
} = require('./permissions');
const {
    canSeePublished,
    resolveUserGroups,
    resolveAudienceContext,
} = require('./audience');

// Mount sub-routers
router.use('/', require('./loginRoutes'));
router.use('/', require('./oauthRoutes'));
router.use('/', require('./adminRoutes'));
router.use('/', require('./connectorAdminRoutes'));
router.use('/opaque', require('./opaqueRoutes'));

module.exports = {
    router,
    requireAuth,
    requireAdmin,
    requirePermission,
    requirePluginAdmin,
    hasPermission,
    getUserPermissions,
    resolveUserOrgIds,
    requireOrgAdmin,
    invalidatePermissionCache,
    invalidateAllPermissionCaches,
    canSeePublished,
    resolveUserGroups,
    resolveAudienceContext,
};
