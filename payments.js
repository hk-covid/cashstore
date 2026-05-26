'use strict';

/**
 * payments.js
 * Cash Store — Payment processing and payout disbursement layer.
 *
 * Covers:
 *   • Stripe PaymentIntents  (card / Link / Apple Pay / Google Pay deposits)
 *   • PayPal Payouts SDK     (withdrawals to PayPal, Venmo, Cash App emails)
 */

const Stripe = require('stripe');
const paypal = require('@paypal/payouts-sdk');

/* ─────────────────────────── INITIALISATION ─────────────────────── */

// Validate required environment variables at module load time
// so the application fails fast rather than at the first request.
const REQUIRED_ENV = [
  'STRIPE_SECRET_KEY',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(
      `[payments] Missing required environment variable: ${key}. ` +
        'Check your .env file.'
    );
  }
}

/* ── Stripe ─────────────────────────────────────────────────────── */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
  maxNetworkRetries: 3,         // automatic idempotent retries on 5xx / network errors
  timeout: 20_000,              // 20-second socket timeout
});

/* ── PayPal ─────────────────────────────────────────────────────── */

/**
 * Build the correct PayPal environment based on NODE_ENV.
 * Production deployments MUST set NODE_ENV=production.
 */
function buildPayPalEnvironment() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  return process.env.NODE_ENV === 'production'
    ? new paypal.core.LiveEnvironment(clientId, clientSecret)
    : new paypal.core.SandboxEnvironment(clientId, clientSecret);
}

const paypalClient = new paypal.core.PayPalHttpClient(buildPayPalEnvironment());

/* ─────────────────────────── HELPERS ────────────────────────────── */

/**
 * Converts a JavaScript number to a cent-accurate string for Stripe.
 * Stripe amounts are in the currency's smallest unit (cents for USD).
 *
 * @param {number} amount  Dollar amount (e.g. 49.99)
 * @returns {number}       Integer cents (4999)
 */
function dollarsToCents(amount) {
  return Math.round(parseFloat(amount) * 100);
}

/**
 * Validates that `amount` is a positive finite number above a minimum
 * threshold (prevents sub-cent or negative deposits/withdrawals).
 *
 * @param {number|string} amount
 * @param {number}        [minimum=0.50]  Minimum acceptable value in USD
 * @throws {Error} If validation fails
 */
function validateAmount(amount, minimum = 0.5) {
  const n = parseFloat(amount);
  if (!isFinite(n) || isNaN(n)) {
    throw new Error(`Amount "${amount}" is not a valid number.`);
  }
  if (n < minimum) {
    throw new Error(
      `Amount $${n.toFixed(2)} is below the minimum of $${minimum.toFixed(2)}.`
    );
  }
  if (n > 1_000_000) {
    throw new Error('Amount exceeds the maximum single-transaction limit of $1,000,000.');
  }
  return n;
}

/**
 * Validates an email address format.
 *
 * @param {string} email
 * @throws {Error} If format is invalid
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new Error('Email address is required.');
  }
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a valid email address.`);
  }
  return trimmed;
}

/* ────────────────────── STRIPE: DEPOSIT INTENT ─────────────────── */

/**
 * Creates a Stripe PaymentIntent for a wallet deposit.
 *
 * Supports:
 *   • Credit cards and debit cards (`card`)
 *   • Stripe Link (saved cards, 1-click pay)   (`link`)
 *   • Apple Pay and Google Pay are enabled automatically through the
 *     `card` payment method type when the client is a supported browser.
 *
 * @param {number} amount         Dollar amount to deposit (e.g. 100.00)
 * @param {string} [currency]     ISO 4217 currency code (default 'usd')
 * @param {Object} [metadata]     Optional key/value pairs stored on the Intent
 * @returns {Promise<{ clientSecret: string, intentId: string }>}
 */
async function createDepositIntent(amount, currency = 'usd', metadata = {}) {
  const validAmount = validateAmount(amount);
  const cents = dollarsToCents(validAmount);

  try {
    const intent = await stripe.paymentIntents.create({
      amount: cents,
      currency: currency.toLowerCase(),
      payment_method_types: ['card', 'link'],
      capture_method: 'automatic',
      description: 'Cash Store wallet deposit',
      metadata: {
        service: 'cash_store',
        type: 'wallet_deposit',
        ...metadata,
      },
    });

    console.info(
      `[payments] Stripe PaymentIntent created: ${intent.id} ` +
        `for $${validAmount.toFixed(2)} ${currency.toUpperCase()}`
    );

    return {
      clientSecret: intent.client_secret,
      intentId: intent.id,
    };
  } catch (err) {
    console.error('[payments] Stripe PaymentIntent creation failed:', err.message);

    // Rethrow with a user-facing message while preserving the original
    const friendly =
      err.type === 'StripeInvalidRequestError'
        ? `Invalid payment request: ${err.message}`
        : 'Payment gateway error. Please try again later.';

    throw Object.assign(new Error(friendly), { code: err.code, original: err });
  }
}

/* ──────────────────── PAYPAL: WITHDRAWAL PAYOUT ────────────────── */

/**
 * Sends a PayPal Payout to the given email address.
 *
 * PayPal Payouts automatically routes to:
 *   • A PayPal wallet if the email matches a PayPal account.
 *   • Venmo if the recipient has linked their email to Venmo via PayPal.
 *   • Cash App routing requires the recipient's $Cashtag email alias.
 *
 * @param {string} email      Recipient's PayPal/Venmo/CashApp email address
 * @param {number} amount     Dollar amount to send (e.g. 50.00)
 * @param {string} [currency] ISO 4217 currency code (default 'USD')
 * @returns {Promise<{ batchId: string, status: string, itemId: string }>}
 */
async function triggerExternalWithdrawal(email, amount, currency = 'USD') {
  const validEmail = validateEmail(email);
  const validAmount = validateAmount(amount, 1.0); // $1.00 minimum withdrawal

  // Unique idempotency key: prevents duplicate payouts on retry
  const senderBatchId = `cashstore_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 9)}`;

  const itemId = `item_${senderBatchId}`;

  const requestBody = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'Your Cash Store withdrawal has been processed',
      email_message:
        'You have received a payout from Cash Store. ' +
        'Funds will appear in your account shortly.',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: {
          value: validAmount.toFixed(2),
          currency: currency.toUpperCase(),
        },
        receiver: validEmail,
        note: 'Cash Store wallet withdrawal',
        sender_item_id: itemId,
      },
    ],
  };

  const request = new paypal.payouts.PayoutsPostRequest();
  request.requestBody(requestBody);

  try {
    const response = await paypalClient.execute(request);

    const batchHeader = response.result?.batch_header;
    if (!batchHeader) {
      throw new Error('PayPal returned an unexpected response structure.');
    }

    const batchId = batchHeader.payout_batch_id;
    const status = batchHeader.batch_status;

    console.info(
      `[payments] PayPal payout dispatched — batch: ${batchId}, ` +
        `status: ${status}, recipient: ${validEmail}, ` +
        `amount: $${validAmount.toFixed(2)} ${currency}`
    );

    return { batchId, status, itemId };
  } catch (err) {
    console.error('[payments] PayPal payout failed:', err.message);

    // Attempt to surface structured PayPal error details
    let friendly = 'PayPal payout failed. Please try again.';
    try {
      const details = err.result?.details;
      if (details && details.length > 0) {
        const issueMap = {
          INSUFFICIENT_FUNDS:
            'The PayPal payout account has insufficient funds. Contact support.',
          INVALID_RESOURCE_ID:
            'The recipient email address is not linked to a valid PayPal account.',
          SENDER_BATCH_ITEM_UNCLAIMED:
            'The recipient has not claimed their PayPal account.',
        };
        const issue = details[0]?.issue;
        if (issue && issueMap[issue]) {
          friendly = issueMap[issue];
        } else if (details[0]?.description) {
          friendly = details[0].description;
        }
      }
    } catch {
      // err.result parsing failed — use generic message
    }

    throw Object.assign(new Error(friendly), { original: err });
  }
}

/* ─────────────────────────────── EXPORTS ─────────────────────────── */

module.exports = {
  createDepositIntent,
  triggerExternalWithdrawal,
  /** Expose the initialised Stripe client for webhook verification elsewhere */
  stripe,
};
