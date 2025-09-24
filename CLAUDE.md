# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Start development server**: `npm run dev` (uses nodemon for auto-restart)
- **Start production server**: `npm start`
- **Install dependencies**: `npm install`

## Architecture Overview

This is a Node.js/Express AI productivity agent that handles calendar appointments and email through natural language conversation. The application consists of:

### Core Components

**Server Structure:**
- `server/server.js` - Main Express server with chat endpoint and OAuth routes
- `server/services/intentHandler.js` - NLP service using OpenAI + fallback local parsing
- `server/services/gmailService.js` - Gmail API integration for sending emails
- `server/services/calendarService.js` - Google Calendar API integration
- `server/models/database.js` - SQLite database initialization and connection
- `server/utils/googleAuth.js` - Google OAuth 2.0 authentication utilities
- `public/index.html` - Frontend chat interface

### Database Schema

SQLite database with tables for:
- `users` - User email and ID mapping
- `appointments` - Calendar bookings with Google Calendar integration
- `sessions` - Conversation state persistence
- `email_logs` - Email sending history

### Session Management

The application maintains stateful conversations through:
- Session persistence in SQLite with JSON state storage
- Active bookings tracking with confirmation workflow
- Multi-step intent handling (book → collect details → confirm → execute)

### Intent Processing

Two-tier intent recognition:
1. **OpenAI GPT-4o-mini** (primary) - Structured JSON extraction for complex queries
2. **Local regex parser** (fallback) - Rule-based parsing when OpenAI unavailable

Supported intents: `book`, `cancel`, `reschedule`, `ask`, `send_email`, `other`

### Google Services Integration

- **Calendar API**: Create, update, delete events with automatic email notifications
- **Gmail API**: Send emails via authenticated user account
- **OAuth 2.0**: `/auth` and `/oauth2callback` endpoints for Google authorization

### Environment Configuration

Required `.env` variables:
- `OPENAI_API_KEY` - OpenAI API key for NLP processing
- `EMAIL_USER` - Gmail address for sending emails
- `EMAIL_PASS` - Gmail app password
- `PORT` - Server port (default: 3000)
- `DB_PATH` - SQLite database path (default: ./data/database.sqlite)

### Development Notes

- Uses ES modules (`"type": "module"` in package.json)
- Timezone hardcoded to Australia/Sydney in intentHandler.js
- Google credentials stored in `credentials.json` and `token.json`
- No testing framework currently configured
- Main entry point: `server/server.js`