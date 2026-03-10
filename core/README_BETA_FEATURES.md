# Beta Features System

A feature-gating system that allows specific features to be toggled **per organization**. Any user belonging to an organization with a beta feature enabled gets access. Super admins always have access to all beta features.

---

## Quick Reference

### 1. Add a new beta feature

Open `server/core/betaFeatures.js` and add an entry to the `BETA_FEATURES` array:

```js
const BETA_FEATURES = [
    // ... existing features
    { id: 'my_new_feature', name: 'My New Feature', description: 'What it does' },
];
```

### 2. Gate a backend route

```js
const { requireBetaFeature } = require('../core/betaFeatures');

router.get('/my-route', requireBetaFeature('my_new_feature'), (req, res) => {
    // Only accessible if the user's org has 'my_new_feature' enabled
    res.json({ data: 'secret stuff' });
});
```

### 3. Check in backend logic (non-middleware)

```js
const { userHasBetaFeature } = require('../core/betaFeatures');

if (userHasBetaFeature(userId, 'my_new_feature', req.session)) {
    // do beta thing
}
```

### 4. Gate a frontend component

In any component that receives the `user` prop (or `hasBetaFeature` helper):

```jsx
// Using the helper (available in AgentHub.jsx):
{hasBetaFeature('my_new_feature') && (
    <MyNewFeatureComponent />
)}

// Or directly from the user object:
{(user?.betaFeatures || []).includes('my_new_feature') && (
    <MyNewFeatureComponent />
)}
```

### 5. Enable a beta feature for an organization

**Via API** (admin-only):

```bash
# Set features for an org
curl -X PUT /api/auth/admin/organizations/<orgId>/beta-features \
  -H 'Content-Type: application/json' \
  -d '{ "features": ["my_new_feature", "advanced_analytics"] }'

# Get the full registry + assignments
curl /api/auth/admin/beta-features
```

---

## Architecture

| Layer | File | What it does |
|-------|------|-------------|
| Registry + Helpers | `server/core/betaFeatures.js` | Defines features, DB migration, `requireBetaFeature()` middleware |
| Admin API | `server/auth/adminRoutes.js` | `GET /beta-features`, `PUT /organizations/:orgId/beta-features` |
| Session pipeline | `server/auth/loginRoutes.js` | `/my-permissions` returns `betaFeatures[]` |
| Frontend state | `agent-hub/src/App.jsx` | Stores `betaFeatures` on the `user` object |
| Frontend helper | `agent-hub/src/AgentHub.jsx` | `hasBetaFeature(id)` check |

## How it works

1. Admin assigns beta features to an organization via the API
2. Features are stored as a JSON array in the `beta_features` column on the `organizations` table
3. When a user logs in or refreshes, `/my-permissions` resolves their beta features by collecting from all their organizations (via groups)
4. The frontend receives `betaFeatures: string[]` and uses `hasBetaFeature()` to conditionally render UI
5. Backend routes use `requireBetaFeature('feature_id')` middleware to reject unauthorized access
