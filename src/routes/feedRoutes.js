const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const authenticateAdmin = require('../middleware/adminMiddleware');
const authenticateToken = require('../middleware/authMiddleware'); // Ensure this is imported

// 1. GET /feeds/posts (Auth - includes like meta for current user)
router.get('/posts', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { data, error } = await supabase
      .from('posts')
      .select(`
        *,
        profiles(full_name, username, profile_picture_url),
        post_likes (user_id)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const formatted = (data || []).map((p) => ({
      ...p,
      is_liked_by_me: Array.isArray(p.post_likes)
        ? p.post_likes.some((l) => l.user_id === userId)
        : false,
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. GET /feeds/events (Public - For Mobile App)
router.get('/events', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('is_active', true)
      .order('event_date', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2b. GET /feeds/events/:id/meta  (likes + comments summary for one event)
router.get('/events/:id/meta', authenticateToken, async (req, res) => {
  const eventId = req.params.id;
  const userId = req.user.id;
  try {
    // Fetch all likes for this event to compute count + "liked by me"
    const { data: likesData, error: likesError } = await supabase
      .from('event_likes')
      .select('user_id')
      .eq('event_id', eventId);
    if (likesError) throw likesError;

    const likesCount = Array.isArray(likesData) ? likesData.length : 0;
    const isLikedByMe = Array.isArray(likesData)
      ? likesData.some(l => l.user_id === userId)
      : false;

    // Fetch comments just for count
    const { data: commentsData, error: commentsError } = await supabase
      .from('event_comments')
      .select('id')
      .eq('event_id', eventId);
    if (commentsError) throw commentsError;

    const commentsCount = Array.isArray(commentsData) ? commentsData.length : 0;

    res.json({
      likes_count: likesCount,
      comments_count: commentsCount,
      is_liked_by_me: isLikedByMe
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ADMIN ACTIONS ---

// 3. POST /feeds/posts (Admin - Create Post)
router.post('/posts', authenticateAdmin, async (req, res) => {
  const { title, content, image_url } = req.body;
  const userId = req.user.id; // The Admin's ID

  try {
    const { data, error } = await supabaseAdmin
      .from('posts')
      .insert({
        title: title || null,
        content,
        image_url,
        user_id: userId,
        likes_count: 0,
        comments_count: 0
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. DELETE /feeds/posts/:id (Admin - Delete Post)
router.delete('/posts/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabaseAdmin
      .from('posts')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: "Post deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. POST /feeds/posts/:id/like - Toggle Like (Auth Required)
router.post('/posts/:id/like', authenticateToken, async (req, res) => {
  const { id } = req.params; // Post ID
  const userId = req.user.id;

  try {
    const { data: existingLike } = await supabaseAdmin 
      .from('post_likes')
      .select('id')
      .eq('post_id', id)
      .eq('user_id', userId)
      .maybeSingle();

    let isLiked;

    if (existingLike) {
      await supabaseAdmin.from('post_likes').delete().eq('id', existingLike.id);
      isLiked = false;
    } else {
      await supabaseAdmin.from('post_likes').insert({ post_id: id, user_id: userId });
      isLiked = true;
    }

    const { data: likesData, error: likesError } = await supabaseAdmin
      .from('post_likes')
      .select('id')
      .eq('post_id', id);

    if (likesError) throw likesError;

    const likesCount = Array.isArray(likesData) ? likesData.length : 0;

    await supabaseAdmin
      .from('posts')
      .update({ likes_count: likesCount })
      .eq('id', id);

    res.json({
      message: 'Post like toggled',
      is_liked_by_me: isLiked,
      likes_count: likesCount,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5b. POST /feeds/events/:id/like - Toggle Event Like (Auth Required)
router.post('/events/:id/like', authenticateToken, async (req, res) => {
  const { id } = req.params; // Event ID
  const userId = req.user.id;

  try {
    const { data: existingLike } = await supabaseAdmin
      .from('event_likes')
      .select('*')
      .eq('event_id', id)
      .eq('user_id', userId)
      .maybeSingle();

    let isLiked;

    if (existingLike) {
      await supabaseAdmin.from('event_likes').delete().eq('id', existingLike.id);
      isLiked = false;
    } else {
      await supabaseAdmin.from('event_likes').insert({ event_id: id, user_id: userId });
      isLiked = true;
    }

    const { data: likesData } = await supabaseAdmin
      .from('event_likes')
      .select('id')
      .eq('event_id', id);

    const likesCount = Array.isArray(likesData) ? likesData.length : 0;

    res.json({ message: 'Event like toggled', is_liked_by_me: isLiked, likes_count: likesCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. GET /feeds/posts/:id/comments - Get Comments
router.get('/posts/:id/comments', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabaseAdmin 
      .from('post_comments')
      .select('*, profiles(full_name, profile_picture_url)')
      .eq('post_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. POST /feeds/posts/:id/comments - Add Comment (Auth Required)
router.post('/posts/:id/comments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  try {
    const { data, error } = await supabaseAdmin 
      .from('post_comments')
      .insert({ post_id: id, user_id: userId, content })
      .select('*, profiles(full_name, profile_picture_url)')
      .single();

    if (error) throw error;

    const { data: post } = await supabaseAdmin
      .from('posts')
      .select('*')
      .eq('id', id)
      .single();

    if (post) {
      const commentsCount = (post.comments_count || 0) + 1;
      await supabaseAdmin
        .from('posts')
        .update({ comments_count: commentsCount })
        .eq('id', id);

      const ownerId = post.user_id;
      const commenterName = data.profiles?.full_name || 'Someone';

      if (ownerId && ownerId !== userId) {
        const preview = content.length > 80 ? content.substring(0, 77) + '...' : content;
        await supabaseAdmin.from('notifications').insert({
          user_id: ownerId,
          title: 'New Comment on Your Post 💬',
          message: `${commenterName} commented: "${preview}"`,
          type: 'post_comment',
          reference_id: id,
          is_read: false
        });
      }
    }

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. POST /feeds/toggle-bookmark - Toggle Saved Post (Auth Required)
router.post('/toggle-bookmark', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { postId } = req.body;

  if (!postId) {
    return res.status(400).json({ error: 'postId is required' });
  }

  try {
    const { data: existing } = await supabaseAdmin 
      .from('saved_posts')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    let isSaved;

    if (existing) {
      await supabaseAdmin.from('saved_posts').delete().eq('id', existing.id);
      isSaved = false;
    } else {
      await supabaseAdmin.from('saved_posts').insert({
        post_id: postId,
        user_id: userId,
      });
      isSaved = true;
    }

    res.json({ is_saved: isSaved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 9. GET /feeds/saved-posts - Get Saved Posts for Current User (Auth Required)
router.get('/saved-posts', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data, error } = await supabase
      .from('saved_posts')
      .select(`
        id,
        created_at,
        posts (
          *,
          profiles (full_name, username, profile_picture_url)
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const posts = Array.isArray(data)
      ? data.map((row) => row.posts).filter((p) => !!p)
      : [];

    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7b. GET /feeds/events/:id/comments - Get Event Comments
router.get('/events/:id/comments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabaseAdmin
      .from('event_comments')
      .select('*, profiles(full_name, profile_picture_url)')
      .eq('event_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7c. POST /feeds/events/:id/comments - Add Event Comment (Auth Required)
router.post('/events/:id/comments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  try {
    const { data, error } = await supabaseAdmin
      .from('event_comments')
      .insert({ event_id: id, user_id: userId, content })
      .select('*, profiles(full_name, profile_picture_url)')
      .single();

    if (error) throw error;

    const { data: event } = await supabaseAdmin
      .from('events')
      .select('*')
      .eq('id', id)
      .single();

    if (event) {
      const ownerId = event.user_id || event.creator_id;
      const commenterName = data.profiles?.full_name || 'Someone';

      if (ownerId && ownerId !== userId) {
        const preview = content.length > 80 ? content.substring(0, 77) + '...' : content;
        await supabaseAdmin.from('notifications').insert({
          user_id: ownerId,
          title: 'New Comment on Your Event 💬',
          message: `${commenterName} commented on "${event.title}": "${preview}"`,
          type: 'event_comment',
          reference_id: id,
          is_read: false
        });
      }
    }

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ==========================================
// --- GROUPS SECTION (Using supabaseAdmin) ---
// ==========================================

// Helper to filter content
const isContentSafe = (text) => {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /(\+?\d{1,4}[\s-]?)?(\d{10,13})/g;
  const blacklist = ['whatsapp', 'call me', 'contact me', 'phone number', 'telegram', 'send money', 'zelle', 'cashapp'];

  const hasEmail = emailRegex.test(text);
  const hasPhone = phoneRegex.test(text.replace(/\s/g, ''));
  const hasBlacklisted = blacklist.some(word => text.toLowerCase().includes(word));

  return !hasEmail && !hasPhone && !hasBlacklisted;
};

// 1. GET ALL GROUPS (With member counts)
router.get('/groups', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('groups')
      .select(`
        *,
        members_count: group_members(count)
      `);

    if (error) throw error;

    const formattedGroups = data.map(g => ({
      ...g,
      members_count: g.members_count[0]?.count || 0
    }));

    res.json(formattedGroups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /groups/:id (Include membership status)
router.get('/groups/:id', authenticateToken, async (req, res) => {
  const groupId = req.params.id;
  const userId = req.user.id;

  try {
    const { data: group, error } = await supabaseAdmin.from('groups').select('*').eq('id', groupId).single();
    if (error) throw error;

    const { data: member } = await supabaseAdmin.from('group_members')
      .select('*').eq('group_id', groupId).eq('user_id', userId).maybeSingle();

    res.json({
      group,
      isMember: !!member,
      isAdmin: member?.is_admin || false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. POST /groups (Create a Group)
router.post('/groups', authenticateToken, async (req, res) => {
  const { name, description, image_url, anyone_can_post } = req.body;
  const userId = req.user.id;

  try {
    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .insert({ 
        name, 
        description, 
        image_url, 
        creator_id: userId,
        anyone_can_post: anyone_can_post ?? true 
      })
      .select()
      .single();

    if (error) throw error;

    // Automatically make the creator an admin member
    await supabaseAdmin.from('group_members').insert({ 
      group_id: group.id, 
      user_id: userId, 
      is_admin: true 
    });

    res.status(201).json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. POST /groups/:id/join (Join a Group)
router.post('/groups/:id/join', authenticateToken, async (req, res) => {
  const groupId = req.params.id;
  const userId = req.user.id;

  try {
    const { error } = await supabaseAdmin
      .from('group_members')
      .insert({ group_id: groupId, user_id: userId });

    if (error) {
        if (error.code === '23505') return res.status(400).json({ error: "Already a member" });
        throw error;
    }

    res.json({ message: "Joined successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /groups/:id/posts - Get all posts for a specific group
router.get('/groups/:id/posts', authenticateToken, async (req, res) => {
  const groupId = req.params.id;
  const userId = req.user.id;

  try {
    const { data: posts, error } = await supabaseAdmin
      .from('group_posts')
      .select(`
        *,
        profiles (full_name, profile_picture_url, username),
        group_post_likes (user_id)
      `)
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const formattedPosts = posts.map(p => ({
      ...p,
      is_liked_by_me: p.group_post_likes.some(l => l.user_id === userId)
    }));

    res.json(formattedPosts);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /groups/:id/posts
router.post('/groups/:id/posts', authenticateToken, async (req, res) => {
  const { content, image_url } = req.body;
  const groupId = req.params.id;
  const userId = req.user.id;

  if (!isContentSafe(content)) {
    return res.status(400).json({ error: "Post contains restricted contact information (Email/Phone). Please keep transactions on LifeKit." });
  }

  try {
    const { data: group } = await supabaseAdmin.from('groups').select('*').eq('id', groupId).single();
    if (!group.anyone_can_post) {
      const { data: member } = await supabaseAdmin.from('group_members')
        .select('is_admin').eq('group_id', groupId).eq('user_id', userId).single();
      if (!member || !member.is_admin) return res.status(403).json({ error: "Only admins can post in this group." });
    }

    const { data, error } = await supabaseAdmin.from('group_posts').insert({
      group_id: groupId, user_id: userId, content, image_url
    }).select().single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /groups/:id/members - Get list of members
router.get('/groups/:id/members', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('group_members')
      .select('*, profiles(id, full_name, profile_picture_url, username)')
      .eq('group_id', req.params.id);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /groups/:id/settings - Update group permissions
router.put('/groups/:id/settings', authenticateToken, async (req, res) => {
  const { anyone_can_post } = req.body;
  const userId = req.user.id;

  try {
    const { data: member } = await supabaseAdmin.from('group_members')
      .select('is_admin').eq('group_id', req.params.id).eq('user_id', userId).single();

    if (!member || !member.is_admin) return res.status(403).json({ error: "Only admins can change settings" });

    const { error } = await supabaseAdmin.from('groups')
      .update({ anyone_can_post }).eq('id', req.params.id);

    if (error) throw error;
    res.json({ message: "Settings updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /groups/:id/members/:targetUserId - Kick a member
router.delete('/groups/:id/members/:targetUserId', authenticateToken, async (req, res) => {
  const { id, targetUserId } = req.params;
  const adminId = req.user.id;

  try {
    const { data: adminMember } = await supabaseAdmin.from('group_members')
      .select('is_admin').eq('group_id', id).eq('user_id', adminId).single();

    if (!adminMember || !adminMember.is_admin) return res.status(403).json({ error: "Unauthorized" });

    await supabaseAdmin.from('group_members').delete().eq('group_id', id).eq('user_id', targetUserId);
    res.json({ message: "Member removed" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- GROUP POST LIKES ---
router.post('/groups/posts/:postId/like', authenticateToken, async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.id;

  try {
    const { data: existing } = await supabaseAdmin
      .from('group_post_likes').select('*').eq('post_id', postId).eq('user_id', userId).maybeSingle();

    if (existing) {
      await supabaseAdmin.from('group_post_likes').delete().eq('id', existing.id);
      res.json({ message: "Unliked", isLiked: false });
    } else {
      await supabaseAdmin.from('group_post_likes').insert({ post_id: postId, user_id: userId });
      res.json({ message: "Liked", isLiked: true });
    }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- GROUP POST COMMENTS ---
router.get('/groups/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('group_comments')
      .select('*, profiles(full_name, profile_picture_url)')
      .eq('post_id', req.params.postId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/groups/posts/:postId/comments', authenticateToken, async (req, res) => {
  const { content } = req.body;
  if (!isContentSafe(content)) return res.status(400).json({ error: "Restricted content." });

  try {
    const userId = req.user.id;
    const postId = req.params.postId;

    const { data, error } = await supabaseAdmin
      .from('group_comments')
      .insert({
        post_id: postId,
        user_id: userId,
        content
      })
      .select('*, profiles(full_name, profile_picture_url)')
      .single();

    if (error) throw error;

    const { data: post } = await supabaseAdmin
      .from('group_posts')
      .select('user_id, comments_count, content')
      .eq('id', postId)
      .single();

    if (post) {
      const commentsCount = (post.comments_count || 0) + 1;
      await supabaseAdmin
        .from('group_posts')
        .update({ comments_count: commentsCount })
        .eq('id', postId);

      const ownerId = post.user_id;
      const commenterName = data.profiles?.full_name || 'Someone';

      if (ownerId && ownerId !== userId) {
        const preview = content.length > 80 ? content.substring(0, 77) + '...' : content;
        await supabaseAdmin.from('notifications').insert({
          user_id: ownerId,
          title: 'New Comment in Your Group Post 💬',
          message: `${commenterName} commented: "${preview}"`,
          type: 'group_comment',
          reference_id: postId,
          is_read: false
        });
      }
    }

    res.status(201).json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// DELETE /groups/:id/leave - Leave a group
router.delete('/groups/:id/leave', authenticateToken, async (req, res) => {
  const groupId = req.params.id;
  const userId = req.user.id;

  try {
    const { data: group } = await supabaseAdmin.from('groups').select('creator_id').eq('id', groupId).single();
    if (group.creator_id === userId) {
      return res.status(400).json({ error: "Creators cannot leave their own group. Delete the group instead." });
    }

    const { error } = await supabaseAdmin
      .from('group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', userId);

    if (error) throw error;
    res.json({ message: "Left group successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /feeds/groups/:id/members/:targetUserId/admin - Promote/Demote member
router.put('/groups/:id/members/:targetUserId/admin', authenticateToken, async (req, res) => {
  const { id, targetUserId } = req.params;
  const { is_admin } = req.body;
  const requesterId = req.user.id;

  try {
    const { data: requester } = await supabaseAdmin.from('group_members')
      .select('is_admin').eq('group_id', id).eq('user_id', requesterId).single();

    if (!requester || !requester.is_admin) {
      return res.status(403).json({ error: "Only admins can change roles." });
    }

    const { error } = await supabaseAdmin.from('group_members')
      .update({ is_admin })
      .eq('group_id', id)
      .eq('user_id', targetUserId);

    if (error) throw error;
    res.json({ message: "Role updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /feeds/groups/:id - Delete a group (Creator only)
router.delete('/groups/:id', authenticateToken, async (req, res) => {
  const groupId = req.params.id;
  const userId = req.user.id;

  try {
    const { data: group } = await supabaseAdmin.from('groups')
      .select('creator_id').eq('id', groupId).single();

    if (!group || group.creator_id !== userId) {
      return res.status(403).json({ error: "Only the group creator can delete this group." });
    }

    const { error } = await supabaseAdmin.from('groups').delete().eq('id', groupId);
    if (error) throw error;

    res.json({ message: "Group and all associated content deleted." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/groups/posts/:postId', authenticateToken, async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.id;

  try {
    const { data: post, error: postError } = await supabaseAdmin
      .from('group_posts')
      .select('user_id, group_id, content')
      .eq('id', postId)
      .single();

    if (postError || !post) return res.status(404).json({ error: "Post not found" });

    const { data: member } = await supabaseAdmin
      .from('group_members')
      .select('is_admin')
      .eq('group_id', post.group_id)
      .eq('user_id', userId)
      .single();

    const isOwner = post.user_id === userId;
    const isAdmin = member?.is_admin || false;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "Unauthorized to delete this post" });
    }

    const { error: deleteError } = await supabaseAdmin.from('group_posts').delete().eq('id', postId);
    if (deleteError) throw deleteError;

    if (isAdmin && !isOwner) {
      await supabaseAdmin.from('notifications').insert({
        user_id: post.user_id,
        title: "Post Removed ⚠️",
        message: `An admin removed your post: "${post.content.substring(0, 30)}..." for violating community rules.`,
        type: 'post_deleted'
      });
    }

    res.json({ message: "Post deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;