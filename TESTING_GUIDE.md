# Testing Guide for Sender & Receiver Pages

## What Was Fixed

### Issues Resolved:
1. ✅ **Connection not happening** - Sender now properly detects receivers and creates peer connections
2. ✅ **Camera start timing** - Sender now connects to receivers that joined before camera started
3. ✅ **Message sending** - Added full messaging functionality with data channels

### New Features Added:
- 📤 **Message sending from sender to all receivers**
- 📥 **Message display on receiver page**
- 🔗 **Data channel support for real-time messaging**
- 📊 **Better connection status tracking**

---

## How to Test

### Step 1: Start the Server
```bash
npm start
```
Server will run on `http://localhost:3000`

### Step 2: Open Receiver Page
1. Open browser tab: `http://localhost:3000/receiver.html`
2. You should see:
   - ✅ WebSocket: Connected
   - Peer ID assigned (e.g., `Receiver_abc123`)
   - "Waiting for video streams..." message

### Step 3: Open Sender Page
1. Open another browser tab: `http://localhost:3000/sender.html`
2. You should see:
   - ✅ WebSocket: Connected
   - Peer ID assigned (e.g., `Sender_xyz789`)
   - Log shows "Receiver [ID] joined"

### Step 4: Start Camera
1. On sender page, click **"📹 Start Camera"**
2. Allow camera permissions
3. Watch the logs:
   - Sender: "Creating peer connection for Receiver_..."
   - Sender: "Sent offer to Receiver_..."
   - Receiver: "Received OFFER from Sender_..."
   - Receiver: "Sent answer to Sender_..."
   - Both: "✅ Connected to [peer]"

### Step 5: Verify Video Stream
- Receiver page should now show the video stream
- Video should appear in a card with sender's ID label
- Stream count should update to "1"

### Step 6: Test Messaging
1. On sender page, type a message in the input field
2. Click **"📤 Send"** (or press Enter)
3. Check receiver page - message should appear in the Messages section
4. Sender log should show: "Sent message to 1 receiver(s)"

---

## Expected Behavior

### Sender Page Logs (Successful Connection):
```
[Time] WebSocket connected
[Time] Announced as video sender
[Time] Receiver_abc123 joined
[Time] Camera started
[Time] Creating peer connection for Receiver_abc123
[Time] Sent offer to Receiver_abc123
[Time] Received ANSWER from Receiver_abc123
[Time] Connection state with Receiver_abc123: connecting
[Time] Data channel opened with Receiver_abc123
[Time] Connection state with Receiver_abc123: connected
[Time] ✅ Connected to Receiver_abc123
```

### Receiver Page Logs (Successful Connection):
```
[Time] WebSocket connected
[Time] Announced as receiver
[Time] Video sender Sender_xyz789 is available
[Time] Received OFFER from Sender_xyz789
[Time] Handling offer from Sender_xyz789
[Time] Data channel received from Sender_xyz789
[Time] Sent answer to Sender_xyz789
[Time] Received track from Sender_xyz789
[Time] Added video stream from Sender_xyz789
[Time] Data channel opened with Sender_xyz789
[Time] Connection state with Sender_xyz789: connected
[Time] ✅ Connected to Sender_xyz789
```

---

## Testing Multiple Receivers

1. Open multiple receiver tabs
2. Each receiver should:
   - Get a unique ID
   - Connect independently
   - Receive the same video stream
3. Sender should show:
   - "Connected Receivers: [N]"
   - Messages sent to all receivers

---

## Troubleshooting

### Video Not Showing
- Check camera permissions
- Verify both peers show "connected" state
- Check browser console for errors

### Messages Not Sending
- Ensure "Send" button is enabled (means data channel is open)
- Check connection state is "connected"
- Verify receiver has data channel log

### Connection Stuck on "connecting"
- Check firewall settings
- Verify STUN servers are accessible
- Try refreshing both pages

---

## Production Testing (Render)

To test on your deployed server:
1. Open: `https://webrtc-9gdy.onrender.com/sender.html`
2. Open: `https://webrtc-9gdy.onrender.com/receiver.html`
3. Follow same steps as local testing

**Note:** Make sure to allow camera permissions on HTTPS

---

## Key Changes Made

### sender.html:
- Added `knownReceivers` Set to track all receivers
- Fixed NEWPEER handling to detect non-video-sender peers
- Added data channel creation in peer connections
- Added message input UI and send functionality
- Fixed camera start to connect to existing receivers
- Added Enter key support for sending messages

### receiver.html:
- Added message display UI section
- Added `ondatachannel` handler to receive data channels
- Added `displayMessage()` function for message UI
- Improved connection state logging

---

## Next Steps

- ✅ Test basic video streaming
- ✅ Test messaging functionality
- ✅ Test with multiple receivers
- 🔄 Test on production (Render)
- 🔄 Test with Unity client (if needed)
