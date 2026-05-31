/**
 * Trial Service — orchestrates one-time Stripe trial creation for orgs
 * and consumers. Exposes the imperative "start trial" path used by admin
 * routes and an auto-grant path triggered when new orgs/users are created
 * (provided the super admin has chosen a default trial plan).
 *
 * Lazy-requires userStore + stripeService to avoid the userStore →
 * trialService → userStore cycle when auto-grant fires from inside
 * createOrganization.
 */

const configStore = require('../stores/configStore');

const ORG_TRIAL_PLAN_KEY = 'default_org_trial_plan_id';
const CONSUMER_TRIAL_PLAN_KEY = 'default_consumer_trial_plan_id';

function userStore() { return require('../stores/userStore'); }
function stripeService() { return require('./stripeService'); }

function trialAlreadyUsed() {
    const err = new Error('trial_already_used');
    err.code = 'trial_already_used';
    return err;
}

async function assertPlanTrialReady(plan) {
    if (!plan) throw new Error('Plan not found');
    if (!plan.trial_days || plan.trial_days <= 0) throw new Error('Plan has no trial_days configured');
    if (!plan.stripe_price_id) throw new Error('Plan is not synced to Stripe yet');
}

async function startOrgTrial(orgId, planId, { changedBy } = {}) {
    const store = userStore();
    const stripe = stripeService();

    const plan = await store.getPlan(planId);
    await assertPlanTrialReady(plan);

    const org = await store.getOrganization(orgId);
    if (!org) throw new Error('Organization not found');
    if (org.trial_used_at) throw trialAlreadyUsed();
    // Email-scoped: catches the delete-and-recreate bypass on the org row.
    if (org.email && await store.hasEmailUsedTrial('organization', org.email)) throw trialAlreadyUsed();

    if (!(await stripe.isEnabled())) throw new Error('Stripe is not enabled');

    const existing = await store.getOrgSubscription(orgId);
    const stripeCustomerId = existing?.stripe_customer_id || null;

    const trialResult = await stripe.createTrialSubscription({
        plan,
        subscriberType: 'organization',
        subscriberId: orgId,
        orgName: org.name,
        userEmail: org.email || undefined,
        stripeCustomerId,
        trialDays: plan.trial_days,
    });

    await store.setOrgSubscription(orgId, {
        plan_id: planId,
        status: 'trialing',
        payment_status: 'trialing',
        trial_end_date: trialResult.trialEnd,
        stripe_customer_id: trialResult.stripeCustomerId,
        stripe_subscription_id: trialResult.stripeSubscriptionId,
    });
    try {
        await require('./planEntitlements').applyPlanToOrg(orgId, planId, { mode: 'reset' });
    } catch (e) {
        console.warn(`[TrialService] applyPlanToOrg failed for ${orgId}:`, e.message);
    }
    await store.markTrialUsed('organization', orgId);
    await store.recordTrialHistory({
        scope: 'organization',
        email: org.email,
        subscriberId: orgId,
        planId,
        stripeCustomerId: trialResult.stripeCustomerId,
        stripeSubscriptionId: trialResult.stripeSubscriptionId,
        trialEndDate: trialResult.trialEnd,
    });
    await store.logSubscriptionAudit('start_trial', 'org_subscription', orgId, changedBy || 'system', existing, {
        plan_id: planId,
        trial_end_date: trialResult.trialEnd,
        stripe_subscription_id: trialResult.stripeSubscriptionId,
    });

    return await store.getOrgSubscription(orgId);
}

async function startConsumerTrial(userId, planId, { changedBy } = {}) {
    const store = userStore();
    const stripe = stripeService();

    const plan = await store.getPlan(planId);
    await assertPlanTrialReady(plan);

    const user = await store.getUser(userId);
    if (!user) throw new Error('User not found');
    if (user.trial_used_at) throw trialAlreadyUsed();
    if (user.email && await store.hasEmailUsedTrial('consumer', user.email)) throw trialAlreadyUsed();

    if (!(await stripe.isEnabled())) throw new Error('Stripe is not enabled');

    const existing = await store.getConsumerSubscription(userId);
    const stripeCustomerId = existing?.stripe_customer_id || null;

    const trialResult = await stripe.createTrialSubscription({
        plan,
        subscriberType: 'consumer',
        subscriberId: userId,
        userEmail: user.email || undefined,
        stripeCustomerId,
        trialDays: plan.trial_days,
    });

    await store.setConsumerSubscription(userId, {
        plan_id: planId,
        status: 'trialing',
        payment_status: 'trialing',
        trial_end_date: trialResult.trialEnd,
        stripe_customer_id: trialResult.stripeCustomerId,
        stripe_subscription_id: trialResult.stripeSubscriptionId,
    });
    await store.markTrialUsed('consumer', userId);
    await store.recordTrialHistory({
        scope: 'consumer',
        email: user.email,
        subscriberId: userId,
        planId,
        stripeCustomerId: trialResult.stripeCustomerId,
        stripeSubscriptionId: trialResult.stripeSubscriptionId,
        trialEndDate: trialResult.trialEnd,
    });
    await store.logSubscriptionAudit('start_trial', 'consumer_subscription', userId, changedBy || 'system', existing, {
        plan_id: planId,
        trial_end_date: trialResult.trialEnd,
        stripe_subscription_id: trialResult.stripeSubscriptionId,
    });

    return await store.getConsumerSubscription(userId);
}

async function getTrialConfig() {
    const [orgPlanId, consumerPlanId] = await Promise.all([
        configStore.getConfig(ORG_TRIAL_PLAN_KEY),
        configStore.getConfig(CONSUMER_TRIAL_PLAN_KEY),
    ]);
    return {
        default_org_trial_plan_id: orgPlanId || null,
        default_consumer_trial_plan_id: consumerPlanId || null,
    };
}

async function setTrialConfig({ default_org_trial_plan_id, default_consumer_trial_plan_id } = {}) {
    if (default_org_trial_plan_id !== undefined) {
        await configStore.setConfig(ORG_TRIAL_PLAN_KEY, default_org_trial_plan_id || '');
    }
    if (default_consumer_trial_plan_id !== undefined) {
        await configStore.setConfig(CONSUMER_TRIAL_PLAN_KEY, default_consumer_trial_plan_id || '');
    }
    return getTrialConfig();
}

// Fire-and-forget auto-grant from create-org / create-consumer entry points.
// Never throws — signup must succeed even if Stripe is down or the configured
// plan is missing. Logged warnings let the admin notice misconfiguration.
async function maybeAutoGrantOrgTrial(orgId) {
    // Trials are a Stripe/subscription concept — cloud only. Self-hosted (incl.
    // the retired 'private-cloud' value) uses licence keys, never trials.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'cloud') return null;
    try {
        const planId = await configStore.getConfig(ORG_TRIAL_PLAN_KEY);
        if (!planId) return null;
        return await startOrgTrial(orgId, planId, { changedBy: 'auto_grant_signup' });
    } catch (e) {
        if (e.code !== 'trial_already_used') {
            console.warn(`[TrialService] Auto-grant org trial failed for ${orgId}:`, e.message);
        }
        return null;
    }
}

async function maybeAutoGrantConsumerTrial(userId) {
    // Trials are a Stripe/subscription concept — cloud only. Self-hosted (incl.
    // the retired 'private-cloud' value) uses licence keys, never trials.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'cloud') return null;
    try {
        const planId = await configStore.getConfig(CONSUMER_TRIAL_PLAN_KEY);
        if (!planId) return null;
        return await startConsumerTrial(userId, planId, { changedBy: 'auto_grant_signup' });
    } catch (e) {
        if (e.code !== 'trial_already_used') {
            console.warn(`[TrialService] Auto-grant consumer trial failed for ${userId}:`, e.message);
        }
        return null;
    }
}

module.exports = {
    startOrgTrial,
    startConsumerTrial,
    getTrialConfig,
    setTrialConfig,
    maybeAutoGrantOrgTrial,
    maybeAutoGrantConsumerTrial,
};
