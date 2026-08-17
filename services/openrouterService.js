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
const SENDER_FACTS = `
NAME: Jashanpreet Singh
ROLE: Full Stack AI Engineer, final-year B.Tech IT student (SJPML Institute of Engg. & Technology, 2022–2026)
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

function buildPrompt(postText) {
  return `
You write job application emails triggered by LinkedIn hiring posts — the sender is applying for a role, not just networking.

SENDER FACTS (a menu — pick only what's relevant, do not list everything):
${SENDER_FACTS}

LINKEDIN POST:
"""
${postText}
"""

Task:
1. Identify what role is being hired for and what the company/team is working on. Extract the company name, role title, and any tech stack or requirements mentioned — this is what the application needs to speak to directly.
2. Pick the ONE experience item or ONE project from the sender facts that most closely matches the role's stack, domain, or problem type. Ignore the rest. If nothing matches closely, use the most broadly impressive item (the internship's 40% DAU / 80% workflow reduction results).
3. Write a professional job application email (150-220 words) FROM the sender TO the relevant person/team, following this structure:
   - Opening (1-2 sentences): state plainly that you're applying for the specific role/position named or implied in the post, and reference the one concrete detail from the post that makes this role relevant (the team, product, or requirement mentioned) — not generic "I saw your post".
   - Fit (2-3 sentences): map your background directly onto what the post is asking for. Pick the ONE experience/project that most closely matches the role's stack or domain and state it with real numbers — this should read as "here's evidence I can do this job," not a general bio.
   - Logistics (1 sentence): mention final-year B.Tech (2022–2026) status and availability plainly — e.g. available for internship/full-time discussions, open to interview at their convenience. Don't invent a start date or salary figure that isn't given.
   - Ask (1 sentence): a direct, application-appropriate close — request to be considered for the role and/or a short interview, and note the resume/portfolio link covers full details. Not a vague "let's grab coffee" ask.
   - Sign-off: one closing line, then this exact signature block on its own lines, unchanged:
${SIGNATURE_BLOCK}
   Vary sentence rhythm and opening phrasing between emails — write it the way a specific thoughtful person would phrase this particular application, not a fill-in-the-blank template. Do not reuse the same opening sentence structure every time.
4. Tone: Formal but warm, direct — this is a job application, not a networking cold-email, so it should read as confident and role-specific rather than tentative. Ban these phrases entirely: "I hope this email finds you well", "I am writing to express my interest", "I came across your profile", "don't hesitate to reach out", "reaching out to explore opportunities", "passionate about", "I would love the opportunity".
5. Never use placeholder brackets like [Company] or [Name] — use real details from the post, or write around unknowns naturally.
6. Use the signature block exactly as given — don't add, remove, or reorder its lines, and don't repeat any of those links earlier in the body.
7. Subject line: read like a real application subject line — e.g. "Application: [Role] — Jashanpreet Singh" or "[Role] at [Company] — Jashanpreet Singh" if the role/company is known from the post, otherwise something equally specific to what the post is about. Max 12 words. Avoid "opportunity", "exciting", "amazing", or exclamation points.

Return ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"concept": "one sentence naming the role and company being applied to, or what the post is about if unclear", "subject": "email subject line", "body": "full email body with proper line breaks using \\n"}
`.trim();
}

export async function extractConceptAndDraft(postText) {
  const response = await getClient().chat.completions.create({
    model: MODEL,
    temperature: 0.85,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: buildPrompt(postText) }]
  });

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
