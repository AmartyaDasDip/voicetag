VoiceTag – Windows desktop app for football match tagging
==========================================================

কীভাবে ইনস্টলার বানাবেন (একবারই করতে হবে)
------------------------------------------
1. এই ZIP ফাইলটা আনজিপ করুন (রাইট-ক্লিক → Extract All)। যেমন Documents\VoiceTag ফোল্ডারে।
2. Node.js ইনস্টল করুন: https://nodejs.org → "LTS" → Windows Installer (.msi) → শুধু Next চাপতে থাকুন।
3. VoiceTag ফোল্ডারে BUILD.bat-এ ডাবল-ক্লিক করুন। ইন্টারনেট চালু রাখুন, ৫-১৫ মিনিট লাগবে।
4. শেষ হলে "dist" ফোল্ডার খুলবে। সেখানে VoiceTag-Setup-1.0.0.exe → ডাবল-ক্লিক করে ইনস্টল করুন।
   Windows যদি "Windows protected your PC" দেখায়: "More info" → "Run anyway"।
   (অ্যাপটা ডিজিটালি সাইন করা নয়, তাই এই সতর্কবার্তা আসে।)
5. ডেস্কটপে VoiceTag আইকন আসবে। এরপর ইন্টারনেট ছাড়াই চলবে, ভয়েসসহ।

মাইক্রোফোন কাজ না করলে: Windows Settings → Privacy & security → Microphone →
"Let desktop apps access your microphone" চালু করুন।

ইনস্টল না করে শুধু চালিয়ে দেখতে চাইলে: TRY-WITHOUT-INSTALLING.bat


How to build the installer (one time)
-------------------------------------
1. Unzip this folder (right-click → Extract All).
2. Install Node.js LTS from https://nodejs.org (just click Next).
3. Double-click BUILD.bat and wait 5-15 minutes (internet needed).
4. The "dist" folder opens with VoiceTag-Setup-1.0.0.exe – double-click to install.
   If Windows says "Windows protected your PC": More info → Run anyway (the app is not code-signed).
5. After installing, VoiceTag runs fully offline, including voice recognition.

Video formats
-------------
Any format ffmpeg can read opens: MP4, MOV, AVI, MKV, WMV, FLV, MPEG/MPG, MTS/M2TS, TS, VOB, 3GP, MXF, WEBM...
If Windows can't play a file directly, VoiceTag converts it to MP4 once (H.264 video is only re-wrapped,
which takes seconds). Converted copies are kept in %APPDATA%\VoiceTag\converted and reused next time.
Exported clips are always MP4.

What is inside
--------------
main.js / preload.js / exporter.js   desktop shell, file access, video export (ffmpeg)
renderer/                            the app screen (index.html, app.js, styles.css)
renderer/vendor/vosk.js              offline speech engine (vosk-browser, Apache-2.0)
tools/get-model.ps1                  downloads the English voice model (Vosk small en-us)
BUILD.bat                            builds the installer
TRY-WITHOUT-INSTALLING.bat           runs the app straight from this folder
