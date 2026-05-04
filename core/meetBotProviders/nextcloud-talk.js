/**
 * Nextcloud Talk provider for the meeting bot.
 *
 * Joins a Talk room via Playwright (matches the Google Meet provider shape)
 * and captures audio via the shared PulseAudio/MediaRecorder pipeline. Public
 * rooms are joined as a guest using `botName` as the display name. Private
 * rooms work when an admin has configured `nextcloud_bot_user` /
 * `nextcloud_bot_password` in the config store — those creds drive a /login
 * sign-in before navigation.
 *
 * The Talk room token is extracted from the URL and surfaced via
 * `providerMeta.roomToken` so the route handler can post the meeting summary
 * back to the room when the pipeline finishes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const configStore = require('../../stores/configStore');

const PROFILE_DIR = path.resolve(__dirname, '../../data/meet-bot-profile-nextcloud');

// Tokens are short alphanumeric strings (typically 8 chars). Matching loosely
// here; the platform-detection layer above already filters out Google/Teams/
// Zoom URLs before this provider sees them.
const TOKEN_RE = /(?:\/index\.php)?\/call\/([a-zA-Z0-9]+)(?:[/?#]|$)/;

const END_PHRASES = [
    'call has ended',
    'the call has ended',
    'this call has ended',
    'oproep is beëindigd',
    'de oproep is beëindigd',
    'gesprek is beëindigd',
];

function detect(url) {
    if (!url) return false;
    // Bail out for known non-Nextcloud hosts so we don't accidentally claim
    // them when the URL happens to contain "/call/".
    if (/meet\.google\.com|teams\.(microsoft|live)\.com|zoom\.us/i.test(url)) return false;
    return TOKEN_RE.test(url);
}

function validateUrl(url) {
    return detect(url);
}

function extractToken(url) {
    const m = (url || '').match(TOKEN_RE);
    return m ? m[1] : null;
}

async function loadBotCredentials() {
    const username = await configStore.getSecret('nextcloud_bot_user').catch(() => null);
    const password = await configStore.getSecret('nextcloud_bot_password').catch(() => null);
    if (username && password) return { username, password };
    return null;
}

async function signIn(page, baseUrl, credentials) {
    if (!credentials?.username || !credentials?.password) return;
    console.log(`[MeetBot/Nextcloud] Signing in as ${credentials.username}`);
    try {
        await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        const userInput = page.locator('input[name="user"], input#user');
        if (await userInput.count() > 0) {
            await userInput.first().click();
            await userInput.first().fill(credentials.username);
        }
        const passInput = page.locator('input[name="password"], input#password');
        if (await passInput.count() > 0) {
            await passInput.first().click();
            await passInput.first().fill(credentials.password);
        }
        const submit = page.locator('button[type="submit"], input[type="submit"]');
        if (await submit.count() > 0) {
            await submit.first().click();
        }
        await page.waitForTimeout(4000);
        console.log(`[MeetBot/Nextcloud] Sign-in complete. URL: ${page.url()}`);
    } catch (e) {
        console.warn('[MeetBot/Nextcloud] Sign-in failed:', e.message);
    }
}

function originOf(url) {
    try { return new URL(url.startsWith('http') ? url : 'https://' + url).origin; }
    catch { return null; }
}

async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        botName = 'Bee Flow - Meeting assistant',
        maxDurationMs = 3 * 60 * 60 * 1000,
        onStatusChange = () => {},
        registerSession,
        isStopped,
    } = options;

    if (!meetLink.startsWith('http')) meetLink = 'https://' + meetLink;
    const roomToken = extractToken(meetLink);
    const baseUrl = originOf(meetLink);

    const audioPath = path.join(shared.recordingsDir, `nextcloud-${sessionId}-${Date.now()}.webm`);
    let context = null;
    let audioCapture = null;
    let recordingStartTime = null;

    try {
        onStatusChange('joining', { meetLink });

        const display = shared.ensureXvfb();
        if (display) process.env.DISPLAY = display;

        const sinkName = shared.ensurePulseAudio();
        if (!sinkName) console.log('[MeetBot/Nextcloud] PulseAudio unavailable — will use page recorder');

        context = await shared.launchBrowser(PROFILE_DIR, sinkName, display);
        registerSession?.({ context, audioCapture: null });

        const page = context.pages()[0] || await context.newPage();

        // Inject RTCPeerConnection hook BEFORE navigation so tracks are captured.
        await shared.preparePageAudioHook(page);

        const credentials = await loadBotCredentials();
        if (credentials && baseUrl) {
            await signIn(page, baseUrl, credentials);
        }

        console.log(`[MeetBot/Nextcloud] Navigating to ${meetLink}`);
        // Nextcloud Talk keeps WebSocket signaling open after load, so
        // 'networkidle' never resolves. Wait for the DOM only and then for
        // the device-check dialog (or the in-call top bar) to appear.
        await page.goto(meetLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try {
            await page.locator('[role="dialog"], .top-bar, .talkRoom').first()
                .waitFor({ state: 'visible', timeout: 20000 });
            console.log('[MeetBot/Nextcloud] Talk room loaded');
        } catch (_) {
            console.warn('[MeetBot/Nextcloud] Timed out waiting for Talk room UI; continuing anyway');
        }

        // Talk caches the last guest display name in localStorage; that
        // overrides anything we type. Wipe it so the field starts empty.
        console.log('[MeetBot/Nextcloud] Clearing cached display name');
        try {
            await page.evaluate(() => {
                try {
                    Object.keys(localStorage).forEach(k => {
                        if (/guest|display.?name|nick/i.test(k)) localStorage.removeItem(k);
                    });
                } catch (_) {}
            });
        } catch (_) {}

        // Dismiss first-run / cookie dialogs (only if present — no settle wait)
        try {
            const dismiss = page.locator('button:has-text("Got it"), button:has-text("Begrepen"), button[aria-label*="Close" i]');
            if (await dismiss.count() > 0) { await dismiss.first().click(); }
        } catch (_) {}

        // Joining a /call/<token> URL auto-opens the "Check devices" dialog
        // (verified via Playwright codegen). The flow is:
        //   1. Fill the guest display name (skipped when signed in).
        //   2. Click the dialog's Join call button.
        // Locators come straight from codegen — getByRole/getByLabel resolve
        // through Vue's accessible-name machinery, which is what makes .fill()
        // actually stick on Talk's custom input-field component.

        const checkDevicesDialog = page.getByRole('dialog', { name: /Check devices|Apparaten controleren/i });

        // Detect once whether the device-check dialog appeared. Signed-in
        // users skip it entirely, so we shouldn't sit on long waitFor budgets
        // looking for elements that don't exist.
        let dialogPresent = false;
        try {
            await checkDevicesDialog.waitFor({ state: 'visible', timeout: 1500 });
            dialogPresent = true;
        } catch (_) {}

        if (dialogPresent) {
            // Step 1 — fill the guest display name. Press Enter to commit
            // the value to Vue's form state (verified via codegen).
            try {
                const nameInput = page.getByRole('textbox', { name: /Display name|Weergavenaam/i });
                await nameInput.waitFor({ state: 'visible', timeout: 1500 });
                await nameInput.fill(botName);
                await nameInput.press('Enter');
                console.log('[MeetBot/Nextcloud] Filled display name');
            } catch (_) { /* signed in — no field */ }

            // Step 2 — mute mic and camera in the dialog (idempotent, fast).
            for (const name of [/Mute audio/i, /Disable video/i, /Microfoon dempen/i, /Video uitschakelen/i]) {
                try {
                    await checkDevicesDialog.getByRole('button', { name }).first()
                        .click({ timeout: 500 });
                } catch (_) {}
            }

            // Step 3 — click the dialog's Join call button.
            try {
                await checkDevicesDialog.getByLabel('Join call').click({ timeout: 5000 });
                console.log('[MeetBot/Nextcloud] Clicked Join call in dialog');
            } catch (e) {
                try {
                    const screenshotPath = path.join(shared.recordingsDir, `fail-nextcloud-${sessionId}-dialog.png`);
                    await page.screenshot({ path: screenshotPath });
                    console.warn(`[MeetBot/Nextcloud] Screenshot of failure: ${screenshotPath}`);
                } catch (_) {}
                throw new Error(`Could not click dialog Join call: ${e.message}`);
            }
        } else {
            // Signed-in fast-path: click the top-bar Join call button directly.
            try {
                await page.getByRole('button', { name: /^Join call|^Start call|^Deelnemen aan oproep|^Oproep starten/i })
                    .first().click({ timeout: 5000 });
                console.log('[MeetBot/Nextcloud] Clicked top-bar Join call');
            } catch (e) {
                try {
                    const screenshotPath = path.join(shared.recordingsDir, `fail-nextcloud-${sessionId}-topbar.png`);
                    await page.screenshot({ path: screenshotPath });
                } catch (_) {}
                throw new Error(`Could not click Join call: ${e.message}`);
            }
        }

        console.log('[MeetBot/Nextcloud] Waiting for call media...');
        await page.waitForTimeout(2000);

        onStatusChange('recording', { meetLink });
        audioCapture = await shared.startAudioCapture(page, audioPath, sinkName);
        registerSession?.({ context, audioCapture });
        recordingStartTime = Date.now();
        console.log(`[MeetBot/Nextcloud] Recording started (mode: ${audioCapture.mode})`);

        // End-of-call: detect via DOM. Either an explicit end-of-call phrase,
        // or the leave-call button disappearing (call left/ended).
        await shared.waitForMeetingEnd({
            maxDurationMs,
            isStopped,
            isEnded: () => page.evaluate((phrases) => {
                const body = (document.body?.innerText || '').toLowerCase();
                if (phrases.some(p => body.includes(p))) return true;
                const leave = document.querySelector(
                    'button[aria-label*="Leave call" i], button[aria-label*="Oproep verlaten" i], ' +
                    'button.top-bar__button--call-end'
                );
                return !leave;
            }, END_PHRASES),
        });

    } finally {
        const durationSeconds = recordingStartTime ? Math.round((Date.now() - recordingStartTime) / 1000) : 0;
        console.log(`[MeetBot/Nextcloud] Cleaning up ${sessionId} (${durationSeconds}s recorded)`);
        if (audioCapture) await audioCapture.stop();
        if (context) { try { await context.close(); } catch (_) {} }
        let finalAudioPath = '';
        try {
            const stats = fs.statSync(audioPath);
            if (stats.size < 1000) console.warn(`[MeetBot/Nextcloud] Recording too small (${stats.size} bytes)`);
            else console.log(`[MeetBot/Nextcloud] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
            finalAudioPath = audioPath;
        } catch (_) {
            console.warn('[MeetBot/Nextcloud] No recording file was produced');
        }
        return {
            audioPath: finalAudioPath,
            durationSeconds,
            providerMeta: { roomToken, baseUrl },
        };
    }
}

module.exports = {
    platform: 'nextcloud-talk',
    label: 'Nextcloud Talk',
    detect,
    validateUrl,
    joinAndRecord,
    requiresCredentials: false,
    extractToken,
};
