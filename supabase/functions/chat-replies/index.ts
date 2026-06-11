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

// The model is chosen per-request via pickModel(): paid tiers (and the free
// daily bonus) request "opus" → claude-opus-4-8; everyone else → sonnet.
const OPUS_MODEL = "claude-opus-4-8";
const SONNET_MODEL = "claude-sonnet-4-6";

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

function buildCheckUserPrompt(p: any): string {
  const ctx = crushContext(p.crush);
  const hasImage = !!p.imageBase64;
  const draft = (p.text || "").trim();
  const intro = hasImage
    ? `מצורף צילום מסך${draft ? " וגם טקסט" : ""}. המשתמש שוקל לשלוח את ההודעה הזו (או את ההודעה האחרונה שכתב בצילום).`
    : `המשתמש שוקל לשלוח את ההודעה הבאה.`;
  return `אתה מאמן דייטים ביקורתי וישיר. ${intro}${ctx}

${draft ? `ההודעה שהוא רוצה לשלוח:\n"${draft}"\n\n` : ""}המשימה: תבדוק את ההודעה ותגיד אם כדאי לשלוח אותה. תן ציון 0-10 (10 = מושלם לשליחה), פסיקה ברורה, דגלים אדומים אם יש (נואשות, קרינג', יבש מדי, ארוך מדי, מתאמץ מדי), מה כן עובד, וניסוח חלופי טוב יותר.

החזר את התוצאה באמצעות הכלי return_message_check.`;
}

// Thrown when the model declines via the cannot_help tool. The handler turns
// this into a clean 422 message instead of leaking a refusal into the answers.
class RefusalError extends Error {}

// The model can always pick this tool to decline cleanly instead of producing
// a low-quality / refusal-flavored answer inside the real tool.
const CANNOT_HELP_TOOL = {
  name: "cannot_help",
  description:
    "השתמש בכלי הזה רק אם באמת אי אפשר לעזור בבקשה (למשל תוכן לא חוקי, או חיזור אחרי קטין). אל תשתמש בו בשביל בקשות לגיטימיות של חיזור/פלרטוט בין בגירים.",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "סיבה קצרה בעברית למה אי אפשר לעזור" },
    },
    required: ["reason"],
  },
};

// ---- Anthropic call ----------------------------------------------------------
// Uses tool_use with tool_choice to force structured JSON output.
// Returns the chosen tool_use block { name, input }.
async function callAnthropic(opts: {
  model: string;
  system: string;
  userContent: any;
  maxTokens: number;
  tools: any[];
}): Promise<{ name: string; input: any }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.userContent }],
      tools: opts.tools,
      // "any" forces the model to call SOME tool (real one or cannot_help),
      // so we always get structured output — never free-form prose.
      tool_choice: { type: "any" },
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Anthropic error ${res.status}`;
    console.error("Anthropic API error:", res.status, JSON.stringify(errBody));
    throw new Error(msg);
  }

  const data = await res.json();
  console.log("Anthropic response model:", opts.model, "stop_reason:", data.stop_reason);

  const toolBlock = (data.content || []).find((b: any) => b.type === "tool_use");
  if (!toolBlock || !toolBlock.input) {
    console.error("No tool_use block in response. Full response:", JSON.stringify(data).slice(0, 2000));
    throw new Error("המודל לא החזיר תשובה תקינה");
  }
  return { name: toolBlock.name, input: toolBlock.input };
}

// Runs a single content tool alongside the cannot_help escape hatch.
// Throws RefusalError if the model declines.
async function runTool(opts: {
  model: string;
  system: string;
  userContent: any;
  maxTokens: number;
  tool: any;
}): Promise<any> {
  const { name, input } = await callAnthropic({
    model: opts.model,
    system: opts.system,
    userContent: opts.userContent,
    maxTokens: opts.maxTokens,
    tools: [opts.tool, CANNOT_HELP_TOOL],
  });
  if (name === CANNOT_HELP_TOOL.name) {
    console.log("Model declined:", JSON.stringify(input).slice(0, 300));
    throw new RefusalError(input?.reason || "המודל לא יכול לעזור בבקשה הזו");
  }
  return input;
}

// Map the tier hint the frontend sends to an actual model id.
function pickModel(payload: any): string {
  const want = String(payload?.model || "").toLowerCase();
  if (want === "opus" || want.includes("opus")) return OPUS_MODEL;
  return SONNET_MODEL;
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

const CHECK_TOOL = {
  name: "return_message_check",
  description: "בדיקה והערכה של הודעה שהמשתמש עומד לשלוח, עם ציון ושיפורים.",
  input_schema: {
    type: "object",
    properties: {
      score: { type: "integer", description: "ציון 0-10 לכמה ההודעה טובה לשליחה", minimum: 0, maximum: 10 },
      verdict: { type: "string", description: "משפט פסיקה קצר — לשלוח / לשפץ / לא לשלוח, וכמה מילים למה" },
      redFlags: {
        type: "array",
        description: "0-4 בעיות / דגלים אדומים בהודעה (אם אין — מערך ריק)",
        items: { type: "string" },
      },
      strengths: {
        type: "array",
        description: "0-3 דברים שעובדים טוב בהודעה",
        items: { type: "string" },
      },
      rewrite: { type: "string", description: "ניסוח חלופי טוב יותר של ההודעה, בעברית טבעית" },
    },
    required: ["score", "verdict", "redFlags", "strengths", "rewrite"],
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

  // Safety: this is a dating/flirting coach — never assist for a target under 18.
  const crushAge = parseInt(String(payload?.crush?.age ?? ""), 10);
  if (Number.isFinite(crushAge) && crushAge < 18) {
    return json({
      error: "לא ניתן להשתמש בפרופיל של מתחת לגיל 18. האפליקציה מיועדת לחיזור בין בגירים בלבד (18+).",
    }, 400);
  }

  const model = pickModel(payload);
  console.log("using model:", model, "(requested:", payload?.model || "default", ")");

  try {
    if (mode === "coach") {
      if (!payload.text || payload.text.trim().length < 10) {
        return json({ error: "הדבק שיחה ארוכה יותר" }, 400);
      }
      const result = await runTool({
        model,
        system: baseSystemPrompt(),
        userContent: buildCoachUserPrompt(payload),
        maxTokens: 2000,
        tool: COACH_TOOL,
      });
      return json(result, 200);
    }

    if (mode === "check") {
      const hasText = !!(payload.text && payload.text.trim());
      if (!hasText && !payload.imageBase64) {
        return json({ error: "הדבק טקסט או צרף תמונה לבדיקה" }, 400);
      }
      // Check mode accepts text, an image, or both.
      const userContent: any = payload.imageBase64
        ? [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: payload.imageMediaType || "image/jpeg",
                data: payload.imageBase64,
              },
            },
            { type: "text", text: buildCheckUserPrompt(payload) },
          ]
        : buildCheckUserPrompt(payload);
      const result = await runTool({
        model,
        system: baseSystemPrompt(),
        userContent,
        maxTokens: 1500,
        tool: CHECK_TOOL,
      });
      return json(result, 200);
    }

    if (mode === "image") {
      if (!payload.imageBase64) {
        return json({ error: "לא צורפה תמונה" }, 400);
      }
      const result = await runTool({
        model,
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
      const result = await runTool({
        model,
        system: baseSystemPrompt(),
        userContent: buildReplyUserPrompt({ ...payload, mode: effectiveMode }),
        maxTokens: 1200,
        tool: ANSWERS_TOOL,
      });
      return json(coerceAnswers(result), 200);
    }

    return json({ error: `מצב לא נתמך: ${mode || "(ריק)"}` }, 400);
  } catch (e) {
    // A clean refusal — show the user a friendly message, not a 500.
    if (e instanceof RefusalError) {
      console.log("returning refusal 422:", e.message);
      return json({ error: e.message || "לא ניתן לעזור בבקשה הזו" }, 422);
    }
    console.error("chat-replies error:", e);
    return json({ error: (e as Error).message || "שגיאת שרת" }, 500);
  }
});
