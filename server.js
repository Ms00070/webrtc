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

// Store WebRTC session data for each video sender (crucial for late joiners)
const activeStreams = new Map(); // Key: senderId, Value: {offer, candidates}

// Store pending messages for late-joining clients
const pendingMessages = new Map();

// Add status endpoint for debugging
app.get('/api/status', (req, res) => {
  const status = {
    clients: Array.from(clients.keys()),
    unityClients: Array.from(clients.keys()).filter(id => id.includes('Unity')),
    videoSenders: Array.from(videoSenders.keys()),
    activeStreams: Array.from(activeStreams.entries()).map(([senderId, data]) => ({
      senderId,
      hasOffer: !!data.offer,
      candidatesCount: data.candidates.length
    })),
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
  const activeStreamsCount = activeStreams.size;
  
  res.json({
    ready: videoSendersCount > 0,
    videoSenders: Array.from(videoSenders.keys()),
    activeStreams: activeStreamsCount,
    unityClients: Array.from(clients.keys()).filter(id => id.includes('Unity')),
    message: videoSendersCount > 0 ? 
      `Server ready with ${videoSendersCount} video senders and ${activeStreamsCount} active streams` : 
      'Server running but no video senders connected yet'
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store WebRTC session data for video sender (crucial for late joiners)
function storeStreamData(senderId, type, data) {
  if (!activeStreams.has(senderId)) {
    activeStreams.set(senderId, {
      offer: null,
      candidates: [],
      timestamp: Date.now()
    });
  }
  
  const streamData = activeStreams.get(senderId);
  
  if (type === 'OFFER') {
    streamData.offer = data;
    streamData.timestamp = Date.now();
    console.log(`Stored OFFER from ${senderId} for late joiners`);
  } else if (type === 'CANDIDATE') {
    streamData.candidates.push(data);
  }
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
  
  // If this is from a video sender, store the session data for late joiners
  if (videoSenders.has(senderId)) {
    if (type === 'OFFER' || type === 'CANDIDATE') {
      storeStreamData(senderId, type, msgContent);
    }
  }
  
  // Send to specific client
  const targetClient = clients.get(receiverId);
  if (targetClient && targetClient.readyState === WebSocket.OPEN) {
    console.log(`Sending ${type} from ${senderId} to ${receiverId}`);
    targetClient.send(formattedMessage);
    return true;
  } else {
    console.log(`Target client ${receiverId} not found or not connected - storing message`);
    
    // Store important messages for clients who haven't connected yet
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
    
    return false;
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

// Send stored WebRTC session data to a Unity client
function sendStoredStreamDataToUnityClient(unityClientId, unityClient) {
  console.log(`Checking for active streams to send to ${unityClientId}...`);
  
  // Go through all active streams from video senders
  activeStreams.forEach((streamData, senderId) => {
    // Only process if we have an offer
    if (streamData.offer && videoSenders.has(senderId)) {
      console.log(`Sending stored stream data from ${senderId} to ${unityClientId}`);
      
      // First send NEWPEER to establish connection
      const newPeerMsg = `NEWPEER|${senderId}|${unityClientId}|Existing video sender|0|true`;
      unityClient.send(newPeerMsg);
      
      // Then send the stored OFFER
      const offerMsg = `OFFER|${senderId}|${unityClientId}|${streamData.offer}|0|true`;
      unityClient.send(offerMsg);
      console.log(`Sent stored OFFER from ${senderId} to ${unityClientId}`);
      
      // Finally send all stored ICE candidates
      if (streamData.candidates && streamData.candidates.length > 0) {
        console.log(`Sending ${streamData.candidates.length} stored ICE candidates from ${senderId} to ${unityClientId}`);
        streamData.candidates.forEach(candidate => {
          const candidateMsg = `CANDIDATE|${senderId}|${unityClientId}|${candidate}|0|true`;
          unityClient.send(candidateMsg);
        });
      }
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
        
        // If this is a Unity client, send stored stream data
        if (senderId.includes('Unity')) {
          console.log(`Unity client connected: ${senderId}`);
          
          // CRITICAL: Send any active video streams to this Unity client
          sendStoredStreamDataToUnityClient(senderId, ws);
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
      // Handle broadcast messages
      else if (receiverId === 'ALL') {
        // If this is from a video sender to ALL, send to each Unity client individually
        if (videoSenders.has(senderId)) {
          console.log(`Broadcasting ${type} from video sender ${senderId} to all Unity clients`);
          
          const unityClientIds = Array.from(clients.keys()).filter(id => id.includes('Unity'));
          unityClientIds.forEach(unityId => {
            // Create a personalized message for this Unity client
            const personalizedMsg = messageStr.replace('|ALL|', `|${unityId}|`);
            handleDirectMessage(type, senderId, unityId, msgContent, personalizedMsg);
          });
        } else {
          // Regular broadcast
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
      
      // If it was a video sender, update maps but keep stream data for a while
      if (videoSenders.has(clientPeerId)) {
        console.log(`Video sender ${clientPeerId} disconnected`);
        videoSenders.delete(clientPeerId);
        
        // Keep the stream data for a while in case the sender reconnects
        setTimeout(() => {
          if (!videoSenders.has(clientPeerId)) {
            activeStreams.delete(clientPeerId);
            console.log(`Removed stream data for ${clientPeerId} after timeout`);
          }
        }, 60000); // 1 minute timeout
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
            
            // Check if this Unity client has already received the offers/candidates
            // If not, send them again (handles reconnection scenarios)
            if (activeStreams.has(senderPeerId)) {
              const streamData = activeStreams.get(senderPeerId);
              if (streamData.offer) {
                // We'll resend everything once every few reminders to ensure connectivity
                // This is a simple way to handle reconnections without complex tracking
                if (Math.random() < 0.2) { // 20% chance to resend on each reminder
                  console.log(`Resending WebRTC session data from ${senderPeerId} to ${unityClientId}`);
                  
                  const offerMsg = `OFFER|${senderPeerId}|${unityClientId}|${streamData.offer}|0|true`;
                  unityClient.send(offerMsg);
                  
                  // Send a subset of candidates to avoid flooding
                  if (streamData.candidates && streamData.candidates.length > 0) {
                    const candidatesToSend = streamData.candidates.slice(-5); // Just send the last 5
                    candidatesToSend.forEach(candidate => {
                      const candidateMsg = `CANDIDATE|${senderPeerId}|${unityClientId}|${candidate}|0|true`;
                      unityClient.send(candidateMsg);
                    });
                  }
                }
              }
            }
          }
        });
      }
    });
  }
}

// Check for new Unity clients that need stream data
function checkForNewUnityClients() {
  // If we have active streams and Unity clients
  if (activeStreams.size > 0) {
    // Get all Unity clients
    const unityClients = Array.from(clients.entries())
      .filter(([id]) => id.includes('Unity'))
      .map(([id, ws]) => ({ id, ws }));
    
    if (unityClients.length > 0) {
      console.log(`Checking if any of ${unityClients.length} Unity clients need stream data...`);
      
      // For each Unity client
      unityClients.forEach(({ id: unityClientId, ws: unityClient }) => {
        // Send stored stream data if we haven't already
        sendStoredStreamDataToUnityClient(unityClientId, unityClient);
      });
    }
  }
}

// Clean up pending messages periodically
function cleanupPendingMessages() {
  // Remove pending messages for clients that haven't connected for a while
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [clientId, messages] of pendingMessages.entries()) {
    if (!clients.has(clientId) && messages.length > 0) {
      // Check the age of the most recent message
      const lastMessage = messages[messages.length - 1];
      const messageParts = lastMessage.split('|');
      const timestamp = parseInt(messageParts[4]) || now - staleThreshold - 1000;
      
      if (now - timestamp > staleThreshold) {
        console.log(`Cleaning up ${messages.length} stale pending messages for ${clientId}`);
        pendingMessages.delete(clientId);
      }
    }
  }
}

// Set up periodic tasks
setInterval(sendVideoSenderReminders, 10000);
setInterval(checkForNewUnityClients, 5000);  // Crucial for late joiners
setInterval(cleanupPendingMessages, 30000);

// Start the server
server.listen(port, () => {
  console.log(`Fixed Multi-Unity WebRTC server running on port ${port}`);
});
