@echo off
rem Development: the worker in the background and the API (which also serves the built staff app) on :4200.
cd /d "%~dp0"
start "hanger-worker" /b node src\worker.js
node src\index.js
