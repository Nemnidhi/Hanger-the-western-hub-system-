@echo off
rem Development: the worker in the background and the API (which also serves the built staff app) on :4200.
cd /d "%~dp0"
start "hanger-worker" /b node src\worker.js
rem The stand-in courier runs only when .env points the server at it (see src\scripts\fakeCourier.js).
start "hanger-fake-courier" /b node src\scripts\fakeCourier.js
node src\index.js
