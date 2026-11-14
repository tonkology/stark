# STARK

Smart Technologies, Automation & Robotics at King Abdulaziz University.
Engineering that moves · هندسة تتحرّك

Live site: https://tonkology.github.io/stark/

Single-page site: `index.html` (three.js r128 from cdnjs). Share image: `og.png`.

## STARK platform (internal)

- `platform/`: the team platform, served by Firebase Hosting at https://stark-91dfe.web.app (Google sign-in).
- `relay/functions/`: the Ask STARK relay (Cloud Function that holds the Claude API key).
- `firestore.rules`: who can read and change platform data.
- Every push to `main` that touches these deploys automatically (`.github/workflows/deploy-platform.yml`).
