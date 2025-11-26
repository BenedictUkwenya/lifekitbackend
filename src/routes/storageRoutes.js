// src/routes/storageRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../config/supabase');
const authenticateToken = require('../middleware/authMiddleware');

// Configure Multer to use memory storage so Supabase can access the buffer
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  }
});

const BUCKET_NAME = 'lifekit_images';

/**
 * POST /storage/upload/:folder
 * Handles file upload to Supabase Storage.
 * :folder can be 'profiles' or 'services'
 */
router.post('/upload/:folder', authenticateToken, upload.single('file'), async (req, res) => {
  const { folder } = req.params;
  const userId = req.user.id;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  // Basic security check: ensure folder is one of the allowed types
  if (folder !== 'profiles' && folder !== 'services') {
    return res.status(400).json({ error: 'Invalid upload folder specified.' });
  }

  // Create a unique file path: e.g., 'profiles/user_id/timestamp_originalfilename.jpg'
  const timestamp = Date.now();
  const fileExtension = file.originalname.split('.').pop();
  const filePath = `${folder}/${userId}/${timestamp}_${file.originalname.replace(/ /g, '_')}`;

  try {
    // 1. Upload the file to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false // Do not overwrite existing files with the same name
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError.message);
      return res.status(500).json({ error: 'Failed to upload file to storage.' });
    }
    
    // 2. Get the public URL for the uploaded file
    const { data: publicURLData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    if (!publicURLData || !publicURLData.publicUrl) {
       return res.status(500).json({ error: 'Failed to generate public URL.' });
    }


    // 3. Return the public URL to the client
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