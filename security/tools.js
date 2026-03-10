/**
 * Security Agent — Tool Definitions for LLM
 * 
 * These tools let the LLM run Nuclei scans, analyze results, and generate reports
 * inside an isolated Docker container with Nuclei pre-installed.
 */

const SECURITY_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nuclei_scan',
            description: 'Run a Nuclei security scan against a target. Results are saved as JSON in /workspace/. Use this as the primary scanning tool.',
            parameters: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        description: 'Target URL, domain, or IP address to scan (e.g. "https://example.com", "192.168.1.0/24")'
                    },
                    templates: {
                        type: 'string',
                        description: 'Template filter: folder path, tag, or comma-separated tags (e.g. "cves", "vulnerabilities", "exposures,misconfigurations", "-t /root/nuclei-templates/http/"). Leave empty for default templates.'
                    },
                    severity: {
                        type: 'string',
                        description: 'Comma-separated severity filter (e.g. "critical,high,medium"). Options: info, low, medium, high, critical. Leave empty for all severities.'
                    },
                    rate_limit: {
                        type: 'integer',
                        description: 'Maximum requests per second (default: 50). Lower for sensitive targets.'
                    },
                    extra_args: {
                        type: 'string',
                        description: 'Additional Nuclei CLI arguments (e.g. "-headless", "-system-resolvers", "-retries 3")'
                    }
                },
                required: ['target']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Execute a shell command in the security container. Use for supplementary tasks like nmap scans, curl requests, DNS lookups, file management, or custom scripts.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to execute (e.g. "nmap -sV target.com", "curl -I https://example.com", "dig example.com")'
                    }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'generate_report',
            description: 'Generate a comprehensive security report from Nuclei scan results. Reads the JSON output file and produces a well-structured Markdown report with severity breakdown, detailed findings, and remediation advice.',
            parameters: {
                type: 'object',
                properties: {
                    results_file: {
                        type: 'string',
                        description: 'Path to the Nuclei JSON results file (e.g. "scan_results.json")'
                    },
                    target: {
                        type: 'string',
                        description: 'The scanned target (for report metadata)'
                    },
                    report_name: {
                        type: 'string',
                        description: 'Output filename for the report (default: "security_report.md")'
                    }
                },
                required: ['results_file', 'target']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Creates parent directories as needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path (relative to working directory or absolute)'
                    },
                    content: {
                        type: 'string',
                        description: 'Content to write to the file'
                    }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file. Returns the file content as text.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path to read (relative to working directory or absolute)'
                    },
                    maxLines: {
                        type: 'integer',
                        description: 'Maximum number of lines to read (default: 200). Use for large files.'
                    }
                },
                required: ['path']
            }
        }
    }
];

module.exports = { SECURITY_TOOLS };
