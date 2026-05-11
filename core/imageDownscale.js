/**
 * Image downscaling for LLM requests.
 *
 * Anthropic enforces a max dimension of 2000 pixels per image side in
 * many-image requests. When a single image in the conversation exceeds that,
 * the entire request fails with HTTP 400 and (because SSE headers are already
 * flushed) the browser sees ERR_INCOMPLETE_CHUNKED_ENCODING.
 *
 * This module walks an array of Claude-shaped messages and downscales any
 * base64-encoded `image` content block whose longest side exceeds the cap,
 * preserving aspect ratio and the original media_type. URL-source images are
 * left untouched (we don't pay the bandwidth to fetch + re-host).
 *
 * Uses `sharp`. If sharp is unavailable for any reason, the original block is
 * returned unchanged — the request may still fail upstream, but we never block
 * the conversation on a missing dep.
 */

const MAX_DIM = 2000;
const MIN_RESIZE_TRIGGER = MAX_DIM + 1;
// When `sharp` can't be loaded we can't measure dimensions — fall back to a
// rough byte-size heuristic and drop any block whose decoded base64 is
// suspiciously large. A clean 2000×2000 PNG is ~1–3 MB; anything > 2 MB likely
// exceeds the dimension cap. Better to lose one image's content than have
// Anthropic 400 the whole request mid-stream.
const FALLBACK_SIZE_HEURISTIC_BYTES = 2 * 1024 * 1024;

let _sharp = null;
let _sharpProbed = false;
function loadSharp() {
    if (_sharpProbed) return _sharp;
    _sharpProbed = true;
    try { _sharp = require('sharp'); }
    catch (e) {
        console.warn('[ImageDownscale] sharp unavailable — large images will reach the API unmodified:', e.message);
        _sharp = null;
    }
    return _sharp;
}

async function shrinkOne(b64, mediaType) {
    const sharp = loadSharp();
    if (!sharp) return null;
    const buf = Buffer.from(b64, 'base64');
    try {
        const meta = await sharp(buf, { failOn: 'none' }).metadata();
        const w = meta.width || 0;
        const h = meta.height || 0;
        if (w < MIN_RESIZE_TRIGGER && h < MIN_RESIZE_TRIGGER) return null; // no-op
        const longest = Math.max(w, h);
        const ratio = MAX_DIM / longest;
        const newW = Math.max(1, Math.round(w * ratio));
        const newH = Math.max(1, Math.round(h * ratio));

        // Pick output encoder that matches input mediaType so we don't break
        // Claude's expectation. Default to PNG when format is exotic.
        let pipeline = sharp(buf, { failOn: 'none' }).rotate().resize({
            width: newW,
            height: newH,
            fit: 'inside',
            withoutEnlargement: true,
        });

        const mt = (mediaType || '').toLowerCase();
        let outMime;
        if (mt.includes('jpeg') || mt.includes('jpg')) {
            pipeline = pipeline.jpeg({ quality: 85 });
            outMime = 'image/jpeg';
        } else if (mt.includes('webp')) {
            pipeline = pipeline.webp({ quality: 85 });
            outMime = 'image/webp';
        } else if (mt.includes('gif')) {
            // sharp can't write GIF in all builds — fall through to PNG.
            pipeline = pipeline.png();
            outMime = 'image/png';
        } else {
            pipeline = pipeline.png();
            outMime = 'image/png';
        }

        const out = await pipeline.toBuffer();
        return {
            base64: out.toString('base64'),
            mediaType: outMime,
            originalDims: { w, h },
            newDims: { w: newW, h: newH },
        };
    } catch (err) {
        console.warn('[ImageDownscale] failed to shrink image:', err.message);
        return null;
    }
}

/**
 * In-place rewrite. Walks Claude messages, finds image blocks with
 * source.type === 'base64', and downscales any whose dimensions exceed
 * MAX_DIM. Mutates and also returns the input array for convenience.
 */
async function downscaleClaudeMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    const sharpAvailable = !!loadSharp();
    let touched = 0;
    let dropped = 0;
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.content)) continue;
        for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (!block || block.type !== 'image') continue;
            const src = block.source;
            if (!src || src.type !== 'base64' || !src.data) continue;

            if (!sharpAvailable) {
                // No sharp → can't measure or shrink. Estimate decoded byte
                // size from the base64 length (base64 is 4/3 the raw size)
                // and drop any block over the heuristic to keep the request
                // from 400-ing on dimension limits.
                const approxBytes = Math.floor(src.data.length * 3 / 4);
                if (approxBytes > FALLBACK_SIZE_HEURISTIC_BYTES) {
                    msg.content[i] = {
                        type: 'text',
                        text: '[image omitted — server image processor unavailable, image too large to ship as-is]',
                    };
                    dropped++;
                }
                continue;
            }

            const shrunk = await shrinkOne(src.data, src.media_type);
            if (shrunk) {
                block.source = { type: 'base64', media_type: shrunk.mediaType, data: shrunk.base64 };
                touched++;
                console.log(`[ImageDownscale] resized ${shrunk.originalDims.w}x${shrunk.originalDims.h} → ${shrunk.newDims.w}x${shrunk.newDims.h} (${src.media_type} → ${shrunk.mediaType})`);
            }
        }
    }
    if (touched > 0) console.log(`[ImageDownscale] downscaled ${touched} oversized image(s)`);
    if (dropped > 0) console.warn(`[ImageDownscale] dropped ${dropped} oversized image(s) — sharp unavailable`);
    return messages;
}

module.exports = { downscaleClaudeMessages, MAX_DIM };
