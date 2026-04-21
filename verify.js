require('dotenv').config();
const { chromium } = require('playwright');

const ORDER_ID = '3003629';

function scoreForUC(details) {
  const n = details.nutrition;
  let score = (n.protein * 3) - (n.fat * 2) - (n.sugar * 1.5);
  const name = details.menuMealName.toLowerCase();
  if (name.includes('mintaj') || name.includes('łosoś') || name.includes('dorsz') || name.includes('tuńczyk') || name.includes('pstrąg')) score += 20;
  if (name.includes('kurczak') || name.includes('indyk') || name.includes('drobiow')) score += 5;
  if (name.includes('curry') || name.includes('hariss') || name.includes('chili') || name.includes('pikant')) score -= 15;
  if (name.includes('sos pomidorowy') || name.includes('pomidorow')) score -= 10;
  if (name.includes('boczek') || name.includes('pepperoni') || name.includes('kiełbas')) score -= 10;
  return score;
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
  console.log('Logged in.\n');

  const order = await page.evaluate(async (orderId) => {
    const res = await fetch(`/api/company/customer/order/${orderId}`);
    return res.json();
  }, ORDER_ID);

  const today = new Date().toISOString().split('T')[0];
  const deliveries = order.deliveries
    .filter(d => d.date >= today && !d.deleted)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const delivery of deliveries) {
    const meals = Array.isArray(delivery.deliveryMeals)
      ? delivery.deliveryMeals
      : delivery.deliveryMeals ? [delivery.deliveryMeals] : [];

    const switchResults = [];

    for (const meal of meals) {
      if (meal.deleted) continue;

      const sw = await page.evaluate(async ({ orderId, deliveryId, deliveryMealId }) => {
        const res = await fetch(`/api/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch`);
        return res.json();
      }, { orderId: ORDER_ID, deliveryId: delivery.deliveryId, deliveryMealId: meal.deliveryMealId });

      const options = (sw.mealChangeOptions || []).filter(o => o.menuMealDetails);
      if (options.length === 0) continue;

      const scored = options.map(o => ({
        name: o.menuMealDetails.menuMealName,
        mealName: o.menuMealDetails.mealName,
        id: o.menuMealDetails.dietCaloriesMealId,
        score: scoreForUC(o.menuMealDetails),
        isCurrent: o.menuMealDetails.dietCaloriesMealId === meal.dietCaloriesMealId,
      })).sort((a, b) => b.score - a.score);

      switchResults.push({ mealSlot: scored[0].mealName, scored, currentId: meal.dietCaloriesMealId });
    }

    if (switchResults.length === 0) continue;

    console.log(`=== ${delivery.date} ===`);
    for (const r of switchResults) {
      console.log(`  ${r.mealSlot}:`);
      for (const o of r.scored) {
        const tag = o.isCurrent ? ' <-- CURRENT' : '';
        const best = o.score === r.scored[0].score ? ' [BEST]' : '';
        console.log(`    ${o.score.toFixed(1).padStart(6)} | ${o.name}${best}${tag}`);
      }
    }
    console.log('');
  }

  await browser.close();
})();
