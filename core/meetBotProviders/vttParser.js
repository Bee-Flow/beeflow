/**
 * WebVTT parser for Microsoft Teams transcripts.
 *
 * Teams' Graph API returns transcripts in WebVTT with <v Speaker Name>…</v>
 * tags. We convert those cues into the pipeline's segment shape:
 *   { speaker, start, end, text }  — times in seconds.
 *
 * Spec references:
 *   - https://www.w3.org/TR/webvtt1/
 *   - https://learn.microsoft.com/en-us/graph/api/calltranscript-get
 */

function parseTimestamp(ts) {
    // Supports HH:MM:SS.mmm and MM:SS.mmm
    const m = ts.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})$/);
    if (!m) return null;
    const hours = m[1] ? parseInt(m[1], 10) : 0;
    const minutes = parseInt(m[2], 10);
    const seconds = parseInt(m[3], 10);
    const ms = parseInt(m[4].padEnd(3, '0').slice(0, 3), 10);
    return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function stripVoiceTag(text) {
    // <v Speaker Name>Body</v>  →  { speaker: 'Speaker Name', body: 'Body' }
    // <v.loud Speaker>Body</v>  also valid per spec (classes ignored)
    // No tag at all                →  { speaker: null, body: text }
    const m = text.match(/^<v(?:\.[^\s>]+)*\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/);
    if (m) return { speaker: m[1].trim(), body: m[2].trim() };
    return { speaker: null, body: text.trim() };
}

function parseToSegments(vttText) {
    if (typeof vttText !== 'string' || !vttText.trim()) return [];

    // Normalise line endings and drop a leading "WEBVTT" header plus any
    // metadata block that follows (header ends at the first blank line).
    const normalised = vttText.replace(/\r\n?/g, '\n');
    const lines = normalised.split('\n');

    // Find end of header (first blank line after WEBVTT)
    let i = 0;
    if (lines[0]?.startsWith('WEBVTT')) {
        i = 1;
        while (i < lines.length && lines[i].trim() !== '') i++;
        i++; // skip the blank
    }

    const segments = [];
    while (i < lines.length) {
        // Skip blank lines
        while (i < lines.length && lines[i].trim() === '') i++;
        if (i >= lines.length) break;

        // Optional cue identifier line (not a timestamp) — skip it.
        if (!lines[i].includes('-->')) {
            i++;
            if (i >= lines.length) break;
        }

        const timingLine = lines[i];
        if (!timingLine || !timingLine.includes('-->')) {
            i++;
            continue;
        }
        const [startStr, restAfterArrow] = timingLine.split('-->');
        // Settings (alignment, region, etc.) may follow the end timestamp — drop them.
        const endStr = (restAfterArrow || '').trim().split(/\s+/)[0];
        const start = parseTimestamp((startStr || '').trim());
        const end = parseTimestamp(endStr);
        i++;

        // Collect cue payload until blank line / EOF
        const payload = [];
        while (i < lines.length && lines[i].trim() !== '') {
            payload.push(lines[i]);
            i++;
        }
        if (start == null || end == null) continue;

        const joined = payload.join(' ').trim();
        if (!joined) continue;

        const { speaker, body } = stripVoiceTag(joined);
        if (!body) continue;

        segments.push({
            speaker: speaker || 'Unknown',
            start,
            end,
            text: body,
        });
    }

    return mergeConsecutive(segments);
}

/**
 * Collapse adjacent cues from the same speaker into one segment. Teams often
 * emits many short cues for a single utterance.
 */
function mergeConsecutive(segments) {
    const out = [];
    for (const seg of segments) {
        const last = out[out.length - 1];
        if (last && last.speaker === seg.speaker && seg.start - last.end < 2) {
            last.end = seg.end;
            last.text = `${last.text} ${seg.text}`.trim();
        } else {
            out.push({ ...seg });
        }
    }
    return out;
}

module.exports = {
    parseToSegments,
    // Exposed for tests
    parseTimestamp,
    stripVoiceTag,
    mergeConsecutive,
};
