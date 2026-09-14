// Connect to Node.js Backend
const socket = io('https://calldaddy.in');

let localStream;
let peerConnection;
let callInterval;
let callDuration = 60; // 60 Seconds limit
let activeRoomId = null;

// Free Google STUN Servers for P2P connection
const rtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// ─── 1. GOOGLE LOGIN & PROFILE SETUP ────────────────────────────

function handleCredentialResponse(response) {
    console.log("Encoded JWT ID token: " + response.credential);
    // Send JWT to backend for validation. 
    // If user is new, show profile-screen. If existing, register service worker for FCM.
    showScreen('profile-screen'); 
}

function saveProfile() {
    const name = document.getElementById('owner-name').value;
    const mobile = document.getElementById('owner-mobile').value;
    const em1 = document.getElementById('em-mobile-1').value;
    
    // Strict Validations per Phase 1
    if(!/^[a-zA-Z\s]{1,50}$/.test(name)) {
        return alert("Name must be up to 50 English letters only.");
    }
    if(!/^\d{10,15}$/.test(mobile)) {
        return alert("Mobile must be 10-15 digits.");
    }
    
    // Send to backend, associate with unique Google ID.
    alert("Profile Saved. You are ready to activate QR codes.");
    registerServiceWorker(); // For FCM background waking
}

// ─── 2. SCANNER LOGIC & CALLING (WebRTC) ─────────────────────────

// Detect if URL has a QR ID (e.g., calldaddy.in/?qr=A7X9K2M)
window.onload = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const qrId = urlParams.get('qr');
    if(qrId) {
        activeRoomId = qrId;
        showScreen('scanner-screen');
        socket.emit('join-room', qrId);
        
        // Timer for Spam Protection: Expire session after 5 minutes
        setTimeout(() => {
            alert("Session Expired for Security.");
            window.location.reload();
        }, 5 * 60 * 1000);
    }
};

async function initiateCall() {
    const scannerMobile = document.getElementById('scanner-mobile').value;
    if(scannerMobile.length !== 10) return alert("Enter exactly 10 digits.");

    showScreen('call-screen');
    
    // Request Microphone access
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        peerConnection = new RTCPeerConnection(rtcConfig);
        
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        peerConnection.ontrack = (event) => {
            document.getElementById('remote-audio').srcObject = event.streams[0];
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc-ice', { roomId: activeRoomId, candidate: event.candidate });
            }
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        // Notify backend to Wake up Owner App via Firebase Push Notification
        socket.emit('webrtc-offer', { roomId: activeRoomId, offer: offer });
        
        startTimer();

    } catch (err) {
        alert("Microphone permission denied or not available.");
    }
}

function startTimer() {
    callDuration = 60;
    document.getElementById('call-timer').innerText = "01:00";
    callInterval = setInterval(() => {
        callDuration--;
        let seconds = callDuration < 10 ? '0' + callDuration : callDuration;
        document.getElementById('call-timer').innerText = "00:" + seconds;
        
        if(callDuration <= 0) {
            endCall();
        }
    }, 1000);
}

function endCall() {
    clearInterval(callInterval);
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(track => track.stop());
    socket.emit('end-call', { roomId: activeRoomId, duration: 60 - callDuration });
    showScreen('scanner-screen');
    alert("Call Ended securely.");
}

// ─── 3. CHAT LOGIC (Socket.io) ──────────────────────────────────

function showChat() {
    const scannerMobile = document.getElementById('scanner-mobile').value;
    if(scannerMobile.length !== 10) return alert("Enter exactly 10 digits first.");
    showScreen('chat-screen');
}

function sendMessage() {
    const inputField = document.getElementById('chatZaroor, main frontend ka code likh dunga. Par aapko kis chiz ka frontend chahiye? 

Kya yeh **BarberQ** salon app ke kisi naye page ke liye hai, **Rickshaw24** ke liye, ya koi bilkul naya PWA project hai? Ek baar thoda detail bata dijiye ki aapko kaun sa page (jaise login, dashboard, ya booking interface) banana hai aur kaun si technology (plain HTML/CSS/JS ya koi aur framework) use karni hai, taaki main turant code taiyar kar saku.