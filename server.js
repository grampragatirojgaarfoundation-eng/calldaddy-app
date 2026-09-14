require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.DOMAIN } });

// Security & Anti-Spam Middleware
app.use(helmet());
app.use(express.json());

const callLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 2, // 2 calls per IP
  message: "Rate limit exceeded. Try again in 1 hour."
});
app.use('/api/call', callLimiter);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log(err));

// CERT-In Call Log Schema
const CallLogSchema = new mongoose.Schema({
  qrId: String,
  scannerIp: String,
  startTime: { type: Date, default: Date.now },
  durationSeconds: Number
});
const CallLog = mongoose.model('CallLog', CallLogSchema);

// Firebase Admin Setup
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});

// Socket.io for WebRTC Signaling & Chat
io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  socket.on('webrtc-offer', (data) => {
    // WebRTC signaling logic
    socket.to(data.roomId).emit('webrtc-offer', data.offer);
  });

  socket.on('chat-message', (data) => {
    // 500 chars limit & alphanumeric check
    if(data.msg.length <= 500 && /^[a-zA-Z0-9\s]+$/.test(data.msg)) {
       socket.to(data.roomId).emit('chat-message', data.msg);
    }
  });

  socket.on('end-call', async (data) => {
    // Store call logs for 1 year compliance
    await CallLog.create({
        qrId: data.qrId,
        scannerIp: socket.handshake.address,
        durationSeconds: data.duration
    });
  });
});

app.listen(process.env.PORT, () => {
  console.log(`CallDaddy server running on port ${process.env.PORT}`);
});