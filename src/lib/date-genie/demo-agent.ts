/**
 * The built-in agent.
 *
 * WebMCP is young: most people who open this link will be in a browser that has
 * no agent in it at all. Rather than show them a dead page and a "requires
 * Chrome 149" apology, the page ships its own small agent that drives the
 * EXACT SAME tools through the EXACT SAME instrumented path a real WebMCP
 * client uses.
 *
 * It is scripted, not a language model. It plays a fixed sequence of tool
 * calls. That is a deliberate honesty choice: no hidden LLM, no API key, no
 * network. What you watch it do is precisely what ChatGPT or Gemini does when
 * it picks up these tools, and every call it makes appears in the same console.
 *
 * Note step 4: it stops at request_approval and genuinely cannot continue until
 * a human presses a button. That pause is the product.
 */
import { callTool } from "./webmcp";
import * as store from "./store";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = { say: string; run: () => Promise<unknown>; pause?: number };

function tokenFrom(result: unknown): string | null {
  const sc = (result as { structuredContent?: { approvalToken?: string; approved?: boolean } } | undefined)?.structuredContent;
  return sc?.approved && sc.approvalToken ? sc.approvalToken : null;
}

export async function runDemoAgent(request: string): Promise<void> {
  if (store.getState().demoRunning) return;
  store.set({ demoRunning: true, narration: [], utterance: request });

  const say = async (line: string, ms = 550) => {
    store.narrate(line);
    await wait(ms);
  };

  try {
    await say("Reading the page before I ask you anything…", 700);
    await callTool("get_date_context", {}, "demo");

    await say("Composing an evening that satisfies all of it at once…", 750);
    const planned = await callTool("plan_date_night", { request }, "demo");
    if ((planned as { isError?: boolean }).isError) {
      await say("Nothing fits those constraints. Loosen one and ask me again.", 400);
      return;
    }

    await say("Checking my own work against every constraint you set…", 750);
    await callTool("explain_plan", {}, "demo");

    await say("This spends your money, so it is your call, not mine.", 800);
    const approval = await callTool(
      "request_approval",
      { note: "Holds a table, 2 tickets and a parking spot. Nothing charges until you arrive." },
      "demo",
    );

    const token = tokenFrom(approval);
    if (!token) {
      await say("Understood. Nothing booked. Tell me what to change.", 300);
      return;
    }

    await say("Booking all three in one call…", 600);
    await callTool("book_approved_plan", { approvalToken: token }, "demo");
    await say("Done. It's in your calendar if you want it.", 300);
  } finally {
    store.set({ demoRunning: false });
  }
}

/** A second script: the human pushes back mid-flight and the genie adapts. */
export async function runObjectionDemo(dislike: string): Promise<void> {
  if (store.getState().demoRunning) return;
  store.set({ demoRunning: true });
  try {
    store.narrate(`Noted. "${dislike}" is out, permanently.`);
    await wait(500);
    await callTool("remember_preference", { dislike }, "demo");
    await wait(400);
    store.narrate("Re-planned around it. Same budget, same constraints.");
  } finally {
    store.set({ demoRunning: false });
  }
}

export const SAMPLE_REQUESTS = [
  "Plan something fun for me and my girlfriend Friday night. Keep everything under $180. We're in Arlington, don't make us drive more than 20 minutes, and nothing before 7.",
  "Cheap date night, under $90, vegetarian, and we want to be home by 11.",
  "Something quiet where we can actually talk, then live music. Under $200, nothing before 7:30.",
  "It's our anniversary. Under $260, somewhere nice, no seafood, and a show after.",
];
