const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const authenticateToken = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Language helpers ────────────────────────────────────────────────────────
// Reads the user's preferred language from the Accept-Language header
// (sent by the Flutter app whenever the user changes language in Settings).
// Falls back to English when missing or unsupported.
const SUPPORTED_AI_LANGS = ['en', 'ka', 'ru'];

function getLang(req) {
  const raw = (req.headers['accept-language'] || '')
    .toString()
    .toLowerCase()
    .split(',')[0]
    .split('-')[0]
    .trim();
  return SUPPORTED_AI_LANGS.includes(raw) ? raw : 'en';
}

function languageName(lang) {
  switch (lang) {
    case 'ka':
      return 'Georgian (ქართული)';
    case 'ru':
      return 'Russian (Русский)';
    case 'en':
    default:
      return 'English';
  }
}

/**
 * Returns a strict instruction block that tells Gemini which language to
 * write the human-readable text in. JSON keys / enum values stay English so
 * the rest of the backend keeps parsing correctly.
 */
function languageInstruction(lang) {
  if (lang === 'en') {
    return 'Write every human-readable string in clear, natural English.';
  }
  const name = languageName(lang);
  return `IMPORTANT — LANGUAGE REQUIREMENT:
You MUST write every human-readable string value in ${name}.
This applies to ALL natural-language text inside the JSON response (e.g. "reply", "task", "reason", "description", "title", "insight", "match_reason", "label", any message shown to the user, etc.).
DO NOT translate JSON keys or enum/category values — keep those exactly as specified in the schema.
Use proper ${name} grammar, punctuation, and native phrasing. Do not mix languages inside the same sentence.`;
}

// ── Middleware: Premium AI gate ─────────────────────────────────────────────
// Allows: pro, business, OR any tier with an active trial_end_date.
// Must run after authenticateToken.
async function requirePremiumAI(req, res, next) {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('subscription_tier, trial_end_date')
      .eq('id', req.user.id)
      .single();

    if (error || !profile) {
      return res.status(403).json({
        error: 'Could not verify subscription.',
        requires_upgrade: true,
      });
    }

    const tier = (profile.subscription_tier || '').toLowerCase();
    const isTrialActive =
      profile.trial_end_date && new Date(profile.trial_end_date) > new Date();

    if (tier === 'pro' || tier === 'business' || isTrialActive) {
      return next();
    }

    return res.status(403).json({
      error: 'AI features require a Pro or Business subscription.',
      requires_upgrade: true,
    });
  } catch (err) {
    console.error('requirePremiumAI error:', err);
    return res.status(500).json({ error: 'Failed to verify subscription.' });
  }
}

// Fallback model cascade — tried in order until one succeeds
const FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
];

const SYSTEM_PROMPT = `You are an AI assistant for the LifeKit app. A user wants to create a service. Based on their prompt, generate a professional title, a matching category (from: Theatre, Sport, Festival, Tourism, Music, Food, Plumbing, Electrical, Cleaning, Laundry, Hairdressing / Braiding / Barbers, Makeup Artists, Nail Techs, Personal Chef, Grocery Shoppers & Runners, Baby sitters, Pet Sitters, Event Companions, Movers, Painter, Handyman, Tour guide, Tutors, Roommate Matching Help, Activity Partners), a suggested hourly price in USD, and a short professional description. You MUST return ONLY valid JSON in this exact format:
{
  "title": "string",
  "category": "string",
  "price": number,
  "description": "string"
}
Do not include any explanation, markdown, or extra text outside the JSON object.`;

// POST /ai/generate-service
// Protected: requires Pro or Business subscription
router.post('/generate-service', authenticateToken, requirePremiumAI, async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty prompt string is required.' });
  }

  if (prompt.length > 500) {
    return res.status(400).json({ error: 'Prompt must not exceed 500 characters.' });
  }

  try {
    const lang = getLang(req);
    const rawText = await generateWithFallback(
      `${SYSTEM_PROMPT}\n\n${languageInstruction(lang)}`,
      `User prompt: ${prompt.trim()}`,
      { json: true },
    );

    const jsonText = stripJsonFences(rawText);

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      console.error('Gemini returned non-JSON response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    const { title, category, price, description } = parsed;

    if (
      typeof title !== 'string' ||
      typeof category !== 'string' ||
      typeof price !== 'number' ||
      typeof description !== 'string'
    ) {
      console.error('Gemini response schema mismatch:', parsed);
      return res.status(502).json({ error: 'AI response did not match the expected format.' });
    }

    return res.status(200).json({ title, category, price, description });
  } catch (err) {
    console.error('Gemini API error:', err);
    return res.status(500).json({ error: 'Failed to generate service. Please try again later.' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Strip markdown code-fence wrappers that Gemini sometimes adds. */
function stripJsonFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Translate an array of plain strings into the target language via Gemini.
 * Returns the strings in the same order. On any failure, returns the original
 * inputs untouched — translation should never break the live response.
 */
async function translateStrings(strings, targetLang) {
  if (targetLang === 'en' || !Array.isArray(strings) || strings.length === 0) {
    return strings;
  }
  const name = languageName(targetLang);
  const prompt = `Translate each of the following English strings into ${name}.
Return ONLY a JSON array of translated strings, in the SAME order as the input. No markdown, no extra text.

Input:
${JSON.stringify(strings)}`;
  try {
    const raw = await generateWithFallback(
      `You are a professional translator. Translate the user-supplied strings into ${name} using natural, native phrasing. Preserve any proper nouns and product names (e.g. "LifeKit", "Gracia").`,
      prompt,
      { json: true },
    );
    const parsed = JSON.parse(stripJsonFences(raw));
    if (Array.isArray(parsed) && parsed.length === strings.length) {
      return parsed.map((s, i) => (typeof s === 'string' && s.trim() ? s : strings[i]));
    }
    return strings;
  } catch (err) {
    console.warn('[ai] translateStrings failed:', err.message);
    return strings;
  }
}

const PER_MODEL_TIMEOUT_MS = 15000;
const TOTAL_BUDGET_MS = 25000; // stay inside Vercel's function time limit

/**
 * Calls Gemini with automatic model fallback.
 * Tries each model in FALLBACK_MODELS until one succeeds, within a total
 * time budget so a slow cascade can't time out the serverless function.
 * @param {string|null} systemInstruction - Optional system prompt
 * @param {string} userPrompt - The user message / full prompt
 * @param {{ json?: boolean, models?: string[] }} opts - json: force a JSON
 *   response (Gemini JSON mode); models: override the cascade
 */
async function generateWithFallback(systemInstruction, userPrompt, opts = {}) {
  const { json = false, models = FALLBACK_MODELS } = opts;
  const started = Date.now();
  let lastError = new Error('AI unavailable');
  for (const modelName of models) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (remaining < 3000) break;
    try {
      const modelConfig = { model: modelName };
      if (systemInstruction) modelConfig.systemInstruction = systemInstruction;
      if (json) modelConfig.generationConfig = { responseMimeType: 'application/json' };

      const model = genAI.getGenerativeModel(modelConfig, {
        timeout: Math.min(PER_MODEL_TIMEOUT_MS, remaining),
      });
      const result = await model.generateContent(userPrompt);
      return result.response.text();
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Model ${modelName} failed (${error.status || error.message || 'Error'}). Trying next...`);
    }
  }
  throw lastError; // All models exhausted or out of time
}

/** Parse a model response as JSON, tolerating code fences. Returns null on failure. */
function parseJson(text) {
  try {
    return JSON.parse(stripJsonFences(text));
  } catch {
    return null;
  }
}

/** First image of a service row (services store an array in image_urls). */
function firstImage(row) {
  const urls = row?.image_urls;
  return Array.isArray(urls) && urls.length ? urls[0] : null;
}

/**
 * Keep only AI-returned items whose id exists in the data we gave the model,
 * and take display fields from the real row (never trust the model's text
 * for titles, prices or images). `lookup` maps type → Map(id → row).
 */
function validateItems(items, lookup, build) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const type = item?.type;
    const id = item?.id != null ? String(item.id) : '';
    const row = lookup[type]?.get(id);
    if (!row || seen.has(`${type}:${id}`)) continue;
    seen.add(`${type}:${id}`);
    out.push(build(type, row, item));
  }
  return out;
}

// ── POST /ai/chat ──────────────────────────────────────────────────────────
// Module 2.1 — LifeKit AI Assistant (core chat engine)
// Body: { message: string, history?: Array<{ role: 'user'|'model', text: string }> }
router.post('/chat', authenticateToken, requirePremiumAI, async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty message string is required.' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message must not exceed 2000 characters.' });
  }

  try {
    // ── 1. Fetch live platform context relevant to this message ─────────────
    // Keyword-match services/communities against the message, then top up
    // with the best-rated services so Gracia always has something to suggest.
    const words = [...new Set(
      (message.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 6),
    )];
    const svcCols = 'id, title, price, description, provider_id, image_urls, average_rating';
    const orFilter = (cols) =>
      words.flatMap((w) => cols.map((c) => `${c}.ilike.%${w}%`)).join(',');

    const [matchedSvc, topSvc, matchedGroups, someGroups] = await Promise.all([
      words.length
        ? supabaseAdmin.from('services').select(svcCols).eq('status', 'active')
            .or(orFilter(['title', 'description'])).limit(12)
        : Promise.resolve({ data: [] }),
      supabaseAdmin.from('services').select(svcCols).eq('status', 'active')
        .order('average_rating', { ascending: false, nullsFirst: false }).limit(10),
      words.length
        ? supabaseAdmin.from('groups').select('id, name, description, image_url')
            .or(orFilter(['name', 'description'])).limit(6)
        : Promise.resolve({ data: [] }),
      supabaseAdmin.from('groups').select('id, name, description, image_url').limit(6),
    ]);

    const uniq = (rows) => [...new Map((rows || []).map((r) => [String(r.id), r])).values()];
    const services = uniq([...(matchedSvc.data || []), ...(topSvc.data || [])]).slice(0, 18);
    const communities = uniq([...(matchedGroups.data || []), ...(someGroups.data || [])]).slice(0, 10);

    // Only what the model needs — keeps the prompt small and cheap.
    const svcContext = services.map((s) => ({
      id: s.id,
      provider_id: s.provider_id,
      title: s.title,
      price: s.price,
      rating: s.average_rating,
      description: (s.description || '').slice(0, 160),
    }));
    const groupContext = communities.map((g) => ({
      id: g.id,
      name: g.name,
      description: (g.description || '').slice(0, 160),
    }));

    // ── 2. Build dynamic system prompt ──────────────────────────────────────
    const lang = getLang(req);
    const systemPrompt = `You are Gracia, a warm, concise assistant for the LifeKit app — a marketplace where people book local services, offer their own skills, swap skills, and join communities.
Help users find services and communities, explain how LifeKit works (booking, wallet, skill swaps, becoming a provider), and give practical advice.
Keep replies short (2–4 sentences) unless the user asks for detail. Never invent services, prices or people.
Here is the current live data from the LifeKit platform:
SERVICES: ${JSON.stringify(svcContext)}
COMMUNITIES: ${JSON.stringify(groupContext)}

When the user asks a question, answer conversationally. If their request matches any of the provided SERVICES or COMMUNITIES, recommend at most 3 of them as actions. Only use ids that appear above.
You must respond in STRICT JSON format matching this schema:
{
  "reply": "Your conversational text response here",
  "actions": [
    { "type": "service", "id": "service-uuid-from-context", "provider_id": "provider_id-from-context", "label": "Button text (e.g. View Service)" },
    { "type": "community", "id": "community-uuid-from-context", "label": "Button text" }
  ]
}
For service actions, you MUST include the provider_id field from the service data. If no actions are relevant, return an empty array for actions.
Do not include any explanation, markdown, or extra text outside the JSON object.

${languageInstruction(lang)}`;

    // ── 3. Build conversation contents for Gemini ────────────────────────────
    // Flatten prior history into a single context prefix so we avoid complex
    // multi-turn API setup, keeping the implementation simple and free-tier safe.
    let historyContext = '';
    if (Array.isArray(history) && history.length > 0) {
      historyContext = history
        .filter((h) => h && typeof h.text === 'string')
        .slice(-12) // last 12 turns keeps the token budget small
        .map((h) => `${h.role === 'model' ? 'Assistant' : 'User'}: ${h.text.slice(0, 600)}`)
        .join('\n');
      historyContext = `\nPrevious conversation:\n${historyContext}\n`;
    }

    const userMessage = `${historyContext}\nUser: ${message.trim()}`;

    // ── 4. Call Gemini (with fallback cascade) ─────────────────────────────────────────
    const rawText = await generateWithFallback(systemPrompt, userMessage, { json: true });

    // ── 5. Parse and validate response ──────────────────────────────────────
    const parsed = parseJson(rawText);
    if (!parsed || typeof parsed.reply !== 'string') {
      console.error('Gemini /chat invalid response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    // Drop actions pointing at ids the model invented; fill details from real rows.
    const lookup = {
      service: new Map(services.map((s) => [String(s.id), s])),
      community: new Map(communities.map((g) => [String(g.id), g])),
    };
    const actions = validateItems(parsed.actions, lookup, (type, row, item) =>
      type === 'service'
        ? {
            type,
            id: row.id,
            provider_id: row.provider_id,
            label: typeof item.label === 'string' && item.label.trim() ? item.label : row.title,
            title: row.title,
            price: row.price,
            rating: row.average_rating,
            image_url: firstImage(row),
          }
        : {
            type,
            id: row.id,
            label: typeof item.label === 'string' && item.label.trim() ? item.label : row.name,
            title: row.name,
            image_url: row.image_url || null,
          },
    ).slice(0, 3);

    return res.status(200).json({ reply: parsed.reply.trim(), actions });
  } catch (err) {
    console.error('Gemini /chat error:', err);
    return res.status(500).json({ error: 'AI assistant is unavailable. Please try again later.' });
  }
});

// ── POST /ai/onboarding-plan ───────────────────────────────────────────────
// Module 2.2 — AI Onboarding Engine
// Body: { goals: string, skills: string, interests: string }
router.post('/onboarding-plan', authenticateToken, async (req, res) => {
  const { goals, skills, interests } = req.body;

  if (
    !goals || typeof goals !== 'string' || goals.trim().length === 0 ||
    !skills || typeof skills !== 'string' || skills.trim().length === 0 ||
    !interests || typeof interests !== 'string' || interests.trim().length === 0
  ) {
    return res.status(400).json({
      error: 'goals, skills, and interests are all required non-empty strings.',
    });
  }

  // ── 1. Fetch platform context ──────────────────────────────────────────────
  const [{ data: groups }, { data: categories }] = await Promise.all([
    supabaseAdmin.from('groups').select('id, name, description').limit(20),
    supabaseAdmin.from('service_categories').select('name').limit(20),
  ]);

  // NOTE: The canonical plan is always generated and stored in English so that
  // the existing `localiseOnboardingPlan` (in userRoutes) can cache per-language
  // translations against a stable source. The live response below is then
  // localised to the caller's language before returning.
  const lang = getLang(req);
  const systemPrompt = `You are the LifeKit Onboarding AI. Generate a 7-Day Success Plan for a new user.

EXISTING COMMUNITIES: ${JSON.stringify(groups ?? [])}
EXISTING CATEGORIES: ${JSON.stringify(categories ?? [])}

Rules:
1. For 'communities': if an existing community matches the user's interests, return its exact 'id' and set 'is_new' to false. If none match well, suggest a new one with 'id' set to null and 'is_new' set to true.
2. For 'plan': each task MUST include an 'action_route' field chosen EXACTLY from this list: ["profile", "create_service", "explore", "wallet", "none"].
3. For 'services_to_offer': suggest services using an existing category name where possible.

Write all human-readable strings in clear, natural English. The backend will translate them to the user's language afterwards.

You MUST return STRICT JSON matching this exact schema:
{
  "plan": [
    { "day": 1, "task": "Actionable task", "action_route": "explore" },
    { "day": 2, "task": "Actionable task", "action_route": "profile" },
    { "day": 3, "task": "Actionable task", "action_route": "create_service" },
    { "day": 4, "task": "Actionable task", "action_route": "none" },
    { "day": 5, "task": "Actionable task", "action_route": "wallet" },
    { "day": 6, "task": "Actionable task", "action_route": "none" },
    { "day": 7, "task": "Actionable task", "action_route": "none" }
  ],
  "communities": [
    { "name": "Community name", "id": "uuid-or-null", "is_new": false, "reason": "Why join or create this" }
  ],
  "services_to_offer": [
    { "title": "Service title", "category": "Category name" }
  ]
}
Do not include any explanation, markdown, or extra text outside the JSON object.`;

  const userPrompt = `Goals: ${goals.trim()}\nSkills: ${skills.trim()}\nInterests: ${interests.trim()}`;

  try {
    const rawText = await generateWithFallback(systemPrompt, userPrompt, { json: true });

    const parsed = parseJson(rawText);
    if (!parsed) {
      console.error('Gemini /onboarding-plan non-JSON response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    if (
      !Array.isArray(parsed.plan) ||
      parsed.plan.length < 7 ||
      !Array.isArray(parsed.communities) ||
      !Array.isArray(parsed.services_to_offer)
    ) {
      console.error('Gemini /onboarding-plan schema mismatch:', parsed);
      return res.status(502).json({ error: 'AI response did not match the expected format.' });
    }

    const ROUTES = new Set(['profile', 'create_service', 'explore', 'wallet', 'none']);
    parsed.plan = parsed.plan.slice(0, 7).map((d, i) => ({
      day: i + 1,
      task: typeof d?.task === 'string' ? d.task : '',
      action_route: ROUTES.has(d?.action_route) ? d.action_route : 'none',
    }));
    // A community id the model made up becomes a "start a new one" suggestion
    // instead of a link to a group that doesn't exist.
    const groupIds = new Set((groups || []).map((g) => String(g.id)));
    parsed.communities = parsed.communities.slice(0, 4).map((c) => {
      const known = c?.id != null && groupIds.has(String(c.id));
      return { ...c, id: known ? c.id : null, is_new: !known };
    });

    // Translate the live response into the caller's language (Gemini-powered).
    // The canonical English plan is what we persist, but we also seed the
    // translation cache so the next GET /users/profile in this language is
    // instant (no second translation pass).
    let livePlan = parsed.plan;
    let liveCommunities = parsed.communities;
    let liveServices = parsed.services_to_offer;
    let translationCacheForLang = null;

    if (lang !== 'en') {
      try {
        const taskStrings = parsed.plan.map((d) => d?.task || '');
        const commReasonStrings = parsed.communities.map((c) => c?.reason || '');
        const commNameStrings = parsed.communities.map((c) => c?.name || '');
        const svcTitleStrings = parsed.services_to_offer.map((s) => s?.title || '');

        const [tTasks, tReasons, tCommNames, tSvcTitles] = await Promise.all([
          translateStrings(taskStrings, lang),
          translateStrings(commReasonStrings, lang),
          translateStrings(commNameStrings, lang),
          translateStrings(svcTitleStrings, lang),
        ]);

        livePlan = parsed.plan.map((d, i) => ({ ...d, task: tTasks[i] }));
        liveCommunities = parsed.communities.map((c, i) => ({
          ...c,
          name: tCommNames[i],
          reason: tReasons[i],
        }));
        liveServices = parsed.services_to_offer.map((s, i) => ({
          ...s,
          title: tSvcTitles[i],
        }));
        translationCacheForLang = livePlan; // matches schema used by localiseOnboardingPlan
      } catch (translateErr) {
        console.warn('[ai] onboarding-plan live translation failed:', translateErr.message);
      }
    }

    // Persist canonical English plan + (optionally) seed translation cache.
    const updatePayload = { onboarding_plan: parsed.plan };
    if (translationCacheForLang) {
      updatePayload.onboarding_plan_translations = { [lang]: translationCacheForLang };
    }
    supabaseAdmin
      .from('profiles')
      .update(updatePayload)
      .eq('id', req.user.id)
      .then(({ error }) => {
        if (error) console.error('Failed to save onboarding_plan:', error.message);
      });

    return res.status(200).json({
      plan: livePlan,
      communities: liveCommunities,
      services_to_offer: liveServices,
    });
  } catch (err) {
    console.error('Gemini /onboarding-plan error:', err);
    return res.status(500).json({ error: 'Failed to generate onboarding plan. Please try again later.' });
  }
});

// ── GET /ai/opportunities ──────────────────────────────────────────────────
// Module 2.3 — AI Opportunity Engine
// Returns AI-identified market gaps based on the user's skills vs. platform trends.
router.get('/opportunities', authenticateToken, requirePremiumAI, async (req, res) => {
  const userId = req.user.id; // set by authenticateToken middleware

  try {
    // ── 1. What the user can do: bio + the services they already offer ──────
    // (profiles has no skills/city columns — skills come from their listings)
    const [{ data: profile, error: profileError }, { data: myServices }, { data: categories }] =
      await Promise.all([
        supabaseAdmin.from('profiles').select('bio, country').eq('id', userId).single(),
        supabaseAdmin.from('services').select('title, category_id').eq('provider_id', userId).limit(20),
        supabaseAdmin.from('service_categories').select('id, name').limit(40),
      ]);

    if (profileError) {
      console.error('Opportunities: profile fetch error:', profileError.message);
    }

    const offered = (myServices || []).map((s) => s.title).filter(Boolean);
    const userSkills = [
      profile?.bio?.trim(),
      offered.length ? `Already offers: ${offered.join(', ')}` : null,
    ].filter(Boolean).join('. ') || 'General skills not specified';

    const userLocation = profile?.country || 'Location not specified';

    // ── 2. Categories they don't offer yet (platform trends) ────────────────
    const offeredCats = new Set((myServices || []).map((s) => String(s.category_id)));
    const openCats = (categories || []).filter((c) => !offeredCats.has(String(c.id)));

    const categoriesList =
      openCats.length > 0
        ? openCats.map((c) => c.name).join(', ')
        : 'Cleaning, Tutoring, Hairdressing, Plumbing, Personal Chef, Pet Sitting, Laundry, Handyman, Grocery Shopping, Event Companion';

    // ── 3. Build Gemini prompt ───────────────────────────────────────────────
    const lang = getLang(req);
    const systemPrompt = `You are the LifeKit Market Analyst. Your job is to help service providers find new ways to earn.
I will provide you with the User's Skills, their Location, and the current Platform Trends.
Compare them and find 'Market Gaps'—services the user is capable of offering but hasn't listed yet.
If the user has no specific skills listed, use their location to suggest the most high-demand, easy-to-start services in that area.

User Skills: ${userSkills}
User Location: ${userLocation}
Platform Trends (categories users are browsing most): ${categoriesList}

You MUST return STRICT JSON in this exact format:
{
  "opportunities": [
    {
      "title": "Service Name",
      "category": "Exact category name from the Platform Trends list above",
      "demand_level": "High" | "Medium",
      "reason": "Why this is a good match for this user",
      "suggested_price": "Price range in USD"
    }
  ]
}
The "category" field MUST exactly match one of the category names from the Platform Trends list (keep this value in English — it's an identifier).
The "demand_level" field must stay exactly "High" or "Medium" (English enum).
Return between 3 and 6 opportunities. Do not include any explanation, markdown, or extra text outside the JSON object.

${languageInstruction(lang)}`;

    // ── 4. Call Gemini (with fallback cascade) ─────────────────────────────────────────
    const rawText = await generateWithFallback(null, systemPrompt, { json: true });

    // ── 5. Parse and validate ────────────────────────────────────────
    const parsed = parseJson(rawText);
    if (!parsed) {
      console.error('Gemini /opportunities non-JSON response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    if (!Array.isArray(parsed.opportunities)) {
      console.error('Gemini /opportunities schema mismatch:', parsed);
      return res.status(502).json({ error: 'AI response did not match the expected format.' });
    }

    return res.status(200).json({ opportunities: parsed.opportunities });
  } catch (err) {
    console.error('Gemini /opportunities error:', err);
    return res.status(500).json({ error: 'Failed to fetch opportunities. Please try again later.' });
  }
});

// ── GET /ai/discovery ──────────────────────────────────────────────────────
// Module 2.5 & 2.6 — Daily Discovery & Personalised Recommendations
// Returns 3 AI-curated items (event, service, or community) tailored to the user.
router.get('/discovery', authenticateToken, requirePremiumAI, async (req, res) => {
  const userId = req.user.id;

  try {
    // ── 1. Gather global context in parallel ─────────────────────────────────
    const [
      { data: profile },
      { data: events },
      { data: groups },
      { data: services },
      { data: myServices },
      { data: myBookings },
    ] = await Promise.all([
      supabaseAdmin.from('profiles').select('bio').eq('id', userId).single(),
      supabaseAdmin
        .from('events')
        .select('id, title, location, event_date, image_url')
        .eq('is_active', true)
        .gte('event_date', new Date().toISOString())
        .order('event_date', { ascending: true })
        .limit(12),
      supabaseAdmin.from('groups').select('id, name, description, image_url').limit(10),
      supabaseAdmin
        .from('services')
        .select('id, title, provider_id, image_urls, price, average_rating')
        .eq('status', 'active')
        .neq('provider_id', userId)
        .order('average_rating', { ascending: false, nullsFirst: false })
        .limit(15),
      supabaseAdmin.from('services').select('title').eq('provider_id', userId).limit(10),
      supabaseAdmin.from('bookings').select('services(title)').eq('client_id', userId)
        .order('created_at', { ascending: false }).limit(10),
    ]);

    // profiles has no "interests" column — infer them from what the user
    // writes about themselves, offers, and has booked before.
    const booked = (myBookings || []).map((b) => b.services?.title).filter(Boolean);
    const offers = (myServices || []).map((s) => s.title).filter(Boolean);
    const userInterests = [
      profile?.bio?.trim(),
      offers.length ? `Offers: ${offers.join(', ')}` : null,
      booked.length ? `Has booked: ${[...new Set(booked)].join(', ')}` : null,
    ].filter(Boolean).join('. ') || 'General interests not specified';

    const eventCtx = (events || []).map((e) => ({ id: e.id, title: e.title, location: e.location, date: e.event_date }));
    const groupCtx = (groups || []).map((g) => ({ id: g.id, name: g.name, description: (g.description || '').slice(0, 140) }));
    const svcCtx = (services || []).map((s) => ({ id: s.id, title: s.title, price: s.price, rating: s.average_rating }));

    // ── 2. Build system prompt ────────────────────────────────────────────────
    const lang = getLang(req);
    const systemPrompt = `You are the LifeKit Concierge. Your goal is to provide a 'Daily Discovery' list for the user.
Based on the user's profile and the platform data provided, pick the 3 best things (can be an Event, a Service, or a Community) for them right now.
Write a short 'Why for you' reason for each (e.g., 'Since you like music, this jazz event is perfect').

USER INTERESTS: ${userInterests}
PLATFORM EVENTS (upcoming): ${JSON.stringify(eventCtx)}
PLATFORM GROUPS: ${JSON.stringify(groupCtx)}
PLATFORM SERVICES: ${JSON.stringify(svcCtx)}

You MUST return STRICT JSON in this exact format:
{
  "recommendations": [
    { "type": "event" | "service" | "community", "id": "uuid", "reason": "Personalized reason" }
  ]
}
Return exactly 3 recommendations, preferring a mix of types when it makes sense. Only reference ids that appear in the data above. The "type" value must stay exactly "event", "service" or "community" (English enum). Do not include any explanation, markdown, or extra text outside the JSON object.

${languageInstruction(lang)}
NOTE: Use the original title from the data when copying it (don't translate proper names of events / communities), but the "reason" field MUST be written in the user's language.`;

    // ── 3. Call Gemini (with fallback cascade) ─────────────────────────────────────────
    const rawText = await generateWithFallback(null, systemPrompt, { json: true });

    // ── 4. Parse and validate ────────────────────────────────────────
    const parsed = parseJson(rawText);
    if (!parsed || !Array.isArray(parsed.recommendations)) {
      console.error('Gemini /discovery invalid response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    const lookup = {
      event: new Map((events || []).map((e) => [String(e.id), e])),
      community: new Map((groups || []).map((g) => [String(g.id), g])),
      service: new Map((services || []).map((s) => [String(s.id), s])),
    };
    const recommendations = validateItems(parsed.recommendations, lookup, (type, row, item) => ({
      type,
      id: row.id,
      provider_id: type === 'service' ? row.provider_id : null,
      title: type === 'community' ? row.name : row.title,
      reason: typeof item.reason === 'string' ? item.reason : '',
      image_url: type === 'service' ? firstImage(row) : row.image_url || null,
      price: type === 'service' ? row.price : undefined,
      date: type === 'event' ? row.event_date : undefined,
    })).slice(0, 3);

    return res.status(200).json({ recommendations });
  } catch (err) {
    console.error('Gemini /discovery error:', err);
    return res.status(500).json({ error: 'Failed to fetch discovery recommendations. Please try again later.' });
  }
});

// ── POST /ai/city-pulse ────────────────────────────────────────────────────
// Module 2.5/2.7 — AI City Pulse & Notification Injection
// Body: { lat, lng, city, local_time }
router.post('/city-pulse', authenticateToken, async (req, res) => {
  const { lat, lng, city, local_time } = req.body;
  const userId = req.user.id;

  if (!city || typeof city !== 'string' || city.trim().length === 0) {
    return res.status(400).json({ error: 'city is required.' });
  }

  if (!local_time || typeof local_time !== 'string') {
    return res.status(400).json({ error: 'local_time is required.' });
  }

  // One pulse per user per day: reuse today's insight instead of calling
  // Gemini again and inserting (and pushing) another notification.
  try {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { data: today, error: todayErr } = await supabaseAdmin
      .from('notifications')
      .select('message')
      .eq('user_id', userId)
      .eq('type', 'ai_city_pulse')
      .gte('created_at', dayStart.toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (todayErr) console.error('City pulse dedupe lookup failed:', todayErr.message);
    if (today && today.length) {
      return res.status(200).json({
        insight: today[0].message,
        category_suggestion: 'Tourism', // the chip is only a hint
        cached: true,
      });
    }
  } catch (_) {
    // Fall through and generate a fresh one.
  }

  // Fetch user bio for personalisation (non-critical — fallback to empty string)
  let userBio = '';
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('bio')
      .eq('id', userId)
      .single();
    userBio = profile?.bio?.trim() || '';
  } catch (_) {}

  const lang = getLang(req);
  const systemPrompt = `You are the LifeKit City Guide. I will provide a user's location, local time, and their profile.
Generate a short (max 2 sentences), punchy 'Daily Insight' for the user.
If it's morning, suggest starting the day. If it's evening, suggest relaxing or events.
Always tie it back to their location.

USER PROFILE: ${userBio || 'Not provided'}
LOCATION: ${city.trim()}
LOCAL TIME: ${local_time.trim()}

Return ONLY valid JSON in this exact format:
{ "insight": "...", "category_suggestion": "You MUST pick EXACTLY ONE from this list: 'Tourism', 'Food', 'Event', 'Hair', 'Health', 'Tech', 'Cleaning', 'Laundry', 'Plumbing'. Do not invent new categories." }
The "category_suggestion" value MUST remain in English (it's used as an identifier). The "insight" field is shown to the user.
Do not include markdown, code fences, or any explanation outside the JSON object.

${languageInstruction(lang)}`;

  try {
    const rawText = await generateWithFallback(null, systemPrompt, { json: true });

    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(rawText));
    } catch {
      console.error('Gemini /city-pulse non-JSON:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    if (typeof parsed.insight !== 'string' || typeof parsed.category_suggestion !== 'string') {
      console.error('Gemini /city-pulse schema mismatch:', parsed);
      return res.status(502).json({ error: 'AI response did not match the expected format.' });
    }

    // Module 2.7 — Persist insight as a notification (fire-and-forget)
    const notifTitle = lang === 'ka'
      ? '✨ ქალაქის პულსი'
      : lang === 'ru'
        ? '✨ Пульс города'
        : '✨ City Pulse';
    supabaseAdmin
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'ai_city_pulse',
        title: notifTitle,
        message: parsed.insight,
        is_read: false,
      })
      .then(({ error }) => {
        if (error) console.error('Failed to insert city pulse notification:', error.message);
      });

    return res.status(200).json({
      insight: parsed.insight,
      category_suggestion: parsed.category_suggestion,
    });
  } catch (err) {
    console.error('Gemini /city-pulse error:', err);
    return res.status(500).json({ error: 'Failed to generate city pulse. Please try again later.' });
  }
});

// ── POST /ai/skill-swap-matches ─────────────────────────────────────────────
// AI Bi-directional Skill Swap Matcher
// Body: { my_service_id, target_category_id }
// Returns candidates ranked by AI with a match_reason and match_score (0-100)
router.post('/skill-swap-matches', authenticateToken, requirePremiumAI, async (req, res) => {
  const userId = req.user.id;
  const { my_service_id, target_category_id } = req.body;

  if (!my_service_id || !target_category_id) {
    return res.status(400).json({ error: 'my_service_id and target_category_id are required.' });
  }

  try {
    // 1. Fetch my offered service (lookup by ID only, verify ownership in code)
    const { data: myService, error: myErr } = await supabaseAdmin
      .from('services')
      .select('id, title, description, price, category_id, sub_category_id, provider_id')
      .eq('id', my_service_id)
      .single();

    if (myErr || !myService || myService.provider_id !== userId) {
      return res.status(404).json({ error: 'Your service was not found.' });
    }

    // 2. Fetch all active swap-available services in the target category (exclude self)
    // Search both category_id and sub_category_id since either may be set
    const { data: candidates, error: candErr } = await supabaseAdmin
      .from('services')
      .select('id, title, description, price, provider_id, image_urls, average_rating, profiles(id, full_name, profile_picture_url, bio)')
      .or(`category_id.eq.${target_category_id},sub_category_id.eq.${target_category_id}`)
      .eq('status', 'active')
      .eq('is_skill_swap_available', true)
      .neq('provider_id', userId)
      .limit(20);

    if (candErr) throw candErr;

    if (!candidates || candidates.length === 0) {
      return res.status(200).json({ matches: [] });
    }

    // 3. Ask AI to rank and score the candidates
    const lang = getLang(req);
    const systemPrompt = `You are a Skill Swap matching engine for the LifeKit service marketplace.
Your job is to rank a list of candidate services against the user's offered skill and return a JSON array.
For each candidate, provide a match_score (0-100) where 100 means perfect complementary match, and a short match_reason (1 sentence).
Consider: complementarity, price parity, and skill relevance.
Return ONLY a JSON array in this exact format — no markdown, no extra text:
[
  { "service_id": "uuid", "match_score": number, "match_reason": "string" },
  ...
]

${languageInstruction(lang)}
Reminder: the "match_reason" field is the only human-readable string — write it in the user's language.`;

    const userPrompt = `My offered service:
Title: ${myService.title}
Description: ${myService.description || 'N/A'}
Price: $${myService.price}

Candidate services I could receive in exchange:
${candidates.map((c, i) => `${i + 1}. [${c.id}] "${c.title}" — ${c.description || 'No description'} — $${c.price}`).join('\n')}

Rank all candidates from most to least suitable for a skill swap.`;

    const rawText = await generateWithFallback(systemPrompt, userPrompt, { json: true });
    const jsonText = stripJsonFences(rawText);

    const fallbackReason = lang === 'ka'
      ? 'შესაძლო თავსებადობა'
      : lang === 'ru'
        ? 'Возможное соответствие'
        : 'Potential match';

    let rankingArray;
    try {
      rankingArray = JSON.parse(jsonText);
      if (!Array.isArray(rankingArray)) throw new Error('Not an array');
    } catch {
      // Fallback: return candidates unranked
      rankingArray = candidates.map((c) => ({ service_id: c.id, match_score: 50, match_reason: fallbackReason }));
    }

    // 4. Merge AI rankings back into candidate objects
    const scoreMap = {};
    rankingArray.forEach(r => { scoreMap[r.service_id] = r; });

    const ranked = candidates
      .map(c => ({
        ...c,
        match_score: scoreMap[c.id]?.match_score ?? 50,
        match_reason: scoreMap[c.id]?.match_reason ?? fallbackReason,
      }))
      .sort((a, b) => b.match_score - a.match_score);

    return res.status(200).json({ matches: ranked });
  } catch (err) {
    console.error('POST /ai/skill-swap-matches error:', err);
    return res.status(500).json({ error: 'Failed to fetch AI matches.' });
  }
});

// ── POST /ai/generate-swap-proposal ──────────────────────────────────────
// AI Swap Proposal Generator — Pro/Business only
// Body: { my_service_title, target_service_title, target_user_name }
router.post('/generate-swap-proposal', authenticateToken, requirePremiumAI, async (req, res) => {
  const { my_service_title, target_service_title, target_user_name } = req.body;

  if (
    !my_service_title || typeof my_service_title !== 'string' ||
    !target_service_title || typeof target_service_title !== 'string' ||
    !target_user_name || typeof target_user_name !== 'string'
  ) {
    return res.status(400).json({
      error: 'my_service_title, target_service_title, and target_user_name are required strings.',
    });
  }

  const myTitle = my_service_title.trim().slice(0, 100);
  const targetTitle = target_service_title.trim().slice(0, 100);
  const targetName = target_user_name.trim().slice(0, 60);

  if (!myTitle || !targetTitle || !targetName) {
    return res.status(400).json({ error: 'All fields must be non-empty strings.' });
  }

  const lang = getLang(req);
  const langName = languageName(lang);
  const langDirective = lang === 'en'
    ? ''
    : `\nWrite the entire message in ${langName} using natural, native phrasing. Do not include any English words.`;

  const prompt = `Write a friendly, professional, 2-sentence direct message proposing a skill swap. I am offering "${myTitle}" and I want their "${targetTitle}". Address it to ${targetName}. Keep it casual but persuasive. Return ONLY the message text — no subject line, no labels, no quotes around the message.${langDirective}`;

  try {
    const text = await generateWithFallback(null, prompt);
    return res.status(200).json({ proposal: text.trim() });
  } catch (err) {
    console.error('POST /ai/generate-swap-proposal error:', err);
    return res.status(500).json({ error: 'Failed to generate proposal. Please try again.' });
  }
});

// ── GET /ai/greeting ───────────────────────────────────────────────────────
// Short personalised hello for the home-screen bubble. Open to every user
// (the app caches it for the day), so it uses the cheapest model and a tiny
// prompt. Query: ?hour=0-23 (user's local hour).
router.get('/greeting', authenticateToken, async (req, res) => {
  const lang = getLang(req);
  const hour = Math.min(23, Math.max(0, parseInt(req.query.hour, 10) || 12));
  const partOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('full_name')
      .eq('id', req.user.id)
      .single();
    const firstName = (profile?.full_name || '').trim().split(/\s+/)[0] || '';

    const prompt = `Write ONE short, warm ${partOfDay} greeting (max 18 words) from Gracia, the assistant in LifeKit — an app to book local services, offer your skills, swap skills and join communities.
${firstName ? `Address the user by first name: ${firstName}.` : ''}
Optionally include one practical, specific tip about using LifeKit. At most one emoji. Return only the greeting text, no quotes.
${languageInstruction(lang)}`;

    const text = await generateWithFallback(null, prompt, {
      models: ['gemini-flash-lite-latest', 'gemini-flash-latest'],
    });
    const message = text.trim().replace(/^["“]|["”]$/g, '').slice(0, 220);
    if (!message) throw new Error('empty greeting');
    return res.status(200).json({ message });
  } catch (err) {
    console.error('GET /ai/greeting error:', err.message);
    return res.status(500).json({ error: 'Greeting unavailable.' });
  }
});

module.exports = router;
