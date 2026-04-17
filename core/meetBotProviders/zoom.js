/**
 * Zoom provider for the meeting bot.
 *
 * Joins via the Zoom web client as a guest. URLs like
 * https://zoom.us/j/<id>?pwd=<pwd> and https://<tenant>.zoom.us/j/<id> are
 * accepted. The bot rewrites the URL to the explicit /wc/join/<id> web-client
 * path so Zoom doesn't try to launch a desktop app, and appends the password
 * if present so the user isn't prompted a second time.
 *
 * Known limits: Zoom sometimes requires a CAPTCHA before a guest can join.
 * If that happens the bot will fail — log the debug screenshot and, if the
 * host enables "Require authentication", a paid Zoom account will need to
 * be plumbed through credentials (not implemented yet).
 */

const fs = require('fs');
const path = require('path');

const shared = require('./shared');

const PROFILE_DIR = path.resolve(__dirname, '../../data/meet-bot-profile-zoom');

const NAME_SELECTORS = [
    '#input-for-name',
    '#inputname',
    'input[aria-label*="name" i]',
    'input[placeholder*="name" i]',
];

const PASSWORD_SELECTORS = [
    '#input-for-pwd',
    '#inputpasscode',
    'input[type="password"]',
];

const JOIN_SELECTORS = [
    'button.preview-join-button',
    'button#joinBtn',
    'button[aria-label*="Join" i]',
    '.joinWindowBtn',
    'button:has-text("Join")',
];

const END_PHRASES = [
    'this meeting has been ended',
    'the meeting has ended',
    'you have been removed',
    'you left the meeting',
    'host has ended this meeting',
    'de vergadering is beëindigd',
];

function detect(url) {
    return /zoom\.us\/(j|wc|my)\//i.test(url) || /zoom\.us/i.test(url);
}

function validateUrl(url) {
    return /zoom\.us\/(j|wc|my)\/\d+/i.test(url);
}

/**
 * Rewrite a normal /j/ URL to the web-client /wc/join/ path. Preserves pwd
 * query param if present. Returns original URL if no meeting id is found.
 */
function toWebClientUrl(url) {
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        // /j/123456789 or /my/personal-link
        const match = u.pathname.match(/\/j\/(\d+)/i);
        if (!match) return u.toString();
        const meetingId = match[1];
        const pwd = u.searchParams.get('pwd');
        const base = `https://${u.host}/wc/join/${meetingId}`;
        return pwd ? `${base}?pwd=${encodeURIComponent(pwd)}` : base;
    } catch (_) {
        return url;
    }
}

async function dismissOverlays(page) {
    const labels = ['I Agree', 'Accept Cookies', 'Accept All', 'Accept', 'Got it', 'OK', 'Close'];
    for (const label of labels) {
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

    const targetUrl = toWebClientUrl(meetLink);
    console.log(`[MeetBot/Zoom] Using web-client URL: ${targetUrl}`);

    const audioPath = path.join(shared.recordingsDir, `zoom-${sessionId}-${Date.now()}.webm`);
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

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        await dismissOverlays(page);

        // If Zoom is showing the "Launch Meeting" bounce page, click "Join from Your Browser"
        try {
            const joinFromBrowser = page.locator(
                'a:has-text("Join from Your Browser"), a:has-text("Launch from the Web"), button:has-text("Join from Your Browser")'
            );
            if (await joinFromBrowser.count() > 0) {
                console.log('[MeetBot/Zoom] Clicking "Join from Your Browser"');
                await joinFromBrowser.first().click();
                await page.waitForTimeout(3000);
            }
        } catch (_) {}

        try { await page.screenshot({ path: path.join(shared.recordingsDir, `zoom-prejoin-${sessionId}.png`) }); } catch (_) {}

        // Fill name
        for (const sel of NAME_SELECTORS) {
            try {
                const input = page.locator(sel);
                if (await input.count() > 0) {
                    await input.first().click({ clickCount: 3 });
                    await input.first().fill(botName);
                    console.log(`[MeetBot/Zoom] Entered name via ${sel}`);
                    break;
                }
            } catch (_) {}
        }

        // Fill password if prompted (only if the wc URL didn't include pwd)
        try {
            const u = new URL(targetUrl);
            const pwd = u.searchParams.get('pwd');
            if (!pwd) {
                for (const sel of PASSWORD_SELECTORS) {
                    try {
                        const input = page.locator(sel);
                        if (await input.count() > 0 && await input.first().isVisible()) {
                            console.log(`[MeetBot/Zoom] Password prompt detected (${sel}) — no password configured, skipping`);
                            break;
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}

        // Click Join
        let joined = false;
        for (const sel of JOIN_SELECTORS) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) {
                    await btn.first().click();
                    console.log(`[MeetBot/Zoom] Clicked join (${sel})`);
                    joined = true;
                    break;
                }
            } catch (_) {}
        }
        if (!joined) {
            joined = await page.evaluate(() => {
                const btns = document.querySelectorAll('button, a');
                for (const btn of btns) {
                    const t = (btn.textContent || '').trim().toLowerCase();
                    if (t === 'join' || t === 'join meeting') { btn.click(); return true; }
                }
                return false;
            });
        }
        if (!joined) {
            try { await page.screenshot({ path: path.join(shared.recordingsDir, `fail-zoom-${sessionId}.png`) }); } catch (_) {}
            throw new Error('Could not find Zoom join button (CAPTCHA may be required)');
        }

        console.log('[MeetBot/Zoom] Waiting in waiting-room (up to 20s)...');
        await page.waitForTimeout(15000);

        // Dismiss "Join with Computer Audio" dialog — we're recording the tab, mic not needed
        try {
            const computerAudio = page.locator(
                'button:has-text("Join Audio by Computer"), button:has-text("Join with Computer Audio")'
            );
            if (await computerAudio.count() > 0) {
                await computerAudio.first().click();
                console.log('[MeetBot/Zoom] Clicked "Join Audio by Computer"');
                await page.waitForTimeout(1000);
            }
        } catch (_) {}

        // Make sure mic is muted (Zoom mutes guests by default but guard anyway)
        try {
            const unmutedMic = page.locator('button[aria-label*="mute" i][aria-label*="currently unmuted" i]');
            if (await unmutedMic.count() > 0) { await unmutedMic.first().click(); }
        } catch (_) {}

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
        console.log(`[MeetBot/Zoom] Cleaning up ${sessionId} (${durationSeconds}s recorded)`);
        await shared.stopFFmpeg(ffmpegProcess);
        if (context) { try { await context.close(); } catch (_) {} }

        try {
            const stats = fs.statSync(audioPath);
            if (stats.size < 1000) console.warn(`[MeetBot/Zoom] Recording too small (${stats.size} bytes)`);
            else console.log(`[MeetBot/Zoom] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
        } catch (e) { console.error('[MeetBot/Zoom] Could not verify recording:', e.message); }

        return { audioPath, durationSeconds };
    }
}

module.exports = {
    platform: 'zoom',
    label: 'Zoom',
    detect,
    validateUrl,
    joinAndRecord,
    requiresCredentials: false,
};
