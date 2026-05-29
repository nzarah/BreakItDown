import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import express from "express";
import Stripe from "stripe";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Webhook needs raw body — everything else gets JSON
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe-webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

const noteStore = new Map();

// ── FIREBASE RTDB HELPER ────────────────────────────────────────────────────
const DB_URL = 'https://breakitdown-b1293-default-rtdb.firebaseio.com';

async function rtdbSet(path, value) {
  const secret = process.env.FIREBASE_DB_SECRET;
  if (!secret) return;
  await fetch(`${DB_URL}/${path}.json?auth=${secret}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}

// ── GEMINI ──────────────────────────────────────────────────────────────────
async function callGemini(prompt, extraParts = [], model = "gemini-2.5-flash") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not found in environment variables.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [...extraParts, { text: prompt }] }] }),
  });

  const json = await res.json();

  if (json.candidates?.[0]?.content) return json.candidates[0].content.parts[0].text;
  if (json.error) throw new Error("Gemini API Error: " + json.error.message);
  throw new Error("AI could not generate a response. Try again in a moment.");
}

// ── ROUTES ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "BreakItDown backend running." }));

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/roadmap", async (req, res) => {
  const { subject, grade } = req.body;
  if (!subject || !grade) return res.status(400).json({ error: "subject and grade are required." });

  const prompt = `Act as "Echo", an expert educational consultant.
  Create a comprehensive study roadmap for a student in ${grade} grade taking ${subject}.
  Include:
  - Top 5 most important concepts to master.
  - A 3-step action plan to get an A.
  - What you need to know to take this subject.
  - 3 essential vocabulary terms.
  Format with bold headers and bullet points.`;

  try {
    res.json({ roadmap: await callGemini(prompt) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notes", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required." });

  const prompt = `Act as "Echo". Turn the following into clean, high-level study notes.
  Use headings, bullet points, and highlight key formulas or dates.

  CONTENT:
  ${text}`;

  try {
    res.json({ notes: await callGemini(prompt) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/flashcards", async (req, res) => {
  const { notesContent } = req.body;
  if (!notesContent) return res.status(400).json({ error: "notesContent is required." });

  const prompt = `Create 6 high-quality, detailed study flashcards from these notes.
  Return ONLY a valid JSON array.
  Format: [{"front": "Question", "back": "Answer"}]

  NOTES:
  ${notesContent}`;

  try {
    const response = await callGemini(prompt);
    const flashcards = JSON.parse(response.replace(/```json|```/g, "").trim());
    res.json({ flashcards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/echo-chat", async (req, res) => {
  const { message, noteTitle, noteContent, history } = req.body;
  if (!message) return res.status(400).json({ error: "message is required." });

  const historyText = (history || [])
    .map(h => `${h.role === 'user' ? 'Student' : 'Echo'}: ${h.text}`)
    .join('\n');

  const prompt = `You are Echo, a brilliant AI study assistant inside BreakItDown — a student productivity app. You are embedded directly in the student's note editor, so you have full context of what they're working on.

YOUR CAPABILITIES (use all of them freely):
- Answer questions about the note content
- Rewrite or improve sections for clarity, tone, or style
- Fix grammar and spelling
- Summarize the note
- Quiz the student on key concepts
- Explain difficult terms or concepts
- Translate content
- Add structure (bullet points, headers, etc.)
- Anything else that helps the student learn or improve their notes

CURRENT NOTE:
Title: ${noteTitle || 'Untitled'}
Content: ${noteContent || '(empty)'}

${historyText ? `CONVERSATION SO FAR:\n${historyText}\n` : ''}
Student: ${message}

RESPONSE RULES:
- Be warm, smart, and concise — you're a study buddy, not a robot
- If the student asks you to rewrite, edit, improve, or modify the note (fully or substantially), provide the complete rewritten content wrapped EXACTLY like this:
  [EDIT_START]
  ...full rewritten note content here...
  [EDIT_END]
  Then briefly explain what you changed.
- For partial edits, suggestions, answers, or conversations — just respond normally without the markers
- Never add the markers unless returning a full note rewrite meant to replace the editor content

Echo:`;

  try {
    res.json({ reply: await callGemini(prompt) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/save-note", (req, res) => {
  const note = req.body;
  if (!note.id) note.id = "note_" + Date.now();
  noteStore.set(note.id, note);
  res.json({ id: note.id });
});

app.get("/api/notes-list", (req, res) => {
  res.json({ notes: Array.from(noteStore.values()) });
});

async function fetchTranscriptSupadata(url) {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) throw new Error("SUPADATA_API_KEY not set.");
  const resp = await fetch(`https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(url)}`, {
    headers: { "x-api-key": apiKey }
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || "Supadata could not fetch transcript.");
  }
  const data = await resp.json();
  const transcript = (data.content || []).map(c => c.text).join(" ").trim();
  if (!transcript) throw new Error("No transcript available for this video.");
  return transcript;
}

app.post("/api/video", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required." });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const notes = await callGemini(
        `You are "Echo", a study assistant. Watch this YouTube video and convert its content into clean, structured study notes.\n- Use ONLY information from the video.\n- Use headings, bullet points, and highlight key terms, formulas, or dates.`,
        [{ fileData: { fileUri: url } }]
      );
      return res.json({ notes });
    } catch (err) {
      if (attempt < 2 && err.message.includes("high demand")) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      break;
    }
  }

  try {
    const transcript = await fetchTranscriptSupadata(url);
    const prompt = `You are "Echo", a study assistant. A student has provided the EXACT transcript of a YouTube video.

YOUR TASK: Convert this transcript into clean study notes.
STRICT RULES:
- Use ONLY information explicitly stated in the transcript below.
- Do NOT use any outside knowledge or guess the topic.
- Use headings, bullet points, and highlight key terms, formulas, or dates from the transcript.

TRANSCRIPT START:
${transcript.slice(0, 12000)}
TRANSCRIPT END`;
    const notes = await callGemini(prompt);
    return res.json({ notes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── STRIPE CHECKOUT ──────────────────────────────────────────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  const { uid, email } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured yet.' });

  try {
    const stripe = new Stripe(stripeKey);
    const appUrl = process.env.APP_URL || 'https://breakitdown-o75k.onrender.com';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email || undefined,
      client_reference_id: uid,
      success_url: `${appUrl}/app?pro=success`,
      cancel_url: `${appUrl}/app`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  const stripeKey     = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !webhookSecret) return res.status(500).json({ error: 'Stripe not configured.' });

  const stripe = new Stripe(stripeKey);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: 'Webhook signature invalid: ' + err.message });
  }

  const obj = event.data.object;
  const uid = obj.client_reference_id || obj.metadata?.uid;

  if (event.type === 'checkout.session.completed' && uid) {
    await rtdbSet(`users/${uid}/pro`, true);
  } else if (event.type === 'customer.subscription.deleted' && uid) {
    await rtdbSet(`users/${uid}/pro`, false);
  } else if (event.type === 'customer.subscription.updated' && uid) {
    await rtdbSet(`users/${uid}/pro`, obj.status === 'active');
  }

  res.json({ received: true });
});

// ── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BreakItDown running on http://localhost:${PORT}`));
