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

// Store Unity receivers for quick lookup
const unityReceivers = new Map();

// Store WebRTC session data (offers, candidates) for each video sender
const webRTCSessions = new Map();

// Store active connections between senders and receivers
const activeConnections = new Map();

// Connection state constants
const CONNECTION_STATES = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  RECONNECTING: 'reconnecting'
};

// Store pending messages for late-joining clients
const pendingMessages = new Map();

// Add status endpoint for debugging
app.get('/api/status', (req, res) => {
  // Get list of Unity clients
  const unityClientIds = Array.from(unityReceivers.keys());

  const status = {
    clients: Array.from(clients.keys()),
    unityClients: unityClientIds,
    unityClientsCount: unityClientIds.length,
    videoSenders: Array.from(videoSenders.keys()),
    webRTCSessions: Array.from(webRTCSessions.entries()).map(([senderId, session]) => ({
      senderId,
      offerExists: !!session.offer,
      candidatesCount: session.candidates.length,
      connectedReceivers: Array.from(session.connectedReceivers || [])
    })),
    activeConnections: Array.from(activeConnections.entries()).map(([key, conn]) => ({
      pair: key,
      state: conn.state,
      lastActivity: new Date(conn.lastActivity).toISOString()
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

// Function to track connection state between peers
function trackConnection(senderId, receiverId, state) {
  const connectionKey = `${senderId}->${receiverId}`;
  
  if (!activeConnections.has(connectionKey)) {
    activeConnections.set(connectionKey, {
      senderId,
      receiverId,
      state,
      attempts: 1,
      lastActivity: Date.now()
    });
  } else {
    const connection = activeConnections.get(connectionKey);
    connection.state = state;
    connection.lastActivity = Date.now();
    
    if (state === CONNECTION_STATES.CONNECTING) {
      connection.attempts = (connection.attempts || 0) + 1;
    }
  }
  
  console.log(`Connection ${connectionKey}: ${state}`);
}

// Store WebRTC session data (offer and candidates) for a sender
function storeWebRTCSessionData(senderId, type, data) {
  if (!webRTCSessions.has(senderId)) {
    webRTCSessions.set(senderId, {
      offer: null,
      candidates: [],
      timestamp: Date.now(),
      connectedReceivers: new Set()
    });
  }
  
  const session = webRTCSessions.get(senderId);
  
  if (type === 'OFFER') {
    session.offer = data;
    session.timestamp = Date.now();
  } else if (type === 'CANDIDATE') {
    session.candidates.push(data);
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
  
  // Check if this is from a video sender
  if (videoSenders.has(senderId)) {
    // Store WebRTC session data for late joiners
    if (type === 'OFFER' || type === 'CANDIDATE') {
      storeWebRTCSessionData(senderId, type, msgContent);
      
      // If this video sender has an active session, add this receiver
      if (webRTCSessions.has(senderId) && unityReceivers.has(receiverId)) {
        const session = webRTCSessions.get(senderId);
        if (!session.connectedReceivers) {
          session.connectedReceivers = new Set();
        }
        session.connectedReceivers.add(receiverId);
      }
    }
  }
  
  // Send to specific client
  const targetClient = clients.get(receiverId);
  if (targetClient && targetClient.readyState === WebSocket.OPEN) {
    console.log(`Sending ${type} from ${senderId} to ${receiverId}`);
    targetClient.send(formattedMessage);
    
    // Track connection state updates
    if (type === 'OFFER') {
      trackConnection(senderId, receiverId, CONNECTION_STATES.CONNECTING);
    } else if (type === 'ANSWER') {
      trackConnection(senderId, receiverId, CONNECTION_STATES.CONNECTED);
    }
    
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
      
      // Limit the number of stored messages to prevent memory issues
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
        
        // If this is a Unity client, inform about existing video senders
        if (senderId.includes('Unity')) {
          console.log(`Informing Unity client ${senderId} about ${videoSenders.size} existing video senders`);
          
          videoSenders.forEach((sender, senderPeerId) => {
            if (sender.ws.readyState === WebSocket.OPEN) {
              // Send NEWPEER message from each video sender to this Unity client
              const senderAnnouncement = `NEWPEER|${senderPeerId}|${senderId}|Existing video sender|0|true`;
              ws.send(senderAnnouncement);
              
              // Get stored WebRTC session data for this sender
              const session = webRTCSessions.get(senderPeerId);
              if (session && session.offer) {
                // Deliver stored OFFER
                const offerMsg = `OFFER|${senderPeerId}|${senderId}|${session.offer}|0|true`;
                ws.send(offerMsg);
                console.log(`Sent stored OFFER from ${senderPeerId} to Unity client ${senderId}`);
                
                // Deliver stored CANDIDATES
                if (session.candidates && session.candidates.length > 0) {
                  session.candidates.forEach(candidate => {
                    const candidateMsg = `CANDIDATE|${senderPeerId}|${senderId}|${candidate}|0|true`;
                    ws.send(candidateMsg);
                  });
                  console.log(`Sent ${session.candidates.length} stored CANDIDATES from ${senderPeerId} to Unity client ${senderId}`);
                }
                
                // Add this Unity client to the sender's connected receivers
                if (!sender.connectedReceivers) {
                  sender.connectedReceivers = new Set();
                }
                sender.connectedReceivers.add(senderId);
                
                // Add this receiver to the session's connected receivers
                if (!session.connectedReceivers) {
                  session.connectedReceivers = new Set();
                }
                session.connectedReceivers.add(senderId);
                
                // Track this connection
                trackConnection(senderPeerId, senderId, CONNECTION_STATES.CONNECTING);
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
      // Handle peer-to-peer messages
      else if (receiverId && receiverId !== 'ALL') {
        handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
      }
      // Handle broadcast messages
      else if (receiverId === 'ALL') {
        // If this is from a video sender, send to all Unity receivers
        if (videoSenders.has(senderId)) {
          console.log(`Broadcasting ${type} from video sender ${senderId} to all Unity receivers`);
          
          unityReceivers.forEach((receiver, receiverId) => {
            // Create personalized message for this receiver
            const personalizedMessage = messageStr.replace(`|ALL|`, `|${receiverId}|`);
            handleDirectMessage(type, senderId, receiverId, msgContent, personalizedMessage);
          });
        } else {
          // Regular broadcast for non-video senders
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
      
      // If it was a video sender, update video senders map
      if (videoSenders.has(clientPeerId)) {
        console.log(`Video sender ${clientPeerId} disconnected`);
        
        // Keep the WebRTC session data for a while in case the sender reconnects
        setTimeout(() => {
          if (!clients.has(clientPeerId)) {
            console.log(`Removing WebRTC session data for ${clientPeerId} after timeout`);
            webRTCSessions.delete(clientPeerId);
          }
        }, 60000); // Keep for 1 minute
        
        videoSenders.delete(clientPeerId);
      }
      
      // If it was a Unity receiver, remove from unityReceivers map
      if (unityReceivers.has(clientPeerId)) {
        console.log(`Unity receiver ${clientPeerId} disconnected`);
        unityReceivers.delete(clientPeerId);
        
        // Update connected receivers lists for all video senders
        videoSenders.forEach((sender, senderId) => {
          if (sender.connectedReceivers && sender.connectedReceivers.has(clientPeerId)) {
            sender.connectedReceivers.delete(clientPeerId);
          }
          
          // Also update WebRTC sessions
          const session = webRTCSessions.get(senderId);
          if (session && session.connectedReceivers && session.connectedReceivers.has(clientPeerId)) {
            session.connectedReceivers.delete(clientPeerId);
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
  if (videoSenders.size === 0 || unityReceivers.size === 0) {
    return;
  }
  
  console.log(`Sending reminders to ${unityReceivers.size} Unity clients about ${videoSenders.size} video senders`);
  
  videoSenders.forEach((sender, senderPeerId) => {
    if (sender.ws.readyState === WebSocket.OPEN) {
      unityReceivers.forEach((receiver, receiverId) => {
        if (receiver.ws.readyState === WebSocket.OPEN) {
          // Check if we have a connection for this pair
          const connectionKey = `${senderPeerId}->${receiverId}`;
          const connection = activeConnections.get(connectionKey);
          
          // If no connection or it's in a bad state, try to reconnect
          if (!connection || 
              connection.state === CONNECTION_STATES.DISCONNECTED || 
              connection.state === CONNECTION_STATES.FAILED) {
            
            console.log(`Reestablishing connection from ${senderPeerId} to ${receiverId}`);
            
            // Send a NEWPEER reminder
            const reminderMsg = `NEWPEER|${senderPeerId}|${receiverId}|Video sender reminder|0|true`;
            receiver.ws.send(reminderMsg);
            
            // Get stored WebRTC session data for this sender
            const session = webRTCSessions.get(senderPeerId);
            if (session && session.offer) {
              // Deliver stored OFFER
              const offerMsg = `OFFER|${senderPeerId}|${receiverId}|${session.offer}|0|true`;
              receiver.ws.send(offerMsg);
              
              // Deliver stored CANDIDATES (but not all, just a few to avoid flooding)
              if (session.candidates && session.candidates.length > 0) {
                const candidatesToSend = session.candidates.slice(-5); // Just the last 5
                candidatesToSend.forEach(candidate => {
                  const candidateMsg = `CANDIDATE|${senderPeerId}|${receiverId}|${candidate}|0|true`;
                  receiver.ws.send(candidateMsg);
                });
              }
              
              // Track this reconnection attempt
              trackConnection(senderPeerId, receiverId, CONNECTION_STATES.RECONNECTING);
            }
          }
          else {
            // Just send a keepalive NEWPEER message
            const keepaliveMsg = `NEWPEER|${senderPeerId}|${receiverId}|Keepalive|0|true`;
            receiver.ws.send(keepaliveMsg);
          }
        }
      });
    }
  });
}

// Clean up inactive connections periodically
function cleanupInactiveConnections() {
  const now = Date.now();
  const inactivityThreshold = 60 * 1000; // 1 minute
  
  activeConnections.forEach((connection, key) => {
    if (now - connection.lastActivity > inactivityThreshold) {
      if (connection.state !== CONNECTION_STATES.CONNECTED) {
        console.log(`Removing inactive connection: ${key}`);
        activeConnections.delete(key);
      }
    }
  });
}

// Clean up pending messages periodically
function cleanupPendingMessages() {
  // Remove pending messages for clients that haven't connected for a while
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [clientId, messages] of pendingMessages.entries()) {
    if (!clients.has(clientId)) {
      const clientLastSeen = unityReceivers.get(clientId)?.timestamp || 0;
      if (now - clientLastSeen > staleThreshold) {
        console.log(`Cleaning up pending messages for stale client ${clientId}`);
        pendingMessages.delete(clientId);
      }
    }
  }
}

// Set up periodic tasks with appropriate intervals
setInterval(sendVideoSenderReminders, 15000); // Every 15 seconds
setInterval(cleanupInactiveConnections, 30000); // Every 30 seconds
setInterval(cleanupPendingMessages, 60000); // Every minute

// Start the server
server.listen(port, () => {
  console.log(`Enhanced WebRTC server running on port ${port}`);
});
