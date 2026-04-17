const express = require('express');
require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');

const app = express();

// PostgreSQL connection – use env var DATABASE_URL or the connection string you provided
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://feedback_1dkl_user:1FqsxvBC7vWsLwagzRszJOW9kruEWq0P@dpg-d7h2adreo5us739n9vb0-a:5432/feedback_1dkl'
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ======================================================
// Database initialization – create tables if they don't exist
// ======================================================
async function initDB() {
  // PostgreSQL uses SERIAL or UUID; we'll keep TEXT IDs as before
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        tier TEXT DEFAULT 'basic',
        google_reviews_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        name TEXT NOT NULL,
        address TEXT,
        google_reviews_url TEXT,
        qr_code TEXT
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        location_id TEXT NOT NULL REFERENCES locations(id),
        rating INTEGER NOT NULL,
        feedback_text TEXT,
        contact_requested INTEGER DEFAULT 0,
        contact_name TEXT,
        contact_phone TEXT,
        contact_email TEXT,
        service_type TEXT,
        responded INTEGER DEFAULT 0,
        response_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert demo business if none exists
    const { rows: countRows } = await client.query('SELECT COUNT(*) FROM businesses');
    const count = parseInt(countRows[0].count, 10);
    if (count === 0) {
      const hashedPassword = bcrypt.hashSync('demo123', 10);
      const businessId = uuidv4();
      await client.query(
        `INSERT INTO businesses (id, name, slug, email, password, tier, google_reviews_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [businessId, 'The Local Choice', 'the-local-choice', 'demo@yourfeedback.biz', hashedPassword, 'pro', 'https://g.page/r/XXX/review']
      );

      const loc1Id = uuidv4();
      const loc2Id = uuidv4();
      await client.query(
        `INSERT INTO locations (id, business_id, name, address, google_reviews_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [loc1Id, businessId, 'Walker Drive', 'Walker Drive, Sandton', 'https://g.page/r/XXX/review']
      );
      await client.query(
        `INSERT INTO locations (id, business_id, name, address, google_reviews_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [loc2Id, businessId, 'Sandton Square', 'Sandton Square, Sandton', 'https://g.page/r/YYY/review']
      );
      console.log('✅ Demo business created: demo@yourfeedback.biz / demo123');
    }
  } finally {
    client.release();
  }
}

// ==============================
// CUSTOMER FEEDBACK ENDPOINTS
// ==============================

// Get locations for a business (via slug)
app.get('/api/:slug/locations', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: businessRows } = await client.query('SELECT id FROM businesses WHERE slug = $1', [req.params.slug]);
    if (businessRows.length === 0) return res.status(404).json({ error: 'Business not found' });
    const businessId = businessRows[0].id;
    const { rows: locations } = await client.query('SELECT * FROM locations WHERE business_id = $1', [businessId]);
    res.json(locations);
  } finally {
    client.release();
  }
});

// Submit feedback
app.post('/api/feedback', async (req, res) => {
  const { business_slug, location_id, rating, feedback_text, contact_requested, contact_name, contact_phone, contact_email, service_type } = req.body;
  const client = await pool.connect();
  try {
    const { rows: businessRows } = await client.query('SELECT id FROM businesses WHERE slug = $1', [business_slug]);
    if (businessRows.length === 0) return res.status(404).json({ error: 'Business not found' });
    const businessId = businessRows[0].id;
    const reviewId = uuidv4();
    await client.query(
      `INSERT INTO reviews (id, business_id, location_id, rating, feedback_text, contact_requested, contact_name, contact_phone, contact_email, service_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [reviewId, businessId, location_id, rating, feedback_text || null, contact_requested ? 1 : 0, contact_name || null, contact_phone || null, contact_email || null, service_type || null]
    );
    console.log('✅ Feedback saved:', { rating, location_id, feedback_text: feedback_text?.substring(0, 50) });
    res.json({ success: true, review_id: reviewId });
  } finally {
    client.release();
  }
});

// Get business info for thank you page
app.get('/api/:slug/thankyou', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM businesses WHERE slug = $1', [req.params.slug]);
    if (rows.length === 0) return res.status(404).json({ error: 'Business not found' });
    res.json(rows[0]);
  } finally {
    client.release();
  }
});

// ==============================
// ADMIN DASHBOARD ENDPOINTS
// ==============================

// Dashboard login page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Dashboard login
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM businesses WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const business = rows[0];
    if (!bcrypt.compareSync(password, business.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = Buffer.from(JSON.stringify({ business_id: business.id })).toString('base64');
    res.json({ success: true, business: { id: business.id, name: business.name, slug: business.slug, tier: business.tier }, token });
  } finally {
    client.release();
  }
});

// Get dashboard data
app.get('/api/admin/dashboard', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let business_id;
  try { ({ business_id } = JSON.parse(Buffer.from(token, 'base64').toString())); } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
  const client = await pool.connect();
  try {
    // Stats
    const { rows: totalRows } = await client.query('SELECT COUNT(*) FROM reviews WHERE business_id = $1', [business_id]);
    const { rows: avgRows } = await client.query('SELECT AVG(rating) FROM reviews WHERE business_id = $1', [business_id]);
    const { rows: respRows } = await client.query('SELECT CAST(SUM(responded) AS FLOAT)/COUNT(*) FROM reviews WHERE business_id = $1', [business_id]);
    const { rows: pendingRows } = await client.query('SELECT COUNT(*) FROM reviews WHERE business_id = $1 AND rating <= 6 AND responded = 0', [business_id]);
    const stats = {
      total_reviews: parseInt(totalRows[0].count, 10),
      avg_rating: parseFloat(avgRows[0].avg) || 0,
      response_rate: parseFloat(respRows[0].cast) || 0,
      pending_issues: parseInt(pendingRows[0].count, 10)
    };
    // Recent reviews
    const { rows: reviews } = await client.query(`
      SELECT r.*, l.name AS location_name
      FROM reviews r
      JOIN locations l ON r.location_id = l.id
      WHERE r.business_id = $1
      ORDER BY r.created_at DESC
      LIMIT 50
    `, [business_id]);
    // Locations for QR
    const { rows: locations } = await client.query('SELECT * FROM locations WHERE business_id = $1', [business_id]);
    res.json({ stats, reviews, locations });
  } finally {
    client.release();
  }
});

// Reply to a review
app.post('/api/admin/review/:id/respond', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let business_id;
  try { ({ business_id } = JSON.parse(Buffer.from(token, 'base64').toString())); } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
  const { response_text } = req.body;
  const client = await pool.connect();
  try {
    await client.query('UPDATE reviews SET response_text = $1, responded = 1 WHERE id = $2 AND business_id = $3', [response_text, req.params.id, business_id]);
    res.json({ success: true });
  } finally {
    client.release();
  }
});

// Generate QR code for a location
app.get('/api/admin/location/:id/qr', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT l.*, b.slug FROM locations l JOIN businesses b ON l.business_id = b.id WHERE l.id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Location not found' });
    const location = rows[0];
    const baseUrl = `${req.protocol}://${req.get('host')}/r/${location.slug}/${location.id}`;
    const qrDataUrl = await QRCode.toDataURL(baseUrl);
    res.json({ qr: qrDataUrl, url: baseUrl });
  } finally {
    client.release();
  }
});

// Serve feedback page (public QR link)
app.get('/r/:slug/:locationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feedback.html'));
});

// Serve main business page
app.get('/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server after DB init
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Feedback platform running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
