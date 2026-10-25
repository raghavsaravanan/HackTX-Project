// macOS Messages and Contacts through AppleScript (osascript). No external SMS service: messages
// go out from the laptop's own Messages app, as iMessage or (with Text Message Forwarding from an
// iPhone) as SMS. User text is always passed as script arguments, never spliced into the script.
import { execFile } from "node:child_process";
import { config } from "../config.ts";

export type MessageService = "iMessage" | "SMS";

export interface ContactHandle {
  name: string;
  /** Phone number or email address Messages can send to. */
  handle: string;
  kind: "phone" | "email";
  /** "mobile", "iPhone", "home", ... (cleaned from the Contacts label). */
  label: string;
}

/** A failure the player should hear about in plain words. */
export class MessagesError extends Error {
  constructor(
    message: string,
    readonly spoken: string,
  ) {
    super(message);
  }
}

export const messagesAvailable = () => process.platform === "darwin" && config.share.enabled;

const digits = (handle: string) => handle.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** The single allowed recipient from SHARE_ONLY_TO, or null when any contact may be chosen. */
export function onlyRecipient(): ContactHandle | null {
  const raw = config.share.onlyTo;
  if (!raw) return null;
  const [name, handle] = raw.includes("=") ? raw.split("=", 2).map((p) => p.trim()) : ["you", raw];
  if (!handle) return null;
  return { name: name || "you", handle, kind: handle.includes("@") ? "email" : "phone", label: "only" };
}

/** True when SHARE_ONLY_TO is set and `handle` is not that recipient. */
export function blockedRecipient(handle: string): boolean {
  const only = onlyRecipient();
  if (!only) return false;
  return only.kind === "email" ? only.handle.toLowerCase() !== handle.trim().toLowerCase() : digits(only.handle) !== digits(handle);
}

function osascript(script: string, args: string[], timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(explain(err, stderr));
      else resolve(stdout.trim());
    });
  });
}

/** Turn AppleScript failures into something the player can act on. */
function explain(err: Error & { killed?: boolean }, stderr: string): MessagesError {
  const detail = `${stderr || err.message}`.trim();
  if (err.killed) {
    return new MessagesError(`osascript timed out: ${detail}`, "The Mac didn't respond in time. If a permission prompt is open on the laptop, someone needs to click Allow.");
  }
  if (/-1743|not authori[sz]ed|not allowed/i.test(detail)) {
    return new MessagesError(
      `automation not authorized: ${detail}`,
      "The laptop hasn't given me permission to use Messages or Contacts yet. On the Mac, open System Settings, then Privacy and Security, then Automation, and allow it.",
    );
  }
  if (/-1728|-1719|can.t get (account|participant|buddy)/i.test(detail)) {
    return new MessagesError(`messages account missing: ${detail}`, "Messages on the laptop isn't signed in for that kind of message.");
  }
  return new MessagesError(`osascript failed: ${detail}`, "Something went wrong talking to the Messages app on the laptop.");
}

const CLEAN_LABEL = (label: string) => label.replace(/^_\$!<|>!\$_$/g, "").toLowerCase();

/** Contacts listed in SHARE_CONTACTS ("Mom=+15551234567; Alex=alex@icloud.com"): fast and need no permission. */
function configuredContacts(): ContactHandle[] {
  return config.share.contacts
    .split(/[;\n]/)
    .map((entry) => entry.split("="))
    .filter(([name, handle]) => name?.trim() && handle?.trim())
    .map(([name, handle]) => {
      const h = handle.trim();
      return { name: name.trim(), handle: h, kind: h.includes("@") ? "email" : "phone", label: "saved" } as ContactHandle;
    });
}

const CONTACTS_SCRIPT = `
on run argv
  set q to item 1 of argv
  set out to ""
  tell application "Contacts"
    set found to (every person whose name contains q)
    set n to 0
    repeat with p in found
      set n to n + 1
      if n > 8 then exit repeat
      set nm to name of p
      repeat with ph in phones of p
        set out to out & nm & tab & "phone" & tab & (label of ph as text) & tab & (value of ph) & linefeed
      end repeat
      repeat with em in emails of p
        set out to out & nm & tab & "email" & tab & (label of em as text) & tab & (value of em) & linefeed
      end repeat
    end repeat
  end tell
  return out
end run`;

/** People whose name matches what the player said, from SHARE_CONTACTS first, then the Mac's Contacts app. */
export async function findContacts(spoken: string): Promise<ContactHandle[]> {
  const query = spoken.replace(/^(to|send it to|text|message)\s+/i, "").replace(/[^\p{L}\p{N}' .-]/gu, "").trim();
  if (!query) return [];
  const words = query.toLowerCase().split(/\s+/);
  const saved = configuredContacts().filter((c) => words.some((w) => c.name.toLowerCase().includes(w)));
  if (saved.length) return saved;

  const lookup = async (q: string) =>
    (await osascript(CONTACTS_SCRIPT, [q]))
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length === 4 && parts[3])
      .map(([name, kind, label, handle]) => ({ name, kind: kind as ContactHandle["kind"], label: CLEAN_LABEL(label), handle: handle.trim() }));
  let found = await lookup(query);
  // Speech recognition may add or mangle a word ("my mom Sarah"); try each word on its own.
  for (const word of words) {
    if (found.length) break;
    if (word.length > 2) found = await lookup(word);
  }
  return found;
}

// Some accounts (on macOS 26, e.g. ones from other services) fail when asked for their service type,
// which breaks bulk queries like "every account whose service type = iMessage", so check them one by one.
const SERVICES_SCRIPT = `
set out to ""
tell application "Messages"
  repeat with a in accounts
    try
      if enabled of a then set out to out & ((service type of a) as text) & linefeed
    end try
  end repeat
end tell
return out`;

/** Message services the laptop's Messages app has enabled (iMessage, and SMS with Text Message Forwarding). */
export async function enabledServices(): Promise<MessageService[]> {
  const out = await osascript(SERVICES_SCRIPT, []);
  const services: MessageService[] = [];
  if (/imessage/i.test(out)) services.push("iMessage");
  if (/\bsms\b/i.test(out)) services.push("SMS");
  return services;
}

/**
 * Which service to use for a handle: email addresses only work over iMessage; phone numbers use
 * iMessage when it's signed in, otherwise SMS through the paired iPhone.
 */
export function pickService(contact: ContactHandle, services: MessageService[]): MessageService | null {
  if (contact.kind === "email") return services.includes("iMessage") ? "iMessage" : null;
  if (services.includes("iMessage")) return "iMessage";
  return services.includes("SMS") ? "SMS" : null;
}

const SEND_SCRIPT = `
on run argv
  set targetHandle to item 1 of argv
  set messageText to item 2 of argv
  set serviceName to item 3 of argv
  tell application "Messages"
    set targetAccount to missing value
    repeat with a in accounts
      try
        if enabled of a and ((service type of a) as text) is serviceName then
          set targetAccount to a
          exit repeat
        end if
      end try
    end repeat
    if targetAccount is missing value then error "No enabled " & serviceName & " account" number -1728
    set targetParticipant to participant targetHandle of targetAccount
    send messageText to targetParticipant
  end tell
  return "sent"
end run`;

/** Send through the laptop's Messages app. Only call this after the player explicitly confirmed. */
export async function sendMessage(handle: string, text: string, service: MessageService): Promise<void> {
  // Last line of defense: never message anyone but the configured recipient.
  if (blockedRecipient(handle)) throw new MessagesError(`recipient not allowed: ${handle}`, "I'm only allowed to send to your saved number, so I didn't send it.");
  await osascript(SEND_SCRIPT, [handle, text, service], 30000);
}
