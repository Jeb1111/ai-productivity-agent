import fs from "fs";
import path from "path";
import { google } from "googleapis";

const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

export function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Credentials file not found at ${CREDENTIALS_PATH}. Please download from Google Cloud Console.`);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
}

export function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
  console.log("Token stored to", TOKEN_PATH);
}

export function getAuthClient() {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.web;

  // Check for placeholder values
  if (client_id.includes('REPLACE_WITH_YOUR_CLIENT_ID') ||
      client_secret.includes('REPLACE_WITH_YOUR_CLIENT_SECRET')) {
    throw new Error('Please replace placeholder values in credentials.json with actual Google OAuth credentials from Google Cloud Console');
  }

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
  }

  return oAuth2Client;
}