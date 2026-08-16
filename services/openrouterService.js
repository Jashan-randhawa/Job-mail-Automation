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

const SENDER_PROFILE = `
Jashan Singh — Full Stack AI Engineer, final-year B.Tech IT student.
Stack: MERN, Next.js, TypeScript. AI integrations: Google Gemini, Azure Cognitive Services, OpenAI.
Interned at Excellence Technologies; AI/ML training at Infosys ICT Academy.
Has shipped several deployed full-stack AI products (an AI fitness tracker, a face-recognition attendance system, a library management platform).
Portfolio: jashan2978.vercel.app   GitHub: github.com/Jashan-randhawa
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
2. Write a professional outreach email (150-200 words) FROM the sender TO the relevant person/team. Follow this structure exactly:
   - Opening line: Reference something specific from the post (not generic "I saw your post"). One sentence.
   - Value paragraph: 2-3 sentences connecting the sender's most relevant skills/projects to what the post is about. Be specific — name actual projects or technologies.
   - Ask: One clear, low-friction ask — a short call, referral, or to be considered for an open role. One sentence.
   - Sign-off: Professional closing with sender name, portfolio link, and GitHub.
3. Tone: Formal but warm. No buzzwords, no flattery, no filler phrases like "I hope this email finds you well" or "I am writing to express my interest". Get to the point fast.
4. Never use placeholder brackets like [Company] or [Name] — use real details from the post, or write around unknowns naturally.
5. Subject line: Specific and professional. Mention the role/company/technology if known. Max 10 words.

Return ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"concept": "one sentence describing what the post is about", "subject": "email subject line", "body": "full email body with proper line breaks using \\n"}
`.trim();
}

export async function extractConceptAndDraft(postText) {
  const response = await getClient().chat.completions.create({
    model: MODEL,
    temperature: 0.7,
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