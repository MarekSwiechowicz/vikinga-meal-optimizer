require('dotenv').config();
const { chromium } = require('playwright');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function formatMeal(d, i) {
  const n = d.nutrition;
  const ingredients = (d.ingredients || []).map(ing => ing.name).join(', ');
  return [
    `${i + 1}. ${d.menuMealName}`,
    `   Makro: białko ${n.protein}g, tłuszcz ${n.fat}g (nasycone ${n.saturatedFattyAcids}g), węglowodany ${n.carbohydrate}g, błonnik ${n.dietaryFiber}g, cukier ${n.sugar}g, sól ${n.salt}g, ${n.calories} kcal`,
    `   Składniki: ${ingredients}`,
  ].join('\n');
}

async function analyzeForUC(options) {
  const list = options.map((o, i) => formatMeal(o.menuMealDetails, i)).join('\n\n');

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{
      role: 'user',
      content: `Pacjent choruje na wrzodziejące zapalenie jelita grubego (WZJG/UC).
Przeanalizuj poniższe opcje posiłków i:
1. Wskaż numer najlepszego wyboru
2. Daj krótkie uzasadnienie (1-2 zdania) odwołując się do konkretnych składników lub wartości odżywczych

Preferuj: wysokie białko, mało błonnika nierozpuszczalnego, chude mięso (drób, ryby), lekkostrawne składniki.
Unikaj: pikantnych przypraw (chili, curry, harissa), przetworzonego mięsa (chorizo, boczek, kiełbasa), tłuszczów nasyconych, surowych warzyw w dużych ilościach.

${list}

Format odpowiedzi:
WYBÓR: [numer]
UZASADNIENIE: [tekst]`
    }],
    max_tokens: 200,
  });

  return completion.choices[0].message.content.trim();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto('https://panel.kuchniavikinga.pl/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const cookieBtn = await page.$('text=Zezwól na wszystkie');
  if (cookieBtn) { await cookieBtn.click(); await page.waitForTimeout(1000); }
  await page.fill('input[name="username"]', process.env.VIKINGA_EMAIL);
  await page.fill('input[name="password"]', process.env.VIKINGA_PASSWORD);
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
  console.log(`Active order: ${ORDER_ID}\n`);

  const order = await page.evaluate(async (orderId) => {
    const res = await fetch(`/api/company/customer/order/${orderId}`);
    return res.json();
  }, ORDER_ID);

  const today = new Date().toISOString().split('T')[0];
  const filterDate = process.argv[2] || null;
  const deliveries = order.deliveries
    .filter(d => !d.deleted && (filterDate ? d.date === filterDate : d.date >= today))
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const delivery of deliveries) {
    const meals = Array.isArray(delivery.deliveryMeals)
      ? delivery.deliveryMeals
      : delivery.deliveryMeals ? [delivery.deliveryMeals] : [];

    let hasOutput = false;

    for (const meal of meals) {
      if (meal.deleted) continue;

      const sw = await page.evaluate(async ({ orderId, deliveryId, deliveryMealId }) => {
        const res = await fetch(`/api/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch`);
        if (!res.ok) return { mealChangeOptions: [] };
        return res.json();
      }, { orderId: ORDER_ID, deliveryId: delivery.deliveryId, deliveryMealId: meal.deliveryMealId });

      const options = (sw.mealChangeOptions || []).filter(o => o.menuMealDetails);
      if (options.length === 0) continue;

      if (!hasOutput) {
        console.log(`=== ${delivery.date} ===`);
        hasOutput = true;
      }

      console.log(`\n  ${options[0].menuMealDetails.mealName}:`);
      options.forEach((o, i) => {
        const d = o.menuMealDetails;
        const n = d.nutrition;
        const current = d.dietCaloriesMealId === meal.dietCaloriesMealId ? ' <-- CURRENT' : '';
        console.log(`    ${i + 1}. ${d.menuMealName} | B:${n.protein}g T:${n.fat}g C:${n.sugar}g${current}`);
      });

      const analysis = await analyzeForUC(options);
      console.log(`\n  AI (WZJG):`);
      analysis.split('\n').forEach(line => console.log(`    ${line}`));
    }

    if (hasOutput) console.log('');
  }

  await browser.close();
})();
