import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import { getAuthClient, saveToken } from "./utils/googleAuth.js";
import { intentHandler } from "./services/intentHandler.js";
// Database removed - using in-memory session storage
import { v4 as uuidv4 } from "uuid";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, searchCalendarEvents, getEventsForDateRange } from "./services/calendarService.js";
import { detectFreeTimeSlots } from "./services/freeTimeDetector.js"; // Phase 2, Step 2.3
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// In-memory session storage
const sessions = new Map();

// Goal Data Structure (Phase 1 - Step 1.2):
// {
//   id: string (UUID),
//   description: string (original user input),
//   type: string | null (study, exercise, sleep, work, project, other) - Added in Step 1.4,
//   createdAt: ISO timestamp string,
//   status: "active" | "completed" | "cancelled"
// }
// Additional fields added in Step 1.5:
//   target_amount: number | null
//   target_unit: string | null
//   deadline: ISO date string | null
//   frequency: string | null
// Additional fields added in Phase 2, Step 2.1:
//   time_preferences: string[] (array of: 'morning', 'afternoon', 'evening', 'weekend')

// Helper functions
function formatFriendly(dateStr, timeStr) {
  try {
    const dt = new Date(`${dateStr}T${timeStr}:00`);
    return dt.toLocaleString("en-AU", { dateStyle: "long", timeStyle: "short" });
  } catch {
    return `${dateStr} ${timeStr}`;
  }
}

function updateEventInSession(sessionState, event) {
  if (!event.id) event.id = uuidv4();
  const idx = sessionState.activeEvents.findIndex((e) => e.id === event.id);
  if (idx === -1) sessionState.activeEvents.push(event);
  else sessionState.activeEvents[idx] = event;
  return sessionState;
}

function getUnconfirmedEvent(sessionState) {
  return sessionState.activeEvents.find((e) => !e.confirmed) || null;
}

function saveSession(sessionId, sessionState) {
  sessions.set(sessionId, {
    state: sessionState,
    updatedAt: new Date()
  });
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  return session ? session.state : {};
}

function extractYesNo(msg) {
  if (!msg) return null;
  const clean = msg.trim().toLowerCase();
  const yes = ["yes", "y", "yeah", "yep", "sure", "confirm", "ok", "okay"];
  const no = ["no", "n", "nope", "nah"];
  if (yes.includes(clean)) return "yes";
  if (no.includes(clean)) return "no";
  if (/\byes\b/.test(clean)) return "yes";
  if (/\bno\b/.test(clean)) return "no";
  return null;
}

// Main chat endpoint
app.post("/chat", async (req, res) => {
  let { message = "", sessionId, context = null } = req.body;
  if (!sessionId) sessionId = uuidv4();

  try {
    let sessionState = getSession(sessionId);
    sessionState.activeEvents = sessionState.activeEvents || [];
    sessionState.goals = sessionState.goals || []; // Step 1.2: Initialize goals array

    // CRITICAL: Check if there's an active event creation in progress BEFORE parsing
    const hasActiveEventCreation = sessionState.activeEvents &&
                                    sessionState.activeEvents.some(e => !e.confirmed && !e.preConfirmed);

    // Parse intent and fields with context
    const parsed = await intentHandler(message, sessionState, context);

    // OVERRIDE: Handle simple yes/no for pending operations (LLM sometimes misses this)
    const messageLower = message.trim().toLowerCase();
    const isSimpleYesNo = ['yes', 'y', 'no', 'n', 'yeah', 'yep', 'nope', 'nah'].includes(messageLower);
    const hasPendingReschedule = sessionState.rescheduleState && sessionState.rescheduleState.preConfirmed;
    const hasPendingEventConfirmation = sessionState.activeEvents &&
                                         sessionState.activeEvents.some(e => e.preConfirmed && !e.confirmed);

    if (isSimpleYesNo && !parsed.confirmation_response) {
      const confirmResponse = ['yes', 'y', 'yeah', 'yep'].includes(messageLower) ? 'yes' : 'no';

      // Priority: reschedule > event creation
      if (hasPendingReschedule) {
        parsed.intent = "reschedule";
        parsed.confirmation_response = confirmResponse;
      } else if (hasPendingEventConfirmation) {
        parsed.intent = "create_event";
        parsed.confirmation_response = confirmResponse;
      }
    }

    // GOAL CONTEXT OVERRIDE: If in goal_management context, bias toward goal intents
    if (context === "goal_management") {
      // If intent is "other" or ambiguous, default to set_goal
      if (parsed.intent === "other" || parsed.intent === "create_event") {
        parsed.intent = "set_goal";
        // If goal_description wasn't extracted, use the full message
        if (!parsed.goal_description) {
          parsed.goal_description = message;
        }
      }
    }

    // If there's an active event creation and the message looks like just time/date info
    // Override any reschedule intent to create_event instead
    if (hasActiveEventCreation && (parsed.time || parsed.date) &&
        parsed.intent !== "create_event" && parsed.intent !== "cancel") {
      // Check if message is just a simple time (like "6pm", "3:30pm", "18:00")
      const simpleTimePattern = /^\s*(\d{1,2})(:\d{2})?\s*(am|pm|AM|PM)?\s*$/i;
      if (simpleTimePattern.test(message.trim())) {
        parsed.intent = "create_event";
        // Don't clear the title - it will be merged with the existing event in create_event logic
      }
    }

    // Handle create event intent
    if (parsed.intent === "create_event") {
      // Critical: If there's an active reschedule, don't process create_event
      if (sessionState.rescheduleState && sessionState.rescheduleState.preConfirmed) {
        // Redirect to reschedule logic
        parsed.intent = "reschedule";
      }
    }

    if (parsed.intent === "create_event") {
      let currentEvent = getUnconfirmedEvent(sessionState);

      // Only clear existing event if we have a NEW title (indicating a completely new event request)
      // AND no confirmation response AND the event hasn't been pre-confirmed
      const hasNewTitle = parsed.title && (!currentEvent || parsed.title !== currentEvent.title);
      if (hasNewTitle && !parsed.confirmation_response) {
        if (currentEvent && !currentEvent.preConfirmed) {
          sessionState.activeEvents = sessionState.activeEvents.filter(e => e.confirmed);
          currentEvent = null;
        }
      }

      if (!currentEvent) {
        currentEvent = {
          id: uuidv4(),
          title: null,
          date: null,
          time: null,
          duration_minutes: 60,
          notes: null,
          preConfirmed: false,
          confirmed: false,
          google_event_id: null
        };
      }

      // Only merge parsed info if we're not handling a confirmation response
      if (!parsed.confirmation_response) {
        currentEvent.title = parsed.title || currentEvent.title;
        currentEvent.date = parsed.date || currentEvent.date;
        currentEvent.time = parsed.time || currentEvent.time;
        currentEvent.duration_minutes = parsed.duration_minutes || currentEvent.duration_minutes;
        currentEvent.notes = parsed.notes || currentEvent.notes;

        updateEventInSession(sessionState, currentEvent);
      }

      // Check for missing fields (skip if handling confirmation)
      if (!parsed.confirmation_response) {
        const missing = [];
        if (!currentEvent.title) missing.push("event title");
        if (!currentEvent.date) missing.push("date");
        if (!currentEvent.time) missing.push("time");

        if (missing.length) {
          parsed.reply = `Please provide the following: ${missing.join(", ")}.`;
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }
      }

      // If all info present and not yet preConfirmed
      if (!currentEvent.preConfirmed) {
        currentEvent.preConfirmed = true;
        updateEventInSession(sessionState, currentEvent);
        parsed.reply = `I'll create **${currentEvent.title}** on **${formatFriendly(currentEvent.date, currentEvent.time)}**. Would you like to confirm? (yes/no)`;
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      // Handle confirmation
      if (currentEvent.preConfirmed && !currentEvent.confirmed) {
        const yn = parsed.confirmation_response || extractYesNo(message);
        if (yn === "yes") {
          try {
            // Create Google Calendar event
            const start = new Date(`${currentEvent.date}T${currentEvent.time}:00`);
            const end = new Date(start.getTime() + (currentEvent.duration_minutes || 60) * 60000);

            const calendarResult = await createCalendarEvent({
              summary: currentEvent.title,
              description: currentEvent.notes || "",
              startDateTime: start.toISOString(),
              endDateTime: end.toISOString()
            });

            currentEvent.google_event_id = calendarResult.eventId;
            currentEvent.confirmed = true;
            sessionState.lastEvent = { ...currentEvent };

            updateEventInSession(sessionState, currentEvent);

            let replyMsg = `Your event "${currentEvent.title}" is confirmed for ${formatFriendly(currentEvent.date, currentEvent.time)}.`;

            saveSession(sessionId, sessionState);
            return res.json({ reply: replyMsg, state: sessionState, sessionId });

          } catch (calendarError) {
            console.error("Calendar event creation failed:", calendarError);
            currentEvent.preConfirmed = false;
            updateEventInSession(sessionState, currentEvent);

            let errorMessage = "Unable to create calendar event. Please try again.";
            if (calendarError.message.includes("authorization")) {
              errorMessage = "Calendar authorization expired. Please re-authorize by visiting /auth";
            }

            saveSession(sessionId, sessionState);
            return res.json({ reply: errorMessage, state: sessionState, sessionId });
          }

        } else if (yn === "no") {
          // User doesn't want to create this event - cancel it
          const eventTitle = currentEvent.title;
          sessionState.activeEvents = sessionState.activeEvents.filter(e => e.id !== currentEvent.id);
          parsed.reply = `No worries! I won't create the "${eventTitle}" event. Is there anything else I can help you with?`;
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        } else {
          parsed.reply = "Please reply 'yes' to confirm or 'no' to make changes.";
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }
      }
    }

    // Handle cancel intent
    else if (parsed.intent === "cancel") {
      let eventToDelete = null;

      try {
        // Detect generic references like "next event", "my event", "upcoming event", etc.
        const genericRefs = /\b(next|upcoming|my|the|latest|recent|last created|first)\s*(event|appointment|meeting)?\b/i;
        const isGenericRef = !parsed.title || genericRefs.test(parsed.title) ||
                           parsed.title.match(/^(it|that|this|event|appointment|meeting)$/i);

        // If a specific title is mentioned (and not a generic reference), search for it
        if (parsed.title && !isGenericRef) {
          const calendarEvents = await searchCalendarEvents(parsed.title, 10);
          const matchingEvent = calendarEvents.find(event =>
            event.summary && event.summary.toLowerCase().includes(parsed.title.toLowerCase())
          );

          if (matchingEvent) {
            eventToDelete = {
              google_event_id: matchingEvent.eventId,
              title: matchingEvent.summary,
              startDateTime: matchingEvent.startDateTime
            };
          }
        }

        // Handle generic references or fallback: get the next upcoming event
        if (!eventToDelete) {
          // Try to get upcoming events
          const upcomingEvents = await searchCalendarEvents(null, 5);

          if (upcomingEvents && upcomingEvents.length > 0) {
            // Get the first (soonest) upcoming event
            const nextEvent = upcomingEvents[0];
            eventToDelete = {
              google_event_id: nextEvent.eventId,
              title: nextEvent.summary,
              startDateTime: nextEvent.startDateTime
            };
          }
        }

        // Final fallback to lastEvent if still nothing found
        if (!eventToDelete && sessionState.lastEvent && sessionState.lastEvent.google_event_id) {
          eventToDelete = sessionState.lastEvent;
        }

        if (!eventToDelete) {
          parsed.reply = "I couldn't find any events to cancel. Your calendar appears to be empty.";
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }

        // Delete from Google Calendar
        await deleteCalendarEvent(eventToDelete.google_event_id);

        // Update session state
        sessionState.activeEvents = sessionState.activeEvents.filter(e =>
          e.google_event_id !== eventToDelete.google_event_id
        );

        // Clear lastEvent if it matches
        if (sessionState.lastEvent && sessionState.lastEvent.google_event_id === eventToDelete.google_event_id) {
          sessionState.lastEvent = null;
        }

        // Format the event time for display
        let eventTimeStr = "unknown time";
        if (eventToDelete.startDateTime) {
          const startDate = new Date(eventToDelete.startDateTime);
          eventTimeStr = startDate.toLocaleString("en-AU", {
            dateStyle: "long",
            timeStyle: "short",
            timeZone: "Australia/Sydney"
          });
        } else if (eventToDelete.date && eventToDelete.time) {
          eventTimeStr = formatFriendly(eventToDelete.date, eventToDelete.time);
        }

        let replyMsg = `Your event "${eventToDelete.title}" on ${eventTimeStr} has been cancelled.`;

        saveSession(sessionId, sessionState);
        return res.json({ reply: replyMsg, state: sessionState, sessionId });

      } catch (calErr) {
        console.error("Calendar delete failed:", calErr.message);

        // Handle specific error cases
        let errorMsg = "Unable to cancel the event.";
        if (calErr.message.includes("Resource has been deleted") || calErr.code === 410) {
          errorMsg = "This event has already been deleted from your calendar.";
        } else if (calErr.message.includes("Not Found") || calErr.code === 404) {
          errorMsg = "The event was not found in your calendar (it may have already been deleted).";
        } else {
          errorMsg = "Unable to cancel the event. Please try again or check your calendar authorization.";
        }

        parsed.reply = errorMsg;
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
    }

    // Handle reschedule intent
    else if (parsed.intent === "reschedule") {
      let rescheduleState = sessionState.rescheduleState || null;

      if (!rescheduleState) {
        rescheduleState = {
          originalEvent: null,
          newDate: null,
          newTime: null,
          preConfirmed: false
        };

        // Find event to reschedule from Google Calendar
        let eventToReschedule = null;

        try {
          // Search Google Calendar for events
          let calendarEvents = [];

          if (parsed.title) {
            // Search with specific title first
            calendarEvents = await searchCalendarEvents(parsed.title, 10);
          }

          // If no specific title match or no title provided, get all upcoming events
          if (calendarEvents.length === 0) {
            calendarEvents = await searchCalendarEvents(null, 20);
          }

          // If we have a specific title from the request, try to match it
          if (parsed.title && calendarEvents.length > 0) {
            const matchingEvent = calendarEvents.find(event =>
              event.summary &&
              event.summary.toLowerCase().includes(parsed.title.toLowerCase())
            );
            if (matchingEvent) {
              eventToReschedule = {
                google_event_id: matchingEvent.eventId,
                title: matchingEvent.summary,
                startDateTime: matchingEvent.startDateTime,
                endDateTime: matchingEvent.endDateTime,
                duration_minutes: matchingEvent.duration_minutes
              };
            }
          }

          // If still no event found but we have calendar events, check session lastEvent
          if (!eventToReschedule && sessionState.lastEvent && sessionState.lastEvent.google_event_id) {
            // Try to find the lastEvent in current calendar events
            const lastEventInCalendar = calendarEvents.find(event =>
              event.eventId === sessionState.lastEvent.google_event_id
            );
            if (lastEventInCalendar) {
              eventToReschedule = {
                google_event_id: lastEventInCalendar.eventId,
                title: lastEventInCalendar.summary,
                startDateTime: lastEventInCalendar.startDateTime,
                endDateTime: lastEventInCalendar.endDateTime,
                duration_minutes: lastEventInCalendar.duration_minutes
              };
            }
          }

          // If still no specific match, use the first upcoming event if there's only one
          if (!eventToReschedule && calendarEvents.length === 1) {
            const event = calendarEvents[0];
            eventToReschedule = {
              google_event_id: event.eventId,
              title: event.summary,
              startDateTime: event.startDateTime,
              endDateTime: event.endDateTime,
              duration_minutes: event.duration_minutes
            };
          } else if (!eventToReschedule && calendarEvents.length > 1) {
            // Multiple events - ask user to be more specific
            const eventList = calendarEvents.slice(0, 5).map(e => {
              const startDate = new Date(e.startDateTime);
              return `"${e.summary}" on ${startDate.toLocaleDateString('en-AU')} at ${startDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
            }).join(", ");
            parsed.reply = `I found multiple events. Which one would you like to reschedule? ${eventList}`;
            saveSession(sessionId, sessionState);
            return res.json({ reply: parsed.reply, state: sessionState, sessionId });
          }

        } catch (error) {
          console.error("Error searching calendar events:", error);
          parsed.reply = "I had trouble accessing your calendar. Please try again.";
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }

        if (!eventToReschedule) {
          parsed.reply = "I couldn't find any events to reschedule. Please create an event first or be more specific about which event you want to move.";
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }

        rescheduleState.originalEvent = eventToReschedule;
      }
      
      // Update with new date/time
      rescheduleState.newDate = parsed.date || rescheduleState.newDate;
      rescheduleState.newTime = parsed.time || rescheduleState.newTime;
      sessionState.rescheduleState = rescheduleState;

      // Smart date defaulting when only time is provided
      if (!rescheduleState.newDate && rescheduleState.newTime) {
        const now = new Date();
        const currentTime = now.getHours() * 60 + now.getMinutes();
        const [hours, minutes] = rescheduleState.newTime.split(':').map(Number);
        const newTimeInMinutes = hours * 60 + minutes;

        // If the time is later today, use today; otherwise use tomorrow
        if (newTimeInMinutes > currentTime + 30) { // 30 minute buffer
          rescheduleState.newDate = now.toISOString().split('T')[0];
        } else {
          const tomorrow = new Date(now);
          tomorrow.setDate(tomorrow.getDate() + 1);
          rescheduleState.newDate = tomorrow.toISOString().split('T')[0];
        }
      }

      // Enhanced context-aware error messages
      if (!rescheduleState.newDate || !rescheduleState.newTime) {
        let missingInfo = [];
        if (!rescheduleState.newDate) missingInfo.push("date");
        if (!rescheduleState.newTime) missingInfo.push("time");

        const eventName = rescheduleState.originalEvent?.title || "the event";
        parsed.reply = `What ${missingInfo.join(" and ")} would you like to move "${eventName}" to?`;
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
      
      if (!rescheduleState.preConfirmed) {
        // Format original event time from Google Calendar startDateTime
        let oldDateTime = "unknown time";
        if (rescheduleState.originalEvent.startDateTime) {
          const startDate = new Date(rescheduleState.originalEvent.startDateTime);
          oldDateTime = startDate.toLocaleString("en-AU", {
            dateStyle: "long",
            timeStyle: "short",
            timeZone: "Australia/Sydney"
          });
        }

        const newDateTime = formatFriendly(rescheduleState.newDate, rescheduleState.newTime);

        rescheduleState.preConfirmed = true;
        sessionState.rescheduleState = rescheduleState;

        parsed.reply = `I'll move your **${rescheduleState.originalEvent.title}** from **${oldDateTime}** to **${newDateTime}**. Confirm? (yes/no)`;
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
      
      // Handle reschedule confirmation
      if (rescheduleState.preConfirmed) {
        const yn = parsed.confirmation_response || extractYesNo(message);
        
        if (yn === "yes") {
          try {
            // Update Google Calendar event
            if (rescheduleState.originalEvent.google_event_id) {
              const start = new Date(`${rescheduleState.newDate}T${rescheduleState.newTime}:00`);
              const end = new Date(start.getTime() + (rescheduleState.originalEvent.duration_minutes || 60) * 60000);

              await updateCalendarEvent({
                eventId: rescheduleState.originalEvent.google_event_id,
                summary: rescheduleState.originalEvent.title,
                startDateTime: start.toISOString(),
                endDateTime: end.toISOString()
              });
            }

            // Update session state events
            sessionState.activeEvents = sessionState.activeEvents.map((event) => {
              if (event.google_event_id === rescheduleState.originalEvent.google_event_id) {
                return { ...event, date: rescheduleState.newDate, time: rescheduleState.newTime };
              }
              return event;
            });

            // Update lastEvent if it matches
            if (sessionState.lastEvent && sessionState.lastEvent.google_event_id === rescheduleState.originalEvent.google_event_id) {
              sessionState.lastEvent.date = rescheduleState.newDate;
              sessionState.lastEvent.time = rescheduleState.newTime;
            }

            sessionState.rescheduleState = null;

            // Format original time from Google Calendar startDateTime
            let friendlyOld = "unknown time";
            if (rescheduleState.originalEvent.startDateTime) {
              const startDate = new Date(rescheduleState.originalEvent.startDateTime);
              friendlyOld = startDate.toLocaleString("en-AU", {
                dateStyle: "long",
                timeStyle: "short",
                timeZone: "Australia/Sydney"
              });
            }

            const friendlyNew = formatFriendly(rescheduleState.newDate, rescheduleState.newTime);
            let replyMsg = `Your "${rescheduleState.originalEvent.title}" has been moved from ${friendlyOld} to ${friendlyNew}.`;

            saveSession(sessionId, sessionState);
            return res.json({ reply: replyMsg, state: sessionState, sessionId });

          } catch (calendarError) {
            console.error("Calendar reschedule failed:", calendarError);
            rescheduleState.preConfirmed = false;
            sessionState.rescheduleState = rescheduleState;

            saveSession(sessionId, sessionState);
            return res.json({ reply: `Unable to reschedule in calendar: ${calendarError.message}`, state: sessionState, sessionId });
          }
          
        } else if (yn === "no") {
          // User doesn't want to reschedule - cancel the operation
          const eventTitle = rescheduleState.eventTitle;
          sessionState.rescheduleState = null;

          parsed.reply = `Got it! I won't reschedule "${eventTitle}". It will stay at its original time. Anything else I can help with?`;
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        } else {
          parsed.reply = "Please reply 'yes' to confirm the reschedule or 'no' to choose a different time.";
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }
      }
    }

    // Handle check_schedule intent
    else if (parsed.intent === "check_schedule") {
      const qDate = parsed.date || new Date().toISOString().split('T')[0]; // default to today

      try {
        const events = await getEventsForDateRange(qDate);

        if (!events || events.length === 0) {
          const dateStr = new Date(qDate).toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
          parsed.reply = `You have no events scheduled for ${dateStr}. Your day is free!`;
        } else {
          const dateStr = new Date(qDate).toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });

          let scheduleText = `**Your schedule for ${dateStr}:**\n\n`;

          events.forEach((event, index) => {
            const startTime = new Date(event.startDateTime);
            const endTime = new Date(event.endDateTime);
            const timeStr = `${startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} - ${endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;

            scheduleText += `**${index + 1}. ${event.summary}**\n`;
            scheduleText += `⏰ ${timeStr}\n`;

            if (event.location) {
              scheduleText += `📍 ${event.location}\n`;
            }

            if (event.description) {
              scheduleText += `📝 ${event.description}\n`;
            }

            scheduleText += '\n';
          });

          parsed.reply = scheduleText.trim();
        }

        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      } catch (error) {
        console.error("Check schedule error:", error);
        parsed.reply = "Unable to check your schedule right now. Please try again.";
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
    }

    // Handle redirect_to_goals intent - send users to Goals section
    else if (parsed.intent === "redirect_to_goals" || parsed.intent === "set_goal" || parsed.intent === "check_goals") {
      const reply = parsed.reply || "I'd love to help you with your goals! 🎯\n\nPlease use the **Goals** section (click the 📋 Goals button at the top) where you can create, track, and schedule your goals.\n\nThe Goals section makes it much easier to manage your goals!";
      saveSession(sessionId, sessionState);
      return res.json({ reply, state: sessionState, sessionId });
    }

    // OLD: Handle set_goal intent (NOW REDIRECTED TO GOALS SECTION)
    /*
    else if (parsed.intent === "set_goal") {
      // Check if goal description exists
      if (!parsed.goal_description || parsed.goal_description.trim() === "") {
        parsed.reply = "I detected you want to set a goal, but I need more details. What would you like to achieve?";
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      // Create goal object (Step 1.5: with type, target, deadline, frequency)
      const newGoal = {
        id: uuidv4(),
        description: parsed.goal_description.trim(),
        type: parsed.goal_type || "other", // Step 1.4: Store classified type
        target_amount: parsed.target_amount || null, // Step 1.5: Numeric target
        target_unit: parsed.target_unit || null, // Step 1.5: Unit of measurement
        deadline: parsed.deadline || null, // Step 1.5: ISO date deadline
        frequency: parsed.frequency || null, // Step 1.5: Recurrence pattern
        time_preferences: parsed.time_preferences || [], // Phase 2, Step 2.1: Time preferences
        createdAt: new Date().toISOString(),
        status: "active"
      };

      // Store goal in session
      sessionState.goals.push(newGoal);

      // Save session and confirm
      saveSession(sessionId, sessionState);
      parsed.reply = `Goal saved! ${newGoal.description}`;

      return res.json({ reply: parsed.reply, state: sessionState, sessionId });
    }

    // Handle check_goals intent (Step 1.3: View stored goals)
    else if (parsed.intent === "check_goals") {
      // Check if goals exist
      if (!sessionState.goals || sessionState.goals.length === 0) {
        parsed.reply = "You haven't set any goals yet.";
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      // Format goals list with type emojis (Step 1.4)
      let goalsText = "**Your Goals:**\n\n";

      // Emoji mapping for goal types
      const emojiMap = {
        study: "📚",
        exercise: "💪",
        sleep: "😴",
        work: "💼",
        meeting: "📅",
        health: "❤️",
        project: "📋",
        other: "📌"
      };

      sessionState.goals.forEach((goal, index) => {
        const emoji = emojiMap[goal.type] || "📌"; // Fallback for null or invalid types

        // Basic line with emoji and description
        goalsText += `${index + 1}. ${emoji} **${goal.description}**\n`;

        // Add structured target/deadline info if present (Step 1.5)
        const hasTarget = goal.target_amount && goal.target_unit;
        const hasDeadline = goal.deadline;
        const hasFrequency = goal.frequency;

        if (hasTarget || hasDeadline || hasFrequency) {
          let detailLine = "   ";

          if (hasTarget) {
            let unit = goal.target_unit;
            // Smart pluralization for units
            if (goal.target_amount > 1) {
              if (unit === 'glass') {
                unit = 'glasses';
              } else if (!unit.endsWith('s') && unit !== 'km') {
                unit += 's'; // Standard pluralization
              }
            }
            detailLine += `Target: ${goal.target_amount} ${unit}`;

            // Add frequency or deadline to target line
            if (hasFrequency) {
              detailLine += ` (${goal.frequency})`;
            } else if (hasDeadline) {
              const deadlineDate = new Date(goal.deadline);
              const formatted = deadlineDate.toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
              });
              detailLine += ` before ${formatted}`;
            }
          } else if (hasFrequency) {
            detailLine += `Frequency: ${goal.frequency}`;
          } else if (hasDeadline) {
            const deadlineDate = new Date(goal.deadline);
            const formatted = deadlineDate.toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric'
            });
            detailLine += `Deadline: ${formatted}`;
          }

          goalsText += detailLine + '\n';
        }

        goalsText += '\n'; // Extra line between goals
      });

      parsed.reply = goalsText.trim();
      saveSession(sessionId, sessionState);
      return res.json({ reply: parsed.reply, state: sessionState, sessionId });
    }
    */
    // END OF COMMENTED OUT GOAL HANDLING - NOW REDIRECTED TO GOALS SECTION

    // Default response
    else {
      const reply = parsed.reply || "How can I help you today? I can help you create calendar events and manage your schedule.";
      saveSession(sessionId, sessionState);
      return res.json({ reply, state: sessionState, sessionId });
    }

  } catch (err) {
    console.error("Chat endpoint error:", err);
    res.status(500).json({ reply: "Something went wrong. Please try again." });
  }
});

// OAuth routes
app.get("/auth", (req, res) => {
  const oAuth2Client = getAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar"
    ]
  });
  res.redirect(authUrl);
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("No authorization code provided");
  
  const oAuth2Client = getAuthClient();
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);
    res.send("Authorization successful! You can now close this tab and return to the chat.");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Error saving authorization: " + (err.message || err));
  }
});

// Reset sessions (development)
app.post("/reset-all-sessions", async (req, res) => {
  try {
    sessions.clear();
    return res.json({ reply: "All sessions cleared!" });
  } catch (err) {
    console.error("Reset sessions error:", err);
    return res.status(500).json({ reply: "Could not clear sessions." });
  }
});

// Simple upcoming events endpoint for sidebar
app.get("/api/upcoming-events", async (req, res) => {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const now = new Date();
    const endOfWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: endOfWeek.toISOString(),
      maxResults: 5,
      singleEvents: true,
      orderBy: "startTime"
    });

    const events = response.data.items.map(event => {
      const startTime = new Date(event.start.dateTime || event.start.date);
      const endTime = new Date(event.end.dateTime || event.end.date);

      const formatTime = (date) => {
        return date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
      };

      const formatDate = (date) => {
        return date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        });
      };

      const duration = Math.round((endTime - startTime) / 60000); // duration in minutes

      return {
        id: event.id,
        title: event.summary || 'Untitled Event',
        time: `${formatTime(startTime)} - ${formatTime(endTime)}`,
        date: formatDate(startTime),
        fullDateTime: startTime.toLocaleString('en-US', {
          dateStyle: 'long',
          timeStyle: 'short'
        }),
        startDateTime: event.start.dateTime || event.start.date,
        endDateTime: event.end.dateTime || event.end.date,
        location: event.location || '',
        description: event.description || '',
        duration: duration
      };
    });

    res.json(events);
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// Update event endpoint
app.put("/api/events/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { summary, startDateTime, endDateTime, location, description } = req.body;

    // Validate required fields
    if (!summary || !startDateTime || !endDateTime) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const eventUpdate = {
      summary,
      start: {
        dateTime: startDateTime,
        timeZone: 'Australia/Sydney'
      },
      end: {
        dateTime: endDateTime,
        timeZone: 'Australia/Sydney'
      }
    };

    // Add optional fields if provided
    if (location) eventUpdate.location = location;
    if (description) eventUpdate.description = description;

    await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      requestBody: eventUpdate
    });

    res.json({ success: true, message: "Event updated successfully" });
  } catch (error) {
    console.error("Error updating event:", error);
    res.status(500).json({ error: "Failed to update event" });
  }
});

// Delete event endpoint
app.delete("/api/events/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;

    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId
    });

    res.json({ success: true, message: "Event deleted successfully" });
  } catch (error) {
    console.error("Error deleting event:", error);

    // Handle specific error cases
    if (error.code === 404 || error.code === 410) {
      return res.status(404).json({ error: "Event not found or already deleted" });
    }

    res.status(500).json({ error: "Failed to delete event" });
  }
});

// Goals API endpoints (Step 1.6: Goals Dashboard)

// POST /api/goals/:goalId/find-slots - Find available time slots for a goal (Phase 2, Step 2.3)
app.post("/api/goals/:goalId/find-slots", async (req, res) => {
  try {
    const { goalId } = req.params;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    // 1. Get goal from session
    const sessionState = getSession(sessionId);
    const goal = sessionState.goals?.find(g => g.id === goalId);

    if (!goal) {
      return res.status(404).json({ error: "Goal not found" });
    }

    // 2. Get calendar events for next 28 days (4 weeks for recurring goals)
    const now = new Date();
    const fourWeeksFromNow = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);

    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: fourWeeksFromNow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const calendarEvents = response.data.items.map(event => ({
      eventId: event.id,
      summary: event.summary,
      startDateTime: event.start.dateTime || event.start.date,
      endDateTime: event.end.dateTime || event.end.date,
      location: event.location,
      description: event.description
    }));

    // 3. Run free time detection algorithm (returns timeOptions)
    const result = await detectFreeTimeSlots(calendarEvents, goal, {
      daysAhead: 28
    });

    // 4. Calculate insufficiency info (Simple Solution for incomplete schedules)
    let sessionsNeeded, hoursNeeded, sessionDuration;

    if (goal.session_duration && goal.target_amount) {
      // Multi-session goal: "Study 10 hours in 2-hour sessions"
      sessionDuration = goal.session_duration;
      const targetAmount = goal.target_amount;
      sessionsNeeded = Math.ceil(targetAmount / sessionDuration);
      hoursNeeded = sessionsNeeded * sessionDuration;
    } else {
      // Regular recurring goal: "Learn French daily"
      sessionDuration = goal.target_amount || 1;

      // For daily goals with deadline, calculate from TODAY to deadline, not from first available slot
      if (goal.frequency && (goal.frequency === 'daily' || goal.frequency === 'every day') && goal.deadline) {
        const now = new Date();
        const deadline = new Date(goal.deadline);
        deadline.setHours(23, 59, 59, 999);
        const daysUntilDeadline = Math.round((deadline - now) / (1000 * 60 * 60 * 24)) + 1;
        sessionsNeeded = Math.max(1, daysUntilDeadline);
      } else {
        sessionsNeeded = result.eventCount;
      }

      hoursNeeded = sessionsNeeded * sessionDuration;
    }

    const sessionsFound = result.timeOptions[0]?.events.length || 0;
    const hoursFound = sessionsFound * sessionDuration;
    const incomplete = sessionsFound < sessionsNeeded && sessionsNeeded > 0;

    // 5. If incomplete, find alternative slots for missing sessions
    let alternatives = [];
    if (incomplete && result.timeOptions[0]) {
      const missingSessions = sessionsNeeded - sessionsFound;

      // Get all possible dates within deadline (search ALL dates, not just missing ones)
      // User might want multiple sessions per day, so we search everywhere
      const now = new Date();
      const deadline = goal.deadline ? new Date(goal.deadline) : new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
      deadline.setHours(23, 59, 59, 999); // End of deadline day (inclusive)

      const allDates = [];
      for (let d = new Date(now); d <= deadline; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        allDates.push(dateStr);
      }

      // For each missing session, find alternative time slots
      const { findFreeBlocks } = await import('./services/freeTimeDetector.js');
      const durationMinutes = sessionDuration * 60;

      // Search all missing dates, not just first 3
      console.log(`[DEBUG ALT] Searching ${allDates.length} dates for ${missingSessions} missing sessions (max ${missingSessions * 3} alternatives)`);
      for (const date of allDates) {
        if (alternatives.length >= missingSessions * 3) break; // Show up to 3 options per missing session

        // Find slots in all time preferences for this date
        const timeSlots = {
          morning: { start: '06:00', end: '12:00' },
          afternoon: { start: '12:00', end: '18:00' },
          evening: { start: '18:00', end: '22:00' }
        };

        for (const [prefName, prefTimes] of Object.entries(timeSlots)) {
          const freeBlocks = findFreeBlocks(date, prefName, prefTimes, durationMinutes, calendarEvents);

          if (freeBlocks.length > 0) {
            console.log(`[DEBUG ALT] Found ${freeBlocks.length} free blocks on ${date} ${prefName}, adding up to 3`);
            // Add all free blocks for this preference on this date (up to 3)
            freeBlocks.slice(0, 3).forEach(slot => {
              alternatives.push({
                date: slot.date,
                startTime: slot.startTime,
                endTime: slot.endTime,
                durationMinutes: slot.durationMinutes,
                timePreference: prefName
              });
            });
          }
        }
      }
      console.log(`[DEBUG ALT] Total alternatives found: ${alternatives.length}`);
    }

    // 6. Return time options and goal with insufficiency info
    console.log(`[DEBUG SERVER] Returning: incomplete=${incomplete}, sessionsNeeded=${sessionsNeeded}, sessionsFound=${sessionsFound}, timeOptions.length=${result.timeOptions.length}`);

    return res.json({
      timeOptions: result.timeOptions,
      eventCount: result.eventCount,
      frequency: result.frequency,
      goal,
      // Insufficiency detection
      incomplete,
      sessionsNeeded,
      sessionsFound,
      hoursNeeded,
      hoursFound,
      missingHours: hoursNeeded - hoursFound,
      missingSessions: sessionsNeeded - sessionsFound,
      alternatives  // Alternative slots for missing sessions
    });

  } catch (error) {
    console.error("Error finding time slots:", error);
    return res.status(500).json({ error: "Failed to find time slots" });
  }
});

// POST /api/goals/:goalId/schedule-recurring - Schedule recurring events directly via Calendar API (Phase 2, Step 2.4)
app.post("/api/goals/:goalId/schedule-recurring", async (req, res) => {
  try {
    const { goalId } = req.params;
    const { sessionId, events } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: "events array is required" });
    }

    // 1. Get goal from session
    const sessionState = getSession(sessionId);
    const goal = sessionState.goals?.find(g => g.id === goalId);

    if (!goal) {
      return res.status(404).json({ error: "Goal not found" });
    }

    // 2. Get calendar API
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // 3. Check if we have multi-session days (Option 3)
    // If multiple sessions per day, create individual events instead of RRULE
    const eventsByDate = {};
    events.forEach(event => {
      if (!eventsByDate[event.date]) {
        eventsByDate[event.date] = [];
      }
      eventsByDate[event.date].push(event);
    });

    const hasMultiSessionDays = Object.values(eventsByDate).some(dayEvents => dayEvents.length > 1);
    const useIndividualEvents = hasMultiSessionDays || (goal.max_sessions_per_day && goal.max_sessions_per_day > 1);

    // If multi-session pattern detected, create individual events
    if (useIndividualEvents) {
      const results = [];
      let sessionCounter = 1;
      const totalSessions = events.length;

      for (const event of events) {
        try {
          const startDT = new Date(`${event.date}T${event.startTime}:00`);
          const endDT = new Date(`${event.date}T${event.endTime}:00`);

          const eventResource = {
            summary: goal.description,
            description: `Goal: ${goal.description}\nSession ${sessionCounter} of ${totalSessions}\nTarget: ${goal.target_amount} ${goal.target_unit}`,
            start: {
              dateTime: startDT.toISOString(),
              timeZone: 'Australia/Sydney'
            },
            end: {
              dateTime: endDT.toISOString(),
              timeZone: 'Australia/Sydney'
            },
            reminders: {
              useDefault: false,
              overrides: [{ method: 'popup', minutes: 30 }]
            }
          };

          await calendar.events.insert({
            calendarId: 'primary',
            resource: eventResource,
            sendUpdates: 'none'
          });

          results.push({ success: true, date: event.date });
          sessionCounter++;
        } catch (error) {
          console.error(`Error creating event for ${event.date}:`, error);
          results.push({ success: false, date: event.date, error: error.message });
        }
      }

      return res.json({
        success: true,
        created: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        recurring: false,
        multiSession: true,
        results
      });
    }

    // 4. Build recurrence rule (RRULE) for simple recurring patterns
    const firstEvent = events[0];
    const startDateTime = new Date(`${firstEvent.date}T${firstEvent.startTime}:00`);
    const endDateTime = new Date(`${firstEvent.date}T${firstEvent.endTime}:00`);

    let recurrence = [];
    const freq = (goal.frequency || '').toLowerCase();

    // Use the actual number of events calculated (respecting deadline)
    const eventCount = events.length;

    // Determine if we should use UNTIL (for long deadlines) or COUNT (for short ones)
    // Strategy: Use UNTIL if deadline > 4 weeks, otherwise use COUNT
    const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000;
    const now = new Date();
    let useUntil = false;
    let untilDate = null;

    if (goal.deadline) {
      const deadlineDate = new Date(goal.deadline);
      deadlineDate.setHours(23, 59, 59, 999); // End of deadline day
      const timeUntilDeadline = deadlineDate - now;

      if (timeUntilDeadline > FOUR_WEEKS_MS) {
        useUntil = true;
        untilDate = deadlineDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      }
    }

    if (freq === 'daily' || freq === 'every day') {
      // Daily - use UNTIL for long deadlines, COUNT for short ones
      if (useUntil) {
        recurrence = [`RRULE:FREQ=DAILY;UNTIL=${untilDate}`];
      } else {
        recurrence = [`RRULE:FREQ=DAILY;COUNT=${eventCount}`];
      }
    } else if (freq === 'weekly' || freq === 'every week') {
      // Weekly - use UNTIL for long deadlines, COUNT for short ones
      const dayOfWeek = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][startDateTime.getDay()];
      if (useUntil) {
        recurrence = [`RRULE:FREQ=WEEKLY;UNTIL=${untilDate};BYDAY=${dayOfWeek}`];
      } else {
        recurrence = [`RRULE:FREQ=WEEKLY;COUNT=${eventCount};BYDAY=${dayOfWeek}`];
      }
    } else if (freq.includes('3') && freq.includes('week')) {
      // 3 times per week
      if (useUntil) {
        recurrence = [`RRULE:FREQ=WEEKLY;UNTIL=${untilDate};BYDAY=MO,WE,FR;INTERVAL=1`];
      } else {
        recurrence = [`RRULE:FREQ=WEEKLY;COUNT=${eventCount};BYDAY=MO,WE,FR;INTERVAL=1`];
      }
    } else if (freq.includes('2') && freq.includes('week')) {
      // 2 times per week
      if (useUntil) {
        recurrence = [`RRULE:FREQ=WEEKLY;UNTIL=${untilDate};BYDAY=MO,TH;INTERVAL=1`];
      } else {
        recurrence = [`RRULE:FREQ=WEEKLY;COUNT=${eventCount};BYDAY=MO,TH;INTERVAL=1`];
      }
    } else {
      // For one-time or unknown frequency, create individual events
      const results = [];
      for (const event of events) {
        try {
          const startDT = new Date(`${event.date}T${event.startTime}:00`);
          const endDT = new Date(`${event.date}T${event.endTime}:00`);

          const eventResource = {
            summary: goal.description,
            description: `Goal: ${goal.description}\nTarget: ${goal.target_amount} ${goal.target_unit}`,
            start: {
              dateTime: startDT.toISOString(),
              timeZone: 'Australia/Sydney'
            },
            end: {
              dateTime: endDT.toISOString(),
              timeZone: 'Australia/Sydney'
            },
            reminders: {
              useDefault: false,
              overrides: [{ method: 'popup', minutes: 30 }]
            }
          };

          await calendar.events.insert({
            calendarId: 'primary',
            resource: eventResource,
            sendUpdates: 'none'
          });

          results.push({ success: true, date: event.date });
        } catch (error) {
          console.error(`Error creating event for ${event.date}:`, error);
          results.push({ success: false, date: event.date, error: error.message });
        }
      }

      return res.json({
        success: true,
        created: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        recurring: false,
        results
      });
    }

    // 4. Create single recurring event with RRULE
    const eventResource = {
      summary: goal.description,
      description: `Goal: ${goal.description}\nFrequency: ${goal.frequency}\nTarget: ${goal.target_amount} ${goal.target_unit}`,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'Australia/Sydney'
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'Australia/Sydney'
      },
      recurrence: recurrence,
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: 30 }]
      }
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: eventResource,
      sendUpdates: 'none'
    });

    return res.json({
      success: true,
      created: events.length,
      recurring: true,
      eventId: response.data.id,
      recurrenceRule: recurrence[0]
    });

  } catch (error) {
    console.error("Error scheduling recurring events:", error);
    return res.status(500).json({ error: "Failed to schedule events", details: error.message });
  }
});

// GET /api/goals - Fetch all goals for a session
app.get("/api/goals", (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const sessionState = getSession(sessionId);
    const goals = sessionState.goals || [];

    return res.json({ goals });
  } catch (err) {
    console.error("Error fetching goals:", err);
    return res.status(500).json({ error: "Failed to fetch goals" });
  }
});

// POST /api/goals/parse - Parse natural language input into goal fields
app.post("/api/goals/parse", async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || !sessionId) {
      return res.status(400).json({ error: "message and sessionId are required" });
    }

    const sessionState = getSession(sessionId);

    // Parse with goal_management context to bias toward set_goal intent
    const parsed = await intentHandler(message, sessionState, 'goal_management');

    return res.json({
      description: parsed.goal_description || message,
      type: parsed.goal_type || "other",
      target_amount: parsed.target_amount || null,
      target_unit: parsed.target_unit || null,
      deadline: parsed.deadline || null,
      frequency: parsed.frequency || null
    });
  } catch (err) {
    console.error("Error parsing goal:", err);
    return res.status(500).json({ error: "Failed to parse goal" });
  }
});

// POST /api/goals - Create a new goal
app.post("/api/goals", async (req, res) => {
  try {
    const { sessionId, goalData } = req.body;

    if (!sessionId || !goalData) {
      return res.status(400).json({ error: "sessionId and goalData are required" });
    }

    const sessionState = getSession(sessionId);

    // Validate time_preferences if provided
    let timePreferences = goalData.time_preferences || [];
    if (Array.isArray(timePreferences)) {
      const validPrefs = ['morning', 'afternoon', 'evening', 'weekend'];
      timePreferences = timePreferences.filter(pref => validPrefs.includes(pref));
    } else {
      timePreferences = [];
    }

    // Create goal object
    const newGoal = {
      id: uuidv4(),
      description: goalData.description,
      type: goalData.type || "other",
      target_amount: goalData.target_amount || null,
      target_unit: goalData.target_unit || null,
      deadline: goalData.deadline || null,
      frequency: goalData.frequency || null,
      time_preferences: timePreferences, // Phase 2, Step 2.1
      createdAt: new Date().toISOString(),
      status: "active"
    };

    // Initialize goals array if it doesn't exist
    if (!sessionState.goals) {
      sessionState.goals = [];
    }

    sessionState.goals.push(newGoal);
    saveSession(sessionId, sessionState);

    return res.json({ success: true, goal: newGoal });
  } catch (err) {
    console.error("Error creating goal:", err);
    return res.status(500).json({ error: "Failed to create goal" });
  }
});

// PUT /api/goals/:goalId - Update an existing goal
app.put("/api/goals/:goalId", (req, res) => {
  try {
    const { goalId } = req.params;
    const { sessionId, goalData } = req.body;

    if (!sessionId || !goalData) {
      return res.status(400).json({ error: "sessionId and goalData are required" });
    }

    const sessionState = getSession(sessionId);
    const goalIndex = sessionState.goals?.findIndex(g => g.id === goalId);

    if (goalIndex === -1 || goalIndex === undefined) {
      return res.status(404).json({ error: "Goal not found" });
    }

    // Validate time_preferences if provided
    let timePreferences = goalData.time_preferences || [];
    if (Array.isArray(timePreferences)) {
      const validPrefs = ['morning', 'afternoon', 'evening', 'weekend'];
      timePreferences = timePreferences.filter(pref => validPrefs.includes(pref));
    } else {
      timePreferences = [];
    }

    // Update goal while preserving id, createdAt, and status
    sessionState.goals[goalIndex] = {
      ...sessionState.goals[goalIndex],
      description: goalData.description,
      type: goalData.type,
      target_amount: goalData.target_amount || null,
      target_unit: goalData.target_unit || null,
      deadline: goalData.deadline || null,
      frequency: goalData.frequency || null,
      time_preferences: timePreferences // Phase 2, Step 2.1
    };

    saveSession(sessionId, sessionState);
    return res.json({ success: true, goal: sessionState.goals[goalIndex] });
  } catch (err) {
    console.error("Error updating goal:", err);
    return res.status(500).json({ error: "Failed to update goal" });
  }
});

// DELETE /api/goals/:goalId - Delete a goal
app.delete("/api/goals/:goalId", (req, res) => {
  try {
    const { goalId } = req.params;
    const sessionId = req.query.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const sessionState = getSession(sessionId);
    const goalIndex = sessionState.goals?.findIndex(g => g.id === goalId);

    if (goalIndex === -1 || goalIndex === undefined) {
      return res.status(404).json({ error: "Goal not found" });
    }

    sessionState.goals.splice(goalIndex, 1);
    saveSession(sessionId, sessionState);

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting goal:", err);
    return res.status(500).json({ error: "Failed to delete goal" });
  }
});

// Health check
app.get("/", (_req, res) => {
  res.send("BuddyBoi Server is running!");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});