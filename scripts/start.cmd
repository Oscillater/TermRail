@echo off
rem TermRail portable launcher.
rem - Runs the bundled server in this console window; closing the window stops TermRail.
rem - The UI opens in the default browser once the server is ready.
rem - Override the port before launching:  set TERMRAIL_PORT=9000
setlocal
set "ROOT=%~dp0"
if defined TERMRAIL_PORT set "PORT=%TERMRAIL_PORT%"
set "TERMRAIL_OPEN=1"
"%ROOT%node.exe" "%ROOT%server\dist\index.js"
