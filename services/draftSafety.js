// Shared between server.js (local/Express queue) and api/send-outreach.js
// (Vercel streaming route) so the two entry points can never silently drift
// apart on what counts as a rejected draft.

const PLACEHOLDER_RE = /\[[^\]]{1,40}\]/;

// Deliberately NOT an instruction to the LLM to hide or paper over a
// mismatch — see cerebrasService.js STEP 0. If the post states an
// eligibility criterion tied to a protected characteristic (gender, age,
// marital status, religion, etc.) that the candidate doesn't meet, the
// model is told to say so via `eligibilityFlag` rather than draft a
// work-around email. This gate then treats that flag as a rejection, so a
// mismatched post is skipped (not applied to under false pretenses) and
// surfaces a clear reason instead of quietly vanishing.
export function checkDraftSafety(draft) {
  if (draft?.eligibilityFlag) {
    return {
      rejected: true,
      reason: `Skipped: the post states an eligibility requirement the candidate profile doesn't meet (${draft.eligibilityFlag}). Nothing was drafted further or sent.`
    };
  }
  const hasPlaceholder = PLACEHOLDER_RE.test(draft?.subject || '') || PLACEHOLDER_RE.test(draft?.body || '');
  const tooShort = !draft?.body || draft.body.trim().length < 50;
  const missingSubject = !draft?.subject || !draft.subject.trim();
  if (hasPlaceholder || tooShort || missingSubject) {
    return {
      rejected: true,
      reason: 'Generated email failed the safety check (placeholder text, missing subject, or too short). Nothing was sent.'
    };
  }
  return { rejected: false, reason: null };
}
