'use strict';

const mongoose = require('mongoose');

// ══════════════════════════════════════════════════════════
// USER SCHEMA
// ══════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema(
  {
    googleId:     { type: String, required: true, unique: true, index: true },
    email:        { type: String, required: true, unique: true },
    displayName:  { type: String },          // from Google profile
    photoUrl:     { type: String },
    name:         { type: String, default: null },  // user-entered, letters only
    mobile:       { type: String, default: null },  // digits only
    emergency1:   { type: String, default: null },  // digits only
    emergency2:   { type: String, default: null },  // optional, digits only
    fcmToken:     { type: String, default: null },
    refreshToken: { type: String, default: null },
    dndMode:      { type: Boolean, default: false },
    profileComplete: { type: Boolean, default: false },
    activeQRs:    [{ type: String }],
    termsAccepted: {
      accepted:   { type: Boolean, default: false },
      acceptedAt: { type: Date },
      ip:         { type: String },
      userAgent:  { type: String },
    },
  },
  { timestamps: true }
);

// ══════════════════════════════════════════════════════════
// QR CODE SCHEMA
// ══════════════════════════════════════════════════════════
const qrCodeSchema = new mongoose.Schema(
  {
    code:          { type: String, required: true, unique: true, uppercase: true, index: true },
    status:        { type: String, enum: ['UNACTIVATED', 'ACTIVATED', 'DEACTIVATED'], default: 'UNACTIVATED' },
    owner:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    batchId:       { type: String, default: null },
    activatedAt:   { type: Date, default: null },
    totalScans:    { type: Number, default: 0 },
    totalCalls:    { type: Number, default: 0 },
    totalMessages: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ══════════════════════════════════════════════════════════
// CALL LOG SCHEMA  (auto-delete after 1 year — CERT-In rule)
// ══════════════════════════════════════════════════════════
const callLogSchema = new mongoose.Schema(
  {
    sessionId:      { type: String, required: true, unique: true, index: true },
    qrCode:         { type: String, required: true, index: true },
    ownerUserId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    scannerIp:      { type: String },
    scannerDevice:  { type: String },
    type:           { type: String, enum: ['CALL', 'MESSAGE'] },
    startedAt:      { type: Date, default: Date.now },
    endedAt:        { type: Date },
    duration:       { type: Number, default: 0 },  // seconds
    status:         { type: String, enum: ['INITIATED', 'COMPLETED', 'REJECTED', 'MISSED', 'FAILED'], default: 'INITIATED' },
    reported:       { type: Boolean, default: false },
    reportedReason: { type: String, default: null },
    // TTL field: MongoDB will auto-delete this document after 1 year
    expireAt:       { type: Date, default: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);
// TTL index — MongoDB deletes doc when expireAt is reached
callLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// ══════════════════════════════════════════════════════════
// BLOCK LIST SCHEMA
// ══════════════════════════════════════════════════════════
const blockListSchema = new mongoose.Schema(
  {
    qrCode:       { type: String, required: true },
    scannerIp:    { type: String, required: true },
    ownerUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reportCount:  { type: Number, default: 1 },
    reason:       { type: String },
    blockedAt:    { type: Date, default: Date.now },
    blockedUntil: { type: Date },  // null = permanent
  },
  { timestamps: true }
);
blockListSchema.index({ qrCode: 1, scannerIp: 1 }, { unique: true });

// ══════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════
module.exports = {
  User:         mongoose.model('User', userSchema),
  QRCodeModel:  mongoose.model('QRCode', qrCodeSchema),
  CallLog:      mongoose.model('CallLog', callLogSchema),
  BlockList:    mongoose.model('BlockList', blockListSchema),
};
