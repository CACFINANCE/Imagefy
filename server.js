const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient } = require('mongodb');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// ============================================
// RATE LIMITERS
// ============================================
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per IP
  message: { success: false, message: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// CREDIT CONFIGURATION
// Tune these constants to control monthly allocations.
// ============================================
const PRO_MONTHLY_CREDITS         = 1000;  // Stripe Pro subscribers
const PROPLUS_MONTHLY_CREDITS     = 2500;  // Stripe Pro+ subscribers (if/when wired)
const SECRET_CODE_MONTHLY_CREDITS = 1000;  // Lifetime-code users
const CREDIT_RESET_DAYS           = 30;    // Refresh cycle length

function nextResetDate(days = CREDIT_RESET_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function monthlyAllocationFor(planType) {
  if (planType === 'proplus')      return PROPLUS_MONTHLY_CREDITS;
  if (planType === 'pro_lifetime') return SECRET_CODE_MONTHLY_CREDITS;
  return PRO_MONTHLY_CREDITS;
}

// Refresh a user's credits if their reset date has passed (or is missing).
// Returns the canonical { credits, creditsResetDate, planType } shape used by all
// credit-aware endpoints, regardless of whether a refresh actually happened.
async function refreshCreditsIfDue(user) {
  if (!user || !user.isPro) {
    return { credits: 0, creditsResetDate: null, planType: null };
  }

  const planType = user.planType
    || (user.method === 'secret_code' ? 'pro_lifetime' : 'pro');
  const allocation = monthlyAllocationFor(planType);

  const now = new Date();
  const needsRefresh = !user.creditsResetDate
    || new Date(user.creditsResetDate) <= now;

  if (needsRefresh) {
    const resetDate = nextResetDate();
    await db.collection('users').updateOne(
      { email: user.email },
      { $set: { credits: allocation, creditsResetDate: resetDate, planType } }
    );
    return { credits: allocation, creditsResetDate: resetDate, planType };
  }

  return {
    credits: typeof user.credits === 'number' ? user.credits : allocation,
    creditsResetDate: user.creditsResetDate,
    planType
  };
}

// ============================================
// WEBHOOK ROUTE (MUST BE FIRST - BEFORE JSON PARSING)
// ============================================
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('✅ Webhook received:', event.type);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed (initial purchase)
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;

    console.log('💳 Checkout completed for:', email);

    if (email) {
      try {
        // Default all checkouts to the Pro tier for now. If/when you wire
        // Pro+ via a separate price ID, branch on session.metadata or
        // the line items to pick PROPLUS_MONTHLY_CREDITS instead.
        const planType = 'pro';
        const credits = monthlyAllocationFor(planType);
        const resetDate = nextResetDate();

        await db.collection('users').updateOne(
          { email },
          {
            $set: {
              isPro: true,
              activatedAt: new Date(),
              method: 'stripe',
              stripeCustomerId: session.customer,
              subscriptionId: session.subscription,
              credits,
              creditsResetDate: resetDate,
              planType
            }
          },
          { upsert: true }
        );
        console.log(`✅ User marked as Pro (${credits} credits):`, email);
      } catch (error) {
        console.error('❌ Database error:', error);
      }
    } else {
      console.error('❌ No email found in checkout session');
    }
  }

  // Handle invoice.payment_succeeded (recurring payments)
  else if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    console.log('💳 Invoice payment succeeded for customer:', invoice.customer);

    try {
      const customer = await stripe.customers.retrieve(invoice.customer);
      const email = customer.email;

      console.log('💳 Email:', email);

      if (email) {
        // Refill credits on each successful renewal. Reuses planType if the
        // user already has one; otherwise defaults to 'pro'.
        const existing = await db.collection('users').findOne({ email });
        const planType = existing?.planType || 'pro';
        const credits = monthlyAllocationFor(planType);
        const resetDate = nextResetDate();

        await db.collection('users').updateOne(
          { email },
          {
            $set: {
              isPro: true,
              lastPayment: new Date(),
              method: 'stripe',
              stripeCustomerId: invoice.customer,
              credits,
              creditsResetDate: resetDate,
              planType
            }
          },
          { upsert: true }
        );
        console.log(`✅ Pro renewed for ${email} (refilled to ${credits} credits)`);
      } else {
        console.error('❌ No email found for customer');
      }
    } catch (error) {
      console.error('❌ Error processing invoice payment:', error);
    }
  }

  // Handle subscription updates
  else if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;

    console.log('🔄 Subscription updated:', subscription.status);

    try {
      const customer = await stripe.customers.retrieve(subscription.customer);
      const email = customer.email;

      console.log('🔄 For:', email);

      if (email) {
        const isPro = subscription.status === 'active' || subscription.status === 'trialing';

        await db.collection('users').updateOne(
          { email },
          {
            $set: {
              isPro: isPro,
              subscriptionStatus: subscription.status,
              updatedAt: new Date()
            }
          }
        );
        console.log(`✅ Pro status updated to ${isPro} for:`, email);
      }
    } catch (error) {
      console.error('❌ Error processing subscription update:', error);
    }
  }

  // Handle subscription deletion (cancellation) - ONLY for Stripe subscriptions
  else if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;

    console.log('❌ Subscription cancelled');

    try {
      const customer = await stripe.customers.retrieve(subscription.customer);
      const email = customer.email;

      console.log('❌ For:', email);

      if (email) {
        // Check if user has lifetime code access - if so, don't remove Pro
        const user = await db.collection('users').findOne({ email });

        if (user && user.method === 'secret_code') {
          console.log('⚠️ User has lifetime code access - keeping Pro status');
          await db.collection('users').updateOne(
            { email },
            {
              $set: {
                subscriptionStatus: 'cancelled',
                cancelledAt: new Date()
              },
              $unset: {
                stripeCustomerId: "",
                subscriptionId: ""
              }
            }
          );
        } else {
          // Regular Stripe user - remove Pro
          await db.collection('users').updateOne(
            { email },
            {
              $set: {
                isPro: false,
                cancelledAt: new Date(),
                subscriptionStatus: 'cancelled'
              }
            }
          );
          console.log('✅ Pro status removed for:', email);
        }
      }
    } catch (error) {
      console.error('❌ Error processing cancellation:', error);
    }
  }

  res.json({ received: true });
});

// ============================================
// MIDDLEWARE (AFTER WEBHOOK)
// ============================================
app.use(cors());
app.use(express.json());

// ============================================
// CONFIGURATION - SECRET CODES (HIDDEN FROM USERS)
// These codes grant PERMANENT/LIFETIME Pro access
// Reusable by anyone who knows them
// Valid until changed in environment variables
// ============================================
const SECRET_CODES = new Set([
  process.env.SECRET_CODE_1,
  process.env.SECRET_CODE_2,
  process.env.SECRET_CODE_3,
].filter(Boolean)); // Remove undefined/null values

// Pexels API Key
const PEXELS_API_KEY = 'ymdzigbV5NbLWIZSnPh4Usl5t5TAUYN5k8NsoNc9ePQYMIXrMlaHdYip';

let db;

// ============================================
// DATABASE CONNECTION
// ============================================
MongoClient.connect(process.env.MONGODB_URI)
  .then(client => {
    db = client.db('imagefy');
    console.log('✅ MongoDB connected');

    // Create indexes for better performance
    db.collection('users').createIndex({ email: 1 }, { unique: true });
    console.log('✅ Database indexes created');
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Imagefy Backend Running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Check if user is Pro (now also returns credits, so a single round-trip
// gives the frontend everything it needs)
app.post('/check-pro', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.json({ isPro: false });
  }

  try {
    const user = await db.collection('users').findOne({ email });
    const isPro = user?.isPro || false;

    console.log('Checking Pro status for:', email, '→', isPro);

    if (!isPro) {
      return res.json({
        isPro: false,
        subscriptionStatus: user?.subscriptionStatus || null,
        method: user?.method || null
      });
    }

    const { credits, creditsResetDate, planType } = await refreshCreditsIfDue(user);

    res.json({
      isPro: true,
      subscriptionStatus: user?.subscriptionStatus || null,
      method: user?.method || null,
      credits,
      creditsResetDate,
      planType
    });
  } catch (error) {
    console.error('Error checking Pro status:', error);
    res.json({ isPro: false });
  }
});

// Verify secret code (HIDDEN ENDPOINT - grants LIFETIME Pro access + credits)
app.post('/verify-code', codeLimiter, async (req, res) => {
  const { code, email } = req.body;

  // Validate inputs
  if (!email || !code) {
    console.log('❌ Missing email or code');
    return res.json({ success: false, message: 'Email and code required' });
  }

  // Validate email format
  if (!email.includes('@') || !email.includes('.')) {
    console.log('❌ Invalid email format:', email);
    return res.json({ success: false, message: 'Invalid email format' });
  }

  // Normalize code (trim whitespace, uppercase)
  const normalizedCode = code.trim().toUpperCase();

  // Check if code is valid (server-side validation - SECURE!)
  if (SECRET_CODES.has(normalizedCode)) {
    try {
      // Grant PERMANENT Pro access (lifetime - no expiration) plus a
      // monthly credit allocation that auto-refreshes via refreshCreditsIfDue.
      const planType = 'pro_lifetime';
      const credits = monthlyAllocationFor(planType);
      const resetDate = nextResetDate();

      await db.collection('users').updateOne(
        { email },
        {
          $set: {
            isPro: true,
            activatedAt: new Date(),
            method: 'secret_code',
            codeUsedAt: new Date(),
            lifetimeAccess: true,
            credits,
            creditsResetDate: resetDate,
            planType
          }
        },
        { upsert: true }
      );

      console.log(`✅ LIFETIME Pro activated via secret code for ${email} (${credits} credits)`);
      res.json({
        success: true,
        isPro: true,
        credits,
        creditsResetDate: resetDate,
        planType
      });

    } catch (error) {
      console.error('❌ Error activating Pro:', error);
      res.json({ success: false, message: 'Database error' });
    }
  } else {
    console.log('❌ Invalid secret code attempt for:', email);
    res.json({ success: false, message: 'Invalid code' });
  }
});

// Get current credits for a user. Auto-refreshes if the reset window has passed.
app.post('/get-credits', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.json({ success: false, credits: 0 });
  }

  try {
    const user = await db.collection('users').findOne({ email });

    if (!user || !user.isPro) {
      return res.json({ success: false, credits: 0 });
    }

    const { credits, creditsResetDate, planType } = await refreshCreditsIfDue(user);

    res.json({
      success: true,
      credits,
      resetDate: creditsResetDate,
      planType
    });
  } catch (error) {
    console.error('❌ Error getting credits:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Atomically spend credits. The frontend calls this after a successful AI op.
// Uses a guarded $inc so two concurrent requests can't both succeed when the
// balance would go negative.
app.post('/use-credits', async (req, res) => {
  const { email, amount } = req.body;

  if (!email || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Email and positive amount required' });
  }

  try {
    const user = await db.collection('users').findOne({ email });

    if (!user || !user.isPro) {
      return res.status(403).json({ success: false, error: 'Not a Pro user' });
    }

    // Apply any pending monthly refresh BEFORE attempting the spend, so a
    // user whose reset just elapsed isn't blocked by a stale balance.
    await refreshCreditsIfDue(user);

    // Atomic conditional decrement: only succeeds if the user still has
    // at least `amount` credits at the moment of the write.
    const result = await db.collection('users').findOneAndUpdate(
      { email, credits: { $gte: amount } },
      { $inc: { credits: -amount } },
      { returnDocument: 'after' }
    );

    // mongodb v6 returns the document directly; older versions returned { value }
    const updated = result?.value || result;

    if (!updated || typeof updated.credits !== 'number') {
      // Fetch current balance to give the client an accurate "remaining"
      const fresh = await db.collection('users').findOne({ email });
      return res.json({
        success: false,
        error: 'Insufficient credits',
        remainingCredits: fresh?.credits ?? 0
      });
    }

    res.json({
      success: true,
      remainingCredits: updated.credits
    });
  } catch (error) {
    console.error('❌ Error using credits:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Get email from Stripe session
app.post('/get-session-email', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Try multiple places where email might be
    const email = session.customer_email ||
                  session.customer_details?.email ||
                  null;

    console.log('📧 Session retrieved:', sessionId);
    console.log('📧 Email found:', email);

    if (!email) {
      console.error('❌ No email found in session');
    }

    res.json({ email });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(400).json({ error: 'Invalid session ID' });
  }
});

// ============================================
// PEXELS PROXY ENDPOINT (FIXES CORS ISSUES)
// ============================================
app.get('/pexels-proxy', async (req, res) => {
  const { query, page } = req.query;

  console.log('🖼️ Pexels proxy request - Query:', query, 'Page:', page);

  if (!query) {
    return res.status(400).json({ error: 'Query parameter required' });
  }

  try {
    // Use dynamic import for node-fetch (works in Node 18+)
    const fetch = (await import('node-fetch')).default;

    const pexelsUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=12&page=${page || 1}`;

    console.log('🔍 Fetching from Pexels:', pexelsUrl);

    const response = await fetch(pexelsUrl, {
      headers: {
        'Authorization': PEXELS_API_KEY
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Pexels API error:', response.status, errorText);
      throw new Error(`Pexels API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    console.log('✅ Pexels returned', data.photos?.length || 0, 'photos');

    res.json(data);

  } catch (error) {
    console.error('❌ Pexels proxy error:', error.message);
    res.status(500).json({
      error: error.message,
      details: 'Failed to fetch from Pexels API'
    });
  }
});

// ============================================
// CANCEL SUBSCRIPTION ENDPOINT
// ============================================
app.post('/cancel-subscription', async (req, res) => {
  const { email } = req.body;

  console.log('🚫 Cancel subscription request for:', email);

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email is required'
    });
  }

  try {
    // Find the user in database
    const user = await db.collection('users').findOne({ email });

    if (!user) {
      console.log('❌ User not found:', email);
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if user has lifetime code access
    if (user.method === 'secret_code') {
      console.log('⚠️ User has lifetime code access - cannot cancel');
      return res.status(400).json({
        success: false,
        error: 'You have lifetime Pro access via code - no subscription to cancel'
      });
    }

    const subscriptionId = user.subscriptionId;

    if (!subscriptionId) {
      console.log('❌ No subscription ID found for:', email);
      return res.status(404).json({
        success: false,
        error: 'No active subscription found'
      });
    }

    console.log('🔍 Found subscription ID:', subscriptionId);

    // Cancel the subscription at period end (keeps access until billing period ends)
    const canceledSubscription = await stripe.subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true }
    );

    console.log('✅ Subscription set to cancel at period end');

    // Update database to reflect cancellation status
    await db.collection('users').updateOne(
      { email },
      {
        $set: {
          subscriptionStatus: 'cancelling',
          cancelRequestedAt: new Date(),
          cancelAtPeriodEnd: true
        }
      }
    );

    const periodEndDate = new Date(canceledSubscription.current_period_end * 1000);

    console.log('✅ Subscription will end on:', periodEndDate);

    res.json({
      success: true,
      message: 'Subscription will be cancelled at period end',
      periodEnd: periodEndDate,
      accessUntil: periodEndDate.toLocaleDateString()
    });

  } catch (error) {
    console.error('❌ Cancel subscription error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to cancel subscription'
    });
  }
});

// ============================================
// CREATE STRIPE CUSTOMER PORTAL SESSION
// ============================================
app.post('/create-portal-session', async (req, res) => {
  const { email } = req.body;

  console.log('🔐 Portal session request for:', email);

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const user = await db.collection('users').findOne({ email });

    if (!user) {
      console.log('❌ User not found:', email);
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user has lifetime code access
    if (user.method === 'secret_code') {
      console.log('⚠️ User has lifetime code access - no portal needed');
      return res.status(400).json({
        error: 'You have lifetime Pro access - no subscription to manage'
      });
    }

    if (!user.stripeCustomerId) {
      console.log('❌ No Stripe customer ID found for:', email);
      return res.status(404).json({ error: 'No subscription found' });
    }

    console.log('🔍 Found customer ID:', user.stripeCustomerId);

    // Create a portal session for the customer
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: 'https://imagefy.org/',
    });

    console.log('✅ Portal session created');

    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Portal session error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user info (optional - for debugging)
app.post('/get-user-info', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const user = await db.collection('users').findOne({ email });

    if (!user) {
      return res.json({ found: false });
    }

    res.json({
      found: true,
      isPro: user.isPro,
      activatedAt: user.activatedAt,
      method: user.method,
      subscriptionStatus: user.subscriptionStatus,
      lifetimeAccess: user.lifetimeAccess || false,
      credits: user.credits || 0,
      creditsResetDate: user.creditsResetDate || null,
      planType: user.planType || null
    });
  } catch (error) {
    console.error('Error getting user info:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('🚀 Imagefy Backend started');
  console.log('🚀 Port:', PORT);
  console.log('🚀 Environment:', process.env.NODE_ENV || 'development');
  console.log('🚀 Stripe:', process.env.STRIPE_SECRET_KEY ? '✅ Configured' : '❌ Missing');
  console.log('🚀 MongoDB:', process.env.MONGODB_URI ? '✅ Configured' : '❌ Missing');
  console.log('🚀 Webhook Secret:', process.env.STRIPE_WEBHOOK_SECRET ? '✅ Configured' : '❌ Missing');
  console.log('🚀 Secret Codes:', SECRET_CODES.size > 0 ? `✅ ${SECRET_CODES.size} configured` : '⚠️ None configured');
  console.log('🚀 Pexels API:', PEXELS_API_KEY ? '✅ Configured' : '⚠️ Missing');
  console.log('🚀 Credits: pro=' + PRO_MONTHLY_CREDITS + ', proplus=' + PROPLUS_MONTHLY_CREDITS + ', lifetime=' + SECRET_CODE_MONTHLY_CREDITS + ' / ' + CREDIT_RESET_DAYS + 'd cycle');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});
