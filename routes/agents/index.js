const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../utils/routeHelpers');

// Mount sub-routers in the exact order they appeared in the original file
// Meta & All Conversations must intercept before /:id routes
router.use('/', require('./meta'));
router.use('/', require('./conversations_meta'));
router.use('/', require('./published'));
router.use('/', require('./system'));
// Favorites must come before /:id routes so GET /favorites is not captured by GET /:id
router.use('/', require('./favorites'));
// Wizard endpoints (/wizard/*) must come before /:id routes
router.use('/', require('./wizard'));

// Specific /:id routes
router.use('/', require('./crud'));
router.use('/', require('./chat'));
router.use('/', require('./conversations'));

module.exports = { router, getEffectiveUserId };
