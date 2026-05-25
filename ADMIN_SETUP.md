# הגדרת לוח האדמין 🛡️

לוח האדמין באפליקציה (טאב "אני" → "אזור אדמין") מציג סטטיסטיקות ורשימת
משתמשים, ומאפשר לעקוף ידנית את ה-tier של כל משתמש (למקרים מיוחדים).

הוא רואה רק על ידי `rosenthala47@gmail.com` (מוגדר ב-`CONFIG.ADMIN_EMAILS`
ובגרסת השרת ב-`ADMIN_EMAILS` secret).

## דריסות (One-time deploy)

הקבצים נמצאים ב:
- `C:\Users\kobir\ma-laanot-la\supabase\functions\admin-users\index.ts`
- `C:\Users\kobir\ma-laanot-la\supabase\functions\admin-update-tier\index.ts`

### שלב 1 — הגדר Secrets ב-Supabase

`SUPABASE_SERVICE_ROLE_KEY` כבר אמור להיות מוגדר (נשתמש בו גם ב-stripe-webhook).
אם לא, השג אותו מ-Supabase Dashboard → Project Settings → API → service_role
ואז:

```bash
cd /c/Users/kobir/ma-laanot-la
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ... --project-ref sdoglatrwspjivkztndx
npx supabase secrets set ADMIN_EMAILS=rosenthala47@gmail.com --project-ref sdoglatrwspjivkztndx
```

### שלב 2 — פרוס את 2 הפונקציות

```bash
npx supabase functions deploy admin-users --project-ref sdoglatrwspjivkztndx --no-verify-jwt
npx supabase functions deploy admin-update-tier --project-ref sdoglatrwspjivkztndx --no-verify-jwt
```

זהו! עכשיו הלוח עובד.

## איך זה עובד?

1. **תצוגה** — `admin-users` קוראת את כל המשתמשים מ-`auth.users`, סופרת כמה
   Free/Plus/Pro, ומחזירה את 50 האחרונים.
2. **חיפוש** — אותה פונקציה, מסננת לפי אימייל או שם.
3. **עדכון ידני** — `admin-update-tier` משנה את `user_metadata` של המשתמש
   ומוסיפה דגל `manual_override:true`. אם המשתמש משלם דרך Stripe בעתיד,
   ה-Webhook ידרוס את העקיפה (התשלום מנצח).

## אבטחה

שתי הפונקציות מאמתות שה-JWT של הקורא שייך לכתובת אימייל ב-`ADMIN_EMAILS`.
משתמש אחר יקבל `403 Forbidden`.
