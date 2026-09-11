export const PHONE_RE = /^\+?[1-9]\d{7,14}$/;
export function isValidPhone(phone) { return PHONE_RE.test(String(phone || '').trim()); }

export const DEFAULT_GREETING =
  `Hi! I came across your post regarding the hiring opportunity and wanted to reach out. ` +
  `I am Jashanpreet Singh, a Full Stack AI Engineer (B.Tech IT 2026). ` +
  `I have attached my resume here for your review. Would welcome the chance to connect and discuss how my background can support your team. Thank you!`;
