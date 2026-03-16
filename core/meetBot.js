/**
 * Meet Bot Engine — Playwright-based Google Meet recording bot
 *
 * Joins a Google Meet as a signed-in user, captures audio via
 * PulseAudio virtual sink + FFmpeg, and saves a .webm file for transcription.
 *
 * Architecture:
 *   1. PulseAudio null-sink → Chrome outputs audio here
 *   2. FFmpeg records from the sink's monitor source
 *   3. Playwright handles browser automation (sign-in, join, detect end)
 *
 * Requirements on server:
 *   - playwright + @playwright/browser-chromium
 *   - pulseaudio, pulseaudio-utils (pactl)
 *   - ffmpeg
 *   - xvfb
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Directory for saved bot recordings
const recordingsDir = path.resolve(__dirname, '../data/uploads/bot-recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

// Persistent browser data dir (keeps Google sign-in session across restarts)
const browserDataDir = path.resolve(__dirname, '../data/meet-bot-profile');
if (!fs.existsSync(browserDataDir)) fs.mkdirSync(browserDataDir, { recursive: true });

// Track active sessions
const activeSessions = new Map();

// ─── Xvfb management ──────────────────────────────────────
let xvfbProcess = null;
let xvfbDisplay = null;

function ensureXvfb() {
    if (xvfbDisplay) return xvfbDisplay;

    try {
        execSync('which Xvfb', { stdio: 'ignore' });
    } catch {
        console.warn('[MeetBot] Xvfb not installed');
        return null;
    }

    const displayNum = 99;
    try {
        // Kill any existing Xvfb on this display
        try { execSync(`kill $(cat /tmp/.X${displayNum}-lock 2>/dev/null) 2>/dev/null`, { stdio: 'ignore' }); } catch {}
        
        xvfbProcess = spawn('Xvfb', [`:${displayNum}`, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {
            stdio: 'ignore',
            detached: true,
        });
        xvfbProcess.unref();
        execSync('sleep 1');

        xvfbDisplay = `:${displayNum}`;
        console.log(`[MeetBot] Xvfb started on display ${xvfbDisplay}`);
        return xvfbDisplay;
    } catch (e) {
        console.warn(`[MeetBot] Failed to start Xvfb: ${e.message}`);
        return null;
    }
}

// ─── PulseAudio management ─────────────────────────────────
function ensurePulseAudio() {
    try {
        // Check if PulseAudio is running
        execSync('pulseaudio --check 2>/dev/null', { stdio: 'ignore' });
        console.log('[MeetBot] PulseAudio already running');
    } catch {
        // Start PulseAudio in system-wide mode
        try {
            execSync('pulseaudio --start --exit-idle-time=-1 2>/dev/null || true', { stdio: 'ignore' });
            execSync('sleep 1');
            console.log('[MeetBot] PulseAudio started');
        } catch (e) {
            console.warn(`[MeetBot] Failed to start PulseAudio: ${e.message}`);
            return null;
        }
    }

    // Create a null-sink for capturing audio
    const sinkName = 'meet_bot_sink';
    try {
        // Remove existing sink if any
        try { execSync(`pactl unload-module $(pactl list short modules | grep ${sinkName} | cut -f1) 2>/dev/null`, { stdio: 'ignore' }); } catch {}
        
        const moduleId = execSync(
            `pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description="MeetBotSink"`,
            { encoding: 'utf8' }
        ).trim();
        
        // Set as default sink so Chrome outputs here
        execSync(`pactl set-default-sink ${sinkName}`, { stdio: 'ignore' });
        
        console.log(`[MeetBot] PulseAudio null-sink "${sinkName}" created (module ${moduleId})`);
        return sinkName;
    } catch (e) {
        console.warn(`[MeetBot] Failed to create PulseAudio sink: ${e.message}`);
        return null;
    }
}

// ─── FFmpeg audio recorder ─────────────────────────────────
function startFFmpegRecorder(outputPath, sinkName) {
    const monitorSource = `${sinkName}.monitor`;
    
    const ffmpeg = spawn('ffmpeg', [
        '-y',                           // overwrite
        '-f', 'pulse',                  // PulseAudio input
        '-i', monitorSource,            // record from sink monitor
        '-acodec', 'libopus',           // Opus codec (good for speech)
        '-b:a', '128k',                 // bitrate
        '-application', 'voip',         // optimize for speech
        '-vn',                          // no video
        outputPath,
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.startsWith('size=')) {
            console.log(`[MeetBot/FFmpeg] ${msg.substring(0, 200)}`);
        }
    });

    ffmpeg.on('error', (err) => {
        console.error(`[MeetBot/FFmpeg] Error: ${err.message}`);
    });

    return ffmpeg;
}

/**
 * Join a Google Meet and record audio via PulseAudio + FFmpeg.
 */
async function joinAndRecord(sessionId, meetLink, options = {}) {
    const {
        botName = 'Bee Flow - Meeting Assistant',
        maxDurationMs = 3 * 60 * 60 * 1000, // 3 hours
        credentials = null,
        onStatusChange = () => {},
    } = options;

    // Normalize meet link
    if (!meetLink.startsWith('http')) {
        meetLink = 'https://' + meetLink;
    }

    const audioPath = path.join(recordingsDir, `meet-${sessionId}-${Date.now()}.webm`);
    let browser = null;
    let context = null;
    let ffmpegProcess = null;
    let recordingStartTime = null;

    try {
        onStatusChange('joining', { meetLink });
        console.log(`[MeetBot] Launching browser for session ${sessionId}`);

        // Setup virtual display
        const display = ensureXvfb();
        if (display) {
            process.env.DISPLAY = display;
        }

        // Setup PulseAudio
        const sinkName = ensurePulseAudio();
        if (!sinkName) {
            throw new Error('PulseAudio setup failed — cannot record audio');
        }

        // Launch Playwright with persistent context (preserves Google sign-in)
        const { chromium } = require('playwright');
        
        context = await chromium.launchPersistentContext(browserDataDir, {
            headless: false,
            viewport: { width: 1280, height: 720 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--no-first-run',
                '--no-default-browser-check',
            ],
            ignoreDefaultArgs: ['--mute-audio'],
            env: {
                ...process.env,
                DISPLAY: display || ':99',
                PULSE_SINK: sinkName,                // Route Chrome audio → our sink
            },
        });

        browser = context.browser?.() || context;
        activeSessions.set(sessionId, { context, ffmpegProcess: null, stopped: false });

        const page = context.pages()[0] || await context.newPage();

        // ─── Google Sign-In Flow ───────────────────────────────
        if (credentials && credentials.email && credentials.password) {
            console.log(`[MeetBot] Signing in to Google as ${credentials.email}`);

            await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(2000);

            // Screenshot for debugging
            try {
                await page.screenshot({ path: path.join(recordingsDir, `login-1-${sessionId}.png`) });
            } catch (e) { /* ignore */ }

            // Enter email
            try {
                const emailInput = page.locator('input[type="email"]');
                if (await emailInput.count() > 0) {
                    await emailInput.click();
                    await emailInput.fill(credentials.email);
                    console.log('[MeetBot] Entered email');

                    // Click "Next"
                    const nextBtn = page.locator('#identifierNext button, #identifierNext');
                    if (await nextBtn.count() > 0) await nextBtn.first().click();
                    await page.waitForTimeout(3000);
                } else {
                    console.log('[MeetBot] No email input — may already be signed in');
                }
            } catch (e) {
                console.warn('[MeetBot] Email entry failed:', e.message);
            }

            try {
                await page.screenshot({ path: path.join(recordingsDir, `login-2-${sessionId}.png`) });
            } catch (e) { /* ignore */ }

            // Enter password
            try {
                await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10000 });
                const passInput = page.locator('input[type="password"]');
                if (await passInput.count() > 0) {
                    await passInput.click();
                    await passInput.fill(credentials.password);
                    console.log('[MeetBot] Entered password');

                    const nextBtn = page.locator('#passwordNext button, #passwordNext');
                    if (await nextBtn.count() > 0) await nextBtn.first().click();
                    await page.waitForTimeout(5000);
                }
            } catch (e) {
                console.warn('[MeetBot] Password entry failed:', e.message);
            }

            try {
                await page.screenshot({ path: path.join(recordingsDir, `login-3-${sessionId}.png`) });
            } catch (e) { /* ignore */ }

            console.log(`[MeetBot] Sign-in flow complete. Current URL: ${page.url()}`);
        }

        // ─── Navigate to Google Meet ───────────────────────────
        console.log(`[MeetBot] Navigating to ${meetLink}`);
        await page.goto(meetLink, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Debug screenshot
        try {
            const screenshotPath = path.join(recordingsDir, `debug-${sessionId}.png`);
            await page.screenshot({ path: screenshotPath });
            console.log(`[MeetBot] Debug screenshot saved: ${screenshotPath}`);
        } catch (e) { /* ignore */ }

        // --- Handle Google Meet join flow ---
        // Dismiss cookie/terms dialogs
        try {
            const gotItBtn = page.locator('button[jsname="j6LnYe"], button[aria-label="Got it"]');
            if (await gotItBtn.count() > 0) {
                await gotItBtn.first().click();
                await page.waitForTimeout(1000);
            }
        } catch (e) { /* no dialog */ }

        // Dismiss notification popup ("Bureaubladmeldingen krijgen van Meet")
        try {
            // Try Dutch "Niet nu" and English "Not now" / "Dismiss"
            const dismissBtn = page.locator('button:has-text("Niet nu"), button:has-text("Not now"), button:has-text("Dismiss")');
            if (await dismissBtn.count() > 0) {
                await dismissBtn.first().click();
                console.log('[MeetBot] Dismissed notification popup');
                await page.waitForTimeout(500);
            }
        } catch (e) { /* no popup */ }

        // Enter bot name (for guest users)
        try {
            const nameInput = page.locator('input[aria-label="Your name"], input[placeholder="Your name"]');
            if (await nameInput.count() > 0) {
                await nameInput.first().click({ clickCount: 3 });
                await nameInput.first().fill(botName);
                console.log(`[MeetBot] Entered name: ${botName}`);
                await page.waitForTimeout(500);
            }
        } catch (e) {
            console.log('[MeetBot] No name input found');
        }

        // Turn off camera and microphone
        try {
            const cameraBtn = page.locator('[data-is-muted="false"][aria-label*="camera" i], [aria-label*="Turn off camera" i]');
            if (await cameraBtn.count() > 0) {
                await cameraBtn.first().click();
                await page.waitForTimeout(300);
                console.log('[MeetBot] Camera turned off');
            }
        } catch (e) { /* already off */ }

        try {
            const micBtn = page.locator('[data-is-muted="false"][aria-label*="microphone" i], [aria-label*="Turn off microphone" i]');
            if (await micBtn.count() > 0) {
                await micBtn.first().click();
                await page.waitForTimeout(300);
                console.log('[MeetBot] Microphone turned off');
            }
        } catch (e) { /* already off */ }

        // Click "Ask to join" / "Join now"
        const joinSelectors = [
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

        let joined = false;
        for (const selector of joinSelectors) {
            try {
                const btn = page.locator(selector);
                if (await btn.count() > 0) {
                    await btn.first().click();
                    console.log(`[MeetBot] Clicked join button (${selector})`);
                    joined = true;
                    break;
                }
            } catch (e) { /* try next */ }
        }

        if (!joined) {
            // Fallback: text-based search
            joined = await page.evaluate(() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    const text = (btn.textContent || '').toLowerCase();
                    if (text.includes('join') || text.includes('ask to join') ||
                        text.includes('deelnemen') || text.includes('nu deelnemen') ||
                        text.includes('deelnameverzoek')) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });
            if (joined) console.log('[MeetBot] Clicked join button via text search');
        }

        if (!joined) {
            try {
                const failScreenshot = path.join(recordingsDir, `fail-${sessionId}.png`);
                await page.screenshot({ path: failScreenshot });
                console.log(`[MeetBot] Failure screenshot saved: ${failScreenshot}`);
            } catch (e) { /* ignore */ }
            throw new Error('Could not find join button on Google Meet page');
        }

        // Wait to be admitted
        console.log('[MeetBot] Waiting to be admitted to meeting...');
        await page.waitForTimeout(8000);

        // ─── Start FFmpeg audio recording ──────────────────────
        onStatusChange('recording', { meetLink });
        console.log('[MeetBot] Starting FFmpeg audio capture');

        ffmpegProcess = startFFmpegRecorder(audioPath, sinkName);
        activeSessions.set(sessionId, { context, ffmpegProcess, stopped: false });
        recordingStartTime = Date.now();
        console.log(`[MeetBot] Recording started → ${audioPath}`);

        // ─── Monitor for meeting end ───────────────────────────
        await new Promise((resolve) => {
            const maxTimeout = setTimeout(() => {
                console.log('[MeetBot] Max duration reached, stopping');
                resolve();
            }, maxDurationMs);

            // Check if meeting ended
            const checkInterval = setInterval(async () => {
                try {
                    const isEnded = await page.evaluate(() => {
                        const body = document.body?.innerText || '';
                        return body.includes('left the meeting') ||
                               body.includes('meeting has ended') ||
                               body.includes('de vergadering verlaten') ||
                               body.includes('vergadering is beëindigd') ||
                               body.includes('removed from the meeting') ||
                               body.includes('call ended');
                    });
                    if (isEnded) {
                        console.log('[MeetBot] Meeting ended detected');
                        clearInterval(checkInterval);
                        clearTimeout(maxTimeout);
                        resolve();
                    }
                } catch (e) {
                    console.log(`[MeetBot] Page check failed: ${e.message}`);
                    clearInterval(checkInterval);
                    clearTimeout(maxTimeout);
                    resolve();
                }
            }, 10000);

            // Check manual stop
            const stopCheck = setInterval(() => {
                const session = activeSessions.get(sessionId);
                if (!session || session.stopped) {
                    console.log('[MeetBot] Session manually stopped');
                    clearInterval(checkInterval);
                    clearInterval(stopCheck);
                    clearTimeout(maxTimeout);
                    resolve();
                }
            }, 2000);
        });

    } finally {
        const durationSeconds = recordingStartTime
            ? Math.round((Date.now() - recordingStartTime) / 1000)
            : 0;

        console.log(`[MeetBot] Cleaning up session ${sessionId} (${durationSeconds}s recorded)`);

        // Stop FFmpeg gracefully (send 'q' to quit)
        if (ffmpegProcess) {
            try {
                ffmpegProcess.stdin?.write('q');
                await new Promise(r => setTimeout(r, 2000));
                ffmpegProcess.kill('SIGTERM');
            } catch (e) { /* ignore */ }
        }

        // Close browser context (but keep persistent data)
        if (context) {
            try { await context.close(); } catch (e) { /* ignore */ }
        }

        activeSessions.delete(sessionId);

        // Verify recording
        try {
            const stats = fs.statSync(audioPath);
            if (stats.size < 1000) {
                console.warn(`[MeetBot] Recording too small (${stats.size} bytes), may be empty`);
            } else {
                console.log(`[MeetBot] Recording saved: ${audioPath} (${(stats.size / 1024).toFixed(1)} KB)`);
            }
        } catch (e) {
            console.error(`[MeetBot] Could not verify recording:`, e.message);
        }

        return { audioPath, durationSeconds };
    }
}

/**
 * Stop an active bot session.
 */
function stopSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.stopped = true;
        console.log(`[MeetBot] Marked session ${sessionId} for stop`);
        return true;
    }
    return false;
}

/**
 * Check if a session is currently active.
 */
function isSessionActive(sessionId) {
    return activeSessions.has(sessionId);
}

module.exports = {
    joinAndRecord,
    stopSession,
    isSessionActive,
};
