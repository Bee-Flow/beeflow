/**
 * Image Generation Tool — extracted from directChat.js for shared use
 */

const fs = require('fs');
const path = require('path');
const configStore = require('../../stores/configStore');
const { googleAdapter } = require('../../core/providers');

const IMAGE_GEN_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'generate_image',
            description: 'Generate an AI image based on a detailed text prompt. Use this when the user asks you to create, generate, draw, or design an image, picture, illustration, or visual. The generated image is displayed inline AND saved to a URL that you can use as backgroundImageUrl in slides_create_presentation.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'A detailed description of the image to generate. Be specific about style, colors, composition, lighting, and subject.'
                    },
                    aspect_ratio: {
                        type: 'string',
                        description: 'Aspect ratio for the image. Options: 1:1, 16:9, 9:16, 4:3, 3:4. Default: 1:1'
                    }
                },
                required: ['prompt']
            }
        }
    }
];

function isImageGenTool(name) {
    return name === 'generate_image';
}

async function executeImageGenTool(args, imageGenSettings, send, req) {
    const googleApiKey = await configStore.getSecret('google_api_key');
    if (!googleApiKey) {
        return { error: 'Google API key not configured. Add it in Admin → AI Config → API Keys.' };
    }

    const prompt = args.prompt;
    const aspectRatio = args.aspect_ratio || imageGenSettings?.aspectRatio || '1:1';

    console.log(`[ImageGen Tool] Generating: "${prompt.substring(0, 80)}" (${aspectRatio})`);

    const result = await googleAdapter.generateImage(googleApiKey, prompt, {
        aspectRatio,
        model: imageGenSettings?.model || 'gemini-3.1-flash-image-preview',
    });

    if (!result.imageBase64) {
        return { error: 'No image was generated. Try a different prompt.' };
    }

    // Send image via SSE so it shows inline
    send('image', { data: result.imageBase64, mimeType: result.mimeType });

    // Save image to RustFS (or local disk as fallback)
    let imageUrl = null;
    let storageKey = null;
    try {
        const crypto = require('crypto');
        const storageStore = require('../../stores/storageStore');
        const ext = (result.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

        if (storageStore.isAvailable()) {
            const userId = req?.session?.user?.id || 'anonymous';
            const key = storageStore.buildKey(userId, 'images', filename);
            await storageStore.uploadFile(key, Buffer.from(result.imageBase64, 'base64'), result.mimeType || 'image/png');
            storageKey = key;
            imageUrl = storageStore.buildProxyUrl(key);
            console.log(`[ImageGen Tool] Saved to RustFS: ${key}`);
        } else {
            // Fallback: local disk
            const genDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'generated');
            if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });
            fs.writeFileSync(path.join(genDir, filename), Buffer.from(result.imageBase64, 'base64'));
            imageUrl = `/uploads/generated/${filename}`;
            console.log(`[ImageGen Tool] Saved to disk: ${imageUrl}`);
        }
    } catch (e) {
        console.warn('[ImageGen Tool] Failed to save image to disk:', e.message);
    }

    // Log usage
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            agent_id: null,
            agent_name: 'direct-chat',
            model: imageGenSettings?.model || 'gemini-3.1-flash-image-preview',
            prompt_tokens: prompt.length,
            completion_tokens: 0,
            total_tokens: prompt.length,
            source: 'image_generation',
        });
    } catch (e) {
        console.warn('[ImageGen Tool] Failed to log usage:', e.message);
    }

    return {
        success: true,
        message: `Image generated and already displayed inline to the user. Do NOT use markdown image syntax or try to embed the image again. Just describe what was created or ask if they want changes.`,
        prompt,
        aspectRatio,
        imageUrl: imageUrl || null,
    };
}

module.exports = { IMAGE_GEN_TOOLS, isImageGenTool, executeImageGenTool };
