const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const authenticateToken = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
console.log("DEBUG: Gemini API Key loaded:", !!process.env.GEMINI_API_KEY);

// Fallback model cascade — tried in order until one succeeds
const FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
];

// DEBUG: List all available Gemini models at startup via REST API
(async () => {
  try {
    const https = require('https');
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const names = (parsed.models || []).map((m) => m.name);
          console.log("DEBUG: Available Gemini models:", names);
        } catch {
          console.error("DEBUG: Could not parse model list response.");
        }
      });
    }).on('error', (err) => {
      console.error("DEBUG: Failed to list Gemini models:", err.message);
    });
  } catch (err) {
    console.error("DEBUG: Failed to list Gemini models:", err.message);
  }
})();

const SYSTEM_PROMPT = `You are an AI assistant for the LifeKit app. A user wants to create a service. Based on their prompt, generate a professional title, a matching category (from: Theatre, Sport, Festival, Tourism, Music, Food, Plumbing, Electrical, Cleaning, Laundry, Hairdressing / Braiding / Barbers, Makeup Artists, Nail Techs, Personal Chef, Grocery Shoppers & Runners, Baby sitters, Pet Sitters, Event Companions, Movers, Painter, Handyman, Tour guide, Tutors, Roommate Matching Help, Activity Partners), a suggested hourly price in USD, and a short professional description. You MUST return ONLY valid JSON in this exact format:
{
  "title": "string",
  "category": "string",
  "price": number,
  "description": "string"
}
Do not include any explanation, markdown, or extra text outside the JSON object.`;

// POST /ai/generate-service
// Protected: requires a valid JWT
router.post('/generate-service', authenticateToken, async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty prompt string is required.' });
  }

  if (prompt.length > 500) {
    return res.status(400).json({ error: 'Prompt must not exceed 500 characters.' });
  }

  try {
    const rawText = await generateWithFallback(
      SYSTEM_PROMPT,
      `User prompt: ${prompt.trim()}`
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
 * Calls Gemini with automatic model fallback.
 * Tries each model in FALLBACK_MODELS until one succeeds.
 * @param {string|null} systemInstruction - Optional system prompt
 * @param {string} userPrompt - The user message / full prompt
 * @param {Array} history - Optional chat history for multi-turn
 */
async function generateWithFallback(systemInstruction, userPrompt, history = []) {
  let lastError;
  for (const modelName of FALLBACK_MODELS) {
    try {
      const modelConfig = { model: modelName };
      if (systemInstruction) modelConfig.systemInstruction = systemInstruction;

      const model = genAI.getGenerativeModel(modelConfig);

      let result;
      if (history && history.length > 0) {
        const chat = model.startChat({ history });
        result = await chat.sendMessage(userPrompt);
      } else {
        result = await model.generateContent(userPrompt);
      }

      console.log(`✅ Success using model: ${modelName}`);
      return result.response.text();
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Model ${modelName} failed (${error.status || error.message || 'Error'}). Trying next...`);
    }
  }
  throw lastError; // All models exhausted
}

// ── POST /ai/chat ──────────────────────────────────────────────────────────
// Module 2.1 — LifeKit AI Assistant (core chat engine)
// Body: { message: string, history?: Array<{ role: 'user'|'model', text: string }> }
router.post('/chat', authenticateToken, async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty message string is required.' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message must not exceed 2000 characters.' });
  }

  try {
    // ── 1. Fetch live platform context (Zero-Budget Context Injection) ──────
    const [{ data: services }, { data: communities }] = await Promise.all([
      supabaseAdmin
        .from('services')
        .select('id, title, price, description, provider_id, image_urls')
        .eq('status', 'active')
        .limit(15),
      supabaseAdmin
        .from('groups')
        .select('id, name, description')
        .limit(10),
    ]);

    // ── 2. Build dynamic system prompt ──────────────────────────────────────
    const systemPrompt = `You are LifeKit AI, a helpful, conversational assistant for the LifeKit app. Your goal is to help users find services, communities, and navigate the city.
Here is the current live data from the LifeKit platform:
SERVICES: ${JSON.stringify(services ?? [])}
COMMUNITIES: ${JSON.stringify(communities ?? [])}

When the user asks a question, answer conversationally. If their request matches any of the provided SERVICES or COMMUNITIES, you MUST recommend them.
You must respond in STRICT JSON format matching this schema:
{
  "reply": "Your conversational text response here",
  "actions": [
    { "type": "service", "id": "service-uuid-from-context", "provider_id": "provider_id-from-context", "label": "Button text (e.g. View Service)" },
    { "type": "community", "id": "community-uuid-from-context", "label": "Button text" }
  ]
}
For service actions, you MUST include the provider_id field from the service data. If no actions are relevant, return an empty array for actions.
Do not include any explanation, markdown, or extra text outside the JSON object.`;

    // ── 3. Build conversation contents for Gemini ────────────────────────────
    // Flatten prior history into a single context prefix so we avoid complex
    // multi-turn API setup, keeping the implementation simple and free-tier safe.
    let historyContext = '';
    if (Array.isArray(history) && history.length > 0) {
      historyContext = history
        .slice(-10) // cap to last 10 exchanges to stay within token budget
        .map((h) => `${h.role === 'model' ? 'Assistant' : 'User'}: ${h.text}`)
        .join('\n');
      historyContext = `\nPrevious conversation:\n${historyContext}\n`;
    }

    const userMessage = `${historyContext}\nUser: ${message.trim()}`;

    // ── 4. Call Gemini (with fallback cascade) ─────────────────────────────────────────
    const rawText = await generateWithFallback(systemPrompt, userMessage);

    // ── 5. Parse and validate response ──────────────────────────────────────
    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(rawText));
    } catch {
      console.error('Gemini /chat non-JSON response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    if (typeof parsed.reply !== 'string' || !Array.isArray(parsed.actions)) {
      console.error('Gemini /chat schema mismatch:', parsed);
      return res.status(502).json({ error: 'AI response did not match the expected format.' });
    }

    return res.status(200).json({ reply: parsed.reply, actions: parsed.actions });
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

  const systemPrompt = `You are the LifeKit Onboarding AI. Generate a 7-Day Success Plan for a new user.

EXISTING COMMUNITIES: ${JSON.stringify(groups ?? [])}
EXISTING CATEGORIES: ${JSON.stringify(categories ?? [])}

Rules:
1. For 'communities': if an existing community matches the user's interests, return its exact 'id' and set 'is_new' to false. If none match well, suggest a new one with 'id' set to null and 'is_new' set to true.
2. For 'plan': each task MUST include an 'action_route' field chosen EXACTLY from this list: ["profile", "create_service", "explore", "wallet", "none"].
3. For 'services_to_offer': suggest services using an existing category name where possible.

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
    const rawText = await generateWithFallback(systemPrompt, userPrompt);

    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(rawText));
    } catch {
      console.error('Gemini /onboarding-plan non-JSON response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    if (
      !Array.isArray(parsed.plan) ||
      parsed.plan.length !== 7 ||
      !Array.isArray(parsed.communities) ||
      !Array.isArray(parsed.services_to_offer)
    ) {
      console.error('Gemini /onboarding-plan schema mismatch:', parsed);
      return res.status(502).json({ error: 'AI response did not match the expected format.' });
    }

    // Persist plan to user's profile (fire-and-forget, non-blocking)
    supabaseAdmin
      .from('profiles')
      .update({ onboarding_plan: parsed.plan })
      .eq('id', req.user.id)
      .then(({ error }) => {
        if (error) console.error('Failed to save onboarding_plan:', error.message);
      });

    return res.status(200).json({
      plan: parsed.plan,
      communities: parsed.communities,
      services_to_offer: parsed.services_to_offer,
    });
  } catch (err) {
    console.error('Gemini /onboarding-plan error:', err);
    return res.status(500).json({ error: 'Failed to generate onboarding plan. Please try again later.' });
  }
});

// ── GET /ai/opportunities ──────────────────────────────────────────────────
// Module 2.3 — AI Opportunity Engine
// Returns AI-identified market gaps based on the user's skills vs. platform trends.
router.get('/opportunities', authenticateToken, async (req, res) => {
  const userId = req.user.id; // set by authenticateToken middleware

  try {
    // ── 1. Fetch user profile (skills + bio) ────────────────────────────────
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('bio, skills')
      .eq('id', userId)
      .single();

    if (profileError) {
      console.error('Opportunities: profile fetch error:', profileError);
    }

    const userSkills =
      profile?.skills ||
      profile?.bio ||
      'General skills not specified';

    // ── 2. Fetch top service categories (platform trends) ──────────────────
    const { data: categories, error: catError } = await supabaseAdmin
      .from('service_categories')
      .select('name')
      .limit(10);

    if (catError) {
      console.error('Opportunities: categories fetch error:', catError);
    }

    const categoriesList =
      Array.isArray(categories) && categories.length > 0
        ? categories.map((c) => c.name).join(', ')
        : 'Cleaning, Tutoring, Hairdressing, Plumbing, Personal Chef, Pet Sitting, Laundry, Handyman, Grocery Shopping, Event Companion';

    // ── 3. Build Gemini prompt ───────────────────────────────────────────────
    const systemPrompt = `You are the LifeKit Market Analyst. Your job is to help service providers find new ways to earn.
I will provide you with the User's Skills and the current Platform Trends.
Compare them and find 'Market Gaps'—services the user is capable of offering but hasn't listed yet.

User Skills: ${userSkills}
Platform Trends (categories users are browsing most): ${categoriesList}

You MUST return STRICT JSON in this exact format:
{
  "opportunities": [
    {
      "title": "Service Name",
      "demand_level": "High" | "Medium",
      "reason": "Why this is a good match for this user",
      "suggested_price": "Price range in USD"
    }
  ]
}
Return between 3 and 6 opportunities. Do not include any explanation, markdown, or extra text outside the JSON object.`;

    // ── 4. Call Gemini (with fallback cascade) ─────────────────────────────────────────
    const rawText = await generateWithFallback(null, systemPrompt);

    // ── 5. Parse and validate ────────────────────────────────────────
    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(rawText));
    } catch {
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
router.get('/discovery', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // ── 1. Gather global context in parallel ─────────────────────────────────
    const [
      { data: profile },
      { data: events },
      { data: groups },
      { data: services },
    ] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('bio, interests')
        .eq('id', userId)
        .single(),
      supabaseAdmin
        .from('events')
        .select('id, title, location, date, image_url')
        .eq('status', 'active')
        .limit(15),
      supabaseAdmin
        .from('groups')
        .select('id, name, description, image_url')
        .limit(10),
      supabaseAdmin
        .from('services')
        .select('id, title, category, provider_id, image_url')
        .eq('status', 'active')
        .limit(10),
    ]);

    const userInterests =
      profile?.interests || profile?.bio || 'General interests not specified';

    // ── 2. Build system prompt ────────────────────────────────────────────────
    const systemPrompt = `You are the LifeKit Concierge. Your goal is to provide a 'Daily Discovery' list for the user.
Based on the user's profile and the platform data provided, pick the 3 best things (can be an Event, a Service, or a Community) for them right now.
Write a short 'Why for you' reason for each (e.g., 'Since you like music, this jazz event is perfect').

USER INTERESTS: ${userInterests}
PLATFORM EVENTS: ${JSON.stringify(events ?? [])}
PLATFORM GROUPS: ${JSON.stringify(groups ?? [])}
PLATFORM SERVICES: ${JSON.stringify(services ?? [])}

You MUST return STRICT JSON in this exact format:
{
  "recommendations": [
    {
      "type": "event" | "service" | "community",
      "id": "uuid",
      "provider_id": "provider_id from service data (only for type service, otherwise null)",
      "title": "Name of the item",
      "reason": "Personalized reason",
      "image_url": "the image_url from the data provided"
    }
  ]
}
Return exactly 3 recommendations. Only reference items whose IDs appear in the data provided above. For service type items, you MUST include the provider_id from the service data. Do not include any explanation, markdown, or extra text outside the JSON object.`;

    // ── 3. Call Gemini (with fallback cascade) ─────────────────────────────────────────
    const rawText = await generateWithFallback(null, systemPrompt);

    // ── 4. Parse and validate ────────────────────────────────────────
    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(rawText));
    } catch {
      console.error('Gemini /discovery non-JSON response:', rawText);
      return res.status(502).json({ error: 'AI returned an invalid response. Please try again.' });
    }

    if (!Array.isArray(parsed.recommendations)) {
      console.error('Gemini /discovery schema mismatch:', parsed);
      return res.status(502).json({ error: 'AI response did not match the expected format.' });
    }

    return res.status(200).json({ recommendations: parsed.recommendations });
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

  const systemPrompt = `You are the LifeKit City Guide. I will provide a user's location, local time, and their profile.
Generate a short (max 2 sentences), punchy 'Daily Insight' for the user.
If it's morning, suggest starting the day. If it's evening, suggest relaxing or events.
Always tie it back to their location.

USER PROFILE: ${userBio || 'Not provided'}
LOCATION: ${city.trim()}
LOCAL TIME: ${local_time.trim()}

Return ONLY valid JSON in this exact format:
{ "insight": "...", "category_suggestion": "You MUST pick EXACTLY ONE from this list: 'Tourism', 'Food', 'Event', 'Hair', 'Health', 'Tech', 'Cleaning', 'Laundry', 'Plumbing'. Do not invent new categories." }
Do not include markdown, code fences, or any explanation outside the JSON object.`;

  try {
    const rawText = await generateWithFallback(null, systemPrompt);

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
    supabaseAdmin
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'ai_city_pulse',
        title: '✨ City Pulse',
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

module.exports = router;
