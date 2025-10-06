const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
 
// Create Express app
const app = express();
const port = process.env.PORT || 4000;
 
// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));
// Parse JSON bodies for REST endpoints
app.use(express.json({ limit: '10mb' }));
 
// Create HTTP server
const server = http.createServer(app);
 
// Create WebSocket server
const wss = new WebSocket.Server({ server });
 
// Store connected clients with their peer IDs
const clients = new Map();
// Shared in-memory object store
const sharedObjects = [];
 
// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null;
 
  // Handle messages from clients
  ws.on('message', (message, isBinary) => {
    // If binary (e.g., raw video/audio chunks), broadcast as-is
    if (isBinary) {
      console.log(`Received binary message (${message.byteLength || message.length} bytes) - broadcasting`);
      broadcastBinary(message, ws);
      return;
    }
 
    const messageStr = message.toString();
    console.log(`Received message: ${messageStr}`);
   
    try {
      // Parse message format: TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER
      const parts = messageStr.split('|');
      const type = parts[0];
      const senderId = parts[1];
      const receiverId = parts[2];
      const msgContent = parts[3];
      const connectionCount = parts[4] || '0';
      const isVideoAudioSender = parts[5] || 'false';
     
      // Handle Object push/store via WebSocket: OBJ_PUSH|SENDER_ID|ALL|{"any":"json"}
      if (type === 'OBJ_PUSH') {
        try {
          const payload = msgContent ? JSON.parse(msgContent) : null;
          const stored = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}` , senderId, payload, ts: Date.now() };
          sharedObjects.push(stored);
          // Acknowledge to sender
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(`OBJ_ACK|server|${senderId}|${stored.id}|0|false`);
          }
          // Notify others about new object (without payload to keep light)
          const notify = `OBJ_UPDATE|${senderId}|ALL|${stored.id}|${sharedObjects.length}|false`;
          broadcastMessage(notify, null);
        } catch (e) {
          console.error('Failed to parse OBJ_PUSH payload:', e);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(`OBJ_ERR|server|${senderId}|Invalid JSON payload|0|false`);
          }
        }
        return;
      }
 
      // Optional: Forward base64 video data in text frames: VIDEO|SENDER_ID|ALL|<base64>|<count>|<mime>
      if (type === 'VIDEO') {
        // Just broadcast the textual frame to everyone except sender
        broadcastMessage(messageStr, ws);
        return;
      }
 
      // Register client with its ID when it announces itself
      if (type === 'NEWPEER') {
        clientPeerId = senderId;
        clients.set(senderId, ws);
        console.log(`Registered client with ID: ${senderId}`);
       
        // Broadcast to all clients
        broadcastMessage(messageStr, ws);
      }
      // Handle peer-to-peer messages
      else if (receiverId && receiverId !== 'ALL') {
        // Ensure message has complete format
        let completeMessage = messageStr;
        const parts = messageStr.split('|');
        if (parts.length < 6) {
          // Add missing parts with default values
          while (parts.length < 4) {
            parts.push(''); // Add empty strings for missing required parts
          }
          if (parts.length === 4) {
            parts.push('0'); // Add default connection count
          }
          if (parts.length === 5) {
            parts.push('false'); // Add default isVideoAudioSender flag
          }
          completeMessage = parts.join('|');
        }
       
        // Send to specific client
        const targetClient = clients.get(receiverId);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          console.log(`Sending ${type} from ${senderId} to ${receiverId}`);
          targetClient.send(completeMessage);
        } else {
          console.log(`Target client ${receiverId} not found or not connected`);
        }
      }
      // Handle broadcast messages
      else if (receiverId === 'ALL') {
        // Broadcast to all clients except sender
        broadcastMessage(messageStr, ws);
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });
 
  // Handle client disconnections
  ws.on('close', () => {
    if (clientPeerId) {
      console.log(`Client ${clientPeerId} disconnected`);
      clients.delete(clientPeerId);
     
      // Notify other clients about disconnection
      const disconnectMsg = `DISPOSE|${clientPeerId}|ALL|Remove peerConnection for ${clientPeerId}.|0|false`;
      broadcastMessage(disconnectMsg, null);
    } else {
      console.log('Unknown client disconnected');
    }
  });
 
  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});
 
// Function to broadcast a message to all clients except the sender
function broadcastMessage(message, excludeClient) {
  // Ensure message has all 6 parts required by SimpleWebRTC
  const parts = message.split('|');
  if (parts.length < 6) {
    // Add missing parts with default values
    while (parts.length < 4) {
      parts.push(''); // Add empty strings for missing required parts
    }
    if (parts.length === 4) {
      parts.push('0'); // Add default connection count
    }
    if (parts.length === 5) {
      parts.push('false'); // Add default isVideoAudioSender flag
    }
    message = parts.join('|');
  }
 
  wss.clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
 
// Function to broadcast a binary message to all clients except the sender
function broadcastBinary(binaryData, excludeClient) {
  wss.clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(binaryData, { binary: true });
    }
  });
}
 
// Start the server
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
 
// Simple REST API to interact with shared object store
app.get('/objects', (req, res) => {
  res.json({ count: sharedObjects.length, items: sharedObjects });
});
 
app.post('/objects', (req, res) => {
  try {
    const payload = req.body;
    const stored = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, senderId: 'http', payload, ts: Date.now() };
    sharedObjects.push(stored);
    // Notify websocket clients
    const notify = `OBJ_UPDATE|http|ALL|${stored.id}|${sharedObjects.length}|false`;
    broadcastMessage(notify, null);
    res.status(201).json(stored);
  } catch (e) {
    res.status(400).json({ error: 'Invalid payload' });
  }
})
