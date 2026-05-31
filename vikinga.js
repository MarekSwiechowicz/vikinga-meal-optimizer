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
  const filterDate = process.argv[2] || null;
  const deliveries = order.deliveries
    .filter(d => !d.deleted && (filterDate ? d.date === filterDate : d.date >= today))
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log(`Found ${deliveries.length} upcoming deliveries\n`);

  const changes = [];

  for (const delivery of deliveries) {
    const meals = Array.isArray(delivery.deliveryMeals)
      ? delivery.deliveryMeals
      : delivery.deliveryMeals ? [delivery.deliveryMeals] : [];

    for (const meal of meals) {
      if (meal.deleted) continue;

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

      changes.push({
        date: delivery.date,
        mealName: best.menuMealDetails.mealName,
        bestMeal: best.menuMealDetails.menuMealName,
        deliveryId: delivery.deliveryId,
        deliveryMealId: meal.deliveryMealId,
        bestDietCaloriesMealId: best.menuMealDetails.dietCaloriesMealId,
      });
    }
  }

  console.log(`\n${changes.length} meals to change.`);

  if (changes.length === 0) {
    console.log('All meals already optimal.');
    await browser.close();
    return;
  }

  console.log('\nApplying changes...');
  for (const c of changes) {
    const result = await page.evaluate(async ({ orderId, deliveryId, deliveryMealId, dietCaloriesMealId }) => {
      const res = await fetch(
        `/api/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch?dietCaloriesMealId=${dietCaloriesMealId}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' } }
      );
      return { status: res.status };
    }, { orderId: ORDER_ID, deliveryId: c.deliveryId, deliveryMealId: c.deliveryMealId, dietCaloriesMealId: c.bestDietCaloriesMealId });

    const ok = result.status === 200 || result.status === 204;
    console.log(`  [${c.date}] ${ok ? 'OK' : `FAILED (${result.status})`} — ${c.mealName}: ${c.bestMeal}`);
  }

  await browser.close();
  console.log('\nDone.');
})();
