/**
 * Zoom provider for the meeting bot.
 *
 * Joins via the Zoom web client as a guest. Rewrites /j/ URLs to the
 * explicit /wc/join/ path so Zoom doesn't launch a desktop app. Falls back
 * to page MediaRecorder when PulseAudio is unavailable.
 *
 * Known limit: Zoom may require a CAPTCHA before guest join. If that happens
 * the bot will fail with a clear error — check the zoom-prejoin-*.png debug
 * screenshot. A paid Zoom account credential path is not yet implemented.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');

const PROFILE_DIR = path.resolve(__dirname, '../../data/meet-bot-profile-zoom');

const NAME_SELECTORS  = ['#input-for-name', '#inputname', 'input[aria-label*="name" i]', 'input[placeholder*="name" i]'];
const JOIN_SELECTORS  = ['button.preview-join-button', 'button#joinBtn', 'button[aria-label*="Join" i]', '.joinWindowBtn', 'button:has-text("Join")'];
const END_PHRASES     = ['this meeting has been ended', 'the meeting has ended', 'you have been removed', 'you left the meeting', 'host has ended this meeting', 'de vergadering is beëindigd'];
const WEB_CLIENT_SELECTORS = ['a:has-text("Join from Your Browser")', 'a:has-text("Launch from the Web")', 'button:has-text("Join from Your Browser")'];

function detect(url)      { return /zoom\.us\/(j|wc|my)\//i.test(url) || /zoom\.us/i.test(url); }
function validateUrl(url) { return /zoom\.us\/(j|wc|my)\/\d+/i.test(url); }

function toWebClientUrl(url) {
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        const match = u.pathname.match(/\/j\/(\d+)/i);
        if (!match) return u.toString();
        const pwd = u.searchParams.get('pwd');
        const base = `https://${u.host}/wc/join/${match[1]}`;
        return pwd ? `${base}?pwd=${encodeURIComponent(pwd)}` : base;
    } catch (_) { return url; }
}

async function dismissOverlays(page) {
    for (const label of ['I Agree', 'Accept Cookies', 'Accept All', 'Accept', 'Got it', 'OK', 'Close']) {
        try {
            const btn = page.locator(`button:has-text("${label}")`);
            if (await btn.count() > 0) { await btn.first().click({ timeout: 1000 }); await page.waitForTimeout(300); }
        } catch (_) {}
    }
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        botName = 'Bee Flow - Meeting assistant',
        maxDurationMs = 3 * 60 * 60 * 1000,
        onStatusChange = () => {},
        registerSession,
        isStopped,
    } = options;

    const targetUrl = toWebClientUrl(meetLink);
    console.log(`[MeetBot/Zoom] Using web-client URL: ${targetUrl}`);

    const audioPath = path.join(shared.recordingsDir, `zoom-${sessionId}-${Date.now()}.webm`);
    let context = null;
    let audioCapture = null;
    let recordingStartTime = null;

    try {
        onStatusChange('joining', { meetLink });

        const display = shared.ensureXvfb();
        if (display) process.env.DISPLAY = display;

        const sinkName = shared.ensurePulseAudio();
        if (!sinkName) console.log('[MeetBot/Zoom] PulseAudio unavailable — will use page recorder');

        context = await shared.launchBrowser(PROFILE_DIR, sinkName, display);
        registerSession?.({ context, audioCapture: null });

        const page = context.pages()[0] || await context.newPage();

        // Inject RTC hook before navigation.
        await shared.preparePageAudioHook(page);

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);
        await dismissOverlays(page);

        // "Join from Your Browser" link on the launch-redirect page
        try {
            const joinFromBrowser = page.locator(WEB_CLIENT_SELECTORS.join(', '));
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

        // Click Join
        let joined = false;
        for (const sel of JOIN_SELECTORS) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) { await btn.first().click(); console.log(`[MeetBot/Zoom] Clicked join (${sel})`); joined = true; break; }
            } catch (_) {}
        }
        if (!joined) {
            joined = await page.evaluate(() => {
                for (const btn of document.querySelectorAll('button, a')) {
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

        // "Join Audio by Computer" dialog
        try {
            const computerAudio = page.locator('button:has-text("Join Audio by Computer"), button:has-text("Join with Computer Audio")');
            if (await computerAudio.count() > 0) { await computerAudio.first().click(); await page.waitForTimeout(1000); }
        } catch (_) {}

        onStatusChange('recording', { meetLink });
        audioCapture = await shared.startAudioCapture(page, audioPath, sinkName);
        registerSession?.({ context, audioCapture });
        recordingStartTime = Date.now();
        console.log(`[MeetBot/Zoom] Recording started (mode: ${audioCapture.mode})`);

        await shared.waitForMeetingEnd({
            maxDurationMs, isStopped,
            isEnded: () => page.evaluate((phrases) => {
                const body = (document.body?.innerText || '').toLowerCase();
                return phrases.some(p => body.includes(p));
            }, END_PHRASES),
        });

    } finally {
        const durationSeconds = recordingStartTime ? Math.round((Date.now() - recordingStartTime) / 1000) : 0;
        console.log(`[MeetBot/Zoom] Cleaning up ${sessionId} (${durationSeconds}s recorded)`);
        if (audioCapture) await audioCapture.stop();
        if (context) { try { await context.close(); } catch (_) {} }
        let finalAudioPath = '';
        try {
            const stats = fs.statSync(audioPath);
            if (stats.size < 1000) console.warn(`[MeetBot/Zoom] Recording too small (${stats.size} bytes)`);
            else console.log(`[MeetBot/Zoom] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
            finalAudioPath = audioPath;
        } catch (_) {
            console.warn('[MeetBot/Zoom] No recording file was produced');
        }
        return { audioPath: finalAudioPath, durationSeconds };
    }
}

module.exports = { platform: 'zoom', label: 'Zoom', detect, validateUrl, joinAndRecord, requiresCredentials: false };
