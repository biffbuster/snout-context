// The SMS provider's sandbox: one segment of 160 characters at most, as the real one.
export const sent = [];
export function sendSms(phone, text) {
  if (!/^\+\d{8,15}$/.test(phone)) throw new Error(`provider rejected number ${JSON.stringify(phone)}`);
  if ([...text].length > 160) throw new Error("text longer than 160 characters");
  sent.push({ phone, text });
  return `sms-${sent.length}`;
}
