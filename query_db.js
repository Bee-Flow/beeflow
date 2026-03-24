const db = require('./core/db');

async function main() {
  const result = await db.query('SELECT * FROM mcp_servers');
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit(0);
}

main().catch(console.error);
