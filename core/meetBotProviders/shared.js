/**
 * Shared infrastructure for meeting-bot providers.
 *
 * Xvfb (virtual display) + PulseAudio null-sink + FFmpeg audio capture, plus
 * a Playwright persistent-context launcher. Provider modules (google.js,
 * teams.js, zoom.js) import from here so the audio-capture plumbing is
 * identical across platforms.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const recordingsDir = path.resolve(__dirname, '../../data/uploads/bot-recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

// ─── Xvfb ───────────────────────────────────────────────
let xvfbProcess = null;
let xvfbDisplay = null;

function ensureXvfb() {
    if (xvfbDisplay) return xvfbDisplay;
    try { execSync('which Xvfb', { stdio: 'ignore' }); }
    catch { console.warn('[MeetBot] Xvfb not installed'); return null; }

    const displayNum = 99;
    try {
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

// ─── PulseAudio null-sink ───────────────────────────────
function ensurePulseAudio() {
    try {
        execSync('pulseaudio --check 2>/dev/null', { stdio: 'ignore' });
    } catch {
        try {
            execSync('pulseaudio --start --exit-idle-time=-1 2>/dev/null || true', { stdio: 'ignore' });
            execSync('sleep 1');
        } catch (e) {
            console.warn(`[MeetBot] Failed to start PulseAudio: ${e.message}`);
            return null;
        }
    }

    const sinkName = 'meet_bot_sink';
    try {
        try { execSync(`pactl unload-module $(pactl list short modules | grep ${sinkName} | cut -f1) 2>/dev/null`, { stdio: 'ignore' }); } catch {}
        const moduleId = execSync(
            `pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description="MeetBotSink"`,
            { encoding: 'utf8' }
        ).trim();
        execSync(`pactl set-default-sink ${sinkName}`, { stdio: 'ignore' });
        console.log(`[MeetBot] PulseAudio null-sink "${sinkName}" ready (module ${moduleId})`);
        return sinkName;
    } catch (e) {
        console.warn(`[MeetBot] Failed to create PulseAudio sink: ${e.message}`);
        return null;
    }
}

// ─── FFmpeg recorder ────────────────────────────────────
function startFFmpegRecorder(outputPath, sinkName) {
    const monitorSource = `${sinkName}.monitor`;
    const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-f', 'pulse',
        '-i', monitorSource,
        '-acodec', 'libopus',
        '-b:a', '128k',
        '-application', 'voip',
        '-vn',
        outputPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.startsWith('size=')) {
            console.log(`[MeetBot/FFmpeg] ${msg.substring(0, 200)}`);
        }
    });
    ffmpeg.on('error', (err) => console.error(`[MeetBot/FFmpeg] Error: ${err.message}`));

    return ffmpeg;
}

async function stopFFmpeg(ffmpegProcess) {
    if (!ffmpegProcess) return;
    try {
        ffmpegProcess.stdin?.write('q');
        await new Promise(r => setTimeout(r, 2000));
        ffmpegProcess.kill('SIGTERM');
    } catch (_) { /* ignore */ }
}

// ─── Playwright persistent context ──────────────────────
async function launchBrowser(profileDir, sinkName, display) {
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    const { chromium } = require('playwright');
    return await chromium.launchPersistentContext(profileDir, {
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
            PULSE_SINK: sinkName,
        },
    });
}

/**
 * Loop that waits for either meeting-end detection, manual stop, or max duration.
 * `isEnded` is an async function returning true when the meeting has ended.
 */
async function waitForMeetingEnd({ isEnded, isStopped, maxDurationMs }) {
    return new Promise((resolve) => {
        const maxTimeout = setTimeout(() => {
            console.log('[MeetBot] Max duration reached, stopping');
            cleanup();
            resolve();
        }, maxDurationMs);

        const checkInterval = setInterval(async () => {
            try {
                if (await isEnded()) {
                    console.log('[MeetBot] Meeting ended detected');
                    cleanup();
                    resolve();
                }
            } catch (e) {
                console.log(`[MeetBot] End-check failed: ${e.message}`);
                cleanup();
                resolve();
            }
        }, 10000);

        const stopCheck = setInterval(() => {
            if (isStopped()) {
                console.log('[MeetBot] Session manually stopped');
                cleanup();
                resolve();
            }
        }, 2000);

        function cleanup() {
            clearInterval(checkInterval);
            clearInterval(stopCheck);
            clearTimeout(maxTimeout);
        }
    });
}

module.exports = {
    recordingsDir,
    ensureXvfb,
    ensurePulseAudio,
    startFFmpegRecorder,
    stopFFmpeg,
    launchBrowser,
    waitForMeetingEnd,
};
