const express = require('express');
const { Transaction, User } = require('./models');
const { stripe } = require('./payments');

const router = express.Router();

router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error(`[webhook] Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Always return HTTP 200 to Stripe immediately
    res.status(200).json({ received: true });

    // Process event asynchronously
    try {
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const stripeIntentId = paymentIntent.id;

        const transaction = await Transaction.findOne({ stripeIntentId, status: 'pending' });
        if (transaction) {
          const amountDecimal = transaction.amount;
          
          const charge = paymentIntent.latest_charge ? await stripe.charges.retrieve(paymentIntent.latest_charge) : null;
          
          let last4 = null;
          let brand = null;
          let receiptUrl = null;

          if (charge) {
            receiptUrl = charge.receipt_url;
            if (charge.payment_method_details && charge.payment_method_details.card) {
              last4 = charge.payment_method_details.card.last4;
              brand = charge.payment_method_details.card.brand;
            }
          }

          // Atomically credit user's walletBalance
          await User.findOneAndUpdate(
            { _id: transaction.userId },
            [
              {
                $set: {
                  walletBalance: {
                    $toDecimal: {
                      $add: [
                        { $toDouble: '$walletBalance' },
                        { $toDouble: amountDecimal }
                      ]
                    }
                  }
                }
              }
            ]
          );

          await Transaction.findByIdAndUpdate(transaction._id, {
            status: 'completed',
            details: {
              ...transaction.toObject().details,
              chargedAt: new Date().toISOString(),
              last4,
              brand,
              receiptUrl
            }
          });
        }
      } else if (event.type === 'payment_intent.payment_failed') {
        const paymentIntent = event.data.object;
        const stripeIntentId = paymentIntent.id;

        const failureCode = paymentIntent.last_payment_error?.code || 'unknown';
        const failureMessage = paymentIntent.last_payment_error?.message || 'Payment failed';

        const transaction = await Transaction.findOne({ stripeIntentId, status: 'pending' });
        if (transaction) {
          await Transaction.findByIdAndUpdate(transaction._id, {
            status: 'failed',
            details: {
              ...transaction.toObject().details,
              failureCode,
              failureMessage
            }
          });
        }
      }
    } catch (err) {
      console.error(`[webhook] Error processing event ${event.type}:`, err);
    }
  }
);

module.exports = router;
