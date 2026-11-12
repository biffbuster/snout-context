import { sendEmail } from "./email.js";

// Sends `message` to `user` and returns the ids of the messages sent.
// Users: { id, email, phone?, prefers? }.
export function notify(user, message) {
  if (typeof message !== "string" || !message.trim()) throw new TypeError("a message needs text");
  const id = sendEmail(user.email.trim().toLowerCase(), message);
  return [id];
}
