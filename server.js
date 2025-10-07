const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Version 2.0 - One-to-Many Broadcasting Solution

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

// Store Unity receivers
const unityReceivers = new Map();

// Store pending messages for late-joining clients
const pendingMessages = new Map();

// Add status endpoint for debugging
app.get('/api/status', (req, res) => {
  // Get list of Unity clients
  const unityClientIds = Array.from(unityReceivers.keys());

  const status = {
    clients: Array.from(clients.keys()),
    videoSenders: Array.from(videoSenders.entries()).map(([senderId, sender]) => ({
      senderId,
      connectedReceiversCount: sender.connectedReceivers ? sender.connectedReceivers.size : 0,
      connectedReceivers: Array.from(sender.connectedReceivers || [])
    })),
    unityReceivers: unityClientIds,
    unityReceiversCount: unityClientIds.length,
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
  const unityReceiversCount = unityReceivers.size;
  
  res.json({
    ready: videoSendersCount > 0,
    videoSenders: Array.from(videoSenders.keys()),
    unityReceivers: Array.from(unityReceivers.keys()),
    message: videoSendersCount > 0 ? 
      `Server ready with ${videoSendersCount} video senders and ${unityReceiversCount} Unity receivers` : 
      'Server running but no video senders connected yet'
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Utility to send to a single client or store pending if disconnected
function sendToClient(clientId, message) {
  const targetClient = clients.get(clientId);
  if (targetClient && targetClient.readyState === WebSocket.OPEN) {
    targetClient.send(message);
    return true;
  } else {
    storePendingMessage(clientId, message);
    return false;
  }
}

// Store a pending message for a client
function storePendingMessage(clientId, message) {
  if (!pendingMessages.has(clientId)) {
    pendingMessages.set(clientId, []);
  }
  
  // Store the message
  pendingMessages.get(clientId).push(message);
  console.log(`Stored message for ${clientId} (total pending: ${pendingMessages.get(clientId).length})`);
  
  // For Unity clients, limit the number of stored messages to prevent memory issues
  if (pendingMessages.get(clientId).length > 100) {
    // Keep important messages like the most recent OFFER
    const offers = pendingMessages.get(clientId).filter(msg => msg.startsWith('OFFER'));
    const candidates = pendingMessages.get(clientId).filter(msg => msg.startsWith('CANDIDATE')).slice(-20);
    
    // Replace with filtered messages (most recent offer and a reasonable number of candidates)
    const filteredMessages = [...offers.slice(-1), ...candidates];
    pendingMessages.set(clientId, filteredMessages);
    console.log(`Trimmed pending messages for ${clientId} to ${filteredMessages.length} messages`);
  }
}

// Handle direct message broadcasting
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
  
  console.log(`Processing ${type} from ${senderId} to ${receiverId}`);
  
  // BROADCAST to all receivers if 'receiverId' is 'ALL' and this is a video sender
  if (receiverId === 'ALL' && videoSenders.has(senderId)) {
    const sender = videoSenders.get(senderId);
    
    // If this sender has connected receivers
    if (sender.connectedReceivers && sender.connectedReceivers.size > 0) {
      console.log(`Broadcasting from ${senderId} to ${sender.connectedReceivers.size} receivers`);
      
      // Send to each connected Unity receiver
      let sentCount = 0;
      sender.connectedReceivers.forEach(receiverId => {
        // Create a personalized message for this receiver
        const receiverMsg = formattedMessage.replace(`|ALL|`, `|${receiverId}|`);
        
        if (sendToClient(receiverId, receiverMsg)) {
          sentCount++;
        }
      });
      
      console.log(`Successfully sent to ${sentCount}/${sender.connectedReceivers.size} receivers`);
      return sentCount > 0;
    }
    
    // No connected receivers yet
    return false;
  } 
  // DIRECT MESSAGE to a specific Unity receiver from a video sender
  else if (videoSenders.has(senderId) && receiverId.includes('Unity')) {
    // Add receiver to this sender's connected receivers list if not already there
    const sender = videoSenders.get(senderId);
    if (!sender.connectedReceivers) {
      sender.connectedReceivers = new Set();
    }
    
    // Track this connection
    if (!sender.connectedReceivers.has(receiverId)) {
      sender.connectedReceivers.add(receiverId);
      console.log(`Added ${receiverId} to ${senderId}'s connected receivers (total: ${sender.connectedReceivers.size})`);
    }
    
    // Send to the specific receiver
    return sendToClient(receiverId, formattedMessage);
  }
  // Handle any other direct messages
  else {
    return sendToClient(receiverId, formattedMessage);
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
            timestamp: Date.now(),
            connectedReceivers: new Set()
          });
        }
        
        // Check if this is a Unity client
        if (senderId.includes('Unity')) {
          console.log(`Client ${senderId} registered as Unity receiver`);
          unityReceivers.set(senderId, { 
            ws, 
            timestamp: Date.now() 
          });
        }
        
        // Broadcast to all clients
        broadcastMessage(messageStr, ws);
        
        // If this is a new client (not a video sender), inform them about existing video senders
        if (!isVideoSender) {
          console.log(`Sending existing video senders to new client ${senderId}`);
          videoSenders.forEach((sender, senderPeerId) => {
            if (sender.ws.readyState === WebSocket.OPEN) {
              // Send NEWPEER message from each video sender to the new client
              const senderAnnouncement = `NEWPEER|${senderPeerId}|${senderId}|Existing video sender|0|true`;
              ws.send(senderAnnouncement);
              console.log(`Notified new client ${senderId} about existing video sender ${senderPeerId}`);
              
              // If this is a Unity client, add it to the sender's connected receivers
              if (senderId.includes('Unity')) {
                if (!sender.connectedReceivers) {
                  sender.connectedReceivers = new Set();
                }
                sender.connectedReceivers.add(senderId);
                console.log(`Added ${senderId} to ${senderPeerId}'s connected receivers`);
              }
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
      // Handle peer-to-peer messages (including OFFER, ANSWER, CANDIDATE)
      else if (receiverId && receiverId !== 'ALL') {
        handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
      }
      // Handle broadcast messages
      else if (receiverId === 'ALL') {
        if (videoSenders.has(senderId)) {
          // If this is a video sender broadcasting, use our special handling
          handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
        } else {
          // Otherwise, regular broadcast
          broadcastMessage(messageStr, ws);
        }
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
        
        // Get its connected receivers for notification
        const connectedReceivers = Array.from(videoSenders.get(clientPeerId).connectedReceivers || []);
        videoSenders.delete(clientPeerId);
        
        // Notify connected receivers that this sender is gone
        connectedReceivers.forEach(receiverId => {
          const receiver = clients.get(receiverId);
          if (receiver && receiver.readyState === WebSocket.OPEN) {
            receiver.send(`DISPOSE|${clientPeerId}|${receiverId}|Sender disconnected|0|false`);
          }
        });
      }
      
      // If it was a Unity receiver, remove from unityReceivers map
      if (unityReceivers.has(clientPeerId)) {
        console.log(`Unity receiver ${clientPeerId} disconnected`);
        unityReceivers.delete(clientPeerId);
        
        // Remove this receiver from all video senders' connected receivers
        videoSenders.forEach((sender, senderId) => {
          if (sender.connectedReceivers && sender.connectedReceivers.has(clientPeerId)) {
            sender.connectedReceivers.delete(clientPeerId);
            console.log(`Removed ${clientPeerId} from ${senderId}'s connected receivers`);
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

// Send periodic reminders about video senders to ensure Unity clients stay connected
function sendVideoSenderReminders() {
  // Only proceed if we have video senders and Unity receivers
  if (videoSenders.size === 0 || unityReceivers.size === 0) {
    return;
  }
  
  console.log(`Sending reminders to ${unityReceivers.size} Unity clients about ${videoSenders.size} video senders`);
  
  // For each video sender
  videoSenders.forEach((sender, senderPeerId) => {
    if (sender.ws.readyState === WebSocket.OPEN) {
      // Send to each Unity receiver
      unityReceivers.forEach((receiver, receiverId) => {
        if (receiver.ws.readyState === WebSocket.OPEN) {
          // Send a NEWPEER reminder to maintain connection
          const reminderMsg = `NEWPEER|${senderPeerId}|${receiverId}|Video sender reminder|0|true`;
          receiver.ws.send(reminderMsg);
          
          // Add this receiver to the sender's connected receivers if not already there
          if (!sender.connectedReceivers) {
            sender.connectedReceivers = new Set();
          }
          if (!sender.connectedReceivers.has(receiverId)) {
            sender.connectedReceivers.add(receiverId);
            console.log(`Added ${receiverId} to ${senderPeerId}'s connected receivers during reminder`);
          }
        }
      });
    }
  });
}

// Set up periodic reminder (every 5 seconds)
setInterval(sendVideoSenderReminders, 5000);

// Clean up pending messages periodically to prevent memory leaks
function cleanupPendingMessages() {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [clientId, messages] of pendingMessages.entries()) {
    // Remove pending messages for clients that haven't connected in a while
    if (!clients.has(clientId) && now - (unityReceivers.get(clientId)?.timestamp || 0) > staleThreshold) {
      console.log(`Cleaning up ${messages.length} pending messages for inactive client ${clientId}`);
      pendingMessages.delete(clientId);
    }
  }
}

// Set up periodic cleanup
setInterval(cleanupPendingMessages, 30000); // Every 30 seconds

// Start the server
server.listen(port, () => {
  console.log(`Broadcasting WebRTC Server is running on port ${port}`);
});
