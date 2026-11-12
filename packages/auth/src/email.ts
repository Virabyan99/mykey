// E-mail addresses are stored and compared the way Better Auth looks them up
// at sign-in: trimmed and lower-cased.
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
