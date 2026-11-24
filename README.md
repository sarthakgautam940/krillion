# Lore Check

A pass and play answer game for our group. Everyone takes turns on one screen naming answers to a question before the timer bar runs out. Rarer answers score more.

## How a game goes

- The bar drains from blue to yellow to red. Run out and you lose one of your two hearts.
- Every turn needs a new answer. Wrong or repeated answers just cost you time.
- A question ends when every answer has been found, after three full laps, or when the turn comes back around to someone who already missed it. That player starts the next question.
- Lose every heart and you are out. Highest score at the end wins.

| Rarity | Points |
| --- | --- |
| Plankton | 10 |
| Too Clever | 15 |
| Schooler | 30 |
| Rare | 60 |
| Deep Cut | 85 |
| One in a Krillion | 100 |
| Insane | 250, plus the full screen reveal |

## Adding questions

Everything lives in [`questions.txt`](questions.txt). Edit it on GitHub, commit, and Vercel redeploys in a few seconds.

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
- `Insane:` answers stop the game for the big reveal.
- `Anything else: One in a Krillion` accepts any real looking answer at that rarity and rejects keyboard mashing.
- `Block: word, word` never accepts those words. `profanity` and `religion` block whole lists.

## Running it locally

It is a static site with no build step. Serve the folder with anything, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` straight from disk will not load the questions.

## Files

- `questions.txt` is the question bank
- `js/bank.js` reads the bank and judges answers
- `js/game.js` has the turn, heart and scoring rules
- `js/filters.js` blocks words and spots keyboard mashing
- `js/main.js` runs the screens, timer and animations
- `js/audio.js` synthesizes every sound, so there are no audio files
