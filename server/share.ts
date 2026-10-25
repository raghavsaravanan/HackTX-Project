// Sharing a finished quest with a contact through the laptop's Messages app.
// offer -> choose_contact (-> pick_option) -> confirm (preview) -> sending. The message is only sent
// from the confirm stage, after an explicit "send it" (spoken, typed, or the phone's Send button),
// and only the exact previewed text to the previewed recipient over the previewed service.
import type { LineSource, ShareState } from "../shared/types.ts";
import { redact } from "./config.ts";
import { agentText } from "./llm.ts";
import {
  MessagesError,
  blockedRecipient,
  enabledServices,
  findContacts,
  onlyRecipient,
  pickService,
  sendMessage,
  type ContactHandle,
} from "./providers/messages.ts";

/** How long each stage waits for the player before the share quietly ends. */
const STAGE_MS = 120000;

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|please|of course|definitely|absolutely|go ahead|do it|let'?s do it|why not)\b/i;
const NO = /\b(no|nope|nah|cancel|stop|don'?t|do not|never ?mind|not now|skip|forget it)\b/i;
const SEND = /\b(send( it)?|yes|yeah|yep|confirm|go ahead|do it)\b/i;
const AS_TEXT = /\b(as (a )?text( message)?|sms|text message)\b/i;
const REWRITE = /\b(rewrite|reword|different message|change (it|the message)|try again)\b/i;
const ORDINALS = [/\b(one|first|1)\b/i, /\b(two|second|2)\b/i, /\b(three|third|3)\b/i];
/** A new request rather than a contact name ("help me find my keys"). */
const NEW_REQUEST = /\b(help me|i need|i want|can you|could you|let'?s|find my|where (is|are)|how do)\b/i;

export interface ShareIO {
  say(text: string, source?: LineSource): void;
  /** New state for the session; null ends the share. */
  update(state: ShareState | null): void;
}

export function shareOffer(task: ShareState["task"]): ShareState {
  return {
    stage: "offer",
    task,
    options: [],
    contactName: "",
    handle: "",
    handleKind: "",
    service: "",
    services: [],
    message: "",
    expiresAt: Date.now() + STAGE_MS,
  };
}

export const SHARE_QUESTION = "Would you like me to share your accomplishment with one of your contacts?";

/**
 * Whether this reply belongs to the share. While offering, only a clear yes or no does; anything else
 * is a new request, and the player's latest request wins (the offer is dropped).
 */
export function shareConsumes(state: ShareState, text: string): boolean {
  if (Date.now() > state.expiresAt || state.stage === "sending") return false;
  if (state.stage === "offer") return YES.test(text.trim()) || NO.test(text);
  if ((state.stage === "choose_contact" || state.stage === "pick_option") && NEW_REQUEST.test(text)) return false;
  return true;
}

const serviceName = (service: ShareState["service"]) => (service === "SMS" ? "text message" : "iMessage");

/** The player's reply while sharing. Never sends unless the state is a confirmed preview. */
export async function handleShareReply(state: ShareState, text: string, io: ShareIO): Promise<void> {
  const reply = text.trim();
  const next = (patch: Partial<ShareState>) => io.update({ ...state, ...patch, expiresAt: Date.now() + STAGE_MS });

  // Any refusal wins, even mixed with "send": an ambiguous reply must never send.
  if (NO.test(reply)) {
    io.update(null);
    io.say(state.stage === "confirm" ? "Okay, I won't send it." : "No problem. I'll keep it between us.");
    return;
  }

  switch (state.stage) {
    case "offer": {
      // With a single allowed recipient (SHARE_ONLY_TO) there is nobody to choose: go straight to the preview.
      const only = onlyRecipient();
      if (only) {
        await prepare(state, only, io);
        return;
      }
      next({ stage: "choose_contact" });
      io.say("Who should I send it to? Say their name the way it's saved in your contacts.");
      return;
    }

    case "choose_contact": {
      if (YES.test(reply) && reply.split(/\s+/).length <= 2) {
        io.say("Who should I send it to? Just say their name.");
        next({});
        return;
      }
      let found: ContactHandle[];
      try {
        found = await findContacts(reply);
      } catch (err) {
        console.warn("[share] contacts lookup failed:", redact((err as Error).message).slice(0, 160));
        io.say(err instanceof MessagesError ? `${err.spoken} Then say their name again, or say cancel.` : "I couldn't search your contacts. Say their name again, or say cancel.");
        next({});
        return;
      }
      const people = bestHandlePerPerson(found);
      if (!people.length) {
        io.say(`I couldn't find anyone called ${reply} in your contacts. Try their name again, or say cancel.`);
        next({});
        return;
      }
      if (people.length === 1) {
        await prepare(state, people[0], io);
        return;
      }
      const options = people.slice(0, 3);
      next({ stage: "pick_option", options: options.map(({ name, handle, label, kind }) => ({ name, handle, label, kind })) });
      io.say(`I found ${options.length} people. ${options.map((o, i) => `${i + 1}: ${o.name}`).join(". ")}. Which one? Say the number.`);
      return;
    }

    case "pick_option": {
      const byNumber = ORDINALS.findIndex((pattern) => pattern.test(reply));
      const byName = state.options.findIndex((o) => o.name.toLowerCase().includes(reply.toLowerCase()) || reply.toLowerCase().includes(o.name.toLowerCase()));
      const choice = state.options[byNumber >= 0 && byNumber < state.options.length ? byNumber : byName];
      if (!choice) {
        io.say(`Say the number: ${state.options.map((o, i) => `${i + 1} for ${o.name}`).join(", ")}. Or say cancel.`);
        next({});
        return;
      }
      await prepare(state, choice, io);
      return;
    }

    case "confirm": {
      if (AS_TEXT.test(reply) && !/\bsend it\b/i.test(reply.replace(AS_TEXT, ""))) {
        if (state.handleKind !== "phone" || !state.services.includes("SMS")) {
          io.say("I can't send that one as a text message from this laptop. Say send it to use iMessage, or cancel.");
          next({});
          return;
        }
        next({ service: "SMS" });
        io.say(previewLine({ ...state, service: "SMS" }));
        return;
      }
      if (REWRITE.test(reply)) {
        const message = await composeMessage(state.task, state.contactName);
        next({ message });
        io.say(previewLine({ ...state, message }));
        return;
      }
      if (!SEND.test(reply)) {
        io.say(`Should I send it to ${state.contactName}? Say send it, or say cancel.`);
        next({});
        return;
      }
      await send(state, io);
      return;
    }

    default:
      return;
  }
}

/** One handle per person: a mobile or iPhone number first, then any number, then email. */
function bestHandlePerPerson(found: ContactHandle[]): ContactHandle[] {
  const rank = (c: ContactHandle) => (c.kind === "phone" ? (/mobile|iphone|cell|saved/.test(c.label) ? 0 : 1) : 2);
  const byName = new Map<string, ContactHandle>();
  for (const c of found) {
    const best = byName.get(c.name);
    if (!best || rank(c) < rank(best)) byName.set(c.name, c);
  }
  return [...byName.values()];
}

async function prepare(state: ShareState, contact: Pick<ContactHandle, "name" | "handle" | "kind" | "label">, io: ShareIO) {
  let services: ShareState["services"];
  try {
    services = await enabledServices();
  } catch (err) {
    console.warn("[share] messages check failed:", redact((err as Error).message).slice(0, 160));
    io.update(null);
    io.say(err instanceof MessagesError ? `${err.spoken} I didn't send anything.` : "I couldn't reach the Messages app on the laptop, so I didn't send anything.");
    return;
  }
  const service = pickService({ ...contact, label: contact.label }, services);
  if (!service) {
    io.update(null);
    io.say(
      contact.kind === "email"
        ? `${contact.name}'s contact is an email address, which needs iMessage, and iMessage isn't signed in on the laptop. I didn't send anything.`
        : "Messages on the laptop isn't signed in to iMessage and text forwarding from an iPhone isn't on, so I can't send it. I didn't send anything.",
    );
    return;
  }
  const message = await composeMessage(state.task, contact.name);
  const ready: ShareState = {
    ...state,
    stage: "confirm",
    options: [],
    contactName: contact.name,
    handle: contact.handle,
    handleKind: contact.kind,
    service,
    services,
    message,
    expiresAt: Date.now() + STAGE_MS,
  };
  io.update(ready);
  io.say(previewLine(ready));
}

function previewLine(state: ShareState): string {
  const ending = state.handle.replace(/\D/g, "").slice(-4);
  const to = state.handleKind === "phone" && ending ? `${state.contactName}, at the number ending ${ending.split("").join(" ")}` : state.contactName;
  return `Here's the message for ${to}, by ${serviceName(state.service)}: ${state.message} Should I send it? Say send it, or say cancel.`;
}

async function send(state: ShareState, io: ShareIO) {
  if (state.stage !== "confirm" || Date.now() > state.expiresAt || !state.handle || !state.message || !state.service) {
    io.update(null);
    io.say("That message expired, so I didn't send anything.");
    return;
  }
  if (blockedRecipient(state.handle)) {
    io.update(null);
    io.say("I'm only allowed to send to your saved number, so I didn't send it.");
    return;
  }
  io.update({ ...state, stage: "sending" });
  try {
    await sendMessage(state.handle, state.message, state.service);
    console.log(`[share] sent to ${state.contactName} by ${state.service}`);
    io.update(null);
    io.say(`Sent to ${state.contactName} by ${serviceName(state.service)}.`);
  } catch (err) {
    console.warn("[share] send failed:", redact((err as Error).message).slice(0, 200));
    // Offer SMS instead, but only send again after the player confirms it.
    if (state.service === "iMessage" && state.handleKind === "phone" && state.services.includes("SMS")) {
      io.update({ ...state, stage: "confirm", service: "SMS", expiresAt: Date.now() + STAGE_MS });
      io.say(`iMessage didn't go through. Should I send it to ${state.contactName} as a text message instead? Say send it, or say cancel.`);
      return;
    }
    io.update(null);
    io.say(err instanceof MessagesError ? `I couldn't send it. ${err.spoken}` : "I couldn't send it. The Messages app on the laptop gave an error.");
  }
}

/** A short, personal text from the player to the contact about what they finished. */
async function composeMessage(task: ShareState["task"], contactName: string): Promise<string> {
  const first = contactName.split(/\s+/)[0] || contactName;
  // A contact saved as "Me" is the player's own number: write a note to self, not "Hi Me".
  const toSelf = /^(me|myself|my phone)$/i.test(contactName.trim());
  const fallback = toSelf
    ? `Note to self: I just finished "${task.title}" with Lumi. ${task.steps.length} steps, all done.`
    : `Hi ${first}, I just finished "${task.title}" with my AI helper Lumi. ${task.steps.length} steps, all done.`;
  try {
    const { value } = await agentText({
      system: "You write short, warm text messages in the first person, from a person to someone they know. Plain text only.",
      prompt: [
        toSelf
          ? "Write a short note I'm texting to myself to remember that I just finished a task. Don't address anyone by name."
          : `Write a text message from me to ${first}, sharing that I just finished a task.`,
        `Task: "${task.title}". What I asked for: "${task.goal}".`,
        `What I did: ${task.steps.join("; ")}.`,
        "I'm blind, and I did it with Lumi, an AI voice companion that guided me step by step. Mention Lumi once.",
        "At most 2 sentences and 200 characters. Sound like me, not like an ad. No hashtags. At most one emoji.",
        "Reply with only the message text, no quotes.",
      ].join("\n"),
      timeoutMs: 8000,
    });
    const text = value.trim().replace(/^["“]|["”]$/g, "");
    return text && text.length <= 320 ? text : fallback;
  } catch (err) {
    console.warn("[share] message draft failed:", redact((err as Error).message).slice(0, 160));
    return fallback;
  }
}
