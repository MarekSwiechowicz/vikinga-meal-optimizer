require('dotenv').config();
const { chromium } = require('playwright');
const Groq = require('groq-sdk');

const EMAIL = process.env.VIKINGA_EMAIL;
const PASSWORD = process.env.VIKINGA_PASSWORD;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!EMAIL || !PASSWORD) {
  console.error('Missing VIKINGA_EMAIL or VIKINGA_PASSWORD in .env');
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.error('Missing GROQ_API_KEY in .env');
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

function formatMeal(d, i) {
  const n = d.nutrition;
  const ingredients = (d.ingredients || []).map(ing => ing.name).join(', ');
  return [
    `${i + 1}. ${d.menuMealName}`,
    `   Makro: białko ${n.protein}g, tłuszcz ${n.fat}g (nasycone ${n.saturatedFattyAcids}g), węglowodany ${n.carbohydrate}g, błonnik ${n.dietaryFiber}g, cukier ${n.sugar}g, sól ${n.salt}g, ${n.calories} kcal`,
    `   Składniki: ${ingredients}`,
  ].join('\n');
}

async function pickBestForUC(options) {
  const list = options.map((o, i) => formatMeal(o.menuMealDetails, i)).join('\n\n');

  while (true) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Pacjent choruje na wrzodziejące zapalenie jelita grubego (WZJG/UC).
Wybierz JEDEN najlepszy posiłek z poniższej listy.
Preferuj: wysokie białko, mało błonnika nierozpuszczalnego, chude mięso (drób, ryby), lekkostrawne składniki.
Unikaj: pikantnych przypraw (chili, curry, harissa), przetworzonego mięsa (chorizo, boczek, kiełbasa), tłuszczów nasyconych, surowych warzyw w dużych ilościach.
Odpowiedz TYLKO cyfrą (np. 3) bez żadnego dodatkowego tekstu.

${list}`
        }],
        max_tokens: 5,
      });
      const text = completion.choices[0].message.content.trim();
      const idx = parseInt(text) - 1;
      return (idx >= 0 && idx < options.length) ? idx : 0;
    } catch (err) {
      const isRateLimit = err.status === 429;
      const isNetwork = !err.status;
      if (isRateLimit || isNetwork) {
        const match = isRateLimit && err.message && err.message.match(/try again in (\d+)m([\d.]+)s/);
        const waitMs = match
          ? (parseInt(match[1]) * 60 + parseFloat(match[2])) * 1000 + 2000
          : 30000;
        const waitMin = Math.ceil(waitMs / 60000);
        const reason = isRateLimit ? 'rate limit' : 'brak sieci';
        console.log(`\n  [${reason}] czekam ${waitMin} min...`);
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}

async function ensureLoggedIn(page) {
  const test = await page.evaluate(async () => {
    const res = await fetch('/api/company/customer/order/active-ids');
    return res.status;
  });
  if (test !== 200) {
    console.log('  [sesja wygasła] loguję ponownie...');
    await page.goto('https://panel.kuchniavikinga.pl/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const cookieBtn = await page.$('text=Zezwól na wszystkie');
    if (cookieBtn) { await cookieBtn.click(); await page.waitForTimeout(1000); }
    await page.fill('input[name="username"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(6000);
    console.log('  [zalogowano ponownie]');
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Logging in...');
  await page.goto('https://panel.kuchniavikinga.pl/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const cookieBtn = await page.$('text=Zezwól na wszystkie');
  if (cookieBtn) { await cookieBtn.click(); await page.waitForTimeout(1000); }
  await page.fill('input[name="username"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  console.log('Logged in.');

  const activeIds = await page.evaluate(async () => {
    const res = await fetch('/api/company/customer/order/active-ids');
    return res.json();
  });

  if (!activeIds || activeIds.length === 0) {
    console.error('No active orders found.');
    await browser.close();
    return;
  }

  const ORDER_ID = String(activeIds[0]);
  console.log(`Active order: ${ORDER_ID}`);

  const order = await page.evaluate(async (orderId) => {
    const res = await fetch(`/api/company/customer/order/${orderId}`);
    return res.json();
  }, ORDER_ID);

  const today = new Date().toISOString().split('T')[0];
  const dateFrom = process.argv[2] || today;
  const dateTo = process.argv[3] || '9999-12-31';
  const deliveries = order.deliveries
    .filter(d => !d.deleted && d.date >= dateFrom && d.date <= dateTo)
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log(`Found ${deliveries.length} upcoming deliveries\n`);

  for (const delivery of deliveries) {
    const meals = Array.isArray(delivery.deliveryMeals)
      ? delivery.deliveryMeals
      : delivery.deliveryMeals ? [delivery.deliveryMeals] : [];

    for (const meal of meals) {
      if (meal.deleted) continue;

      await ensureLoggedIn(page);

      const switchData = await page.evaluate(async ({ orderId, deliveryId, deliveryMealId }) => {
        const res = await fetch(
          `/api/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch`
        );
        if (!res.ok) return { mealChangeOptions: [] };
        return res.json();
      }, { orderId: ORDER_ID, deliveryId: delivery.deliveryId, deliveryMealId: meal.deliveryMealId });

      const options = (switchData.mealChangeOptions || []).filter(o => o.menuMealDetails);
      if (options.length === 0) continue;

      process.stdout.write(`  [${delivery.date}] Analyzing ${options[0].menuMealDetails.mealName}... `);
      const bestIdx = await pickBestForUC(options);
      const best = options[bestIdx];
      console.log(`→ ${best.menuMealDetails.menuMealName}`);

      if (best.menuMealDetails.dietCaloriesMealId === meal.dietCaloriesMealId) continue;

      await ensureLoggedIn(page);

      const result = await page.evaluate(async ({ orderId, deliveryId, deliveryMealId, dietCaloriesMealId }) => {
        const res = await fetch(
          `/api/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch?dietCaloriesMealId=${dietCaloriesMealId}`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' } }
        );
        return { status: res.status };
      }, { orderId: ORDER_ID, deliveryId: delivery.deliveryId, deliveryMealId: meal.deliveryMealId, dietCaloriesMealId: best.menuMealDetails.dietCaloriesMealId });

      const ok = result.status === 200 || result.status === 204;
      console.log(`  [${delivery.date}] ${ok ? 'OK' : `FAILED (${result.status})`} — ${options[0].menuMealDetails.mealName}: ${best.menuMealDetails.menuMealName}`);
    }
  }

  await browser.close();
  console.log('\nDone.');
})();
