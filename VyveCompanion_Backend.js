// ═══════════════════════════════════════════════════════════════
//  VYVE COMPANION — COMPLETE BACKEND
//  Node.js + Express + PostgreSQL (Prisma) + Firebase + Stripe
// ═══════════════════════════════════════════════════════════════

require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const helmet       = require("helmet");
const rateLimit    = require("express-rate-limit");
const { PrismaClient } = require("@prisma/client");
const admin        = require("firebase-admin");
const Stripe       = require("stripe");
const Anthropic    = require("@anthropic-ai/sdk");

const app    = express();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const ai     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Firebase Admin ─────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

// ── Middleware ─────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "10mb" }));

const limiter   = rateLimit({ windowMs: 15*60*1000, max: 100 });
const aiLimiter = rateLimit({ windowMs: 60*1000,    max: 30  });
app.use("/api",      limiter);
app.use("/api/chat", aiLimiter);

// ── Auth Middleware ─────────────────────────────────────────────
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.status(401).json({ error: "No token" });
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid   = decoded.uid;
    req.email = decoded.email;
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
};

// ═══════════════════════════════════════════════════════════════
//  USER ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/login — create or get user
app.post("/api/auth/login", auth, async (req, res) => {
  try {
    const { name, gender, fcmToken } = req.body;
    let user = await prisma.user.findUnique({ where: { firebaseUid: req.uid } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          firebaseUid: req.uid,
          email:       req.email,
          name:        name || req.email?.split("@")[0] || "User",
          gender:      gender || "male",
          plan:        "free",
          coins:       100,
          xp:          0,
          streak:      1,
          streakDate:  new Date().toDateString(),
          fcmToken:    fcmToken || null,
        },
      });
    } else {
      // Update streak
      const today     = new Date().toDateString();
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      if (user.streakDate !== today) {
        const newStreak = user.streakDate === yesterday ? user.streak + 1 : 1;
        user = await prisma.user.update({
          where: { id: user.id },
          data:  { streak: newStreak, streakDate: today, fcmToken: fcmToken || user.fcmToken },
        });
      }
    }
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/user/me
app.get("/api/user/me", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:   { firebaseUid: req.uid },
      include: { memories: true, cycleData: true },
    });
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/user/me
app.patch("/api/user/me", auth, async (req, res) => {
  try {
    const { name, gender, dob, companionId } = req.body;
    const user = await prisma.user.update({
      where: { firebaseUid: req.uid },
      data:  { name, gender, dob, companionId },
    });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  CHAT ROUTES
// ═══════════════════════════════════════════════════════════════

app.post("/api/chat/send", auth, async (req, res) => {
  try {
    const { companionId, message, systemPrompt } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Message required" });

    const user = await prisma.user.findUnique({ where: { firebaseUid: req.uid } });
    if (!user) return res.status(404).json({ error: "Not found" });

    // Free plan: 50 messages/day limit
    if (user.plan === "free") {
      const today = new Date(); today.setHours(0,0,0,0);
      const count = await prisma.message.count({
        where: { userId: user.id, createdAt: { gte: today }, role: "user" },
      });
      if (count >= 50) return res.status(429).json({ error: "daily_limit" });
    }

    // Load chat history
    const history = await prisma.message.findMany({
      where:   { userId: user.id, companionId },
      orderBy: { createdAt: "desc" },
      take:    20,
    });

    const messages = [
      ...history.reverse().map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    // Call Claude
    const response = await ai.messages.create({
      model:      "claude-sonnet-4-5-20251001",
      max_tokens: 400,
      system:     systemPrompt || `You are a warm caring AI companion for ${user.name}.`,
      messages,
    });
    const reply = response.content[0]?.text || "I'm here for you 💕";

    // Save messages
    await prisma.message.createMany({
      data: [
        { userId: user.id, companionId, role: "user",      content: message },
        { userId: user.id, companionId, role: "assistant", content: reply   },
      ],
    });

    // Award XP + coins
    await prisma.user.update({
      where: { id: user.id },
      data:  { xp: { increment: 10 }, coins: { increment: 5 } },
    });

    // Background memory extraction every 10 messages
    if (messages.length % 10 === 0) extractMemories(user, messages).catch(()=>{});

    res.json({ reply, xpEarned: 10, coinsEarned: 5 });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

async function extractMemories(user, messages) {
  const texts = messages.filter(m=>m.role==="user").slice(-10).map(m=>m.content).join("\n");
  const r = await ai.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system:     "Extract 2-3 personal facts about the user. Return ONLY a JSON array of strings max 8 words each.",
    messages:   [{ role:"user", content: texts }],
  });
  const facts = JSON.parse(r.content[0]?.text || "[]");
  const existing = (await prisma.memory.findMany({ where:{userId:user.id} })).map(m=>m.fact);
  for (const fact of facts) {
    if (!existing.includes(fact)) await prisma.memory.create({ data:{userId:user.id, fact} });
  }
  const all = await prisma.memory.findMany({ where:{userId:user.id}, orderBy:{createdAt:"asc"} });
  if (all.length > 40) {
    await prisma.memory.deleteMany({ where:{ id:{ in: all.slice(0, all.length-40).map(m=>m.id) } } });
  }
}

app.get("/api/chat/history/:companionId", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    const messages = await prisma.message.findMany({
      where:   { userId: user.id, companionId: req.params.companionId },
      orderBy: { createdAt: "asc" },
      take:    100,
    });
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/chat/history/:companionId", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    await prisma.message.deleteMany({ where:{ userId: user.id, companionId: req.params.companionId } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  PERIOD TRACKER ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/api/period", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    const data = await prisma.cycleData.findUnique({ where:{ userId: user.id } });
    const logs = await prisma.periodLog.findMany({
      where:{ userId: user.id }, orderBy:{ date:"desc" }, take: 20
    });
    res.json({ cycleData: data, logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/period/setup", auth, async (req, res) => {
  try {
    const { lastPeriod, cycleLen, periodLen } = req.body;
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    const data = await prisma.cycleData.upsert({
      where:  { userId: user.id },
      update: { lastPeriod: new Date(lastPeriod), cycleLen, periodLen },
      create: { userId: user.id, lastPeriod: new Date(lastPeriod), cycleLen, periodLen },
    });
    res.json({ cycleData: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/period/log", auth, async (req, res) => {
  try {
    const { date, flow, symptoms, mood } = req.body;
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    const log = await prisma.periodLog.create({
      data: { userId: user.id, date: new Date(date), flow, symptoms: symptoms||[], mood: mood||"" },
    });
    if (flow !== "Spotting") {
      await prisma.cycleData.upsert({
        where:  { userId: user.id },
        update: { lastPeriod: new Date(date) },
        create: { userId: user.id, lastPeriod: new Date(date), cycleLen: 28, periodLen: 5 },
      });
    }
    res.json({ log });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  STRIPE — SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════

app.post("/api/subscription/create", auth, async (req, res) => {
  try {
    const { planId } = req.body;
    const prices = { monthly: process.env.STRIPE_PRICE_MONTHLY, annual: process.env.STRIPE_PRICE_ANNUAL };
    if (!prices[planId]) return res.status(400).json({ error: "Invalid plan" });

    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const c = await stripe.customers.create({ email: req.email, metadata:{ firebaseUid: req.uid } });
      customerId = c.id;
      await prisma.user.update({ where:{ id: user.id }, data:{ stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 "subscription",
      payment_method_types: ["card"],
      line_items:           [{ price: prices[planId], quantity: 1 }],
      success_url:          `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${process.env.FRONTEND_URL}/subscribe`,
      metadata:             { firebaseUid: req.uid, planId },
    });

    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/subscription/cancel", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    if (!user.stripeSubscriptionId) return res.status(400).json({ error: "No subscription" });
    await stripe.subscriptions.update(user.stripeSubscriptionId, { cancel_at_period_end: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stripe Webhook
app.post("/api/webhook/stripe", express.raw({ type:"application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }

  if (event.type === "checkout.session.completed") {
    const { firebaseUid, planId } = event.data.object.metadata;
    await prisma.user.update({
      where: { firebaseUid },
      data:  {
        plan: planId,
        stripeSubscriptionId: event.data.object.subscription,
        planExpiresAt: new Date(Date.now() + (planId==="annual"?365:30)*86400000),
      },
    });
  }
  if (event.type === "customer.subscription.deleted") {
    await prisma.user.updateMany({
      where: { stripeSubscriptionId: event.data.object.id },
      data:  { plan:"free", stripeSubscriptionId:null },
    });
  }
  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════
//  COINS / IAP
// ═══════════════════════════════════════════════════════════════

const PACKS = {
  starter: { coins:100,  amount:99   },
  popular: { coins:600,  amount:499  },
  value:   { coins:1500, amount:999  },
  mega:    { coins:4000, amount:1999 },
};

app.post("/api/coins/purchase", auth, async (req, res) => {
  try {
    const pack = PACKS[req.body.packId];
    if (!pack) return res.status(400).json({ error: "Invalid pack" });
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    const intent = await stripe.paymentIntents.create({
      amount:   pack.amount,
      currency: "usd",
      customer: user.stripeCustomerId || undefined,
      metadata: { firebaseUid: req.uid, packId: req.body.packId, coins: pack.coins },
    });
    res.json({ clientSecret: intent.client_secret, pack });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/coins/confirm", auth, async (req, res) => {
  try {
    const intent = await stripe.paymentIntents.retrieve(req.body.paymentIntentId);
    if (intent.status !== "succeeded") return res.status(400).json({ error: "Payment incomplete" });
    if (intent.metadata.firebaseUid !== req.uid) return res.status(403).json({ error: "Forbidden" });

    const coins = parseInt(intent.metadata.coins);
    const user = await prisma.user.update({
      where: { firebaseUid: req.uid },
      data:  { coins: { increment: coins } },
    });
    await prisma.coinTransaction.create({
      data: { userId: user.id, amount: coins, type:"purchase", ref: req.body.paymentIntentId },
    });
    res.json({ coins: user.coins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/coins/spend", auth, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    if (user.coins < amount) return res.status(400).json({ error: "insufficient_coins" });
    const updated = await prisma.user.update({
      where: { id: user.id }, data: { coins: { decrement: amount } },
    });
    await prisma.coinTransaction.create({
      data: { userId: user.id, amount: -amount, type:"spend", ref: reason },
    });
    res.json({ coins: updated.coins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  XP
// ═══════════════════════════════════════════════════════════════

app.post("/api/xp/add", auth, async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { firebaseUid: req.uid },
      data:  { xp: { increment: req.body.amount }, coins: { increment: Math.floor(req.body.amount/2) } },
    });
    res.json({ xp: user.xp, coins: user.coins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  MEMORIES
// ═══════════════════════════════════════════════════════════════

app.get("/api/memories", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    const memories = await prisma.memory.findMany({ where:{ userId: user.id }, orderBy:{ createdAt:"desc" } });
    res.json({ memories: memories.map(m=>m.fact) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/memories", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    await prisma.memory.deleteMany({ where:{ userId: user.id } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS (FCM)
// ═══════════════════════════════════════════════════════════════

app.post("/api/notify/send", auth, async (req, res) => {
  try {
    const { title, body } = req.body;
    const user = await prisma.user.findUnique({ where:{ firebaseUid: req.uid } });
    if (!user.fcmToken) return res.json({ success: false });
    await admin.messaging().send({ token: user.fcmToken, notification:{ title, body } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily check-in cron (call from cron job with INTERNAL_SECRET)
app.post("/api/notify/daily", async (req, res) => {
  if (req.headers["x-secret"] !== process.env.INTERNAL_SECRET) return res.status(403).end();
  const users = await prisma.user.findMany({ where:{ fcmToken:{ not:null } } });
  const msgs = users.map(u=>({
    token: u.fcmToken,
    notification: { title:"She misses you 💕", body:"Your companion has been waiting for you all day" },
  }));
  if (msgs.length) await admin.messaging().sendEach(msgs);
  res.json({ sent: msgs.length });
});

// ── Health check ───────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status:"ok", version:"2.0.0" }));

app.post("/api/chat/ai", async (req, res) => {
  try {
    const { messages, system } = req.body;
    const response = await ai.messages.create({
      model: "claude-sonnet-4-5-20251001",
      max_tokens: 400,
      system: system || "You are a warm caring AI companion.",
      messages,
    });
    res.json({ reply: response.content[0]?.text || "💕" });
  } catch(e) {
    console.error(e);
    res.status(500).json({ reply: "I'm here for you 💕" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Vyve Backend on port ${PORT}`));
module.exports = app;