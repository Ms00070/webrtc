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

// Enhanced status endpoint for debugging
app.get('/api/status', (req, res) => {
  const status = {
    clients: Array.from(clients.keys()),
    videoSenders: Array.from(videoSenders.keys()),
    unityReceivers: Array.from(unityReceivers.keys()),
    webClients: Array.from(webClients.keys()),
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
    ),
    activeSessions: Object.fromEntries(
      Array.from(activeWebRTCSessions.entries()).map(([key, session]) => [
        key,
        {
          hasOffer: !!session.offer,
          candidatesCount: session.candidates.length,
          connectedReceivers: session.connectedReceivers.size
        }
      ])
    ),
    connections: Array.from(activeConnections.entries()).map(([key, conn]) => ({
      pair: key,
      state: conn.state,
      lastActivity: new Date(conn.lastActivity).toISOString()
    }))
  };
  
  res.json(status);
});

// Enhanced ready endpoint
app.get('/api/ready', (req, res) => {
  const videoSendersCount = videoSenders.size;
  const unityReceiversCount = unityReceivers.size;
  const activeSessions = activeWebRTCSessions.size;
  
  res.json({
    ready: videoSendersCount > 0,
    videoSenders: Array.from(videoSenders.keys()),
    unityReceivers: Array.from(unityReceivers.keys()),
    webClients: Array.from(webClients.keys()),
    activeSessions: activeSessions,
    message: videoSendersCount > 0 ? 
      `Server ready with ${videoSendersCount} video senders, ${unityReceiversCount} Unity receivers, ${activeSessions} active sessions` : 
      'Server running but no video senders connected yet'
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Enhanced client management
const clients = new Map(); // All connected clients
const videoSenders = new Map(); // Web clients that send video
const unityReceivers = new Map(); // Unity clients that receive video
const webClients = new Map(); // All web clients
const pendingMessages = new Map(); // Messages waiting for clients
const activeConnections = new Map(); // Track active P2P connections
const activeWebRTCSessions = new Map(); // Track WebRTC session data for late-joining

// Connection state tracking
const CONNECTION_STATES = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed'
};

// Configuration
const CONFIG = {
  MAX_PENDING_MESSAGES: 50,
  PENDING_MESSAGE_CLEANUP_INTERVAL: 30000, // 30 seconds
  CONNECTION_TIMEOUT: 60000, // 1 minute
  HEARTBEAT_INTERVAL: 30000, // 30 seconds
  RECONNECTION_REMINDER_INTERVAL: 10000, // 10 seconds (more frequent)
  LATE_JOIN_RETRY_INTERVAL: 5000 // 5 seconds for late-joining clients
};

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  let clientPeerId = null;
  let clientType = null;
  let lastHeartbeat = Date.now();
  
  // Send heartbeat
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, CONFIG.HEARTBEAT_INTERVAL);
  
  ws.on('pong', () => {
    lastHeartbeat = Date.now();
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
      
      // Register client when it announces itself
      if (type === 'NEWPEER') {
        clientPeerId = senderId;
        clients.set(senderId, {
          ws: ws,
          type: isVideoAudioSender === 'true' ? 'video_sender' : 'unity_receiver',
          lastActivity: Date.now(),
          connectionCount: parseInt(connectionCount) || 0
        });
        
        // Categorize clients
        const isVideoSender = isVideoAudioSender === 'true';
        const isUnityClient = senderId.includes('Unity') || senderId.includes('unity');
        
        if (isVideoSender) {
          console.log(`Video sender registered: ${senderId}`);
          videoSenders.set(senderId, { 
            ws, 
            timestamp: Date.now(),
            connectedReceivers: new Set()
          });
          
          // Initialize WebRTC session tracking for this sender
          if (!activeWebRTCSessions.has(senderId)) {
            activeWebRTCSessions.set(senderId, {
              offer: null,
              candidates: [],
              connectedReceivers: new Set(),
              lastOfferTime: Date.now()
            });
          }
          
          if (!isUnityClient) {
            webClients.set(senderId, { ws, timestamp: Date.now() });
          }
          
          // Immediately connect this sender to all existing Unity receivers
          connectVideoSenderToUnityReceivers(senderId);
          
        } else if (isUnityClient) {
          console.log(`Unity receiver registered: ${senderId}`);
          unityReceivers.set(senderId, { 
            ws, 
            timestamp: Date.now(),
            connectedSenders: new Set()
          });
          
          // CRITICAL: Connect this Unity receiver to all existing video senders
          // This handles the late-joining scenario
          connectUnityReceiverToVideoSenders(senderId);
          
        } else {
          webClients.set(senderId, { ws, timestamp: Date.now() });
        }
        
        clientType = clients.get(senderId).type;
        
        // Broadcast NEWPEER to all other clients
        broadcastMessage(messageStr, ws);
        
        // Send pending messages for this client
        deliverPendingMessages(senderId);
      } 
      // Handle peer-to-peer messages with session tracking
      else if (receiverId && receiverId !== 'ALL') {
        handleDirectMessage(type, senderId, receiverId, msgContent, messageStr);
      }
      // Handle broadcast messages
      else if (receiverId === 'ALL') {
        broadcastMessage(messageStr, ws);
      }
      
      // Update last activity
      if (clientPeerId && clients.has(clientPeerId)) {
        clients.get(clientPeerId).lastActivity = Date.now();
      }
      
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });
  
  // Handle client disconnections
  ws.on('close', () => {
    clearInterval(heartbeatInterval);
    
    if (clientPeerId) {
      console.log(`Client ${clientPeerId} disconnected`);
      
      // Clean up all references
      cleanupClient(clientPeerId);
      
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
    if (clientPeerId) {
      cleanupClient(clientPeerId);
    }
  });
});

// SFU Logic: Connect video sender to all Unity receivers
function connectVideoSenderToUnityReceivers(senderId) {
  console.log(`Connecting video sender ${senderId} to Unity receivers`);
  
  unityReceivers.forEach((receiver, receiverId) => {
    if (receiver.ws.readyState === WebSocket.OPEN) {
      // Send NEWPEER from video sender to Unity receiver
      const connectionMsg = `NEWPEER|${senderId}|${receiverId}|Video sender connection|0|true`;
      receiver.ws.send(connectionMsg);
      console.log(`Connected video sender ${senderId} to Unity receiver ${receiverId}`);
      
      // Track the connection
      if (videoSenders.has(senderId)) {
        videoSenders.get(senderId).connectedReceivers.add(receiverId);
      }
      if (unityReceivers.has(receiverId)) {
        unityReceivers.get(receiverId).connectedSenders.add(senderId);
      }
      
      // Track active connection
      const connectionKey = `${senderId}->${receiverId}`;
      activeConnections.set(connectionKey, {
        state: CONNECTION_STATES.CONNECTING,
        lastActivity: Date.now()
      });
    }
  });
}

// Enhanced SFU Logic: Connect Unity receiver to all video senders with session replay
function connectUnityReceiverToVideoSenders(receiverId) {
  console.log(`Connecting Unity receiver ${receiverId} to video senders (handling late-join)`);
  
  videoSenders.forEach((sender, senderId) => {
    if (sender.ws.readyState === WebSocket.OPEN) {
      console.log(`Processing connection: ${senderId} -> ${receiverId}`);
      
      // Send NEWPEER from video sender to Unity receiver
      const connectionMsg = `NEWPEER|${senderId}|${receiverId}|Video sender connection|0|true`;
      const receiverClient = unityReceivers.get(receiverId);
      if (receiverClient && receiverClient.ws.readyState === WebSocket.OPEN) {
        receiverClient.ws.send(connectionMsg);
        console.log(`Sent NEWPEER: ${senderId} -> ${receiverId}`);
        
        // Track the connection
        sender.connectedReceivers.add(receiverId);
        receiverClient.connectedSenders.add(senderId);
        
        // Track active connection
        const connectionKey = `${senderId}->${receiverId}`;
        activeConnections.set(connectionKey, {
          state: CONNECTION_STATES.CONNECTING,
          lastActivity: Date.now()
        });
        
        // CRITICAL: Replay existing WebRTC session data for late-joining Unity client
        replayWebRTCSessionForLateJoiner(senderId, receiverId);
      }
    }
  });
}

// NEW: Replay WebRTC session data for late-joining clients
function replayWebRTCSessionForLateJoiner(senderId, receiverId) {
  const session = activeWebRTCSessions.get(senderId);
  if (!session) {
    console.log(`No active session found for sender ${senderId}`);
    return;
  }
  
  const receiverClient = unityReceivers.get(receiverId);
  if (!receiverClient || receiverClient.ws.readyState !== WebSocket.OPEN) {
    console.log(`Receiver ${receiverId} not available for session replay`);
    return;
  }
  
  console.log(`Replaying WebRTC session from ${senderId} to late-joining ${receiverId}`);
  
  // Add a small delay to ensure NEWPEER is processed first
  setTimeout(() => {
    // Replay the offer if available
    if (session.offer) {
      const offerMsg = `OFFER|${senderId}|${receiverId}|${session.offer}|0|true`;
      receiverClient.ws.send(offerMsg);
      console.log(`Replayed OFFER: ${senderId} -> ${receiverId}`);
    }
    
    // Replay ICE candidates with small delays
    session.candidates.forEach((candidate, index) => {
      setTimeout(() => {
        const candidateMsg = `CANDIDATE|${senderId}|${receiverId}|${candidate}|0|true`;
        receiverClient.ws.send(candidateMsg);
        console.log(`Replayed CANDIDATE ${index + 1}/${session.candidates.length}: ${senderId} -> ${receiverId}`);
      }, index * 100); // 100ms delay between candidates
    });
    
    // Mark this receiver as connected to the session
    session.connectedReceivers.add(receiverId);
    
  }, 500); // 500ms delay before starting replay
}

// Enhanced direct message handling with session tracking
function handleDirectMessage(type, senderId, receiverId, msgContent, completeMessage) {
  // Ensure message has complete format
  let formattedMessage = completeMessage;
  const parts = completeMessage.split('|');
  if (parts.length < 6) {
    while (parts.length < 4) {
      parts.push('');
    }
    if (parts.length === 4) parts.push('0');
    if (parts.length === 5) parts.push('false');
    formattedMessage = parts.join('|');
  }
  
  // Track WebRTC session data for video senders
  if (videoSenders.has(senderId)) {
    const session = activeWebRTCSessions.get(senderId);
    if (session) {
      if (type === 'OFFER') {
        session.offer = msgContent;
        session.lastOfferTime = Date.now();
        console.log(`Stored OFFER from video sender ${senderId}`);
      } else if (type === 'CANDIDATE') {
        session.candidates.push(msgContent);
        // Keep only the last 20 candidates to prevent memory bloat
        if (session.candidates.length > 20) {
          session.candidates = session.candidates.slice(-20);
        }
        console.log(`Stored CANDIDATE from video sender ${senderId} (total: ${session.candidates.length})`);
      }
    }
  }
  
  // Update connection state
  const connectionKey = `${senderId}->${receiverId}`;
  if (activeConnections.has(connectionKey)) {
    const connection = activeConnections.get(connectionKey);
    connection.lastActivity = Date.now();
    
    if (type === 'OFFER') {
      connection.state = CONNECTION_STATES.CONNECTING;
    } else if (type === 'ANSWER') {
      connection.state = CONNECTION_STATES.CONNECTED;
    }
  }
  
  // Send to specific client
  const targetClient = clients.get(receiverId);
  if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
    console.log(`Forwarding ${type} from ${senderId} to ${receiverId}`);
    targetClient.ws.send(formattedMessage);
  } else {
    console.log(`Target client ${receiverId} not found or not connected - storing message`);
    
    // Store important messages for later delivery
    if (type === 'OFFER' || type === 'CANDIDATE') {
      storePendingMessage(receiverId, formattedMessage);
    }
  }
}

// Store pending messages with cleanup
function storePendingMessage(receiverId, message) {
  if (!pendingMessages.has(receiverId)) {
    pendingMessages.set(receiverId, []);
  }
  
  const messages = pendingMessages.get(receiverId);
  messages.push(message);
  
  // Cleanup old messages
  if (messages.length > CONFIG.MAX_PENDING_MESSAGES) {
    const offers = messages.filter(msg => msg.startsWith('OFFER'));
    const candidates = messages.filter(msg => msg.startsWith('CANDIDATE')).slice(-20);
    pendingMessages.set(receiverId, [...offers.slice(-1), ...candidates]);
  }
  
  console.log(`Stored pending message for ${receiverId} (total: ${pendingMessages.get(receiverId).length})`);
}

// Deliver pending messages to newly connected client
function deliverPendingMessages(clientId) {
  if (pendingMessages.has(clientId)) {
    const messages = pendingMessages.get(clientId);
    const client = clients.get(clientId);
    
    if (client && client.ws.readyState === WebSocket.OPEN) {
      console.log(`Delivering ${messages.length} pending messages to ${clientId}`);
      messages.forEach(message => {
        client.ws.send(message);
      });
      pendingMessages.delete(clientId);
    }
  }
}

// Clean up client references
function cleanupClient(clientId) {
  // Remove from all maps
  clients.delete(clientId);
  
  if (videoSenders.has(clientId)) {
    const sender = videoSenders.get(clientId);
    // Notify connected receivers about sender disconnection
    sender.connectedReceivers.forEach(receiverId => {
      if (unityReceivers.has(receiverId)) {
        unityReceivers.get(receiverId).connectedSenders.delete(clientId);
      }
    });
    videoSenders.delete(clientId);
    
    // Clean up WebRTC session data
    activeWebRTCSessions.delete(clientId);
  }
  
  if (unityReceivers.has(clientId)) {
    const receiver = unityReceivers.get(clientId);
    // Notify connected senders about receiver disconnection
    receiver.connectedSenders.forEach(senderId => {
      if (videoSenders.has(senderId)) {
        videoSenders.get(senderId).connectedReceivers.delete(clientId);
      }
      // Remove from session tracking
      if (activeWebRTCSessions.has(senderId)) {
        activeWebRTCSessions.get(senderId).connectedReceivers.delete(clientId);
      }
    });
    unityReceivers.delete(clientId);
  }
  
  webClients.delete(clientId);
  pendingMessages.delete(clientId);
  
  // Clean up active connections
  for (const [connectionKey, connection] of activeConnections.entries()) {
    if (connectionKey.includes(clientId)) {
      activeConnections.delete(connectionKey);
    }
  }
}

// Enhanced broadcast function
function broadcastMessage(message, excludeClient) {
  const parts = message.split('|');
  if (parts.length < 6) {
    while (parts.length < 4) {
      parts.push('');
    }
    if (parts.length === 4) parts.push('0');
    if (parts.length === 5) parts.push('false');
    message = parts.join('|');
  }
  
  wss.clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Enhanced connection health check and reconnection assistance
function performHealthCheck() {
  const now = Date.now();
  
  // Check for stale connections
  for (const [connectionKey, connection] of activeConnections.entries()) {
    if (now - connection.lastActivity > CONFIG.CONNECTION_TIMEOUT) {
      console.log(`Connection ${connectionKey} appears stale, attempting recovery`);
      connection.state = CONNECTION_STATES.FAILED;
      
      // Try to re-establish connection
      const [senderId, receiverId] = connectionKey.split('->');
      if (clients.has(senderId) && clients.has(receiverId)) {
        console.log(`Re-establishing connection between ${senderId} and ${receiverId}`);
        
        // If it's a video sender to Unity receiver connection, replay the session
        if (videoSenders.has(senderId) && unityReceivers.has(receiverId)) {
          replayWebRTCSessionForLateJoiner(senderId, receiverId);
        }
      }
    }
  }
  
  // Clean up disconnected clients
  for (const [clientId, client] of clients.entries()) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      console.log(`Cleaning up disconnected client: ${clientId}`);
      cleanupClient(clientId);
    }
  }
}

// Periodic cleanup of pending messages
function cleanupPendingMessages() {
  for (const [clientId, messages] of pendingMessages.entries()) {
    // Remove pending messages for clients that haven't connected in a while
    if (!clients.has(clientId)) {
      console.log(`Cleaning up ${messages.length} pending messages for inactive client ${clientId}`);
      pendingMessages.delete(clientId);
    }
  }
}

// Enhanced connection assistance for Unity clients
function assistUnityConnections() {
  // Help Unity receivers that might have missed connections
  if (videoSenders.size > 0 && unityReceivers.size > 0) {
    console.log(`Assisting Unity connections: ${videoSenders.size} senders, ${unityReceivers.size} receivers`);
    
    unityReceivers.forEach((receiver, receiverId) => {
      if (receiver.ws.readyState === WebSocket.OPEN) {
        videoSenders.forEach((sender, senderId) => {
          if (sender.ws.readyState === WebSocket.OPEN) {
            const connectionKey = `${senderId}->${receiverId}`;
            const connection = activeConnections.get(connectionKey);
            
            // If no connection exists or it's failed, try to establish/re-establish
            if (!connection || connection.state === CONNECTION_STATES.FAILED) {
              console.log(`Assisting connection: ${senderId} -> ${receiverId}`);
              
              // Send connection reminder
              const reminderMsg = `NEWPEER|${senderId}|${receiverId}|Connection assistance|0|true`;
              receiver.ws.send(reminderMsg);
              
              // Replay session data after a short delay
              setTimeout(() => {
                replayWebRTCSessionForLateJoiner(senderId, receiverId);
              }, 1000);
            }
          }
        });
      }
    });
  }
}

// Set up periodic tasks
setInterval(performHealthCheck, CONFIG.HEARTBEAT_INTERVAL);
setInterval(cleanupPendingMessages, CONFIG.PENDING_MESSAGE_CLEANUP_INTERVAL);
setInterval(assistUnityConnections, CONFIG.RECONNECTION_REMINDER_INTERVAL);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  
  // Notify all clients about server shutdown
  const shutdownMsg = 'DISPOSE|SERVER|ALL|Server shutting down|0|false';
  broadcastMessage(shutdownMsg, null);
  
  // Close all connections
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });
  
  server.close(() => {
    console.log('Server shut down gracefully');
    process.exit(0);
  });
});

// Start the server
server.listen(port, () => {
  console.log(`Enhanced WebRTC Signaling Server running on port ${port}`);
  console.log(`Features: SFU pattern, multi-client support, late-join handling, session replay`);
});
