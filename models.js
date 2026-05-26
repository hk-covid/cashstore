'use strict';

/**
 * models.js
 * Cash Store — Mongoose schema definitions
 * All monetary amounts stored as Decimal128 for IEEE-754 precision.
 */

const mongoose = require('mongoose');

const { Schema, model } = mongoose;

/* ─────────────────────────────── USER ─────────────────────────────── */

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format'],
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // never returned in queries by default
    },

    role: {
      type: String,
      enum: {
        values: ['user', 'admin'],
        message: 'Role must be either "user" or "admin"',
      },
      default: 'user',
    },

    /**
     * Wallet balance stored as Decimal128 to avoid floating-point drift
     * when accumulating many small cent-level transactions.
     * Always convert to/from string at the application boundary.
     */
    walletBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0.00'),
      get: (v) => (v ? parseFloat(v.toString()) : 0),
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

// Index for fast lookup by email and role filtering
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });

const User = model('User', userSchema);

/* ────────────────────────────── PRODUCT ───────────────────────────── */

const productSchema = new Schema(
  {
    title: {
      type: String,
      required: [true, 'Product title is required'],
      trim: true,
      maxlength: [500, 'Title cannot exceed 500 characters'],
    },

    /**
     * verifiedPrice: the price scraped (and optionally overridden by admin)
     * Stored as Decimal128 for the same precision reasons as walletBalance.
     */
    verifiedPrice: {
      type: mongoose.Schema.Types.Decimal128,
      required: [true, 'Verified price is required'],
      get: (v) => (v ? parseFloat(v.toString()) : 0),
    },

    stock: {
      type: Number,
      required: [true, 'Stock quantity is required'],
      default: 0,
      min: [0, 'Stock cannot be negative'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [5000, 'Description cannot exceed 5000 characters'],
      default: '',
    },

    originalUrl: {
      type: String,
      required: [true, 'Original product URL is required'],
      trim: true,
    },

    imageUrl: {
      type: String,
      trim: true,
      default: '',
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastScrapedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

// Compound index: active catalog sorted by price
productSchema.index({ isActive: 1, stock: 1 });
productSchema.index({ originalUrl: 1 }, { unique: true, sparse: true });

const Product = model('Product', productSchema);

/* ──────────────────────────── TRANSACTION ─────────────────────────── */

const transactionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      index: true,
    },

    type: {
      type: String,
      enum: {
        values: ['deposit', 'withdrawal', 'purchase'],
        message: 'Transaction type must be deposit, withdrawal, or purchase',
      },
      required: [true, 'Transaction type is required'],
    },

    status: {
      type: String,
      enum: {
        values: ['pending', 'completed', 'failed'],
        message: 'Status must be pending, completed, or failed',
      },
      default: 'pending',
    },

    /**
     * amount stored as Decimal128. Always positive; direction is
     * determined by `type` (withdrawal/purchase debit the wallet).
     */
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: [true, 'Amount is required'],
      get: (v) => (v ? parseFloat(v.toString()) : 0),
    },

    paymentMethod: {
      type: String,
      enum: {
        values: ['stripe_card', 'stripe_link', 'paypal', 'wallet'],
        message: 'Unsupported payment method',
      },
      required: [true, 'Payment method is required'],
    },

    /** Stripe PaymentIntent ID — set on deposit flows */
    stripeIntentId: {
      type: String,
      default: null,
      sparse: true,
    },

    /** PayPal Payout batch ID — set on withdrawal flows */
    paypalBatchId: {
      type: String,
      default: null,
      sparse: true,
    },

    /**
     * Flexible metadata bucket. Examples:
     *  - deposit: { last4, brand, receiptUrl }
     *  - withdrawal: { recipientEmail, paypalItemId }
     *  - purchase: { productId, productTitle, quantity }
     */
    details: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

// Compound indexes for admin dashboard aggregation performance
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, type: 1 });
transactionSchema.index({ stripeIntentId: 1 }, { sparse: true });
transactionSchema.index({ paypalBatchId: 1 }, { sparse: true });

const Transaction = model('Transaction', transactionSchema);

/* ─────────────────────────────── EXPORTS ──────────────────────────── */

module.exports = { User, Product, Transaction };
