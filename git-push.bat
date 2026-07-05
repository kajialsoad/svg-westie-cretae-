@echo off
:: AnimSuite Pro - Local Git Commit & Push Script for Windows
:: This script automates adding changes, committing with a message, and pushing to GitHub.

echo ===================================================
echo  🚀 Git Push Automator - AnimSuite Pro
echo ===================================================
echo.

:: Check if git is installed
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git is not installed or not in system PATH.
    pause
    exit /b
)

:: Get commit message from user
set /p commit_msg="Enter commit message (default: 'update'): "
if "%commit_msg%"=="" set commit_msg=update

:: Stage all changes
echo.
echo 📦 Staging all changes...
git add .

:: Commit changes
echo.
echo 💾 Committing changes...
git commit -m "%commit_msg%"

:: Push to remote repository
echo.
echo 📤 Pushing to GitHub...
:: Get current branch name
for /f "tokens=*" %%i in ('git branch --show-current') do set branch=%%i
git push origin %branch%

if %errorlevel% equ 0 (
    echo.
    echo 🎉 Successfully committed and pushed to GitHub on branch '%branch%'!
) else (
    echo.
    echo ❌ Push failed. Please check your internet connection or git permissions.
)

echo.
pause
