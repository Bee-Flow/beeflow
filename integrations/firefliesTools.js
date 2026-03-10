/**
 * Fireflies.ai Tools — Built-in tools for AI to search and read meeting transcripts
 * 
 * These tools are injected into the LLM tool set when a Fireflies API key is configured,
 * allowing the AI to list, search, and summarize meeting transcriptions.
 */

const configStore = require('../stores/configStore');

const FIREFLIES_API_URL = 'https://api.fireflies.ai/graphql';

/**
 * Tool definitions in OpenAI function-calling format.
 */
const FIREFLIES_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'fireflies_list_transcripts',
            description: 'List meeting transcripts from Fireflies.ai. Returns meeting titles, dates, durations, organizers, and participants. Supports filtering by title, date range, host, or participant. Use this when the user asks about their meetings, calls, or transcriptions.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Filter by meeting title (partial match)'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of results (1-50, default 10)'
                    },
                    skip: {
                        type: 'integer',
                        description: 'Pagination offset (default 0)'
                    },
                    hostEmail: {
                        type: 'string',
                        description: 'Filter by host/organizer email'
                    },
                    participantEmail: {
                        type: 'string',
                        description: 'Filter by participant email'
                    },
                    fromDate: {
                        type: 'string',
                        description: 'Start date filter in ISO 8601 format (e.g. "2025-01-01T00:00:00.000Z")'
                    },
                    toDate: {
                        type: 'string',
                        description: 'End date filter in ISO 8601 format'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fireflies_get_summary',
            description: 'Get the AI-generated summary, action items, and analytics for a specific meeting transcript from Fireflies.ai. Use this when the user asks about what was discussed in a meeting, decisions made, action items, or key points. Requires a transcript ID from fireflies_list_transcripts.',
            parameters: {
                type: 'object',
                properties: {
                    transcriptId: {
                        type: 'string',
                        description: 'The transcript ID from fireflies_list_transcripts results'
                    }
                },
                required: ['transcriptId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fireflies_get_transcript',
            description: 'Get the full sentence-by-sentence transcription of a meeting from Fireflies.ai. Use this when the user wants to see exactly what was said in a meeting, or wants to search for specific quotes/topics within the conversation. This returns the complete text — use fireflies_get_summary for a shorter overview. Requires a transcript ID from fireflies_list_transcripts.',
            parameters: {
                type: 'object',
                properties: {
                    transcriptId: {
                        type: 'string',
                        description: 'The transcript ID from fireflies_list_transcripts results'
                    },
                    speakerFilter: {
                        type: 'string',
                        description: 'Optional: only return sentences from this speaker name'
                    }
                },
                required: ['transcriptId']
            }
        }
    }
];

// ─── GraphQL Queries ───────────────────────────────────────────

const LIST_TRANSCRIPTS_QUERY = `
  query Transcripts(
    $title: String
    $limit: Int
    $skip: Int
    $hostEmail: String
    $participantEmail: String
    $fromDate: DateTime
    $toDate: DateTime
  ) {
    transcripts(
      title: $title
      limit: $limit
      skip: $skip
      host_email: $hostEmail
      participant_email: $participantEmail
      fromDate: $fromDate
      toDate: $toDate
    ) {
      id
      title
      date
      dateString
      duration
      organizer_email
      participants
      transcript_url
      speakers {
        id
        name
      }
    }
  }
`;

const GET_SUMMARY_QUERY = `
  query Transcript($transcriptId: String!) {
    transcript(id: $transcriptId) {
      id
      title
      dateString
      duration
      organizer_email
      participants
      transcript_url
      speakers {
        id
        name
      }
      summary {
        keywords
        action_items
        outline
        shorthand_bullet
        overview
        bullet_gist
        gist
        short_summary
      }
      analytics {
        sentiments {
          positive_pct
          neutral_pct
          negative_pct
        }
        speakers {
          name
          duration
          word_count
          words_per_minute
          questions
        }
      }
    }
  }
`;

const GET_TRANSCRIPT_QUERY = `
  query Transcript($transcriptId: String!) {
    transcript(id: $transcriptId) {
      id
      title
      dateString
      duration
      speakers {
        id
        name
      }
      sentences {
        index
        speaker_name
        text
        start_time
        end_time
      }
    }
  }
`;

// ─── API Client ────────────────────────────────────────────────

async function firefliesRequest(apiKey, query, variables = {}) {
    const response = await fetch(FIREFLIES_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Fireflies API error (${response.status}): ${text}`);
    }

    const json = await response.json();

    if (json.errors) {
        throw new Error(`Fireflies GraphQL error: ${json.errors.map(e => e.message).join(', ')}`);
    }

    return json.data;
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeFirefliesTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for Fireflies.' };
    const apiKey = await configStore.getSecret(`fireflies_api_key_user_${userId}`);
    if (!apiKey) {
        return { error: 'Fireflies API key not configured. Add it in Admin → AI Config → API Keys.' };
    }

    if (toolName === 'fireflies_list_transcripts') {
        const variables = {
            limit: Math.min(Math.max(parseInt(args.limit) || 10, 1), 50),
            skip: parseInt(args.skip) || 0,
            title: args.title || null,
            hostEmail: args.hostEmail || null,
            participantEmail: args.participantEmail || null,
            fromDate: args.fromDate || null,
            toDate: args.toDate || null,
        };

        console.log(`[Fireflies] Listing transcripts`, variables);
        const data = await firefliesRequest(apiKey, LIST_TRANSCRIPTS_QUERY, variables);
        const transcripts = data.transcripts || [];

        return {
            results: transcripts.map(t => ({
                id: t.id,
                title: t.title,
                date: t.dateString || t.date,
                duration: t.duration ? `${t.duration} min` : 'unknown',
                organizer: t.organizer_email,
                participants: t.participants || [],
                speakers: (t.speakers || []).map(s => s.name),
                url: t.transcript_url,
            })),
            count: transcripts.length,
            message: transcripts.length === 0
                ? 'No transcripts found matching your criteria.'
                : `Found ${transcripts.length} transcript(s).`,
        };

    } else if (toolName === 'fireflies_get_summary') {
        const { transcriptId } = args;
        if (!transcriptId) return { error: 'transcriptId is required' };

        console.log(`[Fireflies] Getting summary for: ${transcriptId}`);
        const data = await firefliesRequest(apiKey, GET_SUMMARY_QUERY, { transcriptId });
        const t = data.transcript;

        if (!t) return { error: `Transcript not found: ${transcriptId}` };

        return {
            id: t.id,
            title: t.title,
            date: t.dateString,
            duration: t.duration ? `${t.duration} min` : 'unknown',
            organizer: t.organizer_email,
            participants: t.participants || [],
            speakers: (t.speakers || []).map(s => s.name),
            url: t.transcript_url,
            summary: t.summary || {},
            analytics: t.analytics || {},
        };

    } else if (toolName === 'fireflies_get_transcript') {
        const { transcriptId, speakerFilter } = args;
        if (!transcriptId) return { error: 'transcriptId is required' };

        console.log(`[Fireflies] Getting full transcript for: ${transcriptId}`);
        const data = await firefliesRequest(apiKey, GET_TRANSCRIPT_QUERY, { transcriptId });
        const t = data.transcript;

        if (!t) return { error: `Transcript not found: ${transcriptId}` };

        let sentences = t.sentences || [];
        if (speakerFilter) {
            const filter = speakerFilter.toLowerCase();
            sentences = sentences.filter(s =>
                s.speaker_name?.toLowerCase().includes(filter)
            );
        }

        // Truncate if very large
        const MAX_SENTENCES = 500;
        const truncated = sentences.length > MAX_SENTENCES;
        if (truncated) sentences = sentences.slice(0, MAX_SENTENCES);

        return {
            id: t.id,
            title: t.title,
            date: t.dateString,
            duration: t.duration ? `${t.duration} min` : 'unknown',
            speakers: (t.speakers || []).map(s => s.name),
            sentenceCount: sentences.length,
            truncated,
            sentences: sentences.map(s => ({
                speaker: s.speaker_name,
                text: s.text,
                time: s.start_time ? `${Math.floor(s.start_time / 60)}:${String(Math.floor(s.start_time % 60)).padStart(2, '0')}` : null,
            })),
        };

    } else {
        return { error: `Unknown Fireflies tool: ${toolName}` };
    }
}

function isFirefliesTool(toolName) {
    return ['fireflies_list_transcripts', 'fireflies_get_summary', 'fireflies_get_transcript'].includes(toolName);
}

module.exports = {
    FIREFLIES_TOOLS,
    executeFirefliesTool,
    isFirefliesTool,
};
