// seed.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Error: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

// 1. INITIALIZE AS PURE ADMIN (No Sessions)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// --- MOCK DATA ---
const MOCK_PROVIDERS = [
  {
    email: 'barber@test.com',
    password: 'password123',
    fullName: 'Victor Barber',
    bio: 'Expert cuts and fades. 10 years experience.',
    image: 'https://i.pravatar.cc/300?img=11',
    categoryName: 'Barber',
    categoryId: '21ff6c51-2842-4a27-a2c5-30de912f099d', 
    serviceTitle: 'Premium Haircut',
    price: 30.00,
    pricingType: 'hourly',
    serviceType: 'Out Service / Studio (OS)'
  },
  {
    email: 'tech@test.com',
    password: 'password123',
    fullName: 'Jessica Tech',
    bio: 'I teach coding and digital literacy. Open to swaps!',
    image: 'https://i.pravatar.cc/300?img=5',
    categoryName: 'Tech Tutorials',
    categoryId: '6d16b036-1c23-4044-81b6-32c6ed3344b7', 
    serviceTitle: 'Python Coding Lessons',
    price: 0.00, // SKILL SWAP
    pricingType: 'fixed',
    serviceType: 'Hybrid (Both Available)'
  },
  {
    email: 'cleaner@test.com',
    password: 'password123',
    fullName: 'Sarah Clean',
    bio: 'Deep cleaning specialist.',
    image: 'https://i.pravatar.cc/300?img=9',
    categoryName: 'Standard Cleaning',
    categoryId: '349a5a3a-f14d-4f0e-9991-e6164d8aae4f', 
    serviceTitle: 'Full House Deep Clean',
    price: 120.00,
    pricingType: 'fixed',
    serviceType: 'Home Service (HS)'
  },
  {
    email: 'plumber@test.com',
    password: 'password123',
    fullName: 'Mario Pipes',
    bio: '24/7 Emergency Plumbing.',
    image: 'https://i.pravatar.cc/300?img=8',
    categoryName: 'Plumbing',
    categoryId: '24cc36e4-909b-4119-80ff-77ef90474898', 
    serviceTitle: 'Leak Repair & Install',
    price: 85.00,
    pricingType: 'hourly',
    serviceType: 'Home Service (HS)'
  }
];

// Helper to pause execution (prevents socket errors)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed() {
  console.log('🌱 Starting Database Seed...');

  for (const provider of MOCK_PROVIDERS) {
    console.log(`\n🔹 Processing: ${provider.fullName} (${provider.email})`);

    let userId;

    // A. Try Creating User
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email: provider.email,
      password: provider.password,
      email_confirm: true,
      user_metadata: { full_name: provider.fullName }
    });

    if (createError) {
      // If user exists, we must find their ID using listUsers (Safe Admin Way)
      if (createError.message.includes('already registered') || createError.status === 422) {
        console.log(`   User exists. Fetching ID...`);
        // Note: listUsers is paginated, but usually finds recent test users easily
        const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();
        
        if (listError) {
            console.error(`   ❌ Failed to list users: ${listError.message}`);
            continue;
        }

        const foundUser = usersData.users.find(u => u.email === provider.email);
        if (foundUser) {
            userId = foundUser.id;
        } else {
            console.error(`   ❌ Could not find existing user ID for ${provider.email}`);
            continue;
        }
      } else {
        console.error(`   ❌ Auth Creation Error: ${createError.message}`);
        continue;
      }
    } else {
      userId = createData.user.id;
      console.log(`   ✅ User created.`);
    }

    // B. Update Profile
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        email: provider.email,
        full_name: provider.fullName,
        profile_picture_url: provider.image,
        bio: provider.bio,
        is_service_provider: true,
        phone_number: '1234567890'
      }); // No .select(), just fire and forget to avoid RLS return issues

    if (profileError) console.error(`   ❌ Profile Error: ${profileError.message}`);
    else console.log(`   ✅ Profile updated.`);

    // C. Create Service
    // First, check if service exists to avoid duplicates
    const { data: existingService } = await supabase
        .from('services')
        .select('id')
        .eq('provider_id', userId)
        .eq('title', provider.serviceTitle)
        .maybeSingle(); // Use maybeSingle to avoid 406 error if 0 rows

    if (!existingService) {
        const { error: serviceError } = await supabase.from('services').insert({
            provider_id: userId,
            category_id: provider.categoryId,
            title: provider.serviceTitle,
            description: `Professional ${provider.serviceTitle} services. ${provider.bio}`,
            price: provider.price,
            currency: 'USD',
            service_type: provider.serviceType,
            pricing_type: provider.pricingType,
            status: 'active',
            image_urls: [`https://picsum.photos/seed/${userId}/400/300`] 
        });
        if (serviceError) console.error(`   ❌ Service Error: ${serviceError.message}`);
        else console.log(`   ✅ Service created: ${provider.serviceTitle}`);
    } else {
        console.log(`   ℹ️ Service already exists.`);
    }

    // D. Create Schedule
    // Delete existing schedule to avoid conflicts
    await supabase.from('provider_schedules').delete().eq('provider_id', userId);

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const scheduleData = days.map(day => ({
        provider_id: userId,
        day_of_week: day,
        start_time: '09:00',
        end_time: '17:00',
        is_active: true
    }));

    const { error: scheduleError } = await supabase.from('provider_schedules').insert(scheduleData);
    if (scheduleError) console.error(`   ❌ Schedule Error: ${scheduleError.message}`);
    else console.log(`   ✅ Schedule set.`);

    // PAUSE TO PREVENT SOCKET ERROR
    await sleep(1500); 
  }

  console.log('\n✨ Database Seeding Completed!');
}

seed();