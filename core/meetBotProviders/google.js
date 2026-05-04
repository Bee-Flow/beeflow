/**
 * Google Meet provider for the meeting bot.
 *
 * Signs into a Google account (persistent profile) and joins a meet.google.com
 * URL as a full participant so the bot can hear audio piped through PulseAudio.
 * Falls back to in-page MediaRecorder if PulseAudio is unavailable.
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
    'left the meeting', 'meeting has ended',
    'de vergadering verlaten', 'vergadering is beëindigd',
    'removed from the meeting', 'call ended',
];

function detect(url) { return /meet\.google\.com/i.test(url); }
function validateUrl(url) { return /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url) || /meet\.google\.com/i.test(url); }

async function signIn(page, credentials) {
    if (!credentials?.email || !credentials?.password) return;
    console.log(`[MeetBot/Google] Signing in as ${credentials.email}`);
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    try {
        const emailInput = page.locator('input[type="email"]');
        if (await emailInput.count() > 0) {
            await emailInput.click();
            await emailInput.fill(credentials.email);
            const next = page.locator('#identifierNext button, #identifierNext');
            if (await next.count() > 0) await next.first().click();
            await page.waitForTimeout(3000);
        }
    } catch (e) { console.warn('[MeetBot/Google] Email entry failed:', e.message); }
    try {
        await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10000 });
        const pass = page.locator('input[type="password"]');
        if (await pass.count() > 0) {
            await pass.click();
            await pass.fill(credentials.password);
            const next = page.locator('#passwordNext button, #passwordNext');
            if (await next.count() > 0) await next.first().click();
            await page.waitForTimeout(5000);
        }
    } catch (e) { console.warn('[MeetBot/Google] Password entry failed:', e.message); }
    console.log(`[MeetBot/Google] Sign-in complete. URL: ${page.url()}`);
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        botName = 'Bee Flow - Meeting assistant',
        maxDurationMs = 3 * 60 * 60 * 1000,
        credentials = null,
        onStatusChange = () => {},
        registerSession,
        isStopped,
    } = options;

    if (!meetLink.startsWith('http')) meetLink = 'https://' + meetLink;

    const audioPath = path.join(shared.recordingsDir, `google-${sessionId}-${Date.now()}.webm`);
    let context = null;
    let audioCapture = null;
    let recordingStartTime = null;

    try {
        onStatusChange('joining', { meetLink });

        const display = shared.ensureXvfb();
        if (display) process.env.DISPLAY = display;

        const sinkName = shared.ensurePulseAudio();
        if (!sinkName) console.log('[MeetBot/Google] PulseAudio unavailable — will use page recorder');

        context = await shared.launchBrowser(PROFILE_DIR, sinkName, display);
        registerSession?.({ context, audioCapture: null });

        const page = context.pages()[0] || await context.newPage();

        // Inject RTCPeerConnection hook BEFORE any navigation so tracks are captured.
        await shared.preparePageAudioHook(page);

        if (credentials) await signIn(page, credentials);

        console.log(`[MeetBot/Google] Navigating to ${meetLink}`);
        await page.goto(meetLink, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Dismiss cookie/terms dialogs
        try {
            const gotIt = page.locator('button[jsname="j6LnYe"], button[aria-label="Got it"]');
            if (await gotIt.count() > 0) { await gotIt.first().click(); await page.waitForTimeout(1000); }
        } catch (_) {}
        try {
            const dismiss = page.locator('button:has-text("Niet nu"), button:has-text("Not now"), button:has-text("Dismiss")');
            if (await dismiss.count() > 0) { await dismiss.first().click(); await page.waitForTimeout(500); }
        } catch (_) {}

        // Enter bot name (guest users)
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
        for (const sel of JOIN_SELECTORS) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) { await btn.first().click(); joined = true; break; }
            } catch (_) {}
        }
        if (!joined) {
            joined = await page.evaluate(() => {
                for (const btn of document.querySelectorAll('button')) {
                    const t = (btn.textContent || '').toLowerCase();
                    if (t.includes('join') || t.includes('ask to join') || t.includes('deelnemen') || t.includes('deelnameverzoek')) {
                        btn.click(); return true;
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
        audioCapture = await shared.startAudioCapture(page, audioPath, sinkName);
        registerSession?.({ context, audioCapture });
        recordingStartTime = Date.now();
        console.log(`[MeetBot/Google] Recording started (mode: ${audioCapture.mode})`);

        await shared.waitForMeetingEnd({
            maxDurationMs, isStopped,
            isEnded: () => page.evaluate((phrases) => {
                const body = (document.body?.innerText || '').toLowerCase();
                return phrases.some(p => body.includes(p));
            }, END_PHRASES),
        });

    } finally {
        const durationSeconds = recordingStartTime ? Math.round((Date.now() - recordingStartTime) / 1000) : 0;
        console.log(`[MeetBot/Google] Cleaning up ${sessionId} (${durationSeconds}s recorded)`);
        if (audioCapture) await audioCapture.stop();
        if (context) { try { await context.close(); } catch (_) {} }
        let finalAudioPath = '';
        try {
            const stats = fs.statSync(audioPath);
            if (stats.size < 1000) console.warn(`[MeetBot/Google] Recording too small (${stats.size} bytes)`);
            else console.log(`[MeetBot/Google] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
            finalAudioPath = audioPath;
        } catch (_) {
            console.warn('[MeetBot/Google] No recording file was produced');
        }
        return { audioPath: finalAudioPath, durationSeconds };
    }
}

module.exports = { platform: 'google', label: 'Google Meet', detect, validateUrl, joinAndRecord, requiresCredentials: true };
