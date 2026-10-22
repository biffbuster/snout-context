/**
 * Snout in the corner: the anteater from usesnout.xyz rises at the bottom right, says hello,
 * and walks a new user through the three pages worth seeing first. Each stop opens the page,
 * rings its tab in the sidebar and explains it in the speech bubble.
 *
 * Shown once per dashboard (local, hosted, cloud preview). Closing it at any point counts as
 * seen; the ? button in the top bar starts it again. With reduced motion there is no rise,
 * hop or typing: the bubble and its text simply appear.
 *
 * The animation is a separate file the dashboard server sends from the same origin
 * (/snout-mascot.webp), so the page still loads nothing from the network and the hook bundle
 * does not carry 1 MB of image. If it is missing, the Snout mark stands in.
 */
import { h, icon, SNOUT_MARK } from "./dom.js";
import { save, store, type View } from "./ctx.js";

export interface TourEnv {
  view: View;
  host: "local" | "hosted";
  mode: string;
  /** Opens a page by hash. */
  go(hash: string): void;
}

interface Stop {
  page: string;
  title: string;
  text: string;
}

const MASCOT = "/snout-mascot.webp";
const TYPE_MS = 16;

function script(env: TourEnv): { hello: string; stops: Stop[]; bye: string } {
  const bye = "That's the tour. Press the ? at the top whenever you want me back.";
  if (env.host === "hosted") {
    return {
      hello: "Hi, I'm Snout. This is Snout Cloud: the totals each connected machine syncs, in one place. Want a quick look around? It's three stops.",
      stops: [
        { page: "overview", title: "Overview", text: "Overview adds up spend and the tokens I kept out, across every machine in this workspace. Spend comes from the agents' own logs; what I kept out is an estimate and marked that way." },
        { page: "environments", title: "Environments", text: "Environments lists the machines that sync here. Each one is a snout login; disconnect one and it stops sending." },
        { page: "settings", title: "Settings", text: "Settings has your workspaces, the people in a team and the command that connects another machine." },
      ],
      bye,
    };
  }
  if (env.view === "cloud") {
    return {
      hello: "Hi, I'm Snout. This is a preview of Snout Cloud, filled with sample data. Want a quick look around? It's three stops.",
      stops: [
        { page: "overview", title: "Overview", text: "Overview adds up your team's spend and the tokens Snout kept out, across every machine. The numbers are samples until you connect." },
        { page: "agents", title: "Agents", text: "Agents shows each agent your team runs: its requests, what it spent and what Snout kept out." },
        { page: "integrations", title: "Integrations", text: "Integrations shows the tools, MCP servers and models your team can connect, and which ones are on." },
      ],
      bye,
    };
  }
  const hello = "Hi, I'm Snout. Welcome to your dashboard! Everything here is read from this machine, and none of it leaves. Want a quick look around? It's three stops.";
  const mode = env.mode === "enforce"
    ? "I'm in enforce, so I trim bulky reads before they reach your agent."
    : env.mode === "advise"
      ? "I'm in advise, so I ask before a read that would crowd the context."
      : "Right now I'm only watching, so nothing gets trimmed. Switch to enforce here when you're ready.";
  return {
    hello,
    stops: [
      { page: "overview", title: "Overview", text: "Overview is your daily check: what your agents spent, and how many tokens I kept out of their context. Spend comes from the agents' own logs; savings are estimates and marked that way." },
      { page: "sessions", title: "Sessions", text: "Sessions lists every agent session. Open one to go through it turn by turn: what I trimmed, and what I let through and why." },
      { page: "settings", title: "Settings", text: `Settings is where you steer me. ${mode} Memory, allow lists and the health check live here too.` },
    ],
    bye,
  };
}

const seenKey = (env: TourEnv) => `tour.${env.host === "hosted" ? "hosted" : env.view === "cloud" ? "cloud" : "local"}`;

export interface Tour {
  /** The tab to ring in the sidebar, or null. */
  target(): string | null;
  /** Shows the welcome if this dashboard has not had it yet. */
  greet(env: TourEnv): void;
  /** Starts the walkthrough from the first stop (the ? button). */
  replay(env: TourEnv): void;
  /** The view changed under the tour (Local/Cloud switch): close it quietly. */
  reset(): void;
  el: HTMLElement;
}

export function createTour(onTarget: () => void): Tour {
  const reduced = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } })();
  let env: TourEnv | null = null;
  let step = -1; // -1 hello, 0..2 stops, 3 goodbye
  let ring: string | null = null;
  let typing = 0;
  let timers: number[] = [];
  const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };
  const stopTimers = () => { timers.forEach(clearTimeout); timers = []; clearInterval(typing); };

  const text = h("span.tour-text", { "aria-hidden": "true" });
  const live = h("span.sr-only", { role: "status", "aria-live": "polite" });
  const title = h("b.tour-title");
  const dots = h("span.tour-dots");
  const actions = h("div.tour-actions");
  const bubble = h("div.tour-bubble", { onclick: () => finishTyping() }, title, text, live, h("div.tour-foot", null, dots, actions));
  const img = h("img.tour-img", { src: MASCOT, width: 120, height: 134, alt: "Snout, a pink anteater in a cowboy hat", draggable: "false" });
  img.addEventListener("error", () => { img.src = SNOUT_MARK; img.classList.add("fallback"); }, { once: true });
  const closeBtn = h("button.tour-x", { type: "button", "aria-label": "Hide Snout", title: "Hide Snout", onclick: () => close() }, icon("x", 12));
  const pal = h("div.tour-pal", null, img, closeBtn);
  const el = h("div.tour", { hidden: true }, bubble, pal);

  let full = "";
  function say(t: string): void {
    clearInterval(typing);
    full = t;
    live.textContent = t;
    bubble.classList.remove("open");
    void bubble.offsetWidth;
    bubble.classList.add("open");
    if (reduced) { text.textContent = t; return; }
    let n = 0;
    text.textContent = "";
    text.classList.add("typing");
    typing = window.setInterval(() => {
      n += 2;
      text.textContent = t.slice(0, n);
      if (n >= t.length) finishTyping();
    }, TYPE_MS);
  }
  function finishTyping(): void {
    clearInterval(typing);
    text.textContent = full;
    text.classList.remove("typing");
  }

  function hop(): void {
    if (reduced) return;
    pal.classList.remove("hop");
    void pal.offsetWidth;
    pal.classList.add("hop");
  }

  function setRing(page: string | null): void {
    ring = page;
    onTarget();
  }

  function btn(label: string, kind: string, fn: () => void, iconName?: string): HTMLElement {
    return h("button", { type: "button", class: `btn sm ${kind}`, onclick: (e: Event) => { e.stopPropagation(); fn(); } }, label, iconName ? icon(iconName, 13) : null);
  }

  function draw(): void {
    if (!env) return;
    const s = script(env);
    actions.replaceChildren();
    dots.replaceChildren();
    if (step === -1) {
      title.textContent = "Welcome to Snout";
      say(s.hello);
      actions.append(btn("Not now", "ghost", () => close()), btn("Show me around", "accent", () => go(0), "arrow"));
      setRing(null);
      return;
    }
    if (step >= s.stops.length) {
      title.textContent = "You're set";
      say(s.bye);
      actions.append(btn("Done", "accent", () => close()));
      setRing(null);
      hop();
      return;
    }
    const stop = s.stops[step]!;
    title.textContent = `${step + 1} of ${s.stops.length} · ${stop.title}`;
    dots.append(...s.stops.map((_x, i) => h("i", { class: i === step ? "on" : i < step ? "past" : "" })));
    say(stop.text);
    actions.append(
      step > 0 ? btn("Back", "ghost", () => go(step - 1)) : btn("Skip", "ghost", () => close()),
      btn(step === s.stops.length - 1 ? "Finish" : "Next", "accent", () => go(step + 1), "arrow"));
    setRing(stop.page);
    env.go(`#/${stop.page}`);
    hop();
  }

  function go(n: number): void {
    step = n;
    draw();
  }

  function show(e: TourEnv, from: number): void {
    stopTimers();
    env = e;
    step = from;
    el.hidden = false;
    el.classList.remove("closing", "up");
    bubble.classList.remove("open");
    text.textContent = "";
    if (reduced) {
      el.classList.add("up");
      draw();
      return;
    }
    later(() => el.classList.add("up"), from === -1 ? 700 : 30);
    later(() => draw(), from === -1 ? 1300 : 450);
  }

  function close(): void {
    if (env) save(seenKey(env), true);
    stopTimers();
    setRing(null);
    el.classList.add("closing");
    later(() => { el.hidden = true; el.classList.remove("closing", "up"); bubble.classList.remove("open"); }, reduced ? 0 : 600);
  }

  return {
    el,
    target: () => ring,
    greet(e) {
      if (!el.hidden || store<boolean>(seenKey(e), false)) return;
      show(e, -1);
    },
    replay(e) {
      show(e, 0);
    },
    reset() {
      if (el.hidden) return;
      stopTimers();
      setRing(null);
      el.hidden = true;
      el.classList.remove("closing", "up");
    },
  };
}
