const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Create Express app
const app = express();
const port = process.env.PORT || 3000;

// Serve static files from "public"
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients { peerId: ws }
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null;

  ws.on('message', (message) => {
    const messageStr = message.toString();
    console.log(`Received: ${messageStr}`);
    try {
      const parts = messageStr.split('|');
      const type = parts[0];
      const senderId = parts[1];
      const receiverId = parts[2];

      if (type === 'NEWPEER') {
        clientPeerId = senderId;
        clients.set(senderId, ws);
        console.log(`Registered ${senderId}`);
        broadcastMessage(messageStr, ws);
      } else if (receiverId && receiverId !== 'ALL') {
        const target = clients.get(receiverId);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(messageStr);
        }
      } else if (receiverId === 'ALL') {
        broadcastMessage(messageStr, ws);
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', () => {
    if (clientPeerId) {
      console.log(`Client ${clientPeerId} disconnected`);
      clients.delete(clientPeerId);
      const disconnectMsg = `DISPOSE|${clientPeerId}|ALL|Remove peerConnection for ${clientPeerId}.|0|false`;
      broadcastMessage(disconnectMsg, null);
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
});

function broadcastMessage(message, exclude) {
  wss.clients.forEach((client) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

server.listen(port, () => {
  console.log(`Signaling server running on port ${port}`);
});
