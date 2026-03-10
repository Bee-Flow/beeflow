/**
 * Browser Agent — Tool Definitions for LLM
 */

const BROWSER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'navigate',
            description: 'Navigate to a URL.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The URL to navigate to' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'click',
            description: 'Click on an element. Preferred: use elementId from observe() (e.g. "btn_3"). Fallback: use selector with method "css", "text", or "role".',
            parameters: {
                type: 'object',
                properties: {
                    elementId: { type: 'string', description: 'Element ID from observe() output (e.g. "btn_3", "link_1"). Preferred over selector.' },
                    selector: { type: 'string', description: 'CSS selector or text content. Only needed if elementId is not available.' },
                    method: { type: 'string', enum: ['css', 'text', 'role'], description: 'How to find the element (when not using elementId). Default: css' },
                    role: { type: 'string', description: 'ARIA role (e.g. "button", "link"). Only used when method is "role".' },
                    name: { type: 'string', description: 'Accessible name of the element. Only used when method is "role".' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'type_text',
            description: 'Type text into an input field. Preferred: use elementId from observe(). Fallback: use CSS selector.',
            parameters: {
                type: 'object',
                properties: {
                    elementId: { type: 'string', description: 'Element ID from observe() output (e.g. "input_2"). Preferred over selector.' },
                    selector: { type: 'string', description: 'CSS selector of the input field. Only needed if elementId is not available.' },
                    text: { type: 'string', description: 'Text to type' },
                    clear: { type: 'boolean', description: 'Clear field first. Default: true' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'scroll',
            description: 'Scroll the page.',
            parameters: {
                type: 'object',
                properties: {
                    direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
                    amount: { type: 'integer', description: 'Pixels to scroll. Default: 500' }
                },
                required: ['direction']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'extract_text',
            description: 'Extract text from the page or a specific element. Use for reading content.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'Optional CSS selector. Omit for full page.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'observe',
            description: 'Get a structured snapshot of the current page with element IDs. Returns headings, interactive elements (buttons, links, inputs) each with an ID like "btn_0", "link_3", "input_5" that you can pass to click() or type_text(). Much cheaper than extract_text. Use this to understand the page before acting.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'take_screenshot',
            description: 'Take a screenshot of the current page.',
            parameters: {
                type: 'object',
                properties: {
                    fullPage: { type: 'boolean', description: 'Full page screenshot. Default: false' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'wait',
            description: 'Wait for the page to finish updating. After click, navigate, and press_key(Enter), the system already auto-waits for network idle + DOM stability (up to 8s). Use this tool only when you need to wait LONGER (e.g. for a chatbot to finish a long streaming response, or a slow API). You can wait for a specific element, or for a fixed duration.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector to wait for (visible). Use only when you know the specific element.' },
                    ms: { type: 'integer', description: 'Milliseconds to wait. Default: 2000. Max: 15000. Only if no selector.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'go_back',
            description: 'Go back in browser history.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'done',
            description: 'Task is complete. Provide the result summary.',
            parameters: {
                type: 'object',
                properties: {
                    result: { type: 'string', description: 'Summary of what was accomplished or extracted information.' }
                },
                required: ['result']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'press_key',
            description: 'Press a keyboard key. Use Enter to submit forms/search boxes, Escape to close overlays/modals, Tab to move focus.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Key to press: "Enter", "Escape", "Tab", "ArrowDown", etc.' }
                },
                required: ['key']
            }
        }
    }
];

module.exports = { BROWSER_TOOLS };
