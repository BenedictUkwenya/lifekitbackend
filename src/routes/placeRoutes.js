const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../config/supabase');

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

/** Haversine distance in km between two lat/lng points */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Map OSM amenity tag → readable category */
function resolveCategory(tags) {
  const a = tags.amenity || '';
  const t = tags.tourism || '';
  const s = tags.shop || '';
  const l = tags.leisure || '';

  if (a === 'restaurant') return 'Restaurant';
  if (a === 'fast_food') return 'Fast Food';
  if (a === 'cafe') return 'Café';
  if (a === 'bar' || a === 'pub') return 'Bar & Pub';
  if (a === 'hotel' || t === 'hotel' || t === 'guest_house') return 'Hotel';
  if (t === 'attraction' || t === 'museum') return 'Attraction';
  if (a === 'hospital' || a === 'clinic' || a === 'pharmacy') return 'Health';
  if (a === 'bank' || a === 'atm') return 'Finance';
  if (a === 'fuel') return 'Fuel Station';
  if (a === 'place_of_worship') return 'Worship';
  if (s) return 'Shop';
  if (l === 'park' || l === 'garden') return 'Park';
  return 'Place';
}

/** Build a human-readable description from OSM tags */
function buildDescription(tags, category) {
  const parts = [];
  if (tags.cuisine) parts.push(`Serves ${tags.cuisine.replace(/_/g, ' ')} cuisine.`);
  if (tags.opening_hours) parts.push(`Open: ${tags.opening_hours}.`);
  if (tags.phone) parts.push(`Call: ${tags.phone}.`);
  if (tags.website) parts.push(`Visit: ${tags.website}.`);
  if (tags['addr:street'] && tags['addr:city'])
    parts.push(`Located on ${tags['addr:street']}, ${tags['addr:city']}.`);
  if (parts.length === 0)
    parts.push(`A well-known ${category.toLowerCase()} in the area.`);
  return parts.join(' ');
}

/** Generate contextual mock reviews based on real place data */
function generateReviews(place, count = 4) {
  const reviewTemplates = {
    Restaurant: [
      { text: 'Food was absolutely delicious! The {cuisine} dishes were authentic and well-priced.', rating: 5 },
      { text: 'Great atmosphere and friendly staff. Will definitely come back.', rating: 4 },
      { text: 'Decent food but the wait time was a bit long. Worth it overall though.', rating: 4 },
      { text: 'One of the best spots in {city}. The portions are generous too.', rating: 5 },
      { text: 'Solid {cuisine} cuisine. The place was clean and well-organized.', rating: 4 },
    ],
    'Fast Food': [
      { text: 'Quick service and tasty food. Great value for money.', rating: 4 },
      { text: 'Always my go-to when I\'m in {city}. Consistent quality.', rating: 5 },
      { text: 'Food was okay but the service could be faster during rush hours.', rating: 3 },
    ],
    Café: [
      { text: 'Cozy vibe and amazing coffee. The perfect place to work or relax.', rating: 5 },
      { text: 'Love the ambience here. Great pastries too!', rating: 5 },
      { text: 'Nice spot to chill. Wi-Fi is reliable which is a plus.', rating: 4 },
    ],
    Hotel: [
      { text: 'Clean rooms, helpful staff. Great value for the price.', rating: 4 },
      { text: 'Comfortable stay. The location in {city} is very convenient.', rating: 5 },
      { text: 'Good experience overall. Breakfast was included and was quite nice.', rating: 4 },
    ],
  };

  const defaultTemplates = [
    { text: 'Really great place. Highly recommend it to anyone visiting {city}.', rating: 5 },
    { text: 'Good experience. Staff were helpful and the place was well-maintained.', rating: 4 },
    { text: 'Visited recently and was impressed. Will come back for sure.', rating: 4 },
    { text: 'Solid option in the area. Nothing to complain about.', rating: 4 },
  ];

  const names = ['Emeka O.', 'Fatima A.', 'Chidi N.', 'Aisha M.', 'Tunde B.',
    'Ngozi C.', 'Seun K.', 'Amara I.', 'Bola T.', 'Kemi F.'];

  const templates = reviewTemplates[place.category] || defaultTemplates;
  const selectedTemplates = [...templates].sort(() => Math.random() - 0.5).slice(0, count);

  return selectedTemplates.map((t, i) => ({
    author: names[Math.floor(Math.random() * names.length)],
    text: t.text
      .replace('{cuisine}', place.cuisine || 'local')
      .replace('{city}', place.city || 'the area'),
    rating: t.rating,
    date: new Date(Date.now() - randomInt(1, 180) * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0],
  }));
}

/** Fetch image from Wikimedia Commons by search query */
async function fetchWikimediaImage(query) {
  try {
    const searchRes = await axios.get('https://commons.wikimedia.org/w/api.php', {
      params: {
        action: 'query',
        generator: 'search',
        gsrsearch: `${query} place`,
        gsrnamespace: 6, // File namespace
        gsrlimit: 5,
        prop: 'imageinfo',
        iiprop: 'url|mime',
        iiurlwidth: 800,
        format: 'json',
        origin: '*',
      },
      timeout: 4000,
    });

    const pages = searchRes.data?.query?.pages;
    if (!pages) return null;

    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (info && (info.mime === 'image/jpeg' || info.mime === 'image/png')) {
        return info.thumburl || info.url;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Fallback stock images by category (Unsplash source — free, no key needed) */
const FALLBACK_IMAGES = {
  Restaurant:   'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&q=80',
  'Fast Food':  'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800&q=80',
  Café:         'https://images.unsplash.com/photo-1559305616-3f99cd43e353?w=800&q=80',
  Hotel:        'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800&q=80',
  Attraction:   'https://images.unsplash.com/photo-1467269204594-9661b134dd2b?w=800&q=80',
  Health:       'https://images.unsplash.com/photo-1586773860418-d37222d8fce3?w=800&q=80',
  Finance:      'https://images.unsplash.com/photo-1601597111158-2fceff292cdc?w=800&q=80',
  Park:         'https://images.unsplash.com/photo-1519331379826-f10be5486c6f?w=800&q=80',
  default:      'https://images.unsplash.com/photo-1444084316824-dc26d6657664?w=800&q=80',
};

function getFallbackImage(category) {
  return FALLBACK_IMAGES[category] || FALLBACK_IMAGES.default;
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// GET /places/nearby?lat=...&lng=...&radius=5000
router.get('/nearby', async (req, res) => {
  const { lat, lng, radius = 5000 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  try {
    // ── 1. Supabase cache check (within ~5km box, cached < 7 days ago) ──
    const delta = 0.05;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: cached } = await supabase
      .from('places')
      .select('*')
      .gte('latitude', userLat - delta)
      .lte('latitude', userLat + delta)
      .gte('longitude', userLng - delta)
      .lte('longitude', userLng + delta)
      .gte('cached_at', sevenDaysAgo)
      .limit(30);

    if (cached && cached.length >= 5) {
      console.log(`✅ Cache hit: ${cached.length} places`);
      const enriched = cached.map(p => ({
        ...p,
        distance_km: haversineDistance(userLat, userLng, p.latitude, p.longitude).toFixed(2),
      })).sort((a, b) => a.distance_km - b.distance_km);
      return res.json({ places: enriched, source: 'cache' });
    }

    // ── 2. Overpass API (OSM) ──
    console.log('🌍 Fetching from OpenStreetMap Overpass...');
    const overpassQuery = `
      [out:json][timeout:8];
      (
        node(around:${radius},${lat},${lng})[amenity~"^(restaurant|cafe|fast_food|bar|pub|hotel|hospital|pharmacy|bank|fuel|place_of_worship)$"];
        node(around:${radius},${lat},${lng})[tourism~"^(hotel|guest_house|attraction|museum)$"];
        node(around:${radius},${lat},${lng})[leisure~"^(park|garden)$"];
      );
      out 30;
    `;

    let osmElements = [];
    try {
      const osmRes = await axios.get(
        `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`,
        { timeout: 8000 }
      );
      osmElements = osmRes.data?.elements || [];
    } catch (osmErr) {
      console.warn('⚠️ OSM timed out:', osmErr.message);
      return res.json({ places: cached || [], source: 'cache_fallback' });
    }

    if (osmElements.length === 0) {
      return res.json({ places: cached || [], source: 'empty' });
    }

    // ── 3. Enrich each place ──
    // We batch image fetches to avoid hammering Wikimedia
    const enrichedPlaces = [];

    for (const el of osmElements) {
      if (!el.tags?.name) continue; // Skip unnamed places

      const category = resolveCategory(el.tags);
      const city = el.tags['addr:city'] || el.tags['addr:town'] || 'Nearby';
      const country = el.tags['addr:country'] || 'NG';
      const cuisine = el.tags.cuisine?.replace(/_/g, ' ') || null;

      // Build place object
      const place = {
        osm_id: String(el.id),
        name: el.tags.name,
        category,
        cuisine,
        description: buildDescription(el.tags, category),
        address: el.tags['addr:street'] || el.tags['addr:full'] || 'Nearby',
        city,
        country,
        latitude: el.lat,
        longitude: el.lon,
        phone: el.tags.phone || el.tags['contact:phone'] || null,
        website: el.tags.website || el.tags['contact:website'] || null,
        opening_hours: el.tags.opening_hours || null,
        rating: parseFloat((Math.random() * (5.0 - 3.5) + 3.5).toFixed(1)),
        review_count: randomInt(12, 340),
        features: buildFeatures(el.tags, category),
        cached_at: new Date().toISOString(),
      };

      // Fetch Wikimedia image, fall back to category stock image
      const wikiImage = await fetchWikimediaImage(`${place.name} ${city}`);
      place.image_urls = [wikiImage || getFallbackImage(category)];

      // Generate reviews
      place.reviews = generateReviews(place, 4);

      enrichedPlaces.push(place);
    }

    if (enrichedPlaces.length === 0) {
      return res.json({ places: cached || [], source: 'empty_after_filter' });
    }

    // ── 4. Cache to Supabase (upsert by osm_id) ──
    supabase
      .from('places')
      .upsert(enrichedPlaces, { onConflict: 'osm_id' })
      .then(({ error }) => {
        if (error) console.error('Cache upsert error:', error.message);
        else console.log(`✅ Cached ${enrichedPlaces.length} places`);
      });

    // ── 5. Add distance and return ──
    const withDistance = enrichedPlaces.map(p => ({
      ...p,
      distance_km: haversineDistance(userLat, userLng, p.latitude, p.longitude).toFixed(2),
    })).sort((a, b) => a.distance_km - b.distance_km);

    res.json({ places: withDistance, source: 'osm' });

  } catch (err) {
    console.error('Places error:', err.message);
    res.json({ places: [], source: 'error' });
  }
});

// GET /places/popular?lat=...&lng=...
// Returns places sorted by a popularity score (rating × log(review_count))
router.get('/popular', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  try {
    const delta = 0.15; // ~15km box for popular places
    const { data: places, error } = await supabase
      .from('places')
      .select('*')
      .gte('latitude', userLat - delta)
      .lte('latitude', userLat + delta)
      .gte('longitude', userLng - delta)
      .lte('longitude', userLng + delta)
      .gte('rating', 4.0)
      .order('review_count', { ascending: false })
      .limit(20);

    if (error) throw error;

    // Sort by popularity score: rating * ln(review_count + 1)
    const scored = (places || [])
      .map(p => ({
        ...p,
        distance_km: haversineDistance(userLat, userLng, p.latitude, p.longitude).toFixed(2),
        popularity_score: p.rating * Math.log(p.review_count + 1),
      }))
      .sort((a, b) => b.popularity_score - a.popularity_score)
      .slice(0, 10);

    res.json({ places: scored });
  } catch (err) {
    console.error('Popular places error:', err.message);
    res.json({ places: [] });
  }
});

// GET /places/:id — Full detail for a single place
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('places').select('*').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Place not found' });
    res.json({ place: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HELPER: build features array from OSM tags
// ---------------------------------------------------------------------------
function buildFeatures(tags, category) {
  const features = [];
  if (tags.wheelchair === 'yes') features.push('Wheelchair Accessible');
  if (tags.wifi === 'yes' || tags['internet_access'] === 'wlan') features.push('Free Wi-Fi');
  if (tags.outdoor_seating === 'yes') features.push('Outdoor Seating');
  if (tags.delivery === 'yes') features.push('Delivery Available');
  if (tags.takeaway === 'yes') features.push('Takeaway');
  if (tags.parking || tags['amenity:parking']) features.push('Parking Available');
  if (tags.air_conditioning === 'yes') features.push('Air Conditioned');
  if (tags.diet_vegan === 'yes' || tags.diet_vegetarian === 'yes') features.push('Veg-Friendly');
  if (tags.cuisine) features.push(`${tags.cuisine.replace(/_/g, ' ')} Cuisine`);
  if (tags.stars) features.push(`${tags.stars}-Star Rated`);

  // Defaults by category if we have nothing
  if (features.length === 0) {
    const defaults = {
      Restaurant: ['Dine-in', 'Local Favourite'],
      Café: ['Great Atmosphere', 'Wi-Fi Available'],
      Hotel: ['24/7 Front Desk', 'Room Service'],
      'Fast Food': ['Quick Service', 'Value Meals'],
      Attraction: ['Must Visit', 'Family Friendly'],
      Health: ['Professional Staff', 'Walk-ins Welcome'],
    };
    return defaults[category] || ['Popular Spot', 'Locally Recommended'];
  }

  return features;
}

module.exports = router;