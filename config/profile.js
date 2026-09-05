// Single source of truth for "who this tool sends email as." Previously this
// was hardcoded in three different places (services/cerebrasService.js's
// prompt facts + signature, services/emailService.js's `from` header and
// resume filename), so anyone else cloning the repo would silently send
// email claiming to be Jashanpreet Singh unless they hunted down every
// occurrence by hand.
//
// Resolution order (highest priority first):
//   1. `profile.json` at the repo root, if present (gitignored — see
//      profile.example.json for the shape to copy).
//   2. CANDIDATE_NAME / CONTACT_PHONE / PORTFOLIO_LINK / GITHUB_LINK /
//      LINKEDIN_LINK env vars (already partially supported before this
//      change; kept for backward compatibility).
//   3. Built-in defaults — the original candidate's real data, so existing
//      deployments that never set anything up keep working exactly as
//      before.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = process.env.PROFILE_PATH || path.join(__dirname, '..', 'profile.json');

const BUILT_IN_DEFAULTS = {
  name: 'Jashanpreet Singh',
  phone: '+91 7988253528',
  email: 'jashanpreetsinghrandhawa65@gmail.com',
  portfolioLink: 'jashan2978.vercel.app',
  githubLink: 'github.com/Jashan-randhawa',
  linkedinLink: 'linkedin.com/in/jashanpreet-singh-112978211',
  // Used in the drafting prompt's Paragraph 3 ("logistics") line — see
  // cerebrasService.js. Genuinely per-candidate/per-situation (a student
  // still mid-program vs. already graduated vs. only open to internships
  // says something different here), so it's deliberately NOT hardcoded
  // into a fact block the way techFacts/salesFacts are.
  degree: 'B.Tech IT',
  graduationYear: '2026',
  availability: 'immediately',
  // resumeFilename left null on purpose — derived from `name` below unless
  // explicitly overridden, so a name-only override still produces a sane
  // attachment filename instead of a leftover "Jashanpreet_Singh_Resume.pdf".
  resumeFilename: null,
  techFacts: `
NAME: {{name}}
ROLE: Full Stack AI Engineer, B.Tech IT graduate, Class of 2026 (SJPML Institute of Engg. & Technology, 2022–2026)
CORE STACK: MERN, Next.js, TypeScript, Node/Express, MongoDB/PostgreSQL

EXPERIENCE
- Full Stack Developer Intern, Excellence Technologies (Jul–Sep 2024): built a React Native app with offline sync + real-time chat (Socket.io) that drove a 40% DAU increase; automated internal workflows cutting manual effort by 80% and resolving 15+ critical bugs; shipped Next.js landing pages for an eCommerce platform.
- AI & ML Trainee, Infosys ICT Academy (2023): Azure AI Services training (Python ML, Azure ML Studio, NLP, Computer Vision); deployed an Azure Computer Vision image classifier (Streamlit) at 92% accuracy.

PROJECTS (pick whichever is most relevant to the post's tech/domain, don't list all of them)
- AI FiTrack: React + TypeScript + Strapi + Google Gemini AI + Azure Maps fitness tracker — Gemini-powered calorie estimation, AI chatbot, webcam food capture, PDF export.
- Smart Attend: FastAPI + Azure Face API + InsightFace + MongoDB + Docker face-recognition attendance system — migrated ephemeral storage to MongoDB and fixed aggregation-pipeline bugs to stabilize production inference.
- Real-Time Chat App: Node.js + Socket.io + MongoDB with a self-built TF-IDF + Logistic Regression spam classifier at 94% accuracy, auto-filtering malicious messages before delivery.
- LibraryOS: React + TypeScript + Node/Express + MongoDB library management SaaS with role-based access and JWT auth, deployed on Render + Vercel.

OTHER CREDIBILITY SIGNALS (use sparingly, at most one, only if directly relevant)
- Ranked 1st of 150+ peers in 5th semester.
- Led a 5-member team at Smart India Hackathon 2024 against 250+ participants.
- Solved 150+ DSA problems in C++.
`.trim(),
  salesFacts: `
NAME: {{name}}
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
`.trim(),
  customerCareFacts: `
NAME: {{name}}
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
`.trim()
};

function loadJsonOverrides() {
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[profile] Failed to read/parse ${PROFILE_PATH} — falling back to defaults/env vars. ${err.message}`);
  }
  return {};
}

const fileOverrides = loadJsonOverrides();

function resolve(field, envVar) {
  if (fileOverrides[field] !== undefined && fileOverrides[field] !== null && fileOverrides[field] !== '') {
    return fileOverrides[field];
  }
  if (envVar && process.env[envVar] && process.env[envVar].trim()) {
    return process.env[envVar].trim();
  }
  return BUILT_IN_DEFAULTS[field];
}

// Email specifically falls back to EMAIL_USER (the Gmail address the tool
// already sends from) before the hardcoded default, since in the common
// case "who this claims to be" and "what it sends from" are the same
// address and shouldn't need to be typed twice.
function resolveEmail() {
  if (fileOverrides.email) return fileOverrides.email;
  if (process.env.CONTACT_EMAIL && process.env.CONTACT_EMAIL.trim()) return process.env.CONTACT_EMAIL.trim();
  if (process.env.EMAIL_USER && process.env.EMAIL_USER.trim()) return process.env.EMAIL_USER.trim();
  return BUILT_IN_DEFAULTS.email;
}

// {{name}} placeholders let the fact blocks stay name-agnostic even when
// only profile.json's `name` field (not the whole fact blocks) is
// overridden — the common case of "same background, just not literally
// Jashanpreet Singh" doesn't require rewriting every fact paragraph.
function withName(template, name) {
  return template.split('{{name}}').join(name);
}

export const CANDIDATE_NAME = resolve('name', 'CANDIDATE_NAME');

export const profile = {
  name: CANDIDATE_NAME,
  phone: resolve('phone', 'CONTACT_PHONE'),
  email: resolveEmail(),
  portfolioLink: resolve('portfolioLink', 'PORTFOLIO_LINK'),
  githubLink: resolve('githubLink', 'GITHUB_LINK'),
  linkedinLink: resolve('linkedinLink', 'LINKEDIN_LINK'),
  degree: resolve('degree', 'DEGREE'),
  graduationYear: resolve('graduationYear', 'GRADUATION_YEAR'),
  availability: resolve('availability', 'AVAILABILITY'),
  resumeFilename:
    resolve('resumeFilename', 'RESUME_ATTACHMENT_FILENAME') ||
    `${CANDIDATE_NAME.replace(/\s+/g, '_')}_Resume.pdf`,
  techFacts: withName(resolve('techFacts'), CANDIDATE_NAME),
  salesFacts: withName(resolve('salesFacts'), CANDIDATE_NAME),
  customerCareFacts: withName(resolve('customerCareFacts'), CANDIDATE_NAME)
};
