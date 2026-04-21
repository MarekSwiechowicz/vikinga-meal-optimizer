# Vikinga Meal Optimizer

Automates weekly meal selection on [panel.kuchniavikinga.pl](https://panel.kuchniavikinga.pl) using Playwright and API reverse engineering. Scores meals based on nutritional data with rules tailored for ulcerative colitis in remission.

## How it works

1. Logs into the catering panel using a real Chromium browser (Playwright)
2. Fetches all upcoming deliveries via the internal API
3. For each meal, retrieves available swap options
4. Scores each option: `protein×3 - fat×2 - sugar×1.5` with bonuses for fish/poultry and penalties for spicy/processed foods
5. Swaps meals where a better-scoring option exists

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Fill in your credentials in .env
```

## Usage

```bash
npm start
```

The script runs headlessly and logs every change made.

## Scoring logic

| Factor | Weight |
|---|---|
| Protein | +3 per gram |
| Fat | -2 per gram |
| Sugar | -1.5 per gram |
| Fish (mintaj, łosoś, dorsz, tuńczyk) | +20 |
| Poultry (kurczak, indyk) | +5 |
| Spicy (curry, chili, pikant) | -15 |
| Tomato sauce | -10 |
| Processed meat (boczek, pepperoni) | -10 |
