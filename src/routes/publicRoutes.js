// src/routes/publicRoutes.js
// Public, crawlable directory of active services. The website proxies
// https://www.lifekithub.com/services to /public/services so search engines
// and AI assistants (which don't run JavaScript) can read what LifeKit offers.
// Only public listing data is exposed — provider first names, never contact
// details, emails or full profiles.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');

const SITE = 'https://www.lifekithub.com';
const APP_STORE = `${SITE}/#get-app`; // switch to the App Store link once the app is live

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'A LifeKit provider';
const excerpt = (s, n = 220) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const priceText = (svc) => {
  const p = Number(svc.price);
  if (!Number.isFinite(p) || p <= 0) return svc.is_skill_swap_available ? 'Skill swap' : 'Price on request';
  const cur = (svc.currency || 'USD').toUpperCase();
  const sym = { USD: '$', GEL: '₾', EUR: '€' }[cur] || `${cur} `;
  return `${sym}${p % 1 ? p.toFixed(2) : p}${svc.pricing_type === 'hourly' ? '/hr' : ''}`;
};

async function loadDirectory() {
  const [{ data: services, error }, { data: cats }] = await Promise.all([
    supabaseAdmin
      .from('services')
      .select('id, title, description, price, currency, pricing_type, location_text, is_skill_swap_available, average_rating, total_reviews, category_id, created_at, profiles!provider_id (full_name, status)')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(500),
    supabaseAdmin.from('service_categories').select('id, name, parent_category_id'),
  ]);
  if (error) throw error;
  const catById = new Map((cats || []).map((c) => [c.id, c]));
  const rootName = (id) => {
    let c = catById.get(id);
    for (let i = 0; c?.parent_category_id && i < 10; i++) c = catById.get(c.parent_category_id);
    return c?.name || 'Other services';
  };
  const list = (services || [])
    .filter((s) => !/^\s*\[test\]/i.test(s.title || '') && s.profiles?.status !== 'deleted')
    .map((s) => ({
      ...s,
      category: rootName(s.category_id),
      subcategory: catById.get(s.category_id)?.parent_category_id ? catById.get(s.category_id).name : null,
    }));
  const groups = new Map();
  for (const s of list) {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  }
  return { list, groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])) };
}

function jsonLd(list) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Services available on LifeKit',
    url: `${SITE}/services`,
    numberOfItems: list.length,
    itemListElement: list.map((s, i) => {
      const item = {
        '@type': 'Service',
        name: s.title,
        description: excerpt(s.description, 300),
        serviceType: s.subcategory || s.category,
        category: s.category,
        provider: { '@type': 'Person', name: firstName(s.profiles?.full_name) },
        areaServed: s.location_text || 'Georgia',
        url: `${SITE}/services#${s.id}`,
      };
      const p = Number(s.price);
      if (Number.isFinite(p) && p > 0) {
        item.offers = { '@type': 'Offer', price: p, priceCurrency: (s.currency || 'USD').toUpperCase() };
      }
      if (Number(s.total_reviews) > 0) {
        item.aggregateRating = { '@type': 'AggregateRating', ratingValue: Number(s.average_rating), reviewCount: Number(s.total_reviews) };
      }
      return { '@type': 'ListItem', position: i + 1, item };
    }),
  };
}

router.get('/services.json', async (req, res) => {
  try {
    const { list } = await loadDirectory();
    res.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    res.json({
      source: `${SITE}/services`,
      updated_at: new Date().toISOString(),
      services: list.map((s) => ({
        id: s.id,
        title: s.title,
        category: s.category,
        subcategory: s.subcategory,
        description: excerpt(s.description, 500),
        price: priceText(s),
        location: s.location_text || null,
        skill_swap: !!s.is_skill_swap_available,
        rating: Number(s.total_reviews) > 0 ? Number(s.average_rating) : null,
        reviews: Number(s.total_reviews) || 0,
        provider_first_name: firstName(s.profiles?.full_name),
      })),
    });
  } catch (e) {
    console.error('Public services json error:', e.message);
    res.status(500).json({ error: 'Directory unavailable' });
  }
});

router.get('/services', async (req, res) => {
  try {
    const { list, groups } = await loadDirectory();
    const updated = new Date().toISOString().slice(0, 10);
    const sections = groups
      .map(([cat, items]) => `
    <section>
      <h2>${esc(cat)}</h2>
      <ul>${items
        .map((s) => `
        <li id="${esc(s.id)}">
          <h3>${esc(s.title)}</h3>
          <p class="meta">${esc(priceText(s))}${s.subcategory ? ` · ${esc(s.subcategory)}` : ''}${s.location_text ? ` · ${esc(s.location_text)}` : ''}${s.is_skill_swap_available ? ' · Open to skill swap' : ''}${Number(s.total_reviews) > 0 ? ` · ★ ${Number(s.average_rating).toFixed(1)} (${Number(s.total_reviews)} reviews)` : ''}</p>
          <p>${esc(excerpt(s.description))}</p>
          <p class="by">Offered by ${esc(firstName(s.profiles?.full_name))} on LifeKit</p>
        </li>`)
        .join('')}
      </ul>
    </section>`)
      .join('');

    res.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local services on LifeKit — ${list.length} services in Georgia</title>
<meta name="description" content="Browse ${list.length} local services offered on LifeKit in Georgia: ${esc(groups.map(([c]) => c).slice(0, 8).join(', '))}. Book in the LifeKit app.">
<link rel="canonical" href="${SITE}/services">
<meta name="robots" content="index, follow">
<meta property="og:title" content="Local services on LifeKit">
<meta property="og:url" content="${SITE}/services">
<meta property="og:image" content="${SITE}/og-image.png">
<link rel="icon" href="${SITE}/icon-512.png">
<link rel="alternate" type="application/json" href="${SITE}/services.json">
<script type="application/ld+json">${JSON.stringify(jsonLd(list)).replace(/</g, '\\u003c')}</script>
<style>
  :root{--brand:#89273B;--ink:#1f1f24;--muted:#6b6b76;--line:#ece7e9;--bg:#fcfafb}
  body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
  header,main,footer{max-width:880px;margin:0 auto;padding:0 16px}
  header{padding-top:40px}
  a{color:var(--brand)}
  h1{font-size:2rem;line-height:1.2;margin:.2em 0}
  h2{margin-top:2em;padding-bottom:.3em;border-bottom:2px solid var(--line);color:var(--brand)}
  ul{list-style:none;padding:0}
  li{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 18px;margin:12px 0}
  h3{margin:0 0 4px;font-size:1.1rem}
  .meta,.by{color:var(--muted);font-size:.9rem;margin:2px 0}
  footer{padding:40px 16px;color:var(--muted);font-size:.9rem}
</style>
</head>
<body>
<header>
  <p><a href="${SITE}/">LifeKit</a></p>
  <h1>Local services on LifeKit</h1>
  <p>LifeKit is an app for finding and booking local services, joining communities and discovering places in Georgia. These are the ${list.length} services currently offered by providers on LifeKit. To book, chat with a provider or propose a skill swap, use the <a href="${APP_STORE}">LifeKit app</a>.</p>
</header>
<main>${sections || '<p>No services are listed right now.</p>'}
</main>
<footer>
  <p>Updated ${updated}. Prices are set by providers. Machine-readable version: <a href="${SITE}/services.json">services.json</a>. Want to offer a service? <a href="${SITE}/providers">Join LifeKit as a provider</a>.</p>
</footer>
</body>
</html>`);
  } catch (e) {
    console.error('Public services page error:', e.message);
    res.status(500).type('text').send('Directory temporarily unavailable.');
  }
});

module.exports = router;
