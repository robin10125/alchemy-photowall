# PhotoWall — Rolling Photo Reel with Admin Moderation

A community photo wall that displays approved images in hypnotic rolling columns. Users upload photos, admins approve or reject them, and approved images appear on a public display with smooth scrolling reels.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────┐
│  Public Wall │────▶│  Express API │────▶│ AWS S3  │
│  (index.html)│     │  (server.js) │     │ Bucket  │
└─────────────┘     └──────────────┘     └─────────┘
                           ▲
┌─────────────┐            │
│ Upload Page  │───────────┤
│ (upload.html)│            │
└─────────────┘            │
                           │
┌─────────────┐            │
│ Admin Panel  │───────────┘
│ (admin.html) │
└─────────────┘
```

**Key flows:**
1. **User uploads** → image is processed (resized, optimized via Sharp) → stored in S3 → marked `pending`
2. **Admin reviews** → sees only pending images → approves or rejects each one
3. **Public display** → polls for approved images → renders in rolling reel columns
4. **Rejected images** → deleted from S3 immediately, purged from memory

## Quick Start

### 1. Prerequisites
- Node.js 18+
- An AWS account with an S3 bucket

### 2. Create an S3 Bucket

```bash
aws s3 mb s3://your-photo-wall-bucket --region us-east-1
```

Set the bucket's CORS policy (required for browser uploads):
```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

### 3. Set Environment Variables

```bash
export S3_BUCKET=your-photo-wall-bucket
export S3_REGION=us-east-1
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=your-secure-password
export PORT=3000
```

### 4. Install & Run

```bash
npm install
npm start
```

### 5. Access

| Page | URL |
|------|-----|
| Public photo wall | `http://localhost:3000` |
| Upload page | `http://localhost:3000/upload.html` |
| Admin panel | `http://localhost:3000/admin.html` |

## Pages

### Public Display (`/`)
- Rolling photo reels in 3-5 columns (responsive)
- Alternating scroll directions per column
- Varied scroll speeds for organic feel
- Hover pauses animation
- Auto-polls for new approved images every 8 seconds
- Fade effects at top/bottom edges

### Upload Page (`/upload.html`)
- Drag-and-drop or click-to-browse
- Client-side file type and size validation
- Image preview before upload
- Progress indication
- Success/error feedback
- Rate limited: 10 uploads per 15 minutes per IP

### Admin Dashboard (`/admin.html`)
- Basic auth login (credentials from env vars)
- **Only shows pending images** — approved/rejected are hidden
- Per-image approve/reject buttons
- Bulk select, approve, or reject
- Lightbox preview of full-size images
- Real-time stats (pending, approved, total, capacity)
- Auto-polls every 5 seconds for new submissions
- Toast notifications for actions
- Smooth card removal animations

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/upload` | No | Upload a photo (multipart/form-data, field: `photo`) |
| `GET` | `/api/images` | No | Get all approved image URLs |
| `GET` | `/api/image/:id` | No | Serve full-size approved image (proxied from S3) |
| `GET` | `/api/image/:id/thumb` | No | Serve thumbnail of approved image |
| `GET` | `/api/admin/pending` | Basic | Get all pending images |
| `GET` | `/api/admin/preview/:id` | Basic | Preview a pending image |
| `POST` | `/api/admin/approve/:id` | Basic | Approve a pending image |
| `POST` | `/api/admin/reject/:id` | Basic | Reject and delete a pending image |
| `POST` | `/api/admin/bulk` | Basic | Bulk approve/reject `{ ids: [], action: "approve"|"reject" }` |
| `GET` | `/api/admin/stats` | Basic | Get image count stats |

## Scaling for 500 Concurrent Users

The current architecture handles 500 users well:

**Already built in:**
- Rate limiting (120 API req/min globally, 10 uploads/15min per IP)
- Image optimization (Sharp resizes to 1200px max, JPEG at 80% quality)
- Thumbnail generation (400px wide for reel display)
- S3 storage (infinitely scalable object storage)
- Client-side polling at 8s intervals (not WebSockets, reduces server load)
- In-memory image metadata (fast reads, no DB latency)
- `Cache-Control` headers on served images

**For production at scale, add:**

1. **Replace in-memory store with a database:**
   ```bash
   # PostgreSQL or DynamoDB for image metadata
   # Redis for caching approved image lists
   ```

2. **Use a CDN (CloudFront) in front of S3:**
   ```
   S3 → CloudFront → Users
   ```
   This offloads image serving entirely from your server.

3. **Use S3 presigned URLs** instead of proxying through Express:
   ```js
   // Already imported in server.js — just enable:
   const url = await getSignedUrl(s3, new GetObjectCommand({...}), { expiresIn: 3600 });
   ```

4. **Run behind a reverse proxy:**
   ```nginx
   upstream photowall {
     server 127.0.0.1:3000;
     server 127.0.0.1:3001;
   }
   ```

5. **Deploy with PM2 for clustering:**
   ```bash
   pm2 start server.js -i max
   ```

## Production Deployment Checklist

- [ ] Set strong `ADMIN_PASSWORD`
- [ ] Use HTTPS (terminate SSL at load balancer or Nginx)
- [ ] Set up CloudFront CDN for S3 bucket
- [ ] Replace in-memory store with PostgreSQL + Redis
- [ ] Add PM2 or Docker for process management
- [ ] Set up S3 lifecycle policies to auto-delete old rejected objects
- [ ] Add request logging (Morgan or Pino)
- [ ] Add image content moderation (AWS Rekognition) for auto-flagging
- [ ] Set up monitoring (health check endpoint, uptime alerts)
- [ ] Back up database regularly

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `S3_BUCKET` | `your-photo-wall-bucket` | S3 bucket name |
| `S3_REGION` | `us-east-1` | AWS region |
| `AWS_ACCESS_KEY_ID` | — | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | — | AWS credentials |
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | `changeme123` | Admin login password |

## Tech Stack

- **Backend:** Node.js, Express
- **Storage:** AWS S3
- **Image Processing:** Sharp (resize, optimize, thumbnails)
- **Frontend:** Vanilla HTML/CSS/JS (no framework overhead)
- **Auth:** HTTP Basic Auth (admin only)
- **Rate Limiting:** express-rate-limit
