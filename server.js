const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Create Express app
const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients with their peer IDs
const clients = new Map();
// Store pending messages for clients that haven't connected yet
const pendingMessages = new Map();
// Store pending ICE candidates
const pendingCandidates = new Map();

// Constants
const MAX_PENDING_MESSAGES = 100;
const HEARTBEAT_INTERVAL = 30000;
const MAX_INACTIVE_TIME = 60000;
const MAX_BROADCASTERS = 5; // Limit number of simultaneous broadcasters

// Track broadcasters
const broadcasters = new Map(); // broadcasterId -> { lastActive, clients: Set }
const subscribers = new Map();  // peerId -> Set of broadcasterIds they subscribe to

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null;
  let lastPing = Date.now();
  let isBroadcaster = false;
  
  // Setup heartbeat
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    lastPing = Date.now();
  });
  
  // Handle messages from clients
  ws.on('message', (message) => {
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
      
      // Register client with its ID when it announces itself
      if (type === 'NEWPEER') {
        clientPeerId = senderId;
        clients.set(senderId, ws);
        console.log(`Registered client with ID: ${senderId}`);
        
        // Check if this client has pending messages
        deliverPendingMessages(senderId);
        
        // Is this a broadcaster?
        if (msgContent.includes('broadcaster') || isVideoAudioSender === 'true') {
          registerBroadcaster(senderId);
          isBroadcaster = true;
        }
        
        // Broadcast to all clients
        broadcastMessage(messageStr, ws);
      } 
      // Handle SFU broadcast registration
      else if (type === 'BROADCAST_REGISTER') {
        registerBroadcaster(senderId);
        isBroadcaster = true;
        
        // Notify all clients about the new broadcaster
        broadcastMessage(`BROADCAST_AVAILABLE|${senderId}|ALL|New broadcaster available|0|true`, null);
      }
      // Handle subscription to a broadcaster
      else if (type === 'SUBSCRIBE') {
        const broadcasterId = receiverId;
        
        // Register subscription
        if (!subscribers.has(senderId)) {
          subscribers.set(senderId, new Set());
        }
        subscribers.get(senderId).add(broadcasterId);
        
        // If broadcaster exists, notify them of new subscriber
        if (broadcasters.has(broadcasterId)) {
          const broadcaster = clients.get(broadcasterId);
          if (broadcaster && broadcaster.readyState === WebSocket.OPEN) {
            broadcaster.send(`SUBSCRIBER_JOINED|${senderId}|${broadcasterId}|New subscriber joined|0|false`);
          }
        }
      }
      // Handle peer-to-peer messages
      else if (receiverId && receiverId !== 'ALL') {
        // Ensure message has complete format
        const completeMessage = ensureMessageFormat(messageStr);
        
        // Send to specific client
        const targetClient = clients.get(receiverId);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          console.log(`Sending ${type} from ${senderId} to ${receiverId}`);
          targetClient.send(completeMessage);
        } else {
          console.log(`Target client ${receiverId} not found or not connected, storing message`);
          storePendingMessage(receiverId, completeMessage);
          
          // For ICE candidates, store them separately for faster recovery
          if (type === 'CANDIDATE') {
            storePendingCandidate(senderId, receiverId, msgContent);
          }
        }
      }
      // Handle broadcast messages
      else if (receiverId === 'ALL') {
        // Broadcast to all clients except sender
        broadcastMessage(ensureMessageFormat(messageStr), ws);
      }
      // Handle media relay for SFU mode
      else if (type === 'MEDIA') {
        relayMediaPacket(senderId, receiverId, msgContent, parts[4], parts[5]);
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
      
      // If this was a broadcaster, clean up
      if (isBroadcaster && broadcasters.has(clientPeerId)) {
        broadcasters.delete(clientPeerId);
      }
      
      // Remove client from subscribers
      if (subscribers.has(clientPeerId)) {
        subscribers.delete(clientPeerId);
      }
      
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

// Helper functions
function registerBroadcaster(peerId) {
  // Check if we're at the limit
  if (broadcasters.size >= MAX_BROADCASTERS && !broadcasters.has(peerId)) {
    // Find oldest inactive broadcaster to replace
    let oldestBroadcaster = null;
    let oldestTime = Date.now();
    
    for (const [id, data] of broadcasters.entries()) {
      if (data.lastActive < oldestTime) {
        oldestTime = data.lastActive;
        oldestBroadcaster = id;
      }
    }
    
    // Remove oldest if needed
    if (oldestBroadcaster) {
      broadcasters.delete(oldestBroadcaster);
    }
  }
  
  // Add or update broadcaster
  broadcasters.set(peerId, {
    lastActive: Date.now(),
    clients: new Set()
  });
  
  console.log(`Registered broadcaster: ${peerId}`);
}

function broadcastMessage(message, excludeClient) {
  // Ensure message has all 6 parts required by SimpleWebRTC
  const formattedMessage = ensureMessageFormat(message);
  
  wss.clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(formattedMessage);
    }
  });
}

function ensureMessageFormat(message) {
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
  return message;
}

function storePendingMessage(receiverId, message) {
  if (!pendingMessages.has(receiverId)) {
    pendingMessages.set(receiverId, []);
  }
  
  const messages = pendingMessages.get(receiverId);
  messages.push({
    message,
    timestamp: Date.now()
  });
  
  // Limit pending messages to prevent memory issues
  if (messages.length > MAX_PENDING_MESSAGES) {
    pendingMessages.set(receiverId, messages.slice(-MAX_PENDING_MESSAGES));
  }
}

function storePendingCandidate(senderId, receiverId, candidateJson) {
  const key = `${receiverId}:${senderId}`;
  if (!pendingCandidates.has(key)) {
    pendingCandidates.set(key, []);
  }
  
  pendingCandidates.get(key).push({
    candidate: candidateJson,
    timestamp: Date.now()
  });
}

function deliverPendingMessages(peerId) {
  // Check for regular pending messages
  if (pendingMessages.has(peerId)) {
    const messages = pendingMessages.get(peerId);
    console.log(`Delivering ${messages.length} pending messages to ${peerId}`);
    
    const client = clients.get(peerId);
    if (client && client.readyState === WebSocket.OPEN) {
      messages.forEach(item => {
        client.send(item.message);
      });
    }
    
    // Clear delivered messages
    pendingMessages.delete(peerId);
  }
  
  // Check for pending ICE candidates
  for (const [key, candidates] of pendingCandidates.entries()) {
    const [receiverId, senderId] = key.split(':');
    if (receiverId === peerId) {
      const client = clients.get(peerId);
      if (client && client.readyState === WebSocket.OPEN) {
        candidates.forEach(item => {
          client.send(`CANDIDATE|${senderId}|${receiverId}|${item.candidate}|0|false`);
        });
      }
      
      // Clear delivered candidates
      pendingCandidates.delete(key);
    }
  }
}

function relayMediaPacket(senderId, mediaType, packet, metadata, encoding) {
  // Only handle packets from registered broadcasters
  if (!broadcasters.has(senderId)) return;
  
  // Update last active timestamp
  broadcasters.get(senderId).lastActive = Date.now();
  
  // Get all subscribers for this broadcaster
  const subscriberList = [];
  
  for (const [subId, broadcasterIds] of subscribers.entries()) {
    if (broadcasterIds.has(senderId)) {
      subscriberList.push(subId);
    }
  }
  
  // Forward media packet to all subscribers
  for (const subId of subscriberList) {
    const client = clients.get(subId);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(`MEDIA|${senderId}|${subId}|${mediaType}|${metadata}|${encoding}|${packet}`);
    }
  }
}

// Clean up old pending messages and candidates
function cleanupOldPendingItems() {
  const maxAge = 3600000; // 1 hour
  const now = Date.now();
  
  // Clean up pending messages
  for (const [peerId, messages] of pendingMessages.entries()) {
    const filteredMessages = messages.filter(item => (now - item.timestamp) < maxAge);
    if (filteredMessages.length === 0) {
      pendingMessages.delete(peerId);
    } else if (filteredMessages.length !== messages.length) {
      pendingMessages.set(peerId, filteredMessages);
    }
  }
  
  // Clean up pending candidates
  for (const [key, candidates] of pendingCandidates.entries()) {
    const filteredCandidates = candidates.filter(item => (now - item.timestamp) < maxAge);
    if (filteredCandidates.length === 0) {
      pendingCandidates.delete(key);
    } else if (filteredCandidates.length !== candidates.length) {
      pendingCandidates.set(key, filteredCandidates);
    }
  }
}

// Heartbeat to detect disconnected clients
const interval = setInterval(() => {
  const now = Date.now();
  
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false || (now - ws.lastPing > MAX_INACTIVE_TIME)) {
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
  
  // Clean up old pending messages and candidates
  cleanupOldPendingItems();
}, HEARTBEAT_INTERVAL);

// Handle server shutdown
wss.on('close', () => {
  clearInterval(interval);
});

// Start the server
server.listen(port, () => {
  console.log(`WebRTC Signaling Server is running on port ${port}`);
});
