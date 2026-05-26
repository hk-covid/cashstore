// frontend/app.js

const API_URL = 'http://localhost:3000/api';
let currentToken = localStorage.getItem('token');
let currentUserId = localStorage.getItem('userId');
let stripe = null;
let cardElement = null;

// Initialize Stripe (use your publishable key here ideally, but for demo we mock it if empty)
// Since we don't have a public key in the prompt, we just instantiate with a placeholder
// In reality, this requires a valid pk_test_...
try {
  stripe = Stripe('pk_test_TYooMQauvdEDq54NiTphI7jx'); 
} catch(e) { console.error("Stripe not loaded"); }

// DOM Elements
const views = {
  auth: document.getElementById('auth-view'),
  dashboard: document.getElementById('dashboard-view'),
  shop: document.getElementById('shop-view'),
  history: document.getElementById('history-view')
};

const nav = document.getElementById('navbar');

// UI State
let isLoginMode = true;

// Init
function init() {
  if (currentToken) {
    showView('dashboard');
    loadDashboard();
  } else {
    showView('auth');
  }
  setupEventListeners();
  if(stripe) {
    setupStripe();
  }
}

// Router
function showView(viewName) {
  Object.values(views).forEach(v => {
    v.classList.add('hidden');
    v.classList.remove('active');
  });
  
  views[viewName].classList.remove('hidden');
  views[viewName].classList.add('active');

  if (viewName === 'auth') {
    nav.classList.add('hidden');
  } else {
    nav.classList.remove('hidden');
  }

  // View specific loads
  if (viewName === 'dashboard') loadDashboard();
  if (viewName === 'shop') loadShop();
  if (viewName === 'history') loadHistory(1);
}

// API Wrapper
async function apiCall(endpoint, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (currentToken) {
    headers['Authorization'] = `Bearer ${currentToken}`;
  }

  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && currentToken) {
      logout();
    }
    throw new Error(data.message || data.error || 'API Error');
  }
  return data;
}

// Auth
document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name').value;
  const errDiv = document.getElementById('auth-error');
  errDiv.innerText = '';

  try {
    if (isLoginMode) {
      const res = await apiCall('/auth/login', 'POST', { email, password });
      handleAuthSuccess(res);
    } else {
      const res = await apiCall('/auth/register', 'POST', { email, password, name });
      handleAuthSuccess(res);
    }
  } catch (err) {
    errDiv.innerText = err.message;
  }
});

document.getElementById('auth-toggle-btn').addEventListener('click', (e) => {
  e.preventDefault();
  isLoginMode = !isLoginMode;
  document.getElementById('auth-title').innerText = isLoginMode ? 'Welcome Back' : 'Create Account';
  document.getElementById('auth-submit').innerText = isLoginMode ? 'Login' : 'Register';
  document.getElementById('auth-toggle-text').innerText = isLoginMode ? "Don't have an account?" : "Already have an account?";
  document.getElementById('auth-toggle-btn').innerText = isLoginMode ? 'Register here' : 'Login here';
  document.getElementById('name-group').style.display = isLoginMode ? 'none' : 'block';
});

function handleAuthSuccess(data) {
  currentToken = data.token;
  currentUserId = data.userId;
  localStorage.setItem('token', currentToken);
  localStorage.setItem('userId', currentUserId);
  showView('dashboard');
}

function logout() {
  currentToken = null;
  currentUserId = null;
  localStorage.removeItem('token');
  localStorage.removeItem('userId');
  showView('auth');
}

document.getElementById('logout-btn').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

// Navigation
document.querySelectorAll('.nav-links a[data-view]').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showView(e.target.dataset.view);
  });
});

// Dashboard
async function loadDashboard() {
  try {
    const res = await apiCall(`/wallet/balance/${currentUserId}`);
    document.getElementById('wallet-balance').innerText = `$${res.balance.toFixed(2)}`;
    
    // Load recent transactions (limit to 5)
    const txRes = await apiCall(`/orders/history/${currentUserId}?limit=5`);
    const tbody = document.getElementById('recent-tx-body');
    tbody.innerHTML = '';
    txRes.transactions.forEach(tx => {
      const amountSign = tx.type === 'deposit' ? '+' : '-';
      const color = tx.type === 'deposit' ? 'var(--accent)' : 'var(--text-main)';
      tbody.innerHTML += `
        <tr>
          <td>${new Date(tx.createdAt).toLocaleDateString()}</td>
          <td style="text-transform: capitalize;">${tx.type}</td>
          <td style="color: ${color}">${amountSign}$${parseFloat(tx.amount.$numberDecimal || tx.amount).toFixed(2)}</td>
          <td>${tx.status}</td>
        </tr>
      `;
    });
  } catch (err) {
    console.error(err);
  }
}

// Deposit
function setupStripe() {
  const elements = stripe.elements();
  cardElement = elements.create('card');
  cardElement.mount('#card-element');
}

const depositModal = document.getElementById('deposit-modal');
document.getElementById('add-funds-btn').addEventListener('click', () => {
  depositModal.classList.remove('hidden');
  document.getElementById('deposit-message').innerText = '';
});

document.getElementById('submit-deposit').addEventListener('click', async () => {
  const amount = parseFloat(document.getElementById('deposit-amount').value);
  const msgDiv = document.getElementById('deposit-message');
  msgDiv.innerText = 'Processing...';
  msgDiv.style.color = 'var(--text-main)';

  try {
    const res = await apiCall('/wallet/initiate-deposit', 'POST', { userId: currentUserId, amount });
    
    const { error, paymentIntent } = await stripe.confirmCardPayment(res.clientSecret, {
      payment_method: { card: cardElement }
    });

    if (error) {
      msgDiv.innerText = error.message;
      msgDiv.style.color = 'var(--danger)';
    } else {
      msgDiv.innerText = 'Payment successful! Updating balance...';
      msgDiv.style.color = 'var(--accent)';
      
      // Poll for balance update
      let attempts = 0;
      const initialBalanceStr = document.getElementById('wallet-balance').innerText.replace('$','');
      const initialBalance = parseFloat(initialBalanceStr);
      
      const poll = setInterval(async () => {
        attempts++;
        const balRes = await apiCall(`/wallet/balance/${currentUserId}`);
        if (balRes.balance > initialBalance) {
          clearInterval(poll);
          loadDashboard();
          setTimeout(() => depositModal.classList.add('hidden'), 2000);
        } else if (attempts >= 10) {
          clearInterval(poll);
          msgDiv.innerText = 'Balance will update shortly.';
        }
      }, 3000);
    }
  } catch (err) {
    msgDiv.innerText = err.message;
    msgDiv.style.color = 'var(--danger)';
  }
});

// Withdraw
const withdrawModal = document.getElementById('withdraw-modal');
document.getElementById('withdraw-btn').addEventListener('click', () => {
  withdrawModal.classList.remove('hidden');
  document.getElementById('withdraw-message').innerText = '';
});

let currentWithdrawTab = 'paypal';
document.querySelectorAll('#withdraw-modal .tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('#withdraw-modal .tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#withdraw-modal .tab-pane').forEach(p => p.classList.add('hidden'));
    
    e.target.classList.add('active');
    currentWithdrawTab = e.target.dataset.tab;
    document.getElementById(`tab-${currentWithdrawTab}`).classList.remove('hidden');
    document.getElementById('withdraw-message').innerText = '';
  });
});

document.getElementById('submit-withdraw').addEventListener('click', async () => {
  const amount = parseFloat(document.getElementById('withdraw-amount').value);
  const msgDiv = document.getElementById('withdraw-message');
  msgDiv.innerText = 'Processing...';
  msgDiv.style.color = 'var(--text-main)';

  let endpoint = `/withdrawals/${currentWithdrawTab}`;
  let payload = { userId: currentUserId, amount };

  if (currentWithdrawTab === 'paypal') payload.paypalEmail = document.getElementById('withdraw-paypal-email').value;
  if (currentWithdrawTab === 'cashapp') payload.cashappEmail = document.getElementById('withdraw-cashapp-email').value;
  if (currentWithdrawTab === 'venmo') payload.venmoEmail = document.getElementById('withdraw-venmo-email').value;
  if (currentWithdrawTab === 'bank') {
    payload.accountHolderName = document.getElementById('bank-name').value;
    payload.routingNumber = document.getElementById('bank-routing').value;
    payload.accountNumber = document.getElementById('bank-account').value;
    payload.accountType = document.getElementById('bank-type').value;
  }

  try {
    const res = await apiCall(endpoint, 'POST', payload);
    msgDiv.innerText = 'Withdrawal successful!';
    msgDiv.style.color = 'var(--accent)';
    loadDashboard();
    setTimeout(() => withdrawModal.classList.add('hidden'), 2000);
  } catch (err) {
    msgDiv.innerText = err.message;
    msgDiv.style.color = 'var(--danger)';
  }
});

// Shop
async function loadShop() {
  try {
    const res = await apiCall('/products');
    const grid = document.getElementById('product-grid');
    grid.innerHTML = '';
    
    if (res.products.length === 0) {
      grid.innerHTML = '<p>No products available right now.</p>';
      return;
    }

    res.products.forEach(p => {
      const price = parseFloat(p.verifiedPrice.$numberDecimal || p.verifiedPrice).toFixed(2);
      const card = document.createElement('div');
      card.className = 'product-card glass-card';
      card.innerHTML = `
        ${p.imageUrl ? `<img src="${p.imageUrl}" class="product-img" alt="${p.title}">` : '<div class="product-img"></div>'}
        <div class="product-title">${p.title}</div>
        <div class="product-price">$${price}</div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 10px;">Stock: ${p.stock}</div>
        <button class="btn-primary" onclick="buyProduct('${p._id}')">Buy Now</button>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    console.error(err);
  }
}

async function buyProduct(productId) {
  try {
    const res = await apiCall('/orders/purchase', 'POST', { userId: currentUserId, productId, quantity: 1 });
    alert('Purchase successful! New balance: $' + res.newBalance.toFixed(2));
    loadDashboard(); // update balance in background
    loadShop();      // refresh stock
  } catch (err) {
    alert('Purchase failed: ' + err.message);
  }
}

// History
let historyPage = 1;
async function loadHistory(page) {
  historyPage = page;
  try {
    const res = await apiCall(`/orders/history/${currentUserId}?page=${page}&limit=10`);
    const tbody = document.getElementById('full-tx-body');
    tbody.innerHTML = '';
    
    res.transactions.forEach(tx => {
      const amountSign = tx.type === 'deposit' ? '+' : '-';
      const color = tx.type === 'deposit' ? 'var(--accent)' : 'var(--text-main)';
      tbody.innerHTML += `
        <tr>
          <td>${new Date(tx.createdAt).toLocaleDateString()}</td>
          <td style="text-transform: capitalize;">${tx.type}</td>
          <td style="color: ${color}">${amountSign}$${parseFloat(tx.amount.$numberDecimal || tx.amount).toFixed(2)}</td>
          <td>${tx.status}</td>
          <td style="text-transform: capitalize;">${tx.paymentMethod.replace('_', ' ')}</td>
        </tr>
      `;
    });

    document.getElementById('page-info').innerText = `Page ${res.page} of ${res.pages}`;
    
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');
    
    prevBtn.classList.toggle('disabled', res.page <= 1);
    nextBtn.classList.toggle('disabled', res.page >= res.pages);
    
    prevBtn.onclick = () => loadHistory(res.page - 1);
    nextBtn.onclick = () => loadHistory(res.page + 1);
    
  } catch (err) {
    console.error(err);
  }
}

// Modals close logic
document.querySelectorAll('.close-modal').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.target.closest('.modal').classList.add('hidden');
  });
});

// Setup
function setupEventListeners() {
  // handled inline where possible
}

init();
