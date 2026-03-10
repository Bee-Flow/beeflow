/**
 * Hive Mind — Distributed intelligence for swarm runs
 * 
 * Modeled after real honeybee swarm intelligence:
 * - Each worker explores independently (like scout bees)
 * - Workers contribute findings back to the hive (waggle dance)
 * - Later workers see all prior discoveries and can build upon them
 * - The orchestrator synthesizes the hive's collective knowledge
 * 
 * Created once per chatWithAgentStream call when isSwarm=true.
 */

class HiveMind {
    constructor(swarmId) {
        this.swarmId = swarmId;
        this.entries = [];
    }

    /**
     * Read hive entries, optionally filtered by phase
     * @param {string|null} phase - Filter by phase name, or null for all
     * @returns {Array} entries
     */
    read(phase = null) {
        if (phase) {
            return this.entries.filter(e => e.phase === phase);
        }
        return [...this.entries];
    }

    /**
     * Worker contributes findings to the hive mind (waggle dance)
     * @param {string} phase - The phase the worker belongs to
     * @param {string} worker - The worker name
     * @param {string} content - The worker's findings
     */
    addEntry(phase, worker, content) {
        this.entries.push({
            phase,
            worker,
            content,
            timestamp: new Date().toISOString()
        });
        console.log(`[HiveMind] 🐝 ${worker} contributed to the hive (${phase}) — ${this.entries.length} total entries`);
    }

    /**
     * Format hive knowledge for injection into worker prompts.
     * Workers receive the collective intelligence of all prior scouts.
     */
    toPromptContext() {
        if (this.entries.length === 0) {
            return '';
        }

        let context = '## 🐝 Hive Mind — Collective Intelligence\n';
        context += 'You are part of a swarm. The following findings have been contributed by fellow workers.\n';
        context += 'Study this shared knowledge carefully. Build upon it — do not repeat what has already been discovered.\n';
        context += 'If you find information that contradicts prior findings, highlight the discrepancy.\n\n';

        // Group by phase for readability
        const byPhase = {};
        for (const entry of this.entries) {
            const key = entry.phase || 'General';
            if (!byPhase[key]) byPhase[key] = [];
            byPhase[key].push(entry);
        }

        for (const [phase, entries] of Object.entries(byPhase)) {
            context += `### Phase: ${phase}\n`;
            for (const entry of entries) {
                context += `**${entry.worker}:**\n${entry.content}\n\n`;
            }
        }

        context += '---\nUse the collective knowledge above to inform your work. Explore new angles rather than retreading covered ground.\n';
        return context;
    }

    /**
     * Get the number of entries
     */
    get size() {
        return this.entries.length;
    }
}

module.exports = HiveMind;
