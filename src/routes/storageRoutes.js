const express = require('express');
const router = express.Router();
const multer = require('multer');
// CHANGE 1: Import supabaseAdmin
const { supabaseAdmin } = require('../config/supabase'); 
const authenticateToken = require('../middleware/authMiddleware');

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

  const allowedFolders = ['profiles', 'services', 'avatars'];
  if (!allowedFolders.includes(folder)) {
    return res.status(400).json({ error: `Invalid folder. Allowed: ${allowedFolders.join(', ')}` });
  }

  const timestamp = Date.now();
  const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
  const filePath = `${folder}/${userId}/${timestamp}_${sanitizedName}`;

  try {
    // CHANGE 2: Use supabaseAdmin instead of supabase
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET_NAME)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
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