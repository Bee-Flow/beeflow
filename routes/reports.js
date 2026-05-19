/**
 * Reports API Routes
 * Generates JSON-structured reports for the frontend PageRenderer
 */

const express = require('express');
const agentStore = require('../stores/agentStore');
const memoryStore = require('../stores/memoryStore');
const { requireAuth, requirePermission } = require('../auth/permissions');

const router = express.Router();

const REPORT_TYPES = [
    {
        id: 'system-overview',
        name: 'System Overview',
        description: 'Global statistics about agents, conversations, and memory usage',
        filters: [
            { id: 'dateRange', type: 'date-range', label: 'Time Period' }
        ]
    },
    {
        id: 'agent-performance',
        name: 'Agent Performance',
        description: 'Detailed activity metrics for each agent',
        filters: [
            { id: 'dateRange', type: 'date-range', label: 'Time Period' }
        ]
    }
];

// Get available report types
router.get('/types', requireAuth, async (req, res) => {
    res.json(REPORT_TYPES);
});

// Generate a specific report
router.get('/:type', requireAuth, requirePermission('admin_monitoring'), async (req, res) => {
    const { type } = req.params;
    const userId = req.session.user.id;

    try {
        let reportData;
        const { startDate, endDate } = req.query;
        const filters = { startDate: startDate || null, endDate: endDate || null };

        switch (type) {
            case 'system-overview':
                reportData = await generateSystemOverview(userId, filters);
                break;
            case 'agent-performance':
                reportData = await generateAgentPerformance(userId, filters);
                break;
            default:
                return res.status(404).json({ error: 'Report type not found' });
        }

        res.json(reportData);
    } catch (error) {
        console.error(`Failed to generate report ${type}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Report Generators

async function generateSystemOverview(userId, filters = {}) {
    const { startDate, endDate } = filters;
    const agentStats = await agentStore.getSystemStats(startDate, endDate);
    const memoryStats = memoryStore.getMemoryStats(userId);

    const title = startDate ? `System Overview (${startDate.split('T')[0]} - ${endDate.split('T')[0]})` : "System Overview";

    // Prepare chart data for messages per agent
    const messageChartData = {
        labels: [],
        datasets: [{
            label: 'Messages',
            data: [],
            backgroundColor: 'rgba(99, 102, 241, 0.5)',
            borderColor: 'rgba(99, 102, 241, 1)',
            borderWidth: 1
        }]
    };

    // Get top 5 agents by message count
    const topAgents = Object.entries(agentStats.agentMessageCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    // Fetch names for top agents
    for (const [agentId, count] of topAgents) {
        const agent = await agentStore.getAgent(agentId);
        messageChartData.labels.push(agent ? agent.name : 'Unknown Agent');
        messageChartData.datasets[0].data.push(count);
    }

    return {
        title: "System Overview",
        layout: [
            {
                type: "heading",
                content: "Global Statistics",
                level: 2
            },
            {
                type: "row",
                cols: [
                    { type: "stat", label: "Total Agents", value: agentStats.totalAgents, icon: "users" },
                    { type: "stat", label: "Total Conversations", value: agentStats.totalConversations, icon: "chat" },
                    { type: "stat", label: "Active (7d)", value: agentStats.activeConversations, icon: "activity" }
                ]
            },
            { type: "divider" },
            {
                type: "heading",
                content: "Memory Usage",
                level: 2
            },
            {
                type: "row",
                cols: [
                    { type: "stat", label: "Total Memories", value: memoryStats.total, icon: "brain" },
                    { type: "stat", label: "High Importance", value: memoryStats.importanceDistribution.high, icon: "star" },
                    {
                        type: "chart",
                        title: "Memory Types",
                        chartType: "pie", // Assuming PageRenderer supports this, relying on provided components
                        data: {
                            labels: memoryStats.typeDistribution.labels,
                            datasets: [{
                                label: 'Memories',
                                data: memoryStats.typeDistribution.data,
                                backgroundColor: [
                                    'rgba(16, 185, 129, 0.6)',
                                    'rgba(59, 130, 246, 0.6)',
                                    'rgba(245, 158, 11, 0.6)',
                                    'rgba(239, 68, 68, 0.6)'
                                ]
                            }]
                        }
                    }
                ]
            },
            { type: "divider" },
            {
                type: "heading",
                content: "Most Active Agents",
                level: 2
            },
            {
                type: "chart",
                title: "Messages per Agent",
                chartType: "bar",
                data: messageChartData
            }
        ]
    };
}

async function generateAgentPerformance(userId) {
    const agents = await agentStore.getAgents('system'); // Get system + user agents would be better, but start with user
    // Actually, getAgents(userId) returns user's agents + system agents.
    // Let's get ALL agents for admin view if possible, but adhering to existing pattern.
    // Ideally we want *all* agents for an admin report, but `getAgents` filters by owner.
    // We recently added `getAllAgents()` for admin dashboard. Let's use that.

    // Check if user is admin (simple check: usually effective user ID is set)
    // For now, let's just use getAllAgents() which we added for Admin Dashboard
    const allAgents = await agentStore.getAllAgents();

    const rows = [];

    for (const agent of allAgents) {
        const stats = await agentStore.getAgentStats(agent.id);
        const tools = await agentStore.getAgentTools(agent.id);

        rows.push({
            id: agent.id,
            name: agent.name,
            model: agent.model,
            conversations: stats.conversationCount,
            messages: stats.messageCount,
            tools: tools.length,
            last_active: stats.lastUpdated
        });
    }

    // Sort by messages desc
    rows.sort((a, b) => b.messages - a.messages);

    return {
        title: title,
        layout: [
            {
                type: "heading",
                content: "Agent Activity Metrics",
                level: 2
            },
            {
                type: "table",
                title: "Detailed Agent Stats",
                columns: [
                    { key: "name", label: "Agent Name" },
                    { key: "model", label: "Model" },
                    { key: "conversations", label: "Conversations" },
                    { key: "messages", label: "Messages" },
                    { key: "tools", label: "Tools" },
                    { key: "last_active", label: "Last Updated" }
                ],
                data: rows
            }
        ]
    };
}

module.exports = router;
