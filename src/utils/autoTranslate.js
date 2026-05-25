/**
 * autoTranslate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Translates user-generated text (service titles, descriptions, etc.) from
 * English into Georgian (ka) and Russian (ru) using the free MyMemory API.
 *
 * Key design decisions:
 *  - All failures are logged but swallowed — a translation error must never
 *    prevent a provider from saving their service.
 *  - Calls for ka and ru run in parallel to minimise latency.
 *  - Empty / whitespace-only strings are skipped immediately.
 *  - Results are returned as JSONB-friendly objects ready to be stored in
 *    the title_translations / description_translations columns.
 *
 * MyMemory free limits:
 *   Without email : 5 000 chars / day
 *   With    email : 10 000 chars / day (set MYMEMORY_EMAIL in .env)
 */

const https = require('https');

const SUPPORTED_LANGS = ['ka', 'ru'];
const MYMEMORY_EMAIL  = process.env.MYMEMORY_EMAIL || null;
const REQUEST_TIMEOUT = 8000; // ms — bail early rather than stalling a save

/**
 * Translate a single string to the target language via MyMemory.
 * Returns the original text if the API call fails or returns an error.
 *
 * @param {string} text        - The English source text
 * @param {string} targetLang  - BCP-47 language code: 'ka' | 'ru'
 * @returns {Promise<string>}
 */
function translateText(text, targetLang) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string' || !text.trim()) {
      return resolve(text || '');
    }

    const encoded  = encodeURIComponent(text.trim());
    const langPair = `en|${targetLang}`;
    const emailQs  = MYMEMORY_EMAIL ? `&de=${encodeURIComponent(MYMEMORY_EMAIL)}` : '';
    const path     = `/get?q=${encoded}&langpair=${langPair}${emailQs}`;

    const req = https.get(
      { hostname: 'api.mymemory.translated.net', path, timeout: REQUEST_TIMEOUT },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            // MyMemory returns status 200 even for errors; check responseStatus
            if (
              json.responseStatus === 200 &&
              json.responseData?.translatedText &&
              json.responseData.translatedText !== 'INVALID LANGUAGE PAIR'
            ) {
              resolve(json.responseData.translatedText);
            } else {
              console.warn(`[autoTranslate] MyMemory status ${json.responseStatus} for lang=${targetLang}: "${text.substring(0, 40)}…"`);
              resolve(text); // fallback to original
            }
          } catch {
            resolve(text);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      console.warn(`[autoTranslate] Timeout translating to ${targetLang}: "${text.substring(0, 40)}…"`);
      resolve(text);
    });

    req.on('error', (err) => {
      console.warn(`[autoTranslate] Network error (${targetLang}):`, err.message);
      resolve(text);
    });
  });
}

/**
 * Translate title and description into all supported languages in parallel.
 * Returns an object ready to be merged into a Supabase update payload.
 *
 * @param {{ title?: string, description?: string }} fields
 * @returns {Promise<{ title_translations: object, description_translations: object }>}
 *
 * @example
 * const t = await translateFields({ title: 'Hair Braiding', description: 'Professional braiding.' });
 * // t = {
 * //   title_translations:       { ka: 'თმის წნული',      ru: 'Плетение волос' },
 * //   description_translations: { ka: 'პროფესიონალური…', ru: 'Профессиональное…' },
 * // }
 */
async function translateFields({ title = '', description = '' } = {}) {
  const titleTranslations       = {};
  const descriptionTranslations = {};

  await Promise.all(
    SUPPORTED_LANGS.map(async (lang) => {
      const [tTitle, tDesc] = await Promise.all([
        title       ? translateText(title,       lang) : Promise.resolve(''),
        description ? translateText(description, lang) : Promise.resolve(''),
      ]);
      if (tTitle)       titleTranslations[lang]       = tTitle;
      if (tDesc)        descriptionTranslations[lang] = tDesc;
    })
  );

  return {
    title_translations:       titleTranslations,
    description_translations: descriptionTranslations,
  };
}

module.exports = { translateText, translateFields };
