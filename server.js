require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Configuration ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const S3_BUCKET = process.env.S3_BUCKET || 'your-photo-wall-bucket';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const MAX_IMAGES = 1000;
const APPROVAL_SIGNING_SECRET = process.env.APPROVAL_SIGNING_SECRET || ADMIN_PASSWORD;

// ─── S3 Client ───────────────────────────────────────────────────
const s3 = new S3Client({
  region: S3_REGION,
  // credentials auto-loaded from env vars or IAM role:
  // AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
});

// ─── In-Memory Store (swap for Redis/DB in production) ──────────
// Status: 'pending' | 'approved' | 'rejected'
const images = new Map(); // id -> { id, key, originalName, uploadedAt, status, mimeType }
let approvedOrder = []; // ordered list of approved image IDs for display

function recordKeyForId(id) {
  return `metadata/${id}.json`;
}

function recordSignature(record) {
  const payload = [
    record.id,
    record.key,
    record.thumbKey,
    record.originalName,
    record.uploadedAt,
    record.status,
    record.mimeType,
    record.approvedAt || '',
  ].join('|');

  return crypto
    .createHmac('sha256', APPROVAL_SIGNING_SECRET)
    .update(payload)
    .digest('hex');
}

function serializeRecord(img) {
  const record = {
    id: img.id,
    key: img.key,
    thumbKey: img.thumbKey,
    originalName: img.originalName,
    uploadedAt: img.uploadedAt,
    status: img.status,
    mimeType: img.mimeType,
    approvedAt: img.approvedAt || null,
  };

  return {
    ...record,
    signature: recordSignature(record),
  };
}

function deserializeRecord(raw) {
  const {
    signature,
    id,
    key,
    thumbKey,
    originalName,
    uploadedAt,
    status,
    mimeType,
    approvedAt,
  } = raw || {};

  if (!signature || !id || !key || !thumbKey || !uploadedAt || !status || !mimeType) {
    return null;
  }

  const expected = recordSignature({
    id,
    key,
    thumbKey,
    originalName: originalName || `recovered-${id.slice(0, 8)}.jpg`,
    uploadedAt,
    status,
    mimeType,
    approvedAt: approvedAt || null,
  });

  if (expected !== signature) return null;

  return {
    id,
    key,
    thumbKey,
    originalName: originalName || `recovered-${id.slice(0, 8)}.jpg`,
    uploadedAt,
    status,
    mimeType,
    approvedAt: approvedAt || null,
  };
}

async function persistImageRecord(img) {
  const record = serializeRecord(img);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: recordKeyForId(img.id),
    Body: JSON.stringify(record),
    ContentType: 'application/json',
  }));
}

// ─── Rate Limiting ───────────────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 uploads per IP per window
  message: { error: 'Too many uploads, please try again later.' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120, // 120 requests/min — supports 500 concurrent users polling
  message: { error: 'Rate limit exceeded.' }
});

app.use('/api/', apiLimiter);

// ─── Multer for file uploads ─────────────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed.'));
    }
  }
});

// ─── Basic Auth Middleware for Admin ─────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === ADMIN_USERNAME && pass === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(403).json({ error: 'Invalid credentials' });
}

// ─── UPLOAD ENDPOINT ─────────────────────────────────────────────
app.post('/api/upload', uploadLimiter, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Check total image count
    const activeCount = [...images.values()].filter(i => i.status !== 'rejected').length;
    if (activeCount >= MAX_IMAGES) {
      return res.status(400).json({ error: 'Maximum image capacity reached.' });
    }

    // Process image with sharp — resize to max 1200px wide, optimize
    const processed = await sharp(req.file.buffer)
      .resize(1200, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Generate thumbnail
    const thumbnail = await sharp(req.file.buffer)
      .resize(400, 600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();

    const id = crypto.randomUUID();
    const key = `uploads/${id}.jpg`;
    const thumbKey = `thumbnails/${id}.jpg`;

    // Upload to S3
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: processed,
      ContentType: 'image/jpeg',
    }));

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: thumbKey,
      Body: thumbnail,
      ContentType: 'image/jpeg',
    }));

    // Store metadata
    images.set(id, {
      id,
      key,
      thumbKey,
      originalName: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      status: 'pending',
      mimeType: 'image/jpeg',
      approvedAt: null,
    });

    await persistImageRecord(images.get(id));

    res.json({ success: true, id, message: 'Photo uploaded! It will appear after admin approval.' });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// ─── PUBLIC: Get approved images ─────────────────────────────────
app.get('/api/images', async (req, res) => {
  try {
    const approved = approvedOrder
      .map(id => images.get(id))
      .filter(Boolean)
      .map(img => ({
        id: img.id,
        url: `/api/image/${img.id}`,
        thumbUrl: `/api/image/${img.id}/thumb`,
      }));

    res.json({ images: approved, total: approved.length });
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: 'Failed to load images.' });
  }
});

// ─── PUBLIC: Serve image (proxied from S3) ───────────────────────
app.get('/api/image/:id', async (req, res) => {
  try {
    const img = images.get(req.params.id);
    if (!img || img.status !== 'approved') {
      return res.status(404).json({ error: 'Image not found' });
    }

    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: img.key });
    const s3Response = await s3.send(command);

    res.set('Content-Type', img.mimeType);
    res.set('Cache-Control', 'public, max-age=3600');
    s3Response.Body.pipe(res);
  } catch (err) {
    console.error('Image serve error:', err);
    res.status(500).json({ error: 'Failed to load image.' });
  }
});

// ─── PUBLIC: Serve thumbnail ─────────────────────────────────────
app.get('/api/image/:id/thumb', async (req, res) => {
  try {
    const img = images.get(req.params.id);
    if (!img || img.status !== 'approved') {
      return res.status(404).json({ error: 'Image not found' });
    }

    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: img.thumbKey });
    const s3Response = await s3.send(command);

    res.set('Content-Type', img.mimeType);
    res.set('Cache-Control', 'public, max-age=3600');
    s3Response.Body.pipe(res);
  } catch (err) {
    console.error('Thumbnail serve error:', err);
    res.status(500).json({ error: 'Failed to load thumbnail.' });
  }
});

// ─── ADMIN: Get pending images ───────────────────────────────────
app.get('/api/admin/pending', adminAuth, async (req, res) => {
  try {
    const pending = [...images.values()]
      .filter(img => img.status === 'pending')
      .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt))
      .map(img => ({
        id: img.id,
        originalName: img.originalName,
        uploadedAt: img.uploadedAt,
        previewUrl: `/api/admin/preview/${img.id}`,
      }));

    res.json({ images: pending, total: pending.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pending images.' });
  }
});

// ─── ADMIN: Preview pending image ────────────────────────────────
app.get('/api/admin/preview/:id', adminAuth, async (req, res) => {
  try {
    const img = images.get(req.params.id);
    if (!img || img.status !== 'pending') {
      return res.status(404).json({ error: 'Image not found' });
    }

    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: img.key });
    const s3Response = await s3.send(command);

    res.set('Content-Type', img.mimeType);
    s3Response.Body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load preview.' });
  }
});

// ─── ADMIN: Approve image ────────────────────────────────────────
app.post('/api/admin/approve/:id', adminAuth, async (req, res) => {
  try {
    const img = images.get(req.params.id);
    if (!img) return res.status(404).json({ error: 'Image not found' });
    if (img.status !== 'pending') return res.status(400).json({ error: 'Image is not pending.' });

    img.status = 'approved';
    img.approvedAt = new Date().toISOString();
    approvedOrder.push(img.id);
    await persistImageRecord(img);

    res.json({ success: true, message: 'Image approved.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve image.' });
  }
});

// ─── ADMIN: Reject image (delete from S3) ────────────────────────
app.post('/api/admin/reject/:id', adminAuth, async (req, res) => {
  try {
    const img = images.get(req.params.id);
    if (!img) return res.status(404).json({ error: 'Image not found' });
    if (img.status !== 'pending') return res.status(400).json({ error: 'Image is not pending.' });

    // Delete from S3
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: img.key }));
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: img.thumbKey }));

    img.status = 'rejected';
    img.approvedAt = null;
    await persistImageRecord(img);
    // Remove from map after a delay (or immediately)
    setTimeout(() => images.delete(img.id), 60000);

    res.json({ success: true, message: 'Image rejected and deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject image.' });
  }
});

// ─── ADMIN: Bulk actions ─────────────────────────────────────────
app.post('/api/admin/bulk', adminAuth, async (req, res) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const results = [];
  for (const id of ids) {
    const img = images.get(id);
    if (!img || img.status !== 'pending') {
      results.push({ id, success: false, reason: 'Not found or not pending' });
      continue;
    }

    if (action === 'approve') {
      img.status = 'approved';
      img.approvedAt = new Date().toISOString();
      approvedOrder.push(img.id);
      await persistImageRecord(img);
      results.push({ id, success: true });
    } else {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: img.key }));
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: img.thumbKey }));
      } catch (e) { /* continue */ }
      img.status = 'rejected';
      img.approvedAt = null;
      await persistImageRecord(img);
      setTimeout(() => images.delete(img.id), 60000);
      results.push({ id, success: true });
    }
  }

  res.json({ results });
});

// ─── ADMIN: Stats ────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const all = [...images.values()];
  res.json({
    total: all.length,
    pending: all.filter(i => i.status === 'pending').length,
    approved: all.filter(i => i.status === 'approved').length,
    rejected: all.filter(i => i.status === 'rejected').length,
    capacity: MAX_IMAGES,
  });
});

// ─── Error handler ───────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async () => {
  console.log(`🚀 Photo Wall server running on port ${PORT}`);
  console.log(`   Public display: http://localhost:${PORT}`);
  console.log(`   Admin panel:    http://localhost:${PORT}/admin.html`);
  console.log(`   Upload page:    http://localhost:${PORT}/upload.html`);

  // ─── Re-sync images from S3 on startup ───────────────────────
  try {
    console.log('   Scanning S3 bucket for persisted metadata...');
    const metadataList = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: 'metadata/',
    }));

    const metadataObjects = (metadataList.Contents || []).filter(obj => obj.Key !== 'metadata/');
    let recoveredFromMetadata = 0;

    for (const obj of metadataObjects) {
      try {
        const metadataResponse = await s3.send(new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: obj.Key,
        }));
        const content = await metadataResponse.Body.transformToString();
        const parsed = JSON.parse(content);
        const restored = deserializeRecord(parsed);
        if (!restored) {
          console.warn(`   ⚠ Ignored tampered or invalid metadata file: ${obj.Key}`);
          continue;
        }
        images.set(restored.id, restored);
        if (restored.status === 'approved') {
          approvedOrder.push(restored.id);
        }
        recoveredFromMetadata++;
      } catch (e) {
        console.warn(`   ⚠ Failed to read metadata ${obj.Key}: ${e.message}`);
      }
    }

    approvedOrder = approvedOrder
      .map(id => images.get(id))
      .filter(Boolean)
      .sort((a, b) => new Date(a.approvedAt || a.uploadedAt) - new Date(b.approvedAt || b.uploadedAt))
      .map(img => img.id);

    console.log(`   ✓ Recovered ${recoveredFromMetadata} image record(s) from metadata`);

    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: 'uploads/',
    }));

    const objects = (listRes.Contents || []).filter(obj => obj.Key !== 'uploads/');
    let recoveredLegacy = 0;

    for (const obj of objects) {
      // Extract ID from key: uploads/{id}.jpg
      const match = obj.Key.match(/^uploads\/(.+)\.jpg$/);
      if (!match) continue;
      const id = match[1];

      // Skip if already tracked
      if (images.has(id)) continue;

      // Check if thumbnail exists
      const thumbKey = `thumbnails/${id}.jpg`;

      images.set(id, {
        id,
        key: obj.Key,
        thumbKey,
        originalName: `recovered-${id.slice(0, 8)}.jpg`,
        uploadedAt: obj.LastModified ? obj.LastModified.toISOString() : new Date().toISOString(),
        status: 'pending',
        mimeType: 'image/jpeg',
        approvedAt: null,
      });
      await persistImageRecord(images.get(id));
      recoveredLegacy++;
    }

    if (recoveredLegacy > 0) {
      console.log(`   ✓ Migrated ${recoveredLegacy} legacy image(s) to signed metadata records`);
    } else {
      console.log('   ✓ No legacy images found in S3');
    }
  } catch (err) {
    console.warn('   ⚠ Could not scan S3 bucket:', err.message);
    console.warn('     (Images uploaded this session will still work)');
  }
});
