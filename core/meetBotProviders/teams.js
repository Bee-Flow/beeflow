/**
 * Microsoft Teams provider for the meeting bot.
 *
 * Joins as a guest via the Teams web client. Handles both teams.microsoft.com
 * and teams.live.com meeting URLs. No Microsoft account required for guest
 * join; credentials are optional and used only for meetings that disallow
 * anonymous participants.
 *
 * Teams frequently revises its UI, so the join flow uses multiple fallback
 * selectors (locale-aware) and a generic text search as a last resort.
 */

const fs = require('fs');
const path = require('path');

const shared = require('./shared');

const PROFILE_DIR = path.resolve(__dirname, '../../data/meet-bot-profile-teams');

const NAME_INPUT_SELECTORS = [
    'input[data-tid="prejoin-display-name-input"]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
    '#username',
];

const JOIN_SELECTORS = [
    'button[data-tid="prejoin-join-button"]',
    'button#prejoin-join-button',
    'button:has-text("Join now")',
    'button:has-text("Nu deelnemen")',
    'button:has-text("Jetzt teilnehmen")',
    'button:has-text("Rejoindre maintenant")',
    '[aria-label="Join now" i]',
];

const CONTINUE_ON_WEB_SELECTORS = [
    'button[data-tid="joinOnWeb"]',
    'a[data-tid="joinOnWeb"]',
    'button:has-text("Continue on this browser")',
    'button:has-text("Join on the web instead")',
    'a:has-text("Continue on this browser")',
    'a:has-text("Join on the web instead")',
];

const END_PHRASES = [
    'you left the meeting',
    'the meeting has ended',
    'call ended',
    'meeting ended',
    'u hebt de vergadering verlaten',
    'de vergadering is beëindigd',
    'besprechung beendet',
];

function detect(url) {
    return /teams\.microsoft\.com|teams\.live\.com/i.test(url);
}

function validateUrl(url) {
    return /teams\.(microsoft|live)\.com\/.*(meetup-join|meet)/i.test(url);
}

async function dismissOverlays(page) {
    const dismissLabels = [
        'Accept', 'Accept all', 'Got it', 'OK', 'Allow', 'Later', 'Skip',
        'Accepteren', 'Alles accepteren', 'Begrepen',
    ];
    for (const label of dismissLabels) {
        try {
            const btn = page.locator(`button:has-text("${label}")`);
            if (await btn.count() > 0) { await btn.first().click({ timeout: 1000 }); await page.waitForTimeout(300); }
        } catch (_) {}
    }
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        botName = 'Bee Flow - Meeting Assistant',
        maxDurationMs = 3 * 60 * 60 * 1000,
        onStatusChange = () => {},
        registerSession,
        isStopped,
    } = options;

    if (!meetLink.startsWith('http')) meetLink = 'https://' + meetLink;

    const audioPath = path.join(shared.recordingsDir, `teams-${sessionId}-${Date.now()}.webm`);
    let context = null;
    let ffmpegProcess = null;
    let recordingStartTime = null;

    try {
        onStatusChange('joining', { meetLink });

        const display = shared.ensureXvfb();
        if (display) process.env.DISPLAY = display;

        const sinkName = shared.ensurePulseAudio();
        if (!sinkName) throw new Error('PulseAudio setup failed — cannot record audio');

        context = await shared.launchBrowser(PROFILE_DIR, sinkName, display);
        registerSession?.({ context, ffmpegProcess: null });

        const page = context.pages()[0] || await context.newPage();

        console.log(`[MeetBot/Teams] Navigating to ${meetLink}`);
        await page.goto(meetLink, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        await dismissOverlays(page);

        // "Continue on this browser" / "Join on the web instead"
        for (const sel of CONTINUE_ON_WEB_SELECTORS) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) {
                    console.log(`[MeetBot/Teams] Clicked "continue in browser" (${sel})`);
                    await btn.first().click();
                    await page.waitForTimeout(3000);
                    break;
                }
            } catch (_) {}
        }

        await dismissOverlays(page);

        // Debug screenshot of prejoin screen
        try { await page.screenshot({ path: path.join(shared.recordingsDir, `teams-prejoin-${sessionId}.png`) }); } catch (_) {}

        // Fill name for guest join
        let nameEntered = false;
        for (const sel of NAME_INPUT_SELECTORS) {
            try {
                const input = page.locator(sel);
                if (await input.count() > 0) {
                    await input.first().click({ clickCount: 3 });
                    await input.first().fill(botName);
                    nameEntered = true;
                    console.log(`[MeetBot/Teams] Entered name via ${sel}`);
                    break;
                }
            } catch (_) {}
        }
        if (!nameEntered) console.log('[MeetBot/Teams] No name input found — may already be signed in');

        // Mute mic + camera (defensive — guest flow usually defaults to off already)
        for (const sel of [
            '[data-tid="toggle-video"][aria-pressed="true"]',
            '[data-tid="toggle-mute"][aria-pressed="true"]',
            'button[aria-label*="camera" i][aria-pressed="true"]',
            'button[aria-label*="microphone" i][aria-pressed="true"]',
        ]) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) { await btn.first().click({ timeout: 1000 }); await page.waitForTimeout(200); }
            } catch (_) {}
        }

        // Join now
        let joined = false;
        for (const selector of JOIN_SELECTORS) {
            try {
                const btn = page.locator(selector);
                if (await btn.count() > 0) {
                    await btn.first().click();
                    console.log(`[MeetBot/Teams] Clicked join (${selector})`);
                    joined = true;
                    break;
                }
            } catch (_) {}
        }
        if (!joined) {
            // Last-ditch text match
            joined = await page.evaluate(() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    const t = (btn.textContent || '').toLowerCase();
                    if (t.includes('join now') || t.includes('nu deelnemen') || t.includes('jetzt teilnehmen')) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });
        }
        if (!joined) {
            try { await page.screenshot({ path: path.join(shared.recordingsDir, `fail-teams-${sessionId}.png`) }); } catch (_) {}
            throw new Error('Could not find Teams join button');
        }

        console.log('[MeetBot/Teams] Waiting in lobby (up to 20s)...');
        await page.waitForTimeout(15000);

        onStatusChange('recording', { meetLink });
        ffmpegProcess = shared.startFFmpegRecorder(audioPath, sinkName);
        registerSession?.({ context, ffmpegProcess });
        recordingStartTime = Date.now();

        await shared.waitForMeetingEnd({
            maxDurationMs,
            isStopped,
            isEnded: async () => page.evaluate((phrases) => {
                const body = (document.body?.innerText || '').toLowerCase();
                return phrases.some(p => body.includes(p));
            }, END_PHRASES),
        });

    } finally {
        const durationSeconds = recordingStartTime ? Math.round((Date.now() - recordingStartTime) / 1000) : 0;
        console.log(`[MeetBot/Teams] Cleaning up ${sessionId} (${durationSeconds}s recorded)`);
        await shared.stopFFmpeg(ffmpegProcess);
        if (context) { try { await context.close(); } catch (_) {} }

        try {
            const stats = fs.statSync(audioPath);
            if (stats.size < 1000) console.warn(`[MeetBot/Teams] Recording too small (${stats.size} bytes)`);
            else console.log(`[MeetBot/Teams] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
        } catch (e) { console.error('[MeetBot/Teams] Could not verify recording:', e.message); }

        return { audioPath, durationSeconds };
    }
}

module.exports = {
    platform: 'teams',
    label: 'Microsoft Teams',
    detect,
    validateUrl,
    joinAndRecord,
    requiresCredentials: false,
};
