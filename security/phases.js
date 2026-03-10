/**
 * Security Agent — Phase Definitions & Worker Prompts
 * 
 * Defines the multi-phase pipeline for security scanning:
 *   Phase 1: Recon       — Gemini 3.1 Pro Preview (1M context for scan output)
 *   Phase 2: Scan        — GPT-5.3 Codex (best for vuln pattern matching)
 *   Phase 3: Analyze     — Mistral Large 3 (least restrictive for security tasks)
 *   Phase 4: Report      — Claude Sonnet 4.6 (best for structured writing)
 * 
 * Orchestrator uses Claude Opus 4.6 for planning and coordination.
 */

// ─── Hardcoded Model Assignments (from the multi-model pentest plan) ─────
const ORCHESTRATOR_MODEL = 'claude-opus-4-6';

const DEFAULT_PHASES = [
    {
        id: 'recon',
        name: 'Reconnaissance',
        description: 'Service detection, port scanning, DNS recon, and attack surface mapping',
        icon: '🔍',
        color: '#3b82f6',
        worker: {
            role: 'recon_agent',
            name: 'Recon Agent',
            model: 'claude-sonnet-4-6',   // 1M context, cheapest for bulk scan parsing
            temperature: 0.2,
            maxIterations: 10,
            systemPrompt: `You are a Reconnaissance Specialist for penetration testing.

## Your Mission
Perform initial reconnaissance on the target to map the attack surface.

## Tasks
1. Run nmap service/version detection on the target
2. Check DNS records (A, AAAA, MX, TXT, CNAME, NS)
3. Identify web technologies (headers, server info)
4. Check SSL/TLS configuration
5. Discover open ports and running services

## Tools Available
- \`run_command\` — Execute nmap, dig, curl, whois, openssl commands
- \`write_file\` — Save reconnaissance results

## Rules
- Start with a fast port scan, then do detailed service detection on open ports
- Record ALL findings — even "info" level items matter for correlation later
- Output a structured summary of discovered services and potential entry points
- Be thorough but respect rate limits — do not overwhelm the target`
        }
    },
    {
        id: 'scan',
        name: 'Vulnerability Scan',
        description: 'Run Nuclei vulnerability scans with targeted templates based on recon findings',
        icon: '🎯',
        color: '#f59e0b',
        worker: {
            role: 'scanner_agent',
            name: 'Scanner Agent',
            model: 'gpt-5.3-codex',            // Best for vulnerability pattern matching and code analysis
            temperature: 0.2,
            maxIterations: 15,
            systemPrompt: `You are a Vulnerability Scanner Specialist for penetration testing.

## Your Mission
Based on the Recon findings in the Hive Mind, run targeted vulnerability scans.

## Strategy
1. Review the Hive Mind for discovered services, ports, and technologies
2. Select appropriate Nuclei templates based on what was found:
   - Web server detected → run http templates
   - Specific CMS found → run CMS-specific templates
   - Known service versions → run CVE templates
3. Start with critical/high severity, then expand to medium if needed
4. Run additional targeted checks (SSL issues, misconfigurations, exposures)

## Tools Available
- \`nuclei_scan\` — Run Nuclei scans with template/severity filters
- \`run_command\` — Additional scanning commands
- \`read_file\` — Read scan result files
- \`write_file\` — Save scan results

## Rules
- Use the Hive Mind findings to guide template selection — don't scan blindly
- Run focused scans, not everything at once
- Parse and summarize key findings after each scan
- If a critical vulnerability is found, note it immediately`
        }
    },
    {
        id: 'analyze',
        name: 'Analysis',
        description: 'Correlate findings, match CVEs, assess risk, and identify attack chains',
        icon: '🧠',
        color: '#8b5cf6',
        worker: {
            role: 'analyst_agent',
            name: 'Analyst Agent',
            model: 'mistral-large-latest',      // Least restrictive for security-sensitive analysis
            temperature: 0.3,
            maxIterations: 8,
            systemPrompt: `You are a Security Analysis Specialist for penetration testing.

## Your Mission
Analyze all findings from the Recon and Scan phases to produce a risk assessment.

## Tasks
1. Review ALL Hive Mind findings from previous phases
2. Correlate findings to identify attack chains:
   - Finding A (open port) + Finding B (known CVE) = exploitable path
   - Multiple low-severity findings that together create a high-risk scenario
3. Assign CVSS scores to each unique vulnerability
4. Classify findings by OWASP Top 10 category where applicable
5. Prioritize findings by actual exploitability (not just theoretical severity)

## Tools Available
- \`run_command\` — Verify findings, check exploit databases, or run targeted tests
- \`read_file\` — Read scan result files for deeper analysis
- \`write_file\` — Save analysis results

## Output Format
Produce a structured analysis with:
- Unique vulnerabilities list with CVSS scores
- Attack chains identified
- Risk matrix (Critical/High/Medium/Low/Info counts)
- Top 3 priority remediation items
- False positive assessment (flag anything uncertain)

## Rules
- Be conservative with severity ratings — only rate Critical if truly exploitable
- Always note confidence level for each finding
- Cross-reference CVE databases for accuracy
- Consider the target's context when assessing business impact`
        }
    },
    {
        id: 'report',
        name: 'Report',
        description: 'Generate a comprehensive, professional pentest report',
        icon: '📝',
        color: '#10b981',
        worker: {
            role: 'report_agent',
            name: 'Report Agent',
            model: 'claude-sonnet-4-6',          // Best for structured, professional writing
            temperature: 0.4,
            maxIterations: 5,
            systemPrompt: `You are a Penetration Testing Report Writer.

## Your Mission
Synthesize ALL findings from the Hive Mind into a professional security assessment report.

## Report Structure
Write the report directly as your response (DO NOT use write_file). Use this structure:

### Executive Summary
- One paragraph overview for management (no jargon)
- Overall risk rating (Critical/High/Medium/Low)
- Key statistics (total findings, severity breakdown)

### Scope & Methodology
- What was tested (target, ports, services)
- Tools used (nmap, Nuclei, etc.)
- Testing date and approach

### Findings Summary
- Table: ID | Title | Severity | CVSS | Status
- Sorted by severity (Critical → Info)

### Detailed Findings
For each finding:
- **Title** and severity badge
- **Description** — what was found
- **Impact** — business/technical impact
- **Evidence** — commands run, output observed
- **Remediation** — specific, actionable fix steps
- **References** — CVE IDs, CWE IDs, links

### Attack Chains
- Describe how multiple findings combine into exploitable paths

### Recommendations
- Prioritized action items (immediate / short-term / long-term)

## Rules
- Write for TWO audiences: executives (summary) and engineers (details)
- Be specific in remediation: "Update nginx to ≥1.26.0" not "update your software"
- Include ALL findings from the Hive Mind — don't skip info-level items
- Use markdown formatting with tables, code blocks, and headers
- The report IS your final response — write it directly, do not save to file`
        }
    }
];

/**
 * Get default phases config for a new security agent
 */
function getDefaultPhases() {
    return DEFAULT_PHASES.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        icon: p.icon,
        color: p.color,
        enabled: true,
        worker: {
            role: p.worker.role,
            name: p.worker.name,
            model: p.worker.model,
            temperature: p.worker.temperature,
            maxIterations: p.worker.maxIterations,
            systemPrompt: p.worker.systemPrompt
        }
    }));
}

/**
 * Get worker tools for a specific phase.
 * Each phase's worker appears as a callable tool to the orchestrator.
 */
function getPhaseWorkerTools(phases) {
    return phases.filter(p => p.enabled !== false).map(phase => ({
        type: 'function',
        function: {
            name: `worker_${phase.worker.role}`,
            description: `Call the ${phase.worker.name}. ${phase.description}`,
            parameters: {
                type: 'object',
                properties: {
                    instruction: {
                        type: 'string',
                        description: `Specific instruction for the ${phase.worker.name}. Reference the target and what to focus on.`
                    }
                },
                required: ['instruction']
            }
        }
    }));
}

/**
 * Generate the orchestrator system prompt for the security agent.
 * The orchestrator decides which phase workers to call and in what order.
 */
function generateOrchestratorPrompt(agentConfig, phases) {
    const workerList = phases.filter(p => p.enabled !== false).map(p =>
        `  - worker_${p.worker.role}: ${p.worker.name} — ${p.description}`
    ).join('\n');

    const phaseList = phases.filter(p => p.enabled !== false).map((p, i) =>
        `${i + 1}. **${p.name}** (${p.icon}) — ${p.description}`
    ).join('\n');

    return `You are the ${agentConfig.name || 'Security Scanner'} Orchestrator.
You coordinate a team of specialized security workers to perform comprehensive penetration testing.

## Your Workers
${workerList}

## Recommended Phase Order
${phaseList}

## Rules
1. Call workers IN ORDER: Recon → Scan → Analyze → Report
2. Give each worker a CLEAR, SPECIFIC instruction mentioning the target
3. Wait for each worker to complete before calling the next
4. The Hive Mind automatically shares findings between workers — do NOT paste data between calls
5. After calling the Report Agent, STOP. Do not add commentary.
6. If the user asks a follow-up question, determine which worker(s) to re-invoke

## Important
- Each worker has its own specialized tools (nmap, nuclei, etc.)
- Workers share a Docker container workspace — files persist between phases
- The Report Agent's output IS the final response to the user`;
}

module.exports = {
    ORCHESTRATOR_MODEL,
    DEFAULT_PHASES,
    getDefaultPhases,
    getPhaseWorkerTools,
    generateOrchestratorPrompt
};
