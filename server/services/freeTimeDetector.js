/**
 * Free Time Detection Service (Phase 2, Step 2.2)
 *
 * Analyzes user's calendar and finds available time slots that match
 * goal's time preferences and duration requirements.
 */

// ============ TIME SLOT DEFINITIONS ============

const TIME_SLOTS = {
  morning: { start: '06:00', end: '12:00' },
  afternoon: { start: '12:00', end: '18:00' },
  evening: { start: '18:00', end: '22:00' }
};

// ============ HELPER FUNCTIONS ============

/**
 * Convert time string to minutes since midnight
 * @param {string} timeString - Format: 'HH:MM' (e.g., '07:30')
 * @returns {number} Minutes since midnight
 */
function timeToMinutes(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Convert minutes since midnight to time string
 * @param {number} minutes - Minutes since midnight
 * @returns {string} Time string in 'HH:MM' format
 */
function minutesToTime(minutes) {
  // Handle overflow past midnight (e.g., 1440+ minutes wraps to next day)
  const totalMinutes = minutes % 1440; // 1440 = 24 hours in minutes
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Add minutes to a time string
 * @param {string} timeString - Format: 'HH:MM'
 * @param {number} minutesToAdd - Minutes to add
 * @returns {string} New time string
 */
function addMinutes(timeString, minutesToAdd) {
  const totalMinutes = timeToMinutes(timeString) + minutesToAdd;
  return minutesToTime(totalMinutes);
}

/**
 * Check if a date is a weekend (Saturday or Sunday)
 * @param {string} dateString - Format: 'YYYY-MM-DD'
 * @returns {boolean} True if weekend
 */
function isWeekend(dateString) {
  const date = new Date(dateString + 'T12:00:00'); // Use noon to avoid timezone issues
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

/**
 * Check if a date is today
 * @param {string} dateString - Format: 'YYYY-MM-DD'
 * @returns {boolean} True if today
 */
function isToday(dateString) {
  const today = new Date().toISOString().split('T')[0];
  return dateString === today;
}

/**
 * Check if a time slot is in the past
 * @param {string} date - Format: 'YYYY-MM-DD'
 * @param {string} startTime - Format: 'HH:MM'
 * @returns {boolean} True if slot is in the past
 */
function isTooLate(date, startTime) {
  const now = new Date();
  const slotStart = new Date(`${date}T${startTime}:00`);

  // Add buffer: don't suggest slots starting in the next 30 minutes
  const bufferMs = 30 * 60 * 1000;
  return slotStart.getTime() <= (now.getTime() + bufferMs);
}

/**
 * Check if two time ranges overlap
 * @param {Date} start1 - Start of first range
 * @param {Date} end1 - End of first range
 * @param {Date} start2 - Start of second range
 * @param {Date} end2 - End of second range
 * @returns {boolean} True if ranges overlap
 */
function doTimesOverlap(start1, end1, start2, end2) {
  // No overlap if one range ends before the other starts
  const noOverlap = (end1 <= start2) || (start1 >= end2);
  return !noOverlap;
}

// ============ CORE LOGIC FUNCTIONS ============

/**
 * Calculate duration needed in minutes from goal's target
 * @param {Object} goal - Goal object with target_amount and target_unit
 * @returns {number} Duration in minutes
 */
function calculateDurationMinutes(goal) {
  if (!goal.target_amount || !goal.target_unit) {
    return 60; // Default: 1 hour
  }

  const unitToMinutes = {
    'hour': 60,
    'hours': 60,
    'hr': 60,
    'hrs': 60,
    'minute': 1,
    'minutes': 1,
    'min': 1,
    'mins': 1,
    'km': 30,        // Assume 30 min per km for running
    'kilometer': 30,
    'kilometers': 30,
    'mile': 45,      // Assume 45 min per mile for running
    'miles': 45,
    'page': 2,       // Assume 2 min per page for reading
    'pages': 2,
    'chapter': 30,   // Assume 30 min per chapter
    'chapters': 30
  };

  const unit = goal.target_unit.toLowerCase();
  const multiplier = unitToMinutes[unit] || 60; // Default to 60 if unknown

  return goal.target_amount * multiplier;
}

/**
 * Generate array of dates for the next N days
 * @param {number} daysAhead - Number of days to look ahead
 * @returns {string[]} Array of date strings in 'YYYY-MM-DD' format
 */
function getDateRange(daysAhead = 7) {
  const dates = [];
  const today = new Date();

  for (let i = 0; i < daysAhead; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  return dates;
}

/**
 * Check if a specific time slot is free (no calendar conflicts)
 * @param {string} date - Format: 'YYYY-MM-DD'
 * @param {string} startTime - Format: 'HH:MM'
 * @param {string} endTime - Format: 'HH:MM'
 * @param {Array} calendarEvents - Array of calendar events
 * @returns {boolean} True if slot is free
 */
function isSlotFree(date, startTime, endTime, calendarEvents) {
  const slotStart = new Date(`${date}T${startTime}:00`);
  const slotEnd = new Date(`${date}T${endTime}:00`);

  // Check against all calendar events
  for (const event of calendarEvents) {
    if (!event.startDateTime || !event.endDateTime) continue;

    const eventStart = new Date(event.startDateTime);
    const eventEnd = new Date(event.endDateTime);

    // Check if there's an overlap
    if (doTimesOverlap(slotStart, slotEnd, eventStart, eventEnd)) {
      return false; // Overlap detected, slot is NOT free
    }
  }

  return true; // No overlaps, slot is free
}

/**
 * Find all free blocks within a time slot (morning/afternoon/evening)
 * @param {string} date - Format: 'YYYY-MM-DD'
 * @param {string} slotName - 'morning', 'afternoon', or 'evening'
 * @param {Object} slotTimes - Object with start and end times
 * @param {number} durationMinutes - Required duration in minutes
 * @param {Array} calendarEvents - Array of calendar events
 * @returns {Array} Array of free time blocks
 */
function findFreeBlocks(date, slotName, slotTimes, durationMinutes, calendarEvents) {
  const blocks = [];
  const slotStartMinutes = timeToMinutes(slotTimes.start);
  const slotEndMinutes = timeToMinutes(slotTimes.end);

  // Can't fit the duration in this time slot at all
  if (durationMinutes > (slotEndMinutes - slotStartMinutes)) {
    return blocks;
  }

  // Search in 30-minute increments
  const INCREMENT = 30;
  let currentMinutes = slotStartMinutes;

  while (currentMinutes + durationMinutes <= slotEndMinutes) {
    const startTime = minutesToTime(currentMinutes);
    const endTime = minutesToTime(currentMinutes + durationMinutes);

    // Skip if in the past
    if (isTooLate(date, startTime)) {
      currentMinutes += INCREMENT;
      continue;
    }

    // Check if this block is free
    if (isSlotFree(date, startTime, endTime, calendarEvents)) {
      blocks.push({
        date,
        startTime,
        endTime,
        slot: slotName,
        durationMinutes
      });
    }

    currentMinutes += INCREMENT;
  }

  return blocks;
}

/**
 * Calculate number of events needed based on goal frequency and deadline
 * @param {Object} goal - Goal with frequency and deadline fields
 * @param {string} firstDate - First event date in YYYY-MM-DD format
 * @returns {number} Number of events to schedule
 */
function calculateEventCount(goal, firstDate) {
  if (!goal.frequency) return 1;

  const freq = goal.frequency.toLowerCase();

  // Calculate max events based on frequency (default: cap at 4 weeks)
  let maxEvents = 1;
  if (freq === 'daily' || freq === 'every day') maxEvents = 28; // 4 weeks of daily
  else if (freq === 'weekly' || freq === 'every week') maxEvents = 4; // 4 weeks
  else if (freq.includes('3') && freq.includes('week')) maxEvents = 12; // 3x/week for 4 weeks
  else if (freq.includes('2') && freq.includes('week')) maxEvents = 8;  // 2x/week for 4 weeks

  // If no deadline, return max events (capped at 4 weeks)
  if (!goal.deadline) return maxEvents;

  // Calculate events that fit before deadline (inclusive)
  const start = new Date(firstDate + 'T00:00:00');
  const deadline = new Date(goal.deadline);
  deadline.setHours(23, 59, 59, 999); // End of deadline day (inclusive)

  // Calculate days INCLUDING both start and end dates
  // Example: Oct 9 to Oct 15 = 7 days (9,10,11,12,13,14,15)
  const daysUntilDeadline = Math.round((deadline - start) / (1000 * 60 * 60 * 24)) + 1;

  if (daysUntilDeadline <= 0) return 1; // Deadline already passed, schedule at least 1

  // Calculate how many events can fit before deadline
  let eventsBeforeDeadline = maxEvents;

  if (freq === 'daily' || freq === 'every day') {
    // Daily: one event per day up to and including deadline
    eventsBeforeDeadline = Math.min(maxEvents, daysUntilDeadline);
  } else if (freq === 'weekly' || freq === 'every week') {
    // Weekly: round up to include partial weeks
    const weeksUntilDeadline = Math.ceil(daysUntilDeadline / 7);
    eventsBeforeDeadline = Math.min(maxEvents, weeksUntilDeadline);
  } else if (freq.includes('3') && freq.includes('week')) {
    const weeksUntilDeadline = Math.ceil(daysUntilDeadline / 7);
    eventsBeforeDeadline = Math.min(maxEvents, weeksUntilDeadline * 3);
  } else if (freq.includes('2') && freq.includes('week')) {
    const weeksUntilDeadline = Math.ceil(daysUntilDeadline / 7);
    eventsBeforeDeadline = Math.min(maxEvents, weeksUntilDeadline * 2);
  }

  return Math.max(1, eventsBeforeDeadline); // Return at least 1 event
}

/**
 * Get dates for recurring events based on frequency and deadline
 * @param {string} frequency - Goal frequency
 * @param {string} firstDate - Starting date in YYYY-MM-DD format
 * @param {Array} validDates - Available dates to choose from
 * @param {string} deadline - Deadline date in ISO format (optional)
 * @param {number} maxCount - Maximum number of events to generate
 * @returns {Array} Array of date strings
 */
function getRecurringDates(frequency, firstDate, validDates, deadline = null, maxCount = 100) {
  if (!frequency) return [firstDate];

  const freq = frequency.toLowerCase();
  const dates = [];
  const startIndex = validDates.indexOf(firstDate);

  if (startIndex === -1) return [firstDate];

  // Parse deadline if provided (set to end of deadline day to be inclusive)
  const deadlineDate = deadline ? new Date(deadline) : null;
  if (deadlineDate) {
    deadlineDate.setHours(23, 59, 59, 999); // End of deadline day
  }

  // Helper to check if date is on or before deadline (inclusive)
  const isBeforeDeadline = (dateStr) => {
    if (!deadlineDate) return true;
    const date = new Date(dateStr + 'T00:00:00'); // Start of event day
    const result = date <= deadlineDate;
    console.log(`[DEBUG DEADLINE] Checking ${dateStr}: date=${date.toISOString()}, deadline=${deadlineDate.toISOString()}, allowed=${result}`);
    return result;
  };

  if (freq === 'daily' || freq === 'every day') {
    // One per day
    for (let i = 0; i < maxCount && (startIndex + i) < validDates.length; i++) {
      const date = validDates[startIndex + i];
      if (isBeforeDeadline(date)) {
        dates.push(date);
      } else {
        break; // Stop if we've passed the deadline
      }
    }
  } else if (freq === 'weekly' || freq === 'every week') {
    // One per week
    for (let i = 0; i < maxCount; i++) {
      const dateIndex = startIndex + (i * 7);
      if (dateIndex < validDates.length) {
        const date = validDates[dateIndex];
        if (isBeforeDeadline(date)) {
          dates.push(date);
        } else {
          break;
        }
      }
    }
  } else if (freq.includes('3') && freq.includes('week')) {
    // 3x per week
    for (let week = 0; week < Math.ceil(maxCount / 3); week++) {
      for (let session = 0; session < 3; session++) {
        if (dates.length >= maxCount) break;
        const dateIndex = startIndex + (week * 7) + (session * 2);
        if (dateIndex < validDates.length) {
          const date = validDates[dateIndex];
          if (isBeforeDeadline(date)) {
            dates.push(date);
          } else {
            return dates; // Stop completely if past deadline
          }
        }
      }
      if (dates.length >= maxCount) break;
    }
  } else if (freq.includes('2') && freq.includes('week')) {
    // 2x per week
    for (let week = 0; week < Math.ceil(maxCount / 2); week++) {
      for (let session = 0; session < 2; session++) {
        if (dates.length >= maxCount) break;
        const dateIndex = startIndex + (week * 7) + (session * 3);
        if (dateIndex < validDates.length) {
          const date = validDates[dateIndex];
          if (isBeforeDeadline(date)) {
            dates.push(date);
          } else {
            return dates; // Stop completely if past deadline
          }
        }
      }
      if (dates.length >= maxCount) break;
    }
  } else {
    dates.push(firstDate);
  }

  return dates;
}

/**
 * Main function: Detect free time slots based on calendar and goal
 * Returns 3 time alternatives (morning/afternoon/evening) with recommended dates
 * @param {Array} calendarEvents - Array of calendar events
 * @param {Object} goal - Goal object with preferences
 * @param {Object} options - Optional settings
 * @returns {Promise<Object>} Object with timeOptions array
 */
async function detectFreeTimeSlots(calendarEvents, goal, options = {}) {
  const {
    daysAhead = 28 // Extended to 4 weeks for weekly recurring goals
  } = options;

  // 1. Calculate duration needed
  const durationMinutes = calculateDurationMinutes(goal);

  // 2. Get time preferences (default to all if empty)
  let timePreferences = goal.time_preferences || [];
  if (timePreferences.length === 0) {
    timePreferences = ['morning', 'afternoon', 'evening'];
  }

  // 3. Check if weekend-only preference
  const weekendOnly = timePreferences.includes('weekend');

  // 4. Remove 'weekend' from time slots to check (it's a filter, not a time slot)
  const timeSlotsToCheck = timePreferences.filter(pref => pref !== 'weekend');

  // If only 'weekend' was selected, check all time slots but only on weekends
  if (timeSlotsToCheck.length === 0) {
    timeSlotsToCheck.push('morning', 'afternoon', 'evening');
  }

  // 5. Get date range
  const allDates = getDateRange(daysAhead);

  // 6. Filter dates by weekend preference
  const validDates = weekendOnly
    ? allDates.filter(d => isWeekend(d))
    : allDates;

  // 7. Find free slots per day for each time preference
  // Option 3: Support multiple sessions per day
  const maxSessionsPerDay = goal.max_sessions_per_day || 1;

  const slotsByPreference = {
    morning: [],
    afternoon: [],
    evening: []
  };

  for (const date of validDates) {
    for (const pref of ['morning', 'afternoon', 'evening']) {
      const slotTimes = TIME_SLOTS[pref];
      if (!slotTimes) continue;

      const freeBlocks = findFreeBlocks(
        date,
        pref,
        slotTimes,
        durationMinutes,
        calendarEvents
      );

      // Take up to maxSessionsPerDay slots for this date+preference
      // For multi-session support, we store all available slots for this day
      if (freeBlocks.length > 0) {
        slotsByPreference[pref].push({
          date: date,
          slots: freeBlocks.slice(0, maxSessionsPerDay) // Limit to max sessions
        });
      }
    }
  }

  // 8. Build 3 time alternatives
  const timeOptions = [];

  // Determine which preferences to show (prioritize user's selection)
  const preferenceOrder = [];
  if (timeSlotsToCheck.includes('morning')) preferenceOrder.push('morning');
  if (timeSlotsToCheck.includes('afternoon')) preferenceOrder.push('afternoon');
  if (timeSlotsToCheck.includes('evening')) preferenceOrder.push('evening');

  // Fill remaining slots
  if (!preferenceOrder.includes('morning')) preferenceOrder.push('morning');
  if (!preferenceOrder.includes('afternoon')) preferenceOrder.push('afternoon');
  if (!preferenceOrder.includes('evening')) preferenceOrder.push('evening');

  // Get first available slot across all preferences to calculate max event count
  let firstAvailableDate = null;
  for (const pref of preferenceOrder) {
    const slots = slotsByPreference[pref];
    if (slots.length > 0) {
      firstAvailableDate = slots[0].date;
      break;
    }
  }

  // Calculate max event count based on frequency and deadline
  const maxEventCount = firstAvailableDate
    ? calculateEventCount(goal, firstAvailableDate)
    : 1;

  // Create option for each preference
  // Option 3: Build events with multi-session support
  for (const pref of preferenceOrder.slice(0, 3)) {
    const daySlots = slotsByPreference[pref]; // Array of {date, slots: []}

    if (daySlots.length === 0) continue;

    // Get first available date
    const firstDaySlot = daySlots[0];

    // Calculate how many total sessions needed based on goal
    // For multi-session goals (with session_duration), calculate sessions needed
    // For regular recurring goals (daily/weekly), use maxEventCount
    let totalSessionsNeeded;

    if (goal.session_duration && goal.target_amount) {
      // Multi-session goal: "Study 10 hours in 2-hour sessions" = 5 sessions
      const sessionDuration = goal.session_duration;
      const targetAmount = goal.target_amount;
      totalSessionsNeeded = Math.ceil(targetAmount / sessionDuration);
    } else {
      // Regular recurring goal: "Learn French daily" = maxEventCount sessions
      totalSessionsNeeded = maxEventCount;
    }

    // Calculate recurring dates (respecting deadline)
    const recurringDates = getRecurringDates(
      goal.frequency,
      firstDaySlot.date,
      validDates,
      goal.deadline,
      maxEventCount
    );

    // Build events for this time option with multi-session support
    const events = [];
    const distributionStrategy = goal.distribution_strategy || 'spread_evenly';

    for (const date of recurringDates) {
      // Find all slots for this date and preference
      const daySlotEntry = daySlots.find(s => s.date === date);

      if (daySlotEntry && daySlotEntry.slots) {
        // Add sessions for this day based on distribution strategy
        const sessionsToAdd = distributionStrategy === 'finish_quickly'
          ? daySlotEntry.slots.length  // Use all available slots
          : Math.min(maxSessionsPerDay, daySlotEntry.slots.length); // Spread evenly: respect max_sessions_per_day

        for (let i = 0; i < sessionsToAdd && events.length < totalSessionsNeeded; i++) {
          const slot = daySlotEntry.slots[i];
          events.push({
            date: slot.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            durationMinutes: slot.durationMinutes
          });
        }
      } else {
        // If no slot found for this exact preference, try alternative time preferences
        for (const altPref of ['morning', 'afternoon', 'evening']) {
          if (altPref === pref) continue;

          const altDaySlots = slotsByPreference[altPref];
          const altDaySlotEntry = altDaySlots.find(s => s.date === date);

          if (altDaySlotEntry && altDaySlotEntry.slots && altDaySlotEntry.slots.length > 0) {
            const slot = altDaySlotEntry.slots[0];
            events.push({
              date: slot.date,
              startTime: slot.startTime,
              endTime: slot.endTime,
              durationMinutes: slot.durationMinutes
            });
            break;
          }
        }
      }

      if (events.length >= totalSessionsNeeded) break;
    }

    console.log(`[DEBUG] ${pref}: found ${events.length} events (needed ${totalSessionsNeeded})`);

    if (events.length > 0) {
      timeOptions.push({
        timeSlot: pref,
        label: pref.charAt(0).toUpperCase() + pref.slice(1),
        events: events,
        totalEvents: events.length,
        totalHours: (events.length * durationMinutes) / 60 // Add total hours for display
      });
    }
  }

  console.log(`[DEBUG] Final timeOptions count: ${timeOptions.length}`);

  return {
    timeOptions,
    eventCount: maxEventCount,
    frequency: goal.frequency || 'one-time'
  };
}

// ============ EXPORTS ============

export {
  detectFreeTimeSlots,
  calculateDurationMinutes,
  isSlotFree,
  findFreeBlocks,
  timeToMinutes,
  minutesToTime,
  addMinutes,
  isWeekend,
  TIME_SLOTS
};
