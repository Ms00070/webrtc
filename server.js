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
  
  res.json({
    ready: videoSendersCount > 0,
    videoSenders: Array.from(videoSenders.keys()),
    unityReceivers: Array.from(unityReceivers.keys()),
    webClients: Array.from(webClients.keys()),
    message: videoSendersCount > 0 ? 
      `Server ready with ${videoSendersCount} video senders and ${unityReceiversCount} Unity receivers` : 
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
  RECONNECTION_REMINDER_INTERVAL: 15000 // 15 seconds
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
          
          // Connect this Unity receiver to all existing video senders
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
      // Handle peer-to-peer messages with SFU logic
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

// SFU Logic: Connect Unity receiver to all video senders
function connectUnityReceiverToVideoSenders(receiverId) {
  console.log(`Connecting Unity receiver ${receiverId} to video senders`);
  
  videoSenders.forEach((sender, senderId) => {
    if (sender.ws.readyState === WebSocket.OPEN) {
      // Send NEWPEER from video sender to Unity receiver
      const connectionMsg = `NEWPEER|${senderId}|${receiverId}|Video sender connection|0|true`;
      const receiverClient = unityReceivers.get(receiverId);
      if (receiverClient && receiverClient.ws.readyState === WebSocket.OPEN) {
        receiverClient.ws.send(connectionMsg);
        console.log(`Connected video sender ${senderId} to Unity receiver ${receiverId}`);
        
        // Track the connection
        sender.connectedReceivers.add(receiverId);
        receiverClient.connectedSenders.add(senderId);
        
        // Track active connection
        const connectionKey = `${senderId}->${receiverId}`;
        activeConnections.set(connectionKey, {
          state: CONNECTION_STATES.CONNECTING,
          lastActivity: Date.now()
        });
      }
    }
  });
}

// Handle direct messages with SFU forwarding
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
  }
  
  if (unityReceivers.has(clientId)) {
    const receiver = unityReceivers.get(clientId);
    // Notify connected senders about receiver disconnection
    receiver.connectedSenders.forEach(senderId => {
      if (videoSenders.has(senderId)) {
        videoSenders.get(senderId).connectedReceivers.delete(clientId);
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

// Periodic connection health check and reconnection assistance
function performHealthCheck() {
  const now = Date.now();
  
  // Check for stale connections
  for (const [connectionKey, connection] of activeConnections.entries()) {
    if (now - connection.lastActivity > CONFIG.CONNECTION_TIMEOUT) {
      console.log(`Connection ${connectionKey} appears stale, marking as failed`);
      connection.state = CONNECTION_STATES.FAILED;
      
      // Try to re-establish connection
      const [senderId, receiverId] = connectionKey.split('->');
      if (clients.has(senderId) && clients.has(receiverId)) {
        console.log(`Attempting to re-establish connection between ${senderId} and ${receiverId}`);
        const reconnectMsg = `NEWPEER|${senderId}|${receiverId}|Reconnection attempt|0|true`;
        const receiverClient = clients.get(receiverId);
        if (receiverClient && receiverClient.ws.readyState === WebSocket.OPEN) {
          receiverClient.ws.send(reconnectMsg);
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
  const now = Date.now();
  for (const [clientId, messages] of pendingMessages.entries()) {
    // Remove pending messages for clients that haven't connected in a while
    if (!clients.has(clientId)) {
      console.log(`Cleaning up ${messages.length} pending messages for inactive client ${clientId}`);
      pendingMessages.delete(clientId);
    }
  }
}

// Enhanced connection reminders for Unity clients
function sendConnectionReminders() {
  // Only send reminders if we have video senders and Unity receivers
  if (videoSenders.size > 0 && unityReceivers.size > 0) {
    console.log(`Sending connection reminders: ${videoSenders.size} senders, ${unityReceivers.size} receivers`);
    
    videoSenders.forEach((sender, senderId) => {
      if (sender.ws.readyState === WebSocket.OPEN) {
        unityReceivers.forEach((receiver, receiverId) => {
          if (receiver.ws.readyState === WebSocket.OPEN) {
            // Check if they're already connected
            const connectionKey = `${senderId}->${receiverId}`;
            const connection = activeConnections.get(connectionKey);
            
            if (!connection || connection.state === CONNECTION_STATES.FAILED) {
              const reminderMsg = `NEWPEER|${senderId}|${receiverId}|Connection reminder|0|true`;
              receiver.ws.send(reminderMsg);
              console.log(`Sent connection reminder: ${senderId} -> ${receiverId}`);
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
setInterval(sendConnectionReminders, CONFIG.RECONNECTION_REMINDER_INTERVAL);

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
  console.log(`Features: SFU pattern, multi-client support, connection health monitoring`);
});
