import { google } from "googleapis";
import { getAuthClient } from "../utils/googleAuth.js";

export async function sendGmailEmail({ to, subject, body, from = null }) {
  try {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    // Create email message
    const messageParts = [
      from ? `From: ${from}` : '',
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].filter(part => part !== '').join('\n');

    // Encode message in base64
    const encodedMessage = Buffer.from(messageParts)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send email
    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    console.log(`Email sent to ${to}:`, response.data.id);
    return { success: true, messageId: response.data.id };
    
  } catch (error) {
    console.error("Gmail API error:", error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

export async function draftGmailEmail({ to, subject, body }) {
  try {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].join('\n');

    const encodedMessage = Buffer.from(messageParts)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedMessage
        }
      }
    });

    console.log(`Draft created for ${to}:`, response.data.id);
    return { success: true, draftId: response.data.id };
    
  } catch (error) {
    console.error("Gmail draft error:", error);
    throw new Error(`Failed to create draft: ${error.message}`);
  }
}