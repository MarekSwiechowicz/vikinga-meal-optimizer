require('dotenv').config();
const { chromium } = require('playwright');

const ORDER_ID = '3003629';
const EMAIL = process.env.VIKINGA_EMAIL;
const PASSWORD = process.env.VIKINGA_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('Missing VIKINGA_EMAIL or VIKINGA_PASSWORD in .env');
  process.exit(1);
}

function scoreForUC(meal) {
  const n = meal.nutrition;
  let score = (n.protein * 3) - (n.fat * 2) - (n.sugar * 1.5);
  const name = meal.menuMealName.toLowerCase();

  if (name.includes('mintaj') || name.includes('łosoś') ||
      name.includes('dorsz') || name.includes('tuńczyk') ||
      name.includes('pstrąg')) score += 20;

  if (name.includes('kurczak') || name.includes('indyk') ||
      name.includes('drobiow')) score += 5;

  if (name.includes('curry') || name.includes('hariss') ||
      name.includes('chili') || name.includes('pikant')) score -= 15;

  if (name.includes('sos pomidorowy') || name.includes('pomidorow')) score -= 10;

  if (name.includes('boczek') || name.includes('pepperoni') ||
      name.includes('kiełbas')) score -= 10;

  return score;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Logging in...');
  await page.goto('https://panel.kuchniavikinga.pl/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const cookieBtn = await page.$('text=Zezwól na wszystkie');
  if (cookieBtn) {
    await cookieBtn.click();
    await page.waitForTimeout(1000);
  }

  await page.fill('input[name="username"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
  console.log('Logged in.');

  const order = await page.evaluate(async (orderId) => {
    const res = await fetch(`/api/company/customer/order/${orderId}`);
    return res.json();
  }, ORDER_ID);

  const today = new Date().toISOString().split('T')[0];
  const deliveries = order.deliveries
    .filter(d => d.date >= today && !d.deleted)
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log(`Found ${deliveries.length} upcoming deliveries`);

  const changes = [];

  for (const delivery of deliveries) {
    const meals = delivery.deliveryMeals || [];
    for (const meal of meals) {
      const switchData = await page.evaluate(async ({ orderId, deliveryId, deliveryMealId }) => {
        const res = await fetch(
          `/api/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch`
        );
        return res.json();
      }, { orderId: ORDER_ID, deliveryId: delivery.deliveryId, deliveryMealId: meal.deliveryMealId });

      const options = switchData.mealChangeOptions || [];
      if (options.length === 0) continue;

      const scored = options.map(o => ({ ...o, score: scoreForUC(o) }));
      const current = { menuMealName: meal.menuMealName, nutrition: meal.nutrition };
      current.score = scoreForUC(current);

      const best = scored.reduce((a, b) => a.score > b.score ? a : b);

      if (best.score > current.score) {
        changes.push({
          date: delivery.date,
          meal: meal.menuMealName,
          bestMeal: best.menuMealName,
          deliveryId: delivery.deliveryId,
          deliveryMealId: meal.deliveryMealId,
          bestDietCaloriesMealId: best.dietCaloriesMealId,
          scoreDiff: best.score - current.score,
        });
      }
    }
  }

  console.log(`\n${changes.length} changes to make:`);
  for (const c of changes) {
    console.log(`  [${c.date}] ${c.meal} -> ${c.bestMeal} (+${c.scoreDiff.toFixed(1)} pts)`);
  }

  for (const c of changes) {
    const result = await page.evaluate(async ({ orderId, deliveryId, deliveryMealId, dietCaloriesMealId }) => {
      const res = await fetch(
        `/api/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch?dietCaloriesMealId=${dietCaloriesMealId}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' } }
      );
      return { status: res.status };
    }, { orderId: ORDER_ID, deliveryId: c.deliveryId, deliveryMealId: c.deliveryMealId, dietCaloriesMealId: c.bestDietCaloriesMealId });

    console.log(`  [${c.date}] ${result.status === 200 ? 'OK' : 'FAILED'} ${c.meal} -> ${c.bestMeal}`);
  }

  await browser.close();
  console.log('\nDone.');
})();
