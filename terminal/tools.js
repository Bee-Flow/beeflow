/**
 * Terminal Agent — Tool Definitions for LLM
 * 
 * These tools let the LLM execute commands, write/read files, and manage Python packages
 * inside an isolated virtual environment.
 */

const TERMINAL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Execute a shell command in the terminal. The command runs in the configured working directory. Use this for general shell operations, file management, git, etc.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to execute (e.g. "ls -la", "cat file.txt", "git status")'
                    }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'python_exec',
            description: 'Execute Python code using the agent\'s virtual environment. The code is run as a script. Use this for data processing, calculations, running Python scripts, etc.',
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'Python code to execute. Can be multi-line. Will be run with the venv\'s Python interpreter.'
                    },
                    description: {
                        type: 'string',
                        description: 'Brief description of what this code does (for logging)'
                    }
                },
                required: ['code']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'pip_install',
            description: 'Install Python packages in the agent\'s virtual environment using pip.',
            parameters: {
                type: 'object',
                properties: {
                    packages: {
                        type: 'string',
                        description: 'Space-separated package names to install (e.g. "requests pandas numpy")'
                    }
                },
                required: ['packages']
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
    },
    {
        type: 'function',
        function: {
            name: 'convert_document_to_text',
            description: 'Extract text from a document (PDF, DOCX, CSV, XLSX) and save it as a new .txt file in the workspace. Use this to read files that are not plain text. After conversion, you can read or process the resulting text file using bash commands (grep, head, tail) or Python.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the document file (e.g., "report.pdf", "data.xlsx").'
                    }
                },
                required: ['path']
            }
        }
    }
];

module.exports = { TERMINAL_TOOLS };
