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

export async function searchCalendarEvents(titleQuery = null, maxResults = 50) {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const params = {
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults: maxResults,
      singleEvents: true,
      orderBy: "startTime"
    };

    if (titleQuery) {
      params.q = titleQuery;
    }

    const response = await calendar.events.list(params);
    const events = response.data.items || [];

    return events.map(event => {
      const startDateTime = event.start?.dateTime || event.start?.date;
      const endDateTime = event.end?.dateTime || event.end?.date;

      // Calculate duration in minutes
      let duration_minutes = 60; // Default duration
      if (startDateTime && endDateTime) {
        const start = new Date(startDateTime);
        const end = new Date(endDateTime);
        duration_minutes = Math.round((end.getTime() - start.getTime()) / (1000 * 60));
      }

      return {
        eventId: event.id,
        summary: event.summary || 'No title',
        startDateTime: startDateTime,
        endDateTime: endDateTime,
        duration_minutes: duration_minutes,
        description: event.description || null
      };
    });

  } catch (error) {
    console.error("Calendar search error:", error);
    throw new Error(`Failed to search calendar events: ${error.message}`);
  }
}

export async function getEventsForDateRange(startDate, endDate = null) {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    // If no end date provided, use end of start date
    const timeMin = new Date(startDate);
    timeMin.setHours(0, 0, 0, 0);

    const timeMax = endDate ? new Date(endDate) : new Date(startDate);
    timeMax.setHours(23, 59, 59, 999);

    const params = {
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    };

    const response = await calendar.events.list(params);
    const events = response.data.items || [];

    return events.map(event => {
      const startDateTime = event.start?.dateTime || event.start?.date;
      const endDateTime = event.end?.dateTime || event.end?.date;

      // Calculate duration in minutes
      let duration_minutes = 60; // Default duration
      if (startDateTime && endDateTime) {
        const start = new Date(startDateTime);
        const end = new Date(endDateTime);
        duration_minutes = Math.round((end.getTime() - start.getTime()) / (1000 * 60));
      }

      return {
        eventId: event.id,
        summary: event.summary || 'No title',
        startDateTime: startDateTime,
        endDateTime: endDateTime,
        duration_minutes: duration_minutes,
        description: event.description || null,
        location: event.location || null
      };
    });

  } catch (error) {
    console.error("Calendar get events error:", error);
    throw new Error(`Failed to get calendar events: ${error.message}`);
  }
}