const { mistralOCR } = require('../ocr');

async function processAttachments(attachments = [], lastMsg) {
    if (!attachments || attachments.length === 0) return;

    if (typeof lastMsg.content === 'string') {
        lastMsg.content = [{ type: "text", text: lastMsg.content }];
    }

    for (const att of attachments) {
        if (att.type.includes('pdf')) {
            const base64Data = att.content.split(',')[1];
            const pdfBuffer = Buffer.from(base64Data, 'base64');
            let pdfText = '';

            try {
                const { extractTextFromPDF } = require('./pdfExtractor');
                pdfText = await extractTextFromPDF(pdfBuffer, att.name);
            } catch (parseErr) {
                console.warn(`[AttachmentProcessor] pdfjs extraction failed for ${att.name}:`, parseErr.message);
            }

            if (!pdfText) {
                try {
                    pdfText = await mistralOCR(base64Data, att.type, att.name);
                } catch (ocrErr) {
                    console.warn(`[AttachmentProcessor] OCR failed:`, ocrErr.message);
                }
            }

            if (pdfText) {
                const textBlock = lastMsg.content.find(c => c.type === 'text');
                const appendText = `\n\n[PDF Document: ${att.name}]\n---\n${pdfText}\n---\n`;
                if (textBlock) {
                    textBlock.text += appendText;
                } else {
                    lastMsg.content.push({ type: "text", text: appendText });
                }
            } else {
                lastMsg.content.push({
                    type: "file",
                    file: { filename: att.name, file_data: att.content }
                });
            }
        } else if (att.type.startsWith('image/')) {
            lastMsg.content.push({
                type: "image_url",
                image_url: { url: att.content }
            });
        } else {
            try {
                const { parseDocument } = require('./documentParser');
                const base64Data = att.content.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const text = await parseDocument(buffer, att.type, att.name);

                const textBlock = lastMsg.content.find(c => c.type === 'text');
                const appendText = `\n\n[Attachment: ${att.name}]\n---\n${text}\n---\n`;
                if (textBlock) {
                    textBlock.text += appendText;
                } else {
                    lastMsg.content.push({ type: "text", text: appendText });
                }
            } catch (e) {
                console.error(`[AttachmentProcessor] Failed to parse document ${att.name}`, e);
            }
        }
    }
}

module.exports = { processAttachments };
