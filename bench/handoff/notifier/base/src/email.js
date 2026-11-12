// The email provider's sandbox: it rejects addresses that are not lower case, as the real one does.
export const sent = [];
export function sendEmail(to, body) {
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(to)) throw new Error(`provider rejected address ${JSON.stringify(to)}`);
  sent.push({ to, body });
  return `em-${sent.length}`;
}
