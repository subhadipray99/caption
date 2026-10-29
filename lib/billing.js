// lib/billing.js
// Razorpay Pay-as-you-go Minute Billing Service for Buzy SI

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let Razorpay;
try {
  Razorpay = require("razorpay");
} catch (e) {
  console.warn("Razorpay package not loaded yet");
}
const { supabase } = require("./supabase");

const CREDITS_FILE = path.join(__dirname, "../projects/user_credits.json");
const PAYMENTS_FILE = path.join(__dirname, "../projects/payments.json");

// Ensure projects dir exists
const projDir = path.join(__dirname, "../projects");
if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });

// Local JSON store helpers for fallback/local operations
function readJson(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {
    console.warn(`Error reading ${file}:`, e.message);
  }
  return fallback;
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error(`Error writing ${file}:`, e.message);
  }
}

// Initialize Razorpay client instance
function getRazorpayClient() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return null;
  }
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

// ---------------- User Credits Management ----------------
// Default free trial: 1 minute (60 seconds) for first-time registered accounts
const DEFAULT_FREE_MINUTES = 1;
const DEFAULT_FREE_SECONDS = 60;

async function getUserBalance(userId) {
  if (!userId) {
    return { balanceMinutes: 0, balanceSeconds: 0, totalPurchasedSeconds: 0, totalUsedSeconds: 0 };
  }

  // 1. Try Supabase
  try {
    const { data, error } = await supabase
      .from("user_credits")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!error && data) {
      return {
        balanceMinutes: Math.round((Number(data.balance_seconds) / 60) * 10) / 10,
        balanceSeconds: Number(data.balance_seconds),
        totalPurchasedSeconds: Number(data.total_purchased_seconds || 0),
        totalUsedSeconds: Number(data.total_used_seconds || 0),
      };
    } else if (error && (error.code === "PGRST116" || error.message?.includes("0 rows"))) {
      // New registered user: credit 1 minute (60 seconds) free
      const newCredits = {
        user_id: userId,
        balance_seconds: DEFAULT_FREE_SECONDS,
        total_purchased_seconds: 0,
        total_used_seconds: 0,
        updated_at: new Date().toISOString(),
      };
      await supabase.from("user_credits").insert(newCredits);

      const allCredits = readJson(CREDITS_FILE, {});
      allCredits[userId] = newCredits;
      writeJson(CREDITS_FILE, allCredits);

      return {
        balanceMinutes: 1,
        balanceSeconds: DEFAULT_FREE_SECONDS,
        totalPurchasedSeconds: 0,
        totalUsedSeconds: 0,
      };
    }
  } catch (err) {
    // Supabase table may not exist yet; fall back to local JSON store
  }

  // 2. Local JSON store fallback
  const allCredits = readJson(CREDITS_FILE, {});
  if (!allCredits[userId]) {
    // Initialise with default trial credits (1 min = 60s)
    allCredits[userId] = {
      user_id: userId,
      balance_seconds: DEFAULT_FREE_SECONDS,
      total_purchased_seconds: 0,
      total_used_seconds: 0,
      updated_at: new Date().toISOString(),
    };
    writeJson(CREDITS_FILE, allCredits);

    // Try saving to Supabase in background
    supabase
      .from("user_credits")
      .insert({
        user_id: userId,
        balance_seconds: DEFAULT_FREE_SECONDS,
        total_purchased_seconds: 0,
        total_used_seconds: 0,
      })
      .then(() => {})
      .catch(() => {});
  }

  const rec = allCredits[userId];
  return {
    balanceMinutes: Math.round((rec.balance_seconds / 60) * 10) / 10,
    balanceSeconds: rec.balance_seconds,
    totalPurchasedSeconds: rec.total_purchased_seconds || 0,
    totalUsedSeconds: rec.total_used_seconds || 0,
  };
}

async function addCredits(userId, minutesPurchased) {
  if (!userId || !minutesPurchased) return;
  const addedSeconds = Math.round(minutesPurchased * 60);

  // 1. Local JSON store
  const allCredits = readJson(CREDITS_FILE, {});
  const current = allCredits[userId] || {
    user_id: userId,
    balance_seconds: DEFAULT_FREE_SECONDS,
    total_purchased_seconds: 0,
    total_used_seconds: 0,
  };

  const newBalanceSeconds = (current.balance_seconds || 0) + addedSeconds;
  const newPurchasedSeconds = (current.total_purchased_seconds || 0) + addedSeconds;

  allCredits[userId] = {
    ...current,
    balance_seconds: newBalanceSeconds,
    total_purchased_seconds: newPurchasedSeconds,
    updated_at: new Date().toISOString(),
  };
  writeJson(CREDITS_FILE, allCredits);

  // 2. Sync to Supabase
  try {
    await supabase.from("user_credits").upsert({
      user_id: userId,
      balance_seconds: newBalanceSeconds,
      total_purchased_seconds: newPurchasedSeconds,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("Could not sync credits to Supabase:", e.message);
  }

  return {
    balanceMinutes: Math.round((newBalanceSeconds / 60) * 10) / 10,
    balanceSeconds: newBalanceSeconds,
  };
}

async function deductCredits(userId, durationSeconds) {
  if (!userId) return { allowed: true, remainingMinutes: 0, remainingSeconds: 0 };
  const durSec = Math.max(1, Math.round(durationSeconds));

  const { balanceSeconds } = await getUserBalance(userId);
  if (balanceSeconds < durSec) {
    return {
      allowed: false,
      requiredSeconds: durSec,
      requiredMinutes: Math.ceil(durSec / 60),
      currentMinutes: Math.round((balanceSeconds / 60) * 10) / 10,
      currentSeconds: balanceSeconds,
    };
  }

  const newBalance = Math.max(0, balanceSeconds - durSec);

  // Update local store
  const allCredits = readJson(CREDITS_FILE, {});
  const current = allCredits[userId] || {};
  allCredits[userId] = {
    ...current,
    balance_seconds: newBalance,
    total_used_seconds: (current.total_used_seconds || 0) + durSec,
    updated_at: new Date().toISOString(),
  };
  writeJson(CREDITS_FILE, allCredits);

  // Update Supabase
  try {
    await supabase.from("user_credits").upsert({
      user_id: userId,
      balance_seconds: newBalance,
      total_used_seconds: (current.total_used_seconds || 0) + durSec,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {}

  return {
    allowed: true,
    remainingMinutes: Math.round((newBalance / 60) * 10) / 10,
    remainingSeconds: newBalance,
  };
}

// ---------------- Razorpay Orders & Verification ----------------
// Pricing rules:
// INR: 10 Rupees = 5 Minutes (Rate = 0.5 mins / ₹1 -> ₹2 per minute), Minimum = ₹10 (5 mins)
// USD: $1 = 30 Minutes, Minimum = $1

async function createRazorpayOrder({ userId, userEmail, currency = "INR", amount }) {
  const rzp = getRazorpayClient();
  if (!rzp) {
    throw new Error("Razorpay live keys are not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env");
  }

  const curr = String(currency || "INR").toUpperCase();
  let numAmount = Number(amount);
  let minutes = 0;

  if (curr === "INR") {
    if (numAmount < 10) {
      throw new Error("Minimum amount for INR recharge is ₹10 (5 Minutes).");
    }
    // 10 INR = 5 Minutes -> 0.5 minutes per Rupee (₹2/minute)
    minutes = Math.round(numAmount * 0.5 * 10) / 10;
  } else if (curr === "USD") {
    if (numAmount < 1) {
      throw new Error("Minimum amount for USD recharge is $1 (30 Minutes).");
    }
    // Proportional USD tiers: $1 = 30 mins, $3 = 100 mins, $5 = 180 mins, $10 = 400 mins
    if (numAmount === 1) minutes = 30;
    else if (numAmount === 3) minutes = 100;
    else if (numAmount === 5) minutes = 180;
    else if (numAmount === 10) minutes = 400;
    else minutes = Math.floor(numAmount * 35);
  } else {
    throw new Error(`Unsupported currency: ${currency}`);
  }

  // Razorpay requires amount in smallest currency unit (paise for INR, cents for USD)
  const amountSubunits = Math.round(numAmount * 100);

  const orderOptions = {
    amount: amountSubunits,
    currency: curr,
    receipt: `buzy_${Date.now().toString(36)}`,
    payment_capture: 1,
    notes: {
      userId: userId || "",
      userEmail: userEmail || "",
      minutes: String(minutes),
      currency: curr,
    },
  };

  const order = await rzp.orders.create(orderOptions);

  // Record pending payment in store
  const allPayments = readJson(PAYMENTS_FILE, []);
  allPayments.unshift({
    order_id: order.id,
    user_id: userId,
    user_email: userEmail,
    amount: numAmount,
    currency: curr,
    minutes_credited: minutes,
    status: "created",
    created_at: new Date().toISOString(),
  });
  writeJson(PAYMENTS_FILE, allPayments);

  // Sync to Supabase
  try {
    await supabase.from("payments").insert({
      razorpay_order_id: order.id,
      user_id: userId,
      amount: numAmount,
      currency: curr,
      minutes_credited: minutes,
      status: "created",
    });
  } catch (e) {}

  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    minutes,
    keyId: process.env.RAZORPAY_KEY_ID,
  };
}

async function verifyRazorpayPayment({ userId, orderId, paymentId, signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    throw new Error("RAZORPAY_KEY_SECRET not configured on server.");
  }

  // 1. Verify HMAC SHA256 Signature
  const body = orderId + "|" + paymentId;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature !== signature) {
    console.error("Razorpay signature verification failed!");
    throw new Error("Invalid payment signature. Payment verification failed.");
  }

  // 2. Ensure payment is captured on Razorpay
  const rzp = getRazorpayClient();
  if (rzp) {
    try {
      const paymentInfo = await rzp.payments.fetch(paymentId);
      if (paymentInfo && paymentInfo.status === "authorized") {
        console.log(`Payment ${paymentId} is authorized. Capturing now...`);
        await rzp.payments.capture(paymentId, paymentInfo.amount, paymentInfo.currency);
        console.log(`Payment ${paymentId} captured successfully.`);
      }
    } catch (capErr) {
      console.warn("Razorpay capture check warning:", capErr.message);
    }
  }

  // 3. Retrieve order records to credit exact minutes
  const allPayments = readJson(PAYMENTS_FILE, []);
  const record = allPayments.find((p) => p.order_id === orderId);
  const minutesToCredit = record?.minutes_credited || 100;

  // Mark payment as captured
  if (record) {
    record.status = "captured";
    record.payment_id = paymentId;
    record.signature = signature;
    record.captured_at = new Date().toISOString();
    writeJson(PAYMENTS_FILE, allPayments);
  }

  // 3. Add minutes to user's balance
  const newBalance = await addCredits(userId, minutesToCredit);

  // 4. Update Supabase
  try {
    await supabase
      .from("payments")
      .update({
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        status: "captured",
      })
      .eq("razorpay_order_id", orderId);
  } catch (e) {}

  return {
    success: true,
    minutesCredited: minutesToCredit,
    balanceMinutes: newBalance.balanceMinutes,
    balanceSeconds: newBalance.balanceSeconds,
  };
}

module.exports = {
  getUserBalance,
  addCredits,
  deductCredits,
  createRazorpayOrder,
  verifyRazorpayPayment,
};
