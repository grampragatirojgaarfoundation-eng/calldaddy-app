'use strict';

require('dotenv').config();
const express       = require('express');
const http          = require('http');
const { Server }    = require('socket.io');
const mongoose      = require('mongoose');
const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session       = require('express-session');
const jwt           = require('jsonwebtoken');
const helmet        = require('helmet');
const cors          = require('cors');
const rateLimit     = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const compression   = require('compression');
const morgan        = require('morgan');
const { v4: uuidv4 } = require('uuid');
const admin         = require('firebase-admin');
const crypto        = require('crypto');
const path          = require('path');
const xss           = require('xss');

const { User, QRCodeModel, CallLog, BlockList } = require('./models');

// ══════════════════════════════════════════════════════════
// FIREBASE ADMIN INIT
// ══════════════════════════════════════════════════════════
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
  console.log('✅ Firebase Admin initialized');
} catch (err) {
  console.error('❌ Firebase init error:', err.message);
}

// ══════════════════════════════════════════════════════════
// EXPRESS + HTTP + SOCKET.IO
// ══════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.DOMAIN, methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling'],
});

// ══════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ══════════════════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://www.gstatic.com', 'https://accounts.google.com', 'https://cdn.socket.io'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https:', 'https://fcmregistrations.googleapis.com'],
      mediaSrc:   ["'self'", 'blob:'],
      frameSrc:   ["'none'"],
      workerSrc:  ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: process.env.DOMAIN, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.set('trust proxy', 1);
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

// Session only needed for OAuth flow (short-lived)
app.use(session({
  secret: process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 5 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());

// ══════════════════════════════════════════════════════════
// RATE LIMITERS
// ══════════════════════════════════════════════════════════
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many login attempts. Please try after 15 minutes.' } });

const scanLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many scan requests from this IP.' } });

const callLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 2,
  keyGenerator: (req) => req.ip,
  message: { error: 'Call limit reached. You can call at most 2 times per hour.' } });

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 150 });

app.use('/api/', apiLimiter);

// ══════════════════════════════════════════════════════════
// JWT HELPERS
// ══════════════════════════════════════════════════════════
const generateTokens = (userId) => ({
  accessToken:  jwt.sign({ userId }, process.env.JWT_SECRET,         { expiresIn: '15m' }),
  refreshToken: jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d'  }),
});

const authenticateJWT = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ══════════════════════════════════════════════════════════
// GOOGLE OAUTH PASSPORT
// ══════════════════════════════════════════════════════════
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.create({
        googleId:    profile.id,
        email:       profile.emails[0].value,
        displayName: profile.displayName,
        photoUrl:    profile.photos?.[0]?.value || null,
      });
    }
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); } catch (e) { done(e, null); }
});

// ══════════════════════════════════════════════════════════
// IN-MEMORY SESSION STORE  (active calls & chats — NOT saved in DB)
// Structure: sessionId => { qrCode, ownerId, ownerFcmToken,
//                           scannerIp, scannerMobile, type,
//                           startedAt, status, sdpOffer }
// ══════════════════════════════════════════════════════════
const activeSessions = new Map();

// Clean expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of activeSessions) {
    const maxAge = s.type === 'CALL' ? 70 * 1000 : 10 * 60 * 1000;
    if (now - s.startedAt > maxAge) activeSessions.delete(id);
  }
}, 5 * 60 * 1000);

// ══════════════════════════════════════════════════════════
// FCM PUSH HELPER
// ══════════════════════════════════════════════════════════
const sendFCMPush = async (fcmToken, notification, data = {}) => {
  if (!fcmToken) return false;
  // Convert all data values to strings (FCM requirement)
  const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification,
      data: strData,
      android: {
        priority: 'high',
        notification: { channelId: 'calldaddy_alerts', sound: 'default', ...notification },
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          ...notification,
          icon:    '/icons/icon-192x192.png',
          badge:   '/icons/badge-72x72.png',
          vibrate: [200, 100, 200],
          requireInteraction: strData.type === 'CALL',
          data: strData,
        },
        fcmOptions: { link: `${process.env.DOMAIN}/?sessionId=${strData.sessionId}&type=${strData.type}&action=incoming` },
      },
    });
    return true;
  } catch (err) {
    console.error('FCM Error:', err.message);
    return false;
  }
};

// ══════════════════════════════════════════════════════════
// TURN CREDENTIAL GENERATOR  (time-limited, HMAC-SHA1)
// ══════════════════════════════════════════════════════════
const getTurnCredentials = (role = 'user') => {
  const timestamp = Math.floor(Date.now() / 1000) + 3600;
  const username  = `${timestamp}:${role}`;
  const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
  return {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: `turn:${process.env.DOMAIN.replace(/https?:\/\//, '')}:3478`, username, credential },
    ],
  };
};

// ══════════════════════════════════════════════════════════
// STATIC FILES
// ══════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');  // Always fresh service worker
      res.setHeader('Service-Worker-Allowed', '/');
    }
  },
}));

// ══════════════════════════════════════════════════════════
// ────────────────  AUTH ROUTES  ──────────────────────────
// ══════════════════════════════════════════════════════════

// Step 1: Redirect to Google
app.get('/auth/google', authLimiter, passport.authenticate('google', { scope: ['profile', 'email'] }));

// Step 2: Google redirects back here
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  async (req, res) => {
    try {
      const { accessToken, refreshToken } = generateTokens(req.user._id.toString());
      await User.findByIdAndUpdate(req.user._id, { refreshToken });
      const isNew = !req.user.profileComplete;
      res.redirect(`/?token=${accessToken}&refresh=${refreshToken}&new=${isNew}`);
    } catch {
      res.redirect('/?error=server_error');
    }
  }
);

// Refresh access token
app.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user    = await User.findById(decoded.userId);
    if (!user || user.refreshToken !== refreshToken)
      return res.status(401).json({ error: 'Invalid refresh token' });
    const tokens = generateTokens(user._id.toString());
    await User.findByIdAndUpdate(user._id, { refreshToken: tokens.refreshToken });
    res.json(tokens);
  } catch {
    res.status(401).json({ error: 'Token expired. Please login again.' });
  }
});

// Logout
app.post('/auth/logout', authenticateJWT, async (req, res) => {
  await User.findByIdAndUpdate(req.userId, { refreshToken: null, fcmToken: null });
  res.json({ message: 'Logged out successfully' });
});

// ══════════════════════════════════════════════════════════
// ────────────────  USER ROUTES  ──────────────────────────
// ══════════════════════════════════════════════════════════

// Get profile
app.get('/api/user/profile', authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-refreshToken -googleId -fcmToken');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Save / update profile
app.put('/api/user/profile', authenticateJWT, [
  body('name').trim()
    .isLength({ min: 2, max: 50 }).withMessage('Name must be 2-50 characters')
    .matches(/^[a-zA-Z\s]+$/).withMessage('Name must contain English letters only'),
  body('mobile').trim()
    .isLength({ min: 7, max: 15 }).withMessage('Mobile must be 7-15 digits')
    .matches(/^\d+$/).withMessage('Mobile must contain digits only'),
  body('emergency1').trim()
    .isLength({ min: 7, max: 15 })
    .matches(/^\d+$/).withMessage('Emergency contact must be digits only'),
  body('emergency2').optional({ checkFalsy: true }).trim()
    .isLength({ max: 15 }).matches(/^\d+$/).withMessage('Emergency 2 must be digits only'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const { name, mobile, emergency1, emergency2 } = req.body;
    const user = await User.findByIdAndUpdate(req.userId, {
      name: xss(name).trim(), mobile, emergency1, emergency2: emergency2 || null, profileComplete: true,
    }, { new: true }).select('-refreshToken -googleId -fcmToken');
    res.json(user);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Toggle DND mode
app.patch('/api/user/dnd', authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.dndMode = !user.dndMode;
    await user.save();
    res.json({ dndMode: user.dndMode, message: user.dndMode ? 'DND enabled' : 'DND disabled' });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Save FCM token (called after push permission granted)
app.post('/api/user/fcm-token', authenticateJWT, [
  body('fcmToken').notEmpty().isString().isLength({ max: 500 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid FCM token' });
  try {
    await User.findByIdAndUpdate(req.userId, { fcmToken: req.body.fcmToken });
    res.json({ message: 'FCM token saved' });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Accept Terms & Conditions (saves IP, timestamp, user-agent to DB permanently)
app.post('/api/user/terms-accept', authenticateJWT, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      termsAccepted: {
        accepted:   true,
        acceptedAt: new Date(),
        ip:         req.ip,
        userAgent:  req.headers['user-agent']?.substring(0, 300),
      },
    });
    res.json({ message: 'Terms accepted and recorded' });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Get user's QR codes list
app.get('/api/user/qrs', authenticateJWT, async (req, res) => {
  try {
    const qrs = await QRCodeModel.find({ owner: req.userId })
      .select('code status activatedAt totalScans totalCalls totalMessages');
    res.json(qrs);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════
// ────────────────  QR ROUTES  ────────────────────────────
// ══════════════════════════════════════════════════════════

// Owner activates a QR code by entering the printed code
app.post('/api/qr/activate', authenticateJWT, [
  body('code').trim().toUpperCase()
    .isLength({ min: 5, max: 20 })
    .matches(/^[A-Z0-9-]+$/).withMessage('Invalid QR code format'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid QR code format' });
  try {
    const user = await User.findById(req.userId);
    if (!user)               return res.status(404).json({ error: 'User not found' });
    if (!user.profileComplete)      return res.status(400).json({ error: 'Please complete your profile first' });
    if (!user.termsAccepted?.accepted) return res.status(400).json({ error: 'Please accept the Terms & Conditions first' });

    const qr = await QRCodeModel.findOne({ code: req.body.code.toUpperCase() });
    if (!qr)                        return res.status(404).json({ error: 'QR code not found. Check the code printed on your sticker.' });
    if (qr.status === 'ACTIVATED')  return res.status(409).json({ error: 'This QR is already activated by someone else.' });
    if (qr.status === 'DEACTIVATED') return res.status(410).json({ error: 'This QR has been deactivated.' });

    qr.status = 'ACTIVATED';
    qr.owner  = user._id;
    qr.activatedAt = new Date();
    await qr.save();
    await User.findByIdAndUpdate(req.userId, { $addToSet: { activeQRs: qr.code } });

    res.json({
      message: 'QR activated successfully!',
      code:    qr.code,
      scanUrl: `${process.env.DOMAIN}/scan/${qr.code}`,
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// PUBLIC: Scanner gets QR owner info (NO phone numbers or PII returned)
app.get('/api/public/qr/:code', scanLimiter, [
  param('code').trim().toUpperCase().matches(/^[A-Z0-9-]+$/).isLength({ min: 5, max: 20 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid code' });
  try {
    const qr = await QRCodeModel.findOne({ code: req.params.code.toUpperCase() })
      .populate('owner', 'name dndMode');

    if (!qr || qr.status !== 'ACTIVATED')
      return res.status(404).json({ error: 'QR not found or not activated yet.' });

    // Check if scanner's IP is blocked for this QR
    const blocked = await BlockList.findOne({
      qrCode:    qr.code,
      scannerIp: req.ip,
      blockedUntil: { $gt: new Date() },
    });
    if (blocked) return res.status(429).json({ error: 'You are blocked from contacting this owner.' });

    // Increment scan count
    await QRCodeModel.findByIdAndUpdate(qr._id, { $inc: { totalScans: 1 } });

    // Return only safe public info
    res.json({
      ownerName: qr.owner.name,
      dndMode:   qr.owner.dndMode,
      available: !qr.owner.dndMode,
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// PUBLIC: Scanner initiates a CALL or MESSAGE session
app.post('/api/session/init', callLimiter, [
  body('code').trim().toUpperCase().matches(/^[A-Z0-9-]+$/).isLength({ min: 5, max: 20 }),
  body('scannerMobile').trim().matches(/^\d{7,15}$/).withMessage('Enter a valid mobile number'),
  body('type').isIn(['CALL', 'MESSAGE']).withMessage('Type must be CALL or MESSAGE'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { code, scannerMobile, type } = req.body;
    const qr = await QRCodeModel.findOne({ code: code.toUpperCase() })
      .populate('owner', 'name fcmToken dndMode');

    if (!qr || qr.status !== 'ACTIVATED') return res.status(404).json({ error: 'QR not found.' });
    if (qr.owner.dndMode) return res.status(503).json({
      error: 'Owner is not available right now. Please try again later.',
    });
    if (!qr.owner.fcmToken) return res.status(503).json({
      error: 'Owner\'s app is not set up for notifications. Try again later.',
    });

    // Block check
    const blocked = await BlockList.findOne({ qrCode: code, scannerIp: req.ip, blockedUntil: { $gt: new Date() } });
    if (blocked) return res.status(429).json({ error: 'You are blocked.' });

    // Prevent duplicate active session from same IP for same QR
    for (const [, s] of activeSessions) {
      if (s.qrCode === code && s.scannerIp === req.ip && Date.now() - s.startedAt < 5 * 60 * 1000)
        return res.status(409).json({ error: 'You already have an active session. Please wait.' });
    }

    const sessionId = uuidv4();
    // Store in memory (scannerMobile is NEVER sent to owner's frontend)
    activeSessions.set(sessionId, {
      qrCode:        code,
      ownerId:       qr.owner._id.toString(),
      ownerFcmToken: qr.owner.fcmToken,
      scannerIp:     req.ip,
      scannerMobile, // stored server-side only for emergency/legal purposes
      type,
      startedAt:     Date.now(),
      status:        'PENDING',
      sdpOffer:      null,
    });

    // Save call log to DB
    await CallLog.create({
      sessionId,
      qrCode:       code,
      ownerUserId:  qr.owner._id,
      scannerIp:    req.ip,
      scannerDevice: req.headers['user-agent']?.substring(0, 200),
      type,
      startedAt:    new Date(),
      status:       'INITIATED',
    });

    // Update QR stats
    const update = type === 'CALL' ? { $inc: { totalCalls: 1 } } : { $inc: { totalMessages: 1 } };
    await QRCodeModel.findByIdAndUpdate(qr._id, update);

    // Send FCM push to owner's device
    await sendFCMPush(
      qr.owner.fcmToken,
      {
        title: type === 'CALL' ? '📞 Incoming Call' : '💬 New Message',
        body:  type === 'CALL'
          ? 'Someone is calling via your CallDaddy QR sticker'
          : 'Someone sent a message via your CallDaddy QR sticker',
      },
      { type, sessionId, qrCode: code }
    );

    res.json({ sessionId, type, ownerName: qr.owner.name });
  } catch (err) {
    console.error('Session init error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Report abuse (from owner's app during/after call)
app.post('/api/session/report', authenticateJWT, [
  body('sessionId').notEmpty().isUUID(),
  body('reason').isIn(['SPAM', 'ABUSE', 'HARASSMENT', 'OTHER']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid data' });
  try {
    const { sessionId, reason } = req.body;
    await CallLog.findOneAndUpdate({ sessionId }, { reported: true, reportedReason: reason });

    const log = await CallLog.findOne({ sessionId });
    if (log) {
      const reportCount = await CallLog.countDocuments({ qrCode: log.qrCode, scannerIp: log.scannerIp, reported: true });
      if (reportCount >= 3) {
        await BlockList.findOneAndUpdate(
          { qrCode: log.qrCode, scannerIp: log.scannerIp },
          {
            ownerUserId:  req.userId,
            reportCount,
            reason,
            blockedAt:    new Date(),
            blockedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          },
          { upsert: true, new: true }
        );
      }
    }
    res.json({ message: 'Reported. Thank you for keeping CallDaddy safe.' });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Get TURN credentials for authenticated owner
app.get('/api/turn-credentials', authenticateJWT, (req, res) => {
  res.json(getTurnCredentials('owner'));
});

// Get TURN credentials for public scanner (no auth)
app.get('/api/turn-public', (req, res) => {
  res.json(getTurnCredentials('scanner'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
// ────────────────  ADMIN ROUTES  ─────────────────────────
// (Protected by ADMIN_SECRET header, not public)
// ══════════════════════════════════════════════════════════
const adminAuth = (req, res, next) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Generate a batch of unactivated QR codes in DB
app.post('/admin/qr/generate', adminAuth, [
  body('count').isInt({ min: 1, max: 10000 }),
  body('prefix').optional().isAlphanumeric().isLength({ max: 5 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const { count, prefix = 'CD' } = req.body;
    const batchId = Date.now().toString(36).toUpperCase();
    const chars   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars (0,O,1,I)
    const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const codes = new Set();
    while (codes.size < count) codes.add(`${prefix.toUpperCase()}-${rand(4)}-${rand(4)}`);

    const docs = [...codes].map(code => ({ code, batchId, status: 'UNACTIVATED' }));
    const result = await QRCodeModel.insertMany(docs, { ordered: false });

    res.json({
      message:    `Generated ${result.length} QR codes`,
      batchId,
      sampleCode: docs[0]?.code,
      scanUrlSample: `${process.env.DOMAIN}/scan/${docs[0]?.code}`,
      total: result.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List QR codes
app.get('/admin/qr/list', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 100, status, batchId } = req.query;
    const filter = {};
    if (status)  filter.status  = status;
    if (batchId) filter.batchId = batchId;
    const qrs   = await QRCodeModel.find(filter).limit(+limit).skip((+page - 1) * +limit)
      .populate('owner', 'name email').sort({ createdAt: -1 });
    const total = await QRCodeModel.countDocuments(filter);
    res.json({ qrs, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Serve public scan page (e.g., https://calldaddy.in/scan/CD-XXXX-XXXX)
app.get('/scan/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

// ══════════════════════════════════════════════════════════
// SOCKET.IO  —  WebRTC Signaling + Masked Chat
// ══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  let currentSession = null;
  let myRole         = null;

  // Both scanner and owner join the session room
  socket.on('join-session', ({ sessionId, role }) => {
    const s = activeSessions.get(sessionId);
    if (!s) { socket.emit('error', { message: 'Session not found or expired.' }); return; }

    currentSession = sessionId;
    myRole = role;
    socket.join(sessionId);

    if (role === 'owner') { s.status = 'OWNER_CONNECTED'; s.ownerSocketId = socket.id; }
    else                  { s.scannerSocketId = socket.id; }
    activeSessions.set(sessionId, s);

    socket.emit('session-joined', { sessionId, type: s.type });
    socket.to(sessionId).emit('peer-connected', { role });

    // If owner joins and scanner already sent an SDP offer, forward it
    if (role === 'owner' && s.sdpOffer) {
      socket.emit('webrtc-offer', { offer: s.sdpOffer });
    }
  });

  // ── WebRTC Signaling ────────────────────────────────────
  // Scanner → Server → Owner: SDP Offer
  socket.on('webrtc-offer', ({ sessionId: sid, offer }) => {
    const id = sid || currentSession;
    const s  = activeSessions.get(id);
    if (!s) return;
    s.sdpOffer = offer;
    activeSessions.set(id, s);
    socket.to(id).emit('webrtc-offer', { offer });
  });

  // Owner → Server → Scanner: SDP Answer
  socket.on('webrtc-answer', ({ sessionId: sid, answer }) => {
    const id = sid || currentSession;
    socket.to(id).emit('webrtc-answer', { answer });
    const s = activeSessions.get(id);
    if (s) { s.status = 'CONNECTED'; activeSessions.set(id, s); }
  });

  // ICE candidates (both directions)
  socket.on('ice-candidate', ({ sessionId: sid, candidate }) => {
    socket.to(sid || currentSession).emit('ice-candidate', { candidate });
  });

  // Owner accepts or rejects the incoming call
  socket.on('call-response', ({ sessionId: sid, accepted }) => {
    const id = sid || currentSession;
    socket.to(id).emit('call-response', { accepted });
    if (!accepted) {
      CallLog.findOneAndUpdate({ sessionId: id }, { status: 'REJECTED' }).exec();
      activeSessions.delete(id);
    }
  });

  // ── Chat messages ───────────────────────────────────────
  // Relay text message, stored in memory only (NOT in DB — ephemeral)
  socket.on('chat-message', ({ sessionId: sid, message }) => {
    const id = sid || currentSession;
    const s  = activeSessions.get(id);
    if (!s || s.type !== 'MESSAGE') return;
    // Allow only A-Z, a-z, 0-9, spaces, basic punctuation — max 500 chars
    const clean = String(message).replace(/[^a-zA-Z0-9 .,!?]/g, '').substring(0, 500);
    if (!clean.trim()) return;
    socket.to(id).emit('chat-message', { message: clean, from: myRole, ts: Date.now() });
  });

  // Call/session ended
  socket.on('call-ended', ({ sessionId: sid, duration }) => {
    const id = sid || currentSession;
    socket.to(id).emit('call-ended');
    CallLog.findOneAndUpdate({ sessionId: id }, { status: 'COMPLETED', duration: duration || 0, endedAt: new Date() }).exec();
    activeSessions.delete(id);
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    if (!currentSession) return;
    socket.to(currentSession).emit('peer-disconnected', { role: myRole });
    const s = activeSessions.get(currentSession);
    if (s && s.status === 'CONNECTED') {
      const dur = Math.floor((Date.now() - s.startedAt) / 1000);
      CallLog.findOneAndUpdate({ sessionId: currentSession }, { status: 'COMPLETED', duration: dur, endedAt: new Date() }).exec();
      activeSessions.delete(currentSession);
    }
  });
});

// ══════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ══════════════════════════════════════════════════════════
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ══════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected to "calldaddy" DB');
    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`✅ CallDaddy server running on port ${PORT}`);
      console.log(`🌐 Domain: ${process.env.DOMAIN}`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
