export function sanitizeMessageContent(content) {
    let sanitized = content;
    const invisibleChars = [
        '\u200B',
        '\u200C',
        '\u200D',
        '\u200E',
        '\u200F',
        '\u202A',
        '\u202B',
        '\u202C',
        '\u202D',
        '\u202E',
        '\uFEFF',
        '\u2060',
        '\u2061',
        '\u2062',
        '\u2063',
        '\u2064',
    ];
    for (const char of invisibleChars) {
        sanitized = sanitized.replace(new RegExp(char, 'g'), '');
    }
    const homographMap = {
        'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
        'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
        'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X',
        'α': 'a', 'ο': 'o', 'ν': 'v',
        '\u201A': ',', '\u2018': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-',
        '\u00A1': 'i', '\uFF01': '!', '\uFF1F': '?', '\uFF1A': ':', '\uFF1B': ';',
    };
    for (const [homograph, ascii] of Object.entries(homographMap)) {
        sanitized = sanitized.replace(new RegExp(homograph, 'g'), ascii);
    }
    sanitized = sanitized
        .replace(/\\u[\da-fA-F]{4}/g, '[REMOVED]')
        .replace(/\\x[\da-fA-F]{2}/g, '[REMOVED]')
        .replace(/\\U[\da-fA-F]{8}/g, '[REMOVED]');
    const dangerousPatterns = [
        /["'`]?\s*sender\s*["'`]?\s*:/gi,
        /["'`]?\s*is[\s_-]?from[\s_-]?me\s*["'`]?\s*:/gi,
        /["'`]?\s*content\s*["'`]?\s*:/gi,
        /["'`]?\s*date\s*["'`]?\s*:/gi,
        /(?:^|\s)sender\s*:/gim,
        /(?:^|\s)is[\s_-]?from[\s_-]?me\s*:/gim,
        /(?:^|\s)content\s*:/gim,
        /(?:^|\s)date\s*:/gim,
        /\}\s*,\s*\{/g,
        /\]\s*\}\s*,?\s*\{\s*["'`]?messages["'`]?\s*:\s*\[/gi,
    ];
    for (const pattern of dangerousPatterns) {
        sanitized = sanitized.replace(pattern, ' [REMOVED] ');
    }
    sanitized = sanitized
        .replace(/\}\s*\]/g, ' [REMOVED] ')
        .replace(/\[\s*\{/g, ' [REMOVED] ')
        .replace(/\}\s*\{/g, ' [REMOVED] ')
        .replace(/\]\s*,\s*\[/g, ' [REMOVED] ')
        .replace(/\\["']/g, '[REMOVED]')
        .replace(/`/g, "'");
    const jsonKeyPattern = /[\n\r]+\s*["'`]?(sender|is_from_me|content|date|messages|attachments|url|phone_number|text|body|from|to|id|user|owner)["'`]?\s*:/gi;
    sanitized = sanitized.replace(jsonKeyPattern, '\n[REMOVED]:');
    sanitized = sanitized.replace(/\x00/g, '[REMOVED]');
    sanitized = sanitized.replace(/\s{3,}/g, '  ');
    return sanitized;
}
export function sanitizePhoneNumber(phoneNumber) {
    return phoneNumber
        .replace(/[{}[\]"':`,]/g, '')
        .trim();
}
export function sanitizeUrl(url) {
    try {
        const sanitized = sanitizeMessageContent(url);
        if (sanitized.includes('[REMOVED]')) {
            return '';
        }
        new URL(sanitized);
        return sanitized;
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=sanitize.js.map