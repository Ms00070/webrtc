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

// Add status endpoint for debugging
app.get('/api/status', (req, res) => {
  const status = {
    clients: Array.from(clients.keys()),
    videoSenders: Array.from(videoSenders.keys()),
    activeWebRTCSessions: Array.from(activeWebRTCSessions.keys()),
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
  res.json({
    ready: videoSendersCount > 0,
    videoSenders: Array.from(videoSenders.keys()),
    message: videoSendersCount > 0 ? 
      `Server ready with ${videoSendersCount} video senders`  : 
      'Server running but no video senders connected yet'
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients with their peer IDs
const clients = new Map();

// Store video senders for quick reconnection when new clients join
const videoSenders = new Map();

// Store pending offers and candidates for late-joining clients
const pendingMessages = new Map();

// Store active WebRTC sessions for multi-client support
const activeWebRTCSessions = new Map();

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
          videoSenders.set(senderId, { ws, timestamp: Date.now() });
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

              // If Unity client and we have stored session data, send it after a short delay
              if (senderId.includes('Unity') && activeWebRTCSessions.has(senderPeerId)) {
                setTimeout(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                    sendStoredSessionToClient(senderPeerId, senderId, ws);
                  }
                }, 1000);
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
      // Handle OFFER messages - store them for late joiners
      else if (type === 'OFFER') {
        // Store the offer for video senders
        if (videoSenders.has(senderId)) {
          storeWebRTCSessionData(senderId, msgContent);
        }
        
        // Continue with normal message handling
        handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
      } 
      // Handle CANDIDATE messages - store them for video senders
      else if (type === 'CANDIDATE') {
        // Store candidate for video senders
        if (videoSenders.has(senderId)) {
          const session = activeWebRTCSessions.get(senderId);
          if (session) {
            session.candidates.push(msgContent);
          }
        }
        
        // Continue with normal message handling
        handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
      }
      // Handle other peer-to-peer messages
      else if (receiverId && receiverId !== 'ALL') {
        handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
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
      
      // Remove from clients map
      clients.delete(clientPeerId);
      
      // If it was a video sender, remove from video senders map
      if (videoSenders.has(clientPeerId)) {
        console.log(`Video sender ${clientPeerId} disconnected`);
        videoSenders.delete(clientPeerId);
        
        // Also remove any stored WebRTC session data
        if (activeWebRTCSessions.has(clientPeerId)) {
          activeWebRTCSessions.delete(clientPeerId);
        }
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

// Store WebRTC session data for multi-client support
function storeWebRTCSessionData(senderId, offerSdp) {
  // Store the offer for later use with new clients
  if (!activeWebRTCSessions.has(senderId)) {
    activeWebRTCSessions.set(senderId, {
      offer: offerSdp,
      candidates: [],
      connectedReceivers: new Set()
    });
  } else {
    activeWebRTCSessions.get(senderId).offer = offerSdp;
  }
  console.log(`Stored WebRTC session data for sender ${senderId}`);
}

// Send stored session data to a specific client
function sendStoredSessionToClient(senderId, receiverId, clientWs) {
  const session = activeWebRTCSessions.get(senderId);
  if (!session || !session.offer) {
    console.log(`No stored session data for ${senderId}`);
    return;
  }
  
  // Send the stored offer
  clientWs.send(`OFFER|${senderId}|${receiverId}|${session.offer}|0|true`);
  console.log(`Sent stored offer from ${senderId} to client ${receiverId}`);
  
  // Send stored ICE candidates with small delays
  session.candidates.forEach((candidate, idx) => {
    setTimeout(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(`CANDIDATE|${senderId}|${receiverId}|${candidate}|0|true`);
      }
    }, idx * 50); // Small delay between candidates
  });
  
  // Mark this receiver as having received the session data
  session.connectedReceivers.add(receiverId);
}

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

// Enhanced video sender reminder function for multiple Unity clients
function sendVideoSenderReminders() {
  // Get all video senders and Unity clients
  const unityClients = new Map([...clients.entries()].filter(([id]) => id.includes('Unity')));
  
  if (videoSenders.size > 0 && unityClients.size > 0) {
    console.log(`Sending video sender reminders to ${unityClients.size} Unity clients`);
    
    videoSenders.forEach((sender, senderPeerId) => {
      if (sender.ws.readyState === WebSocket.OPEN) {
        // Get active session for this sender
        const session = activeWebRTCSessions.get(senderPeerId);
        
        unityClients.forEach((unityClient, unityClientId) => {
          if (unityClient.readyState === WebSocket.OPEN) {
            // Send a NEWPEER reminder
            const reminderMsg = `NEWPEER|${senderPeerId}|${unityClientId}|Video sender reminder|0|true`;
            unityClient.send(reminderMsg);
            
            // If we have a stored session and this client hasn't received it yet
            if (session && session.offer && (!session.connectedReceivers.has(unityClientId))) {
              // Delay sending offer to ensure NEWPEER is processed first
              setTimeout(() => {
                if (unityClient.readyState === WebSocket.OPEN) {
                  sendStoredSessionToClient(senderPeerId, unityClientId, unityClient);
                }
              }, 500);
            }
          }
        });
      }
    });
  }
}

// Set up periodic reminder (more frequent for better multi-client support)
setInterval(sendVideoSenderReminders, 5000); // Every 5 seconds

// Clean up pending messages periodically to prevent memory leaks
function cleanupPendingMessages() {
  for (const [clientId, messages] of pendingMessages.entries()) {
    // Remove pending messages for clients that haven't connected in a while
    if (!clients.has(clientId)) {
      console.log(`Cleaning up ${messages.length} pending messages for inactive client ${clientId}`);
      pendingMessages.delete(clientId);
    }
  }
}

// Set up periodic cleanup
setInterval(cleanupPendingMessages, 30000); // Every 30 seconds

// Start the server
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
