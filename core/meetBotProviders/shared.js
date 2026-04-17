/**
 * Shared infrastructure for meeting-bot providers.
 *
 * Audio capture has two modes, chosen automatically:
 *
 * 1. PulseAudio + FFmpeg  — records what Chrome routes to a virtual audio
 *    sink. Requires pulseaudio + pactl + ffmpeg on the system. Preferred when
 *    available (best quality, works for all audio including system sounds).
 *
 * 2. Page MediaRecorder (fallback) — injects a script into the browser that
 *    intercepts RTCPeerConnection audio tracks and records them with the Web
 *    Audio API. Zero system-audio dependencies; works in bare Docker containers.
 *
 * Providers call `startAudioCapture(page, audioPath, sinkName)` which returns
 * a `{ stop }` handle. The caller does not need to know which mode is active.
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
            stdio: 'ignore', detached: true,
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

// ─── PulseAudio null-sink (Mode 1) ─────────────────────
// Returns the sink name on success, null when PulseAudio is unavailable.
// Tries a silent apt-get install if pactl is missing (works for Docker images
// based on Debian/Ubuntu that have internet access at runtime).
function ensurePulseAudio() {
    // Auto-install if not present
    try { execSync('which pactl', { stdio: 'ignore' }); }
    catch {
        console.log('[MeetBot] pactl not found — attempting auto-install (apt-get)...');
        try {
            execSync('apt-get install -y -q pulseaudio pulseaudio-utils 2>/dev/null', { stdio: 'ignore', timeout: 60000 });
            console.log('[MeetBot] PulseAudio installed');
        } catch {
            console.warn('[MeetBot] PulseAudio auto-install failed — will use page recorder instead');
            return null;
        }
    }

    try { execSync('pulseaudio --check 2>/dev/null', { stdio: 'ignore' }); }
    catch {
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

// ─── FFmpeg recorder (Mode 1) ───────────────────────────
function startFFmpegRecorder(outputPath, sinkName) {
    const ffmpeg = spawn('ffmpeg', [
        '-y', '-f', 'pulse', '-i', `${sinkName}.monitor`,
        '-acodec', 'libopus', '-b:a', '128k', '-application', 'voip',
        '-vn', outputPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg && !msg.startsWith('size=')) console.log(`[MeetBot/FFmpeg] ${msg.substring(0, 200)}`);
    });
    ffmpeg.on('error', (err) => console.error(`[MeetBot/FFmpeg] ${err.message}`));
    return ffmpeg;
}

async function stopFFmpeg(ffmpegProcess) {
    if (!ffmpegProcess) return;
    try {
        ffmpegProcess.stdin?.write('q');
        await new Promise(r => setTimeout(r, 2000));
        ffmpegProcess.kill('SIGTERM');
    } catch (_) {}
}

// ─── Page MediaRecorder (Mode 2 fallback) ──────────────
//
// RTCPeerConnection tracks are intercepted via an initScript injected BEFORE
// the meeting page loads. After joining, activatePageRecorder() creates an
// AudioContext that mixes all captured tracks and records them with
// MediaRecorder.

const RTC_HOOK_SCRIPT = `
(function () {
    // Collect audio tracks from every RTCPeerConnection the page creates.
    // Must run before any peer connection is opened (hence addInitScript).
    window.__bfAudioTracks = window.__bfAudioTracks || [];
    const _PC = window.RTCPeerConnection;
    if (!_PC || window.__bfPCHooked) return;
    window.__bfPCHooked = true;
    function HookedPC(...args) {
        const pc = new _PC(...args);
        pc.addEventListener('track', (e) => {
            if (e.track && e.track.kind === 'audio') {
                window.__bfAudioTracks.push(e.track);
                console.debug('[BeeFlow] Captured RTCPeerConnection audio track', e.track.id);
            }
        });
        return pc;
    }
    HookedPC.prototype = _PC.prototype;
    Object.keys(_PC).forEach(k => { try { HookedPC[k] = _PC[k]; } catch (_) {} });
    window.RTCPeerConnection = HookedPC;
})();
`;

/**
 * Inject the RTCPeerConnection hook before navigating to the meeting page.
 * Call once per page, before any page.goto() call.
 */
async function preparePageAudioHook(page) {
    await page.addInitScript(RTC_HOOK_SCRIPT);
}

/**
 * Start recording audio from the browser page via Web Audio API + MediaRecorder.
 * Call this AFTER the bot has joined the meeting (so RTCPeerConnection tracks
 * are being received), then wait for the meeting to end, and call .stop().
 */
async function activatePageRecorder(page, audioPath) {
    const writeStream = fs.createWriteStream(audioPath);

    // Expose a function that the in-page MediaRecorder calls with each audio chunk.
    // exposeFunction throws if already exposed — ignore that.
    try {
        await page.exposeFunction('__bfChunk', (arr) => {
            writeStream.write(Buffer.from(arr));
        });
    } catch (_) {}

    // Start the recorder inside the page.
    await page.evaluate(() => {
        try {
            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            const connected = new WeakSet();

            function connectTrack(track) {
                try {
                    if (connected.has(track)) return;
                    connected.add(track);
                    const src = ctx.createMediaStreamSource(new MediaStream([track]));
                    src.connect(dest);
                    console.debug('[BeeFlow] Connected audio track', track.id);
                } catch (e) { console.warn('[BeeFlow] connectTrack failed', e); }
            }

            // Connect tracks already captured by the RTC hook
            (window.__bfAudioTracks || []).forEach(connectTrack);

            // Capture audio/video elements (some platforms use <audio> elements)
            document.querySelectorAll('audio, video').forEach(el => {
                try {
                    const stream = el.captureStream ? el.captureStream() : null;
                    if (stream) stream.getAudioTracks().forEach(connectTrack);
                } catch (_) {}
            });

            // Watch for new media elements and future RTC tracks
            new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        const els = (node.tagName === 'AUDIO' || node.tagName === 'VIDEO')
                            ? [node] : [...(node.querySelectorAll?.('audio,video') ?? [])];
                        for (const el of els) {
                            try {
                                const s = el.captureStream?.();
                                if (s) s.getAudioTracks().forEach(connectTrack);
                            } catch (_) {}
                        }
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });

            // Also connect any new RTC tracks that arrive after we started
            const _origPush = window.__bfAudioTracks.push.bind(window.__bfAudioTracks);
            window.__bfAudioTracks.push = function (track) {
                connectTrack(track);
                return _origPush(track);
            };

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
            const mr = new MediaRecorder(dest.stream, mimeType ? { mimeType } : {});

            mr.ondataavailable = async (e) => {
                if (e.data.size > 0) {
                    const buf = await e.data.arrayBuffer();
                    window.__bfChunk([...new Uint8Array(buf)]);
                }
            };

            mr.start(1000);
            window.__bfRecorder = mr;
            console.debug('[BeeFlow] Page audio recorder started, mimeType:', mr.mimeType);
        } catch (e) {
            console.error('[BeeFlow] Failed to start page recorder:', e);
        }
    });

    console.log('[MeetBot] Page audio recorder active (no PulseAudio needed)');

    return {
        stop: async () => {
            try {
                await page.evaluate(() => new Promise((resolve) => {
                    const rec = window.__bfRecorder;
                    if (!rec || rec.state === 'inactive') return resolve();
                    rec.onstop = resolve;
                    rec.stop();
                }));
                await new Promise(r => setTimeout(r, 2000));
            } catch (_) {}
            await new Promise(r => writeStream.end(r));
        },
    };
}

// ─── Unified audio-capture entry point ─────────────────
/**
 * Start audio capture. Uses PulseAudio+FFmpeg when sinkName is provided,
 * page MediaRecorder otherwise.
 * Returns { stop: async () => void }.
 */
function startAudioCapture(page, audioPath, sinkName) {
    if (sinkName) {
        const ffmpegProcess = startFFmpegRecorder(audioPath, sinkName);
        return {
            mode: 'pulseaudio',
            stop: () => stopFFmpeg(ffmpegProcess),
        };
    }
    // Return a promise-based handle for page recording (activated async)
    return activatePageRecorder(page, audioPath).then(rec => ({
        mode: 'page',
        ...rec,
    }));
}

// ─── Playwright persistent context ──────────────────────
async function launchBrowser(profileDir, sinkName, display) {
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    const { chromium } = require('playwright');

    const args = [
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
    ];

    const env = { ...process.env, DISPLAY: display || ':99' };
    if (sinkName) {
        // Route Chrome audio output to our PulseAudio null-sink
        env.PULSE_SINK = sinkName;
    }

    return await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args,
        ignoreDefaultArgs: ['--mute-audio'], // keep audio un-muted for both modes
        env,
    });
}

/**
 * Loop that waits for meeting-end detection, manual stop, or max duration.
 */
async function waitForMeetingEnd({ isEnded, isStopped, maxDurationMs }) {
    return new Promise((resolve) => {
        const maxTimeout = setTimeout(() => { cleanup(); resolve(); }, maxDurationMs);

        const checkInterval = setInterval(async () => {
            try {
                if (await isEnded()) { cleanup(); resolve(); }
            } catch (e) {
                console.log(`[MeetBot] End-check failed: ${e.message}`);
                cleanup();
                resolve();
            }
        }, 10000);

        const stopCheck = setInterval(() => {
            if (isStopped()) { cleanup(); resolve(); }
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
    preparePageAudioHook,
    activatePageRecorder,
    startAudioCapture,
    launchBrowser,
    waitForMeetingEnd,
};
