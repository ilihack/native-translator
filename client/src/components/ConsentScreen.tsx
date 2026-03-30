/**
 * Consent persistence helpers for nativ translator.
 * Consent is stored in both localStorage AND a cookie so it survives
 * iOS PWA ↔ Safari context switches (which do not share localStorage).
 * The actual consent UI lives in index.html as static HTML for SEO crawlability.
 * @exports CONSENT_STORAGE_KEY constant, hasConsentStored helper, saveConsentStored helper
 */

/** localStorage key used to persist consent acceptance. */
export const CONSENT_STORAGE_KEY = 'native-translator-consent-v1';

/** Cookie name mirroring the localStorage key (shared between Safari and iOS PWA). */
const CONSENT_COOKIE = 'nt_consent_v1';

/**
 * Reads consent from localStorage OR the shared cookie.
 * Cookies survive iOS PWA ↔ Safari context switches; localStorage does not.
 */
export function hasConsentStored(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(CONSENT_STORAGE_KEY) === 'accepted') {
      return true;
    }
  } catch { /* localStorage blocked (private mode on some browsers) */ }
  return document.cookie.split(';').some(c => c.trim().startsWith(`${CONSENT_COOKIE}=accepted`));
}

/**
 * Persists consent in both localStorage and a 2-year cookie so it survives across
 * iOS PWA ↔ Safari context switches.
 */
export function saveConsentStored(): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'accepted');
  } catch { /* ignore if blocked */ }
  const expires = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${CONSENT_COOKIE}=accepted; expires=${expires}; path=/; SameSite=Lax`;
}
