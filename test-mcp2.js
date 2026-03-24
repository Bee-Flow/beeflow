require('dotenv').config();
const { pool } = require('./db');

async function run() {
    const { rows } = await pool.query('SELECT * FROM "mcp_servers"');
    console.log("MCP SERVERS:", JSON.stringify(rows, null, 2));

    const { rows: creds } = await pool.query('SELECT * FROM "mcp_server_credentials"');
    console.log("MCP CREDS:", JSON.stringify(creds, null, 2));
    
    // Check global config for github tokens
    const { rows: globals } = await pool.query("SELECT * FROM \"workspace_settings\"");
    console.log("WORKSPACE SETTINGS:", JSON.stringify(globals.filter(g => g.key.includes('github')), null, 2));

    process.exit(0);
}
run();
