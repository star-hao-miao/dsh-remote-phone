@echo off
rem start-emulator.cmd - launch the AVD outside the caller's process tree
rem (Windows Task Scheduler owns it, so it survives the coding-agent shell).
rem All Android "home" state stays inside the workspace.

set TC=%~dp0..
set TC=%TC%\..\.toolchain
set JAVA_HOME=%TC%\jdk21
set ANDROID_HOME=%TC%\android-sdk
set ANDROID_SDK_ROOT=%TC%\android-sdk
set ANDROID_USER_HOME=%TC%\android-home
set ANDROID_SDK_HOME=%TC%\android-home
set ANDROID_AVD_HOME=%TC%\android-home\avd
set HOME=%TC%\android-home
set GRADLE_USER_HOME=%TC%\gradle-home

if not exist "%TC%\logs" mkdir "%TC%\logs"
"%TC%\android-sdk\emulator\emulator.exe" -avd dshphone -port 5554 -no-snapshot -no-boot-anim -gpu swiftshader_indirect 1> "%TC%\logs\emulator-5554.out.log" 2> "%TC%\logs\emulator-5554.err.log"
