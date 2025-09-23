import { google } from "googleapis";
import { getAuthClient } from "../utils/googleAuth.js";

export async function createCalendarEvent({ 
  summary, 
  description = "", 
  startDateTime, 
  endDateTime, 
  attendeeEmail = null 
}) {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const event = {
      summary: summary,
      description: description,
      start: { 
        dateTime: startDateTime, 
        timeZone: "Australia/Sydney" 
      },
      end: { 
        dateTime: endDateTime, 
        timeZone: "Australia/Sydney" 
      }
    };

    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail }];
    }

    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event
    });

    console.log("Calendar event created:", response.data.id);
    return { success: true, eventId: response.data.id, event: response.data };
    
  } catch (error) {
    console.error("Calendar API error:", error);
    throw new Error(`Failed to create calendar event: ${error.message}`);
  }
}

export async function updateCalendarEvent({ eventId, summary, startDateTime, endDateTime }) {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.events.update({
      calendarId: "primary",
      eventId: eventId,
      resource: {
        summary: summary,
        start: { dateTime: startDateTime, timeZone: "Australia/Sydney" },
        end: { dateTime: endDateTime, timeZone: "Australia/Sydney" }
      }
    });

    return { success: true, event: response.data };
  } catch (error) {
    console.error("Calendar update error:", error);
    throw new Error(`Failed to update calendar event: ${error.message}`);
  }
}

export async function deleteCalendarEvent(eventId) {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({
      calendarId: "primary",
      eventId: eventId
    });

    return { success: true };
  } catch (error) {
    console.error("Calendar delete error:", error);
    throw new Error(`Failed to delete calendar event: ${error.message}`);
  }
}