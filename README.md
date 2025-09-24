# AI Productivity Agent

An intelligent personal assistant that helps manage your calendar and emails through natural conversation.

## Features

- **Natural Language Processing** - Powered by OpenAI with intelligent fallbacks
- **Calendar Integration** - Book, reschedule, and cancel appointments via Google Calendar
- **Email Management** - Send emails through Gmail API
- **Chat Interface** - Modern, responsive web interface
- **Secure Authentication** - OAuth 2.0 with Google services
- **Session Persistence** - SQLite database for conversation history

## Quick Start

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up Google Cloud Console APIs (Calendar & Gmail)
4. Configure environment variables in `.env`
5. Run: `npm run dev`
6. Open: `http://localhost:3000`

## Environment Variables

```env
OPENAI_API_KEY=your_openai_api_key
EMAIL_USER=your_gmail@gmail.com
EMAIL_PASS=your_gmail_app_password
PORT=3000
```
