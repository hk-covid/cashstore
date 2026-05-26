'use strict';

/**
 * server.js
 * Cash Store — Express REST API
 *
 * Public routes:
 *   POST /api/products/scan-live
 *   POST /api/wallet/initiate-deposit
 *   POST /api/wallet/execute-withdrawal
 *
 * Admin-only routes (isAdmin middleware):
 *   GET  /api/admin/dashboard
 *   PUT  /api/admin/transactions/:id
 *   PUT  /api/admin/products/:id
 */

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { User, Product, Transaction } = require('./models');
const { scanProductPrice } = require('./scraper');
const { createDepositIntent, triggerExternalWithdrawal } = require('./payments');

const authRouter = require('./auth');
const webhookRouter = require('./webhook');
const ordersRouter = require('./orders');
const withdrawalsRouter = require('./withdrawals');

/* ────────────────────── APP SETUP ──────────────────────────────── */

const app = express();

// Stripe Webhook needs raw body, mount it before express.json()
app.use('/api/webhook', webhookRouter);

// Parse JSON bodies (limit to 10 kb to mitigate DoS via huge payloads)
app.use(express.json({ limit: '10kb' }));

// Helmet security headers
app.use(helmet());

// CORS configuration
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: process.env.NODE_ENV === 'development' ? ['http://localhost:3000', allowedOrigin] : allowedOrigin
}));

// Serve static frontend
const path = require('path');
app.use(express.static(path.join(__dirname, 'frontend')));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts, please try again after 15 minutes' }
});

const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => {
    return req.user ? req.user.userId : req.ip;
  },
  message: { error: 'Too many withdrawal requests, please try again after an hour' }
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);

app.use('/api/withdrawals', withdrawalLimiter, withdrawalsRouter);
app.use('/api/orders', ordersRouter);

/* ────────────────────── DATABASE ───────────────────────────────── */

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set.');
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });

  console.info('[server] MongoDB connected:', mongoose.connection.host);
}

/* ────────────────────── VALIDATION HELPERS ─────────────────────── */

/**
 * Returns a clean, positive float or throws.
 * @param {*} val
 * @param {string} fieldName
 * @param {number} [min=0.01]
 * @param {number} [max=1000000]
 */
function requirePositiveFloat(val, fieldName, min = 0.01, max = 1_000_000) {
  const n = parseFloat(val);
  if (!isFinite(n) || isNaN(n) || n < min || n > max) {
    throw Object.assign(
      new Error(
        `"${fieldName}" must be a number between ${min} and ${max}. Got: ${val}`
      ),
      { httpStatus: 400 }
    );
  }
  return n;
}

/**
 * Returns a valid MongoDB ObjectId string or throws.
 * @param {*} val
 * @param {string} fieldName
 */
function requireObjectId(val, fieldName) {
  if (!val || !mongoose.Types.ObjectId.isValid(val)) {
    throw Object.assign(
      new Error(`"${fieldName}" must be a valid ObjectId. Got: ${val}`),
      { httpStatus: 400 }
    );
  }
  return val;
}

/**
 * Returns a validated email string or throws.
 * @param {*} val
 */
function requireEmail(val) {
  if (!val || typeof val !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim())) {
    throw Object.assign(
      new Error(`"${val}" is not a valid email address.`),
      { httpStatus: 400 }
    );
  }
  return val.trim().toLowerCase();
}

/**
 * Sanitises a free-text string for storage. Trims, removes HTML tags.
 * @param {string} str
 * @param {number} maxLen
 */
function sanitiseText(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().substring(0, maxLen);
}

/* ────────────────────── MIDDLEWARE: isAdmin ─────────────────────── */

/**
 * Validates the Authorization header.
 *
 * Accepts two formats:
 *   1. Bearer <JWT>   — issued at login with { userId, role } payload
 *   2. ApiKey <key>   — static admin API key via ADMIN_API_KEY env var
 *
 * Sets `req.adminUser = { userId, role }` on success.
 * Returns HTTP 403 on failure.
 */
async function isAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';

  if (!header) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Authorization header is required.',
    });
  }

  const [scheme, token] = header.split(' ');

  if (!scheme || !token) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Malformed Authorization header. Use: Bearer <token> or ApiKey <key>.',
    });
  }

  try {
    // ── Option 1: Static Admin API Key ──────────────────────────────
    if (scheme === 'ApiKey') {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Admin API key authentication is not configured.',
        });
      }
      // Constant-time comparison to prevent timing attacks
      const expectedBuf = Buffer.from(adminKey);
      const receivedBuf = Buffer.from(token);
      const match =
        expectedBuf.length === receivedBuf.length &&
        require('crypto').timingSafeEqual(expectedBuf, receivedBuf);

      if (!match) {
        return res.status(403).json({ error: 'Forbidden', message: 'Invalid admin API key.' });
      }

      req.adminUser = { role: 'admin' };
      return next();
    }

    // ── Option 2: JWT Bearer Token ──────────────────────────────────
    if (scheme === 'Bearer') {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        return res.status(500).json({ error: 'Server Error', message: 'JWT secret not configured.' });
      }

      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });

      if (payload.role !== 'admin') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Admin role required.',
        });
      }

      // Cross-check against DB to handle revoked tokens / role downgrades
      const user = await User.findById(payload.userId).select('role isActive');
      if (!user || !user.isActive || user.role !== 'admin') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Token is no longer valid or account has been deactivated.',
        });
      }

      req.adminUser = { userId: payload.userId, role: 'admin' };
      return next();
    }

    return res.status(403).json({
      error: 'Forbidden',
      message: 'Unsupported auth scheme. Use Bearer or ApiKey.',
    });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(403).json({
        error: 'Forbidden',
        message: err.name === 'TokenExpiredError' ? 'Token expired.' : 'Invalid token.',
      });
    }
    console.error('[auth] isAdmin middleware error:', err);
    return res.status(500).json({ error: 'Server Error', message: 'Authentication error.' });
  }
}

/* ────────────────────── ERROR WRAPPER ──────────────────────────── */

/**
 * Wraps an async route handler to forward uncaught errors to Express.
 * @param {Function} fn
 */
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC ENDPOINTS
   ═══════════════════════════════════════════════════════════════════ */

/* ── GET /api/wallet/balance/:userId ────────────────────── */
app.get('/api/wallet/balance/:userId', wrap(async (req, res) => {
  const { userId } = req.params;
  
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing token' });
  }
  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
  
  if (payload.userId !== userId && payload.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const user = await User.findById(userId).select('walletBalance');
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.status(200).json({ balance: parseFloat(user.walletBalance.toString()) });
}));

/* ── GET /api/products ──────────────────────────────────────── */
app.get('/api/products', wrap(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const search = req.query.search || '';
  const skip = (page - 1) * limit;

  const query = { isActive: true, stock: { $gt: 0 } };
  if (search) {
    query.title = { $regex: search, $options: 'i' };
  }

  const [products, total] = await Promise.all([
    Product.find(query).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Product.countDocuments(query)
  ]);

  res.status(200).json({
    products,
    total,
    page,
    pages: Math.ceil(total / limit)
  });
}));

/* ── POST /api/products/scan-live ──────────────────────────────── */

/**
 * Accepts a product page URL, scrapes live data, persists it, and
 * returns the saved product document.
 *
 * Body: { url: string }
 */
app.post(
  '/api/products/scan-live',
  wrap(async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: '"url" is required and must be a non-empty string.',
      });
    }

    const trimmedUrl = url.trim();

    // Basic URL format guard before spawning Puppeteer
    try {
      const parsed = new URL(trimmedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Protocol must be http or https.');
      }
    } catch {
      return res.status(400).json({
        error: 'Bad Request',
        message: `"${trimmedUrl}" is not a valid URL.`,
      });
    }

    const scraped = await scanProductPrice(trimmedUrl);

    if (!scraped) {
      return res.status(422).json({
        error: 'Unprocessable Entity',
        message:
          'Could not extract product data from the provided URL. ' +
          'The page may be behind a login, use unsupported markup, or block scrapers.',
      });
    }

    if (!scraped.title || scraped.price <= 0) {
      return res.status(422).json({
        error: 'Unprocessable Entity',
        message: 'Scraped data is incomplete: title and a positive price are required.',
      });
    }

    // Upsert: if same URL already exists, refresh price and metadata
    const product = await Product.findOneAndUpdate(
      { originalUrl: trimmedUrl },
      {
        title: scraped.title,
        verifiedPrice: mongoose.Types.Decimal128.fromString(
          scraped.price.toFixed(2)
        ),
        imageUrl: scraped.imageUrl || '',
        originalUrl: trimmedUrl,
        lastScrapedAt: new Date(),
        isActive: true,
        $setOnInsert: { stock: 1 }, // default stock=1 for new records only
      },
      { new: true, upsert: true, runValidators: true }
    );

    return res.status(201).json({
      message: 'Product scanned and saved successfully.',
      product,
    });
  })
);

/* ── POST /api/wallet/initiate-deposit ─────────────────────────── */

/**
 * Creates a Stripe PaymentIntent and a pending Transaction record.
 *
 * Body: { userId: string, amount: number }
 * Returns: { clientSecret, transactionId }
 */
app.post(
  '/api/wallet/initiate-deposit',
  wrap(async (req, res) => {
    const { userId, amount } = req.body;

    requireObjectId(userId, 'userId');
    const validAmount = requirePositiveFloat(amount, 'amount', 0.5);

    // Verify user exists
    const user = await User.findById(userId).select('_id email isActive');
    if (!user || !user.isActive) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'User not found or account is inactive.',
      });
    }

    const { clientSecret, intentId } = await createDepositIntent(validAmount, 'usd', {
      userId: userId.toString(),
      userEmail: user.email,
    });

    const transaction = await Transaction.create({
      userId,
      type: 'deposit',
      status: 'pending',
      amount: mongoose.Types.Decimal128.fromString(validAmount.toFixed(2)),
      paymentMethod: 'stripe_card',
      stripeIntentId: intentId,
      details: {
        initiatedAt: new Date().toISOString(),
        userEmail: user.email,
      },
    });

    return res.status(201).json({
      message: 'Deposit intent created. Complete payment on the client using clientSecret.',
      clientSecret,
      transactionId: transaction._id,
    });
  })
);

/* ── POST /api/wallet/execute-withdrawal ───────────────────────── */

/**
 * Validates balance, atomically deducts funds, dispatches a PayPal payout,
 * and records the completed transaction.
 *
 * Body: { userId: string, amount: number, email: string }
 */
app.post(
  '/api/wallet/execute-withdrawal',
  wrap(async (req, res) => {
    const { userId, amount, email } = req.body;

    requireObjectId(userId, 'userId');
    const validAmount = requirePositiveFloat(amount, 'amount', 1.0);
    const validEmail = requireEmail(email);

    const amountDecimal = mongoose.Types.Decimal128.fromString(
      validAmount.toFixed(2)
    );

    /**
     * ATOMIC balance deduction:
     * findOneAndUpdate with a conditional filter ensures the balance can never
     * go negative even under concurrent request load (optimistic locking pattern).
     *
     * The filter `walletBalance { $gte: amountDecimal }` only matches the
     * document when the balance is sufficient; if no document matches, the
     * update is a no-op and we return 400.
     */
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        isActive: true,
        walletBalance: {
          $gte: amountDecimal,
        },
      },
      {
        $inc: {
          // MongoDB Decimal128 does not support $inc directly —
          // use the aggregation pipeline form of findOneAndUpdate.
          // We use a pipeline update instead:
        },
      },
      { new: false } // we'll redo this below with a pipeline
    );

    /**
     * Re-implement using an aggregation pipeline update (MongoDB 4.2+)
     * which natively handles Decimal128 arithmetic:
     */
    const deductionResult = await User.findOneAndUpdate(
      {
        _id: userId,
        isActive: true,
        // Decimal128 comparison: balance must be >= amount
        $expr: {
          $gte: [
            { $toDouble: '$walletBalance' },
            validAmount,
          ],
        },
      },
      [
        {
          $set: {
            walletBalance: {
              $toDecimal: {
                $subtract: [
                  { $toDouble: '$walletBalance' },
                  validAmount,
                ],
              },
            },
          },
        },
      ],
      { new: true, runValidators: true }
    );

    if (!deductionResult) {
      // Could be insufficient funds OR user not found
      const user = await User.findById(userId).select('isActive walletBalance');
      if (!user || !user.isActive) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'User not found or account is inactive.',
        });
      }
      const balance = parseFloat(user.walletBalance.toString());
      return res.status(400).json({
        error: 'Bad Request',
        message: `Insufficient wallet balance. ` +
          `Available: $${balance.toFixed(2)}, Requested: $${validAmount.toFixed(2)}.`,
        availableBalance: balance,
        requestedAmount: validAmount,
      });
    }

    // Create a pending transaction record BEFORE calling PayPal
    // so we have an audit trail even if the payout call fails.
    const transaction = await Transaction.create({
      userId,
      type: 'withdrawal',
      status: 'pending',
      amount: amountDecimal,
      paymentMethod: 'paypal',
      details: {
        recipientEmail: validEmail,
        initiatedAt: new Date().toISOString(),
      },
    });

    let paypalResult;
    try {
      paypalResult = await triggerExternalWithdrawal(validEmail, validAmount);
    } catch (paypalErr) {
      // PayPal call failed — REFUND the wallet balance immediately
      console.error('[server] PayPal payout failed; refunding balance:', paypalErr.message);

      await User.findOneAndUpdate(
        { _id: userId },
        [
          {
            $set: {
              walletBalance: {
                $toDecimal: {
                  $add: [{ $toDouble: '$walletBalance' }, validAmount],
                },
              },
            },
          },
        ]
      );

      await Transaction.findByIdAndUpdate(transaction._id, {
        status: 'failed',
        details: {
          ...transaction.details,
          failureReason: paypalErr.message,
          failedAt: new Date().toISOString(),
          refunded: true,
        },
      });

      return res.status(502).json({
        error: 'Payment Gateway Error',
        message: paypalErr.message,
        refunded: true,
      });
    }

    // PayPal succeeded — update transaction to completed
    const completedTransaction = await Transaction.findByIdAndUpdate(
      transaction._id,
      {
        status: 'completed',
        paypalBatchId: paypalResult.batchId,
        details: {
          ...transaction.toObject().details,
          recipientEmail: validEmail,
          paypalBatchId: paypalResult.batchId,
          paypalStatus: paypalResult.status,
          paypalItemId: paypalResult.itemId,
          completedAt: new Date().toISOString(),
        },
      },
      { new: true }
    );

    return res.status(200).json({
      message: 'Withdrawal processed successfully.',
      transaction: completedTransaction,
      newBalance: parseFloat(deductionResult.walletBalance.toString()),
    });
  })
);

/* ═══════════════════════════════════════════════════════════════════
   ADMIN-ONLY ENDPOINTS
   ═══════════════════════════════════════════════════════════════════ */

/* ── GET /api/admin/dashboard ──────────────────────────────────── */

/**
 * Returns aggregated platform statistics in a single round-trip.
 */
app.get(
  '/api/admin/dashboard',
  isAdmin,
  wrap(async (_req, res) => {
    const [userStats, productStats, transactionStats, escrowResult] =
      await Promise.all([
        // Total registered users
        User.countDocuments({ isActive: true }),

        // Active catalog items (in stock)
        Product.countDocuments({ isActive: true, stock: { $gt: 0 } }),

        // Pending withdrawals count
        Transaction.countDocuments({ type: 'withdrawal', status: 'pending' }),

        // Total escrow: sum of all user wallet balances
        User.aggregate([
          { $match: { isActive: true } },
          {
            $group: {
              _id: null,
              totalEscrow: {
                $sum: { $toDouble: '$walletBalance' },
              },
            },
          },
        ]),
      ]);

    const totalEscrow =
      escrowResult.length > 0
        ? Math.round(escrowResult[0].totalEscrow * 100) / 100
        : 0;

    return res.status(200).json({
      dashboard: {
        totalUsers: userStats,
        activeCatalogItems: productStats,
        pendingWithdrawals: transactionStats,
        totalEscrowBalance: totalEscrow,
        generatedAt: new Date().toISOString(),
      },
    });
  })
);

/* ── PUT /api/admin/transactions/:id ───────────────────────────── */

/**
 * Settle or reject a pending transaction.
 *
 * Body: { status: string, action: 'settle' | 'reject' }
 *
 * On 'reject': refunds the amount to the user's wallet and marks
 *              the transaction as 'failed'.
 * On 'settle': marks the transaction as 'completed'.
 */
app.put(
  '/api/admin/transactions/:id',
  isAdmin,
  wrap(async (req, res) => {
    const { id } = req.params;
    requireObjectId(id, 'id');

    const { action } = req.body;
    if (!action || !['settle', 'reject'].includes(action)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: '"action" must be "settle" or "reject".',
      });
    }

    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Transaction ${id} not found.`,
      });
    }

    if (transaction.status !== 'pending') {
      return res.status(409).json({
        error: 'Conflict',
        message: `Transaction is already "${transaction.status}" and cannot be modified.`,
      });
    }

    if (action === 'reject') {
      const refundAmount = parseFloat(transaction.amount.toString());

      // Refund wallet atomically
      await User.findOneAndUpdate(
        { _id: transaction.userId },
        [
          {
            $set: {
              walletBalance: {
                $toDecimal: {
                  $add: [{ $toDouble: '$walletBalance' }, refundAmount],
                },
              },
            },
          },
        ]
      );

      const updated = await Transaction.findByIdAndUpdate(
        id,
        {
          status: 'failed',
          details: {
            ...transaction.toObject().details,
            rejectedBy: req.adminUser.userId || 'api_key_admin',
            rejectedAt: new Date().toISOString(),
            refunded: true,
            refundAmount,
          },
        },
        { new: true }
      );

      return res.status(200).json({
        message: `Transaction rejected and $${refundAmount.toFixed(2)} refunded to user.`,
        transaction: updated,
      });
    }

    // action === 'settle'
    const settled = await Transaction.findByIdAndUpdate(
      id,
      {
        status: 'completed',
        details: {
          ...transaction.toObject().details,
          settledBy: req.adminUser.userId || 'api_key_admin',
          settledAt: new Date().toISOString(),
        },
      },
      { new: true }
    );

    return res.status(200).json({
      message: 'Transaction settled successfully.',
      transaction: settled,
    });
  })
);

/* ── PUT /api/admin/products/:id ────────────────────────────────── */

/**
 * Updates product catalogue fields.
 *
 * Body: { price?: number, stock?: number, title?: string, description?: string }
 */
app.put(
  '/api/admin/products/:id',
  isAdmin,
  wrap(async (req, res) => {
    const { id } = req.params;
    requireObjectId(id, 'id');

    const { price, stock, title, description } = req.body;

    if (
      price === undefined &&
      stock === undefined &&
      title === undefined &&
      description === undefined
    ) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'At least one field (price, stock, title, description) must be provided.',
      });
    }

    const update = {};

    if (price !== undefined) {
      const validPrice = requirePositiveFloat(price, 'price', 0.01);
      update.verifiedPrice = mongoose.Types.Decimal128.fromString(
        validPrice.toFixed(2)
      );
    }

    if (stock !== undefined) {
      const stockNum = parseInt(stock, 10);
      if (!Number.isInteger(stockNum) || stockNum < 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: '"stock" must be a non-negative integer.',
        });
      }
      update.stock = stockNum;
    }

    if (title !== undefined) {
      const cleanTitle = sanitiseText(title, 500);
      if (!cleanTitle) {
        return res.status(400).json({
          error: 'Bad Request',
          message: '"title" cannot be empty after sanitisation.',
        });
      }
      update.title = cleanTitle;
    }

    if (description !== undefined) {
      update.description = sanitiseText(description, 5000);
    }

    const product = await Product.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });

    if (!product) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Product ${id} not found.`,
      });
    }

    return res.status(200).json({
      message: 'Product updated successfully.',
      product,
    });
  })
);

/* ────────────────────── 404 HANDLER ────────────────────────────── */

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found', message: 'Route not found.' });
});

/* ────────────────────── GLOBAL ERROR HANDLER ───────────────────── */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.httpStatus || 500;
  const isOperational = status < 500;

  if (!isOperational) {
    console.error('[server] Unhandled error:', err);
  }

  res.status(status).json({
    error: isOperational ? 'Bad Request' : 'Server Error',
    message: isOperational
      ? err.message
      : 'An unexpected error occurred. Please try again later.',
    ...(process.env.NODE_ENV !== 'production' && !isOperational
      ? { stack: err.stack }
      : {}),
  });
});

/* ────────────────────── START ───────────────────────────────────── */

const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  try {
    await connectDatabase();

    app.listen(PORT, () => {
      console.info(`[server] Cash Store API listening on port ${PORT}`);
      console.info(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('[server] Startup failed:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.info('[server] SIGTERM received — closing connections');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.info('[server] SIGINT received — closing connections');
  await mongoose.connection.close();
  process.exit(0);
});

start();

module.exports = app; // exported for integration testing
