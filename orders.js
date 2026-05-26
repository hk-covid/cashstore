const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { Product, User, Transaction } = require('./models');

const router = express.Router();

const requireAuth = (req, res, next) => {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { userId: payload.userId, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
};

router.use(requireAuth);

router.post('/purchase', async (req, res, next) => {
  try {
    const { userId, productId, quantity } = req.body;

    if (req.user.userId !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'Quantity must be a positive integer' });
    }

    const product = await Product.findById(productId);
    if (!product || !product.isActive) {
      return res.status(404).json({ error: 'Product not found or inactive' });
    }

    if (product.stock < quantity) {
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    const verifiedPrice = parseFloat(product.verifiedPrice.toString());
    const totalCost = verifiedPrice * quantity;
    const costDecimal = mongoose.Types.Decimal128.fromString(totalCost.toFixed(2));

    // Atomically deduct from walletBalance
    const userUpdate = await User.findOneAndUpdate(
      {
        _id: userId,
        isActive: true,
        $expr: {
          $gte: [
            { $toDouble: '$walletBalance' },
            totalCost
          ]
        }
      },
      [
        {
          $set: {
            walletBalance: {
              $toDecimal: {
                $subtract: [
                  { $toDouble: '$walletBalance' },
                  totalCost
                ]
              }
            }
          }
        }
      ],
      { new: true, runValidators: true }
    );

    if (!userUpdate) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Atomically decrement stock
    const productUpdate = await Product.findOneAndUpdate(
      { _id: productId, stock: { $gte: quantity } },
      { $inc: { stock: -quantity } },
      { new: true }
    );

    if (!productUpdate) {
      // Refund user if stock went out between checks
      await User.findOneAndUpdate(
        { _id: userId },
        [
          {
            $set: {
              walletBalance: {
                $toDecimal: {
                  $add: [
                    { $toDouble: '$walletBalance' },
                    totalCost
                  ]
                }
              }
            }
          }
        ]
      );
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    // Create Transaction record
    const transaction = await Transaction.create({
      userId,
      type: 'purchase',
      status: 'completed',
      amount: costDecimal,
      paymentMethod: 'wallet',
      details: {
        productId,
        productTitle: product.title,
        quantity,
        unitPrice: verifiedPrice,
        totalCost
      }
    });

    res.status(200).json({
      order: transaction,
      newBalance: parseFloat(userUpdate.walletBalance.toString())
    });

  } catch (error) {
    next(error);
  }
});

router.get('/history/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;

    if (req.user.userId !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments({ userId })
    ]);

    res.status(200).json({
      transactions,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
