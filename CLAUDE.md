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
- `server/utils/googleAuth.js` - Google OAuth 2.0 authentication utilities
- `public/index.html` - Frontend chat interface

### Session Management

The application maintains stateful conversations through:

- In-memory session storage using JavaScript Map
- Active bookings tracking with confirmation workflow
- Multi-step intent handling (book → collect details → confirm → execute)
- Email tracking via Gmail's built-in Sent folder

### Intent Processing

Two-tier intent recognition:

1. **OpenAI GPT-4o-mini** (primary) - Structured JSON extraction for complex queries
2. **Local regex parser** (fallback) - Rule-based parsing when OpenAI unavailable

Supported intents: `create_event`, `cancel`, `reschedule`, `ask`, `send_email`, `other`

### Google Services Integration

- **Calendar API**: Create, update, delete, and search events with automatic email notifications
- **Gmail API**: Send emails via authenticated user account
- **OAuth 2.0**: `/auth` and `/oauth2callback` endpoints for Google authorization

**Key Features:**
- Smart event search for cancel/reschedule operations by event title
- Context-aware date defaulting (e.g., "3pm" automatically selects today/tomorrow)
- Multi-step confirmation workflow for creating and modifying events
- Active reschedule state management to prevent intent conflicts

### Environment Configuration

Required `.env` variables:

- `OPENAI_API_KEY` - OpenAI API key for NLP processing
- `EMAIL_USER` - Gmail address for sending emails
- `EMAIL_PASS` - Gmail app password
- `PORT` - Server port (default: 3000)

### Development Notes

- Uses ES modules (`"type": "module"` in package.json)
- Timezone hardcoded to Australia/Sydney in intentHandler.js
- Google credentials stored in `credentials.json` and `token.json`
- No testing framework currently configured
- Main entry point: `server/server.js`
