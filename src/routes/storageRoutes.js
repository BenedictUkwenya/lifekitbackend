const express = require('express');
const router = express.Router();
const multer = require('multer');
// CHANGE 1: Import supabaseAdmin
const { supabaseAdmin } = require('../config/supabase'); 
const authenticateToken = require('../middleware/authMiddleware');
const sharp = require('sharp');

// Phone photos arrive at 1–5 MB and made the feed slow on mobile data.
// Every image is resized and re-encoded as WebP (≈100–250 KB) before storage.
const MAX_SIDE = { profiles: 640, avatars: 640, groups: 1280 };
const DEFAULT_MAX_SIDE = 1440;

async function optimizeImage(buffer, folder) {
  const max = MAX_SIDE[folder] || DEFAULT_MAX_SIDE;
  return sharp(buffer, { failOn: 'none' })
    .rotate() // apply the camera's EXIF orientation, then drop the metadata
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();
}

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const BUCKET_NAME = 'lifekit_images';

router.post('/upload/:folder', authenticateToken, upload.single('file'), async (req, res) => {
  const { folder } = req.params;
  const userId = req.user.id;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file uploaded.' });

  const allowedFolders = ['profiles', 'services', 'avatars', 'posts', 'groups', 'chats'];
  if (!allowedFolders.includes(folder)) {
    return res.status(400).json({ error: `Invalid folder. Allowed: ${allowedFolders.join(', ')}` });
  }

  const timestamp = Date.now();
  let body = file.buffer;
  let contentType = file.mimetype;
  let baseName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
  if ((file.mimetype || '').startsWith('image/') && file.mimetype !== 'image/gif') {
    try {
      body = await optimizeImage(file.buffer, folder);
      contentType = 'image/webp';
      baseName = baseName.replace(/.[a-zA-Z0-9]+$/, '') + '.webp';
    } catch (e) {
      // Unreadable by sharp (rare formats): keep the original rather than fail.
      console.warn('Image optimisation skipped:', e.message);
    }
  }
  const filePath = `${folder}/${userId}/${timestamp}_${baseName}`;

  try {
    // CHANGE 2: Use supabaseAdmin instead of supabase
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET_NAME)
      .upload(filePath, body, {
        contentType,
        // Paths are unique per upload, so the file never changes: let phones
        // and the CDN keep it for a year instead of re-downloading.
        cacheControl: '31536000',
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError.message);
      return res.status(500).json({ error: uploadError.message });
    }
    
    // CHANGE 3: Use supabaseAdmin to get URL
    const { data: publicURLData } = supabaseAdmin.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    res.status(200).json({
      message: 'File uploaded successfully!',
      url: publicURLData.publicUrl,
      path: filePath,
    });

  } catch (error) {
    console.error('Unexpected storage error:', error.message);
    res.status(500).json({ error: 'Internal server error during file upload.' });
  }
});

module.exports = router;