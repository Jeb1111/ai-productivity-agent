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

/**
 * Detect if message is about goal management (create/update/delete goals)
 * These requests should be redirected to the Goals section
 */
function isGoalManagementRequest(message) {
  const lower = message.toLowerCase();

  const goalKeywords = [
    /\b(set|create|add|make|new)\s+(?:a\s+)?goal\b/i,
    /\bgoal\s+(?:to|of|is)\b/i,
    /\bmy\s+goal\s+is\b/i,
    /\b(update|change|modify|edit)\s+(?:my\s+)?goal/i,
    /\b(delete|remove|drop)\s+(?:my\s+)?goal/i,
    /\btrack\s+(?:my\s+)?progress\b/i,
    /\b(?:what|show|list|view|display)\s+(?:are\s+)?(?:my\s+|the\s+)?goals?\b/i,
    /^(?:my\s+)?goals?\??$/i,
    // "I want to" patterns with measurable targets (likely goals)
    /\bI\s+want\s+to\s+\w+\s+\d+/i, // "I want to run 5km"
    /\bI\s+need\s+to\s+\w+\s+\d+/i, // "I need to study 10 hours"
    /\bI['']d\s+like\s+to\s+\w+\s+\d+/i, // "I'd like to read 2 books"
  ];

  return goalKeywords.some(pattern => pattern.test(message));
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
    notes: null,
    old_date: null,
    old_time: null,
    reply: null,
    confirmation_response: null,
    goal_description: null,
    goal_type: null, // Step 1.4: Type classification
    target_amount: null, // Step 1.5: Numeric target (e.g., 10, 3, 8)
    target_unit: null, // Step 1.5: Unit of measurement (e.g., "hours", "times", "km")
    deadline: null, // Step 1.5: ISO date string (YYYY-MM-DD)
    frequency: null, // Step 1.5: Recurrence pattern (e.g., "daily", "weekly", "3x per week")

    // Recurring event fields (Phase 1)
    recurrence_pattern: null, // "daily" | "weekly" | "custom"
    recurrence_days: null, // ["monday", "wednesday"] for custom patterns
    recurrence_count: null, // Number of occurrences
    recurrence_end_date: null, // Alternative to count (YYYY-MM-DD)
    recurrence_interval: null, // Every N days/weeks (default 1)
  };

  // Intent detection for personal productivity - enhanced delete/cancel recognition
  if (/\b(set|create|add)\s+(?:a\s+)?goal\b/.test(lower)) {
    res.intent = "set_goal";
  } else if (/\b(what|show|list|view|display)\s+(are\s+)?(my\s+|the\s+)?goals?\b/i.test(lower)) {
    res.intent = "check_goals";
  } else if (/^(my\s+)?goals?\??$/i.test(lower)) {
    res.intent = "check_goals";
  } else if (/\b(cancel|delete|remove|clear|erase|drop|eliminate|destroy)\b/.test(lower)) {
    res.intent = "cancel";
  } else if (/\b(resched|reschedule|move|change|shift)\b/.test(lower)) {
    res.intent = "reschedule";
  } else if (/\bmove\b.*\b(to|at)\b/.test(lower)) {
    res.intent = "reschedule";
  } else if (/\b(create|add|schedule|book|make|plan|set up)\b.*\b(event|appointment|meeting|reminder)\b/.test(lower)) {
    // Check if this is a recurring event request
    const recurringPatterns = [
      /\b(repeat|recurring|recur|repeating)\b/,
      /\bevery\s+(day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend)/,
      /\b(daily|weekly|monthly)\b/,
      /\bfor\s+\d+\s+(days|weeks|months)/,
      /\b\d+\s+times?\b/,
      /\bstarting\s+.*\s+(and|until|for)\b/
    ];

    if (recurringPatterns.some(pattern => pattern.test(lower))) {
      res.intent = "create_recurring_event";
    } else {
      res.intent = "create_event";
    }
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

  // Extract goal type from description (Step 1.4 - fallback classification)
  if (res.intent === "set_goal" && res.goal_description) {
    const desc = res.goal_description.toLowerCase();

    // Check in priority order (primary actions first)
    if (/\b(study|learn|read|review|practice|homework|exam|course|class|revision|prepare)\b/.test(desc)) {
      res.goal_type = "study";
    } else if (/\b(gym|workout|run|jog|exercise|fitness|train|cardio|lift|yoga|swim|sport)\b/.test(desc)) {
      res.goal_type = "exercise";
    } else if (/\b(sleep|rest|nap|bedtime|wake)\b/.test(desc)) {
      res.goal_type = "sleep";
    } else if (/\b(project|build|develop|make|create)\b/.test(desc)) {
      res.goal_type = "project";
    } else if (/\b(meeting|standup|sync|call|conference|attend)\b/.test(desc)) {
      res.goal_type = "meeting";
    } else if (/\b(health|water|diet|nutrition|meal|vitamin|medicine|doctor|hydrate|eat)\b/.test(desc)) {
      res.goal_type = "health";
    } else if (/\b(work|job|tasks|deliverable|deadline|complete|finish)\b/.test(desc)) {
      res.goal_type = "work";
    } else {
      res.goal_type = "other";
    }
  }

  // Extract target amount and unit (Step 1.5)
  if (res.intent === "set_goal" && res.goal_description) {
    const desc = res.goal_description;

    // Match patterns like "10 hours", "3 times", "5km", "5 km"
    const targetMatch = desc.match(/(\d+)\s*(hours?|times?|sessions?|km|kilometers?|minutes?|days?|weeks?|months?)/i);
    if (targetMatch) {
      res.target_amount = parseInt(targetMatch[1]);
      res.target_unit = targetMatch[2].toLowerCase();
      // Normalize plural forms
      if (res.target_unit.endsWith('s')) {
        res.target_unit = res.target_unit.slice(0, -1);
      }
    }

    // Extract frequency (Step 1.5)
    if (/\b(every\s+day|daily|every\s+night|nightly|each\s+day)\b/i.test(desc)) {
      res.frequency = "daily";
    } else if (/\b(per\s+week|weekly|every\s+week|each\s+week)\b/i.test(desc)) {
      res.frequency = "weekly";
    } else if (/\b(\d+)x?\s+per\s+week\b/i.test(desc)) {
      const freqMatch = desc.match(/(\d+)x?\s+per\s+week/i);
      res.frequency = `${freqMatch[1]}x per week`;
    } else if (/\bmonthly\b/i.test(desc)) {
      res.frequency = "monthly";
    }

    // Note: Complex deadline parsing left to LLM (will use chrono-node)
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

  // Extract recurring event details (Phase 1 - basic patterns only)
  if (res.intent === "create_recurring_event") {
    // Pattern: "daily" or "every day"
    if (/\b(daily|every day)\b/i.test(lower)) {
      res.recurrence_pattern = "daily";
      res.recurrence_interval = 1;
    }

    // Pattern: "weekly" or "every week"
    if (/\b(weekly|every week)\b/i.test(lower)) {
      res.recurrence_pattern = "weekly";
      res.recurrence_interval = 1;
    }

    // Pattern: "for X days/weeks"
    const countMatch = lower.match(/\bfor\s+(\d+)\s+(days?|weeks?)/i);
    if (countMatch) {
      const num = parseInt(countMatch[1]);
      const unit = countMatch[2];

      if (unit.startsWith("day")) {
        res.recurrence_count = num;
        if (!res.recurrence_pattern) res.recurrence_pattern = "daily";
      } else if (unit.startsWith("week")) {
        res.recurrence_count = num * 7;
        if (!res.recurrence_pattern) res.recurrence_pattern = "daily";
      }
    }

    // Pattern: "X times"
    const timesMatch = lower.match(/(\d+)\s+times?/i);
    if (timesMatch) {
      res.recurrence_count = parseInt(timesMatch[1]);
    }

    // Pattern: "every Monday", "every Wednesday"
    const dayMatch = lower.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (dayMatch) {
      res.recurrence_pattern = "weekly";
      res.recurrence_days = [dayMatch[1].toLowerCase()];
    }

    // Pattern: "every weekday"
    if (/every\s+weekday/i.test(lower)) {
      res.recurrence_pattern = "weekly";
      res.recurrence_days = ["monday", "tuesday", "wednesday", "thursday", "friday"];
    }

    // Pattern: "lasts X hour(s)" or "lasts X minutes"
    if (!res.duration_minutes) {
      const durationMatch = lower.match(/\b(?:lasts?|lasting)\s+(?:an?\s+)?(\d+)?\s*(hour|minute|hr|min)/i);
      if (durationMatch) {
        const num = durationMatch[1] ? parseInt(durationMatch[1]) : 1;
        const unit = durationMatch[2];

        if (unit.startsWith("hour") || unit === "hr") {
          res.duration_minutes = num * 60;
        } else if (unit.startsWith("minute") || unit === "min") {
          res.duration_minutes = num;
        }
      }
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
- Has pending event confirmation: ${hasPendingEvent}
- Has pending reschedule confirmation: ${hasPendingReschedule}

CORE CAPABILITIES:
1. Calendar: create events, cancel events, reschedule events, check schedule
2. Goals: set personal goals (study hours, exercise frequency, sleep targets, project deadlines)
3. Context tracking: understand pronouns, partial info, multi-turn conversations

GOAL TYPE CLASSIFICATION (Step 1.4):
When extracting goal_type, use these keyword mappings:
- study: study, learn, read, review, practice, homework, exam, course, class, revision, prepare
- exercise: gym, workout, run, jog, exercise, fitness, train, cardio, lift, yoga, swim, sport
- sleep: sleep, rest, nap, bedtime, wake up
- work: work, job, tasks, deliverable, deadline, complete (work context), finish (work context)
- meeting: meeting, standup, sync, call, conference, appointment, attend
- health: health, water, diet, nutrition, meal, vitamins, medicine, doctor, hydrate, eat
- project: project, build, create, develop, make, personal project, side project
- other: anything that doesn't clearly fit above categories

Rules for ambiguous cases:
- Prioritize the PRIMARY ACTION: "study for work" → study (not work)
- "exercise for health" → exercise (not health)
- "read project docs" → study (reading/learning action)
- If truly unclear → default to "other"

GOAL TARGET/DEADLINE EXTRACTION (Step 1.5):
When extracting goal target and deadline fields:
- target_amount: Extract the NUMBER (10, 3, 8, 5, etc.) - set to null if no number present
- target_unit: Extract the UNIT ("hours", "times", "sessions", "km", "minutes", "days") - set to null if no unit
- deadline: Parse deadline phrases to ISO date format YYYY-MM-DD - set to null if no deadline
  - "by Friday" → calculate next Friday's date (e.g., "2025-10-10")
  - "before my exam on Oct 10" → "2025-10-10"
  - "this week" / "by end of week" → calculate Friday/Sunday of current week
  - "next Monday" → calculate next Monday's date
  - "by next week" → calculate end of next week
- frequency: Extract recurrence pattern - set to null if not recurring
  - "every day" / "daily" / "every night" / "each day" → "daily"
  - "per week" / "weekly" / "every week" / "each week" → "weekly"
  - "3 times per week" / "3x per week" → "3x per week"
  - "monthly" / "every month" → "monthly"

IMPORTANT: Set fields to null if not present - do NOT guess or infer values
Examples:
- "Study 10 hours before Friday" → amount: 10, unit: "hour", deadline: "2025-10-10", frequency: null
- "Gym 3 times per week" → amount: 3, unit: "time", frequency: "weekly", deadline: null
- "Sleep 7 hours every night" → amount: 7, unit: "hour", frequency: "daily", deadline: null
- "Run 5km daily" → amount: 5, unit: "km", frequency: "daily", deadline: null
- "Study for my exam" → amount: null, unit: null, deadline: null, frequency: null (NO specific target)
- "Finish project by Monday" → amount: null, unit: null, deadline: "2025-10-13", frequency: null

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
   - Cancel without title → Use lastEvent or ask which event

D) INTENT DISAMBIGUATION:
   - "get rid of", "remove", "delete", "drop" → intent: "cancel"
   - "push", "shift", "bump", "move" → intent: "reschedule"
   - "what's happening", "free time", "schedule", "day look like" → intent: "check_schedule"
   - "I want to", "I need to", "goal to", "set a goal" → intent: "set_goal"

E) CONFIRMATION PRIORITY (CRITICAL):
   - If hasPendingReschedule AND user says yes/no → intent: "reschedule", confirmation_response
   - If hasPendingEvent (NOT reschedule) AND user says yes/no → intent: "create_event", confirmation_response
   - Simple "yes"/"no" without context → Ask what they're confirming in reply
   - Check what's actually pending in the session to route confirmation correctly

F) UNCLEAR/INSUFFICIENT INPUT:
   - Provide helpful "reply" asking for missing information
   - Never fail silently - always give feedback
   - Examples:
     * "cancel" alone → reply: "Which event would you like to cancel?"
     * "tomorrow" alone → reply: "What would you like to schedule tomorrow?"

G) MULTI-STEP CONVERSATIONS:
   - If user adds info to existing activeEvent → Keep same intent, add new fields
   - "6pm" after creating event → intent: "create_event", time: "18:00" (NOT reschedule)

H) RECURRING EVENT DETECTION (Phase 1):
   Use intent "create_recurring_event" when user requests repeating events.

   PATTERN RECOGNITION:
   - "repeat", "recurring", "repeating", "recur" → Recurring event
   - "every day", "daily", "each day" → pattern: "daily", interval: 1
   - "every week", "weekly" → pattern: "weekly", interval: 1
   - "every Monday", "every Wednesday" → pattern: "weekly", days: ["monday"] or ["wednesday"]
   - "every Monday and Wednesday" → pattern: "weekly", days: ["monday", "wednesday"]
   - "every weekday" → pattern: "weekly", days: ["monday", "tuesday", "wednesday", "thursday", "friday"]
   - "for 8 days", "for 2 weeks" → Extract count (8 or 14)
   - "8 times", "10 times" → count: 8 or 10
   - "until next Friday" → Calculate end_date from "next Friday"
   - "starting Monday for a month" → date: <next Monday>, count: ~30 (daily) or 4 (weekly)
   - "lasts an hour", "lasts 90 minutes" → duration_minutes: 60 or 90
   - "every other day" → pattern: "daily", interval: 2
   - "every 2 weeks" → pattern: "weekly", interval: 2

   EXTRACTION LOGIC:
   - recurrence_pattern: "daily" | "weekly" | "custom"
   - recurrence_days: Array of day names in lowercase (only for weekly/custom patterns)
   - recurrence_count: Total number of occurrences (prioritize this over end_date)
   - recurrence_end_date: ISO date string (YYYY-MM-DD) - only if user specifies "until <date>"
   - recurrence_interval: Number (1 = every time, 2 = every other time, etc.)
   - duration_minutes: Extract from "lasts X hours/minutes" if present

   EXAMPLES:
   - "Gym every Monday at 8am for 4 weeks" →
     intent: "create_recurring_event", title: "Gym", time: "08:00",
     recurrence_pattern: "weekly", recurrence_days: ["monday"], recurrence_count: 4

   - "Daily standup at 10am for the next 2 weeks" →
     intent: "create_recurring_event", title: "Daily standup", time: "10:00",
     recurrence_pattern: "daily", recurrence_count: 14

   - "Make an event starting Monday called Gym that lasts an hour at 8am and ensure it repeats for 8 days after" →
     intent: "create_recurring_event", title: "Gym", date: "<next Monday>", time: "08:00",
     duration_minutes: 60, recurrence_pattern: "daily", recurrence_count: 8

   - "Team meeting every Monday and Wednesday at 3pm until end of month" →
     intent: "create_recurring_event", title: "Team meeting", time: "15:00",
     recurrence_pattern: "weekly", recurrence_days: ["monday", "wednesday"],
     recurrence_end_date: "<end of current month>"

OUTPUT SCHEMA (JSON only, no markdown):
{
  "intent": "create_event" | "create_recurring_event" | "cancel" | "reschedule" | "check_schedule" | "set_goal" | "check_goals" | "other",
  "title": "string or null",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "duration_minutes": number or null,
  "notes": "string or null",
  "old_date": "YYYY-MM-DD or null",
  "old_time": "HH:MM or null",
  "goal_description": "string or null (full description of the goal)",
  "goal_type": "study" | "exercise" | "sleep" | "work" | "meeting" | "health" | "project" | "other" | null,
  "target_amount": number or null,
  "target_unit": "hour" | "time" | "session" | "km" | "minute" | "day" | "week" | "month" | string | null,
  "deadline": "YYYY-MM-DD or null",
  "frequency": "daily" | "weekly" | "monthly" | "Nx per week" | string | null,

  // RECURRING EVENT FIELDS (Phase 1):
  "recurrence_pattern": "daily" | "weekly" | "custom" | null,
  "recurrence_days": ["monday", "wednesday"] | null,
  "recurrence_count": number | null,
  "recurrence_end_date": "YYYY-MM-DD" | null,
  "recurrence_interval": number | null,

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

10. CONFIRMATION - Event creation:
Input: "yes" (hasPendingEvent = true, hasPendingReschedule = false)
Output: {"intent": "create_event", "confirmation_response": "yes", "reply": null}

11. CONFIRMATION - Reschedule:
Input: "yes" (hasPendingReschedule = true)
Output: {"intent": "reschedule", "confirmation_response": "yes", "reply": null}

12. UNCLEAR INPUT:
Input: "tomorrow"
Output: {"intent": "other", "reply": "What would you like to do tomorrow?"}

13. TIME COLLOQUIALISMS:
Input: "schedule lunch meeting tomorrow afternoon"
Output: {"intent": "create_event", "title": "lunch meeting", "date": "2025-10-06", "time": "14:00", "duration_minutes": 60, "reply": null}

14. SET GOAL - Study with deadline (Step 1.5: with target & deadline):
Input: "I want to study 10 hours before my exam"
Output: {"intent": "set_goal", "goal_description": "study 10 hours before my exam", "goal_type": "study", "target_amount": 10, "target_unit": "hour", "deadline": null, "frequency": null, "reply": null}
Note: No specific exam date given, so deadline is null

15. SET GOAL - Exercise recurring (Step 1.5: with target & frequency):
Input: "Set a goal to go to the gym 3 times per week"
Output: {"intent": "set_goal", "goal_description": "go to the gym 3 times per week", "goal_type": "exercise", "target_amount": 3, "target_unit": "time", "deadline": null, "frequency": "weekly", "reply": null}

16. SET GOAL - Sleep daily (Step 1.5: with target & frequency):
Input: "I need to sleep 7 hours every night"
Output: {"intent": "set_goal", "goal_description": "sleep 7 hours every night", "goal_type": "sleep", "target_amount": 7, "target_unit": "hour", "deadline": null, "frequency": "daily", "reply": null}

17. SET GOAL - Project deadline (Step 1.5: with deadline only):
Input: "I need to finish my project by Friday"
Output: {"intent": "set_goal", "goal_description": "finish my project by Friday", "goal_type": "project", "target_amount": null, "target_unit": "null", "deadline": "2025-10-10", "frequency": null, "reply": null}

18. SET GOAL - Natural phrasing (Step 1.5: with target):
Input: "My goal is to work out 4 times this week"
Output: {"intent": "set_goal", "goal_description": "work out 4 times this week", "goal_type": "exercise", "target_amount": 4, "target_unit": "time", "deadline": "2025-10-12", "frequency": null, "reply": null}
Note: "this week" = deadline is end of current week

19. SET GOAL - Different verb (Step 1.5: with target):
Input: "I'd like to read 2 books this month"
Output: {"intent": "set_goal", "goal_description": "read 2 books this month", "goal_type": "study", "target_amount": 2, "target_unit": "book", "deadline": "2025-10-31", "frequency": null, "reply": null}

20. RECURRING EVENT - Daily for X days (Phase 1):
Input: "Make an event starting Monday called Gym that lasts an hour at 8am and ensure it repeats for 8 days after"
Output: {"intent": "create_recurring_event", "title": "Gym", "date": "2025-10-13", "time": "08:00", "duration_minutes": 60, "recurrence_pattern": "daily", "recurrence_count": 8, "recurrence_interval": 1, "reply": null}

21. RECURRING EVENT - Every specific day (Phase 1):
Input: "Gym every Monday at 8am for 4 weeks"
Output: {"intent": "create_recurring_event", "title": "Gym", "time": "08:00", "recurrence_pattern": "weekly", "recurrence_days": ["monday"], "recurrence_count": 4, "recurrence_interval": 1, "reply": null}

22. RECURRING EVENT - Multiple days per week (Phase 1):
Input: "Team meeting every Monday and Wednesday at 3pm for the next month"
Output: {"intent": "create_recurring_event", "title": "Team meeting", "time": "15:00", "recurrence_pattern": "weekly", "recurrence_days": ["monday", "wednesday"], "recurrence_count": 8, "recurrence_interval": 1, "reply": null}

23. RECURRING EVENT - Daily standup (Phase 1):
Input: "Daily standup at 10am for the next 2 weeks"
Output: {"intent": "create_recurring_event", "title": "Daily standup", "time": "10:00", "recurrence_pattern": "daily", "recurrence_count": 14, "recurrence_interval": 1, "reply": null}

24. RECURRING EVENT - Every weekday (Phase 1):
Input: "Morning workout every weekday at 7am for 2 weeks"
Output: {"intent": "create_recurring_event", "title": "Morning workout", "time": "07:00", "recurrence_pattern": "weekly", "recurrence_days": ["monday", "tuesday", "wednesday", "thursday", "friday"], "recurrence_count": 10, "recurrence_interval": 1, "reply": null}

20. DISAMBIGUATION - Goal vs Event:
Input: "I want to study tomorrow at 3pm"
Output: {"intent": "create_event", "title": "study", "date": "2025-10-06", "time": "15:00", "duration_minutes": 60, "reply": null}
Note: Specific date/time = event, not goal

23. DISAMBIGUATION - Goal vs Event (goal version):
Input: "I want to study 15 hours this week"
Output: {"intent": "set_goal", "goal_description": "study 15 hours this week", "reply": null}
Note: Total target over period = goal, not single event

24. CHECK GOALS - Direct:
Input: "What are my goals?"
Output: {"intent": "check_goals", "reply": null}

25. CHECK GOALS - Variations:
Input: "Show me my goals"
Output: {"intent": "check_goals", "reply": null}

Input: "List goals"
Output: {"intent": "check_goals", "reply": null}

Input: "View my goals"
Output: {"intent": "check_goals", "reply": null}

Input: "My goals"
Output: {"intent": "check_goals", "reply": null}

26. DISAMBIGUATION - Schedule vs Goals:
Input: "What's my schedule today?"
Output: {"intent": "check_schedule", "date": "2025-10-05", "reply": null}
Note: "schedule" keyword = check_schedule, NOT check_goals

Input: "What are my goals?"
Output: {"intent": "check_goals", "reply": null}
Note: "goals" keyword = check_goals, NOT check_schedule

27. GOAL TYPE CLASSIFICATION - All 8 types (Step 1.5: with targets/deadlines):
Input: "I want to learn Python this month"
Output: {"intent": "set_goal", "goal_description": "learn Python this month", "goal_type": "study", "target_amount": null, "target_unit": null, "deadline": "2025-10-31", "frequency": null, "reply": null}

Input: "Run 5km daily"
Output: {"intent": "set_goal", "goal_description": "run 5km daily", "goal_type": "exercise", "target_amount": 5, "target_unit": "km", "deadline": null, "frequency": "daily", "reply": null}

Input: "Sleep 8 hours nightly"
Output: {"intent": "set_goal", "goal_description": "sleep 8 hours nightly", "goal_type": "sleep", "target_amount": 8, "target_unit": "hour", "deadline": null, "frequency": "daily", "reply": null}

Input: "Complete work tasks by EOD"
Output: {"intent": "set_goal", "goal_description": "complete work tasks by EOD", "goal_type": "work", "target_amount": null, "target_unit": null, "deadline": "2025-10-06", "frequency": null, "reply": null}

Input: "Attend team standup weekly"
Output: {"intent": "set_goal", "goal_description": "attend team standup weekly", "goal_type": "meeting", "target_amount": null, "target_unit": null, "deadline": null, "frequency": "weekly", "reply": null}

Input: "Drink 8 glasses of water daily"
Output: {"intent": "set_goal", "goal_description": "drink 8 glasses of water daily", "goal_type": "health", "target_amount": 8, "target_unit": "glass", "deadline": null, "frequency": "daily", "reply": null}

Input: "Build a mobile app by December"
Output: {"intent": "set_goal", "goal_description": "build a mobile app by December", "goal_type": "project", "target_amount": null, "target_unit": null, "deadline": "2025-12-31", "frequency": null, "reply": null}

Input: "Organize my closet this weekend"
Output: {"intent": "set_goal", "goal_description": "organize my closet this weekend", "goal_type": "other", "target_amount": null, "target_unit": null, "deadline": "2025-10-12", "frequency": null, "reply": null}

28. GOAL TYPE - Ambiguous cases (Step 1.5: prioritize PRIMARY ACTION):
Input: "Study for work presentation"
Output: {"intent": "set_goal", "goal_description": "study for work presentation", "goal_type": "study", "target_amount": null, "target_unit": null, "deadline": null, "frequency": null, "reply": null}
Note: Primary action is "study", context is "work" → Choose "study"

Input: "Exercise for better health"
Output: {"intent": "set_goal", "goal_description": "exercise for better health", "goal_type": "exercise", "target_amount": null, "target_unit": null, "deadline": null, "frequency": null, "reply": null}
Note: Primary action is "exercise", benefit is "health" → Choose "exercise"

29. GOAL WITHOUT SPECIFIC TARGET (Step 1.5: all fields null except description/type):
Input: "I want to study for my exam"
Output: {"intent": "set_goal", "goal_description": "study for my exam", "goal_type": "study", "target_amount": null, "target_unit": null, "deadline": null, "frequency": null, "reply": null}
Note: No specific number, deadline, or frequency - all null is valid

Input: "I need to exercise more"
Output: {"intent": "set_goal", "goal_description": "exercise more", "goal_type": "exercise", "target_amount": null, "target_unit": null, "deadline": null, "frequency": null, "reply": null}

30. GOAL WITH COMPLEX DEADLINE (Step 1.5: parse deadline dates):
Input: "Study 15 hours before my exam on Friday"
Output: {"intent": "set_goal", "goal_description": "study 15 hours before my exam on Friday", "goal_type": "study", "target_amount": 15, "target_unit": "hour", "deadline": "2025-10-10", "frequency": null, "reply": null}

Input: "Complete 20 hours of project work by next Monday"
Output: {"intent": "set_goal", "goal_description": "complete 20 hours of project work by next Monday", "goal_type": "project", "target_amount": 20, "target_unit": "hour", "deadline": "2025-10-13", "frequency": null, "reply": null}

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
    const validIntents = ["create_event", "cancel", "reschedule", "check_schedule", "set_goal", "check_goals", "other"];
    if (!validIntents.includes(parsed.intent)) {
      console.warn(`Invalid intent "${parsed.intent}", defaulting to "other"`);
      parsed.intent = "other";
    }

    // Validate goal_type (Step 1.4)
    if (parsed.goal_type) {
      const validTypes = ["study", "exercise", "sleep", "work", "meeting", "health", "project", "other"];
      if (!validTypes.includes(parsed.goal_type)) {
        console.warn(`Invalid goal_type "${parsed.goal_type}", defaulting to "other"`);
        parsed.goal_type = "other";
      }
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
    notes: null,
    old_date: null,
    old_time: null,
    reply: null,
    confirmation_response: null,
    goal_description: null,
    goal_type: null, // Step 1.4: Type classification
    target_amount: null, // Step 1.5: Numeric target
    target_unit: null, // Step 1.5: Unit of measurement
    deadline: null, // Step 1.5: ISO date string (YYYY-MM-DD)
    frequency: null, // Step 1.5: Recurrence pattern
  };

  // Early return: Redirect goal management requests to Goals section
  // (unless in goal_management context)
  if (context !== 'goal_management' && isGoalManagementRequest(message)) {
    return {
      ...base,
      intent: 'redirect_to_goals',
      reply: "I'd love to help you with your goals! 🎯\n\nPlease use the **Goals** section (click the 📋 Goals button at the top) where you can create, track, and schedule your goals with a dedicated interface.\n\nThe Goals section makes it much easier to:\n• Set measurable targets\n• Choose time preferences\n• Schedule time automatically\n• Track your progress"
    };
  }

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