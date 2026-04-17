/**
 * Google Meet provider for the meeting bot.
 *
 * Signs into a Google account (persistent profile) and joins a meet.google.com
 * URL as a full participant so the bot can hear audio piped through PulseAudio.
 */

const fs = require('fs');
const path = require('path');

const shared = require('./shared');

const PROFILE_DIR = path.resolve(__dirname, '../../data/meet-bot-profile-google');

const JOIN_SELECTORS = [
    'button[jsname="Qx7uuf"]',
    'button[data-mdc-dialog-action="join"]',
    '[aria-label="Ask to join"]',
    '[aria-label="Join now"]',
    '[aria-label="Deelnemen"]',
    '[aria-label="Nu deelnemen"]',
    '[aria-label="Deelnameverzoek"]',
    'button:has-text("Deelnameverzoek")',
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("Nu deelnemen")',
];

const END_PHRASES = [
    'left the meeting',
    'meeting has ended',
    'de vergadering verlaten',
    'vergadering is beëindigd',
    'removed from the meeting',
    'call ended',
];

function detect(url) {
    return /meet\.google\.com/i.test(url);
}

function validateUrl(url) {
    return /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url) || /meet\.google\.com/i.test(url);
}

async function signIn(page, credentials, sessionId) {
    if (!credentials?.email || !credentials?.password) return;
    console.log(`[MeetBot/Google] Signing in as ${credentials.email}`);

    await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    try {
        const emailInput = page.locator('input[type="email"]');
        if (await emailInput.count() > 0) {
            await emailInput.click();
            await emailInput.fill(credentials.email);
            const nextBtn = page.locator('#identifierNext button, #identifierNext');
            if (await nextBtn.count() > 0) await nextBtn.first().click();
            await page.waitForTimeout(3000);
        }
    } catch (e) { console.warn('[MeetBot/Google] Email entry failed:', e.message); }

    try {
        await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10000 });
        const passInput = page.locator('input[type="password"]');
        if (await passInput.count() > 0) {
            await passInput.click();
            await passInput.fill(credentials.password);
            const nextBtn = page.locator('#passwordNext button, #passwordNext');
            if (await nextBtn.count() > 0) await nextBtn.first().click();
            await page.waitForTimeout(5000);
        }
    } catch (e) { console.warn('[MeetBot/Google] Password entry failed:', e.message); }

    console.log(`[MeetBot/Google] Sign-in complete. Current URL: ${page.url()}`);
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        botName = 'Bee Flow - Meeting Assistant',
        maxDurationMs = 3 * 60 * 60 * 1000,
        credentials = null,
        onStatusChange = () => {},
        registerSession,
        isStopped,
    } = options;

    if (!meetLink.startsWith('http')) meetLink = 'https://' + meetLink;

    const audioPath = path.join(shared.recordingsDir, `google-${sessionId}-${Date.now()}.webm`);
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

        if (credentials) await signIn(page, credentials, sessionId);

        console.log(`[MeetBot/Google] Navigating to ${meetLink}`);
        await page.goto(meetLink, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Dismiss cookie/terms dialogs
        try {
            const gotItBtn = page.locator('button[jsname="j6LnYe"], button[aria-label="Got it"]');
            if (await gotItBtn.count() > 0) { await gotItBtn.first().click(); await page.waitForTimeout(1000); }
        } catch (_) {}

        // Dismiss notification popup
        try {
            const dismissBtn = page.locator('button:has-text("Niet nu"), button:has-text("Not now"), button:has-text("Dismiss")');
            if (await dismissBtn.count() > 0) { await dismissBtn.first().click(); await page.waitForTimeout(500); }
        } catch (_) {}

        // Enter bot name (for guest users)
        try {
            const nameInput = page.locator('input[aria-label="Your name"], input[placeholder="Your name"]');
            if (await nameInput.count() > 0) {
                await nameInput.first().click({ clickCount: 3 });
                await nameInput.first().fill(botName);
                await page.waitForTimeout(500);
            }
        } catch (_) {}

        // Turn off camera/mic
        for (const sel of [
            '[data-is-muted="false"][aria-label*="camera" i], [aria-label*="Turn off camera" i]',
            '[data-is-muted="false"][aria-label*="microphone" i], [aria-label*="Turn off microphone" i]',
        ]) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) { await btn.first().click(); await page.waitForTimeout(300); }
            } catch (_) {}
        }

        let joined = false;
        for (const selector of JOIN_SELECTORS) {
            try {
                const btn = page.locator(selector);
                if (await btn.count() > 0) { await btn.first().click(); joined = true; break; }
            } catch (_) {}
        }
        if (!joined) {
            joined = await page.evaluate(() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    const text = (btn.textContent || '').toLowerCase();
                    if (text.includes('join') || text.includes('ask to join') ||
                        text.includes('deelnemen') || text.includes('deelnameverzoek')) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });
        }
        if (!joined) {
            try { await page.screenshot({ path: path.join(shared.recordingsDir, `fail-google-${sessionId}.png`) }); } catch (_) {}
            throw new Error('Could not find join button on Google Meet page');
        }

        console.log('[MeetBot/Google] Waiting to be admitted...');
        await page.waitForTimeout(8000);

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
        console.log(`[MeetBot/Google] Cleaning up ${sessionId} (${durationSeconds}s recorded)`);
        await shared.stopFFmpeg(ffmpegProcess);
        if (context) { try { await context.close(); } catch (_) {} }

        try {
            const stats = fs.statSync(audioPath);
            if (stats.size < 1000) console.warn(`[MeetBot/Google] Recording too small (${stats.size} bytes)`);
            else console.log(`[MeetBot/Google] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
        } catch (e) { console.error('[MeetBot/Google] Could not verify recording:', e.message); }

        return { audioPath, durationSeconds };
    }
}

module.exports = {
    platform: 'google',
    label: 'Google Meet',
    detect,
    validateUrl,
    joinAndRecord,
    requiresCredentials: true,
};
