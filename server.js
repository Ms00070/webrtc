const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Initialize server
const server = http.createServer(app);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Set up WebSocket server
const wss = new WebSocket.Server({ server });

// Track connected clients
const clients = new Set();

// Map to store clients by their IDs
const clientsById = new Map();

// Map to store pending ICE candidates until after ANSWER is processed
const pendingCandidates = new Map();

// Assign a client ID on connection
let nextClientId = 1;

// Initialize clientPeerId to null (FIXED)
let clientPeerId = null;

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Add client to tracked clients
  clients.add(ws);
  
  // Generate a unique ID for this client
  const clientId = Date.now();
  clientsById.set(ws, clientId);
  
  // Send welcome message with client ID
  ws.send(JSON.stringify({ type: 'welcome', clientId, clients: Array.from(clients).map(c => clientsById.get(c)) }));
  
  // Handle messages from clients
  ws.on('message', (message) => {
    console.log(`Received: ${message}`);
    
    // Check if the message is in Unity WebRTC protocol format (pipe-delimited)
    const messageStr = message.toString();
    
    if (messageStr.includes('|')) {
      // Unity-style message: TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTIONCOUNT|ISVIDEOAUDIOSENDER
      const parts = messageStr.split('|');
      const type = parts[0];
      const senderId = parts[1];
      const receiverId = parts[2];
      const content = parts[3];
      
      // FIXED: Store the client's peer ID for later use in CANDIDATE messages
      if (type === 'NEWPEER') {
        clientPeerId = senderId;
      }

      if (type === 'CANDIDATE') {
        try {
          const candidate = JSON.parse(content);
          
          // Check if candidate is empty or invalid
          if (!candidate || Object.keys(candidate).length === 0 || 
              (!candidate.sdpMid && candidate.sdpMLineIndex === undefined)) {
            console.log('Skipping invalid ICE candidate:', content);
            return;
          }
          
          // If this is targeting a specific client and we haven't processed an ANSWER yet,
          // buffer the candidate
          if (receiverId !== 'ALL' && !receiverId.includes('ALL')) {
            if (!pendingCandidates.has(receiverId)) {
              pendingCandidates.set(receiverId, []);
            }
            
            const targetClientCandidates = pendingCandidates.get(receiverId);
            targetClientCandidates.push({ senderId, message: messageStr });
            console.log(`Stored ICE candidate from ${senderId} for ${receiverId}`);
          }
        } catch (err) {
          console.error('Error processing ICE candidate:', err);
        }
      }
      
      // For ANSWER messages, we need to process any stored ICE candidates
      if (type === 'ANSWER') {
        // Forward the ANSWER first
        broadcastMessage(messageStr, ws);
        
        // Then send any pending ICE candidates
        if (pendingCandidates.has(senderId)) {
          const candidatesToSend = pendingCandidates.get(senderId);
          for (const candidate of candidatesToSend) {
            console.log(`Sending stored ICE candidate from ${candidate.senderId} to ${senderId}`);
            broadcastMessage(candidate.message, ws);
          }
          // Clear the pending candidates
          pendingCandidates.delete(senderId);
        }
        
        // Don't broadcast this message again below, as we've already handled it
        return;
      }
      
      // Forward the message to all clients or specific client
      broadcastMessage(messageStr, ws);
    } else {
      // Standard JSON message
      try {
        const msg = JSON.parse(messageStr);
        
        // Handle different message types
        if (msg.type === 'offer') {
          // Handle offer - find target client and forward
          const targetWs = findClientById(msg.to);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type: 'offer',
              sdp: msg.sdp,
              from: clientsById.get(ws)
            }));
          }
        } else if (msg.type === 'answer') {
          // Handle answer - find target client and forward
          const targetWs = findClientById(msg.to);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type: 'answer',
              sdp: msg.sdp,
              from: clientsById.get(ws)
            }));
          }
        } else if (msg.type === 'candidate') {
          // Handle ICE candidate - find target client and forward
          const targetWs = findClientById(msg.to);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type: 'ice-candidate',
              candidate: msg.candidate,
              from: clientsById.get(ws)
            }));
          }
        } else {
          // For other message types, broadcast to all clients
          broadcastJSON(msg, ws);
        }
      } catch (e) {
        console.error('Error parsing message:', e);
      }
    }
  });
  
  // Handle client disconnection
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
    
    // Notify other clients about disconnection
    const clientId = clientsById.get(ws);
    broadcastJSON({
      type: 'peer-disconnected',
      clientId
    }, null);
    
    clientsById.delete(ws);
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
  
  // Extract receiver ID to check if this is a direct message
  const receiverId = parts[2];
  
  // If this is a direct message to a specific client
  if (receiverId !== 'ALL' && !receiverId.includes('ALL')) {
    // Find the target client and send only to them
    for (const client of clients) {
      const clientId = clientsById.get(client);
      if (clientId && clientId.toString() === receiverId) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          console.log(`Sent directed message to ${receiverId}`);
        }
        return; // Exit after sending to the target
      }
    }
    console.log(`Target client ${receiverId} not found`);
    return;
  }
  
  // Otherwise broadcast to all (except sender if specified)
  clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Function to broadcast JSON messages to all clients except the sender
function broadcastJSON(message, excludeClient) {
  const messageStr = JSON.stringify(message);
  clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// Function to find a client by its ID
function findClientById(id) {
  for (const [client, clientId] of clientsById.entries()) {
    if (clientId.toString() === id.toString()) {
      return client;
    }
  }
  return null;
}

// Start the server
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
