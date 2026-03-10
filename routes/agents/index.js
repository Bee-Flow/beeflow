const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../utils/routeHelpers');

// Mount sub-routers in the exact order they appeared in the original file
// Meta & All Conversations must intercept before /:id routes
router.use('/', require('./meta'));
router.use('/', require('./conversations_meta'));
router.use('/', require('./published'));
router.use('/', require('./system'));

// Specific /:id routes
router.use('/', require('./crud'));
router.use('/', require('./chat'));
router.use('/', require('./conversations'));

module.exports = { router, getEffectiveUserId };
