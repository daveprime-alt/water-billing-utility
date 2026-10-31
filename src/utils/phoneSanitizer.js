// Cleaned up to evaluate raw digit distribution counts (exactly 10 or 12 digits)
const KENYAN_MOBILE_LOCAL_PATTERN = /^0[71]\d{8}$/;
const KENYAN_MOBILE_NATIONAL_PATTERN = /^[71]\d{8}$/;
const KENYAN_MOBILE_INTERNATIONAL_PATTERN = /^254[71]\d{8}$/;

export function normalizePhoneNumber(value) {
    if (value === null || value === undefined) return null;

    let input = String(value).trim();
    if (input === "") return null;

    // Fix the "254(0)7..." format common in corporate profiles before stripping punctuation
    if (input.includes('254') && input.includes('(0)')) {
        input = input.replace('(0)', '');
    } else if (input.startsWith('+2540')) {
        // Fixes accidents like +2540712345678 -> 254712345678
        input = '254' + input.slice(5);
    }

    const digits = input.replace(/\D/g, "");

    if (KENYAN_MOBILE_LOCAL_PATTERN.test(digits)) {
        return `254${digits.slice(1)}`;
    }
    
    if (KENYAN_MOBILE_NATIONAL_PATTERN.test(digits)) {
        return `254${digits}`;
    }
    
    if (KENYAN_MOBILE_INTERNATIONAL_PATTERN.test(digits)) {
        return digits;
    }

    return null;
}

export function sanitizePhoneNumber(value) {
    return normalizePhoneNumber(value);
}
