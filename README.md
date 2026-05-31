# Vikinga Meal Optimizer

Automatically selects the best meal options on [panel.kuchniavikinga.pl](https://panel.kuchniavikinga.pl) using Playwright and Groq AI (LLaMA 3.3), optimized for ulcerative colitis (UC/WZJG).

## How it works

1. Logs into the catering panel using a headless Chromium browser (Playwright)
2. Fetches the active order and upcoming deliveries via the internal API
3. For each meal slot, retrieves all available swap options (name, full macros, ingredient list)
4. Sends all options to Groq AI with a UC-specific prompt
5. AI picks the best option based on ingredients and nutrition (not just keywords)
6. Swaps the meal via the API if a better option exists

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Fill in your credentials in .env
```

## Usage

```bash
# Optimize all upcoming deliveries
node vikinga.js

# Optimize a specific date
node vikinga.js 2026-06-06

# Preview AI analysis without making changes
node verify.js
node verify.js 2026-06-06
```

## AI scoring criteria (UC/WZJG)

The AI (LLaMA 3.3 70B via Groq) evaluates each meal based on:

**Preferred:**
- High protein, lean meats (poultry, fish)
- Low insoluble fiber
- Simple, easily digestible ingredients

**Avoided:**
- Spicy ingredients (chili, curry, harissa)
- Processed meats (chorizo, bacon, salami)
- High saturated fat
- Large amounts of raw vegetables

## Environment variables

| Variable | Description |
|---|---|
| `VIKINGA_EMAIL` | Login email for kuchniavikinga.pl |
| `VIKINGA_PASSWORD` | Login password |
| `GROQ_API_KEY` | API key from console.groq.com (free tier) |
