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

// Single link only. Two+ links in a short cold email is a mild spam signal,
// and it forces the recipient to choose which one matters. Point people at
// the portfolio — it already links out to the resume and GitHub from there.
const CONTACT_LINK = process.env.PORTFOLIO_LINK || 'jashan2978.vercel.app';

const SENDER_PROFILE = `
Jashan Singh — Full Stack AI Engineer, final-year B.Tech IT student.
Stack: MERN, Next.js, TypeScript. AI integrations: Google Gemini, Azure Cognitive Services, OpenAI.
Interned at Excellence Technologies; AI/ML training at Infosys ICT Academy.
Has shipped several deployed full-stack AI products (an AI fitness tracker, a face-recognition attendance system, a library management platform).
Portfolio (resume and GitHub are both linked from here): ${CONTACT_LINK}
`.trim();

function buildPrompt(postText) {
  return `
You write professional job-application cold outreach emails triggered by LinkedIn posts.

SENDER PROFILE:
${SENDER_PROFILE}

LINKEDIN POST:
"""
${postText}
"""

Task:
1. Identify the core concept of the post: hiring news, product launch, technical achievement, company update, etc. Extract any company name, role, or technology mentioned.
2. Write a professional outreach email (150-200 words) FROM the sender TO the relevant person/team. It should naturally cover:
   - A specific reference to something in the post (not generic "I saw your post").
   - Why the sender is relevant — 2-3 sentences connecting their most relevant skills/projects to what the post is about. Name actual projects or technologies.
   - One clear, low-friction ask — a short call, referral, or to be considered for an open role.
   - A professional sign-off with the sender's name and exactly ONE link: ${CONTACT_LINK}
   Vary the ordering, sentence rhythm, and opening phrasing each time rather than following one fixed skeleton — write it the way a thoughtful person would actually phrase this particular email, not a mail-merge template.
3. Tone: Formal but warm. Avoid stock cold-email phrases entirely — no "I hope this email finds you well", "I am writing to express my interest", "I came across your profile", "don't hesitate to reach out", "reaching out to explore opportunities", or similar filler. Get to the point in language a specific human would use.
4. Never use placeholder brackets like [Company] or [Name] — use real details from the post, or write around unknowns naturally.
5. Include only the one link above — do not add any other URLs.
6. Subject line: Specific and professional, not generic or salesy. Mention the role/company/technology if known. Max 10 words. Avoid words like "opportunity", "exciting", or "amazing".

Return ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"concept": "one sentence describing what the post is about", "subject": "email subject line", "body": "full email body with proper line breaks using \\n"}
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
