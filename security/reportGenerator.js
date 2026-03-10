/**
 * Security Agent — Report Generator
 * 
 * Transforms raw Nuclei JSON output into a comprehensive Markdown security report.
 */

/**
 * Parse Nuclei JSONL output (one JSON object per line) into an array of findings.
 * @param {string} jsonlContent - Raw JSONL content from Nuclei
 * @returns {Array} Parsed findings
 */
function parseNucleiOutput(jsonlContent) {
    const findings = [];
    const lines = jsonlContent.trim().split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const finding = JSON.parse(line.trim());
            findings.push(finding);
        } catch (e) {
            // Skip malformed lines
        }
    }

    return findings;
}

/**
 * Generate a comprehensive Markdown report from Nuclei findings.
 * @param {Array} findings - Parsed Nuclei findings
 * @param {string} target - The scanned target
 * @param {object} options - Additional options
 * @returns {string} Markdown report
 */
function generateMarkdownReport(findings, target, options = {}) {
    const scanDate = options.scanDate || new Date().toISOString();
    const duration = options.duration || 'N/A';

    // Categorize by severity
    const bySeverity = { critical: [], high: [], medium: [], low: [], info: [], unknown: [] };
    for (const f of findings) {
        const sev = (f.info?.severity || 'unknown').toLowerCase();
        if (bySeverity[sev]) {
            bySeverity[sev].push(f);
        } else {
            bySeverity.unknown.push(f);
        }
    }

    const totalFindings = findings.length;
    const criticalCount = bySeverity.critical.length;
    const highCount = bySeverity.high.length;
    const mediumCount = bySeverity.medium.length;
    const lowCount = bySeverity.low.length;
    const infoCount = bySeverity.info.length;

    // Determine overall risk rating
    let riskRating = '🟢 Low';
    if (criticalCount > 0) riskRating = '🔴 Critical';
    else if (highCount > 0) riskRating = '🟠 High';
    else if (mediumCount > 0) riskRating = '🟡 Medium';

    let report = '';

    // ── Header ──
    report += `# 🛡️ Security Scan Report\n\n`;

    // ── Executive Summary ──
    report += `## Executive Summary\n\n`;
    report += `| Property | Value |\n`;
    report += `|----------|-------|\n`;
    report += `| **Target** | \`${target}\` |\n`;
    report += `| **Scan Date** | ${scanDate} |\n`;
    report += `| **Duration** | ${duration} |\n`;
    report += `| **Total Findings** | ${totalFindings} |\n`;
    report += `| **Overall Risk** | ${riskRating} |\n\n`;

    // ── Severity Breakdown ──
    report += `## Severity Breakdown\n\n`;
    report += `| Severity | Count | Indicator |\n`;
    report += `|----------|-------|-----------|\n`;
    report += `| 🔴 Critical | ${criticalCount} | ${'█'.repeat(criticalCount).padEnd(20, '░')} |\n`;
    report += `| 🟠 High | ${highCount} | ${'█'.repeat(highCount).padEnd(20, '░')} |\n`;
    report += `| 🟡 Medium | ${mediumCount} | ${'█'.repeat(Math.min(mediumCount, 20)).padEnd(20, '░')} |\n`;
    report += `| 🔵 Low | ${lowCount} | ${'█'.repeat(Math.min(lowCount, 20)).padEnd(20, '░')} |\n`;
    report += `| ⚪ Info | ${infoCount} | ${'█'.repeat(Math.min(infoCount, 20)).padEnd(20, '░')} |\n\n`;

    // ── Detailed Findings (by severity) ──
    const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
    const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

    for (const sev of severityOrder) {
        const items = bySeverity[sev];
        if (items.length === 0) continue;

        report += `## ${severityEmoji[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)} Findings (${items.length})\n\n`;

        for (let i = 0; i < items.length; i++) {
            const f = items[i];
            const info = f.info || {};
            const name = info.name || f['template-id'] || 'Unknown';
            const templateId = f['template-id'] || 'N/A';
            const matchedAt = f['matched-at'] || f.host || 'N/A';
            const description = info.description || 'No description available.';
            const reference = info.reference || [];
            const tags = (info.tags || []);
            const matcher = f['matcher-name'] || '';
            const extractedResults = f['extracted-results'] || [];
            const curl = f['curl-command'] || '';

            report += `### ${i + 1}. ${name}\n\n`;
            report += `| Field | Details |\n`;
            report += `|-------|--------|\n`;
            report += `| **Template** | \`${templateId}\` |\n`;
            report += `| **Severity** | ${severityEmoji[sev]} ${sev.toUpperCase()} |\n`;
            report += `| **Matched At** | \`${matchedAt}\` |\n`;
            if (matcher) report += `| **Matcher** | \`${matcher}\` |\n`;
            if (tags.length) report += `| **Tags** | ${tags.map(t => `\`${t}\``).join(', ')} |\n`;
            report += `\n`;

            if (description && description !== 'No description available.') {
                report += `**Description:** ${description}\n\n`;
            }

            if (extractedResults.length > 0) {
                report += `**Extracted Data:**\n`;
                report += '```\n';
                for (const er of extractedResults) {
                    report += `${er}\n`;
                }
                report += '```\n\n';
            }

            if (reference.length > 0) {
                report += `**References:**\n`;
                for (const ref of reference) {
                    if (typeof ref === 'string' && ref.startsWith('http')) {
                        report += `- ${ref}\n`;
                    }
                }
                report += '\n';
            }

            if (curl) {
                report += `<details>\n<summary>Reproduction Command</summary>\n\n\`\`\`bash\n${curl}\n\`\`\`\n</details>\n\n`;
            }

            report += `---\n\n`;
        }
    }

    // ── Remediation Priorities ──
    const actionableFindings = [...bySeverity.critical, ...bySeverity.high, ...bySeverity.medium];
    if (actionableFindings.length > 0) {
        report += `## Remediation Priorities\n\n`;
        report += `The following issues should be addressed in order of severity:\n\n`;

        let priority = 1;
        for (const f of actionableFindings) {
            const info = f.info || {};
            const sev = (info.severity || 'unknown').toLowerCase();
            const name = info.name || f['template-id'] || 'Unknown';
            const remediation = info.remediation || getDefaultRemediation(f['template-id'], sev);
            report += `${priority}. **${severityEmoji[sev]} ${name}** — ${remediation}\n`;
            priority++;
        }
        report += '\n';
    }

    // ── Recommendations ──
    report += `## General Recommendations\n\n`;
    report += `1. **Patch Management**: Keep all software and dependencies up to date\n`;
    report += `2. **Security Headers**: Implement CSP, HSTS, X-Frame-Options, and X-Content-Type-Options\n`;
    report += `3. **TLS Configuration**: Use TLS 1.2+ with strong cipher suites\n`;
    report += `4. **Access Control**: Review exposed endpoints and enforce authentication\n`;
    report += `5. **Information Disclosure**: Remove version banners, debug endpoints, and unnecessary headers\n`;
    report += `6. **Regular Scanning**: Schedule periodic security scans to catch new vulnerabilities\n\n`;

    // ── Footer ──
    report += `---\n\n`;
    report += `*Report generated by Security Scanner Agent using [Nuclei](https://github.com/projectdiscovery/nuclei) by ProjectDiscovery.*\n`;

    return report;
}

/**
 * Get a default remediation suggestion based on template ID or severity.
 */
function getDefaultRemediation(templateId, severity) {
    if (!templateId) return 'Review and remediate this finding.';

    const id = templateId.toLowerCase();
    if (id.includes('cve-')) return 'Apply the relevant security patch or update the affected software.';
    if (id.includes('xss')) return 'Implement proper input validation and output encoding.';
    if (id.includes('sqli') || id.includes('sql-injection')) return 'Use parameterized queries and input validation.';
    if (id.includes('header') || id.includes('headers')) return 'Configure the appropriate security headers on your web server.';
    if (id.includes('ssl') || id.includes('tls')) return 'Update TLS configuration to use secure protocols and cipher suites.';
    if (id.includes('cors')) return 'Review and restrict CORS policy to trusted origins only.';
    if (id.includes('open-redirect')) return 'Validate and whitelist redirect URLs.';
    if (id.includes('disclosure') || id.includes('exposed')) return 'Remove or restrict access to the exposed resource.';
    if (id.includes('default') || id.includes('credential')) return 'Change default credentials immediately.';

    return 'Review and remediate according to the vulnerability details above.';
}

module.exports = {
    parseNucleiOutput,
    generateMarkdownReport
};
