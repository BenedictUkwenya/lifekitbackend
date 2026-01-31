require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Error: Missing env variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// --- DATA STRUCTURE FROM IMAGES ---
const SEED_DATA = [
  // 1. RELOCATION (Standard)
  {
    name: "Relocation Service",
    type: "standard",
    location_options: ["Remote", "In-Person"],
    subs: [
      "Visa support", "Residency Permit Assistance", "Document Translation & Legalization",
      "University Application Assistance", "Apartment Search", "Business Registration Assistant", "Insurance Help"
    ]
  },
  // 2. COMMUNICATION (Standard)
  {
    name: "Communication & Language",
    type: "standard",
    location_options: ["Home Service (HS)", "Out Service / Studio (OS)", "Online"],
    subs: ["Interpreter On-Demand", "Language Tutoring"]
  },
  // 3. TECH (Standard)
  {
    name: "Tech & Digital Help",
    type: "standard",
    location_options: ["Home Service (HS)", "Out Service / Studio (OS)", "Remote"],
    subs: ["Home Tech Setup", "Phone repair", "Laptop repair", "Tech Tutorials", "Digital Literacy Help"]
  },
  // 4. HEALTH (Standard)
  {
    name: "Health & Wellness",
    type: "standard",
    location_options: ["Home Service (HS)", "Out Service / Studio (OS)"],
    subs: ["Personal Trainer", "Nutritionist", "Physiotherapist", "Chiropractor", "Mental Health Counselor"]
  },
  // 5. EVENT & LIFESTYLE (Mixed Location Logic)
  {
    name: "Event & Lifestyle",
    type: "standard",
    subs: [
      { name: "Photographer", location_options: ["Studio session", "Home session", "Event coverage"] },
      { name: "Event Planner", location_options: ["Small gathering", "Wedding/Big event"] },
      { name: "DJ / Musician", location_options: ["Event Location"] },
      { name: "Henna Artist", location_options: ["Bridal", "Casual"] },
      { name: "Fashion Stylist", location_options: ["Personal shopper", "Outfit curation"] }
    ]
  },
  
  // --- STAND ALONE CATEGORIES (Multi-Select Tasks) ---
  
  // 6. PLUMBING
  {
    name: "Plumbing",
    type: "standalone", // Provider picks multiple
    location_options: ["Home Service (HS)"],
    subs: ["Sink/faucet installation", "Sink/faucet repair", "Leak repair", "Toilet installation", "Drain Unclogging", "Shower head repair"]
  },
  // 7. ELECTRICAL
  {
    name: "Electrical",
    type: "standalone",
    location_options: ["Home Service (HS)"],
    subs: ["Light fixture installation", "Socket repair", "Full wiring"]
  },
  // 8. CLEANING
  {
    name: "Cleaning Services",
    type: "standalone",
    location_options: ["Home Service (HS)", "Office"],
    subs: ["Standard cleaning", "Deep cleaning", "Move in or out cleaning", "Office cleaning", "Post renovation cleaning"]
  },
  // 9. LAUNDRY
  {
    name: "Laundry & Ironing",
    type: "standalone",
    location_options: ["Home Service (HS)", "Out Service (OS)"],
    subs: ["Wash and fold", "Pickup/drop off", "Ironing"]
  },
  // 10. HAIR & BEAUTY
  {
    name: "Hairdressing / Braiding / Barbers",
    type: "standalone",
    location_options: ["Home Service (HS)", "Out Service (OS)"],
    subs: [
      "Box Braids (Small)", "Box Braids (Medium)", "Box Braids (Large)",
      "Cornrows (Small)", "Cornrows (Medium)", "Cornrows (Large)",
      "LOCS (Starter)", "LOCS (Retwisting)", "Faux locs", "Crotchet styles",
      "Wig installation", "Washing and blow drying", "Colouring", "Styling"
    ]
  },
  // 11. MAKEUP
  {
    name: "Makeup Artists",
    type: "standalone",
    location_options: ["Home Service (HS)", "Out Service (OS)"],
    subs: ["Everyday glam", "Bridal/Event makeup"]
  },
  // 12. NAILS
  {
    name: "Nail Techs",
    type: "standalone",
    location_options: ["Home Service (HS)", "Out Service (OS)"],
    subs: ["Basic manicure", "Basic pedicure", "French manicure", "Acrylic", "Gel X", "Builder Gel", "Custom nail art", "Chrome art", "Ombre/aura nails", "French tips", "3D art"]
  },
  // 13. CHEF
  {
    name: "Personal Chef",
    type: "standalone",
    location_options: ["Home service", "Food delivery", "Event catering"],
    subs: ["Meal Prep", "Private Dinner", "Party Catering"]
  },
  // 14. OTHERS (Single levels acting as Standalone for simplicity)
  {
    name: "Grocery Shoppers & Runners",
    type: "standalone",
    location_options: ["Delivery"],
    subs: ["Grocery Shopping", "Errand Running"]
  },
  {
    name: "Baby sitters",
    type: "standalone",
    location_options: ["Home Service (HS)"],
    subs: ["Hourly Care", "Overnight", "Nanny"]
  },
  {
    name: "Pet Sitters",
    type: "standalone",
    location_options: ["Home Service (HS)"],
    subs: ["Dog Walking", "Pet Sitting", "Grooming"]
  },
  {
    name: "Event Companions",
    type: "standalone",
    location_options: ["Event Location"],
    subs: ["Plus One", "Party Partner"]
  },
  {
    name: "Movers",
    type: "standalone",
    location_options: ["Home Service (HS)"],
    subs: ["Packing", "Moving", "Unpacking"]
  },
  {
    name: "Painter",
    type: "standalone",
    location_options: ["Home Service (HS)"],
    subs: ["Exterior", "Interior"]
  },
  {
    name: "Handyman",
    type: "standalone",
    location_options: ["Home Service (HS)"],
    subs: ["Furniture assembly", "Tv mounting", "Wall drilling", "Accessories Installation"]
  },
  {
    name: "Tour guide",
    type: "standalone",
    location_options: ["On Site"],
    subs: ["City Tour", "Museum Tour", "Nature Hike"]
  },
  {
    name: "Tutors",
    type: "standalone",
    location_options: ["Online", "In-Person"],
    subs: ["Assignment help", "Research or thesis editing", "General/Exam prep tutoring", "Resume writing"]
  },
  {
    name: "Roommate Matching Help",
    type: "standalone",
    location_options: ["Remote"],
    subs: ["Profile Setup", "Matching"]
  },
  {
    name: "Activity Partners",
    type: "standalone",
    location_options: ["On Site"],
    subs: ["Gym Buddy", "Running Partner", "Tennis Partner"]
  }
];

async function seedCategories() {
  console.log('🧹 Cleaning Database...');
  
  // 1. CLEANUP (Order is important due to foreign keys)
  // Delete Services first, then Categories
  await supabase.from('services').delete().neq('id', '00000000-0000-0000-0000-000000000000'); 
  await supabase.from('service_categories').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('🌱 Inserting Categories...');

  for (const cat of SEED_DATA) {
    // A. Insert Parent Category
    const { data: parent, error: parentError } = await supabase
      .from('service_categories')
      .insert({
        name: cat.name,
        is_standalone: cat.type === 'standalone',
        location_options: cat.location_options || ["Home Service (HS)", "Out Service / Studio (OS)"]
      })
      .select()
      .single();

    if (parentError) {
      console.error(`❌ Failed to create ${cat.name}:`, parentError.message);
      continue;
    }

    console.log(`   ✅ Created Parent: ${cat.name} ${cat.type === 'standalone' ? '(Standalone)' : ''}`);

    // B. Insert Sub-Categories
    if (cat.subs && cat.subs.length > 0) {
      const subInserts = cat.subs.map(sub => {
        // Handle complex sub objects (like Photographer having specific locations)
        if (typeof sub === 'object') {
          return {
            name: sub.name,
            parent_category_id: parent.id,
            location_options: sub.location_options,
            is_standalone: false
          };
        }
        // Handle simple strings
        return {
          name: sub,
          parent_category_id: parent.id,
          // Inherit location options from parent if not specified
          location_options: parent.location_options, 
          is_standalone: false
        };
      });

      const { error: subError } = await supabase.from('service_categories').insert(subInserts);
      if (subError) {
        console.error(`      ❌ Failed subs for ${cat.name}:`, subError.message);
      } else {
        console.log(`      Example Sub: ${cat.subs[0].name || cat.subs[0]}`);
      }
    }
  }

  console.log('\n✨ All Categories Seeded Successfully!');
}

seedCategories();