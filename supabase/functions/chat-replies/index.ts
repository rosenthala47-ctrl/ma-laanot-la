// ============================================================================
// chat-replies — Supabase Edge Function (Deno)
//
// Generates dating-reply suggestions for the "מה לענות לה" app by calling the
// Anthropic Messages API. Rebuilt to use Deno.serve + raw fetch (NO
// `@supabase/functions-js` JSR import — that dependency failed to load and
// crashed the previous deploy with a 503 on the CORS preflight).
//
// Required Supabase secret:  ANTHROPIC_API_KEY
// ============================================================================

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Default to the most capable model. To lower cost, switch to
// "claude-sonnet-4-6" (≈5× cheaper) or "claude-haiku-4-5" (cheapest).
const MODEL = "claude-sonnet-4-6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---- label maps (id → Hebrew) -------------------------------------------------
const STYLE_LABELS: Record<string, string> = {
  funny: "מצחיק ושנון", flirty: "פלרטטני", dry: "יבש ולקוני",
  romantic: "רומנטי", cold: "קר ומרוחק", confident: "בטוח בעצמו",
  calm: "רגוע", sharp: "חד ושנון",
};
const SITUATION_LABELS: Record<string, string> = {
  auto: "זהה את הסיטואציה לבד מההקשר",
  first_message: "הודעה ראשונה / פתיחה",
  continue: "המשך שיחה קיימת",
  dry: "היא עונה יבש וקצר",
  ignoring: "היא מתעלמת / לא עונה",
  bring_back: "להחזיר אותה לעניין",
  after_date: "אחרי דייט",
  haha: "היא כתבה 'חחח' וצריך להמשיך",
  story_reply: "תגובה לסטורי שלה",
  flirty_smart: "לפלרטט בצורה חכמה בלי קרינג'",
  not_desperate: "להישמע לא נואש",
  cute: "חמוד",
  mysterious: "מסתורי",
  funny_clean: "מצחיק ונקי",
  confident: "בטוח בעצמו",
};

// ---- prompt building ----------------------------------------------------------
function crushContext(crush: any): string {
  if (!crush || typeof crush !== "object") return "";
  const parts: string[] = [];
  if (crush.name) parts.push(`שם: ${crush.name}`);
  if (crush.age) parts.push(`גיל: ${crush.age}`);
  if (crush.how_met || crush.howMet) parts.push(`איך הכרתם: ${crush.how_met || crush.howMet}`);
  if (crush.notes) parts.push(`מידע נוסף: ${crush.notes}`);
  if (crush.vibe) parts.push(`וייב: ${crush.vibe}`);
  return parts.length ? `\nפרטים על מי שאתה כותב לו/לה:\n${parts.join("\n")}` : "";
}

function baseSystemPrompt(): string {
  return `אתה מאמן דייטים ישראלי מומחה שעוזר לכתוב הודעות שנונות וטבעיות בעברית מדוברת ועכשווית.
אתה כותב כמו בן אדם אמיתי בן 20-30, לא כמו רובוט — סלנג ישראלי טבעי, בלי אימוג'ים מוגזמים, בלי קרינג'.
ההודעות צריכות להיות קצרות (משפט-שניים), אמיתיות, ולהתאים בדיוק לסגנון ולסיטואציה שביקשו.
תמיד החזר תשובה בפורמט JSON בלבד לפי הסכמה.`;
}

function buildReplyUserPrompt(p: any): string {
  const style = STYLE_LABELS[p.style] || "טבעי";
  const sit = SITUATION_LABELS[p.situation] || "זהה מההקשר";
  const ctx = crushContext(p.crush);
  let task = "";

  if (p.mode === "opener") {
    task = `המשימה: כתוב 5 הודעות פתיחה ("אופנינגים") מקוריות לפתיחת שיחה.${
      p.context ? `\nהקשר נוסף שהמשתמש נתן: ${p.context}` : ""
    }`;
  } else if (p.mode === "phrase") {
    task = `המשימה: המשתמש רוצה להגיד את הדבר הבא, נסח לו את זה ב-5 ואריאציות שונות בסגנון המבוקש:\n"${p.intent}"`;
  } else if (p.mode === "emergency") {
    task = `המשימה: מצב חירום — תן 5 תשובות מהירות ומגוונות (מצחיק / בטוח / פלרטטני / מסתורי / צ'יל) להודעה שהוא קיבל עכשיו:\n"${p.text}"`;
  } else {
    // text mode
    task = `המשימה: ההודעה שהוא קיבל היא:\n"${p.text}"\nכתוב 5 תשובות אפשריות.`;
  }

  return `סגנון מבוקש: ${style}
סיטואציה: ${sit}${ctx}

${task}

החזר בדיוק 5 תשובות במערך "answers". כל תשובה קצרה, טבעית, ובסגנון המבוקש.`;
}

function buildImageUserPrompt(p: any): string {
  const style = STYLE_LABELS[p.style] || "טבעי";
  const sit = SITUATION_LABELS[p.situation] || "זהה מההקשר";
  const ctx = crushContext(p.crush);
  return `מצורף צילום מסך של שיחה. קרא את השיחה, הבן מי כתב מה (ההודעות מצד ימין/הכחולות הן בדרך כלל של המשתמש), והתמקד בהודעה האחרונה שהוא צריך לענות עליה.

סגנון מבוקש: ${style}
סיטואציה: ${sit}${ctx}

כתוב 5 תשובות אפשריות שהמשתמש יכול לשלוח עכשיו. החזר אותן במערך "answers".`;
}

function buildCoachUserPrompt(p: any): string {
  const ctx = crushContext(p.crush);
  return `נתח את השיחה הבאה כמו מאמן דייטים מקצועי:${ctx}

השיחה:
"${p.text}"

החזר ניתוח מלא בפורמט JSON:
- interest: מספר 0-100, כמה היא/הוא מעוניין/ת לפי השיחה
- tone: תיאור קצר של הטון (למשל "חמים ומשחקי", "מנומס ומרוחק")
- interestReason: משפט שמסביר את רמת העניין
- signals: מערך של 2-4 סיגנלים שזיהית (למשל "עונה מהר", "שואלת שאלות", "תשובות קצרות")
- timing: אובייקט עם action (המלצה מתי וכיצד לענות) ו-reason (למה)
- replies: אובייקט עם 5 תשובות מומלצות, מפתח לכל סגנון: funny, confident, flirty, mysterious, chill
- tips: מערך של 2-3 טיפים אישיים לשיחה`;
}

// ---- Anthropic call ----------------------------------------------------------
async function callAnthropic(opts: {
  system: string;
  userContent: any;
  maxTokens: number;
}): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.userContent }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Anthropic error ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b: any) => b.type === "text");
  if (!textBlock) throw new Error("תשובה ריקה מהמודל");

  // Extract JSON robustly — strip any markdown fences the model may add
  let text: string = textBlock.text.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Also handle case where model wraps in a single JSON object/array without fences but with prose
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    text = text.slice(firstBrace, text.lastIndexOf("}") + 1);
  } else if (firstBracket !== -1) {
    text = text.slice(firstBracket, text.lastIndexOf("]") + 1);
  }

  return JSON.parse(text);
}

// ---- handler -----------------------------------------------------------------
Deno.serve(async (req: Request) => {
  // CORS preflight — MUST return cleanly or the browser blocks the real request.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "השרת חסר מפתח ANTHROPIC_API_KEY" }, 500);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "גוף בקשה לא תקין" }, 400);
  }

  const mode = typeof payload.mode === "string" ? payload.mode.trim().toLowerCase() : "";
  console.log("chat-replies request:", JSON.stringify({
    mode,
    hasText: !!payload.text,
    hasImage: !!payload.imageBase64,
    hasIntent: !!payload.intent,
    style: payload.style,
    situation: payload.situation,
  }));

  try {
    if (mode === "coach") {
      if (!payload.text || payload.text.trim().length < 10) {
        return json({ error: "הדבק שיחה ארוכה יותר" }, 400);
      }
      const result = await callAnthropic({
        system: baseSystemPrompt(),
        userContent: buildCoachUserPrompt(payload),
        maxTokens: 2000,
      });
      return json(result, 200);
    }

    if (mode === "image") {
      if (!payload.imageBase64) {
        return json({ error: "לא צורפה תמונה" }, 400);
      }
      const result = await callAnthropic({
        system: baseSystemPrompt(),
        userContent: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: payload.imageMediaType || "image/jpeg",
              data: payload.imageBase64,
            },
          },
          { type: "text", text: buildImageUserPrompt(payload) },
        ],
        maxTokens: 1200,
      });
      return json(result, 200);
    }

    // text / opener / phrase / emergency — or anything else with a text payload
    // (be lenient: an unfamiliar mode shouldn't break the user, just treat as text)
    const effectiveMode = ["text", "opener", "phrase", "emergency"].includes(mode)
      ? mode
      : payload.text ? "text" : payload.intent ? "phrase" : "";

    if (effectiveMode) {
      const result = await callAnthropic({
        system: baseSystemPrompt(),
        userContent: buildReplyUserPrompt({ ...payload, mode: effectiveMode }),
        maxTokens: 1200,
      });
      return json(result, 200);
    }

    return json({ error: `מצב לא נתמך: ${mode || "(ריק)"}` }, 400);
  } catch (e) {
    console.error("chat-replies error:", e);
    return json({ error: (e as Error).message || "שגיאת שרת" }, 500);
  }
});
