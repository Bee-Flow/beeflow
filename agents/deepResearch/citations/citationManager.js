/**
 * Deep Research — Citation Manager
 *
 * Centralized citation tracking across all research workers:
 *   - Assigns unique IDs to each source
 *   - Deduplicates by URL
 *   - Generates formatted reference lists
 *   - Provides inline citation helpers
 */

class CitationManager {
    constructor() {
        /** @type {Map<string, { id: number, title: string, url: string, excerpt: string, accessDate: string, relevanceScore: number, type: string }>} */
        this.sources = new Map(); // keyed by URL or unique identifier
        this.nextId = 1;
    }

    /**
     * Register a source and get its citation number.
     * Deduplicates by URL — same URL = same citation number.
     * @param {object} source - { title, url, excerpt, relevanceScore, type, accessDate }
     * @returns {number} Citation number [N]
     */
    addSource(source) {
        const key = source.url || source.title || `source_${this.nextId}`;

        if (this.sources.has(key)) {
            // Update fields if we have better data
            const existing = this.sources.get(key);
            if (!existing.excerpt && source.excerpt) existing.excerpt = source.excerpt;
            if (source.relevanceScore > (existing.relevanceScore || 0)) existing.relevanceScore = source.relevanceScore;
            return existing.id;
        }

        const id = this.nextId++;
        this.sources.set(key, {
            id,
            title: source.title || 'Untitled',
            url: source.url || null,
            excerpt: (source.excerpt || '').slice(0, 300),
            accessDate: source.accessDate || new Date().toISOString().split('T')[0],
            relevanceScore: source.relevanceScore || 0,
            type: source.type || 'web'
        });
        return id;
    }

    /**
     * Register multiple sources from worker results.
     * @param {object[]} results - Array of worker results with .sources[]
     */
    registerFromResults(results) {
        for (const result of results) {
            for (const source of (result.sources || [])) {
                this.addSource(source);
            }
        }
    }

    /**
     * Get inline citation for a URL: returns "[N]"
     */
    getCitation(url) {
        const entry = this.sources.get(url);
        return entry ? `[${entry.id}]` : '';
    }

    /**
     * Get all sources sorted by ID.
     */
    getAllSources() {
        return [...this.sources.values()].sort((a, b) => a.id - b.id);
    }

    /**
     * Generate a formatted reference list.
     */
    formatReferenceList() {
        const sources = this.getAllSources();
        if (sources.length === 0) return '';

        const lines = sources.map(s => {
            const urlPart = s.url ? ` — ${s.url}` : '';
            const datePart = s.accessDate ? ` (accessed ${s.accessDate})` : '';
            return `[${s.id}] ${s.title}${urlPart}${datePart}`;
        });

        return `\n---\n\n## Sources\n\n${lines.join('\n')}`;
    }

    /**
     * Get source count.
     */
    get count() {
        return this.sources.size;
    }
}

module.exports = { CitationManager };
