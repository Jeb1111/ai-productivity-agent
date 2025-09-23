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

// Enhanced local parser with email support
function localParse(message, session = {}) {
  const raw = cleanText(message);
  const lower = raw.toLowerCase();

  const res = {
    intent: "other",
    service: null,
    date: null,
    time: null,
    duration_minutes: null,
    email: null,
    email_recipient: null,
    email_subject: null,
    email_body: null,
    preferred_staff: null,
    notes: null,
    old_date: null,
    old_time: null,
    reply: null,
    confirmation_response: null,
  };

  // Email detection
  const emailMatch = raw.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch) res.email = emailMatch[0].toLowerCase();

  // Email recipient detection for send commands
  const recipientMatch = raw.match(/(?:send email to|email)\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  if (recipientMatch) res.email_recipient = recipientMatch[1].toLowerCase();

  // Intent detection - now includes email
  if (/\b(send email|email|compose|draft)\b/.test(lower) && !(/\bmy email\b/.test(lower))) {
    res.intent = "send_email";
  } else if (/\b(cancel|delete|remove)\b/.test(lower)) {
    res.intent = "cancel";
  } else if (/\b(resched|reschedule|move|change|shift)\b/.test(lower)) {
    res.intent = "reschedule";
  } else if (/\b(book|schedule|make an appointment|i want to book|i'd like to book|i want to schedule)\b/.test(lower)) {
    res.intent = "book";
  } else if (/\b(what do i have|what's my schedule|my appointments|check|show me|what do i have)\b/.test(lower)) {
    res.intent = "ask";
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

  // Handle confirmations
  const yn = detectYesNo(raw);
  const inProgress = (session.activeBookings || []).slice(-1)[0] || null;
  if (inProgress && inProgress.preConfirmed && !inProgress.confirmed && yn) {
    res.intent = "book";
    res.confirmation_response = yn;
    res.reply = yn === "yes" ? "Confirming booking." : "Making changes to booking.";
    return res;
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

// Enhanced LLM parser with email support
async function llmParse(message, session = {}) {
  if (!openaiClient) throw new Error("No OpenAI client configured");

  const systemPrompt = `
You are an AI productivity assistant that handles both scheduling and email tasks.
Today's date: ${today} in ${TIMEZONE}.
Context:
- Active bookings: ${JSON.stringify(session.activeBookings || [])}
- Last appointment: ${JSON.stringify(session.lastAppointment || null)}
- User email: ${session.email || "null"}

Return JSON only using this schema:
{
  "intent": "book" | "cancel" | "reschedule" | "ask" | "send_email" | "other",
  "service": "<service name or null>",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null", 
  "duration_minutes": number or null,
  "email": "<user email or null>",
  "email_recipient": "<recipient email or null>",
  "email_subject": "<email subject or null>",
  "email_body": "<email body or null>",
  "preferred_staff": "<name or null>",
  "notes": "<notes or null>",
  "old_date": "YYYY-MM-DD or null",
  "old_time": "HH:MM or null",
  "reply": "<short natural reply or null>",
  "confirmation_response": "yes" | "no" | null
}

Examples:
- "Send email to john@example.com saying hello" → intent: "send_email", email_recipient: "john@example.com", email_body: "hello"
- "Book a haircut tomorrow at 2pm" → intent: "book", service: "haircut", date: "2025-09-19", time: "14:00"
- "Email sarah@test.com about the meeting" → intent: "send_email", email_recipient: "sarah@test.com", email_subject: "about the meeting"
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
    service: null,
    date: null,
    time: null,
    duration_minutes: null,
    email: null,
    email_recipient: null,
    email_subject: null,
    email_body: null,
    preferred_staff: null,
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