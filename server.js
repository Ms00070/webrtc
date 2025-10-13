// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Serve static files (your index.html inside "public" folder)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map to track connected peers: peerId -> ws
const peers = new Map();

wss.on('connection', (ws) => {
  let peerId = null;

  ws.on('message', (message) => {
    try {
      const msg = message.toString();
      const [type, senderId, targetId, content] = msg.split('|');

      // Save peerId when first message is NEWPEER
      if (!peerId && type === 'NEWPEER') {
        peerId = senderId;
        peers.set(peerId, ws);
        console.log(`Peer connected: ${peerId}`);
      }

      // Relay messages
      if (targetId === 'ALL') {
        peers.forEach((client, id) => {
          if (client.readyState === WebSocket.OPEN && id !== senderId) {
            client.send(msg);
          }
        });
      } else if (peers.has(targetId)) {
        const client = peers.get(targetId);
        if (client.readyState === WebSocket.OPEN) client.send(msg);
      }
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  });

  ws.on('close', () => {
    if (peerId) {
      peers.delete(peerId);
      console.log(`Peer disconnected: ${peerId}`);
      // Notify all peers about disconnection
      peers.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`DISCONNECT|${peerId}|ALL|`);
        }
      });
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
});

server.listen(port, () => {
  console.log(`WebRTC signaling server running on http://localhost:${port}`);
});
