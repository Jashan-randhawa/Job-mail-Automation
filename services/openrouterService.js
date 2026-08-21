import OpenAI from 'openai';

const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini';

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

function buildPrompt(postText) {
  return `
You write job application emails triggered by LinkedIn hiring posts — the sender is applying for a role, not just networking.

TECH FACTS (a menu — pick only what's relevant, do not list everything):
${TECH_FACTS}

SALES/BUSINESS FACTS (the SAME real background as TECH FACTS above, reframed for non-engineering roles — same person, same achievements, no new companies/titles/dates/numbers):
${SALES_FACTS}

LINKEDIN POST:
"""
${postText}
"""

Task:
1. Identify what role is being hired for and what the company/team is working on. Extract the company name, role title, and any stack, domain, or requirements mentioned — this is what the application needs to speak to directly.
2. Classify the role into exactly one category and pick facts accordingly — this decision matters more than anything else below, because a technical pitch sent to a sales post (or vice versa) reads as generic and unconvincing:
   - TECHNICAL (software/data/ML engineering, developer roles): use TECH FACTS as the source. Pick the ONE experience item or ONE project that most closely matches the role's stack or domain.
   - SALES_BUSINESS (sales, business development, account management, marketing, customer success/support, operations, or any other clearly non-engineering role): use SALES/BUSINESS FACTS as the source. Pick the ONE fact block (growth/adoption, operational impact, leadership/communication, results-driven, or customer-facing product sense) that most closely matches what the post is asking for. Do NOT reuse TECH FACTS' engineering-jargon phrasing here — describe the same achievement in the business/impact language SALES/BUSINESS FACTS already uses.
   - HYBRID (sales engineer, technical account manager, solutions consultant, developer relations/advocate, technical customer success — roles that explicitly need both technical credibility and people/communication skills): blend one item from each: lead with the business-impact framing from SALES/BUSINESS FACTS, and use one concrete technical detail from TECH FACTS as supporting proof of technical depth.
   If the post is ambiguous or doesn't fit neatly, make the best-judgment call and proceed — don't default to the technical framing just because TECH FACTS is longer.
3. Write a professional job application email (150-220 words) FROM the sender TO the relevant person/team, following this structure:
   - Opening (1-2 sentences): state plainly that you're applying for the specific role/position named or implied in the post, and reference the one concrete detail from the post that makes this role relevant (the team, product, or requirement mentioned) — not generic "I saw your post".
   - Fit (2-3 sentences): map your background directly onto what the post is asking for, using the fact category chosen in step 2. State it with real numbers — this should read as "here's evidence I can do this job," not a general bio, and it must NOT read like a copy-pasted engineering pitch if the role is sales/business.
   - Logistics (1 sentence): mention 2026 B.Tech graduate status and immediate availability plainly — e.g. available to start immediately, open to interview at their convenience. Don't invent a start date or salary figure that isn't given.
   - Ask (1 sentence): a direct, application-appropriate close — request to be considered for the role and/or a short interview, and note the resume/portfolio link covers full details. Not a vague "let's grab coffee" ask.
   - Sign-off: one closing line, then this exact signature block on its own lines, unchanged:
${SIGNATURE_BLOCK}
   Vary sentence rhythm and opening phrasing between emails — write it the way a specific thoughtful person would phrase this particular application, not a fill-in-the-blank template. Do not reuse the same opening sentence structure every time.
4. Tone: Formal but warm, direct — this is a job application, not a networking cold-email, so it should read as confident and role-specific rather than tentative. Ban these phrases entirely: "I hope this email finds you well", "I am writing to express my interest", "I came across your profile", "don't hesitate to reach out", "reaching out to explore opportunities", "passionate about", "I would love the opportunity".
5. Never use placeholder brackets like [Company] or [Name], and never invent facts, companies, titles, dates, or numbers beyond what TECH FACTS and SALES/BUSINESS FACTS state above — use real details from the post, or write around unknowns naturally.
6. Use the signature block exactly as given — don't add, remove, or reorder its lines, and don't repeat any of those links earlier in the body.
7. Subject line: read like a real application subject line — e.g. "Application: [Role] — Jashanpreet Singh" or "[Role] at [Company] — Jashanpreet Singh" if the role/company is known from the post, otherwise something equally specific to what the post is about. Max 12 words. Avoid "opportunity", "exciting", "amazing", or exclamation points.

Return ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"concept": "one sentence naming the role and company being applied to, or what the post is about if unclear", "roleCategory": "TECHNICAL, SALES_BUSINESS, or HYBRID", "subject": "email subject line", "body": "full email body with proper line breaks using \\n"}
`.trim();
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
      temperature: 0.85,
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

  return draft;
}

export const __promptTest = { buildPrompt, TECH_FACTS, SALES_FACTS };
