const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Express setup
const app = express();
const port = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// Add CORS headers for WebRTC connections
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map to store clients
const clients = new Map();
// Track video broadcasting clients
const videoSources = new Set();

wss.on('connection', (ws) => {
  const clientId = Date.now().toString(); // unique client ID
  clients.set(clientId, ws);
  console.log(`Client connected: ${clientId}`);
  console.log(`Total clients: ${clients.size}`);
  
  // Send welcome message with client ID and list of active clients
  ws.send(JSON.stringify({ 
    type: 'welcome', 
    clientId, 
    clients: Array.from(clients.keys()),
    videoSources: Array.from(videoSources)
  }));
  
  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
      console.log(`Received message type: ${data.type} from: ${data.from || clientId}`);
    } catch (err) {
      console.error('Invalid JSON', msg);
      return;
    }
    
    // Track clients who are broadcasting video
    if (data.type === 'NEWPEER' && data.videoEnabled) {
      console.log(`Client ${data.from || clientId} is broadcasting video`);
      videoSources.add(data.from || clientId);
    }
    
    // Handle WebRTC specific messages (offer, answer, ice-candidate)
    if (['offer', 'answer', 'ice-candidate'].includes(data.type)) {
      console.log(`WebRTC signaling: ${data.type} from ${data.from} to ${data.to}`);
    }
    
    // Forward to specific client
    if (data.to && clients.has(data.to)) {
      console.log(`Forwarding message to: ${data.to}`);
      // Ensure the 'from' field is set correctly
      const outgoingMsg = JSON.stringify({ 
        ...data,
        from: data.from || clientId 
      });
      clients.get(data.to).send(outgoingMsg);
    }
    
    // Broadcast
    if (data.broadcast) {
      console.log(`Broadcasting message to all clients from: ${data.from || clientId}`);
      clients.forEach((client, id) => {
        if (id !== clientId && client.readyState === WebSocket.OPEN) {
          const outgoingMsg = JSON.stringify({ 
            ...data,
            from: data.from || clientId 
          });
          client.send(outgoingMsg);
        }
      });
    }
  });
  
  ws.on('close', () => {
    // Remove video source if this client was broadcasting
    if (videoSources.has(clientId)) {
      videoSources.delete(clientId);
      // Notify others that this video source is gone
      clients.forEach((client, id) => {
        if (id !== clientId && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'video-source-disconnected',
            sourceId: clientId
          }));
        }
      });
    }
    
    clients.delete(clientId);
    console.log(`Client disconnected: ${clientId}`);
    console.log(`Total clients: ${clients.size}`);
  });
  
  ws.on('error', (err) => console.error('WebSocket error:', err));
});

server.listen(port, () => {
  console.log(`WebRTC signaling server running on port ${port}`);
  console.log(`Video streaming enabled via WebRTC`);
});
