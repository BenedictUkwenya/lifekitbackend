// src/services/accountDeletionService.js
// Permanently closes a user's account. Every step can safely run twice, and the
// login is removed last, so a failed deletion can simply be retried by the user.
//
// Kept on purpose: wallets, transactions, bookings, disputes, event tickets,
// reviews, booking chat messages and user reports (legal, tax and safety records
// that other users rely on). They stay linked to the anonymised profile.
const { supabaseAdmin } = require('../config/supabase');

const BUCKET_NAME = 'lifekit_images';

// 'chats' stays with the kept messages; 'groups' images may belong to groups
// that live on under a new creator.
const PERSONAL_IMAGE_FOLDERS = ['profiles', 'avatars', 'posts', 'services'];

const CLOSED_BOOKING_STATUSES = '("completed","cancelled","rejected","declined")';

const PERSONAL_ROWS = [
  ['notifications', 'user_id'],
  ['user_fcm_tokens', 'user_id'],
  ['user_recent_searches', 'user_id'],
  ['saved_posts', 'user_id'],
  ['group_members', 'user_id'],
  ['provider_schedule', 'provider_id'],
  ['provider_schedules', 'provider_id'],
  ['requested_categories', 'user_id'],
  ['active_boosts', 'user_id'],
  ['purchased_ai_tools', 'user_id'],
  ['support_tickets', 'user_id'],
  ['user_blocks', 'blocker_id'],
  ['user_blocks', 'blocked_id'],
];

/** Unwraps a Supabase response, throwing so a failed step stops the deletion. */
async function run(query) {
  const { data, count, error } = await query;
  if (error) throw new Error(error.message);
  return { data, count };
}

/**
 * Why this account can't be closed yet, or null if it can. Money and live
 * bookings have to be settled first, because nobody can act on them afterwards.
 */
async function getDeletionBlocker(userId) {
  const { data: wallets } = await run(
    supabaseAdmin.from('wallets').select('balance').eq('user_id', userId),
  );
  if ((wallets || []).some((w) => Number(w.balance) > 0)) return 'wallet_balance';

  const { count: openBookings } = await run(
    supabaseAdmin
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .or(`client_id.eq.${userId},provider_id.eq.${userId}`)
      .not('status', 'in', CLOSED_BOOKING_STATUSES),
  );
  if (openBookings > 0) return 'open_booking';

  const { count: openDisputes } = await run(
    supabaseAdmin
      .from('disputes')
      .select('id', { count: 'exact', head: true })
      .eq('initiator_id', userId)
      .eq('status', 'open'),
  );
  if (openDisputes > 0) return 'open_dispute';

  return null;
}

/** Hands groups with other members to the longest-serving one; deletes the rest. */
async function releaseCreatedGroups(userId) {
  const { data: groups } = await run(
    supabaseAdmin.from('groups').select('id').eq('creator_id', userId),
  );

  for (const { id: groupId } of groups || []) {
    const { data: heirs } = await run(
      supabaseAdmin
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .neq('user_id', userId)
        .order('is_admin', { ascending: false })
        .order('joined_at', { ascending: true })
        .limit(1),
    );
    const heirId = heirs?.[0]?.user_id;

    if (!heirId) {
      await run(supabaseAdmin.from('groups').delete().eq('id', groupId));
      continue;
    }
    await run(supabaseAdmin.from('groups').update({ creator_id: heirId }).eq('id', groupId));
    await run(
      supabaseAdmin
        .from('group_members')
        .update({ is_admin: true })
        .eq('group_id', groupId)
        .eq('user_id', heirId),
    );
  }
}

/** Removes the user's rows from a like/comment table and fixes the post's counter. */
async function removeInteractions(userId, table, postTable, counter) {
  const { data: rows } = await run(
    supabaseAdmin.from(table).select('post_id').eq('user_id', userId),
  );
  await run(supabaseAdmin.from(table).delete().eq('user_id', userId));

  const postIds = [...new Set((rows || []).map((r) => r.post_id))];
  for (const postId of postIds) {
    const { count } = await run(
      supabaseAdmin.from(table).select('id', { count: 'exact', head: true }).eq('post_id', postId),
    );
    await run(supabaseAdmin.from(postTable).update({ [counter]: count || 0 }).eq('id', postId));
  }
}

async function removePersonalImages(userId) {
  const storage = supabaseAdmin.storage.from(BUCKET_NAME);

  for (const folder of PERSONAL_IMAGE_FOLDERS) {
    const prefix = `${folder}/${userId}`;
    for (;;) {
      const { data: files } = await run(storage.list(prefix, { limit: 1000 }));
      if (!files?.length) break;
      const { data: removed } = await run(storage.remove(files.map((f) => `${prefix}/${f.name}`)));
      if (!removed?.length) break;
    }
  }
}

/**
 * Removes or anonymises everything personal, then the login. Soft-deleting the
 * login wipes its email, password and sessions but keeps the row that the kept
 * wallet and message records point at, and the email can be used to sign up again.
 */
async function deleteAccount(userId) {
  const { data: profile } = await run(
    supabaseAdmin.from('profiles').select('email').eq('id', userId).maybeSingle(),
  );

  await run(
    supabaseAdmin
      .from('swap_requests')
      .update({ status: 'cancelled' })
      .or(`proposer_id.eq.${userId},target_user_id.eq.${userId}`)
      .eq('status', 'pending'),
  );

  // Old bookings and reviews still point at these services, so they are taken
  // off the market rather than deleted.
  await run(
    supabaseAdmin
      .from('services')
      .update({
        status: 'cancelled',
        image_urls: [],
        location_text: null,
        is_skill_swap_available: false,
      })
      .eq('provider_id', userId),
  );

  await releaseCreatedGroups(userId);

  await run(supabaseAdmin.from('posts').delete().eq('user_id', userId));
  await run(supabaseAdmin.from('group_posts').delete().eq('user_id', userId));

  await removeInteractions(userId, 'post_likes', 'posts', 'likes_count');
  await removeInteractions(userId, 'post_comments', 'posts', 'comments_count');
  await removeInteractions(userId, 'group_post_likes', 'group_posts', 'likes_count');
  await removeInteractions(userId, 'group_comments', 'group_posts', 'comments_count');

  for (const [table, column] of PERSONAL_ROWS) {
    await run(supabaseAdmin.from(table).delete().eq(column, userId));
  }
  if (profile?.email) {
    await run(supabaseAdmin.from('waitlist').delete().eq('email', profile.email));
  }

  await removePersonalImages(userId);

  // stripe_connect_id stays: it links the kept payout records to Stripe.
  await run(
    supabaseAdmin
      .from('profiles')
      .update({
        full_name: 'Deleted User',
        email: `deleted_${userId}@deleted.local`,
        profile_picture_url: null,
        username: null,
        phone_number: null,
        bio: null,
        job_title: null,
        country: null,
        signup_platform: null,
        language: null,
        last_active_at: null,
        onboarding_plan: null,
        onboarding_plan_translations: {},
        is_service_provider: false,
        is_founding_member: false,
        email_notifications_enabled: false,
        subscription_tier: 'free',
        subscription_expiry: null,
        trial_end_date: null,
        status: 'deleted',
      })
      .eq('id', userId),
  );

  await run(supabaseAdmin.auth.admin.deleteUser(userId, true));
}

module.exports = { getDeletionBlocker, deleteAccount };
