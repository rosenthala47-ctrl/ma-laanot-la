# הגדרת תשלום עם Stripe – מדריך מהיר 💳

המנוי כבר עובד באפליקציה. כל מה שנותר זה לחבר אותו לחשבון Stripe אמיתי
כדי שכסף יזרום לחשבון שלך בכל פעם שמישהו משדרג.

ההגדרה היא חד-פעמית, לוקחת בערך **20-30 דקות**.

---

## שלב 1 – פתיחת חשבון Stripe

1. כנס ל-https://dashboard.stripe.com/register
2. רשם בחשבון עם המייל `rosenthala47@gmail.com`
3. מלא פרטי עסק (אפשר "individual" / יחיד)
4. הוסף פרטי חשבון בנק ישראלי לקבלת התשלומים
5. אמת את הזהות (תעודת זהות / רישיון נהיגה)

> 💡 בזמן ההמתנה לאישור (יכול לקחת יום-יומיים), אפשר להמשיך ב-Test Mode

---

## שלב 2 – יצירת המוצרים (4 מנויים)

ב-Stripe Dashboard ← `Product catalog` ← `+ Add product`

צור **4 מוצרים**, אחד אחרי השני:

| שם המוצר            | מחיר | חיוב   | Lookup key (אופציונלי) |
|---------------------|------|--------|------------------------|
| מה לענות לה – Plus חודשי   | $7   | Monthly | `plus_monthly`         |
| מה לענות לה – Plus שנתי    | $60  | Yearly  | `plus_yearly`          |
| מה לענות לה – Pro חודשי    | $10  | Monthly | `pro_monthly`          |
| מה לענות לה – Pro שנתי     | $99  | Yearly  | `pro_yearly`           |

לכל מוצר:
- **Recurring** (לא One-off)
- מטבע: USD
- אחרי שמירה, **העתק את ה-Price ID** (`price_1A...`) – נצטרך אותו

---

## שלב 3 – יצירת Payment Links

עבור כל אחד מ-4 המוצרים:

1. בעמוד המוצר ← לחץ `Create payment link`
2. בקטע **"After payment"** בחר:
   - `Don't show confirmation page`
   - **Redirect URL** הדבק:
     ```
     https://rosenthala47-ctrl.github.io/ma-laanot-la/?stripe_status=success&tier=plus&cycle=monthly
     ```
     ⚠️ שנה את `tier` ו-`cycle` לפי המוצר (`plus`/`pro`, `monthly`/`yearly`)
3. תחת **"Advanced options"** הדלק `client_reference_id` (חובה לזהות את המשתמש)
4. שמור והעתק את ה-URL (`https://buy.stripe.com/...`)

---

## שלב 4 – הדבקת ה-URLs באפליקציה

פתח `index.html` ומצא:

```js
STRIPE_LINKS: {
  plus_monthly: '',
  plus_yearly:  '',
  pro_monthly:  '',
  pro_yearly:   '',
},
```

הדבק את 4 ה-URLs במקום הרלוונטי.

שלח לי הודעה "סיימתי שלב 4" ואני אדחוף את השינוי ל-GitHub.

---

## שלב 5 – פריסת ה-Webhook (החלק "הקסם")

ה-Webhook הוא הפונקציה שמפעילה את המנוי באוטומט אחרי שהתשלום מאושר.

### 5.1 – הוסף את ה-Price IDs לפונקציה

פתח `C:\Users\kobir\ma-laanot-la\supabase\functions\stripe-webhook\index.ts`
ומלא את `PRICE_MAP`:

```ts
const PRICE_MAP = {
  "price_1ABC...": { tier: "plus", cycle: "monthly" },
  "price_1DEF...": { tier: "plus", cycle: "yearly"  },
  "price_1GHI...": { tier: "pro",  cycle: "monthly" },
  "price_1JKL...": { tier: "pro",  cycle: "yearly"  },
};
```

### 5.2 – הגדר Secrets ב-Supabase

ב-Stripe Dashboard ← `Developers` ← `API keys` ← העתק את **Secret key** (`sk_live_...`)

ב-Supabase, פתח את הפרויקט `sdoglatrwspjivkztndx` ← `Project Settings` ← `API`
ועותק את **service_role key**.

מ-Git Bash:
```bash
cd /c/Users/kobir/ma-laanot-la
npx supabase secrets set STRIPE_SECRET_KEY=sk_live_... --project-ref sdoglatrwspjivkztndx
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ... --project-ref sdoglatrwspjivkztndx
```

### 5.3 – פרוס את הפונקציה

```bash
npx supabase functions deploy stripe-webhook --project-ref sdoglatrwspjivkztndx --no-verify-jwt
```

יחזיר URL שנראה כך:
```
https://sdoglatrwspjivkztndx.supabase.co/functions/v1/stripe-webhook
```

### 5.4 – חבר את ה-Webhook ב-Stripe

ב-Stripe Dashboard ← `Developers` ← `Webhooks` ← `+ Add endpoint`
- **Endpoint URL**: ה-URL מהשלב הקודם
- **Events to send**:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- שמור. תקבל **Signing secret** (`whsec_...`)

```bash
npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --project-ref sdoglatrwspjivkztndx
```

### 5.5 – פרוס מחדש (לאחר הוספת ה-secret)

```bash
npx supabase functions deploy stripe-webhook --project-ref sdoglatrwspjivkztndx --no-verify-jwt
```

---

## ✅ זהו! בדיקה

1. כנס לאפליקציה כמשתמש רגיל (לא `rosenthala47@gmail.com` כי הוא admin אוטומטית)
2. לחץ "שדרג ל-Plus" → מועבר ל-Stripe
3. השתמש בכרטיס בדיקה: `4242 4242 4242 4242` (כל תאריך עתידי, כל CVV)
4. אחרי תשלום – מועבר חזרה לאפליקציה והמנוי פעיל

---

## 📞 תמיכה

נתקעת? תגיד לי איפה בדיוק (איזה שלב, איזה הודעת שגיאה) ואני אעזור.
