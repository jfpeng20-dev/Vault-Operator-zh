/**
 * Lightweight string module for Vault Operator.
 *
 * Provides key-based string lookup with simple interpolation ({{var}}).
 * Locale is detected once at load: an explicit localStorage override wins,
 * then Obsidian's interface language (via moment.locale), then the
 * browser/Electron locale, finally falling back to English.
 */

import { en } from './locales/en';
import { zh } from './locales/zh';
import type { Translations } from './types';

const messages: Record<string, Translations> = { en, zh };

function detectLocale(): string {
    // 1. Explicit power-user override (also used by the Language settings tab).
    try {
        const stored = localStorage.getItem('vault-operator-ui-lang');
        if (stored && messages[stored]) return stored;
    } catch {
        // localStorage may be unavailable in some sandboxed contexts.
    }
    // 2. Obsidian sets moment.locale() to the user's chosen interface language.
    try {
        const momentRef = (window as unknown as { moment?: { locale?: () => string } }).moment;
        const ml = momentRef && typeof momentRef.locale === 'function' ? momentRef.locale() : '';
        if (typeof ml === 'string' && ml.toLowerCase().startsWith('zh')) return 'zh';
    } catch {
        // ignore
    }
    // 3. Browser / Electron locale.
    try {
        const nav = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language.toLowerCase() : '';
        if (nav.startsWith('zh')) return 'zh';
    } catch {
        // ignore
    }
    // 4. Personal build default: Chinese. Switch back to English by setting
    //    localStorage 'vault-operator-ui-lang' = 'en' in the devtools console.
    return 'zh';
}

const activeLocale = detectLocale();
const dict: Translations = messages[activeLocale] ?? en;

/**
 * Look up a UI string by key. Returns the string, falling back to English,
 * then to the raw key if nothing is found.
 *
 * Supports simple interpolation: `t('key', { count: 5 })` replaces `{{count}}`.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
    let text = dict[key] ?? en[key] ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            text = text.replaceAll(`{{${k}}}`, String(v));
        }
    }
    return text;
}
