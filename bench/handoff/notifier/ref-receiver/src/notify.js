import { sendEmail } from "./email.js";
import { sendSms } from "./sms.js";

const SMS_LIMIT = 160;
// Texts over the limit are cut so that the last character is an ellipsis (platform team).
const fitSms = (text) => ([...text].length <= SMS_LIMIT ? text : [...text].slice(0, SMS_LIMIT - 1).join("") + "…");

// Sends `message` to `user` and returns the ids of the messages sent. The signature and the
// return value stay as they are: billing and auth call this.
export function notify(user, message) {
  if (user.prefers === "sms" && user.phone) return [sendSms(user.phone, fitSms(message))];
  return [sendEmail(user.email.trim().toLowerCase(), message)];
}
