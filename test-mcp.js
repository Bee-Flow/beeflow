const mcpStore = require('./stores/mcpStore');
const configStore = require('./stores/configStore');

async function run() {
    const servers = await mcpStore.getEnabledServers();
    console.log(JSON.stringify(servers, null, 2));
}
run();
