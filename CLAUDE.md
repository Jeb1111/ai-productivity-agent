# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Start development server**: `npm run dev` (uses nodemon for auto-restart)
- **Start production server**: `npm start`
- **Install dependencies**: `npm install`

## Architecture Overview

This is a Node.js/Express AI productivity agent that handles calendar appointments, email, and goal tracking through natural language conversation. The application consists of:

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

Supported intents: `create_event`, `cancel`, `reschedule`, `check_schedule`, `send_email`, `set_goal`, `other`

### Google Services Integration

- **Calendar API**: Create, update, delete, and search events with automatic email notifications
- **Gmail API**: Send emails via authenticated user account
- **OAuth 2.0**: `/auth` and `/oauth2callback` endpoints for Google authorization

**Key Features:**
- Smart event search for cancel/reschedule operations by event title
- Context-aware date defaulting (e.g., "3pm" automatically selects today/tomorrow)
- Multi-step confirmation workflow for creating and modifying events
- Active reschedule state management to prevent intent conflicts
- Upcoming events sidebar with refresh capability
- Event detail modal with edit and delete functionality
- Direct API endpoints for event CRUD operations

### Environment Configuration

Required `.env` variables:

- `OPENAI_API_KEY` - OpenAI API key for NLP processing
- `EMAIL_USER` - Gmail address for sending emails
- `EMAIL_PASS` - Gmail app password
- `PORT` - Server port (default: 3000)

### Frontend UI

**Main Interface:**
- Single-page application with dark theme
- Main chat area for general calendar/email interactions
- Sidebar showing upcoming events (next 7 days)
- Event cards clickable to open detail modal

**Goals Modal:**
- Dedicated goals interface accessible via "📋 Goals" button
- Separate chat area specifically for goal management
- Context-aware processing (sends `context: 'goal_management'` to backend)
- Examples shown: study hours, workout frequency, sleep targets, project deadlines

**Event Management:**
- Event detail modal with view/edit modes
- Edit form with date, time, duration, location, description fields
- Delete confirmation dialog
- Real-time event refresh after modifications

### Goals Functionality (Partial Implementation)

**Current Status:**
- ✅ Intent detection for `set_goal`
- ✅ Goal description extraction via NLP
- ✅ Context-aware goal vs. event disambiguation
- ⚠️ **NOT IMPLEMENTED**: Goal storage, tracking, progress updates, or retrieval

**How It Works:**
1. User opens goals modal (sends `context: 'goal_management'`)
2. Intent handler biases toward `set_goal` intent
3. System extracts `goal_description` field
4. Server acknowledges goal but **does not persist it**
5. No database storage or tracking mechanism exists yet

**Example Goal Patterns:**
- "I want to study 10 hours before my exam" → goal with deadline
- "Set a goal to workout 3 times per week" → recurring goal
- "I need to sleep 7 hours every night" → daily target goal
- "I want to finish my project by next Monday" → project deadline

### API Endpoints

**Chat & Auth:**
- `POST /chat` - Main chat endpoint with session management
- `GET /auth` - Initiate Google OAuth flow
- `GET /oauth2callback` - OAuth callback handler

**Event Management:**
- `GET /api/upcoming-events` - Fetch upcoming events (next 7 days)
- `PUT /api/events/:eventId` - Update existing event
- `DELETE /api/events/:eventId` - Delete event

**Development:**
- `POST /reset-all-sessions` - Clear all in-memory sessions

### Development Notes

- Uses ES modules (`"type": "module"` in package.json)
- Timezone hardcoded to Australia/Sydney in intentHandler.js and server endpoints
- Google credentials stored in `credentials.json` and `token.json`
- No testing framework currently configured
- Main entry point: `server/server.js`
- Session storage is in-memory (lost on server restart)
- No database - goals are not persisted
