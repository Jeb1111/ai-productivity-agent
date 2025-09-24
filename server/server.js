import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import { getAuthClient, saveToken } from "./utils/googleAuth.js";
import { intentHandler } from "./services/intentHandler.js";
import { getDB, initDB } from "./models/database.js";
import { v4 as uuidv4 } from "uuid";
import { sendGmailEmail, draftGmailEmail } from "./services/gmailService.js";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./services/calendarService.js";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Initialize database
await initDB();

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

async function saveSession(db, sessionId, sessionState) {
  const s = JSON.stringify(sessionState);
  const row = await db.get("SELECT 1 FROM sessions WHERE session_id = ?", sessionId);
  if (row) {
    await db.run("UPDATE sessions SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?", s, sessionId);
  } else {
    await db.run("INSERT INTO sessions (session_id, state) VALUES (?, ?)", sessionId, s);
  }
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
    const db = await getDB();
    const sessionRow = await db.get("SELECT * FROM sessions WHERE session_id = ?", sessionId);
    let sessionState = sessionRow ? JSON.parse(sessionRow.state) : {};
    sessionState.activeEvents = sessionState.activeEvents || [];

    // Parse intent and fields
    const parsed = await intentHandler(message, sessionState);

    // Handle email sending intent
    if (parsed.intent === "send_email") {
      if (!parsed.email_recipient) {
        parsed.reply = "Who would you like to send the email to? Please provide their email address.";
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      if (!parsed.email_body && !parsed.email_subject) {
        parsed.reply = `What would you like to say in the email to ${parsed.email_recipient}?`;
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      try {
        // Send email via Gmail API
        const emailResult = await sendGmailEmail({
          to: parsed.email_recipient,
          subject: parsed.email_subject || "Message from AI Assistant",
          body: parsed.email_body || "Hello!"
        });

        // Log email in database for tracking
        await db.run(
          "INSERT INTO email_logs (recipient, subject, status) VALUES (?, ?, ?)",
          [parsed.email_recipient, parsed.email_subject || "Message from AI Assistant", "sent"]
        );

        parsed.reply = `Email sent to ${parsed.email_recipient} successfully!`;
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });

      } catch (emailError) {
        console.error("Email send failed:", emailError);
        parsed.reply = `Failed to send email to ${parsed.email_recipient}. Please try again or check your Gmail authorization.`;
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
    }

    // Handle create event intent
    if (parsed.intent === "create_event") {
      let currentEvent = getUnconfirmedEvent(sessionState);

      if (parsed.title || parsed.date || parsed.time) {
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

      // Merge parsed info
      currentEvent.title = parsed.title || currentEvent.title;
      currentEvent.date = parsed.date || currentEvent.date;
      currentEvent.time = parsed.time || currentEvent.time;
      currentEvent.duration_minutes = parsed.duration_minutes || currentEvent.duration_minutes;
      currentEvent.notes = parsed.notes || currentEvent.notes;

      updateEventInSession(sessionState, currentEvent);

      // Check for missing fields
      const missing = [];
      if (!currentEvent.title) missing.push("event title");
      if (!currentEvent.date) missing.push("date");
      if (!currentEvent.time) missing.push("time");

      if (missing.length) {
        parsed.reply = `Please provide the following: ${missing.join(", ")}.`;
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      // If all info present and not yet preConfirmed
      if (!currentEvent.preConfirmed) {
        currentEvent.preConfirmed = true;
        updateEventInSession(sessionState, currentEvent);
        parsed.reply = `I'll create **${currentEvent.title}** on **${formatFriendly(currentEvent.date, currentEvent.time)}**. Would you like to confirm? (yes/no)`;
        await saveSession(db, sessionId, sessionState);
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

            await saveSession(db, sessionId, sessionState);
            return res.json({ reply: replyMsg, state: sessionState, sessionId });

          } catch (calendarError) {
            console.error("Calendar event creation failed:", calendarError);
            currentEvent.preConfirmed = false;
            updateEventInSession(sessionState, currentEvent);

            let errorMessage = "Unable to create calendar event. Please try again.";
            if (calendarError.message.includes("authorization")) {
              errorMessage = "Calendar authorization expired. Please re-authorize by visiting /auth";
            }

            await saveSession(db, sessionId, sessionState);
            return res.json({ reply: errorMessage, state: sessionState, sessionId });
          }

        } else if (yn === "no") {
          currentEvent.preConfirmed = false;
          updateEventInSession(sessionState, currentEvent);
          parsed.reply = "No problem - what would you like to change? (title / date / time / notes)";
          await saveSession(db, sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        } else {
          parsed.reply = "Please reply 'yes' to confirm or 'no' to make changes.";
          await saveSession(db, sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }
      }
    }

    // Handle cancel intent
    else if (parsed.intent === "cancel") {
      // For personal productivity, we'll work with calendar events directly
      if (!sessionState.lastEvent || !sessionState.lastEvent.google_event_id) {
        parsed.reply = "I don't see any recent events to cancel. Please specify which event you'd like to cancel (title and date).";
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      try {
        // Remove from Google Calendar
        await deleteCalendarEvent(sessionState.lastEvent.google_event_id);

        // Update session state
        sessionState.activeEvents = sessionState.activeEvents.filter(e => e.google_event_id !== sessionState.lastEvent.google_event_id);
        const eventTitle = sessionState.lastEvent.title;
        const eventDate = formatFriendly(sessionState.lastEvent.date, sessionState.lastEvent.time);
        sessionState.lastEvent = null;

        let replyMsg = `Your event "${eventTitle}" on ${eventDate} has been cancelled.`;

        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: replyMsg, state: sessionState, sessionId });

      } catch (calErr) {
        console.error("Calendar delete failed:", calErr.message);
        parsed.reply = "Unable to cancel the event. Please try again or check your calendar authorization.";
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
    }

    // Handle reschedule intent
    else if (parsed.intent === "reschedule") {
      let rescheduleState = sessionState.rescheduleState || null;
      
      if (!rescheduleState) {
        rescheduleState = {
          originalAppointment: null,
          newDate: null,
          newTime: null,
          preConfirmed: false
        };
        
        // Find appointment to reschedule
        if (parsed.service && parsed.date) {
          rescheduleState.originalAppointment = await db.get(
            `SELECT * FROM appointments WHERE user_id = ? AND service = ? AND date = ?`,
            [sessionState.user_id, parsed.service, parsed.date]
          );
        }
        
        if (!rescheduleState.originalAppointment && sessionState.lastAppointment && sessionState.lastAppointment.db_id) {
          rescheduleState.originalAppointment = await db.get("SELECT * FROM appointments WHERE id = ?", sessionState.lastAppointment.db_id);
        }
        
        if (!rescheduleState.originalAppointment) {
          parsed.reply = "I couldn't find the appointment to reschedule. Please specify which appointment (service + current date).";
          await saveSession(db, sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }
      }
      
      // Update with new date/time
      rescheduleState.newDate = parsed.date || rescheduleState.newDate;
      rescheduleState.newTime = parsed.time || rescheduleState.newTime;
      sessionState.rescheduleState = rescheduleState;
      
      if (!rescheduleState.newDate || !rescheduleState.newTime) {
        parsed.reply = "What's the new date and time you'd like to move the appointment to?";
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
      
      if (!rescheduleState.preConfirmed) {
        const oldDateTime = formatFriendly(rescheduleState.originalAppointment.date, rescheduleState.originalAppointment.time);
        const newDateTime = formatFriendly(rescheduleState.newDate, rescheduleState.newTime);
        
        rescheduleState.preConfirmed = true;
        sessionState.rescheduleState = rescheduleState;
        
        parsed.reply = `I'll move your **${rescheduleState.originalAppointment.service}** from **${oldDateTime}** to **${newDateTime}**. Confirm? (yes/no)`;
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
      
      // Handle reschedule confirmation
      if (rescheduleState.preConfirmed) {
        const yn = parsed.confirmation_response || extractYesNo(message);
        
        if (yn === "yes") {
          try {
            // Update Google Calendar event
            if (rescheduleState.originalAppointment.google_event_id) {
              const start = new Date(`${rescheduleState.newDate}T${rescheduleState.newTime}:00`);
              const end = new Date(start.getTime() + (rescheduleState.originalAppointment.duration_minutes * 60000));
              
              await updateCalendarEvent({
                eventId: rescheduleState.originalAppointment.google_event_id,
                summary: `${rescheduleState.originalAppointment.service} - ${sessionState.email}`,
                startDateTime: start.toISOString(),
                endDateTime: end.toISOString()
              });
            }
            
            // Update database
            await db.run("UPDATE appointments SET date = ?, time = ?, status = ? WHERE id = ?", [
              rescheduleState.newDate, 
              rescheduleState.newTime, 
              "Rescheduled", 
              rescheduleState.originalAppointment.id
            ]);

            // Update session state
            sessionState.activeBookings = sessionState.activeBookings.map((b) => {
              if (b.db_id === rescheduleState.originalAppointment.id) {
                return { ...b, date: rescheduleState.newDate, time: rescheduleState.newTime };
              }
              return b;
            });

            if (sessionState.lastAppointment && sessionState.lastAppointment.db_id === rescheduleState.originalAppointment.id) {
              sessionState.lastAppointment.date = rescheduleState.newDate;
              sessionState.lastAppointment.time = rescheduleState.newTime;
            }

            sessionState.rescheduleState = null;

            const friendlyOld = formatFriendly(rescheduleState.originalAppointment.date, rescheduleState.originalAppointment.time);
            const friendlyNew = formatFriendly(rescheduleState.newDate, rescheduleState.newTime);
            let replyMsg = `Your ${rescheduleState.originalAppointment.service} has been moved from ${friendlyOld} to ${friendlyNew}.`;
            
            // Send reschedule email
            try {
              await sendGmailEmail({
                to: sessionState.email,
                subject: `Appointment Rescheduled: ${rescheduleState.originalAppointment.service}`,
                body: `Your ${rescheduleState.originalAppointment.service} appointment has been moved from ${friendlyOld} to ${friendlyNew}.`
              });
              replyMsg += " A confirmation email has been sent.";
            } catch (emailErr) {
              console.error("Reschedule email failed:", emailErr);
              replyMsg += " (Note: Couldn't send confirmation email)";
            }

            await saveSession(db, sessionId, sessionState);
            return res.json({ reply: replyMsg, state: sessionState, sessionId });
            
          } catch (calendarError) {
            console.error("Calendar reschedule failed:", calendarError);
            rescheduleState.preConfirmed = false;
            sessionState.rescheduleState = rescheduleState;
            
            await saveSession(db, sessionId, sessionState);
            return res.json({ reply: `Unable to reschedule in calendar: ${calendarError.message}`, state: sessionState, sessionId });
          }
          
        } else if (yn === "no") {
          rescheduleState.preConfirmed = false;
          rescheduleState.newDate = null;
          rescheduleState.newTime = null;
          sessionState.rescheduleState = rescheduleState;
          
          parsed.reply = "No problem - what's the new date and time you'd prefer?";
          await saveSession(db, sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        } else {
          parsed.reply = "Please reply 'yes' to confirm the reschedule or 'no' to choose a different time.";
          await saveSession(db, sessionId, sessionState);
          return res.json({ reply: parsed.reply, state: sessionState, sessionId });
        }
      }
    }

    // Handle check_schedule intent
    else if (parsed.intent === "check_schedule") {
      const qDate = parsed.date || new Date().toISOString().split('T')[0]; // default to today

      try {
        // This would ideally fetch from Google Calendar API
        // For now, we'll provide a simple response
        parsed.reply = `To check your schedule for ${qDate}, please visit your Google Calendar directly. I'll focus on helping you create, modify, and manage individual events through our conversation.`;

        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      } catch (error) {
        parsed.reply = "Unable to check your schedule right now. Please try again.";
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }
    }

    // Default response
    else {
      const reply = parsed.reply || "How can I help you today? I can help you create calendar events, send emails, and manage your schedule.";
      await saveSession(db, sessionId, sessionState);
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
    const db = await getDB();
    await db.run("DELETE FROM sessions");
    return res.json({ reply: "All sessions cleared!" });
  } catch (err) {
    console.error("Reset sessions error:", err);
    return res.status(500).json({ reply: "Could not clear sessions." });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("AI Productivity Agent Server is running!");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});