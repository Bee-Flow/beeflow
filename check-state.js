const db = require('./db');
(async () => {
    const orgs = await db.getAll('SELECT id, name, nc_instance_id FROM organizations');
    console.log('orgs:', orgs);
    const users = await db.getAll(`SELECT id, username, email, role, "orgRole", "organizationId" FROM users WHERE email = $1`, ['tomkooy@beeflow2.nl']);
    console.log('users with email tomkooy@beeflow2.nl:', users);
    process.exit(0);
})();
