const db = require('./db');
(async () => {
    try {
        const tables = await db.getAll(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%plan%'"
        );
        console.log('plan tables:', tables.map(t => t.table_name));
        const tbl = tables.find(t => /^(plans|subscription_plans)$/i.test(t.table_name));
        if (!tbl) { console.error('No plans table found'); process.exit(1); }
        const TABLE = tbl.table_name;
        console.log('Using table:', TABLE);

        const cols = await db.getAll(
            "SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
            [TABLE]
        );
        console.log('columns:', cols.map(c => c.column_name).join(', '));

        // Hide all current plans from the wizard (FK constraints prevent
        // a clean DELETE — existing org_subscriptions reference them).
        await db.run(`UPDATE ${TABLE} SET is_public = false`);
        console.log('hid existing plans');

        // Upsert the 2 production plans we actually want to expose.
        const upsert = async (id, name, price, trial, stripeId) => {
            await db.run(
                `INSERT INTO ${TABLE} (id, name, plan_type, description, price, currency, billing_interval, trial_days, allowed_features, is_public, is_default, nc_recommended, stripe_price_id, created_at, updated_at)
                 VALUES ($1, $2, 'organization', '', $3, 'EUR', 'monthly', $4, '[]', true, false, false, $5, NOW(), NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   name = EXCLUDED.name,
                   price = EXCLUDED.price,
                   trial_days = EXCLUDED.trial_days,
                   stripe_price_id = EXCLUDED.stripe_price_id,
                   is_public = true,
                   updated_at = NOW()`,
                [id, name, price, trial, stripeId]
            );
        };
        await upsert('2852d756-411c-4459-b335-84878566732a', 'Bee Flow',   30, 14, 'price_1TZ6XIFK891jSpBru7DVVLZn');
        await upsert('d27181cf-f4b4-4da3-919a-2e2c3be43bb1', 'Enterprise', 50, 0,  'price_1TZVGiFK891jSpBr3szqeC8z');

        const after = await db.getAll(`SELECT id, name, price FROM ${TABLE} WHERE is_public = true ORDER BY price`);
        console.log('now:', after);
        process.exit(0);
    } catch (e) {
        console.error('ERR:', e.message);
        process.exit(1);
    }
})();
