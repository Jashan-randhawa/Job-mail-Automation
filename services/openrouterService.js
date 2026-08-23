import OpenAI from 'openai';

const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini';

// Lower than the old 0.85: application emails need to stay factually
// consistent and on-target far more than they need to sound "creative".
// Controlled variation still comes from the prompt's explicit phrasing
// instructions, not from a high sampling temperature.
const TEMPERATURE = 0.55;

let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
        'X-Title': 'LinkedIn Outreach Bot'
      }
    });
  }
  return client;
}

// Full contact block in the sign-off. Note: multiple links in a cold email
// is a mild spam-filter signal (more so than one bare link), so if
// deliverability regresses, trimming this back down to just PORTFOLIO_LINK
// is the first thing to try.
const PORTFOLIO_LINK = process.env.PORTFOLIO_LINK || 'jashan2978.vercel.app';
const GITHUB_LINK = process.env.GITHUB_LINK || 'github.com/Jashan-randhawa';
const LINKEDIN_LINK = process.env.LINKEDIN_LINK || 'linkedin.com/in/jashanpreet-singh-112978211';
const CONTACT_EMAIL = process.env.EMAIL_USER || 'jashanpreetsinghrandhawa65@gmail.com';
const CONTACT_PHONE = process.env.CONTACT_PHONE || '+91 7988253528';

const SIGNATURE_BLOCK = `
Jashanpreet Singh
${CONTACT_PHONE} · ${CONTACT_EMAIL}
Portfolio: ${PORTFOLIO_LINK}
GitHub: ${GITHUB_LINK}
LinkedIn: ${LINKEDIN_LINK}
`.trim();

// A menu of real, verifiable facts rather than one fixed paragraph. The
// model is instructed to pick the ONE item that matches the role in the
// post instead of listing everything — that's what makes each application
// read as targeted rather than mail-merged, which also helps deliverability
// (varied specific content beats one repeated template).
const TECH_FACTS = `
NAME: Jashanpreet Singh
ROLE: Full Stack AI Engineer, B.Tech IT graduate, Class of 2026 (SJPML Institute of Engg. & Technology, 2022–2026)
CORE STACK: MERN, Next.js, TypeScript, Node/Express, MongoDB/PostgreSQL

EXPERIENCE
- Full Stack Developer Intern, Excellence Technologies (Jul–Sep 2024): built a React Native app with offline sync + real-time chat (Socket.io) that drove a 40% DAU increase; automated internal workflows cutting manual effort by 80% and resolving 15+ critical bugs; shipped Next.js landing pages for an eCommerce platform.
- AI & ML Trainee, Infosys ICT Academy (Jun–Aug 2025): Azure AI Services training (Python ML, Azure ML Studio, NLP, Computer Vision); deployed an Azure Computer Vision image classifier (Streamlit) at 92% accuracy.

PROJECTS (pick whichever is most relevant to the post's tech/domain, don't list all of them)
- AI FiTrack: React + TypeScript + Strapi + Google Gemini AI + Azure Maps fitness tracker — Gemini-powered calorie estimation, AI chatbot, webcam food capture, PDF export.
- Smart Attend: FastAPI + Azure Face API + InsightFace + MongoDB + Docker face-recognition attendance system — migrated ephemeral storage to MongoDB and fixed aggregation-pipeline bugs to stabilize production inference.
- Real-Time Chat App: Node.js + Socket.io + MongoDB with a self-built TF-IDF + Logistic Regression spam classifier at 94% accuracy, auto-filtering malicious messages before delivery.
- LibraryOS: React + TypeScript + Node/Express + MongoDB library management SaaS with role-based access and JWT auth, deployed on Render + Vercel.

OTHER CREDIBILITY SIGNALS (use sparingly, at most one, only if directly relevant)
- Ranked 1st of 150+ peers in 5th semester.
- Led a 5-member team at Smart India Hackathon 2024 against 250+ participants.
- Solved 150+ DSA problems in C++.
`.trim();

// Same real, already-verified background as TECH_FACTS above, described in
// business/customer-facing language instead of engineering jargon — for
// sales, business development, account management, customer success, and
// similar non-engineering roles. Deliberately contains NO new companies,
// titles, dates, or numbers beyond what TECH_FACTS already states: everything
// here is a truthful reframing, not fabricated experience. If genuine sales
// job history is ever added, it belongs here as its own dated EXPERIENCE
// entry, written the same way TECH_FACTS states its experience.
const SALES_FACTS = `
NAME: Jashanpreet Singh
BACKGROUND: Full Stack AI Engineer, B.Tech IT graduate, Class of 2026 — technical builder with a track record of shipping user-facing products and translating that work into measurable business outcomes. Strongest fit for roles where speaking credibly to both the engineering and business sides matters (sales engineering, technical account management, solutions consulting, developer relations, customer success at a technical product company) but the growth/ops/leadership signals below apply to general business-development and account-facing roles too.

GROWTH & ADOPTION IMPACT
- Shipped a real-time chat + offline-sync feature (React Native, Socket.io) during a Full Stack Developer internship at Excellence Technologies that drove a 40% increase in daily active users — direct evidence of understanding what drives user adoption, not just building features in isolation.

OPERATIONAL / PROCESS IMPACT
- Automated internal workflows during that same internship, cutting manual effort by 80% and resolving 15+ recurring issues — reflects the kind of process-improvement instinct and stakeholder problem-solving that matters in account management and operations-adjacent sales roles.

CROSS-FUNCTIONAL LEADERSHIP & COMMUNICATION
- Led a 5-member team at Smart India Hackathon 2024, competing against 250+ participants — coordinated a team and pitched the solution to judges under deadline pressure: team leadership and persuasive communication under pressure, both directly relevant to sales and client-facing work.

PERFORMANCE / RESULTS-DRIVEN
- Ranked 1st of 150+ peers in 5th semester — consistent track record of outperforming in competitive, metrics-driven environments.

CUSTOMER-FACING PRODUCT SENSE
- Built and shipped multiple end-user-facing products (an AI fitness tracker with a chatbot and webcam capture flow; a library-management SaaS with role-based access) — comfortable explaining technical products in plain terms to non-technical users, which is exactly the skill technical/solutions sales roles need.
`.trim();

// Same real, already-verified background as TECH_FACTS above, described in
// customer-care/support language instead of engineering jargon or growth
// metrics — for Customer Care Executive, Customer Support Executive,
// Customer Service Representative, and similar direct support roles.
// Deliberately contains NO new companies, titles, dates, or numbers beyond
// what TECH_FACTS already states: everything here is a truthful reframing,
// not fabricated experience. This is distinct from SALES_FACTS because a
// support-desk posting cares about patience, responsiveness, and issue
// resolution, not growth/revenue framing.
const CUSTOMER_CARE_FACTS = `
NAME: Jashanpreet Singh
BACKGROUND: Full Stack AI Engineer, B.Tech IT graduate, Class of 2026 — builds the tools people rely on for support and communication, and has hands-on experience being the one who fixes things when users are stuck.

ISSUE RESOLUTION & RESPONSIVENESS
- Automated internal workflows during a Full Stack Developer internship at Excellence Technologies, cutting manual effort by 80% and resolving 15+ recurring issues — direct evidence of staying calm, methodical, and fast under a queue of open problems, the core of any support role.

CLEAR COMMUNICATION WITH NON-TECHNICAL USERS
- Built and shipped an AI chatbot (Google Gemini) inside a fitness-tracking app to answer user questions in plain language — practical experience designing how a system talks to people who aren't technical.
- Led a 5-member team at Smart India Hackathon 2024, competing against 250+ participants — pitched and explained a technical solution clearly to non-technical judges under time pressure.

PROTECTING USER EXPERIENCE
- Built a self-trained spam classifier (94% accuracy) into a real-time chat app that auto-filters malicious messages before delivery — shows an instinct for anticipating what will frustrate or harm a user and fixing it proactively, not just reactively.

RELIABILITY & CONSISTENCY
- Shipped a real-time chat + offline-sync feature (Socket.io) that drove a 40% increase in daily active users — evidence the underlying product experience was reliable enough that people kept coming back.
- Ranked 1st of 150+ peers in 5th semester — consistent, dependable performance under evaluation.
`.trim();

// Known technology/skill tokens used to (a) normalize synonyms in the prompt
// instructions and (b) let the deterministic validator below sanity-check
// that a draft isn't dumping the whole stack into one email.
const TECH_SYNONYM_MAP = [
  ['React.js', 'React'], ['ReactJS', 'React'],
  ['Node.js', 'Node.js'], ['Node', 'Node.js'],
  ['Express.js', 'Express'],
  ['Mongo', 'MongoDB'],
  ['TS', 'TypeScript'],
  ['GenAI', 'Generative AI'], ['Generative AI', 'Generative AI'],
  ['Azure Cognitive Services', 'Azure AI'], ['Azure AI', 'Azure AI']
];

const FORBIDDEN_PHRASES = [
  'i hope this email finds you well',
  'i am writing to express my interest',
  'i came across your profile',
  "don't hesitate to reach out",
  'reaching out to explore opportunities',
  'passionate about',
  'i would love the opportunity'
];

const VALID_ROLE_CATEGORIES = ['TECHNICAL', 'SALES_BUSINESS', 'CUSTOMER_CARE', 'HYBRID'];

// All verified facts concatenated once, used only for the deterministic
// no-fabricated-metric check below — never sent anywhere new, just reused.
const ALL_FACTS = `${TECH_FACTS}\n${SALES_FACTS}\n${CUSTOMER_CARE_FACTS}`;

function buildPrompt(postText) {
  return `
SYSTEM ROLE
You are a job-application strategist writing on behalf of one real candidate. Given a LinkedIn hiring post, you (1) extract what the job actually needs, (2) match it against the candidate's real, pre-verified background, and (3) write ONE targeted application email — never a mail-merged template. Optimize in this order: RELEVANCE > FACTUALITY > CLARITY > PERSONALIZATION > VARIATION. Never trade truth for creativity.

CANDIDATE FACTS — three fact sets describing the SAME real person and achievements, reframed by audience. The underlying facts never change, only the language. Never invent a fact, company, title, date, number, or technology beyond what appears below.

TECH FACTS (source for TECHNICAL roles; a menu — pick only what's relevant, never list everything):
${TECH_FACTS}

SALES/BUSINESS FACTS (SAME background as TECH FACTS, reframed for non-engineering roles — no new companies/titles/dates/numbers beyond TECH FACTS):
${SALES_FACTS}

CUSTOMER CARE FACTS (SAME background as TECH FACTS, reframed for support/care roles — no new companies/titles/dates/numbers beyond TECH FACTS):
${CUSTOMER_CARE_FACTS}

JOB POST:
"""
${postText}
"""

MATCHING RULES — work through these internally before writing; do not show the work, only the final email:
1. Extract from the post, without inventing anything left unstated: company, role title, seniority, location, employment type, domain, must-have skills, nice-to-have skills, core responsibilities, and any explicit application instructions. Normalize synonyms when reasoning about them (React/React.js/ReactJS → React; Node/Node.js → Node.js; Express/Express.js → Express; Mongo/MongoDB → MongoDB; TypeScript/TS → TypeScript; GenAI/Generative AI → Generative AI; Azure Cognitive Services/Azure AI → Azure AI), but keep the post's own wording in the email itself where it helps personalize the opening.
2. Classify the role into exactly one category using this priority order — check CUSTOMER_CARE first, then TECHNICAL, then HYBRID, then SALES_BUSINESS — and decide from actual responsibilities in the post, not the title alone (if they conflict, responsibilities win):
   - CUSTOMER_CARE (Customer Care Executive, Customer Support Executive, Customer Service Representative, help desk, support rep, technical support — any role centered on directly handling customer issues/tickets/queries rather than selling or growing accounts): use CUSTOMER CARE FACTS. This takes priority over SALES_BUSINESS whenever the post is about handling customer problems directly rather than revenue/accounts — do not use growth/revenue framing here.
   - TECHNICAL (software/data/ML engineering, developer roles): use TECH FACTS.
   - HYBRID (sales engineer, technical account manager, solutions consultant, developer relations/advocate, technical support engineer — roles that explicitly need both technical credibility and people/communication skills): blend sources — lead with whichever framing fits better, SALES/BUSINESS FACTS or CUSTOMER CARE FACTS, and add one concrete technical detail from TECH FACTS as supporting proof of depth.
   - SALES_BUSINESS (sales, business development, account management, marketing, operations, or any other clearly non-engineering, non-support role): use SALES/BUSINESS FACTS. Describe the achievement in the business/impact language SALES/BUSINESS FACTS already uses — it must NOT read like a copy-pasted engineering pitch if the role is sales/business.
   If the post is genuinely ambiguous, make the best-judgment call and proceed — don't default to TECHNICAL just because TECH FACTS is longer.
3. Within the fact set for the chosen category, judge whether real evidence exists for each important requirement — prioritize must-have skills, then core responsibilities, then domain, then measurable achievements, then nice-to-haves — using this rough strength order: exact skill/technology match > very close transferable skill or strong responsibility match or relevant domain/project match > relevant measurable achievement > general transferable evidence > weak/indirect connection > no evidence. Do not force a match where none exists. Use semantic understanding rather than keyword matching — e.g. REST API → backend/API development, React → frontend development, Socket.io → real-time communication, MongoDB → NoSQL database, Gemini → generative AI/LLM applications, Azure Computer Vision → computer vision/Azure AI, workflow automation → process optimization, customer issue resolution → support/problem solving — but semantic similarity may only surface genuine transferable evidence, never manufacture experience.
4. Select only the strongest evidence: normally one primary proof point plus one supporting proof point (up to three total, only for HYBRID roles). Never dump the whole stack — the email should say "this person has evidence relevant to THIS job," not "this person knows many technologies."
5. Judge overall fit honestly and let it set the email's confidence: strong alignment → state it clearly; moderate/transferable-only fit → emphasize the transferable evidence without overstating qualification; weak fit → do not pretend to be a perfect match, lead with the strongest transferable evidence and stay honest about the rest.
6. Address the post in priority order and don't spend words restating company marketing copy: (1) must-have/required skills, (2) core responsibilities, (3) business/domain context, (4) nice-to-have skills.

WRITING RULES
- Length: 150-210 words.
- Opening (1-2 sentences): must reference at least one concrete element pulled from the post itself (the specific stack, product, team, or responsibility named). Never a generic opening.
- Fit (2-3 sentences): connect one job requirement → the matched candidate evidence → a measurable proof point, written as flowing sentences, e.g. "At Excellence Technologies, I built a React Native real-time chat experience with offline sync and Socket.io that contributed to a 40% increase in daily active users." Never a list of technologies. This is evidence the candidate can do the job, not a general bio.
- Logistics (1 sentence): mention 2026 B.Tech graduate status and immediate availability plainly (e.g. available to start immediately, open to interview at their convenience). Never invent a start date or salary figure that isn't given.
- Ask (1 sentence): a direct, application-appropriate close — request to be considered for the role and/or a short interview, and note the resume/portfolio link covers full details. Not a vague "let's grab coffee" ask.
- Sign-off: one closing line, then this exact signature block on its own lines, unchanged, with none of its links repeated earlier in the body:
${SIGNATURE_BLOCK}
- Vary opening phrasing, transition wording, evidence ordering, and sentence rhythm between emails — write it the way a specific thoughtful person would phrase this particular application, not a fill-in-the-blank template. Keep facts, tone, and the signature block fixed; only the phrasing varies. Don't make it intentionally strange or overly creative.
- Tone: formal but warm and direct — this is a job application, not a networking cold email, so it should read as confident and role-specific rather than tentative. Ban these phrases entirely: "I hope this email finds you well", "I am writing to express my interest", "I came across your profile", "don't hesitate to reach out", "reaching out to explore opportunities", "passionate about", "I would love the opportunity".
- Missing information: if the company name is unavailable, don't invent one — write naturally around it. If no recruiter name is given, use "Hiring Team" — never invent a person's name. If the role itself is unclear, describe the opportunity using the strongest identifiable job function.
- Subject line: reads like a real application subject line — e.g. "Application: [Role] — Jashanpreet Singh" or "[Role] at [Company] — Jashanpreet Singh" if known from the post, otherwise something equally specific to what the post is about. Max 12 words. Avoid "opportunity", "exciting", "amazing", or exclamation points.

FACTUALITY RULES — never violate these, even when a job requirement makes it tempting:
- Never invent experience, job titles, companies, years of experience, certifications, responsibilities, salaries, locations, or technologies, and never claim proficiency the facts above don't support.
- JOB REQUIREMENT ≠ CANDIDATE EXPERIENCE. State a requirement as candidate experience only when the fact sets above verify it. Bad: "I have extensive experience building scalable AWS systems" (when AWS isn't in the facts). Good: "My experience building Node.js and MongoDB applications gives me a strong foundation for backend development."
- Never claim a responsibility was performed just because the job post mentions it.
- Never use placeholder brackets like [Company], [Name], or [Role] — use real details from the post, or write around unknowns naturally.
- Use the signature block exactly as given — don't add, remove, or reorder its lines.

OUTPUT FORMAT
Return ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"concept": "one sentence naming the role and company being applied to, or what the post is about if unclear", "roleCategory": "TECHNICAL, SALES_BUSINESS, CUSTOMER_CARE, or HYBRID", "subject": "email subject line", "body": "full email body with proper line breaks using \\n"}
`.trim();
}

// --- Deterministic post-generation checks (section 18/19 of the spec) ---
// Cheap, rule-based, no extra LLM call. These run after the model's JSON is
// parsed and before the draft is handed back to the caller. They exist to
// catch concrete, checkable problems (placeholders, banned phrases, an
// invented number, a mangled signature) — not to second-guess valid prose,
// so a different-but-fine sentence structure is never a reason to reject.

const PLACEHOLDER_RE = /\[[^\]]{1,40}\]/;

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function findFabricatedMetric(body) {
  const numbers = body.match(/\d+%|\d+\+/g) || [];
  return numbers.find((n) => !ALL_FACTS.includes(n)) || null;
}

function countDistinctTechMentions(body) {
  const lower = body.toLowerCase();
  const canonical = new Set(TECH_SYNONYM_MAP.map(([, canon]) => canon.toLowerCase()));
  let count = 0;
  for (const tech of canonical) {
    if (lower.includes(tech)) count += 1;
  }
  return count;
}

function validateDraft(draft) {
  const subject = (draft.subject || '').trim();
  const body = (draft.body || '').trim();

  if (!subject) throw new Error('Draft is missing a subject line.');
  if (!body || body.length < 50) throw new Error('Draft body is missing or too short.');
  if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) {
    throw new Error('Draft still contains placeholder text like [Company] or [Name].');
  }
  if (draft.roleCategory && !VALID_ROLE_CATEGORIES.includes(draft.roleCategory)) {
    throw new Error(`Draft returned an invalid roleCategory: ${draft.roleCategory}`);
  }

  const lowerBody = body.toLowerCase();
  const forbidden = FORBIDDEN_PHRASES.find((phrase) => lowerBody.includes(phrase));
  if (forbidden) throw new Error(`Draft body uses a banned generic phrase: "${forbidden}".`);

  if (!body.includes('Jashanpreet Singh')) {
    throw new Error('Draft body is missing the candidate signature.');
  }

  for (const link of [PORTFOLIO_LINK, GITHUB_LINK, LINKEDIN_LINK]) {
    if (countOccurrences(body, link) > 1) {
      throw new Error(`Draft repeats the "${link}" link outside the signature block.`);
    }
  }

  const fabricatedMetric = findFabricatedMetric(body);
  if (fabricatedMetric) {
    throw new Error(`Draft body cites "${fabricatedMetric}", which does not appear in any verified candidate fact.`);
  }

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < 90 || wordCount > 320) {
    throw new Error(`Draft body length (${wordCount} words) is outside a reasonable range for an application email.`);
  }

  const techMentionCount = countDistinctTechMentions(body);
  if (techMentionCount > 8) {
    throw new Error('Draft body lists too many technologies — evidence was not narrowed down as instructed.');
  }
}

// Lightweight, deterministic 0-10 heuristic per dimension, purely for
// internal observability (logged, never returned to the caller or exposed
// over the API — the public response shape stays {concept, roleCategory,
// subject, body}). Not a quality gate; validateDraft above is the gate.
function scoreDraftQuality(draft, postText) {
  const body = draft.body || '';
  const lowerBody = body.toLowerCase();
  const lowerPost = (postText || '').toLowerCase();
  const postTokens = Array.from(new Set(lowerPost.match(/[a-z][a-z0-9+.#]{2,}/g) || []));

  const overlap = postTokens.filter((t) => lowerBody.includes(t)).length;
  const jobSpecificity = Math.max(0, Math.min(10, Math.round((overlap / 6) * 10)));

  const hasMeasurable = /\d+%|\d+\+/.test(body);
  const techMentions = countDistinctTechMentions(body);
  const evidenceStrength = Math.max(0, Math.min(10, (hasMeasurable ? 6 : 2) + (techMentions >= 1 && techMentions <= 4 ? 4 : 1)));

  const factualSafety = findFabricatedMetric(body) ? 2 : 10;

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const naturalness = wordCount >= 130 && wordCount <= 230 ? 9 : 6;

  const clarity = body.split(/\n{2,}/).length >= 3 ? 9 : 6;

  const average = (jobSpecificity + evidenceStrength + factualSafety + naturalness + clarity) / 5;
  return { jobSpecificity, evidenceStrength, factualSafety, naturalness, clarity, average };
}

export async function extractConceptAndDraft(postText) {
  if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_API_KEY.trim()) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Get one at https://openrouter.ai/keys and add it to your environment.'
    );
  }

  let response;
  try {
    response = await getClient().chat.completions.create({
      model: MODEL,
      temperature: TEMPERATURE,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildPrompt(postText) }]
    });
  } catch (err) {
    if (err?.status === 401) {
      throw new Error(
        'OpenRouter rejected OPENROUTER_API_KEY (401 Unauthorized). The key is missing, invalid, or was ' +
        'revoked — check https://openrouter.ai/keys and make sure the same value is set wherever this is ' +
        'running (local .env vs. hosting provider env vars can drift, and env var changes usually need a redeploy).'
      );
    }
    throw err;
  }

  let draft;
  try {
    draft = JSON.parse(response.choices[0].message.content);
  } catch (err) {
    throw new Error(`OpenRouter did not return valid JSON. Raw: ${response.choices[0].message.content.slice(0, 300)}`);
  }

  if (!draft.subject || !draft.body) {
    throw new Error('OpenRouter response was missing a subject or body.');
  }

  // Deterministic checks (spec section 18) — throws on concrete, checkable
  // problems (placeholders, banned phrases, an invented number, a mangled
  // signature, an unreasonable length). A rejection here surfaces to the
  // caller the same way any other draft-generation failure does.
  validateDraft(draft);

  // Deterministic quality heuristic (spec section 19) — observability only,
  // never blocks the draft and never changes the returned shape.
  try {
    const quality = scoreDraftQuality(draft, postText);
    if (quality.average < 8) {
      console.info('[openrouterService] draft quality below target', quality);
    }
  } catch (err) {
    // Scoring is best-effort; never let it break a good draft.
    console.warn('[openrouterService] quality scoring failed:', err?.message || err);
  }

  return draft;
}

export const __promptTest = {
  buildPrompt,
  TECH_FACTS,
  SALES_FACTS,
  CUSTOMER_CARE_FACTS,
  validateDraft,
  scoreDraftQuality
};
