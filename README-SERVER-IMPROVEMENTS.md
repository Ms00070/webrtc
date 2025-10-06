# WebRTC Server Improvements

This document outlines the improvements made to the WebRTC server to better handle Unity clients connecting after the server has already started.

## Key Improvements

1. **Pending Message Storage**
   - The server now stores OFFER and CANDIDATE messages for clients that haven't connected yet
   - These messages are delivered when the client connects, ensuring proper connection initialization

2. **Video Sender Tracking**
   - The server keeps track of which clients are video senders
   - When a new client connects, it's informed about existing video senders
   - This helps Unity clients connect to already running video sources

3. **Periodic Reminders**
   - The server sends periodic reminders to Unity clients about video senders
   - This helps ensure connections are maintained and video keeps streaming

4. **API Endpoints**
   - `/api/status` - Shows current connected clients and pending messages
   - `/api/ready` - Unity clients can check if video senders are available before connecting

## How to Use

### Running the Server

1. Start the server as usual with `node server.js`
2. Server will listen on port 3000 by default (or the `PORT` environment variable)

### Using the Video File Streamer

1. Open http://localhost:3000/file-streamer.html in your browser
2. Load a video file and click "Start Streaming"
3. The server will register this client as a video sender

### Connecting Unity Clients

Unity clients now have three options for connecting:

1. **Using the ServerReadinessChecker** (recommended)
   - Add the ServerReadinessChecker component to your Unity scene
   - It will check if the server has video senders before connecting
   - It will handle the connection process automatically

2. **Using the WebRTCManagerPatcher**
   - Add the WebRTCManagerPatcher component to your Unity scene
   - It patches the WebRTCManager to avoid common issues
   - It handles KeyNotFoundException errors and ensures proper video display

3. **Manual Connection**
   - Use the standard WebRTCConnection component
   - Set WebRTCConnectionActive and WebSocketConnectionActive to true
   - Set IsVideoAudioReceiver to true

## API Reference

### GET /api/status

Returns the current server status including:
- List of connected clients
- List of video senders
- Pending messages for each client

Example response:
```json
{
  "clients": ["WebClient-User1", "UnityClient-1234"],
  "videoSenders": ["WebClient-User1"],
  "pendingMessages": {
    "UnityClient-5678": {
      "count": 10,
      "types": {
        "OFFER": 1,
        "CANDIDATE": 9
      }
    }
  }
}
```

### GET /api/ready

Checks if the server has any video senders connected and is ready for Unity clients.

Example response:
```json
{
  "ready": true,
  "videoSenders": ["WebClient-User1"],
  "message": "Server ready with 1 video senders"
}
```

## Troubleshooting

1. **Unity client doesn't connect**
   - Check server status at http://localhost:3000/api/status
   - Ensure at least one video sender is connected
   - Make sure Unity client is using the correct server URL

2. **No video appears**
   - Check if the video sender is connected
   - Verify that the Unity client has a RawImage component for display
   - Use the WebRTCManagerPatcher to ensure video tracks are properly handled

3. **Connection errors**
   - Ensure WebSocket server is accessible
   - Check browser console or Unity logs for error messages
   - Verify that ICE candidates are being exchanged properly
