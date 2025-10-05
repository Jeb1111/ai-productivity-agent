import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import { getAuthClient, saveToken } from "./utils/googleAuth.js";
import { intentHandler } from "./services/intentHandler.js";
// Database removed - using in-memory session storage
import { v4 as uuidv4 } from "uuid";
import { sendGmailEmail, draftGmailEmail } from "./services/gmailService.js";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, searchCalendarEvents, getEventsForDateRange } from "./services/calendarService.js";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// In-memory session storage
const sessions = new Map();

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
  let { message = "", sessionId } = req.body;
  if (!sessionId) sessionId = uuidv4();

  try {
    let sessionState = getSession(sessionId);
    sessionState.activeEvents = sessionState.activeEvents || [];

    // CRITICAL: Check if there's an active event creation in progress BEFORE parsing
    const hasActiveEventCreation = sessionState.activeEvents &&
                                    sessionState.activeEvents.some(e => !e.confirmed && !e.preConfirmed);

    // Parse intent and fields
    const parsed = await intentHandler(message, sessionState);

    // OVERRIDE: Handle simple yes/no for pending operations (LLM sometimes misses this)
    const messageLower = message.trim().toLowerCase();
    const isSimpleYesNo = ['yes', 'y', 'no', 'n', 'yeah', 'yep', 'nope', 'nah'].includes(messageLower);
    const hasPendingReschedule = sessionState.rescheduleState && sessionState.rescheduleState.preConfirmed;
    const hasPendingEventConfirmation = sessionState.activeEvents &&
                                         sessionState.activeEvents.some(e => e.preConfirmed && !e.confirmed);

    if (isSimpleYesNo && !parsed.confirmation_response) {
      const confirmResponse = ['yes', 'y', 'yeah', 'yep'].includes(messageLower) ? 'yes' : 'no';

      // Priority: email > reschedule > event creation
      if (sessionState.pendingEmail) {
        parsed.intent = "send_email";
        parsed.confirmation_response = confirmResponse;
      } else if (hasPendingReschedule) {
        parsed.intent = "reschedule";
        parsed.confirmation_response = confirmResponse;
      } else if (hasPendingEventConfirmation) {
        parsed.intent = "create_event";
        parsed.confirmation_response = confirmResponse;
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

    // Handle email sending intent
    if (parsed.intent === "send_email") {
      // Initialize pendingEmail in session if it doesn't exist
      if (!sessionState.pendingEmail) {
        sessionState.pendingEmail = null;
      }

      // Handle confirmation response
      if (parsed.confirmation_response && sessionState.pendingEmail) {
        if (parsed.confirmation_response === "yes") {
          try {
            // Send the confirmed email
            const emailResult = await sendGmailEmail({
              to: sessionState.pendingEmail.recipient,
              subject: sessionState.pendingEmail.subject,
              body: sessionState.pendingEmail.body
            });

            parsed.reply = `Email sent to ${sessionState.pendingEmail.recipient} successfully!`;
            sessionState.pendingEmail = null; // Clear pending email
            saveSession(sessionId, sessionState);
            return res.json({ reply: parsed.reply, state: sessionState, sessionId });

          } catch (emailError) {
            console.error("Email send failed:", emailError);
            parsed.reply = `Failed to send email to ${sessionState.pendingEmail.recipient}. Please try again or check your Gmail authorization.`;
            sessionState.pendingEmail = null;
            saveSession(sessionId, sessionState);
            return res.json({ reply: parsed.reply, state: sessionState, sessionId });
          }
        } else {
          // User said no - cancel email
          const recipient = sessionState.pendingEmail.recipient;
          parsed.reply = `Got it! I won't send the email to ${recipient}. Is there anything else I can help you with?`;
          sessionState.pendingEmail = null;
          saveSession(sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }
      }

      // Collect email details
      if (!parsed.email_recipient) {
        parsed.reply = "Who would you like to send the email to? Please provide their email address.";
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      if (!parsed.email_body && !parsed.email_subject) {
        parsed.reply = `What would you like to say in the email to ${parsed.email_recipient}?`;
        saveSession(sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      // Store pending email and ask for confirmation
      const subject = parsed.email_subject || "Message from AI Assistant";
      const body = parsed.email_body || "Hello!";

      sessionState.pendingEmail = {
        recipient: parsed.email_recipient,
        subject: subject,
        body: body
      };

      let confirmMsg = `I'll send an email to **${parsed.email_recipient}**\n\n`;
      confirmMsg += `**Subject:** ${subject}\n`;
      confirmMsg += `**Message:**\n${body}\n\n`;
      confirmMsg += `Would you like to send this email? (yes/no)`;

      parsed.reply = confirmMsg;
      saveSession(sessionId, sessionState);
      return res.json({ reply: parsed.reply, state: sessionState, sessionId });
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

    // Default response
    else {
      const reply = parsed.reply || "How can I help you today? I can help you create calendar events, send emails, and manage your schedule.";
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
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose"
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

// Health check
app.get("/", (_req, res) => {
  res.send("BuddyBoi Server is running!");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});