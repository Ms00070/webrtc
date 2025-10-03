# Unity WebRTC Video Receiver - Local Setup Guide

This guide explains how to configure the Unity client to receive a video stream from the local WebRTC file streaming server.

## Prerequisites
- Unity project with SimpleWebRTC is set up
- The signaling server is running (via launch-file-streamer.bat)
- A video file is ready to be streamed

## Unity Configuration Steps

Since both the server and Unity client are running on the same machine (IP: 192.168.68.52), follow these specific steps:

### 1. Open the Unity Scene

Open your WebRTC-MultipleClients-STUNConnection scene or any scene with a WebRTCConnection component.

### 2. Configure the WebRTCConnection Component

Select one of the client GameObjects in the scene (e.g., Red-STUNConnection) and configure the WebRTCConnection component:

```
WebSocketServerAddress: ws://localhost:3000 or ws://127.0.0.1:3000
LocalPeerId: UnityVideoReceiver (or any unique name)
IsVideoAudioSender: false
IsVideoAudioReceiver: true
WebSocketConnectionActive: ✓ (checked)
```

### 3. Ensure UI Components Are Set Up

Make sure:
- The GameObject is active
- ReceivingRawImagesParent is assigned to a valid RectTransform
- The parent Canvas is active and visible

### 4. Start the Video Stream

1. Run the launch-file-streamer.bat script
2. In the browser that opens, click "Start Streaming"
3. Run your Unity scene

### 5. Testing

- You should see connection logs in both the browser and Unity Console
- The video should appear in a RawImage within your Unity scene
- If the RawImage parent was previously inactive, it might be automatically activated when the video is received

### 6. Troubleshooting

If the video doesn't appear:
- Check Unity Console for connection messages
- Make sure both the browser streamer and Unity are connecting to the same signaling server
- Verify the RawImage container is active and visible
- Try restarting both the server and Unity client

## Next Steps

After successful local testing, to use this between separate machines:
1. Use the actual server machine's IP address instead of localhost
2. Make sure both machines are on the same network
3. Ensure firewalls allow connections on port 3000
