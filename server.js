const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cp = require('child_process');
const { RTCPeerConnection, nonstandard } = require('wrtc');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
const videoSenders = new Map();
const pendingMessages = new Map();

// Your RTSP camera URL
const CAMERA_URL = 'rtsp://10.210.14.58:8080/h264_ulaw.sdp';

wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientId = null;

  ws.on('message', async (msg) => {
    const parts = msg.toString().split('|');
    const type = parts[0];
    const senderId = parts[1];
    const receiverId = parts[2];
    const content = parts[3];
    const isVideoSender = parts[5] === 'true';

    if (type === 'NEWPEER') {
      clientId = senderId;
      clients.set(clientId, ws);
      if (isVideoSender) videoSenders.set(clientId, ws);

      // Send existing video senders info
      videoSenders.forEach((vws, vid) => {
        if (vws.readyState === WebSocket.OPEN && vid !== clientId) {
          ws.send(`NEWPEER|${vid}|${clientId}|Existing video sender|0|true`);
        }
      });

      // Send pending messages
      if (pendingMessages.has(clientId)) {
        pendingMessages.get(clientId).forEach((m) => ws.send(m));
        pendingMessages.delete(clientId);
      }
    } else if (receiverId === 'ALL') {
      // Broadcast
      clients.forEach((cws, cid) => {
        if (cid !== senderId && cws.readyState === WebSocket.OPEN) {
          cws.send(msg.toString());
        }
      });
    } else {
      const target = clients.get(receiverId);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(msg.toString());
      } else {
        if (!pendingMessages.has(receiverId)) pendingMessages.set(receiverId, []);
        pendingMessages.get(receiverId).push(msg.toString());
      }
    }
  });

  ws.on('close', () => {
    if (clientId) {
      clients.delete(clientId);
      videoSenders.delete(clientId);
      const disposeMsg = `DISPOSE|${clientId}|ALL|Peer disconnected|0|false`;
      clients.forEach((cws) => {
        if (cws.readyState === WebSocket.OPEN) cws.send(disposeMsg);
      });
    }
  });

  ws.on('error', console.error);
});

// Start FFmpeg process to push camera to each video sender
function startCameraStream() {
  const ffmpeg = cp.spawn('ffmpeg', [
    '-i', CAMERA_URL,
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=640:480',
    'pipe:1'
  ]);

  ffmpeg.stdout.on('data', (chunk) => {
    // Feed each video sender track
    videoSenders.forEach(async (ws, vid) => {
      // Here we could feed the raw video to wrtc's RTCVideoSource
      // For simplicity, let each client pull via WebRTC offer/answer
    });
  });

  ffmpeg.stderr.on('data', (data) => console.log('FFmpeg:', data.toString()));
  ffmpeg.on('exit', (code) => console.log('FFmpeg exited with', code));
}

// Start camera streaming
startCameraStream();

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
