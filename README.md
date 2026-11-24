# Yo UnCrillion

Our live answer game. Everyone opens the link on their own phone, types their name, and lands in the same room. Once everyone is in, anyone taps Start and the whole room plays through the questions together.

## How a game goes

- Players take turns. The bar drains from blue to yellow to red. Run out and you lose one of your two hearts.
- Every turn needs a new answer. Wrong or repeated answers just cost time, and everyone sees them.
- A question ends when every answer has been found, after three full laps, or when the turn comes back around to someone who already missed it. That player starts the next question.
- Lose every heart and you are out. Highest score at the end wins.
- An insane answer slows the whole room down and plays the full screen reveal on every phone.

| Rarity | Points |
| --- | --- |
| Plankton | 10 |
| Too Clever | 15 |
| Schooler | 30 |
| Rare | 60 |
| Deep Cut | 85 |
| One in a Krillion | 100 |
| Insane | 250 |

## One time setup on Vercel

The room lives in a small Redis database, so phones can share it.

1. Open the project in Vercel and go to **Storage**.
2. Choose **Create Database**, then **Upstash for Redis**, on the free plan.
3. Connect it to this project for all environments.
4. Redeploy, or push any commit.

If the database is missing, the site says so instead of letting people join.

## Adding questions

Everything lives in [`questions.txt`](questions.txt). It is read by the server only, so players cannot peek at the answers. Edit it on GitHub, commit, and Vercel redeploys.

```text
Worst cafeteria food
Plankton: Pizza, Chicken Nuggets / Nuggets
Schooler: Fish Sticks
Rare: Mystery Meat / Mystery Burger
One in a Krillion: The Milk
```

- First line is the question, then one line per rarity.
- Commas separate different answers. Slashes join spellings of the same answer, so saying one uses up all of them.
- Capitals, apostrophes, "the", "Mr" and "Mrs", plurals and small typos are matched automatically.
- `Insane:` answers trigger the big reveal.
- `Anything else: One in a Krillion` accepts any real looking answer at that rarity and rejects keyboard mashing.
- `Block: word, word` never accepts those words. `profanity` and `religion` block whole lists.

## Running it locally

```bash
npm run dev
```

Open http://localhost:3000 in a few tabs or on phones on the same wifi. Without database credentials the room lives in memory, which is fine for testing.

```bash
npm test
```

## How it fits together

- `public/` is the site every phone loads
- `api/room.js` is the one server function: phones poll it about once a second and send moves to it
- `lib/engine.js` holds the rules: turns, hearts, timers and when a question ends
- `lib/bank.js` reads `questions.txt` and judges answers
- `lib/store.js` saves the room to Redis with a version check, so two phones can never overwrite each other
