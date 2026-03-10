/**
 * Agent Stats - Reporting statistics across agents and conversations
 */

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');

async function getSystemStats(startDate = null, endDate = null) {
    await initDB();
    let totalAgents, totalConversations, activeConversations, allConvs;

    if (!startDate && !endDate) {
        totalAgents = (await getOne("SELECT COUNT(*) as count FROM agents WHERE owner_id NOT IN ('system', 'swarm')")).count;
        totalConversations = (await getOne('SELECT COUNT(*) as count FROM agent_conversations')).count;
        activeConversations = (await getOne("SELECT COUNT(*) as count FROM agent_conversations WHERE updated_at > NOW() - INTERVAL '7 days'")).count;
        allConvs = await getAll('SELECT agent_id, messages_json FROM agent_conversations');
    } else {
        totalAgents = (await getOne("SELECT COUNT(*) as count FROM agents WHERE ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)", [startDate, endDate])).count;
        totalConversations = (await getOne('SELECT COUNT(*) as count FROM agent_conversations WHERE ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)', [startDate, endDate])).count;
        activeConversations = (await getOne("SELECT COUNT(*) as count FROM agent_conversations WHERE updated_at > NOW() - INTERVAL '7 days' AND ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)", [startDate, endDate])).count;
        allConvs = await getAll('SELECT agent_id, messages_json FROM agent_conversations WHERE ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)', [startDate, endDate]);
    }

    let totalMessages = 0;
    const agentMessageCounts = {};
    for (const row of allConvs) {
        try {
            const msgs = JSON.parse(row.messages_json || '[]');
            totalMessages += msgs.length;
            agentMessageCounts[row.agent_id] = (agentMessageCounts[row.agent_id] || 0) + msgs.length;
        } catch (e) { /* ignore parse errors */ }
    }

    return { totalAgents, totalConversations, activeConversations, totalMessages, agentMessageCounts };
}

async function getAgentStats(agentId, startDate = null, endDate = null) {
    await initDB();
    const stats = await getOne(`SELECT
        (SELECT COUNT(*) FROM agent_conversations WHERE agent_id = $1) as conversation_count,
        (SELECT updated_at FROM agents WHERE id = $2) as last_updated`, [agentId, agentId]);

    let sql = 'SELECT messages_json FROM agent_conversations WHERE agent_id = $1';
    const params = [agentId];
    let idx = 2;
    if (startDate) { sql += ` AND created_at >= $${idx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND created_at <= $${idx++}`; params.push(endDate); }

    const convs = await getAll(sql, params);
    const conversationCount = startDate || endDate ? convs.length : (stats?.conversation_count ?? 0);
    let messageCount = 0;
    for (const row of convs) {
        try { messageCount += JSON.parse(row.messages_json || '[]').length; } catch (e) { }
    }

    return { conversationCount, lastUpdated: stats?.last_updated, messageCount };
}

module.exports = { getSystemStats, getAgentStats };
