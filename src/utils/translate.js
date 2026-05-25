/**
 * translate.js
 * A minimal i18n helper for the Node.js backend.
 *
 * Usage:
 *   const { t } = require('./translate');
 *
 *   // Simple key lookup
 *   t('errors.unauthorized', 'en')          // → "Unauthorized."
 *
 *   // Dot-path into nested object
 *   t('notifications.trialExpired.title', 'ka')
 *
 *   // With interpolation variables
 *   t('notifications.trialWarning.title', 'en', { days: 7, plural: 's' })
 *   // → "⏳ Your Pro trial ends in 7 days"
 *
 * Supported languages: 'en', 'ka', 'ru'
 * Falls back to 'en' for any missing key or unsupported language.
 */

const path = require('path');
const I18N_DIR = path.join(__dirname, '..', 'i18n');

const locales = {
  en: require('../i18n/en.json'),
  ka: (() => { try { return require('../i18n/ka.json'); } catch { return {}; } })(),
  ru: (() => { try { return require('../i18n/ru.json'); } catch { return {}; } })(),
};

/**
 * Get a nested value from an object by dot-separated key path.
 * Returns undefined if any segment is missing.
 */
function getNestedValue(obj, keyPath) {
  return keyPath.split('.').reduce((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), obj);
}

/**
 * Interpolate {{variable}} placeholders in a string.
 */
function interpolate(str, vars) {
  if (!vars || typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : `{{${key}}}`));
}

/**
 * Translate a dot-path key into the target language.
 * Falls back to English if the key is missing in the target locale.
 * Falls back to the raw key string if not found in English either.
 *
 * @param {string} key      - Dot-separated key path, e.g. 'notifications.trialExpired.title'
 * @param {string} lang     - Target language code: 'en' | 'ka' | 'ru'
 * @param {object} [vars]   - Optional interpolation variables
 * @returns {string}
 */
function t(key, lang = 'en', vars = {}) {
  const safeLang = ['en', 'ka', 'ru'].includes(lang) ? lang : 'en';

  let value = getNestedValue(locales[safeLang], key);

  // Fall back to English
  if (value === undefined || value === '') {
    value = getNestedValue(locales.en, key);
  }

  // Fall back to the key itself
  if (value === undefined) {
    return key;
  }

  return interpolate(value, vars);
}

/**
 * Get a user's preferred language from a profile or request object.
 * Defaults to 'en' if no preference is set.
 *
 * @param {object|string} source - A user profile object with a `language` field, or a raw lang code string
 * @returns {'en'|'ka'|'ru'}
 */
function getUserLang(source) {
  if (!source) return 'en';
  const lang = typeof source === 'string' ? source : (source.language || source.preferred_language || 'en');
  return ['en', 'ka', 'ru'].includes(lang) ? lang : 'en';
}

module.exports = { t, getUserLang };
