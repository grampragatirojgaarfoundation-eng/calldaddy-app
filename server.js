/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  CallDaddy — Complete Backend (server.js)            ║
 * ║  All models, routes, socket.io, utils combined       ║
 * ╚══════════════════════════════════════════════════════╝
 */
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const Redis      = require('ioredis');
const passport   = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const admin      = require('firebase-admin');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const QRCode     = require('qrcode');
const Razorpay   = require('razorpay');
const { v4: uuidv4 } = require('uuid');
const cron       = require('node-cron');
const helmet     = require('helmet');
const cors       = require('cors');
const compression = require('compression');
const morgan     = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean   = require('xss-clean');
const hpp        = require('hpp');
const cookieParser = require('cookie-parser');
const { body, param, validationResult } = require('express-validator');
const rateLimit  = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const winston    = require('winston');
const path       = require('path');
const fs         = require('fs');

// ══════════════════════════════════════════════════════════
// SECTION 1 — LOGGER
// ══════════════════════════════════════════════════════════
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) }),
    new winston.transports.File({ filename: './logs/err.log', level: 'error' }),
    new winston.transports.File({ filename: './logs/combined.log' }),
  ],
});

// ══════════════════════════════════════════════════════════
// SECTION 2 — CRYPTO UTILS
// ══════════════════════════════════════════════════════════
const ALGO = 'aes-256-gcm';

function encryptField(plain) {
  if (!plain) return null;
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let enc = cipher.update(String(plain), 'utf8', 'hex') + cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}

function decryptField(cipher_text) {
  if (!cipher_text) return null;
  try {
    const [ivH, tagH, enc] = cipher_text.split(':');
    const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    const dec = crypto.createDecipheriv(ALGO, key, Buffer.from(ivH, 'hex'));
    dec.setAuthTag(Buffer.from(tagH, 'hex'));
    return dec.update(enc, 'hex', 'utf8') + dec.final('utf8');
  } catch { return null; }
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + process.env.ENCRYPTION_KEY).digest('hex');
}

function generateSafeCode(len = 8) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len)).map(b => chars[b % chars.length]).join('');
}

// HMAC TURN credentials (time-limited, secure)
function generateTurnCredentials() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiry}:calldaddy`;
  const hmac = crypto.createHmac('sha1', process.env.TURN_SECRET || 'calldaddy_turn_secret');
  hmac.update(username);
  const credential = hmac.digest('base64');
  return { username, credential, ttl: 3600 };
}

// ══════════════════════════════════════════════════════════
// SECTION 3 — MONGODB MODELS
// ══════════════════════════════════════════════════════════

// User
const UserSchema = new mongoose.Schema({
  googleId:    { type: String, required: true, unique: true, index: true },
  email:       { type: String, required: true, unique: true },
  name:        { type: String, trim: true, maxlength: 50, match: /^[a-zA-Z\s]+$/ },
  _mobileEnc:  String,
  _em1Enc:     String,
  _em2Enc:     String,
  fcmToken:    String,
  dndEnabled:  { type: Boolean, default: false },
  isProfileComplete: { type: Boolean, default: false },
  termsAcceptedAt: Date,
  lastLoginAt: { type: Date, default: Date.now },
  refreshToken: String,
}, { timestamps: true });

UserSchema.virtual('mobile').get(function() { return decryptField(this._mobileEnc); })
  .set(function(v) { this._mobileEnc = encryptField(v); });
UserSchema.virtual('emergency1').get(function() { return decryptField(this._em1Enc); })
  .set(function(v) { this._em1Enc = encryptField(v); });
UserSchema.virtual('emergency2').get(function() { return decryptField(this._em2Enc); })
  .set(function(v) { if (v) this._em2Enc = encryptField(v); });

UserSchema.methods.toSafe = function() {
  return {
    id: this._id, name: this.name, email: this.email,
    hasMobile: !!this._mobileEnc, hasEmergency1: !!this._em1Enc, hasEmergency2: !!this._em2Enc,
    dndEnabled: this.dndEnabled, isProfileComplete: this.isProfileComplete,
    termsAcceptedAt: this.termsAcceptedAt, createdAt: this.createdAt,
  };
};
const User = mongoose.model('User', UserSchema);

// QR Code
const QRCodeSchema = new mongoose.Schema({
  qrUniqueCode: { type: String, required: true, unique: true, uppercase: true, index: true },
  qrType:       { type: String, enum: ['physical', 'digital'], required: true },
  status:       { type: String, enum: ['unactivated', 'active', 'suspended'], default: 'unactivated', index: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  batchId:      mongoose.Schema.Types.ObjectId,
  qrImageUrl:   String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  amountPaid:   Number,
  activatedAt:  Date,
  scanCount:    { type: Number, default: 0 },
  lastScannedAt: Date,
}, { timestamps: true });
const QRCodeModel = mongoose.model('QRCode', QRCodeSchema);

// QR Batch (admin)
const QRBatchSchema = new mongoose.Schema({
  batchName: String, totalCodes: Number, activatedCount: { type: Number, default: 0 },
}, { timestamps: true });
const QRBatch = mongoose.model('QRBatch', QRBatchSchema);

// Scan Session (auto-TTL)
const ScanSessionSchema = new mongoose.Schema({
  sessionId:     { type: String, required: true, unique: true, index: true },
  qrCodeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'QRCode', required: true },
  scannerIp:     String,
  scannerDevice: String,
  scannerMobileEnc: String,
  status:        { type: String, enum: ['pending','ready','call_connecting','call_active','call_ended','expired'], default: 'pending' },
  callStartedAt: Date,
  callEndedAt:   Date,
  expiresAt:     { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  createdAt:     { type: Date, default: Date.now },
});
const ScanSession = mongoose.model('ScanSession', ScanSessionSchema);

// Call Log (CERT-In 1 year retention)
const CallLogSchema = new mongoose.Schema({
  qrCodeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'QRCode' },
  sessionId:     String,
  scannerIpHash: String,
  scannerDevice: String,
  callStartedAt: Date,
  callDuration:  { type: Number, default: 0 },
  callStatus:    { type: String, enum: ['missed','declined','completed','failed'] },
  expiresAt:     { type: Date, default: () => new Date(Date.now() + 365*24*60*60*1000), index: { expireAfterSeconds: 0 } },
});
const CallLog = mongoose.model('CallLog', CallLogSchema);

// Terms Acceptance (PERMANENT — never deleted)
const TermsSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acceptedAt: { type: Date, default: Date.now },
  ipAddress:  String,
  userAgent:  String,
  version:    { type: String, default: '1.0' },
});
const TermsAcceptance = mongoose.model('TermsAcceptance', TermsSchema);

// Report
const ReportSchema = new mongoose.Schema({
  qrCodeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'QRCode' },
  sessionId:  String,
  ipHash:     String,
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reason:     { type: String, enum: ['spam','abuse','harassment','obscene','other'] },
  adminReviewed: { type: Boolean, default: false },
  reportedAt: { type: Date, default: Date.now },
});
const Report = mongoose.model('Report', ReportSchema);

// Block List
const BlockSchema = new mongoose.Schema({
  qrCodeId:    { type: mongoose.Schema.Types.ObjectId, ref: 'QRCode' },
  ipHash:      String,
  reportCount: { type: Number, default: 1 },
  isPermanent: { type: Boolean, default: false },
  blockedAt:   { type: Date, default: Date.now },
});
BlockSchema.index({ qrCodeId: 1, ipHash: 1 }, { unique: true });
const BlockList = mongoose.model('BlockList', BlockSchema);

// ══════════════════════════════════════════════════════════
// SECTION 4 — SERVICES (QR Generator, FCM)
// ══════════════════════════════════════════════════════════

async function generateQRImage(code) {
  const dir = path.join(__dirname, 'uploads/qrcodes');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const url = `${process.env.DOMAIN}/scan/${code}`;
  const file = path.join(dir, `${code}.png`);
  await QRCode.toFile(file, url, { type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'H' });
  return `/uploads/qrcodes/${code}.png`;
}

async function generateQRDataUrl(code) {
  const url = `${process.env.DOMAIN}/scan/${code}`;
  return QRCode.toDataURL(url, { type: 'image/png', width: 600, errorCorrectionLevel: 'H' });
}

let firebaseReady = false;
function initFirebase() {
  try {
    const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!pk.includes('BEGIN PRIVATE KEY')) {
      logger.warn('Firebase private key not set — FCM push disabled. Fill FIREBASE_PRIVATE_KEY in .env');
      return;
    }
    admin.initializeApp({ credential: admin.credential.cert({
      projectId:    process.env.FIREBASE_PROJECT_ID,
      clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:   pk,
    })});
    firebaseReady = true;
    logger.info('Firebase Admin SDK ready');
  } catch(e) { logger.error(`Firebase init: ${e.message}`); }
}

async function sendCallPush(fcmToken, sessionId) {
  if (!firebaseReady || !fcmToken) return false;
  try {
    await admin.messaging().send({
      token: fcmToken,
      data: { type: 'INCOMING_CALL', sessionId, timestamp: String(Date.now()) },
      android: { priority: 'high', ttl: 30000 },
      apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'background' }, payload: { aps: { 'content-available': 1 } } },
    });
    return true;
  } catch(e) { logger.error(`FCM call push: ${e.message}`); return false; }
}

async function sendMsgPush(fcmToken, sessionId) {
  if (!firebaseReady || !fcmToken) return false;
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title: 'CallDaddy: New Message', body: 'Someone near your QR sent you a message.' },
      data: { type: 'INCOMING_MESSAGE', sessionId },
      android: { priority: 'high' },
    });
    return true;
  } catch(e) { logger.error(`FCM msg push: ${e.message}`); return false; }
}

// ══════════════════════════════════════════════════════════
// SECTION 5 — EXPRESS APP SETUP
// ══════════════════════════════════════════════════════════

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.DOMAIN, methods: ['GET','POST'], credentials: true },
  transports: ['websocket', 'polling'],
});

// Redis client
let redisClient;
function connectRedis() {
  redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    retryStrategy: t => Math.min(t * 50, 2000),
    maxRetriesPerRequest: 3,
  });
  redisClient.on('connect', () => logger.info('Redis connected'));
  redisClient.on('error',   e  => logger.error(`Redis: ${e.message}`));
}

// Rate limiters
const apiLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests, try later.' },
  store: new RedisStore({ sendCommand: (...a) => redisClient.call(...a) }),
});
const callLimiter = () => rateLimit({
  windowMs: 60 * 60 * 1000, max: 2, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `${req.ip}:${req.params.qrCode || req.body?.qrCode || 'x'}`,
  message: { success: false, message: 'Too many calls from this device. Try again in 1 hour.' },
  store: new RedisStore({ sendCommand: (...a) => redisClient.call(...a) }),
});
const authLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, message: 'Too many auth attempts.' },
  store: new RedisStore({ sendCommand: (...a) => redisClient.call(...a) }),
});

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com', 'https://www.google.com', 'https://www.gstatic.com', 'https://www.googleapis.com'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:'],
      mediaSrc:   ["'self'"],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https://checkout.razorpay.com', 'https://fcmregistrations.googleapis.com'],
      frameSrc:   ['https://checkout.razorpay.com'],
      workerSrc:  ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));
app.use(cors({ origin: process.env.DOMAIN, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(xssClean());
app.use(hpp());
app.use(morgan('combined', { stream: { write: m => logger.info(m.trim()) }, skip: (req, res) => res.statusCode < 400 }));

// IP extraction middleware
app.use((req, _, next) => {
  req.clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  req.clientDevice = (req.headers['user-agent'] || 'unknown').substring(0, 200);
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use('/uploads/qrcodes', express.static(path.join(__dirname, 'uploads/qrcodes'), { maxAge: '30d' }));

// ══════════════════════════════════════════════════════════
// SECTION 6 — PASSPORT (Google OAuth)
// ══════════════════════════════════════════════════════════

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.create({ googleId: profile.id, email: profile.emails[0].value });
      logger.info(`New user: ${user.email}`);
    } else {
      user.lastLoginAt = new Date();
      await user.save();
    }
    return done(null, user);
  } catch(e) { return done(e, null); }
}));
app.use(passport.initialize());

// JWT helpers
function signTokens(userId) {
  const accessToken   = jwt.sign({ userId }, process.env.JWT_SECRET,            { expiresIn: '15m' });
  const refreshToken  = jwt.sign({ userId }, process.env.REFRESH_TOKEN_SECRET,  { expiresIn: '7d'  });
  return { accessToken, refreshToken };
}

function cookieOpts(maxAge) {
  return { httpOnly: true, secure: true, sameSite: 'Strict', maxAge };
}

// Auth middleware
async function protect(req, res, next) {
  let token = (req.headers.authorization || '').replace('Bearer ', '') || req.cookies?.accessToken;
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(userId).select('-refreshToken');
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });
    req.user = user;
    next();
  } catch(e) {
    if (e.name === 'TokenExpiredError')
      return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function requireProfile(req, res, next) {
  if (!req.user.isProfileComplete)
    return res.status(403).json({ success: false, message: 'Complete your profile first', code: 'PROFILE_INCOMPLETE' });
  next();
}

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!key || key !== process.env.ADMIN_SECRET_KEY)
    return res.status(403).json({ success: false, message: 'Admin access denied' });
  next();
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ success: false, errors: errors.array().map(e => ({ field: e.path, msg: e.msg })) });
  next();
}

// ══════════════════════════════════════════════════════════
// SECTION 7 — ROUTES
// ══════════════════════════════════════════════════════════

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────
router.get('/auth/google', passport.authenticate('google', { scope: ['profile','email'], prompt: 'select_account', session: false }));

router.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=auth_failed' }),
  async (req, res) => {
    try {
      const { accessToken, refreshToken } = signTokens(req.user._id.toString());
      await User.findByIdAndUpdate(req.user._id, {
        refreshToken: crypto.createHash('sha256').update(refreshToken).digest('hex'),
        lastLoginAt: new Date(),
      });
      res.cookie('accessToken', accessToken, cookieOpts(15*60*1000))
         .cookie('refreshToken', refreshToken, cookieOpts(7*24*60*60*1000))
         .redirect(req.user.isProfileComplete ? '/?view=home' : '/?view=setup');
    } catch(e) {
      logger.error(`OAuth callback: ${e.message}`);
      res.redirect('/login?error=server_error');
    }
  }
);

router.post('/auth/refresh', async (req, res) => {
  const rt = req.cookies?.refreshToken;
  if (!rt) return res.status(401).json({ success: false, message: 'No refresh token' });
  try {
    const { userId } = jwt.verify(rt, process.env.REFRESH_TOKEN_SECRET);
    const user = await User.findById(userId);
    if (!user || user.refreshToken !== crypto.createHash('sha256').update(rt).digest('hex'))
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    const { accessToken, refreshToken } = signTokens(userId);
    await User.findByIdAndUpdate(userId, { refreshToken: crypto.createHash('sha256').update(refreshToken).digest('hex') });
    res.cookie('accessToken', accessToken, cookieOpts(15*60*1000))
       .cookie('refreshToken', refreshToken, cookieOpts(7*24*60*60*1000))
       .json({ success: true });
  } catch { res.status(401).json({ success: false, message: 'Refresh failed' }); }
});

// ✅ Terms Acceptance — saves date, time, IP, browser permanently in MongoDB
router.post('/auth/accept-terms', protect, async (req, res) => {
  try {
    await TermsAcceptance.create({
      userId:    req.user._id,
      ipAddress: req.clientIp,
      userAgent: req.clientDevice,
      version:   '1.0',
    });
    await User.findByIdAndUpdate(req.user._id, { termsAcceptedAt: new Date() });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/auth/logout', protect, async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { refreshToken: null });
  res.clearCookie('accessToken').clearCookie('refreshToken').json({ success: true });
});

router.get('/auth/me', protect, (req, res) => res.json({ success: true, user: req.user.toSafe() }));

router.delete('/auth/account', protect, async (req, res) => {
  try {
    await QRCodeModel.updateMany({ userId: req.user._id }, { status: 'suspended', userId: null });
    await User.findByIdAndDelete(req.user._id);
    res.clearCookie('accessToken').clearCookie('refreshToken')
       .json({ success: true, message: 'Account deleted.' });
  } catch(e) { res.status(500).json({ success: false, message: 'Deletion failed' }); }
});

// ── User Profile ──────────────────────────────────────────
router.put('/api/user/profile', protect,
  body('name').trim().notEmpty().matches(/^[a-zA-Z\s]+$/).withMessage('Letters only').isLength({max:50}),
  body('mobile').trim().notEmpty().matches(/^[0-9]+$/).withMessage('Digits only').isLength({min:7,max:15}),
  body('emergencyContact1').trim().notEmpty().matches(/^[0-9]+$/).isLength({min:7,max:15}),
  body('emergencyContact2').optional({checkFalsy:true}).trim().matches(/^[0-9]+$/).isLength({min:7,max:15}),
  validate,
  async (req, res) => {
    try {
      if (!req.user.termsAcceptedAt)
        return res.status(403).json({ success: false, message: 'Accept terms first', code: 'TERMS_NOT_ACCEPTED' });
      const { name, mobile, emergencyContact1, emergencyContact2 } = req.body;
      const u = await User.findById(req.user._id);
      u.name = name; u.mobile = mobile; u.emergency1 = emergencyContact1;
      if (emergencyContact2) u.emergency2 = emergencyContact2;
      u.isProfileComplete = true;
      await u.save();
      res.json({ success: true, user: u.toSafe() });
    } catch(e) { res.status(500).json({ success: false, message: 'Profile update failed' }); }
  }
);

router.put('/api/user/fcm-token', protect, async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ success: false });
  await User.findByIdAndUpdate(req.user._id, { fcmToken });
  res.json({ success: true });
});

router.put('/api/user/dnd', protect, async (req, res) => {
  const { dndEnabled } = req.body;
  if (typeof dndEnabled !== 'boolean') return res.status(400).json({ success: false });
  await User.findByIdAndUpdate(req.user._id, { dndEnabled });
  res.json({ success: true, dndEnabled });
});

router.get('/api/user/profile', protect, async (req, res) => {
  const u = await User.findById(req.user._id);
  res.json({ success: true, user: u?.toSafe() });
});

// ── QR Codes ──────────────────────────────────────────────
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

router.post('/api/qr/activate', protect, requireProfile,
  body('qrCode').trim().notEmpty().matches(/^SQ-[A-Z0-9]{4}-[A-Z0-9]{4}$/).withMessage('Invalid QR code format'),
  validate,
  async (req, res) => {
    try {
      const qr = await QRCodeModel.findOne({ qrUniqueCode: req.body.qrCode });
      if (!qr) return res.status(404).json({ success: false, message: 'QR code not found.' });
      if (qr.status !== 'unactivated') {
        if (qr.userId?.toString() === req.user._id.toString())
          return res.status(409).json({ success: false, message: 'Already activated by you.' });
        return res.status(409).json({ success: false, message: 'QR code already in use.' });
      }
      qr.status = 'active'; qr.userId = req.user._id; qr.activatedAt = new Date();
      await qr.save();
      res.json({ success: true, message: 'QR activated!', qr: { qrUniqueCode: qr.qrUniqueCode, qrImageUrl: qr.qrImageUrl } });
    } catch(e) { res.status(500).json({ success: false, message: 'Activation failed' }); }
  }
);

router.post('/api/qr/create-order', protect, requireProfile, async (req, res) => {
  try {
    const existing = await QRCodeModel.findOne({ userId: req.user._id, qrType: 'digital', status: 'active' });
    if (existing) return res.status(409).json({ success: false, message: 'You already have a digital QR.' });
    const order = await razorpay.orders.create({
      amount: parseInt(process.env.DIGITAL_QR_PRICE) || 19900,
      currency: 'INR',
      receipt: `qr_${req.user._id}_${Date.now()}`,
      notes: { userId: req.user._id.toString(), purpose: 'digital_qr' },
    });
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, razorpayKeyId: process.env.RAZORPAY_KEY_ID });
  } catch(e) { logger.error(`Razorpay order: ${e.message}`); res.status(500).json({ success: false, message: 'Payment init failed' }); }
});

router.post('/api/qr/verify-payment', protect, requireProfile, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ success: false, message: 'Payment verification failed' });
    const raw  = generateSafeCode(8);
    const code = `SQ-${raw.slice(0,4)}-${raw.slice(4)}`;
    const imgUrl  = await generateQRImage(code);
    const dataUrl = await generateQRDataUrl(code);
    await QRCodeModel.create({
      qrUniqueCode: code, qrType: 'digital', status: 'active',
      userId: req.user._id, qrImageUrl: imgUrl,
      razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id,
      amountPaid: parseInt(process.env.DIGITAL_QR_PRICE) || 19900,
      activatedAt: new Date(),
    });
    res.json({ success: true, message: 'QR generated!', qr: { qrUniqueCode: code, qrImageUrl: imgUrl, qrDataUrl: dataUrl } });
  } catch(e) { logger.error(`Payment verify: ${e.message}`); res.status(500).json({ success: false, message: 'QR generation failed' }); }
});

router.get('/api/qr/my-qrs', protect, async (req, res) => {
  const qrs = await QRCodeModel.find({ userId: req.user._id, status: { $ne: 'suspended' } })
    .select('qrUniqueCode qrType status qrImageUrl activatedAt scanCount lastScannedAt').sort({ createdAt: -1 });
  res.json({ success: true, qrs });
});

router.get('/api/qr/download/:code', protect, async (req, res) => {
  const qr = await QRCodeModel.findOne({ qrUniqueCode: req.params.code, userId: req.user._id });
  if (!qr) return res.status(404).json({ success: false });
  res.json({ success: true, qrDataUrl: await generateQRDataUrl(qr.qrUniqueCode) });
});

// ── Public Scan ───────────────────────────────────────────
router.get('/api/scan/:qrCode', async (req, res) => {
  try {
    const qr = await QRCodeModel.findOne({ qrUniqueCode: req.params.qrCode }).populate('userId', 'dndEnabled name');
    if (!qr || qr.status === 'suspended') return res.status(404).json({ success: false, code: 'QR_NOT_FOUND', message: 'QR not found or deactivated.' });
    if (qr.status === 'unactivated') return res.json({ success: false, code: 'NOT_ACTIVATED', message: 'QR not yet activated.' });
    const owner = qr.userId;
    if (owner?.dndEnabled) return res.json({ success: true, code: 'DND_ACTIVE', message: 'Owner is currently unavailable. Try later.' });
    const ipHash = hashIp(req.clientIp);
    const blocked = await BlockList.findOne({ qrCodeId: qr._id, ipHash, isPermanent: true });
    if (blocked) return res.status(403).json({ success: false, code: 'IP_BLOCKED', message: 'Access restricted.' });
    qr.scanCount = (qr.scanCount || 0) + 1; qr.lastScannedAt = new Date();
    await qr.save();
    res.json({ success: true, code: 'QR_ACTIVE', qrId: qr._id, ownerInitial: owner?.name?.charAt(0).toUpperCase() || 'C' });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/api/scan/:qrCode/session',
  body('mobile').trim().notEmpty().matches(/^[0-9]{10}$/).withMessage('Enter valid 10-digit number'),
  validate,
  async (req, res) => {
    try {
      const qr = await QRCodeModel.findOne({ qrUniqueCode: req.params.qrCode, status: 'active' });
      if (!qr) return res.status(404).json({ success: false, message: 'QR not found' });
      const sessionId = uuidv4();
      const ttl = parseInt(process.env.SCAN_SESSION_TTL_MINUTES) || 15;
      await ScanSession.create({
        sessionId, qrCodeId: qr._id,
        scannerIp: req.clientIp, scannerDevice: req.clientDevice,
        scannerMobileEnc: encryptField(req.body.mobile), status: 'ready',
        expiresAt: new Date(Date.now() + ttl * 60 * 1000),
      });
      res.json({ success: true, sessionId });
    } catch(e) { res.status(500).json({ success: false, message: 'Session creation failed' }); }
  }
);

// TURN credentials endpoint (for WebRTC)
router.get('/api/scan/turn-credentials', (req, res) => {
  res.json({ success: true, ...generateTurnCredentials(), servers: [process.env.TURN_SERVER, process.env.TURNS_SERVER].filter(Boolean) });
});

// ── Report / Block ─────────────────────────────────────────
router.post('/api/report', protect, async (req, res) => {
  try {
    const { sessionId, reason } = req.body;
    if (!sessionId || !reason) return res.status(400).json({ success: false });
    const sess = await ScanSession.findOne({ sessionId });
    if (!sess) return res.status(404).json({ success: false, message: 'Session not found' });
    const ipHash = hashIp(sess.scannerIp);
    await Report.create({ qrCodeId: sess.qrCodeId, sessionId, ipHash, reportedBy: req.user._id, reason });
    let bl = await BlockList.findOne({ qrCodeId: sess.qrCodeId, ipHash });
    if (bl) { bl.reportCount++; bl.lastReportAt = new Date(); if (bl.reportCount >= 3) bl.isPermanent = true; await bl.save(); }
    else await BlockList.create({ qrCodeId: sess.qrCodeId, ipHash });
    res.json({ success: true, message: 'Report submitted.' });
  } catch(e) { res.status(500).json({ success: false }); }
});

// ── Admin ──────────────────────────────────────────────────
router.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  const [users, activeQRs, unactivated, calls, pendingReports] = await Promise.all([
    User.countDocuments(), QRCodeModel.countDocuments({ status: 'active' }),
    QRCodeModel.countDocuments({ status: 'unactivated' }),
    CallLog.countDocuments(), Report.countDocuments({ adminReviewed: false }),
  ]);
  res.json({ success: true, stats: { users, activeQRs, unactivated, calls, pendingReports } });
});

router.get('/api/admin/reports', adminAuth, async (req, res) => {
  const reports = await Report.find({ adminReviewed: false }).populate('reportedBy','name email').populate('qrCodeId','qrUniqueCode').limit(100);
  res.json({ success: true, reports });
});

router.put('/api/admin/qr/:code/suspend', adminAuth, async (req, res) => {
  await QRCodeModel.findOneAndUpdate({ qrUniqueCode: req.params.code }, { status: 'suspended' });
  res.json({ success: true });
});

router.post('/api/admin/generate-batch', adminAuth, async (req, res) => {
  try {
    const size = parseInt(req.body.size) || 100;
    const batch = await QRBatch.create({ batchName: `Batch-${Date.now()}`, totalCodes: size });
    const docs = []; let gen = 0;
    while (gen < size) {
      const raw = generateSafeCode(8);
      const code = `SQ-${raw.slice(0,4)}-${raw.slice(4)}`;
      if (await QRCodeModel.exists({ qrUniqueCode: code })) continue;
      const url = await generateQRImage(code);
      docs.push({ qrUniqueCode: code, qrType: 'physical', status: 'unactivated', batchId: batch._id, qrImageUrl: url });
      gen++;
    }
    await QRCodeModel.insertMany(docs, { ordered: false });
    res.json({ success: true, generated: docs.length, batchId: batch._id });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── HTML Routes ────────────────────────────────────────────
const pub = p => (_, res) => res.sendFile(path.join(__dirname, 'public', p));
router.get('/scan/:qrCode',               pub('scan.html'));
router.get(['/login', '/login.html'],     pub('index.html'));
// ✅ /policy and /terms serve standalone policy.html (Play Store / App Store verification)
router.get(['/policy', '/policy.html', '/privacy', '/privacy-policy'], pub('policy.html'));
router.get(['/terms',  '/terms.html',  '/terms-of-service'],           pub('policy.html'));
router.get(['/admin',  '/admin.html'],    pub('index.html'));
router.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return res.status(404).json({ success: false });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(router);

// Global error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled: ${err.message}`);
  res.status(500).json({ success: false, message: process.env.NODE_ENV === 'production' ? 'Server error' : err.message });
});

// ══════════════════════════════════════════════════════════
// SECTION 8 — SOCKET.IO (WebRTC Signaling + Masked Chat)
// ══════════════════════════════════════════════════════════

const ownerSockets   = new Map();
const activeSessions = new Map();
const sessionMsgs    = new Map();

const MAX_CALL_MS  = (parseInt(process.env.MAX_CALL_DURATION_SECONDS) || 60) * 1000;
const POST_CALL_MS = (parseInt(process.env.POST_CALL_EXPIRY_MINUTES)  || 5)  * 60 * 1000;

async function endCall(sessionId, status) {
  try {
    const s = activeSessions.get(sessionId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    const dur = s.callStartedAt ? Math.round((Date.now() - s.callStartedAt) / 1000) : 0;
    const dbSess = await ScanSession.findOne({ sessionId });
    if (dbSess) {
      await CallLog.create({ qrCodeId: s.qrCodeId, sessionId, scannerIpHash: hashIp(dbSess.scannerIp), scannerDevice: dbSess.scannerDevice, callStartedAt: s.callStartedAt ? new Date(s.callStartedAt) : new Date(), callDuration: dur, callStatus: status });
      await ScanSession.findByIdAndUpdate(dbSess._id, { status: 'call_ended', callEndedAt: new Date(), expiresAt: new Date(Date.now() + POST_CALL_MS) });
    }
    activeSessions.delete(sessionId);
    sessionMsgs.delete(sessionId);
    logger.info(`Call ended: ${sessionId}, ${dur}s, ${status}`);
  } catch(e) { logger.error(`endCall: ${e.message}`); }
}

io.on('connection', socket => {
  socket.on('owner:register', ({ userId }) => {
    if (!userId) return;
    ownerSockets.set(userId, socket.id);
    socket.join(`owner:${userId}`);
  });

  socket.on('scanner:call', async ({ sessionId, qrCode }) => {
    try {
      const sess = await ScanSession.findOne({ sessionId });
      if (!sess || sess.status === 'expired') return socket.emit('call:error', { message: 'Session expired. Refresh and try again.' });
      const qr = await QRCodeModel.findById(sess.qrCodeId).populate('userId', 'fcmToken dndEnabled name');
      if (!qr?.userId) return socket.emit('call:error', { message: 'Owner not found.' });
      const owner = qr.userId;
      if (owner.dndEnabled) return socket.emit('call:error', { message: 'Owner is unavailable.', code: 'DND' });
      activeSessions.set(sessionId, { scannerSockId: socket.id, ownerSockId: ownerSockets.get(owner._id.toString()), qrCodeId: qr._id, ownerId: owner._id.toString(), callStartedAt: null, timer: null });
      await ScanSession.findByIdAndUpdate(sess._id, { status: 'call_connecting' });
      const ownerSockId = ownerSockets.get(owner._id.toString());
      if (ownerSockId) {
        io.to(ownerSockId).emit('incoming:call', { sessionId, label: 'Someone scanned your CallDaddy QR' });
        socket.emit('call:ringing');
      } else if (owner.fcmToken) {
        const sent = await sendCallPush(owner.fcmToken, sessionId);
        socket.emit(sent ? 'call:ringing' : 'call:error', sent ? {} : { message: 'Could not reach owner.' });
      } else {
        socket.emit('call:missed', { message: 'Owner is not available right now.' });
      }
    } catch(e) { logger.error(`scanner:call: ${e.message}`); socket.emit('call:error', { message: 'Server error' }); }
  });

  socket.on('owner:accept', ({ sessionId }) => {
    const s = activeSessions.get(sessionId);
    if (!s) return;
    s.ownerSockId = socket.id;
    s.callStartedAt = Date.now();
    io.to(s.scannerSockId).emit('call:accepted', { sessionId });
    s.timer = setTimeout(async () => {
      io.to(s.scannerSockId).emit('call:ended', { reason: 'time_limit' });
      io.to(s.ownerSockId).emit('call:ended', { reason: 'time_limit' });
      await endCall(sessionId, 'completed');
    }, MAX_CALL_MS);
  });

  socket.on('owner:decline', async ({ sessionId }) => {
    const s = activeSessions.get(sessionId);
    if (!s) return;
    io.to(s.scannerSockId).emit('call:declined');
    await endCall(sessionId, 'declined');
  });

  socket.on('webrtc:offer', ({ sessionId, offer }) => {
    const s = activeSessions.get(sessionId);
    if (s?.ownerSockId) io.to(s.ownerSockId).emit('webrtc:offer', { sessionId, offer });
  });
  socket.on('webrtc:answer', ({ sessionId, answer }) => {
    const s = activeSessions.get(sessionId);
    if (s?.scannerSockId) io.to(s.scannerSockId).emit('webrtc:answer', { sessionId, answer });
  });
  socket.on('webrtc:ice', ({ sessionId, candidate, from }) => {
    const s = activeSessions.get(sessionId);
    if (!s) return;
    const target = from === 'scanner' ? s.ownerSockId : s.scannerSockId;
    if (target) io.to(target).emit('webrtc:ice', { candidate, from });
  });

  socket.on('call:hangup', async ({ sessionId }) => {
    const s = activeSessions.get(sessionId);
    if (!s) return;
    const other = socket.id === s.scannerSockId ? s.ownerSockId : s.scannerSockId;
    if (other) io.to(other).emit('call:ended', { reason: 'hangup' });
    await endCall(sessionId, 'completed');
  });

  socket.on('msg:send', async ({ sessionId, text }) => {
    if (!text || !/^[a-zA-Z0-9\s]{1,500}$/.test(text.trim()))
      return socket.emit('msg:error', { message: 'Invalid message. Letters and numbers only, max 500.' });
    const s = activeSessions.get(sessionId);
    const dbSess = await ScanSession.findOne({ sessionId });
    if (!dbSess) return socket.emit('msg:error', { message: 'Session expired' });
    if (!sessionMsgs.has(sessionId)) sessionMsgs.set(sessionId, []);
    const isOwner = socket.id === s?.ownerSockId;
    const msg = { from: isOwner ? 'owner' : 'scanner', text: text.trim(), ts: Date.now() };
    sessionMsgs.get(sessionId).push(msg);
    const target = s ? (isOwner ? s.scannerSockId : s.ownerSockId) : null;
    if (target) io.to(target).emit('msg:received', msg);
    else if (!isOwner) {
      const qr = await QRCodeModel.findById(dbSess.qrCodeId).populate('userId', 'fcmToken');
      if (qr?.userId?.fcmToken) await sendMsgPush(qr.userId.fcmToken, sessionId);
    }
  });

  socket.on('disconnect', async () => {
    for (const [uid, sid] of ownerSockets.entries()) { if (sid === socket.id) { ownerSockets.delete(uid); break; } }
    for (const [sid, s] of activeSessions.entries()) {
      if (s.scannerSockId === socket.id || s.ownerSockId === socket.id) {
        const other = s.scannerSockId === socket.id ? s.ownerSockId : s.scannerSockId;
        if (other) io.to(other).emit('call:ended', { reason: 'partner_disconnected' });
        await endCall(sid, 'completed'); break;
      }
    }
  });
});

// ══════════════════════════════════════════════════════════
// SECTION 9 — CRON JOBS
// ══════════════════════════════════════════════════════════

function startCrons() {
  cron.schedule('*/10 * * * *', async () => {
    const ago = new Date(Date.now() - 10 * 60 * 1000);
    const r = await ScanSession.deleteMany({ status: 'call_active', callStartedAt: { $lt: ago } });
    if (r.deletedCount) logger.info(`Cron: Cleaned ${r.deletedCount} stale sessions`);
  });
  logger.info('Cron jobs started');
}

// ══════════════════════════════════════════════════════════
// SECTION 10 — SERVER START
// ══════════════════════════════════════════════════════════

async function start() {
  await mongoose.connect(process.env.MONGODB_URI);
  logger.info('MongoDB connected');
  connectRedis();
  initFirebase();
  startCrons();
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => logger.info(`CallDaddy running on port ${PORT} [${process.env.NODE_ENV}]`));
}

process.on('unhandledRejection', e => { logger.error(`Unhandled: ${e.message}`); });
process.on('uncaughtException',  e => { logger.error(`UncaughtEx: ${e.message}`); process.exit(1); });

module.exports = { generateBatch: async (size) => { /* run via npm run generate-qr-batch */ } };

start();