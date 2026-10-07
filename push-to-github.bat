@echo off
cd /d "%~dp0"
echo ========================================================
echo  Deploying PDF/AI -^> PLT Batch Cutter to GitHub
echo  Repository: https://github.com/Rajaqwe/Free-converter
echo ========================================================
echo.
git push -u origin main
echo.
if %ERRORLEVEL% EQU 0 (
    echo [SUCCESS] Changes pushed to GitHub successfully!
) else (
    echo [ERROR] Git push failed. Please ensure you are logged into GitHub in your browser.
)
echo.
pause
