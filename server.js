const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from "public"
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store clients by ID
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null;

  ws.on('message', (message) => {
    const messageStr = message.toString();
    console.log(`Received: ${messageStr}`);

    try {
      // Format: TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER
      const parts = messageStr.split('|');
      const type = parts[0];
      const senderId = parts[1];
      const receiverId = parts[2];

      // Register new client
      if (type === 'NEWPEER') {
        clientPeerId = senderId;
        clients.set(senderId, ws);
        console.log(`Registered ${senderId}`);

        // Notify everyone (broadcast presence)
        broadcastMessage(messageStr, ws);
      } 
      // Forward directly if target known
      else if (receiverId && receiverId !== 'ALL') {
        const targetClient = clients.get(receiverId);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          console.log(`Forwarding ${type} from ${senderId} to ${receiverId}`);
          targetClient.send(messageStr);
        } else {
          console.log(`Target ${receiverId} not found or not connected`);
        }
      } 
      // Broadcast to all
      else if (receiverId === 'ALL') {
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

      // Notify others
      const disconnectMsg = `DISPOSE|${clientPeerId}|ALL|Remove peerConnection for ${clientPeerId}.|0|false`;
      broadcastMessage(disconnectMsg, null);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

function broadcastMessage(message, excludeClient) {
  wss.clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

server.listen(port, () => {
  console.log(`🚀 Signaling server running on ws://localhost:${port}`);
});
