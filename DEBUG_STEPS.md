# Debug Steps - Connection Issue

## Current Issue
- Sender shows "Connected Receivers: 0"
- Messages cannot be sent
- Peer connection not establishing

## Testing Steps

### 1. Clear Everything and Start Fresh
1. Close all browser tabs with sender/receiver
2. Restart the server if needed: `npm start`
3. Open browser console (F12) on both tabs to see detailed logs

### 2. Open Pages in Correct Order

**Step A: Open Receiver First**
1. Go to: `http://localhost:3000/receiver.html` (or your Render URL)
2. Check Activity Log - should show:
   ```
   [Time] WebSocket connected
   [Time] Announced as receiver: NEWPEER|Receiver_xxx|ALL|Receiver joined|0|false
   ```
3. **IMPORTANT:** Note the exact message format - it should have 6 parts separated by `|`

**Step B: Open Sender Second**
1. Go to: `http://localhost:3000/sender.html`
2. Check Activity Log - should show:
   ```
   [Time] WebSocket connected
   [Time] Announced as video sender
   [Time] Received NEWPEER from Receiver_xxx (isVideoSender: false)
   [Time] ✅ Receiver Receiver_xxx joined (total: 1)
   [Time] Stream not ready, will connect when camera starts
   ```

**Step C: Start Camera**
1. Click "Start Camera" on sender
2. Allow camera permissions
3. Check logs - should show:
   ```
   [Time] Camera started
   [Time] Known receivers: 1
   [Time] Creating connections to 1 receiver(s)...
   [Time] Connecting to Receiver_xxx...
   [Time] Creating peer connection for Receiver_xxx
   [Time] Sent offer to Receiver_xxx
   ```

**Step D: Verify Connection**
1. Wait 2-3 seconds for connection to establish
2. Sender should show: "Connected Receivers: 1"
3. Receiver should show video stream
4. Both logs should show: "✅ Connected to [peer]"

### 3. What to Look For

**If receiver is NOT detected by sender:**
- Check sender log for: `Received NEWPEER from Receiver_xxx (isVideoSender: false)`
- If it says `(isVideoSender: true)` - that's the bug!
- If you don't see this message at all - WebSocket issue

**If receiver IS detected but connection fails:**
- Check for "Sent offer" message
- Check receiver for "Received OFFER" message
- Check for ICE candidate exchange
- Look for connection state changes

**If connection works but receiver count is 0:**
- Check `updateReceiverCount()` function
- Look for "Connection state: connected" messages
- Check browser console for JavaScript errors

### 4. Common Issues

**Issue: Sender says "Ignoring video sender"**
- The receiver's message has `isVideoSender: true` instead of `false`
- Check the receiver's announcement message format

**Issue: "No receivers connected yet"**
- Receiver joined AFTER sender
- Try: Open receiver, then open sender

**Issue: Connection stuck on "connecting"**
- Firewall blocking WebRTC
- STUN servers not reachable
- Try on localhost first

**Issue: "Data channel opened" never appears**
- Peer connection failed
- Check ICE candidate exchange
- Verify both peers are on same network (for local testing)

### 5. Browser Console Commands

Open browser console (F12) and try these:

**On Sender:**
```javascript
console.log('Known receivers:', knownReceivers);
console.log('Peer connections:', peerConnections);
console.log('Data channels:', dataChannels);
```

**On Receiver:**
```javascript
console.log('Peer ID:', peerId);
console.log('Peer connections:', peerConnections);
console.log('Remote streams:', remoteStreams);
```

### 6. Expected Full Flow

```
RECEIVER:
[3:00:00] WebSocket connected
[3:00:00] Announced as receiver: NEWPEER|Receiver_abc|ALL|Receiver joined|0|false

SENDER:
[3:00:05] WebSocket connected
[3:00:05] Announced as video sender
[3:00:05] Received NEWPEER from Receiver_abc (isVideoSender: false)
[3:00:05] ✅ Receiver Receiver_abc joined (total: 1)
[3:00:05] Stream not ready, will connect when camera starts

SENDER (after clicking Start Camera):
[3:00:10] Camera started
[3:00:10] Known receivers: 1
[3:00:10] Creating connections to 1 receiver(s)...
[3:00:10] Connecting to Receiver_abc...
[3:00:10] Creating peer connection for Receiver_abc
[3:00:10] Sent offer to Receiver_abc

RECEIVER:
[3:00:10] Received OFFER from Sender_xyz (isVideoSender: true)
[3:00:10] Handling offer from Sender_xyz
[3:00:10] Data channel received from Sender_xyz
[3:00:10] Sent answer to Sender_xyz

SENDER:
[3:00:11] Received ANSWER from Receiver_abc
[3:00:11] Set remote description from Receiver_abc
[3:00:11] Connection state with Receiver_abc: connecting
[3:00:12] Data channel opened with Receiver_abc
[3:00:12] Connection state with Receiver_abc: connected
[3:00:12] ✅ Connected to Receiver_abc

RECEIVER:
[3:00:12] Received track from Sender_xyz
[3:00:12] Added video stream from Sender_xyz
[3:00:12] Data channel opened with Sender_xyz
[3:00:12] Connection state with Sender_xyz: connected
[3:00:12] ✅ Connected to Sender_xyz
```

### 7. Next Steps

After following these steps, report back with:
1. The exact log messages you see
2. At which step it fails
3. Any error messages in browser console
4. Whether you're testing locally or on Render

This will help identify the exact issue!
