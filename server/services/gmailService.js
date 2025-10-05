import { google } from "googleapis";
import { getAuthClient } from "../utils/googleAuth.js";

export async function sendGmailEmail({ to, subject, body, from = null }) {
  try {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    // Create RFC 2822 compliant email message
    const headers = [];
    if (from) {
      headers.push(`From: ${from}`);
    }
    headers.push(`To: ${to}`);
    headers.push(`Subject: ${subject}`);
    headers.push('MIME-Version: 1.0');
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 7bit');

    // Join headers and add double CRLF before body (RFC 2822 requirement)
    const messageParts = headers.join('\r\n') + '\r\n\r\n' + body;

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

    // Create RFC 2822 compliant email message
    const headers = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit'
    ];

    // Join headers and add double CRLF before body (RFC 2822 requirement)
    const messageParts = headers.join('\r\n') + '\r\n\r\n' + body;

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