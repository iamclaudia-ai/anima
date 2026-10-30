/**
 * Who a sender is to Claudia.
 *
 * - `principal`: Michael. Verified mail from him is trusted.
 * - `contact`: someone she corresponds with for him. Verified mail wakes her
 *   and can be replied to, but it is never trusted.
 * - `unknown`: everyone else, and *any* address whose mail failed DMARC.
 */

export type SenderRole = "principal" | "contact" | "unknown";

export interface SenderLists {
  principals: string[];
  contacts: string[];
}

export function senderRole(from: string, verified: boolean, lists: SenderLists): SenderRole {
  if (!verified) return "unknown";
  const address = from.toLowerCase();
  if (lists.principals.includes(address)) return "principal";
  if (lists.contacts.includes(address)) return "contact";
  return "unknown";
}
