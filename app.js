const socket = io({ transports: ['websocket'], upgrade: false });

let localStream = null, peerConnection = null, callInterval = null;
let callDuration = 0, callStartTime = null;
let activeRoomId = null, userEmail = "", authMode = "register";
let rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function fetchTurnConfig() {
    try {
        const res = await fetch('/api/turn-config');
        const data = await res.json();
        if (data.iceServers) rtcConfig = data;
    } catch (e) {}
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const t = document.getElementById(id);
    if (t) t.classList.add('active');
}

// ── SECURITY: SCANNER SANDBOX ──
// यह फंक्शन स्कैनर के फोन से डैशबोर्ड और लॉगिन को पूरी तरह मिटा देता है
function enforceScannerSandbox() {
    const sensitiveScreens = ['owner-home-screen', 'my-qrs-screen', 'profile-screen', 'login-screen', 'home-screen'];
    sensitiveScreens.forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
    document.querySelectorAll('.back-btn, header a, footer a, .dashboard-link').forEach(el => el.remove());
}

document.addEventListener('DOMContentLoaded', async () => {
    await fetchTurnConfig();
    initGoogleAuth();

    const urlParams = new URLSearchParams(window.location.search);
    const qrId = urlParams.get('qr');
    const action = urlParams.get('action');
    const ownedQrId = localStorage.getItem('ownedQrId');
    const ownerEmail = localStorage.getItem('ownerEmail');

    ['chat-input', 'owner-chat-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', function () { this.value = this.value.replace(/[^a-zA-Z0-9 ]/g, ''); });
    });

    if (qrId) {
        activeRoomId = qrId.trim();

        try {
            // STEP 1: चेक करें कि QR का स्टेटस क्या है?
            const res = await fetch(`/api/check-qr/${activeRoomId}`);
            const data = await res.json();

            if (data.status === 'unregistered') {
                // 🔹 FRESH QR: यूजर को इसे रजिस्टर और एक्टिव करने दें
                authMode = "register";
                showScreen('login-screen');
            }
            else if (data.status === 'active') {
                // 🔹 ACTIVE QR: चेक करें कि स्कैन करने वाला Owner है या Scanner?
                let isOwner = false;
                if (ownedQrId === activeRoomId && ownerEmail) {
                    const verRes = await fetch('/api/verify-ownership', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ qrId: activeRoomId, email: ownerEmail })
                    });
                    isOwner = (await verRes.json()).isOwner;
                }

                if (isOwner) {
                    // 👑 यह खुद OWNER है
                    socket.emit('join-room', { roomId: activeRoomId, role: 'owner' });

                    if (action === 'answer') acceptCall(activeRoomId); // Push Notification से कॉल उठाना
                    else if (action === 'chat') openMessages();        // Push Notification से मैसेज खोलना
                    else loadOwnerDashboard();                         // खुद का QR स्कैन करके डैशबोर्ड पर आना
                } else {
                    // 👤 यह कोई SCANNER (अजनबी) है!
                    // तुरंत Sandbox लगाओ और Owner के सारे फीचर डिलीट कर दो
                    enforceScannerSandbox();
                    socket.emit('join-room', { roomId: activeRoomId, role: 'scanner' });

                    if (action === 'chat') {
                        showChat();
                    } else {
                        showScreen('scanner-screen');
                        if (data.dnd) { // अगर Owner ने DND लगाया है
                            const warn = document.getElementById('scanner-dnd-warning');
                            const btn = document.getElementById('btn-call-owner');
                            if (warn) warn.style.display = 'block';
                            if (btn) { btn.disabled = true; btn.style.background = '#6c757d'; }
                        }
                    }
                }
            }
            else {
                // ❌ QR डेटाबेस में है ही नहीं (Wrong/Fake QR)
                document.getElementById('loading-screen').innerHTML = '<h3 style="color:red;text-align:center;">❌ Invalid QR</h3>';
            }
        } catch (e) {
            document.getElementById('loading-screen').innerHTML = '<h3 style="text-align:center;">⚠️ Server Error</h3>';
        }

    } else if (ownedQrId && ownerEmail) {
        // 🔹 OWNER APP OPENED (बिना QR स्कैन किए)
        authMode = "login";
        activeRoomId = ownedQrId;
        loadOwnerDashboard();
    } else {
        // 🔹 NEW APP OPEN (कोई डेटा नहीं)
        authMode = "login";
        showScreen('home-screen');
    }
});

// ── WebRTC Calling ──
async function initiateCall() {
    const callBtn = document.getElementById('btn-call-owner');
    if (callBtn) callBtn.disabled = true;
    showScreen('call-screen');
    document.getElementById('call-timer').innerText = "Requesting Microphone...";

    try {
        if (peerConnection) { peerConnection.close(); peerConnection = null; }
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        peerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
        peerConnection.ontrack = e => { const ra = document.getElementById('remote-audio'); if (ra) { ra.srcObject = e.streams[0]; ra.play().catch(()=>{}); } };
        peerConnection.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice', { roomId: activeRoomId, candidate: e.candidate }); };

        socket.emit('call-initiated', { roomId: activeRoomId });

        // Push notification Owner को भेजना
        fetch('/api/notify-owner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: activeRoomId }) })
            .then(async res => { if (res.status === 403) { alert("Owner is on DND."); endCall(true); } }).catch(() => {});

        startTimer(60, "ringing");
    } catch (err) {
        alert("Microphone Error: " + err.message);
        showScreen('scanner-screen');
        if (callBtn) callBtn.disabled = false;
    }
}

async function acceptCall(roomId = activeRoomId) {
    stopRingtone();
    activeRoomId = roomId;
    showScreen('call-screen');
    document.getElementById('call-timer').innerText = "Connecting...";
    socket.emit('join-room', { roomId: activeRoomId, role: 'owner' });

    try {
        if (peerConnection) { peerConnection.close(); peerConnection = null; }
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        peerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
        peerConnection.ontrack = e => { const ra = document.getElementById('remote-audio'); if(ra) ra.srcObject = e.streams[0]; };
        peerConnection.onicecandidate = e => { if (e.candidate) socket.emit('webrtc-ice', { roomId: activeRoomId, candidate: e.candidate }); };

        socket.emit('owner-ready', { roomId: activeRoomId });
        startTimer(150, "call");
    } catch (e) {
        alert("Microphone access required: " + e.message);
        loadOwnerDashboard();
    }
}

socket.on('call-initiated', () => { showScreen('incoming-call-screen'); const audio = document.getElementById('ringtone-audio'); if (audio) audio.play().catch(() => {}); });
socket.on('call-rejected', () => { alert("Owner rejected the call."); endCall(false); });
socket.on('call-ended', () => endCall(false));

function rejectCall() { stopRingtone(); socket.emit('call-rejected', { roomId: activeRoomId }); loadOwnerDashboard(); }
function stopRingtone() { const audio = document.getElementById('ringtone-audio'); if (audio) { audio.pause(); audio.currentTime = 0; } }

socket.on('owner-ready', async () => {
    document.getElementById('call-timer').innerText = "Connected";
    startTimer(150, "call");
    if (!peerConnection) return;
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', { roomId: activeRoomId, offer });
});

socket.on('webrtc-offer', async (offer) => {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('webrtc-answer', { roomId: activeRoomId, answer });
});
socket.on('webrtc-answer', async (answer) => { if (peerConnection) await peerConnection.setRemoteDescription(new RTCSessionDescription(answer)); });
socket.on('webrtc-ice', async (candidate) => { if (peerConnection && candidate) await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); });

function startTimer(duration, mode) {
    callDuration = duration;
    if (mode === "call") callStartTime = Date.now();
    clearInterval(callInterval);
    callInterval = setInterval(() => {
        callDuration--;
        const m = Math.floor(callDuration / 60); const s = callDuration % 60;
        const timeStr = (m < 10 ? '0' + m : m) + ":" + (s < 10 ? '0' + s : s);
        const timerEl = document.getElementById('call-timer');
        if (timerEl) timerEl.innerText = mode === "ringing" ? "Ringing... " + timeStr : timeStr;
        if (callDuration <= 0) { endCall(true); if (mode === "ringing") alert("Owner didn't answer."); }
    }, 1000);
}

function endCall(emit = true) {
    clearInterval(callInterval); stopRingtone();
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (emit) socket.emit('end-call', { roomId: activeRoomId, duration: callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0 });
    callStartTime = null;
    const callBtn = document.getElementById('btn-call-owner');
    if (callBtn) callBtn.disabled = false;

    if (localStorage.getItem('ownedQrId') === activeRoomId && !window.location.search.includes('qr=')) loadOwnerDashboard();
    else showScreen('scanner-screen');
}

// ── Google Auth & Registration ──
function initGoogleAuth() {
    if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({ client_id: "48981611712-cph3ipjfjq4lc59eusalcmsp6rg9t62f.apps.googleusercontent.com", callback: handleCredentialResponse, auto_select: false });
        ['google-btn-wrapper', 'owner-login-btn-wrapper'].forEach(id => { const el = document.getElementById(id); if (el) google.accounts.id.renderButton(el, { theme: "outline", size: "large", width: 300 }); });
    } else setTimeout(initGoogleAuth, 300);
}

function handleCredentialResponse(response) {
    try {
        const payload = JSON.parse(decodeURIComponent(window.atob(response.credential.split('.')[1]).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
        userEmail = payload.email;
        if (authMode === "register") showScreen('profile-screen'); else loginOwnerWithEmail(userEmail);
    } catch (e) { alert("Auth Failed"); }
}

async function loginOwnerWithEmail(email) {
    let fcmToken = window.getFirebaseToken ? await window.getFirebaseToken().catch(()=>null) : null;
    try {
        const res = await fetch('/api/owner/my-qrs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        const data = await res.json();
        if (!data.success || !data.qrs || data.qrs.length === 0) return alert("No active QR found for this email.");
        if (data.qrs.length === 1) await selectQrForDashboard(data.qrs[0].qrId, email, fcmToken);
        else showMyQrsScreen(data.qrs, email, fcmToken);
    } catch (e) { alert("Server error."); }
}

function showMyQrsScreen(qrs, email, fcmToken) {
    showScreen('my-qrs-screen'); const list = document.getElementById('my-qrs-list'); list.innerHTML = '';
    qrs.forEach(q => {
        const btn = document.createElement('button');
        btn.style.cssText = 'background:#17a2b8; margin-bottom:10px; text-align:left; padding:15px; width:100%;';
        btn.innerHTML = `<b>${q.qrId}</b><br><small>${q.name} | DND: ${q.dnd ? 'ON' : 'OFF'}</small>`;
        btn.onclick = () => selectQrForDashboard(q.qrId, email, fcmToken);
        list.appendChild(btn);
    });
}

async function selectQrForDashboard(qrId, email, fcmToken) {
    try {
        const res = await fetch('/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, qrId, fcmToken }) });
        const data = await res.json();
        if (data.success) { localStorage.setItem('ownedQrId', data.qrId); localStorage.setItem('ownerEmail', email); activeRoomId = data.qrId; loadOwnerDashboard(); }
    } catch (e) { alert("Server error."); }
}

window.requestNotificationAccess = async function () {
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') { document.getElementById('notification-warning').style.display = 'none'; await refreshFcmToken(); alert("✅ Notifications Enabled!"); }
    } catch (e) {}
};

async function refreshFcmToken() {
    if (!window.getFirebaseToken || !activeRoomId) return;
    try {
        const token = await window.getFirebaseToken();
        if (token) await fetch('/api/update-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: activeRoomId, fcmToken: token }) });
    } catch (e) {}
}

async function saveProfile() {
    const name = document.getElementById('owner-name').value.trim(), mobile = document.getElementById('owner-mobile').value.trim();
    const saveBtn = document.getElementById('save-btn'); saveBtn.innerText = "Activating..."; saveBtn.disabled = true;
    let fcmToken = window.getFirebaseToken ? await window.getFirebaseToken().catch(()=>null) : null;
    try {
        const res = await fetch('/api/register-qr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: activeRoomId, email: userEmail, name, mobile, fcmToken }) });
        const data = await res.json();
        if (res.ok && data.success) {
            localStorage.setItem('ownedQrId', activeRoomId);
            localStorage.setItem('ownerEmail', userEmail);
            alert("🎉 QR Activated successfully!");
            window.location.reload();
        }
        else { alert(data.error); saveBtn.innerText = "Save & Activate QR"; saveBtn.disabled = false; }
    } catch (err) { alert("Server error."); saveBtn.innerText = "Save & Activate QR"; saveBtn.disabled = false; }
}

async function loadOwnerDashboard() {
    showScreen('owner-home-screen'); socket.emit('join-room', { roomId: activeRoomId, role: 'owner' });
    document.getElementById('active-qr-display').innerHTML = `Managing QR: <b>${activeRoomId}</b>`;
    if (Notification.permission !== 'granted') { const nw = document.getElementById('notification-warning'); if(nw) nw.style.display = 'block'; } else await refreshFcmToken();
    fetch(`/api/owner/profile/${activeRoomId}`).then(r => r.json()).then(data => {
        if (data.success) {
            document.getElementById('update-name').value = data.name !== 'Unknown' ? data.name : ''; document.getElementById('update-mobile').value = data.mobile !== 'N/A' ? data.mobile : ''; document.getElementById('update-dnd').checked = data.dnd;
            const title = document.getElementById('owner-status-title');
            if (data.dnd) { title.innerText = "🔕 Do Not Disturb ON"; title.style.color = "#dc3545"; } else { title.innerText = "✅ Active & Listening"; title.style.color = "#28a745"; }
        }
    }).catch(() => {});
}

async function updateProfile() {
    const name = document.getElementById('update-name').value.trim(), mobile = document.getElementById('update-mobile').value.trim(), dnd = document.getElementById('update-dnd').checked;
    try {
        const res = await fetch('/api/owner/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: activeRoomId, name: name || 'Unknown', mobile: mobile || 'N/A', dnd }) });
        if ((await res.json()).success) { alert("Updated successfully!"); loadOwnerDashboard(); }
    } catch (e) { alert("Error"); }
}

function logoutOwner() {
    if (confirm("Logout?")) fetch('/api/owner/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: activeRoomId }) }).finally(() => { localStorage.removeItem('ownedQrId'); localStorage.removeItem('ownerEmail'); window.location.href = "/"; });
}

// ── Chat Functions ──
async function openMessages() {
    showScreen('owner-messages-screen');
    try {
        const res = await fetch(`/api/active-chat/${activeRoomId}`), data = await res.json(), list = document.getElementById('owner-messages-list');
        list.innerHTML = '';
        if (data.success && data.messages.length > 0) {
            data.messages.forEach(m => {
                const isOwner = m.sender === 'Owner', align = isOwner ? 'right' : 'left', bg = isOwner ? '#28a745' : '#e9ecef', color = isOwner ? 'white' : 'black';
                list.innerHTML += `<div style="text-align:${align}; margin:5px 0;"><div style="display:inline-block; max-width:85%; background:${bg}; color:${color}; padding:8px 12px; border-radius:8px; text-align:left;"><div style="font-size:10px; opacity:0.7; margin-bottom:3px;">${new Date(m.timestamp).toLocaleTimeString()}</div>${m.msg}</div></div>`;
            });
            list.scrollTop = list.scrollHeight;
        } else list.innerHTML = '<p style="text-align:center; color:#888; margin-top:20px;">No messages yet.</p>';
    } catch (e) {}
}

async function sendOwnerMessage() {
    const input = document.getElementById('owner-chat-input'), msg = input.value.trim();
    if (!msg || !/^[a-zA-Z0-9 ]*$/.test(msg)) return alert("Only letters & numbers allowed.");
    socket.emit('chat-message', { roomId: activeRoomId, msg, sender: 'Owner' });
    fetch('/api/send-message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: activeRoomId, content: msg, sender: 'Owner' }) }).catch(() => {});
    input.value = ''; setTimeout(openMessages, 150);
}

socket.on('chat-message', (data) => {
    const isOwner = data.sender === 'Owner';
    if (document.getElementById('chat-screen').classList.contains('active')) {
        const chatBox = document.getElementById('chat-box');
        if (chatBox) { chatBox.innerHTML += `<div style="text-align:left; color:${isOwner?'white':'black'}; padding:6px 10px; margin:4px 0; background:${isOwner?'#28a745':'#e9ecef'}; border-radius:8px;">${isOwner ? '<b>Owner: </b>' : ''}${data.msg}</div>`; chatBox.scrollTop = chatBox.scrollHeight; }
    }
    if (document.getElementById('owner-messages-screen').classList.contains('active')) openMessages();
});

socket.on('scanner-opened-chat', () => { if (localStorage.getItem('ownedQrId') === activeRoomId) openMessages(); });
socket.on('chat-ended', () => { if (document.getElementById('owner-messages-screen').classList.contains('active')) document.getElementById('owner-messages-list').innerHTML = '<p style="text-align:center; color:#888;">Scanner disconnected.</p>'; });
function showChat() { showScreen('chat-screen'); socket.emit('scanner-opened-chat', { roomId: activeRoomId }); }
function endSession() { window.location.reload(); }

async function sendMessage() {
    const input = document.getElementById('chat-input'), msg = input.value.trim();
    if (!msg || !/^[a-zA-Z0-9 ]*$/.test(msg)) return alert("Only letters & numbers allowed.");
    const chatBox = document.getElementById('chat-box');
    if (chatBox) { chatBox.innerHTML += `<div style="text-align:right; color:white; padding:6px 10px; margin:4px 0; background:#007bff; border-radius:8px;">${msg}</div>`; chatBox.scrollTop = chatBox.scrollHeight; }
    input.value = '';
    socket.emit('chat-message', { roomId: activeRoomId, msg, sender: 'Scanner' });
    fetch('/api/send-message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qrId: activeRoomId, content: msg, sender: 'Scanner' }) }).catch(() => {});
}
