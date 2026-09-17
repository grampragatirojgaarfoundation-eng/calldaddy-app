require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Strict WebSocket for PM2 Multi-Core WebRTC Stability
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket']
});

// ─── Redis Setup for PM2 Cluster Mode ───
const pubClient = createClient({ url: 'redis://127.0.0.1:6379' });
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('Redis Pub Error:', err));
subClient.on('error', (err) => console.error('Redis Sub Error:', err));

Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log(`Worker ${process.pid} - Redis & Socket.IO Active ✅`);
});

// Prevent unauthorized access to sensitive files
app.get('/*', (req, res, next) => {
    if (req.url.includes('.env') || req.url.includes('.json.key') || req.url.includes('.git')) {
        return res.status(403).send("Access Denied");
    }
    next();
});

app.use(express.static(__dirname));

const callLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
app.use('/api/call', callLimiter);

// ─── MongoDB Connect ───
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log(`Worker ${process.pid} - MongoDB Connected`);
        try {
            const usersCol = mongoose.connection.db.collection('users');
            await usersCol.dropIndex('email_1').catch(() => {});
            await usersCol.dropIndex('googleId_1').catch(() => {});
            await usersCol.dropIndex('mobile_1').catch(() => {});
        } catch (e) {}
    })
    .catch(err => console.error('MongoDB Error:', err));

// ─── Schemas ───
const QrSchema = new mongoose.Schema({
    qrId: { type: String, unique: true, required: true },
    status: { type: String, enum: ['unregistered', 'active'], default: 'unregistered' },
    createdAt: { type: Date, default: Date.now }
});
const Qr = mongoose.model('Qr', QrSchema);

const UserSchema = new mongoose.Schema({
    qrId: { type: String, unique: true, required: true },
    email: { type: String, required: true, index: false },
    name: { type: String, default: 'Unknown' },
    mobile: { type: String, default: 'N/A' },
    fcmToken: { type: String, default: null },
    dnd: { type: Boolean, default: false },
    activatedAt: { type: Date, default: Date.now }
}, { autoIndex: false });
const User = mongoose.model('User', UserSchema);

const AuthLogSchema = new mongoose.Schema({
    qrId: String, email: String, action: String, ipAddress: String, deviceInfo: String,
    timestamp: { type: Date, default: Date.now, expires: 31536000 }
});
const AuthLog = mongoose.model('AuthLog', AuthLogSchema);

const CallLogSchema = new mongoose.Schema({
    qrId: String, callerIp: String, calleeIp: String, callerDevice: String, calleeDevice: String,
    startTime: { type: Date, default: Date.now }, endTime: Date, durationSeconds: Number, status: String,
    createdAt: { type: Date, default: Date.now, expires: 31536000 }
});
const CallLog = mongoose.model('CallLog', CallLogSchema);

// ─── Coturn TURN Config ───
app.get('/api/turn-config', (req, res) => {
    const turnSecret = process.env.TURN_SECRET;
    const timestamp = Math.floor(Date.now() / 1000) + 86400;
    const username = `${timestamp}:calldaddy`;
    const hmac = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    res.json({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "turn:calldaddy.in:3478", username, credential: hmac },
            { urls: "turn:calldaddy.in:3478?transport=tcp", username, credential: hmac }
        ]
    });
});

// ─── ADMIN PANEL APIs ───
const verifyAdmin = (req, res, next) => {
    const secret = req.headers['x-admin-secret'];
    if (secret && secret === process.env.ADMIN_SECRET) {
        next();
    } else {
        res.status(401).json({ success: false, error: "Unauthorized / Invalid Admin Password" });
    }
};

app.get('/api/admin/qrs', verifyAdmin, async (req, res) => {
    try {
        const qrs = await Qr.find().lean();
        for (let q of qrs) {
            if (q.status === 'active') {
                q.user = await User.findOne({ qrId: q.qrId }).lean();
            }
        }
        res.json({ success: true, qrs });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/generate-qrs', verifyAdmin, async (req, res) => {
    try {
        const { prefix, startNum, count } = req.body;
        let generated = 0;
        for (let i = 0; i < parseInt(count); i++) {
            const qrId = `${prefix}${parseInt(startNum) + i}`;
            const exists = await Qr.findOne({ qrId });
            if (!exists) {
                await Qr.create({ qrId, status: 'unregistered' });
                generated++;
            }
        }
        res.json({ success: true, message: `Successfully generated ${generated} QRs.` });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/delete-qr', verifyAdmin, async (req, res) => {
    try {
        const { qrId } = req.body;
        await Qr.deleteOne({ qrId });
        await User.deleteOne({ qrId });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// ─── Scanner API Routes ───
app.get('/api/check-qr/:qrId', async (req, res) => {
    try {
        const qrId = req.params.qrId.trim();
        const user = await User.findOne({ qrId });
        if (user) return res.json({ status: 'active', ownerName: user.name, dnd: user.dnd });
        const qrRecord = await Qr.findOne({ qrId });
        if (qrRecord) return res.json({ status: 'unregistered' });
        return res.json({ status: 'invalid' });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/verify-ownership', async (req, res) => {
    try {
        const { qrId, email } = req.body;
        if (!qrId || !email) return res.status(400).json({ isOwner: false });
        const user = await User.findOne({ qrId, email });
        res.json({ isOwner: !!user });
    } catch (err) { res.status(500).json({ isOwner: false }); }
});

app.post('/api/register-qr', async (req, res) => {
    try {
        const { qrId, email, name, mobile, fcmToken } = req.body;
        if (!qrId || !email) return res.status(400).json({ error: "Missing fields" });
        if (await User.findOne({ qrId })) return res.status(400).json({ error: "QR active already" });

        await User.create({ qrId, email, name: name || 'Unknown', mobile: mobile || 'N/A', fcmToken: fcmToken || null });
        await Qr.findOneAndUpdate({ qrId }, { status: 'active' }, { upsert: true });

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await AuthLog.create({ qrId, email, action: 'register', ipAddress: ip, deviceInfo: req.headers['user-agent'] });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Registration failed" }); }
});

app.post('/api/update-token', async (req, res) => {
    const { qrId, fcmToken } = req.body;
    if (qrId && fcmToken) {
        await User.findOneAndUpdate({ qrId }, { fcmToken });
        res.json({ success: true });
    } else res.status(400).json({ error: "Missing data" });
});

app.post('/api/owner/login', async (req, res) => {
    try {
        const { email, qrId, fcmToken } = req.body;
        if (!email) return res.status(400).json({ error: "Email required" });
        let user = qrId ? await User.findOne({ qrId, email }) : await User.findOne({ email });
        if (!user) return res.status(404).json({ error: "Not found or unauthorized." });

        if (fcmToken) { user.fcmToken = fcmToken; await user.save(); }
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await AuthLog.create({ qrId: user.qrId, email: user.email, action: 'login', ipAddress: ip, deviceInfo: req.headers['user-agent'] });

        res.json({ success: true, qrId: user.qrId, name: user.name });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/owner/my-qrs', async (req, res) => {
    const { email } = req.body;
    const users = await User.find({ email }).lean();
    res.json({ success: true, qrs: users.map(u => ({ qrId: u.qrId, name: u.name, dnd: u.dnd })) });
});

app.post('/api/owner/logout', async (req, res) => {
    const { qrId } = req.body;
    const user = await User.findOne({ qrId });
    if (user) {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await AuthLog.create({ qrId, email: user.email, action: 'logout', ipAddress: ip, deviceInfo: req.headers['user-agent'] });
        user.fcmToken = null;
        await user.save();
    }
    res.json({ success: true });
});

app.get('/api/owner/profile/:qrId', async (req, res) => {
    const user = await User.findOne({ qrId: req.params.qrId });
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, name: user.name, mobile: user.mobile, dnd: user.dnd });
});

app.post('/api/owner/update', async (req, res) => {
    const { qrId, name, mobile, dnd } = req.body;
    await User.findOneAndUpdate({ qrId }, { name, mobile, dnd });
    res.json({ success: true });
});

// ─── Firebase Admin SDK ───
let privateKey = process.env.FIREBASE_PRIVATE_KEY;
if (privateKey) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n')
            })
        });
    } catch (e) {}
}

app.post('/api/notify-owner', async (req, res) => {
    try {
        const { qrId } = req.body;
        const user = await User.findOne({ qrId });
        if (!user || user.dnd || !user.fcmToken) return res.status(403).json({ error: "Cannot send push" });

        const domain = process.env.DOMAIN || 'https://calldaddy.in';
        await admin.messaging().send({
            token: user.fcmToken,
            data: {
                title: "📞 Incoming Call",
                body: "Someone is calling from your vehicle. Tap Answer!",
                url: `${domain}/?qr=${qrId}&action=answer`,
                type: "call",
                qrId: String(qrId)
            },
            android: { priority: "high" },
            webpush: { headers: { Urgency: "high", TTL: "60" } }
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "FCM Error" }); }
});

app.post('/api/reject-call', async (req, res) => {
    const { qrId } = req.body;
    if (qrId) {
        const callStr = await pubClient.hGet('activeCalls', qrId);
        if (callStr) {
            const call = JSON.parse(callStr);
            call.status = 'rejected';
            call.calleeIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            call.calleeDevice = req.headers['user-agent'];
            call.endTime = new Date();
            await CallLog.create(call).catch(()=>{});
            await pubClient.hDel('activeCalls', qrId);
        }
        io.to(qrId).emit('call-rejected');
    }
    res.json({ success: true });
});

app.post('/api/send-message', async (req, res) => {
    try {
        const { qrId, content, sender } = req.body;
        if (!content || !/^[a-zA-Z0-9 ]*$/.test(content)) return res.status(400).json({ error: "Invalid text" });
        const user = await User.findOne({ qrId });
        if (!user) return res.status(404).json({ error: "User not found" });

        const msgObj = { sender: sender || 'Scanner', msg: content, timestamp: Date.now() };
        await pubClient.rPush(`chats:${qrId}`, JSON.stringify(msgObj));
        await pubClient.expire(`chats:${qrId}`, 86400);

        if (sender !== 'Owner' && user.fcmToken && !user.dnd) {
            const domain = process.env.DOMAIN || 'https://calldaddy.in';
            admin.messaging().send({
                token: user.fcmToken,
                data: {
                    title: "💬 New Message",
                    body: content.substring(0, 60),
                    url: `${domain}/?qr=${qrId}&action=chat`,
                    type: "chat",
                    qrId: String(qrId)
                },
                android: { priority: "high" }
            }).catch(()=>{});
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

app.get('/api/active-chat/:qrId', async (req, res) => {
    try {
        const msgsStr = await pubClient.lRange(`chats:${req.params.qrId}`, 0, -1);
        res.json({ success: true, messages: msgsStr.map(s => JSON.parse(s)) });
    } catch (e) { res.json({ success: true, messages: [] }); }
});

// ─── Socket.IO Sync ───
let localSocketRooms = {};
io.on('connection', (socket) => {
    socket.on('join-room', (data = {}) => {
        const { roomId, role } = data;
        if (roomId) { socket.join(roomId); localSocketRooms[socket.id] = { roomId, role }; }
    });

    socket.on('scanner-opened-chat', (data = {}) => {
        if (data.roomId) socket.to(data.roomId).emit('scanner-opened-chat');
    });

    socket.on('call-initiated', async (data = {}) => {
        const { roomId } = data;
        if (!roomId) return;
        const callData = {
            qrId: roomId,
            callerIp: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
            callerDevice: socket.handshake.headers['user-agent'],
            startTime: new Date(),
            status: 'missed'
        };
        await pubClient.hSet('activeCalls', roomId, JSON.stringify(callData));
        socket.to(roomId).emit('call-initiated', data);
    });

    socket.on('call-rejected', async (data = {}) => {
        const { roomId } = data;
        if (!roomId) return;
        const callStr = await pubClient.hGet('activeCalls', roomId);
        if (callStr) {
            const call = JSON.parse(callStr);
            call.status = 'rejected';
            call.calleeIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            call.calleeDevice = socket.handshake.headers['user-agent'];
            await pubClient.hSet('activeCalls', roomId, JSON.stringify(call));
        }
        socket.to(roomId).emit('call-rejected');
    });

    socket.on('owner-ready', async (data = {}) => {
        const { roomId } = data;
        if (!roomId) return;
        const callStr = await pubClient.hGet('activeCalls', roomId);
        if (callStr) {
            const call = JSON.parse(callStr);
            call.status = 'completed';
            call.calleeIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            call.calleeDevice = socket.handshake.headers['user-agent'];
            await pubClient.hSet('activeCalls', roomId, JSON.stringify(call));
        }
        socket.to(roomId).emit('owner-ready', data);
    });

    socket.on('webrtc-offer', (data = {}) => { if (data.roomId) socket.to(data.roomId).emit('webrtc-offer', data.offer); });
    socket.on('webrtc-answer', (data = {}) => { if (data.roomId) socket.to(data.roomId).emit('webrtc-answer', data.answer); });
    socket.on('webrtc-ice', (data = {}) => { if (data.roomId) socket.to(data.roomId).emit('webrtc-ice', data.candidate); });

    socket.on('chat-message', async (data = {}) => {
        const { roomId, msg, sender } = data;
        if (roomId && msg && /^[a-zA-Z0-9 ]*$/.test(msg)) {
            const msgObj = { sender: sender || 'Scanner', msg, timestamp: Date.now() };
            await pubClient.rPush(`chats:${roomId}`, JSON.stringify(msgObj));
            socket.to(roomId).emit('chat-message', data);
        }
    });

    socket.on('end-call', async (data = {}) => {
        const { roomId, duration } = data;
        if (!roomId) return;
        socket.to(roomId).emit('call-ended');
        const callStr = await pubClient.hGet('activeCalls', roomId);
        if (callStr) {
            const call = JSON.parse(callStr);
            call.endTime = new Date();
            call.durationSeconds = duration || 0;
            await CallLog.create(call).catch(()=>{});
            await pubClient.hDel('activeCalls', roomId);
        }
    });

    socket.on('disconnect', async () => {
        const info = localSocketRooms[socket.id];
        if (info && info.role === 'scanner' && info.roomId) {
            const { roomId } = info;
            socket.to(roomId).emit('call-ended');
            socket.to(roomId).emit('chat-ended');
            await pubClient.del(`chats:${roomId}`); // Destroy chat

            const callStr = await pubClient.hGet('activeCalls', roomId);
            if (callStr) {
                const call = JSON.parse(callStr);
                call.endTime = new Date();
                call.status = call.status || 'missed';
                await CallLog.create(call).catch(()=>{});
                await pubClient.hDel('activeCalls', roomId);
            }
        }
        delete localSocketRooms[socket.id];
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Worker ${process.pid} listening on port ${PORT}`));
