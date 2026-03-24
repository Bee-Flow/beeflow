const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core'
});

async function main() {
  await client.connect();
  const res = await client.query('SELECT * FROM mcp_servers');
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}

main().catch(console.error);
