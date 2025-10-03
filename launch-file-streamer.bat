@echo off
echo Starting WebRTC Video File Streaming Server (Local Testing Mode)
echo.

REM Define the video file path - edit this to match your video location
set VIDEO_FILE=C:\Users\ctadmin\Downloads\ServerTesting.mp4
echo Video file to stream: %VIDEO_FILE%

REM URL encode the file path
set "VIDEO_FILE_ENCODED=%VIDEO_FILE:\=/%"
set "VIDEO_FILE_ENCODED=%VIDEO_FILE_ENCODED: =%%20%"

REM Start the server
start "" node server.js

REM Wait for the server to start
timeout /t 2

REM Open the browser with the file streamer page
start "" http://localhost:3000/file-streamer.html?path=%VIDEO_FILE_ENCODED%

REM Display IP information for Unity configuration
echo.
echo ===================== IMPORTANT CONFIGURATION INFO =====================
echo Since you're running both client and server on the same machine (192.168.68.52):
echo.
echo In Unity WebRTCConnection component, set:
echo   WebSocketServerAddress: ws://localhost:3000 or ws://127.0.0.1:3000
echo   LocalPeerId: UnityVideoReceiver (or any unique name)
echo   IsVideoAudioSender: false
echo   IsVideoAudioReceiver: true
echo.
echo ====================================================================

echo.
echo Server is running. Press any key to stop the server when you're done.
pause > nul

REM Kill the Node.js server when done
taskkill /f /im node.exe
echo Server stopped.
