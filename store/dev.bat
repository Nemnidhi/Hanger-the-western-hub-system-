@echo off
cd /d %~dp0
set HANGER_API_URL=http://localhost:4200
set SITE_URL=http://localhost:4300
npx next dev -p 4300
