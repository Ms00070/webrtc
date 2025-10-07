const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Create Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware for JSON parsing
app.use(express.json());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Store connected clients with their peer IDs
const clients = new Map();

// Store video senders with their connected receivers
const videoSenders = new Map();

// Track which Unity clients are connected to which video senders
const senderToReceiversMap = new Map();

// Store pending messages for late-joining clients
const pendingMessages = new Map();

// Add status endpoint for debugging
app.get('/api/status', (req, res) => {
  // Get list of Unity clients
  const unityClientIds = Array.from(clients.keys()).filter(id => id.includes('Unity'));
  
  // Get active sender-to-receiver mappings
  const activeMappings = Array.from(senderToReceiversMap.entries()).map(([senderId, receivers]) => ({
    senderId,
    receivers: Array.from(receivers)
  }));
  
  const status = {
    clients: Array.from(clients.keys()),
    unityClients: unityClientIds,
    videoSenders: Array.from(videoSenders.keys()),
    activeMappings: activeMappings,
    pendingMessages: Object.fromEntries(
      Array.from(pendingMessages.entries()).map(([key, messages]) => [
        key,
        {
          count: messages.length,
          types: messages.reduce((acc, msg) => {
            const type = msg.split('|')[0];
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {})
        }
      ])
    )
  };
  
  res.json(status);
});

// Add endpoint for Unity to check if server is ready
app.get('/api/ready', (req, res) => {
  const videoSendersCount = videoSenders.size;
  const unityReceiversCount = Array.from(clients.keys()).filter(id => id.includes('Unity')).length;
  
  res.json({
    ready: videoSendersCount > 0,
    videoSenders: Array.from(videoSenders.keys()),
    unityClients: Array.from(clients.keys()).filter(id => id.includes('Unity')),
    message: videoSendersCount > 0 ? 
      `Server ready with ${videoSendersCount} video senders and ${unityReceiversCount} Unity receivers` : 
      'Server running but no video senders connected yet'
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Handle direct message between peers
function handleDirectMessage(type, senderId, receiverId, msgContent, completeMessage) {
  // Ensure message has complete format
  let formattedMessage = completeMessage;
  const parts = completeMessage.split('|');
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
    formattedMessage = parts.join('|');
  }
  
  // Check if this is from a video sender - enable multi-client
  if (videoSenders.has(senderId) && receiverId.includes('Unity')) {
    // Store the connection for broadcasting
    if (!senderToReceiversMap.has(senderId)) {
      senderToReceiversMap.set(senderId, new Set());
    }
    
    // Add this receiver to the sender's list
    senderToReceiversMap.get(senderId).add(receiverId);
    console.log(`Tracking connection from ${senderId} to ${receiverId}`);
    
    // Store offer for late-joining clients if this is an offer
    if (type === 'OFFER') {
      if (!pendingMessages.has('stored-offers')) {
        pendingMessages.set('stored-offers', []);
      }
      const offerKey = `${senderId}-offer`;
      
      // Check if we already have an offer for this sender
      const existingOfferIndex = pendingMessages.get('stored-offers').findIndex(
        msg => msg.startsWith(`OFFER|${senderId}|`)
      );
      
      if (existingOfferIndex >= 0) {
        // Replace the existing offer
        pendingMessages.get('stored-offers')[existingOfferIndex] = formattedMessage;
      } else {
        // Store the new offer
        pendingMessages.get('stored-offers').push(formattedMessage);
      }
      
      console.log(`Stored ${type} from ${senderId} for future Unity clients`);
    }
  }
  
  // Send to specific client
  const targetClient = clients.get(receiverId);
  if (targetClient && targetClient.readyState === WebSocket.OPEN) {
    console.log(`Sending ${type} from ${senderId} to ${receiverId}`);
    targetClient.send(formattedMessage);
  } else {
    console.log(`Target client ${receiverId} not found or not connected - storing message`);
    
    // Store important messages (OFFER and CANDIDATE) for clients who haven't connected yet
    if (type === 'OFFER' || type === 'CANDIDATE') {
      if (!pendingMessages.has(receiverId)) {
        pendingMessages.set(receiverId, []);
      }
      
      // Store the complete message
      pendingMessages.get(receiverId).push(formattedMessage);
      console.log(`Stored ${type} message for ${receiverId} (total pending: ${pendingMessages.get(receiverId).length})`);
      
      // For Unity clients, limit the number of stored messages to prevent memory issues
      if (pendingMessages.get(receiverId).length > 100) {
        // Keep important messages like the most recent OFFER
        const offers = pendingMessages.get(receiverId).filter(msg => msg.startsWith('OFFER'));
        const candidates = pendingMessages.get(receiverId).filter(msg => msg.startsWith('CANDIDATE')).slice(-20);
        
        // Replace with filtered messages (most recent offer and a reasonable number of candidates)
        const filteredMessages = [...offers.slice(-1), ...candidates];
        pendingMessages.set(receiverId, filteredMessages);
        console.log(`Trimmed pending messages for ${receiverId} to ${filteredMessages.length} messages`);
      }
    }
  }
}

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

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null;
  
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
        
        // Check if this is a video sender
        const isVideoSender = isVideoAudioSender === 'true';
        if (isVideoSender) {
          console.log(`Client ${senderId} registered as video sender`);
          videoSenders.set(senderId, { 
            ws, 
            timestamp: Date.now() 
          });
        }
        
        // Broadcast to all clients
        broadcastMessage(messageStr, ws);
        
        // If this is a Unity client, inform about existing video senders
        if (senderId.includes('Unity')) {
          console.log(`Sending existing video senders to Unity client ${senderId}`);
          
          videoSenders.forEach((sender, senderPeerId) => {
            if (sender.ws.readyState === WebSocket.OPEN) {
              // Send NEWPEER message from each video sender to the new client
              const senderAnnouncement = `NEWPEER|${senderPeerId}|${senderId}|Existing video sender|0|true`;
              ws.send(senderAnnouncement);
              console.log(`Notified Unity client ${senderId} about existing video sender ${senderPeerId}`);
              
              // If we have stored offers for this sender, send them to the new client
              const storedOffers = pendingMessages.get('stored-offers') || [];
              const senderOffer = storedOffers.find(msg => msg.startsWith(`OFFER|${senderPeerId}|`));
              
              if (senderOffer) {
                // Send a personalized version of the offer to this client
                const personalizedOffer = senderOffer.replace(/\|[^|]+?\|/, `|${senderId}|`);
                ws.send(personalizedOffer);
                console.log(`Sent stored offer from ${senderPeerId} to Unity client ${senderId}`);
              }
              
              // Track this connection
              if (!senderToReceiversMap.has(senderPeerId)) {
                senderToReceiversMap.set(senderPeerId, new Set());
              }
              senderToReceiversMap.get(senderPeerId).add(senderId);
            }
          });
        }
        
        // Send any pending messages for this client
        if (pendingMessages.has(senderId)) {
          console.log(`Delivering ${pendingMessages.get(senderId).length} pending messages to ${senderId}`);
          pendingMessages.get(senderId).forEach(pendingMsg => {
            ws.send(pendingMsg);
          });
          pendingMessages.delete(senderId);
        }
      } 
      // Handle peer-to-peer messages
      else if (receiverId && receiverId !== 'ALL') {
        handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
      }
      // Handle broadcast messages from video sender to Unity clients
      else if (receiverId === 'ALL' && videoSenders.has(senderId)) {
        console.log(`Broadcasting ${type} from video sender ${senderId} to Unity clients`);
        
        // Get all Unity clients
        const unityClientIds = Array.from(clients.keys()).filter(id => id.includes('Unity'));
        
        unityClientIds.forEach(unityClientId => {
          // Create a personalized message for this Unity client
          const personalizedMessage = messageStr.replace(`|ALL|`, `|${unityClientId}|`);
          handleDirectMessage(type, senderId, unityClientId, msgContent, personalizedMessage);
        });
      }
      // Handle other broadcast messages
      else if (receiverId === 'ALL') {
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
      
      // Remove from clients map
      clients.delete(clientPeerId);
      
      // If it was a video sender, remove from video senders map
      if (videoSenders.has(clientPeerId)) {
        console.log(`Video sender ${clientPeerId} disconnected`);
        videoSenders.delete(clientPeerId);
        
        // Remove from sender-receiver mappings
        senderToReceiversMap.delete(clientPeerId);
      }
      
      // If it was a Unity client, remove from any sender's receivers list
      if (clientPeerId.includes('Unity')) {
        senderToReceiversMap.forEach((receivers, senderId) => {
          if (receivers.has(clientPeerId)) {
            receivers.delete(clientPeerId);
            console.log(`Removed ${clientPeerId} from ${senderId}'s receivers list`);
          }
        });
      }
      
      // Clear any pending messages for this client
      if (pendingMessages.has(clientPeerId)) {
        console.log(`Clearing ${pendingMessages.get(clientPeerId).length} pending messages for ${clientPeerId}`);
        pendingMessages.delete(clientPeerId);
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

// Send video senders to Unity clients and ensure all Unity clients get connected
function broadcastVideoSenderOffersToUnityClients() {
  // Get all Unity clients
  const unityClients = Array.from(clients.entries())
    .filter(([id]) => id.includes('Unity'))
    .map(([id, ws]) => ({ id, ws }));
  
  if (videoSenders.size > 0 && unityClients.length > 0) {
    console.log(`Checking connections for ${unityClients.length} Unity clients and ${videoSenders.size} video senders...`);
    
    videoSenders.forEach((sender, senderPeerId) => {
      if (sender.ws.readyState === WebSocket.OPEN) {
        // Get the receivers for this sender
        const receivers = senderToReceiversMap.get(senderPeerId) || new Set();
        
        // Check each Unity client to see if it's connected to this sender
        unityClients.forEach(({ id: unityClientId, ws: unityClient }) => {
          if (!receivers.has(unityClientId)) {
            console.log(`Unity client ${unityClientId} not connected to ${senderPeerId}, establishing connection...`);
            
            // Send a NEWPEER reminder
            const reminderMsg = `NEWPEER|${senderPeerId}|${unityClientId}|Connect to video sender|0|true`;
            unityClient.send(reminderMsg);
            
            // If we have stored offers for this sender, send one to this client
            const storedOffers = pendingMessages.get('stored-offers') || [];
            const senderOffer = storedOffers.find(msg => msg.startsWith(`OFFER|${senderPeerId}|`));
            
            if (senderOffer) {
              // Send a personalized version of the offer to this client
              const personalizedOffer = senderOffer.replace(/\|[^|]+?\|/, `|${unityClientId}|`);
              unityClient.send(personalizedOffer);
              console.log(`Sent stored offer from ${senderPeerId} to Unity client ${unityClientId}`);
            }
            
            // Track this connection
            if (!senderToReceiversMap.has(senderPeerId)) {
              senderToReceiversMap.set(senderPeerId, new Set());
            }
            senderToReceiversMap.get(senderPeerId).add(unityClientId);
          }
        });
      }
    });
  }
}

// Send periodic reminders about video senders to ensure Unity clients stay connected
function sendVideoSenderReminders() {
  // Get all Unity clients
  const unityClients = new Map([...clients.entries()].filter(([id]) => id.includes('Unity')));
  
  if (videoSenders.size > 0 && unityClients.size > 0) {
    console.log(`Sending video sender reminders to ${unityClients.size} Unity clients`);
    
    videoSenders.forEach((sender, senderPeerId) => {
      if (sender.ws.readyState === WebSocket.OPEN) {
        unityClients.forEach((unityClient, unityClientId) => {
          if (unityClient.readyState === WebSocket.OPEN) {
            // Send a NEWPEER reminder
            const reminderMsg = `NEWPEER|${senderPeerId}|${unityClientId}|Video sender reminder|0|true`;
            unityClient.send(reminderMsg);
            console.log(`Sent reminder about ${senderPeerId} to Unity client ${unityClientId}`);
          }
        });
      }
    });
  }
}

// Clean up pending messages periodically
function cleanupPendingMessages() {
  // Don't clean up stored offers, those are needed for late joining clients
  if (pendingMessages.has('stored-offers')) {
    return;
  }
  
  // Remove pending messages for clients that haven't connected in a while
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [clientId, messages] of pendingMessages.entries()) {
    if (clientId !== 'stored-offers' && !clients.has(clientId) && messages.length > 0) {
      // Only keep the messages for a reasonable amount of time
      const lastMessage = messages[messages.length - 1];
      const messageParts = lastMessage.split('|');
      const timestamp = parseInt(messageParts[4]) || now - staleThreshold - 1000;
      
      if (now - timestamp > staleThreshold) {
        console.log(`Cleaning up stale pending messages for ${clientId}`);
        pendingMessages.delete(clientId);
      }
    }
  }
}

// Set up periodic tasks
setInterval(sendVideoSenderReminders, 10000);
setInterval(broadcastVideoSenderOffersToUnityClients, 5000);
setInterval(cleanupPendingMessages, 30000);

// Start the server
server.listen(port, () => {
  console.log(`Multi-Unity WebRTC server running on port ${port}`);
});
