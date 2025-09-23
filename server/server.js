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

function updateBookingInSession(sessionState, booking) {
  if (!booking.id) booking.id = uuidv4();
  const idx = sessionState.activeBookings.findIndex((b) => b.id === booking.id);
  if (idx === -1) sessionState.activeBookings.push(booking);
  else sessionState.activeBookings[idx] = booking;
  return sessionState;
}

function getUnconfirmedBooking(sessionState) {
  return sessionState.activeBookings.find((b) => !b.confirmed) || null;
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
    sessionState.activeBookings = sessionState.activeBookings || [];

    // Parse intent and fields
    const parsed = await intentHandler(message, sessionState);

    // Handle email if provided by parser
    if (parsed.email && parsed.email !== sessionState.email) {
      let userRow = await db.get("SELECT * FROM users WHERE email = ?", parsed.email);
      if (!userRow) {
        const r = await db.run("INSERT INTO users (email) VALUES (?)", parsed.email);
        sessionState.user_id = r.lastID;
      } else {
        sessionState.user_id = userRow.id;
      }
      sessionState.email = parsed.email;
    }

    // If no email, ask for it
    if (!sessionState.email && parsed.intent !== "send_email") {
      const askEmailReply = parsed.reply || "I need your email before I can help with bookings. Could you share it please?";
      await saveSession(db, sessionId, sessionState);
      return res.json({ reply: askEmailReply, state: sessionState, sessionId });
    }

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

        // Log email in database if user is authenticated
        if (sessionState.user_id) {
          await db.run(
            "INSERT INTO email_logs (user_id, recipient, subject, status) VALUES (?, ?, ?, ?)",
            [sessionState.user_id, parsed.email_recipient, parsed.email_subject || "Message from AI Assistant", "sent"]
          );
        }

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

    // Handle booking intent
    if (parsed.intent === "book") {
      let currentBooking = getUnconfirmedBooking(sessionState);
      
      if (parsed.service || parsed.date || parsed.time) {
        if (currentBooking && !currentBooking.preConfirmed) {
          sessionState.activeBookings = sessionState.activeBookings.filter(b => b.confirmed);
          currentBooking = null;
        }
      }
      
      if (!currentBooking) {
        currentBooking = {
          id: uuidv4(),
          service: null,
          date: null,
          time: null,
          duration_minutes: 60,
          notes: null,
          preConfirmed: false,
          confirmed: false,
          db_id: null,
          google_event_id: null
        };
      }

      // Merge parsed info
      currentBooking.service = parsed.service || currentBooking.service;
      currentBooking.date = parsed.date || currentBooking.date;
      currentBooking.time = parsed.time || currentBooking.time;
      currentBooking.duration_minutes = parsed.duration_minutes || currentBooking.duration_minutes;
      currentBooking.notes = parsed.notes || currentBooking.notes;

      updateBookingInSession(sessionState, currentBooking);

      // Check for missing fields
      const missing = [];
      if (!currentBooking.service) missing.push("service");
      if (!currentBooking.date) missing.push("date");
      if (!currentBooking.time) missing.push("time");

      if (missing.length) {
        parsed.reply = `Please provide the following: ${missing.join(", ")}.`;
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      // If all info present and not yet preConfirmed
      if (!currentBooking.preConfirmed) {
        currentBooking.preConfirmed = true;
        updateBookingInSession(sessionState, currentBooking);
        parsed.reply = `I'll book a **${currentBooking.service}** on **${formatFriendly(currentBooking.date, currentBooking.time)}**. Would you like to confirm? (yes/no)`;
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      // Handle confirmation
      if (currentBooking.preConfirmed && !currentBooking.confirmed) {
        const yn = parsed.confirmation_response || extractYesNo(message);
        if (yn === "yes") {
          try {
            // Create Google Calendar event
            const start = new Date(`${currentBooking.date}T${currentBooking.time}:00`);
            const end = new Date(start.getTime() + (currentBooking.duration_minutes || 60) * 60000);

            const calendarResult = await createCalendarEvent({
              summary: `${currentBooking.service} - ${sessionState.email}`,
              description: currentBooking.notes || "",
              startDateTime: start.toISOString(),
              endDateTime: end.toISOString(),
              attendeeEmail: sessionState.email
            });

            currentBooking.google_event_id = calendarResult.eventId;

            // Save to database
            const insert = await db.run(
              `INSERT INTO appointments (user_id, service, date, time, duration_minutes, notes, google_event_id, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                sessionState.user_id,
                currentBooking.service,
                currentBooking.date,
                currentBooking.time,
                currentBooking.duration_minutes || 60,
                currentBooking.notes || "",
                currentBooking.google_event_id,
                "Booked"
              ]
            );

            currentBooking.confirmed = true;
            currentBooking.db_id = insert.lastID;
            sessionState.lastAppointment = { ...currentBooking };

            updateBookingInSession(sessionState, currentBooking);

            let replyMsg = `Your ${currentBooking.service} is confirmed for ${formatFriendly(currentBooking.date, currentBooking.time)}.`;
            
            // Send notification email
            try {
              await sendGmailEmail({
                to: sessionState.email,
                subject: `Appointment Confirmed: ${currentBooking.service}`,
                body: `Your ${currentBooking.service} appointment is confirmed for ${formatFriendly(currentBooking.date, currentBooking.time)}.\n\nWe look forward to seeing you!`
              });
              replyMsg += " A confirmation email has been sent.";
            } catch (emailErr) {
              console.error("Confirmation email failed:", emailErr);
              replyMsg += " (Note: Couldn't send confirmation email)";
            }

            await saveSession(db, sessionId, sessionState);
            return res.json({ reply: replyMsg, state: sessionState, sessionId });

          } catch (calendarError) {
            console.error("Calendar booking failed:", calendarError);
            currentBooking.preConfirmed = false;
            updateBookingInSession(sessionState, currentBooking);
            
            let errorMessage = "Unable to create calendar event. Please try again.";
            if (calendarError.message.includes("authorization")) {
              errorMessage = "Calendar authorization expired. Please re-authorize by visiting /auth";
            }

            await saveSession(db, sessionId, sessionState);
            return res.json({ reply: errorMessage, state: sessionState, sessionId });
          }
          
        } else if (yn === "no") {
          currentBooking.preConfirmed = false;
          updateBookingInSession(sessionState, currentBooking);
          parsed.reply = "No problem - what would you like to change? (service / date / time / notes)";
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
      let appointmentRow = null;
      if (parsed.service && parsed.date) {
        appointmentRow = await db.get(
          `SELECT * FROM appointments WHERE user_id = ? AND service = ? AND date = ?`,
          [sessionState.user_id, parsed.service, parsed.date]
        );
      }

      if (!appointmentRow && sessionState.lastAppointment && sessionState.lastAppointment.db_id) {
        appointmentRow = await db.get("SELECT * FROM appointments WHERE id = ?", sessionState.lastAppointment.db_id);
      }

      if (!appointmentRow) {
        parsed.reply = "I couldn't find that appointment. Which appointment would you like to cancel? (please specify service and date)";
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      try {
        // Remove from Google Calendar if event exists
        if (appointmentRow.google_event_id) {
          await deleteCalendarEvent(appointmentRow.google_event_id);
        }
      } catch (calErr) {
        console.warn("Calendar delete failed:", calErr.message);
      }

      // Delete from database
      await db.run("DELETE FROM appointments WHERE id = ?", appointmentRow.id);

      // Update session state
      sessionState.activeBookings = sessionState.activeBookings.filter(b => b.db_id !== appointmentRow.id);
      if (sessionState.lastAppointment && sessionState.lastAppointment.db_id === appointmentRow.id) {
        sessionState.lastAppointment = null;
      }

      let replyMsg = `Your ${appointmentRow.service} on ${formatFriendly(appointmentRow.date, appointmentRow.time)} has been cancelled.`;
      
      // Send cancellation email
      try {
        await sendGmailEmail({
          to: sessionState.email,
          subject: `Appointment Cancelled: ${appointmentRow.service}`,
          body: `Your ${appointmentRow.service} appointment scheduled for ${formatFriendly(appointmentRow.date, appointmentRow.time)} has been cancelled.`
        });
        replyMsg += " A confirmation email has been sent.";
      } catch (emailErr) {
        console.error("Cancellation email failed:", emailErr);
        replyMsg += " (Note: Couldn't send confirmation email)";
      }

      await saveSession(db, sessionId, sessionState);
      return res.json({ reply: replyMsg, state: sessionState, sessionId });
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

    // Handle ask/check intent
    else if (parsed.intent === "ask") {
      const qDate = parsed.date || sessionState.lastAppointment?.date;
      if (!qDate) {
        parsed.reply = "Which date would you like me to check?";
        await saveSession(db, sessionId, sessionState);
        return res.json({ reply: parsed.reply, state: sessionState, sessionId });
      }

      const appts = await db.all("SELECT * FROM appointments WHERE user_id = ? AND date = ?", [sessionState.user_id, qDate]);
      if (!appts || appts.length === 0) {
        parsed.reply = `You don't have any appointments on ${qDate}.`;
      } else {
        const list = appts.map(a => `${a.service} at ${a.time}${a.notes ? " - " + a.notes : ""}`).join("\n");
        parsed.reply = `Here are your appointments on ${qDate}:\n${list}`;
      }

      await saveSession(db, sessionId, sessionState);
      return res.json({ reply: parsed.reply, state: sessionState, sessionId });
    }

    // Default response
    else {
      const reply = parsed.reply || "How can I help you today? I can help with booking appointments, sending emails, and managing your schedule.";
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