@echo off
title GPA Buddy Quiz Agent (localhost:8788)
cd /d %~dp0

if not exist .venv\Scripts\python.exe (
    echo [ERROR] .venv not found. Run: python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
    pause
    exit /b 1
)

set GOOGLE_GENAI_USE_VERTEXAI=true
set GOOGLE_CLOUD_PROJECT=gpa-490510
set GOOGLE_CLOUD_LOCATION=global
set QUIZ_AGENT_SEED_QUIZ=seed_quiz.json

echo Starting quiz agent server on http://localhost:8788 ...
echo Seed quiz loaded. Close this window to stop the server.
echo.

rem open the frontend in the browser after 3s (wait for server startup)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8788"

.venv\Scripts\python.exe server.py
pause
