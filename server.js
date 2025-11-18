const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const SECRET_CODE = 'IMAGEFY2025PRO';
let db;

// Connect to MongoDB
MongoClient.connect(process.env.MONGODB_URI)
  .then(client => {
    db = client.db('imagefy');
    console.log('✅ Database connected');
  });

// Stripe Webhook - Auto-activate Pro when user pays
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;
    
    // Save to database
    await db.collection('users').updateOne(
      { email },
      { $set: { isPro: true, activatedAt: new Date() } },
      { upsert: true }
    );
    
    console.log(`✅ Pro activated for: ${email}`);
  }

  res.json({received: true});
});

// Check if user is Pro
app.post('/check-pro', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.json({ isPro: false });
  }

  const user = await db.collection('users').findOne({ email });
  res.json({ isPro: user?.isPro || false });
});

// Verify secret code (server-side = secure)
app.post('/verify-code', async (req, res) => {
  const { code, email } = req.body;
  
  if (code === SECRET_CODE) {
    // Activate Pro
    await db.collection('users').updateOne(
      { email },
      { $set: { isPro: true, activatedAt: new Date(), method: 'secret_code' } },
      { upsert: true }
    );
    
    res.json({ success: true, isPro: true });
  } else {
    res.json({ success: false, isPro: false });
  }
});

// Get email from Stripe session
app.post('/get-session-email', async (req, res) => {
  const { sessionId } = req.body;
  
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.json({ email: session.customer_email });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(400).json({ error: 'Invalid session' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Backend running on port', process.env.PORT || 3000);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Backend running!');
});
