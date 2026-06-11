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

חובה: השתמש בכלי שניתן לך כדי להחזיר את התשובה. אל תכתוב טקסט חופשי — קרא לכלי עם הפרמטרים המתאימים.`;
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

החזר בדיוק 5 תשובות באמצעות הכלי return_answers. כל תשובה קצרה, טבעית, ובסגנון המבוקש.`;
}

function buildImageUserPrompt(p: any): string {
  const style = STYLE_LABELS[p.style] || "טבעי";
  const sit = SITUATION_LABELS[p.situation] || "זהה מההקשר";
  const ctx = crushContext(p.crush);
  return `מצורף צילום מסך של שיחה. קרא את השיחה, הבן מי כתב מה (ההודעות מצד ימין/הכחולות הן בדרך כלל של המשתמש), והתמקד בהודעה האחרונה שהוא צריך לענות עליה.

סגנון מבוקש: ${style}
סיטואציה: ${sit}${ctx}

החזר 5 תשובות אפשריות שהמשתמש יכול לשלוח עכשיו, באמצעות הכלי return_answers.`;
}

function buildCoachUserPrompt(p: any): string {
  const ctx = crushContext(p.crush);
  return `נתח את השיחה הבאה כמו מאמן דייטים מקצועי:${ctx}

השיחה:
"${p.text}"

החזר את הניתוח באמצעות הכלי return_coach_analysis עם כל השדות הנדרשים: רמת עניין 0-100, טון, נימוק לעניין, סיגנלים, המלצת תזמון, 5 תשובות בסגנונות שונים, וטיפים אישיים.`;
}

// ---- Anthropic call ----------------------------------------------------------
// Uses tool_use with tool_choice to force structured JSON output.
// This is more reliable than asking for JSON in the prompt — Claude is forced
// to populate the tool's input schema exactly.
async function callAnthropic(opts: {
  system: string;
  userContent: any;
  maxTokens: number;
  tool: { name: string; description: string; input_schema: any };
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
      tools: [opts.tool],
      tool_choice: { type: "tool", name: opts.tool.name },
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Anthropic error ${res.status}`;
    console.error("Anthropic API error:", res.status, JSON.stringify(errBody));
    throw new Error(msg);
  }

  const data = await res.json();
  console.log("Anthropic response stop_reason:", data.stop_reason, "content_types:", (data.content || []).map((b: any) => b.type).join(","));

  const toolBlock = (data.content || []).find((b: any) => b.type === "tool_use");
  if (!toolBlock || !toolBlock.input) {
    console.error("No tool_use block in response. Full response:", JSON.stringify(data).slice(0, 2000));
    throw new Error("המודל לא החזיר תשובה תקינה");
  }
  console.log("Tool input received:", JSON.stringify(toolBlock.input).slice(0, 500));
  return toolBlock.input;
}

// ---- Tool schemas ------------------------------------------------------------
const ANSWERS_TOOL = {
  name: "return_answers",
  description: "החזרת 5 תשובות אפשריות לשיחה. חובה להחזיר בדיוק 5 פריטים במערך answers.",
  input_schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        description: "מערך של 5 תשובות בעברית, כל אחת קצרה וטבעית",
        items: { type: "string" },
        minItems: 5,
        maxItems: 5,
      },
    },
    required: ["answers"],
  },
};

const COACH_TOOL = {
  name: "return_coach_analysis",
  description: "החזרת ניתוח מלא של השיחה כמו מאמן דייטים מקצועי.",
  input_schema: {
    type: "object",
    properties: {
      interest: { type: "integer", description: "רמת עניין 0-100", minimum: 0, maximum: 100 },
      tone: { type: "string", description: "תיאור קצר של הטון" },
      interestReason: { type: "string", description: "משפט שמסביר את רמת העניין" },
      signals: {
        type: "array",
        description: "2-4 סיגנלים שזיהית בשיחה",
        items: { type: "string" },
      },
      timing: {
        type: "object",
        properties: {
          action: { type: "string", description: "המלצה מתי וכיצד לענות" },
          reason: { type: "string", description: "למה דווקא ככה" },
        },
        required: ["action", "reason"],
      },
      replies: {
        type: "object",
        properties: {
          funny: { type: "string" },
          confident: { type: "string" },
          flirty: { type: "string" },
          mysterious: { type: "string" },
          chill: { type: "string" },
        },
        required: ["funny", "confident", "flirty", "mysterious", "chill"],
      },
      tips: {
        type: "array",
        description: "2-3 טיפים אישיים לשיחה",
        items: { type: "string" },
      },
    },
    required: ["interest", "tone", "interestReason", "signals", "timing", "replies", "tips"],
  },
};


// Defensive: even though tool_choice should guarantee the schema, coerce
// the tool input into { answers: string[] } no matter what shape we get.
function coerceAnswers(input: any): { answers: string[] } {
  const toStr = (v: any): string => {
    if (typeof v === "string") return v;
    if (v == null) return "";
    if (typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      if (typeof v.message === "string") return v.message;
      if (typeof v.content === "string") return v.content;
      return JSON.stringify(v);
    }
    return String(v);
  };

  if (Array.isArray(input?.answers)) {
    return { answers: input.answers.map(toStr).filter((s: string) => s.length > 0) };
  }
  if (Array.isArray(input)) {
    return { answers: input.map(toStr).filter((s: string) => s.length > 0) };
  }
  if (input && typeof input === "object") {
    // Try common alt keys
    for (const key of ["replies", "options", "messages", "תשובות"]) {
      if (Array.isArray(input[key])) {
        return { answers: input[key].map(toStr).filter((s: string) => s.length > 0) };
      }
    }
    // Fallback: collect string values from the object
    const vals = Object.values(input).map(toStr).filter((s) => s.length > 0);
    if (vals.length >= 1) return { answers: vals };
  }
  console.error("coerceAnswers couldn't extract from:", JSON.stringify(input).slice(0, 500));
  return { answers: [] };
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
        tool: COACH_TOOL,
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
        tool: ANSWERS_TOOL,
      });
      return json(coerceAnswers(result), 200);
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
        tool: ANSWERS_TOOL,
      });
      return json(coerceAnswers(result), 200);
    }

    return json({ error: `מצב לא נתמך: ${mode || "(ריק)"}` }, 400);
  } catch (e) {
    console.error("chat-replies error:", e);
    return json({ error: (e as Error).message || "שגיאת שרת" }, 500);
  }
});
