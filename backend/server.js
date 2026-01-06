import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/responses";

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, "0")}`;
}

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "NO_TOKEN" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };
    next();
  } catch {
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }
}

function buildPrompts(type, question) {
  const typeLabel =
    type === "kahve" ? "Kahve Yorumu" :
    type === "ruya" ? "Rüya Yorumu" :
    "Yorum";

  const system = `
Sen "Falhane" uygulamasında Türkçe yazan sezgisel bir yorumcusun.
Kesin gelecek iddiası YOK: "kesin olacak" deme. "olabilir", "eğilim", "işaret" kullan.
Korkutma, tehdit etme, manipüle etme.
Yorum eğlence amaçlıdır. Sonuna kısa uyarı ekle.
`.trim();

  const user = `
Tür: ${typeLabel}
Kullanıcı metni/sorusu:
${question}

ÇIKTI FORMATI:
1) Başlık (1 satır)
2) 7-10 kısa paragraf yorum
3) "Öneri" (3 madde)
4) "Uyarı" (1 paragraf: eğlence/yorum amaçlı, kesinlik yok)
`.trim();

  return { system, user };
}

app.get("/health", (req, res) => res.send("ok"));

app.post("/api/fortune", requireAuth, async (req, res) => {
  try {
    const { type, question, isPaid } = req.body || {};
    if (!["kahve", "ruya"].includes(type)) return res.status(400).json({ error: "BAD_TYPE" });
    if (!question || String(question).trim().length < 3) return res.status(400).json({ error: "BAD_QUESTION" });

    const uid = req.user.uid;
    const week = isoWeekKey();
    const usageRef = db.collection("usage").doc(uid);

    if (!isPaid) {
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(usageRef);
          const data = snap.exists ? snap.data() : {};
          if (data?.freeUsedWeek === week) {
            const err = new Error("FREE_LIMIT_REACHED");
            err.code = "FREE_LIMIT_REACHED";
            throw err;
          }
          tx.set(
            usageRef,
            { freeUsedWeek: week, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        });
      } catch (err) {
        if (err?.code === "FREE_LIMIT_REACHED" || err?.message === "FREE_LIMIT_REACHED") {
          return res.status(402).json({ error: "FREE_LIMIT_REACHED" });
        }
        throw err;
      }
    }

    const { system, user } = buildPrompts(type, String(question).trim());

    const openaiResp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        max_output_tokens: 800
      }),
    });

    if (!openaiResp.ok) {
      const detail = await openaiResp.text();
      return res.status(500).json({ error: "OPENAI_ERROR", detail });
    }

    const data = await openaiResp.json();
    const text = data.output_text ?? "";

    return res.json({ text });
  } catch (e) {
    return res.status(500).json({ error: "SERVER_ERROR", detail: String(e?.message || e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Falhane backend running on ${port}`));
