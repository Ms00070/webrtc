# WebRTC Signaling Server for Unity

This is a simple WebRTC signaling server that's compatible with the SimpleWebRTC Unity project.

## Features

- WebSocket-based signaling server
- Compatible with SimpleWebRTC Unity project
- Includes a web-based test client
- Easy to deploy locally or to a hosting service

## Getting Started

### Prerequisites

- Node.js (version 14 or higher)
- npm (usually comes with Node.js)

### Installation

1. Clone or download this repository
2. Open a terminal in the project directory
3. Install dependencies:

```bash
npm install
```

### Running the server locally

```bash
npm start
```

This will start the server on port 3000 (or whatever port you set in the PORT environment variable).

### Accessing the test client

Open a web browser and navigate to:
```
http://localhost:3000
```

## Using with Unity SimpleWebRTC

1. Open your Unity project
2. Select your WebRTCConnection GameObject in the hierarchy
3. In the Inspector, change the WebSocketServerAddress to:
   - For local testing: `ws://localhost:3000`
   - If deployed: The WebSocket URL of your deployed server
4. Make sure other settings are configured properly:
   - `IsVideoAudioSender` and `IsVideoAudioReceiver` based on your needs
   - `StunServerAddress` can remain as the default Google STUN server
   - Set a unique `LocalPeerId`

## Deploying to a hosting service

This server can be deployed to services like Heroku, Render, or any other Node.js hosting platform.

### Example: Deploying to Render

1. Create an account on render.com
2. Create a new Web Service
3. Link to your GitHub repository or upload this code
4. Select Node.js as the runtime
5. Set the build command to `npm install`
6. Set the start command to `node server.js`
7. Deploy the service

After deployment, you'll get a URL like `https://your-app-name.onrender.com`. Update your Unity WebSocketServerAddress to use this URL with the WebSocket protocol: `wss://your-app-name.onrender.com`

## Protocol Details

The signaling server uses a simple message format:

```
TYPE|SENDER_ID|RECEIVER_ID|MESSAGE|CONNECTION_COUNT|IS_VIDEO_AUDIO_SENDER
```

Where:
- TYPE: Message type (e.g., NEWPEER, OFFER, ANSWER, CANDIDATE)
- SENDER_ID: ID of the sending peer
- RECEIVER_ID: ID of the receiving peer (or ALL for broadcast)
- MESSAGE: The message content (often JSON)
- CONNECTION_COUNT: Number of connections (optional)
- IS_VIDEO_AUDIO_SENDER: Whether the peer sends video/audio (optional)

## License

This project is provided as-is with no warranties.
