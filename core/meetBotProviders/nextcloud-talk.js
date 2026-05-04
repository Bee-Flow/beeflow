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

// Top-bar "Join call" button — opens the device-check modal.
const TOP_BAR_JOIN_SELECTORS = [
    'button.top-bar__button--call-start',
    'button.top-bar__button[aria-label*="Join call" i]',
    'button.top-bar__button[aria-label*="Start call" i]',
    'button.top-bar__button[aria-label*="Deelnemen aan oproep" i]',
    'button.top-bar__button[aria-label*="Oproep starten" i]',
];

// Final "Join call" button inside the device-check modal.
const MODAL_JOIN_SELECTORS = [
    'button.join-call.action-button',
    'button.button-vue--success.join-call',
];

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
        botName = 'Bee Flow - Meeting Assistant',
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
        await page.goto(meetLink, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Dismiss first-run / cookie dialogs
        try {
            const dismiss = page.locator('button:has-text("Got it"), button:has-text("Begrepen"), button[aria-label*="Close" i]');
            if (await dismiss.count() > 0) { await dismiss.first().click(); await page.waitForTimeout(500); }
        } catch (_) {}

        // Step 1 — open the call flow by clicking the top-bar "Join call".
        // This brings up Talk's "Check devices" pre-join modal.
        let openedCallFlow = false;
        for (const sel of TOP_BAR_JOIN_SELECTORS) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) { await btn.first().click(); openedCallFlow = true; break; }
            } catch (_) {}
        }
        if (!openedCallFlow) {
            // Generic fallback for translated/restyled instances.
            openedCallFlow = await page.evaluate(() => {
                for (const btn of document.querySelectorAll('button')) {
                    const t = (btn.textContent || '').toLowerCase();
                    const a = (btn.getAttribute('aria-label') || '').toLowerCase();
                    if (t.includes('join call') || a.includes('join call')
                        || t.includes('start call') || a.includes('start call')
                        || t.includes('deelnemen aan oproep') || a.includes('deelnemen aan oproep')
                        || t.includes('oproep starten') || a.includes('oproep starten')) {
                        btn.click(); return true;
                    }
                }
                return false;
            });
        }
        if (!openedCallFlow) {
            try { await page.screenshot({ path: path.join(shared.recordingsDir, `fail-nextcloud-${sessionId}.png`) }); } catch (_) {}
            throw new Error('Could not find join-call button on the Nextcloud Talk page (room may require an account or password).');
        }

        // Step 2 — fill the guest display name (skipped when signed in).
        // Talk's input has placeholder="Guest" and an associated <label> — no
        // aria-label, no predictable id. Same click+fill pattern as the
        // Google Meet provider; the trailing Tab fires the blur event Vue
        // needs to revalidate and enable the modal's Join call button.
        const nameSelectors = [
            'input[placeholder="Guest"]',
            '.username-form input.input-field__input',
            '.username-form__display-name input',
        ];
        let nameInput = null;
        for (const sel of nameSelectors) {
            const candidate = page.locator(sel).first();
            try {
                await candidate.waitFor({ state: 'visible', timeout: 3000 });
                nameInput = candidate;
                break;
            } catch (_) {}
        }
        if (nameInput) {
            await nameInput.click({ clickCount: 3 });
            await nameInput.fill(botName);
            await nameInput.press('Tab');
            await page.waitForTimeout(400);
            console.log(`[MeetBot/Nextcloud] Filled guest display name: "${botName}"`);
        } else {
            console.log('[MeetBot/Nextcloud] No name input found — assuming signed in');
        }

        // Step 3 — turn off mic and camera in the device-check modal so the bot
        // doesn't broadcast the fake-device test pattern. Idempotent: if the
        // toggle isn't present (already muted) the click is a no-op.
        for (const sel of [
            '.media-settings__toggles button[aria-label="Mute audio" i]',
            '.media-settings__toggles button[aria-label="Disable video" i]',
            '.media-settings__toggles button[aria-label="Microfoon dempen" i]',
            '.media-settings__toggles button[aria-label="Video uitschakelen" i]',
        ]) {
            try {
                const btn = page.locator(sel);
                if (await btn.count() > 0) { await btn.first().click(); await page.waitForTimeout(200); }
            } catch (_) {}
        }

        // Step 4 — click the modal's "Join call" button. It's disabled until
        // the name field validates, so retry a few times.
        let inCall = false;
        for (let attempt = 0; attempt < 8 && !inCall; attempt++) {
            for (const sel of MODAL_JOIN_SELECTORS) {
                try {
                    const btn = page.locator(sel);
                    if (await btn.count() === 0) continue;
                    const disabled = await btn.first().evaluate(el => el.disabled || el.hasAttribute('disabled'));
                    if (disabled) continue;
                    await btn.first().click();
                    inCall = true;
                    break;
                } catch (_) {}
            }
            if (!inCall) await page.waitForTimeout(700);
        }
        if (inCall) {
            console.log('[MeetBot/Nextcloud] Confirmed Join call in device-check modal');
        } else {
            console.log('[MeetBot/Nextcloud] No device-check modal detected — assuming direct join');
        }

        console.log('[MeetBot/Nextcloud] Waiting for call media...');
        await page.waitForTimeout(5000);

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
