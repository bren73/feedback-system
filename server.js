const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const db = new Database('feedback.db');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ============= DATABASE SETUP =============
function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      tier TEXT DEFAULT 'basic',
      google_reviews_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      google_reviews_url TEXT,
      qr_code TEXT,
      FOREIGN KEY (business_id) REFERENCES businesses(id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      feedback_text TEXT,
      contact_requested INTEGER DEFAULT 0,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      service_type TEXT,
      responded INTEGER DEFAULT 0,
      response_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES businesses(id),
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );
  `);

  // Create demo business if none exists
  const count = db.prepare('SELECT COUNT(*) as cnt FROM businesses').get();
  if (count.cnt === 0) {
    const hashedPassword = bcrypt.hashSync('demo123', 10);
    const businessId = uuidv4();
    
    db.prepare(`
      INSERT INTO businesses (id, name, slug, email, password, tier, google_reviews_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(businessId, 'The Local Choice', 'the-local-choice', 'demo@yourfeedback.biz', hashedPassword, 'pro', 'https://g.page/r/XXX/review');
    
    // Add locations
    const loc1Id = uuidv4();
    const loc2Id = uuidv4();
    
    db.prepare(`INSERT INTO locations (id, business_id, name, address, google_reviews_url) VALUES (?, ?, ?, ?, ?)`)
      .run(loc1Id, businessId, 'Walker Drive', 'Walker Drive, Sandton', 'https://g.page/r/XXX/review');
    db.prepare(`INSERT INTO locations (id, business_id, name, address, google_reviews_url) VALUES (?, ?, ?, ?, ?)`)
      .run(loc2Id, businessId, 'Sandton Square', 'Sandton Square, Sandton', 'https://g.page/r/YYY/review');
    
    console.log('✅ Demo business created: demo@yourfeedback.biz / demo123');
  }
}

// ============= CUSTOMER FEEDBACK ROUTES =============

// Get locations for a business (via slug)
app.get('/api/:slug/locations', (req, res) => {
  const business = db.prepare('SELECT id FROM businesses WHERE slug = ?').get(req.params.slug);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  
  const locations = db.prepare('SELECT * FROM locations WHERE business_id = ?').all(business.id);
  res.json(locations);
});

// Submit feedback
app.post('/api/feedback', (req, res) => {
  const { business_slug, location_id, rating, feedback_text, contact_requested, contact_name, contact_phone, contact_email, service_type } = req.body;
  
  const business = db.prepare('SELECT id FROM businesses WHERE slug = ?').get(business_slug);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  
  const reviewId = uuidv4();
  db.prepare(`
    INSERT INTO reviews (id, business_id, location_id, rating, feedback_text, contact_requested, contact_name, contact_phone, contact_email, service_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(reviewId, business.id, location_id, rating, feedback_text || null, contact_requested ? 1 : 0, contact_name || null, contact_phone || null, contact_email || null, service_type || null);
  
  console.log('✅ Feedback saved:', { rating, location_id, feedback_text: feedback_text?.substring(0, 50) });
  res.json({ success: true, review_id: reviewId });
});

// Get business info for thank you page
app.get('/api/:slug/thankyou', (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(req.params.slug);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  res.json(business);
});

// ============= BUSINESS DASHBOARD ROUTES =============

// Dashboard login page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Dashboard login
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const business = db.prepare('SELECT * FROM businesses WHERE email = ?').get(email);
  
  if (!business || !bcrypt.compareSync(password, business.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  res.json({ 
    success: true, 
    business: { id: business.id, name: business.name, slug: business.slug, tier: business.tier },
    token: Buffer.from(JSON.stringify({ business_id: business.id })).toString('base64')
  });
});

// Get dashboard data
app.get('/api/admin/dashboard', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  let business_id;
  try {
    ({ business_id } = JSON.parse(Buffer.from(token, 'base64').toString()));
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  // Get stats
  const stats = {
    total_reviews: db.prepare('SELECT COUNT(*) as cnt FROM reviews WHERE business_id = ?').get(business_id).cnt,
    avg_rating: db.prepare('SELECT AVG(rating) as avg FROM reviews WHERE business_id = ?').get(business_id).avg || 0,
    response_rate: db.prepare('SELECT (CAST(SUM(responded) AS FLOAT) / COUNT(*)) as rate FROM reviews WHERE business_id = ?').get(business_id).rate || 0,
    pending_issues: db.prepare('SELECT COUNT(*) as cnt FROM reviews WHERE business_id = ? AND rating <= 6 AND responded = 0').get(business_id).cnt
  };
  
  // Get recent reviews
  const reviews = db.prepare(`
    SELECT r.*, l.name as location_name 
    FROM reviews r 
    JOIN locations l ON r.location_id = l.id 
    WHERE r.business_id = ? 
    ORDER BY r.created_at DESC 
    LIMIT 50
  `).all(business_id);
  
  // Get locations for QR generation
  const locations = db.prepare('SELECT * FROM locations WHERE business_id = ?').all(business_id);
  
  res.json({ stats, reviews, locations });
});

// Reply to a review
app.post('/api/admin/review/:id/respond', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  let business_id;
  try {
    ({ business_id } = JSON.parse(Buffer.from(token, 'base64').toString()));
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const { response_text } = req.body;
  db.prepare('UPDATE reviews SET response_text = ?, responded = 1 WHERE id = ? AND business_id = ?')
    .run(response_text, req.params.id, business_id);
  
  res.json({ success: true });
});

// Generate QR code
app.get('/api/admin/location/:id/qr', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  const location = db.prepare('SELECT l.*, b.slug FROM locations l JOIN businesses b ON l.business_id = b.id WHERE l.id = ?').get(req.params.id);
  if (!location) return res.status(404).json({ error: 'Location not found' });
  
  const baseUrl = `${req.protocol}://${req.get('host')}/r/${location.slug}/${location.id}`;
  const qrDataUrl = await QRCode.toDataURL(baseUrl);
  
  res.json({ qr: qrDataUrl, url: baseUrl });
});

// Serve feedback page
app.get('/r/:slug/:locationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feedback.html'));
});

// Serve main business page
app.get('/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
initDB();
app.listen(PORT, () => {
  console.log(`🚀 Feedback platform running on port ${PORT}`);
});
