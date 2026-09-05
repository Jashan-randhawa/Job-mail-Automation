// Prompt + call to Groq's OpenAI-compatible LLM API, JSON parsing, and the
// role-classification logic that picks which fact block(s) the draft is
// allowed to draw from. Named cerebrasService.js for historical reasons
// (see README) — the actual provider is Groq.
import OpenAI from 'openai';
import { profile } from '../config/profile.js';
import { estimateTokens, reserveGroqCapacity } from './groqRateLimiter.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

// Lazily constructed so a missing GROQ_API_KEY doesn't crash the whole
// process at import time — server.js only *warns* on startup (see README),
// every job fails individually until it's set.
let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GROQ_API_KEY is not set — cannot draft emails. Get one at https://console.groq.com/keys and add it to .env.'
      );
    }
    client = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
  }
  return client;
}

export const TECH_FACTS = profile.techFacts;
export const SALES_FACTS = profile.salesFacts;
export const CUSTOMER_CARE_FACTS = profile.customerCareFacts;

// The drafting prompt's contact links and signature block are hardcoded
// here (via `profile`) — see README "Notes": update config/profile.js or
// profile.json, not this string, if you're forking this for someone else.
export function buildPrompt(postText) {
  return `
You are drafting a short, personalized cold-outreach email on behalf of a job candidate, in reply to a LinkedIn post about a hiring opportunity.

STEP 0 — CHECK ELIGIBILITY. If the post states a requirement tied to a protected characteristic (e.g. "female candidates only", a specific age range, marital status, religion) and nothing in the fact blocks below indicates the candidate meets it, do NOT try to word around it or draft an email that ignores it. Instead set "eligibilityFlag" to a short phrase naming the mismatch (e.g. "post requires female candidates") and still fill in subject/body as best you can — a downstream safety check will skip sending automatically. If there's no such stated requirement, or the candidate clearly meets it, set "eligibilityFlag" to null.

If instead the post asks for something ordinary the candidate falls short on — e.g. "5+ years experience" for a final-year student — that is NOT an eligibility-flag case (leave "eligibilityFlag" null). Just don't lead the email with the shortfall or pretend to meet it: pivot the hook and bullets toward what's genuinely true and relevant instead — rapid ramp-up on new stacks, concrete shipped results, the portfolio/GitHub — without stating or implying a duration or seniority that isn't real.

STEP 1 — CLASSIFY THE ROLE. Read the post and classify what is actually being hired for into exactly one of:
- TECHNICAL — engineering, dev, data, ML, or other hands-on technical roles.
- SALES_BUSINESS — sales, business development, account management, marketing, ops, or other non-technical business roles.
- CUSTOMER_CARE — support, customer success, community, help-desk, or telecalling roles.
- HYBRID — roles that genuinely blend technical work with business or customer-facing work (e.g. sales engineering, technical account management, developer relations, solutions consulting).

STEP 2 — PICK THE RIGHT FACT BLOCK(S). Use only the fact block(s) that match your classification. Never invent, exaggerate, or borrow a fact, number, company name, or title from a block that doesn't apply. Never invent a metric that isn't written in the fact block — bridge a technical achievement to the soft skill a non-technical role needs by describing what was built and how, not by inventing a business result (a "CSAT score" or "ticket volume") that was never actually measured.

STEP 3 — WRITE THE EMAIL, in exactly this 4-paragraph structure. No extra paragraphs, no bullet lists.

1. Subject line — specific and human, never generic. Prefer the pattern "Application for [Role] – ${profile.name}" adapted to what the post actually says. Never a bare word like "Application" or "Hello" alone.
2. Salutation — "Dear Hiring Manager," if no company/team name is known, or "Dear [Company] Team," if the post names the company. Never "Hi there" or "Hello,".
3. Paragraph 1 (the hook) — one sentence in the shape "The post's focus on [2-3 specific keywords or responsibilities actually taken from the post] resonated with my experience," or close natural variation. Must name something concretely present in the post, not a generic phrase.
4. Paragraph 2 (the proof) — 1-2 sentences on the single achievement from the matching fact block(s) that best fits the post, including its real metric (e.g. "40%", "80%", "15+"). If the role is SALES_BUSINESS or CUSTOMER_CARE, the email must not read like a copy-pasted engineering pitch — connect the technical work to the business/communication outcome the role actually needs, using only the outcome already stated in the fact block. Never invent a metric, or a business result (a "CSAT score", "ticket volume", "revenue" figure) that isn't written in the fact block — describing a real chatbot as reducing "support tickets" when the fact block never says that is exactly the kind of fabrication this rule forbids.
5. Paragraph 3 (logistics) — exactly: "I am a ${profile.graduationYear} ${profile.degree} graduate, available to start ${profile.availability} and open to interview at your convenience."
6. Paragraph 4 (call to action) — one sentence in the shape "I would appreciate the opportunity to discuss how my background in [2 relevant skills from the fact block used] can support your [the post's stated goal/team], with my resume and portfolio attached for full details," adapted naturally to the post.
7. Sign-off — exactly "Sincerely,\n\n${profile.name}" and nothing after it. Do NOT include phone number, email, or links in the body — those are appended separately after drafting.

Keep the whole body (salutation through sign-off) to roughly 150-200 words total. Do not pad it out to hit a word count.
Tone: professional, warm, confident, never salesy. Do not use hype words or spam-flagged language — no "guarantee", "best", "urgent", "amazing opportunity", "act now", excessive exclamation marks, or ALL CAPS.
No bracketed placeholders like [Company] or [Hiring Manager] anywhere in the output — if the company name isn't in the post, use natural phrasing like "your team" or "your organization" instead of a placeholder.

--- TECH_FACTS (use for TECHNICAL, or the technical half of HYBRID) ---
${TECH_FACTS}

--- SALES_FACTS (use for SALES_BUSINESS, or the business half of HYBRID) ---
${SALES_FACTS}

--- CUSTOMER_CARE_FACTS (use for CUSTOMER_CARE) ---
${CUSTOMER_CARE_FACTS}

LINKEDIN POST:
"""
${postText}
"""

Respond with ONLY a JSON object (no markdown fences, no commentary) matching exactly this schema:
{
  "roleCategory": "TECHNICAL" | "SALES_BUSINESS" | "CUSTOMER_CARE" | "HYBRID",
  "eligibilityFlag": string | null,
  "concept": "one short phrase naming what the post is actually about (company/role/domain)",
  "subject": "the email subject line",
  "body": "the full email body as plain text: salutation, then exactly 4 paragraphs (hook, proof, logistics, call-to-action), then the two-line sign-off — no phone number, email, or links"
}
`.trim();
}

function parseDraftResponse(raw) {
  let text = (raw || '').trim();
  // Strip ```json ... ``` fences in case the model adds them despite being
  // told not to — cheap defensive parsing, not a substitute for the prompt
  // instruction above.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Groq response was not valid JSON: ${err.message}`);
  }
  // Defensive cleanup: occasionally a model echoes the field label as part
  // of the value itself (e.g. subject: "Subject: Application for ..."),
  // which would otherwise show up verbatim in the sent email. Strip a
  // leading label if present rather than rejecting an otherwise-good draft.
  if (typeof parsed.subject === 'string') {
    parsed.subject = parsed.subject.replace(/^\s*subject\s*:\s*/i, '').trim();
  }
  if (typeof parsed.body === 'string') {
    parsed.body = parsed.body.replace(/^\s*body\s*:\s*/i, '').trim();
  }
  return parsed;
}

export async function extractConceptAndDraft(postText) {
  const prompt = buildPrompt(postText);
  // Conservative worst-case estimate (prompt + generous completion
  // headroom) reserved *before* the call so groqRateLimiter can pace
  // concurrent drafts; reconciled down to real usage via handle.settle()
  // once the response comes back (see services/groqRateLimiter.js).
  const estimatedTokens = estimateTokens(prompt) + 700;
  const handle = await reserveGroqCapacity(estimatedTokens);
  try {
    const completion = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      response_format: { type: 'json_object' }
    });
    handle.settle(completion.usage?.total_tokens);
    const draft = parseDraftResponse(completion.choices?.[0]?.message?.content);
    if (!draft.subject || !draft.body) {
      throw new Error('Groq response was missing subject or body.');
    }
    return {
      concept: draft.concept || '',
      subject: draft.subject,
      body: draft.body,
      roleCategory: draft.roleCategory || null,
      eligibilityFlag: draft.eligibilityFlag || null
    };
  } catch (err) {
    handle.settle(0); // don't let a failed call's reservation squat on the window
    throw err;
  }
}

// Exposed for test/promptClassification.test.js — asserts the prompt keeps
// both fact sets, the classification instructions, and the anti-copy-paste
// rule intact as the prompt evolves.
export const __promptTest = { buildPrompt, TECH_FACTS, SALES_FACTS };
