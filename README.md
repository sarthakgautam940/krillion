# Yo UnCrillion

Our live answer game. Open the link, type your name, and you are in the room. When everyone is in, anyone taps Start.

There is no server and nothing to set up. Phones talk through public MQTT relays, the same way spelling-race does. The first player in the room hosts: their phone runs the game and every other phone follows it. If the host leaves, the next player takes over and the game carries on.

## The live room

- Everyone starts with two hearts. Players take turns in a circle.
- It is you against the timer. Wrong guesses cost nothing. If the bar runs out before you give an accepted answer, you lose a heart.
- A question ends at the end of a circle in which anyone ran out of time, so nobody gets an extra turn. It also ends when every answer has been found, or when a new circle would start with fewer answers left than players.
- The next question starts with the next player in line. Players with no hearts left are out and skipped.
- The last one alive wins. If the questions run out first, they start over in overtime with shorter turns.
- Rarity is just for show here. An insane answer slows the room down and plays the full reveal on every phone.
- A phone that drops is skipped until it comes back. Gone for 45 seconds mid game and that player is out.

## Solo

Tap Play solo on the front screen.

- Every accepted answer resets your timer. When time runs out, the next question starts. A cleared board moves on by itself.
- Points by rarity: Plankton 10, Too Clever 15, Schooler 30, Rare 60, Deep Cut 85, One in a Krillion 100, Insane 250.
- After all four questions you see your score and your high score on that phone.
- Copy my answers puts everything you typed on your clipboard, grouped by question, including the answers that were not on the board. Paste it to Claude to grow the bank.

## Adding questions

Everything lives in [`public/questions.txt`](public/questions.txt). Edit it on GitHub, commit, and Vercel redeploys.

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

Open http://localhost:3000. To test the room without the public relays, run any MQTT broker that accepts WebSockets and add `?broker=ws://localhost:9001` to the address. `?fast=1` shortens every timer for testing, and `?debug=1` logs what the relay is doing.

```bash
npm test
```

## Files

- `public/js/engine.js` holds the rules: turns, circles, hearts, solo scoring and when a question ends
- `public/js/relay.js` is the connection layer, ported from spelling-race
- `public/js/main.js` joins the room, hosts when it is this phone's turn to, and draws everything
- `public/js/bank.js` reads `questions.txt` and judges answers
- `public/js/filters.js` blocks words and spots keyboard mashing
- `public/js/insane.js` is the slow motion insane reveal
