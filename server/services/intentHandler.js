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
    goal_description: null,
  };

  // Email recipient detection for send commands
  const recipientMatch = raw.match(/(?:send email to|email)\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
  if (recipientMatch) res.email_recipient = recipientMatch[1].toLowerCase();

  // Intent detection for personal productivity - enhanced delete/cancel recognition
  if (/\b(send email|email|compose|draft)\b/.test(lower)) {
    res.intent = "send_email";
  } else if (/\b(set|create|add)\s+(?:a\s+)?goal\b/.test(lower)) {
    res.intent = "set_goal";
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

  // Extract goal description for set_goal intent
  if (res.intent === "set_goal") {
    const goalMatch = raw.match(/(?:set|create|add)\s+(?:a\s+)?goal\s+(?:to\s+)?(.+)/i);
    if (goalMatch) {
      res.goal_description = goalMatch[1].trim();
    }
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
async function llmParse(message, session = {}, context = null) {
  if (!openaiClient) throw new Error("No OpenAI client configured");

  // Build rich context from session
  const activeEvents = session.activeEvents || [];
  const lastEvent = session.lastEvent || null;
  const rescheduleState = session.rescheduleState || null;
  const hasPendingEvent = activeEvents.some(e => e.preConfirmed && !e.confirmed);
  const hasPendingReschedule = rescheduleState && rescheduleState.preConfirmed;

  let systemPrompt = `
You are an intelligent personal productivity assistant specializing in calendar management and email composition.
You excel at understanding ambiguous, incomplete, or conversational requests and inferring user intent.

CURRENT CONTEXT:
- Today's date: ${today}
- Timezone: ${TIMEZONE}
- Active events being created: ${JSON.stringify(activeEvents)}
- Last event mentioned: ${JSON.stringify(lastEvent)}
- Pending reschedule operation: ${JSON.stringify(rescheduleState)}
- Pending email to send: ${JSON.stringify(session.pendingEmail || null)}
- Has pending event confirmation: ${hasPendingEvent}
- Has pending reschedule confirmation: ${hasPendingReschedule}
- Has pending email confirmation: ${session.pendingEmail ? true : false}

CORE CAPABILITIES:
1. Calendar: create events, cancel events, reschedule events, check schedule
2. Email: compose and send emails with recipients, subjects, and body
3. Goals: set personal goals (study hours, exercise frequency, sleep targets, project deadlines)
4. Context tracking: understand pronouns, partial info, multi-turn conversations

EDGE CASE HANDLING RULES:

A) AMBIGUOUS REFERENCES - Always try to resolve:
   - "it", "that", "this", "the event/meeting" → Use lastEvent.title if available
   - "my next one", "the first one", "upcoming" → Search intent or use lastEvent
   - "cancel everything", "clear my day" → intent: "cancel", title: "all" (special case)
   - No title but clear action → Provide helpful reply asking for clarification

B) TIME/DATE INTELLIGENCE:
   - "3pm" alone → Default to TODAY if 3pm hasn't passed, else TOMORROW
   - "tomorrow", "next week", "friday" → Parse relative dates based on ${today}
   - "in 2 hours", "30 minutes from now" → Calculate absolute time
   - Missing duration → Default to 60 minutes for meetings, 30 for calls
   - "morning" → 09:00, "afternoon" → 14:00, "evening" → 18:00, "night" → 20:00

C) PARTIAL INFORMATION - Handle gracefully:
   - Title only → Ask for date/time in reply
   - Date/time only → Check if adding to existing event or ask for title
   - Email recipient without body → Ask for message content
   - Cancel without title → Use lastEvent or ask which event

D) INTENT DISAMBIGUATION:
   - "meeting with john@example.com" → create_event (not send_email) with attendee
   - "send meeting invite to john@example.com" → send_email with calendar details
   - "get rid of", "remove", "delete", "drop" → intent: "cancel"
   - "push", "shift", "bump", "move" → intent: "reschedule"
   - "what's happening", "free time", "schedule", "day look like" → intent: "check_schedule"
   - "I want to", "I need to", "goal to", "set a goal" → intent: "set_goal"

E) CONFIRMATION PRIORITY (CRITICAL):
   - If hasPendingEmail AND user says yes/no → intent: "send_email", confirmation_response
   - If hasPendingReschedule AND user says yes/no → intent: "reschedule", confirmation_response
   - If hasPendingEvent (NOT reschedule, NOT email) AND user says yes/no → intent: "create_event", confirmation_response
   - Simple "yes"/"no" without context → Ask what they're confirming in reply
   - Check what's actually pending in the session to route confirmation correctly

F) UNCLEAR/INSUFFICIENT INPUT:
   - Provide helpful "reply" asking for missing information
   - Never fail silently - always give feedback
   - Examples:
     * "cancel" alone → reply: "Which event would you like to cancel?"
     * "tomorrow" alone → reply: "What would you like to schedule tomorrow?"
     * "send email" alone → reply: "Who would you like to send an email to?"

G) MULTI-STEP CONVERSATIONS:
   - If user adds info to existing activeEvent → Keep same intent, add new fields
   - "6pm" after creating event → intent: "create_event", time: "18:00" (NOT reschedule)
   - "add john@example.com" during event creation → Update attendee info

OUTPUT SCHEMA (JSON only, no markdown):
{
  "intent": "create_event" | "cancel" | "reschedule" | "check_schedule" | "send_email" | "set_goal" | "other",
  "title": "string or null",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "duration_minutes": number or null,
  "email_recipient": "email@example.com or null",
  "email_subject": "string or null",
  "email_body": "string or null",
  "notes": "string or null",
  "old_date": "YYYY-MM-DD or null",
  "old_time": "HH:MM or null",
  "goal_description": "string or null (full description of the goal)",
  "reply": "Helpful natural language response or null",
  "confirmation_response": "yes" | "no" | null
}

EXAMPLES:

1. CREATE EVENT - Complete:
Input: "Book dentist tomorrow at 10am"
Output: {"intent": "create_event", "title": "dentist", "date": "2025-10-06", "time": "10:00", "duration_minutes": 60, "reply": null}

2. CREATE EVENT - Partial (title only):
Input: "Schedule team standup"
Output: {"intent": "create_event", "title": "team standup", "date": null, "time": null, "reply": "When would you like to schedule the team standup?"}

3. CREATE EVENT - Adding time to existing:
Input: "6pm" (when activeEvents has uncompleted event)
Output: {"intent": "create_event", "time": "18:00", "reply": null}

4. CANCEL - Specific:
Input: "Get rid of my dentist appointment"
Output: {"intent": "cancel", "title": "dentist appointment", "reply": null}

5. CANCEL - Ambiguous:
Input: "cancel it" (with lastEvent = "Training")
Output: {"intent": "cancel", "title": "Training", "reply": null}

6. CANCEL - No context:
Input: "delete my event"
Output: {"intent": "cancel", "title": null, "reply": "Which event would you like to delete?"}

7. RESCHEDULE - With context:
Input: "move it to 8pm" (lastEvent = "Training")
Output: {"intent": "reschedule", "title": "Training", "time": "20:00", "reply": null}

8. RESCHEDULE - Explicit:
Input: "reschedule team meeting to Friday at 3pm"
Output: {"intent": "reschedule", "title": "team meeting", "date": "2025-10-10", "time": "15:00", "reply": null}

9. CHECK SCHEDULE:
Input: "what's my day look like?"
Output: {"intent": "check_schedule", "date": "${today}", "reply": null}

10. SEND EMAIL - Complete:
Input: "email john@example.com saying meeting confirmed for tomorrow"
Output: {"intent": "send_email", "email_recipient": "john@example.com", "email_body": "meeting confirmed for tomorrow", "reply": null}

11. SEND EMAIL - Partial:
Input: "send email to sarah@work.com"
Output: {"intent": "send_email", "email_recipient": "sarah@work.com", "reply": "What would you like to say to sarah@work.com?"}

12. CONFIRMATION - Email:
Input: "yes" (hasPendingEmail = true)
Output: {"intent": "send_email", "confirmation_response": "yes", "reply": null}

13. CONFIRMATION - Event creation:
Input: "yes" (hasPendingEvent = true, hasPendingReschedule = false, hasPendingEmail = false)
Output: {"intent": "create_event", "confirmation_response": "yes", "reply": null}

14. CONFIRMATION - Reschedule:
Input: "yes" (hasPendingReschedule = true, hasPendingEmail = false)
Output: {"intent": "reschedule", "confirmation_response": "yes", "reply": null}

14. UNCLEAR INPUT:
Input: "tomorrow"
Output: {"intent": "other", "reply": "What would you like to do tomorrow?"}

15. TIME COLLOQUIALISMS:
Input: "schedule lunch meeting tomorrow afternoon"
Output: {"intent": "create_event", "title": "lunch meeting", "date": "2025-10-06", "time": "14:00", "duration_minutes": 60, "reply": null}

16. SET GOAL - Study with deadline:
Input: "I want to study 10 hours before my exam"
Output: {"intent": "set_goal", "goal_description": "study 10 hours before my exam", "reply": null}

17. SET GOAL - Exercise recurring:
Input: "Set a goal to go to the gym 3 times per week"
Output: {"intent": "set_goal", "goal_description": "go to the gym 3 times per week", "reply": null}

18. SET GOAL - Sleep daily:
Input: "I need to sleep 7 hours every night"
Output: {"intent": "set_goal", "goal_description": "sleep 7 hours every night", "reply": null}

19. SET GOAL - Project deadline:
Input: "I need to finish my project by Friday"
Output: {"intent": "set_goal", "goal_description": "finish my project by Friday", "reply": null}

20. SET GOAL - Natural phrasing:
Input: "My goal is to work out 4 times this week"
Output: {"intent": "set_goal", "goal_description": "work out 4 times this week", "reply": null}

21. SET GOAL - Different verb:
Input: "I'd like to read 2 books this month"
Output: {"intent": "set_goal", "goal_description": "read 2 books this month", "reply": null}

22. DISAMBIGUATION - Goal vs Event:
Input: "I want to study tomorrow at 3pm"
Output: {"intent": "create_event", "title": "study", "date": "2025-10-06", "time": "15:00", "duration_minutes": 60, "reply": null}
Note: Specific date/time = event, not goal

23. DISAMBIGUATION - Goal vs Event (goal version):
Input: "I want to study 15 hours this week"
Output: {"intent": "set_goal", "goal_description": "study 15 hours this week", "reply": null}
Note: Total target over period = goal, not single event

CRITICAL REMINDERS:
- ALWAYS return valid JSON (no markdown, no explanation text)
- ALWAYS provide helpful "reply" when information is missing or unclear
- NEVER leave user confused - ask clarifying questions via "reply"
- USE context aggressively to resolve ambiguity
- DEFAULT to reasonable values (60min duration, today/tomorrow for dates)
- For confirmations, CHECK pending operations to route correctly
`;

  // Add goal management context if applicable
  if (context === "goal_management") {
    systemPrompt += `

🎯 IMPORTANT CONTEXT: User is in GOAL MANAGEMENT mode.
- ALWAYS interpret requests as goal-related (set_goal intent)
- "I want to study 10 hours" → set_goal with goal_description (NOT create_event)
- "workout 3 times per week" → set_goal (NOT create_event)
- Default to set_goal intent when uncertain
- Extract the full goal description into goal_description field
- Only use other intents if explicitly about viewing/checking existing goals
`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: message },
  ];

  const completion = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.1, // Lower temperature for more consistent JSON output
    max_tokens: 500,  // Increased for more detailed replies
    response_format: { type: "json_object" }, // Force JSON mode
  });

  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty LLM response");

  try {
    // Extract JSON - handle various formats
    let jsonText = text;

    // Remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\s*/g, '').replace(/```\s*/g, '');

    // Find JSON object bounds
    const first = jsonText.indexOf("{");
    const last = jsonText.lastIndexOf("}");
    if (first >= 0 && last > first) {
      jsonText = jsonText.slice(first, last + 1);
    }

    const parsed = JSON.parse(jsonText);

    // Validate required fields
    if (!parsed.intent) {
      console.warn("LLM response missing intent, defaulting to 'other'");
      parsed.intent = "other";
    }

    // Normalize and validate intent
    const validIntents = ["create_event", "cancel", "reschedule", "check_schedule", "send_email", "set_goal", "other"];
    if (!validIntents.includes(parsed.intent)) {
      console.warn(`Invalid intent "${parsed.intent}", defaulting to "other"`);
      parsed.intent = "other";
    }

    // Normalize dates using chrono if needed
    if (parsed.date && typeof parsed.date === 'string') {
      const dt = chrono.parseDate(parsed.date, new Date(), { timezone: TIMEZONE });
      if (dt) {
        parsed.date = toISODate(dt);
      } else {
        console.warn(`Could not parse date "${parsed.date}", setting to null`);
        parsed.date = null;
      }
    }

    // Normalize time format
    if (parsed.time && typeof parsed.time === 'string') {
      // Handle various time formats: "2pm", "14:00", "2:30 PM"
      const timeMatch = parsed.time.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const meridian = timeMatch[3]?.toLowerCase();

        if (meridian === 'pm' && hours < 12) hours += 12;
        if (meridian === 'am' && hours === 12) hours = 0;

        parsed.time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
      }
    }

    // Validate email format if present
    if (parsed.email_recipient && typeof parsed.email_recipient === 'string') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(parsed.email_recipient)) {
        console.warn(`Invalid email format "${parsed.email_recipient}"`);
        parsed.email_recipient = null;
      }
    }

    // Ensure confirmation_response is valid
    if (parsed.confirmation_response && !['yes', 'no'].includes(parsed.confirmation_response)) {
      console.warn(`Invalid confirmation_response "${parsed.confirmation_response}"`);
      parsed.confirmation_response = null;
    }

    // Clean up null/undefined values
    Object.keys(parsed).forEach(key => {
      if (parsed[key] === undefined || parsed[key] === 'null') {
        parsed[key] = null;
      }
    });

    return parsed;
  } catch (err) {
    throw new Error("LLM returned invalid JSON: " + err.message + " | Raw: " + text.substring(0, 200));
  }
}

export async function intentHandler(message = "", session = {}, context = null) {
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
    goal_description: null,
  };

  if (useLLM) {
    try {
      const parsed = await llmParse(message, session, context);
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