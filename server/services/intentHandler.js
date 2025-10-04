import dotenv from "dotenv";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import OpenAI from "openai";

dotenv.config();

const TIMEZONE = "Australia/Sydney";
const today = DateTime.now().setZone(TIMEZONE).toISODate();
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const useLLM = Boolean(OPENAI_KEY);

let openaiClient = null;
if (useLLM) {
  openaiClient = new OpenAI({ apiKey: OPENAI_KEY });
}

function cleanText(t) {
  return (t || "").toString().trim();
}

function detectYesNo(msg) {
  if (!msg) return null;
  const s = msg.trim().toLowerCase();
  const yesWords = ["yes", "y", "yeah", "yep", "sure", "confirm", "ok", "okay"];
  const noWords = ["no", "n", "nope", "nah", "change"];
  if (yesWords.includes(s)) return "yes";
  if (noWords.includes(s)) return "no";
  if (/\byes\b/.test(s)) return "yes";
  if (/\bno\b/.test(s)) return "no";
  return null;
}

function toISODate(jsDate) {
  try {
    return DateTime.fromJSDate(jsDate).setZone(TIMEZONE).toISODate();
  } catch {
    return null;
  }
}

function toHHMM(jsDate) {
  try {
    return DateTime.fromJSDate(jsDate).setZone(TIMEZONE).toFormat("HH:mm");
  } catch {
    return null;
  }
}

// Enhanced local parser for personal productivity
function localParse(message, session = {}) {
  const raw = cleanText(message);
  const lower = raw.toLowerCase();

  const res = {
    intent: "other",
    title: null,
    date: null,
    time: null,
    duration_minutes: null,
    email_recipient: null,
    email_subject: null,
    email_body: null,
    notes: null,
    old_date: null,
    old_time: null,
    reply: null,
    confirmation_response: null,
  };

  // Email recipient detection for send commands
  const recipientMatch = raw.match(/(?:send email to|email)\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  if (recipientMatch) res.email_recipient = recipientMatch[1].toLowerCase();

  // Intent detection for personal productivity - enhanced delete/cancel recognition
  if (/\b(send email|email|compose|draft)\b/.test(lower)) {
    res.intent = "send_email";
  } else if (/\b(cancel|delete|remove|clear|erase|drop|eliminate|destroy)\b/.test(lower)) {
    res.intent = "cancel";
  } else if (/\b(resched|reschedule|move|change|shift)\b/.test(lower)) {
    res.intent = "reschedule";
  } else if (/\bmove\b.*\b(to|at)\b/.test(lower)) {
    res.intent = "reschedule";
  } else if (/\b(create|add|schedule|book|make|plan|set up)\b.*\b(event|appointment|meeting|reminder)\b/.test(lower)) {
    res.intent = "create_event";
  } else if (/\b(what do i have|what's my schedule|my appointments|my calendar|check|show me|what do i have)\b/.test(lower)) {
    res.intent = "check_schedule";
  }

  // Extract event title from various patterns
  const titlePatterns = [
    // Create/add patterns
    /(?:create|add|schedule|book|make|plan|set up)\s+(?:a\s+|an\s+)?(?:event|appointment|meeting|reminder)\s+(?:for\s+|called\s+|titled\s+)?["']?([^"'\n,]+)["']?/i,
    /(?:meeting|event|appointment)\s+(?:about|for|with|called)\s+["']?([^"'\n,]+)["']?/i,

    // Delete/cancel patterns - comprehensive and robust
    /(?:cancel|delete|remove|clear|erase|drop|eliminate|destroy)\s+(?:the\s+)?(?:my\s+)?["']([^"']+)["']\s*(?:event|appointment|meeting)?/i,  // "delete the "TEST123" event"
    /(?:cancel|delete|remove|clear|erase|drop|eliminate|destroy)\s+(?:the\s+)?([A-Z0-9]+)\s+(?:event|appointment|meeting)/i,  // "delete the TEST123 event"
    /(?:cancel|delete|remove|clear|erase|drop|eliminate|destroy)\s+(?:my\s+)?(?:the\s+)?(?:next|upcoming|first|latest)\s+(?:event|appointment|meeting)/i,  // "cancel my next event"
    /(?:cancel|delete|remove|clear|erase|drop|eliminate|destroy)\s+(?:my\s+)?(?:the\s+)?([^,\s]+(?:\s+[^,\s]+)*?)\s+(?:event|appointment|meeting)/i,  // "delete my test meeting event"
    /(?:cancel|delete|remove|clear|erase|drop|eliminate|destroy)\s+(?:the\s+)?(?:my\s+)?([^,\s]+(?:\s+[^,\s]+)*?)$/i,  // "delete TEST123" or "delete the event"
    /(?:cancel|delete|remove|clear|erase|drop|eliminate|destroy)\s+(?:tomorrow'?s?|today'?s?)\s+([^,\s]+(?:\s+[^,\s]+)*?)(?:\s+(?:event|appointment|meeting))?/i,  // "delete tomorrow's event"
    /(?:cancel|delete|remove|clear|erase|drop|eliminate|destroy)\s+(?:the\s+)?([a-zA-Z0-9]+(?:\s+[a-zA-Z0-9]+)*?)\s*(?:event|appointment|meeting)?/i,  // More flexible alphanumeric matching

    // Reschedule patterns - enhanced for ambiguous references
    /(?:move|reschedule|shift)\s+(?:my\s+)?([^,\s]+(?:\s+[^,\s]+)*?)(?:\s+(?:to|at|from))/i,
    /(?:move|reschedule|shift)\s+(it|that|this|the\s+(?:event|meeting|appointment))\s+(?:to|at)/i, // "move it to", "reschedule the event to"

    // General patterns with timing
    /([^,\s]+(?:\s+[^,\s]+)*?)\s+(?:at\s+\d)/i,

    // Quoted strings (high priority)
    /"([^"]+)"/,
    /'([^']+)'/
  ];

  for (const pattern of titlePatterns) {
    const match = raw.match(pattern);
    if (match) {
      res.title = match[1].trim();
      break;
    }
  }

  // Email content extraction
  if (res.intent === "send_email") {
    // Extract subject from patterns like "subject: xyz" or "re: xyz"
    const subjectMatch = raw.match(/(?:subject:|re:)\s*([^,\n]+)/i);
    if (subjectMatch) res.email_subject = subjectMatch[1].trim();

    // Extract body from patterns like "saying xyz" or "message: xyz"
    const bodyMatch = raw.match(/(?:saying|message:|telling them|body:)\s*["']?([^"'\n]+)["']?/i);
    if (bodyMatch) res.email_body = bodyMatch[1].trim();
  }

  // Handle confirmations - check for pending operations first
  const yn = detectYesNo(raw);
  const inProgressEvent = (session.activeEvents || []).find(e => e.preConfirmed && !e.confirmed) || null;
  const inProgressReschedule = session.rescheduleState && session.rescheduleState.preConfirmed;


  // Simple yes/no responses - be very specific about context
  if ((lower === "yes" || lower === "no" || lower === "y" || lower === "n") && yn) {
    // PRIORITY 1: If there's an active reschedule waiting for confirmation
    if (inProgressReschedule) {
      res.intent = "reschedule";
      res.confirmation_response = yn;
      res.reply = yn === "yes" ? "Rescheduling event." : "Making changes to reschedule.";
      return res;
    }

    // PRIORITY 2: If there's an active event creation waiting for confirmation
    if (inProgressEvent && !inProgressReschedule) {
      res.intent = "create_event";
      res.confirmation_response = yn;
      res.reply = yn === "yes" ? "Creating event." : "Making changes to event.";
      return res;
    }
  }

  // More detailed confirmations with additional words
  if (yn) {
    if (inProgressReschedule && (lower.includes("confirm") || lower.includes("reschedule") || lower === "yes")) {
      res.intent = "reschedule";
      res.confirmation_response = yn;
      res.reply = yn === "yes" ? "Rescheduling event." : "Making changes to reschedule.";
      return res;
    }

    if (inProgressEvent && !inProgressReschedule && (lower.includes("confirm") || lower.includes("create") || lower === "yes")) {
      res.intent = "create_event";
      res.confirmation_response = yn;
      res.reply = yn === "yes" ? "Creating event." : "Making changes to event.";
      return res;
    }
  }

  // Date/time parsing with chrono
  const chronoResults = chrono.parse(raw, new Date(), { forwardDate: true });
  if (chronoResults && chronoResults.length) {
    const dt = chronoResults[0].start?.date();
    if (dt) {
      res.date = toISODate(dt);
      res.time = toHHMM(dt);
    }
  }

  return res;
}

// Enhanced LLM parser for personal productivity
async function llmParse(message, session = {}) {
  if (!openaiClient) throw new Error("No OpenAI client configured");

  const systemPrompt = `
You are a personal productivity assistant that helps with calendar events and email management.
Today's date: ${today} in ${TIMEZONE}.

IMPORTANT CONTEXT for understanding conversational references:
- Active events: ${JSON.stringify(session.activeEvents || [])}
- Last event mentioned/created: ${JSON.stringify(session.lastEvent || null)}
- Current reschedule in progress: ${JSON.stringify(session.rescheduleState || null)}

CONVERSATIONAL INTELLIGENCE RULES:
1. When user says "it", "that", "the event", "the meeting" without specifying a title, they usually mean the most recent event (lastEvent)
2. If only time is mentioned (like "4pm", "8pm"), default to TODAY if time hasn't passed, or TOMORROW if it has
3. When user says "move it to 8pm" after previously mentioning an event, use that event's title
4. Handle partial information gracefully - don't require every field to be specified in one message
5. Understand context from previous messages in the same session

Return JSON only using this schema:
{
  "intent": "create_event" | "cancel" | "reschedule" | "check_schedule" | "send_email" | "other",
  "title": "<event title or null>",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "duration_minutes": number or null,
  "email_recipient": "<recipient email or null>",
  "email_subject": "<email subject or null>",
  "email_body": "<email body or null>",
  "notes": "<event notes or null>",
  "old_date": "YYYY-MM-DD or null",
  "old_time": "HH:MM or null",
  "reply": "<short natural reply or null>",
  "confirmation_response": "yes" | "no" | null
}

Examples:
- "Send email to john@example.com saying hello" → intent: "send_email", email_recipient: "john@example.com", email_body: "hello"
- "Create a meeting called 'Team Standup' tomorrow at 2pm" → intent: "create_event", title: "Team Standup", date: "2025-09-25", time: "14:00"
- "Schedule dentist appointment for Friday at 10am" → intent: "create_event", title: "dentist appointment", date: "2025-09-27", time: "10:00"
- "What's my schedule for today?" → intent: "check_schedule", date: "2025-09-24"

RESCHEDULE EXAMPLES (using context):
- "Move training to 4pm" → intent: "reschedule", title: "training", time: "16:00" (infer date from context)
- "move it to 8pm" (when lastEvent is "training") → intent: "reschedule", title: "training", time: "20:00"
- "reschedule the meeting to tomorrow at 3pm" → intent: "reschedule", title: "meeting", date: "2025-09-25", time: "15:00"
- "shift it to 5pm tomorrow" (using lastEvent context) → intent: "reschedule", title: from_lastEvent, date: "2025-09-25", time: "17:00"

CONVERSATIONAL CONTEXT EXAMPLES:
- After creating "Training" event, user says "move it to 8pm" → intent: "reschedule", title: "Training", time: "20:00"
- "cancel the event" (when lastEvent exists) → intent: "cancel", title: from_lastEvent
- "what time is it at?" (referring to lastEvent) → intent: "check_schedule", title: from_lastEvent

CONFIRMATION EXAMPLES:
- "yes" (when user has pending event) → intent: "create_event", confirmation_response: "yes"
- "no" (when user has pending event) → intent: "create_event", confirmation_response: "no"

CRITICAL PRIORITY RULES:
1. RESCHEDULE CONFIRMATION: If rescheduleState exists with preConfirmed=true and user says "yes"/"no", set intent="reschedule" with confirmation_response
2. EVENT CREATION CONFIRMATION: If NO reschedule is pending AND there are active events with preConfirmed=true awaiting confirmation, set intent="create_event"
3. CONTEXT MATTERS: Simple "yes"/"no" should be routed based on what operation is actually pending
4. NEVER create reschedule intent unless user explicitly mentions moving/rescheduling OR confirming an existing reschedule
5. For simple confirmations, check what the user is actually confirming
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: message },
  ];

  const completion = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.15,
    max_tokens: 400,
  });

  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty LLM response");

  try {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    const jsonText = first >= 0 && last > first ? text.slice(first, last + 1) : text;
    const parsed = JSON.parse(jsonText);

    // Normalize dates using chrono if needed
    if (parsed.date) {
      const dt = chrono.parseDate(parsed.date, new Date(), { timezone: TIMEZONE });
      if (dt) parsed.date = toISODate(dt);
    }

    return parsed;
  } catch (err) {
    throw new Error("LLM returned invalid JSON: " + err.message);
  }
}

export async function intentHandler(message = "", session = {}) {
  message = cleanText(message || "");

  const base = {
    intent: "other",
    title: null,
    date: null,
    time: null,
    duration_minutes: null,
    email_recipient: null,
    email_subject: null,
    email_body: null,
    notes: null,
    old_date: null,
    old_time: null,
    reply: null,
    confirmation_response: null,
  };

  if (useLLM) {
    try {
      const parsed = await llmParse(message, session);
      return { ...base, ...parsed };
    } catch (err) {
      console.warn("LLM parse failed, falling back to local parser:", err.message);
      const parsedLocal = localParse(message, session);
      return { ...base, ...parsedLocal };
    }
  } else {
    const parsedLocal = localParse(message, session);
    return { ...base, ...parsedLocal };
  }
}