# En-GYM

Independent practice for the TOEFL iBT® test on Windows. Take timed mock tests, record speaking answers, review your results and build a vocabulary collection from your practice.

## Start practicing

1. [Download ZIP](https://github.com/petrovortex/En-GYM/archive/refs/heads/main.zip). Right-click the downloaded file and choose **Extract All**.
2. Open the extracted folder and double-click **Start En-GYM.cmd**. Stay connected during the first launch while it downloads what the app needs. If Windows asks to install the Microsoft Visual C++ Runtime, allow it to finish.
3. The app opens in your browser. Choose **Settings → Microphone and sound → Check microphone** and allow microphone access.
4. Choose **Try Listen and Repeat** for a first speaking exercise. Find your answer and its recording in **History**.

Use Windows 10 or 11 on an Intel or AMD 64-bit PC, with a current Edge or Chrome browser. The launcher downloads its own Node.js and speech tools. You do not need to install Node.js, npm or Python. It checks for the built-in Windows PowerShell, curl.exe and tar.exe and tells you if one is missing.

Keep the launcher window open while using En-GYM. Closing it stops the app and background preparation. Open **Start En-GYM.cmd** again whenever you want to practice.

## Update an existing copy

1. Finish your practice and close the launcher window.
2. Download and extract the latest ZIP using the link above. Copy the contents of the extracted folder into your existing app folder and choose **Replace the files in the destination**.
3. Open **Start En-GYM.cmd**. It installs any changed dependencies and rebuilds the interface automatically.

Your history, recordings, vocabulary and settings are stored in your Windows user profile. Keep the existing app folder's `.work` directory to reuse downloaded speech tools and the runtime.

If you cloned the repository with Git, run `git pull --ff-only origin main` in the app folder instead of copying ZIP files, then open the launcher.

## While you practice

- **Practice** offers full mocks, sections and individual task types. Prepared exercises and recordings work offline.
- **History** opens the report for a completed attempt. Select a response to see the question, answer and recording. **Grade writing** and **Grade speaking** evaluate submitted work. **Discuss results** opens a conversation about the whole attempt.
- **Vocabulary** keeps words with their original sentences. Try a word game or choose several words and ask for a reading passage.

Connect an AI provider in **Settings** for grading, chat and new exercises. These features use the provider’s allowance or API billing. Speech synthesis and transcription run on your PC. Your recordings stay in your Windows profile. Practice scores are estimates.

[Developer and release instructions](docs/development.md)

TOEFL iBT is a registered trademark of ETS. En-GYM is independent and is not endorsed by ETS.
