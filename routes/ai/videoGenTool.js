/**
 * Video Generation Tool — Veo 3.1 via Google GenAI
 * 
 * Follows the same pattern as imageGenTool.js.
 * Generates short videos (5-8s) via long-running operations, saves as MP4.
 */

const fs = require('fs');
const path = require('path');
const configStore = require('../../stores/configStore');
const { googleAdapter } = require('../../core/providers');

const VIDEO_GEN_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'generate_video',
            description: 'Generate a short AI video (5-8 seconds) based on a text prompt. Use this when the user asks you to create, generate, or make a video, clip, animation, or motion content. The generated video is displayed inline in the chat. Note: video generation takes 1-3 minutes.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'A detailed description of the video to generate. Include subject, action, style, lighting, camera movement, and mood. Example: "A golden retriever running through a sunlit forest, cinematic slow motion, warm golden hour lighting"'
                    },
                    aspect_ratio: {
                        type: 'string',
                        description: 'Aspect ratio for the video. Options: "16:9" (landscape), "9:16" (portrait), "1:1" (square). Default: "16:9"'
                    },
                    duration_seconds: {
                        type: 'number',
                        description: 'Duration of the video in seconds. Options: 5, 6, 7, or 8. Default: 8'
                    }
                },
                required: ['prompt']
            }
        }
    }
];

function isVideoGenTool(name) {
    return name === 'generate_video';
}

async function executeVideoGenTool(args, send, req, nanoBananaSettings) {
    const googleApiKey = await configStore.getSecret('google_api_key');
    if (!googleApiKey) {
        return { error: 'Google API key not configured. Add it in Admin → AI Config → API Keys.' };
    }

    // Merge: LLM tool args override Nano Banana defaults
    const videoSettings = nanoBananaSettings?.video || {};
    const prompt = args.prompt;
    const aspectRatio = args.aspect_ratio || videoSettings.aspectRatio || '16:9';
    const durationSeconds = Math.min(8, Math.max(4, args.duration_seconds || videoSettings.duration || 8));
    const model = videoSettings.model || 'veo-3.1-generate-preview';

    console.log(`[VideoGen Tool] Generating: "${prompt.substring(0, 80)}" (${aspectRatio}, ${durationSeconds}s, ${model})`);

    // Notify user that generation is starting (it takes a while)
    send('tool_progress', { name: 'generate_video', message: 'Video generation started — this typically takes 1-3 minutes...' });

    const result = await googleAdapter.generateVideo(googleApiKey, prompt, {
        aspectRatio,
        durationSeconds,
        model,
    });

    if (!result.videoBase64) {
        return { error: 'No video was generated. Try a different prompt.' };
    }

    // Save video to RustFS (or local disk as fallback)
    let videoUrl = null;
    try {
        const crypto = require('crypto');
        const storageStore = require('../../stores/storageStore');
        const filename = `video_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`;

        if (storageStore.isAvailable()) {
            const userId = req?.session?.user?.id || 'anonymous';
            const key = storageStore.buildKey(userId, 'videos', filename);
            await storageStore.uploadFile(key, Buffer.from(result.videoBase64, 'base64'), result.mimeType || 'video/mp4');
            videoUrl = await storageStore.getPresignedUrl(key);
            console.log(`[VideoGen Tool] Saved to RustFS: ${key}`);
        } else {
            // Fallback: local disk
            const genDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'generated');
            if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });
            fs.writeFileSync(path.join(genDir, filename), Buffer.from(result.videoBase64, 'base64'));
            const protocol = req?.protocol || 'http';
            const host = req?.get?.('host') || `localhost:${process.env.SERVER_PORT || 3001}`;
            videoUrl = `${protocol}://${host}/uploads/generated/${filename}`;
            console.log(`[VideoGen Tool] Saved to disk: ${videoUrl}`);
        }
    } catch (e) {
        console.warn('[VideoGen Tool] Failed to save video to disk:', e.message);
    }

    // Send video via SSE — use URL instead of base64 (videos are too large for inline base64)
    if (videoUrl) {
        send('video', { url: videoUrl, mimeType: result.mimeType });
    }

    // Log usage
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            agent_id: null,
            agent_name: 'direct-chat',
            model: 'veo-3.1-generate-001',
            prompt_tokens: prompt.length,
            completion_tokens: 0,
            total_tokens: prompt.length,
            source: 'video_generation',
        });
    } catch (e) {
        console.warn('[VideoGen Tool] Failed to log usage:', e.message);
    }

    return {
        success: true,
        message: `Video generated and already displayed inline to the user. Do NOT try to embed the video or provide a download link. Just describe what was created or ask if they want changes.`,
        prompt,
        aspectRatio,
        durationSeconds,
        videoUrl: videoUrl || null,
    };
}

module.exports = { VIDEO_GEN_TOOLS, isVideoGenTool, executeVideoGenTool };
