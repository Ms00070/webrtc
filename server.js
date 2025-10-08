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

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null; // Fixed: Initialize with instead of empty assignment
  
  // Handle messages from clients
  ws.on('message', (message) => {
    const messageStr = message.toString();
    console.log(`Received message: ${messageStr}`);
    
    try {
      // Check if message is Unity format (TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER)
      if (messageStr.includes('|')) {
        // Parse message in Unity format
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
          
          // Broadcast to all clients
          broadcastMessage(messageStr, ws);
        } 
        // Handle peer-to-peer messages
        else if (receiverId && receiverId !== 'ALL') {
          // Ensure message has complete format
          let completeMessage = messageStr;
          const messageParts = messageStr.split('|');
          if (messageParts.length < 6) {
            // Add missing parts with default values
            while (messageParts.length < 6) {
              messageParts.push(messageParts.length === 4 ? '0' : messageParts.length === 5 ? 'false' : '');
            }
            completeMessage = messageParts.join('|');
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
      } else {
        // Handle JSON format messages (browser clients)
        const data = JSON.parse(messageStr);
        
        // If this is from a browser client, store the clientId
        if (data.type === 'welcome' || data.type === 'NEWPEER') {
          clientPeerId = data.from || data.clientId;
          clients.set(clientPeerId, ws);
          console.log(`Registered JSON client with ID: ${clientPeerId}`);
        }
        
        // Forward to specific client
        if (data.to && clients.has(data.to)) {
          // Check if target is Unity client (needs conversion)
          const targetClient = clients.get(data.to);
          if (targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(JSON.stringify({ from: clientPeerId, ...data }));
          }
        }
        
        // Handle broadcast
        if (data.broadcast) {
          clients.forEach((client, id) => {
            if (id !== clientPeerId && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ from: clientPeerId, ...data }));
            }
          });
        }
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });
  
  // Send welcome message with clientId
  const tempClientId = Date.now().toString();
  ws.send(JSON.stringify({ type: 'welcome', clientId: tempClientId, clients: Array.from(clients.keys()) }));
  
  // Handle client disconnections
  ws.on('close', () => {
    if (clientPeerId) {
      console.log(`Client ${clientPeerId} disconnected`);
      clients.delete(clientPeerId);
      
      // Notify other clients about disconnection
      const disconnectMsg = `DISPOSE|${clientPeerId}|ALL|Remove peerConnection for ${clientPeerId}.|0|false`;
      broadcastMessage(disconnectMsg,);
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
  
  clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Start the server
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
