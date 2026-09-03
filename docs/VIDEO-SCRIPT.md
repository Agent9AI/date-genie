# Demo video script

Target: under 3 minutes, audio on, screen recording of https://date-genie.agent9.dev

Timings are generous. If you run long, cut section 5 first, then trim section 2.

---

## 0:00 to 0:15 · The problem, said once

**On screen:** the landing page, hero visible.

> "Ask any assistant to plan a date night and you get ten links and a shrug. You still have six tabs to open. That is not a recommendation problem. Nobody can finish the job, because a restaurant page and a ticketing page and a parking page have nothing to say to a machine except HTML."

---

## 0:15 to 0:45 · One sentence, anywhere on earth

**Do:** clear the box. Type a city that is obviously not a demo fixture. Suggest Asheville, NC or wherever the viewer is not.

> "So. One sentence. And notice I am naming a town at random, because there is no data in this app. No seed dataset, no cached city."

**Do:** press Grant the wish. Point at the console on the right as calls land.

> "Workers AI turns that sentence into constraints. Then it searches OpenStreetMap live for restaurants, cinemas, theatres, music venues and parking around that town, and does constraint satisfaction over every dinner, event and parking combination. Four thousand of them, in about two seconds."

---

## 0:45 to 1:15 · One evening, with the receipt

**On screen:** the itinerary. Scroll slightly to the constraint table.

> "Not ten options. One evening. Park at 7:24, dinner at 7:30, the show at 9. And underneath, every rule I set, with what I actually got. Under 180 means 146. Nothing before 7 means 7:30. Twenty minute drive means eleven. It shows its work instead of asking me to trust it."

---

## 1:15 to 2:00 · The part only WebMCP can do

**Do:** press Book the whole night. Let the approval sheet appear. **Pause. Say nothing for a beat.**

> "Now watch. The agent has asked to spend my money, and the tool call is suspended. Not polling. Suspended. No timeout, no default. It resolves when my thumb resolves it, and not before."

**Do:** open devtools. Paste and run:

```js
await window.dateGenie.call("book_approved_plan", { approvalToken: "forged" });
```

**On screen:** `TypeError: No such tool: book_approved_plan`

> "And this is the bit I would look at if I were judging. That is not a permission check returning false. The booking tool is not registered. It does not exist. It only appears once a human has approved something, and it disappears again the moment it is used."

**Do:** press Confirm. Show the three confirmation codes.

> "One press. Table, tickets and parking, booked together."

---

## 2:00 to 2:30 · When it cannot help

**Do:** set a deliberately impossible budget, something like $40 in a big city, and re-run.

> "And when it cannot do what you asked, it does not say no results and leave you guessing which of your six constraints was the problem. It prices the shortfall. Cheapest evening that satisfies everything else, broken down, so you know exactly what to give up."

---

## 2:30 to 2:55 · The honest close

**Do:** scroll to the Where this came from panel.

> "Every source, live, with latency. And underneath, the providers that have not shipped WebMCP yet: OpenTable, Resy, Yelp, Ticketmaster, SpotHero. Each with the exact tool contract we would call the day they do. Because right now no major booking site exposes tools, which is the whole reason this challenge exists."

> "Names, locations and every walk and drive time are real. Prices and showtimes are simulated, and the app says so, on screen and in every tool response."

**Final line, over the hero:**

> "AI should stop recommending your life and start executing it. This is what that looks like when the human stays in the room."

---

## Recording notes

- Record at 1440 wide or more. The three-column layout collapses below that.
- Do a warm-up run of your chosen city first. The first search populates the edge cache; the second is faster and demos better.
- Do not skip the silence before the approval sheet. The pause _is_ the point.
- Zoom the devtools font before recording. The `No such tool` line is the single most important frame in the video.
- Say "simulated" out loud at least once. Judges reward candour and punish discovering it themselves.
